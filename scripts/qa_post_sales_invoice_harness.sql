-- Test harness for supabase/98_post_sales_invoice.sql
-- Run: psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/qa_post_sales_invoice_harness.sql
-- Design:
--  - Outer session is one transaction.
--  - Probe procedure _qa_probe_post_sales_invoice() runs mutations in its own
--    subtransaction via CALL, so the outer session can still ROLLBACK at the end.
--  - This file defines the probe procedure first (once), then uses it.

-- Probe procedure for fin.post_sales_invoice
-- Runs mutations in its own transaction via CALL, so the outer harness
-- can still ROLLBACK at the end.
CREATE OR REPLACE PROCEDURE _qa_probe_post_sales_invoice()
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
BEGIN
  -- base unit first (required by items.base_unit_id FK)
  INSERT INTO core.units (id, code, name_ar, is_base)
  VALUES ('unit-piece', 'piece', 'قطعة', true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO core.customers (id, code, name_ar, customer_type, currency, active)
  VALUES ('cust-test-1', 'TST-001', 'عميل اختبار', 'retail', 'EGP', true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO core.warehouses (id, code, name_ar, type, active)
  VALUES ('wh-test-1', 'TST-WH', 'مستودع اختبار', 'local_finished', true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO core.items (id, code, name_ar, name_en, item_type, base_unit_id, vat_rate, active)
  VALUES ('item-test-1', 'TST-ITEM', 'صنف اختبار', 'Test Item', 'finished_product', 'unit-piece', 0.14, true)
  ON CONFLICT (id) DO NOTHING;

  -- ensure the helper objects exist (idempotent inside probe for rerun safety)
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'fin' AND c.relname = 'rpc_idempotency'
  ) THEN
    CREATE TABLE fin.rpc_idempotency (
      key         TEXT PRIMARY KEY,
      invoice_id  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  END IF;

  -- Call 1: valid invoice + idempotency key
  SELECT f.invoice_id, f.invoice_number, f.success, f.error
    INTO r
  FROM fin.post_sales_invoice(
    p_customer_id => 'cust-test-1',
    p_channel => 'retail',
    p_warehouse_id => 'wh-test-1',
    p_payment_method => 'credit',
    p_currency => 'EGP',
    p_exchange_rate => 1,
    p_date => current_date,
    p_lines => '[{"itemId":"item-test-1","quantity":2,"unitPrice":100,"discount":0,"vatRate":0.14}]'::jsonb,
    p_created_by => 'qa',
    p_is_test => true,
    p_idempotency_key => 'qa-harness-key-1'
  ) f;

  RAISE NOTICE 'call1: invoice_id=%, invoice_number=%, success=%, error=%',
    r.invoice_id, r.invoice_number, r.success, r.error;

  IF r.success THEN
    -- Call 2: idempotent retry with same key
    SELECT f.invoice_id, f.invoice_number, f.success, f.error
      INTO r
    FROM fin.post_sales_invoice(
      p_customer_id => 'cust-test-1',
      p_channel => 'retail',
      p_warehouse_id => 'wh-test-1',
      p_payment_method => 'credit',
      p_currency => 'EGP',
      p_exchange_rate => 1,
      p_date => current_date,
      p_lines => '[{"itemId":"item-test-1","quantity":2,"unitPrice":100,"discount":0,"vatRate":0.14}]'::jsonb,
      p_created_by => 'qa',
      p_is_test => true,
      p_idempotency_key => 'qa-harness-key-1'
    ) f;

    RAISE NOTICE 'call2: invoice_id=%, invoice_number=%, success=%, error=%',
      r.invoice_id, r.invoice_number, r.success, r.error;
  END IF;

  -- Call 3: different payload, different key
  SELECT f.invoice_id, f.invoice_number, f.success, f.error
    INTO r
  FROM fin.post_sales_invoice(
    p_customer_id => 'cust-test-1',
    p_channel => 'wholesale',
    p_warehouse_id => 'wh-test-1',
    p_payment_method => 'credit',
    p_currency => 'EGP',
    p_exchange_rate => 1,
    p_date => current_date,
    p_lines => '[{"itemId":"item-test-1","quantity":1,"unitPrice":200,"vatRate":0}]'::jsonb,
    p_created_by => 'qa',
    p_is_test => true,
    p_idempotency_key => 'qa-harness-key-2'
  ) f;

  RAISE NOTICE 'call3: invoice_id=%, invoice_number=%, success=%, error=%',
    r.invoice_id, r.invoice_number, r.success, r.error;
END;
$$;

BEGIN;

\echo '== Pre-test baseline counts (before any seed) =='
\echo 'Invoices(is_test=true):'
SELECT count(*)::int AS c FROM sales.invoices WHERE is_test = true;
\echo 'Invoice lines(is_test=true via join):'
SELECT count(*)::int AS c FROM sales.invoice_lines il JOIN sales.invoices i ON i.id = il.invoice_id WHERE i.is_test = true;
\echo 'Journal entries linked to test invoices:'
SELECT count(*)::int AS c FROM fin.journal_entries je JOIN sales.invoices i ON i.id::text = je.source_document_id WHERE i.is_test = true;
\echo 'Audit rows linked to test invoices:'
SELECT count(*)::int AS c FROM audit.app_audit_log aal JOIN sales.invoices i ON i.id::text = aal.record_id WHERE i.is_test = true;
\echo 'fin.rpc_idempotency rows:'
SELECT count(*)::int AS c FROM fin.rpc_idempotency;
\echo 'core.items/warehouses/customers/units:'
SELECT count(*)::int AS items FROM core.items WHERE id = 'item-test-1';
SELECT count(*)::int AS warehouses FROM core.warehouses WHERE id = 'wh-test-1';
SELECT count(*)::int AS customers FROM core.customers WHERE id = 'cust-test-1';
SELECT count(*)::int AS units FROM core.units WHERE id = 'unit-piece';

\echo '== Probe mutations inside a subtransaction (commits inside, outer still rolls back) =='
CALL _qa_probe_post_sales_invoice();

\echo '== Post-probe counts (should reflect the subtransaction commits) =='
SELECT count(*)::int AS invoices_created FROM sales.invoices WHERE is_test = true;
SELECT count(*)::int AS invoice_lines_created FROM sales.invoice_lines il JOIN sales.invoices i ON i.id = il.invoice_id WHERE i.is_test = true;
SELECT count(*)::int AS journal_entries_created FROM fin.journal_entries je JOIN sales.invoices i ON i.id::text = je.source_document_id WHERE i.is_test = true;
SELECT count(*)::int AS audit_rows_created FROM audit.app_audit_log aal JOIN sales.invoices i ON i.id::text = aal.record_id WHERE i.is_test = true;
SELECT count(*)::int AS idempotency_rows FROM fin.rpc_idempotency;

\echo '== End of probe, outer session ROLLBACK below =='

ROLLBACK;

\echo '== End of harness (outer session rolled back) =='
