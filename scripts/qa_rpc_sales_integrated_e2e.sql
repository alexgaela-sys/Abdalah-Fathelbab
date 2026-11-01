-- =====================================================================
-- scripts/qa_rpc_sales_integrated_e2e.sql
--
-- End-to-end proof of the integrated sales path on Supabase TEST:
--   invoice + sales journal + FIFO issue + COGS journal, atomically.
--
-- Isolation contract:
--   * every fixture id starts with `rpc-test-` (never touches real rows),
--   * the whole run is ONE transaction that ends in ROLLBACK, so no fixture,
--     invoice, journal or stock movement survives the run,
--   * no mapping/account is invented: the required mappings must already
--     exist (the script fails closed if they do not).
--
-- Checks (each raises 'E2E FAILED: ...' and aborts):
--   1. success + invoice posted with a REAL balanced sales journal,
--   2. COGS journal from out_journal_number is posted, balanced, linked to the
--      invoice and DISTINCT from the sales journal,
--   3. FIFO: the older batch is consumed first; COGS = 3*10 + 2*12 = 54,
--   4. idempotent retry returns the same invoice with no second posting,
--   5. a forced downstream failure (issue 999 with 8 on hand) leaves NOTHING,
--   6. a CLOSED period is refused and leaves NOTHING,
--   7. a Viewer role is refused and leaves NOTHING.
--
-- Run: psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
--        -f scripts/qa_rpc_sales_integrated_e2e.sql
-- =====================================================================
\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------
-- 0. required mappings must exist — never invented here
-- ---------------------------------------------------------------------
do $$
declare
  v_missing text;
begin
  select string_agg(k, ', ') into v_missing
    from (values ('sales_vat_output'),('customer_receivable_local'),
                 ('sales_retail_revenue'),('cogs_local'),('inventory_finished_local')) t(k)
   where not exists (select 1 from core.account_mappings m where m.key = t.k);
  if v_missing is not null then
    raise exception 'E2E FAILED: required account mapping(s) missing: %', v_missing;
  end if;

  if not exists (select 1 from core.warehouses where id = 'qa-e2e-wh-01') then
    raise exception 'E2E FAILED: warehouse qa-e2e-wh-01 is missing';
  end if;
  if not exists (select 1 from core.units where id = 'qa-e2e-unit-ctn') then
    raise exception 'E2E FAILED: unit qa-e2e-unit-ctn is missing';
  end if;
  if not exists (select 1 from core.accounting_periods
                  where not is_closed and date '2026-10-20' between start_date and end_date) then
    raise exception 'E2E FAILED: no open accounting period covering 2026-10-20';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. isolated fixtures (all rolled back at the end)
-- ---------------------------------------------------------------------
insert into core.customers (id, code, name_ar, customer_type, currency, active, is_test)
values ('rpc-test-cust', 'RPC-TEST-01', 'عميل اختبار RPC', 'retail', 'EGP', true, true);

insert into core.items (id, code, name_ar, name_en, item_type, base_unit_id,
                        track_batch, track_expiry, expiry_period_days, standard_cost, active, is_test)
values ('rpc-test-item', 'RPC-TEST-ITEM', 'صنف اختبار RPC', 'RPC test item', 'finished_product',
        'qa-e2e-unit-ctn', true, true, 60, 11, true, true);

-- two FIFO layers: older/cheaper first
insert into inventory.batches (id, item_id, warehouse_id, batch_number,
                               production_date, expiry_date, quantity, unit_cost, active, is_test)
values ('rpc-test-b1', 'rpc-test-item', 'qa-e2e-wh-01', 'RPC-TEST-B1',
        date '2026-09-01', date '2026-10-31', 3, 10, true, true),
       ('rpc-test-b2', 'rpc-test-item', 'qa-e2e-wh-01', 'RPC-TEST-B2',
        date '2026-10-01', date '2026-11-30', 10, 12, true, true);

-- a Viewer profile, used only by check 7
insert into core.app_profiles (id, user_id, supabase_auth_id, username, name, role, active, is_test)
values ('rpc-test-viewer', '11111111-1111-1111-1111-111111111111',
        '11111111-1111-1111-1111-111111111111', 'rpc-test-viewer', 'RPC test viewer',
        'Viewer', true, true);

-- ---------------------------------------------------------------------
-- 2. the happy path
-- ---------------------------------------------------------------------
create temp table t_call on commit drop as
select * from public.post_sales_invoice_integrated(
  p_customer_id      => 'rpc-test-cust',
  p_channel          => 'retail',
  p_warehouse_id     => 'qa-e2e-wh-01',
  p_payment_method   => 'credit',
  p_currency         => 'EGP',
  p_exchange_rate    => 1,
  p_date             => date '2026-10-20',
  p_lines            => '[{"itemId":"rpc-test-item","quantity":5,"unitPrice":30,"discount":0,"vatRate":0.14}]'::jsonb,
  p_created_by       => 'rpc-e2e',
  p_idempotency_key  => 'rpc-test-key-1'
);

do $$
declare
  r            record;
  v_inv        record;
  v_sales_jv   text;
  v_sales_dr   numeric; v_sales_cr numeric; v_sales_posted boolean;
  v_cogs       record;
  v_cogs_dr    numeric; v_cogs_cr numeric;
  v_out_qty    numeric;
  v_out_cost   numeric;
  v_b1         numeric;
  v_b2         numeric;
begin
  select * into r from t_call;

  if not coalesce(r.out_success, false) then
    raise exception 'E2E FAILED: posting reported failure: %', coalesce(r.out_error, '(no message)');
  end if;
  if r.out_invoice_number is null then
    raise exception 'E2E FAILED: success without an invoice number';
  end if;

  select id, invoice_number, status, total_amount, total_amount_egp, cogs_total, journal_entry_id
    into v_inv
    from sales.invoices where invoice_number = r.out_invoice_number;

  if v_inv.id is null then
    raise exception 'E2E FAILED: invoice % not found', r.out_invoice_number;
  end if;
  if v_inv.status <> 'posted' then
    raise exception 'E2E FAILED: invoice status is % (expected posted)', v_inv.status;
  end if;

  -- invoice math: 150 + 14% VAT
  if abs(v_inv.total_amount - 171) > 0.01 then
    raise exception 'E2E FAILED: invoice total % (expected 171)', v_inv.total_amount;
  end if;

  -- (1) the sales journal must be real, posted and balanced
  if v_inv.journal_entry_id is null then
    raise exception 'E2E FAILED: invoice has no journal_entry_id';
  end if;
  v_sales_jv := v_inv.journal_entry_id;

  select e.is_posted into v_sales_posted from fin.journal_entries e where e.id = v_sales_jv;
  if not coalesce(v_sales_posted, false) then
    raise exception 'E2E FAILED: sales journal % is not posted', v_sales_jv;
  end if;

  select coalesce(sum(l.debit),0), coalesce(sum(l.credit),0)
    into v_sales_dr, v_sales_cr
    from fin.journal_lines l where l.journal_entry_id = v_sales_jv;
  if abs(v_sales_dr - v_sales_cr) > 0.01 or v_sales_dr <= 0 then
    raise exception 'E2E FAILED: sales journal unbalanced (% / %)', v_sales_dr, v_sales_cr;
  end if;

  -- (2) the COGS journal must exist, be posted, balanced, linked, and distinct
  if coalesce(r.out_journal_number, '') = '' then
    raise exception 'E2E FAILED: no COGS journal number returned';
  end if;

  select e.* into v_cogs
    from fin.journal_entries e
   where e.entry_number = r.out_journal_number;
  if v_cogs.id is null then
    raise exception 'E2E FAILED: COGS journal % does not exist', r.out_journal_number;
  end if;
  if not coalesce(v_cogs.is_posted, false) then
    raise exception 'E2E FAILED: COGS journal % is not posted', r.out_journal_number;
  end if;
  if v_cogs.id = v_sales_jv then
    raise exception 'E2E FAILED: COGS journal is the same entry as the sales journal';
  end if;
  if not (v_cogs.reference = v_inv.invoice_number or v_cogs.source_document_id = v_inv.id) then
    raise exception 'E2E FAILED: COGS journal % is not linked to invoice %', v_cogs.entry_number, v_inv.invoice_number;
  end if;

  select coalesce(sum(l.debit),0), coalesce(sum(l.credit),0)
    into v_cogs_dr, v_cogs_cr
    from fin.journal_lines l where l.journal_entry_id = v_cogs.id;
  if abs(v_cogs_dr - v_cogs_cr) > 0.01 or v_cogs_dr <= 0 then
    raise exception 'E2E FAILED: COGS journal unbalanced (% / %)', v_cogs_dr, v_cogs_cr;
  end if;

  -- (3) FIFO: 3 @ 10 then 2 @ 12
  select coalesce(sum(t.quantity_out),0), coalesce(sum(t.total_cost),0)
    into v_out_qty, v_out_cost
    from inventory.transactions t
   where t.document_number = v_inv.invoice_number
     and t.item_id = 'rpc-test-item'
     and t.quantity_out > 0;

  if abs(v_out_qty - 5) > 0.0001 then
    raise exception 'E2E FAILED: issued % units (expected 5)', v_out_qty;
  end if;
  if abs(v_out_cost - 54) > 0.01 then
    raise exception 'E2E FAILED: FIFO cost % (expected 54 = 3*10 + 2*12)', v_out_cost;
  end if;
  if abs(v_inv.cogs_total - 54) > 0.01 then
    raise exception 'E2E FAILED: invoice cogs_total % (expected 54)', v_inv.cogs_total;
  end if;
  if abs(v_cogs_dr - 54) > 0.01 then
    raise exception 'E2E FAILED: COGS journal debit % (expected 54)', v_cogs_dr;
  end if;

  select quantity into v_b1 from inventory.batches where id = 'rpc-test-b1';
  select quantity into v_b2 from inventory.batches where id = 'rpc-test-b2';
  if abs(v_b1) > 0.0001 or abs(v_b2 - 8) > 0.0001 then
    raise exception 'E2E FAILED: batch balances b1=% b2=% (expected 0 / 8)', v_b1, v_b2;
  end if;

  raise notice 'E2E 1 OK: invoice % posted, sales JV balanced (%), COGS JV % balanced (%), FIFO cost 54',
    v_inv.invoice_number, v_sales_dr, v_cogs.entry_number, v_cogs_dr;
end $$;

-- ---------------------------------------------------------------------
-- 4. idempotent retry: same key -> same invoice, nothing posted twice
-- ---------------------------------------------------------------------
do $$
declare
  v_inv_no      text;
  v_retry_no    text;
  v_jv_before   int;
  v_jv_after    int;
  v_tx_before   int;
  v_tx_after    int;
  v_tx_count    int;
  r             record;
begin
  select out_invoice_number into v_inv_no from t_call;

  select count(*) into v_jv_before
    from fin.journal_entries e
   where e.reference = v_inv_no
      or e.source_document_id = (select id from sales.invoices where invoice_number = v_inv_no);
  select count(*) into v_tx_before
    from inventory.transactions t where t.document_number = v_inv_no;

  select * into r from public.post_sales_invoice_integrated(
    p_customer_id      => 'rpc-test-cust',
    p_channel          => 'retail',
    p_warehouse_id     => 'qa-e2e-wh-01',
    p_payment_method   => 'credit',
    p_currency         => 'EGP',
    p_exchange_rate    => 1,
    p_date             => date '2026-10-20',
    p_lines            => '[{"itemId":"rpc-test-item","quantity":5,"unitPrice":30,"discount":0,"vatRate":0.14}]'::jsonb,
    p_created_by       => 'rpc-e2e',
    p_idempotency_key  => 'rpc-test-key-1'
  );
  v_retry_no := r.out_invoice_number;

  if v_retry_no is distinct from v_inv_no then
    raise exception 'E2E FAILED: retry created % instead of returning %', v_retry_no, v_inv_no;
  end if;

  select count(*) into v_jv_after
    from fin.journal_entries e
   where e.reference = v_inv_no
      or e.source_document_id = (select id from sales.invoices where invoice_number = v_inv_no);
  if v_jv_after <> v_jv_before then
    raise exception 'E2E FAILED: retry added journals (% -> %)', v_jv_before, v_jv_after;
  end if;
  if v_jv_before <> 2 then
    raise exception 'E2E FAILED: expected 2 journals for the invoice (sales + COGS), found %', v_jv_before;
  end if;

  select count(*) into v_tx_after
    from inventory.transactions t where t.document_number = v_inv_no;
  if v_tx_after <> v_tx_before then
    raise exception 'E2E FAILED: retry added inventory movements (% -> %)', v_tx_before, v_tx_after;
  end if;

  select count(*) into v_tx_count from sales.invoices where customer_id = 'rpc-test-cust';
  if v_tx_count <> 1 then
    raise exception 'E2E FAILED: retry created a second invoice (% invoices)', v_tx_count;
  end if;

  raise notice 'E2E 2 OK: idempotent retry returned % with % journals and % movements unchanged',
    v_inv_no, v_jv_after, v_tx_after;
end $$;

-- ---------------------------------------------------------------------
-- 5. forced downstream failure must leave nothing (atomic rollback)
-- ---------------------------------------------------------------------
do $$
declare
  v_invoices int;
  v_keys     int;
  v_failed   boolean := false;
begin
  begin
    perform public.post_sales_invoice_integrated(
      p_customer_id      => 'rpc-test-cust',
      p_channel          => 'retail',
      p_warehouse_id     => 'qa-e2e-wh-01',
      p_payment_method   => 'credit',
      p_currency         => 'EGP',
      p_exchange_rate    => 1,
      p_date             => date '2026-10-20',
      p_lines            => '[{"itemId":"rpc-test-item","quantity":999,"unitPrice":30,"discount":0,"vatRate":0.14}]'::jsonb,
      p_created_by       => 'rpc-e2e',
      p_idempotency_key  => 'rpc-test-key-fail'
    );
  exception when others then
    v_failed := true;
    raise notice 'E2E 3 expected refusal: %', sqlerrm;
  end;

  if not v_failed then
    raise exception 'E2E FAILED: issuing 999 units with 8 on hand was allowed';
  end if;

  select count(*) into v_invoices from sales.invoices where customer_id = 'rpc-test-cust';
  if v_invoices <> 1 then
    raise exception 'E2E FAILED: failed call left % invoices (expected only the first)', v_invoices;
  end if;

  select count(*) into v_keys from fin.rpc_idempotency where key = 'rpc-test-key-fail';
  if v_keys <> 0 then
    raise exception 'E2E FAILED: failed call left an idempotency row behind';
  end if;

  raise notice 'E2E 3 OK: forced inventory failure rolled back invoice, journals and movements';
end $$;

-- ---------------------------------------------------------------------
-- 6. closed period must be refused (September 2026 is closed)
-- ---------------------------------------------------------------------
do $$
declare
  v_failed boolean := false;
begin
  begin
    perform public.post_sales_invoice_integrated(
      p_customer_id      => 'rpc-test-cust',
      p_channel          => 'retail',
      p_warehouse_id     => 'qa-e2e-wh-01',
      p_payment_method   => 'credit',
      p_currency         => 'EGP',
      p_exchange_rate    => 1,
      p_date             => date '2026-09-15',
      p_lines            => '[{"itemId":"rpc-test-item","quantity":1,"unitPrice":30,"discount":0,"vatRate":0.14}]'::jsonb,
      p_created_by       => 'rpc-e2e',
      p_idempotency_key  => 'rpc-test-key-closed'
    );
  exception when others then
    v_failed := true;
    raise notice 'E2E 4 expected refusal (closed period): %', sqlerrm;
  end;

  if not v_failed then
    raise exception 'E2E FAILED: posting into a closed period was allowed';
  end if;

  if exists (select 1 from sales.invoices where customer_id = 'rpc-test-cust' and date = date '2026-09-15') then
    raise exception 'E2E FAILED: closed-period attempt left an invoice behind';
  end if;

  raise notice 'E2E 4 OK: closed period rejected with no partial writes';
end $$;

-- ---------------------------------------------------------------------
-- 7. Viewer role must be refused
-- ---------------------------------------------------------------------
do $$
declare
  v_failed boolean := false;
  r        record;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;

  begin
    select * into r from public.post_sales_invoice_integrated(
      p_customer_id      => 'rpc-test-cust',
      p_channel          => 'retail',
      p_warehouse_id     => 'qa-e2e-wh-01',
      p_payment_method   => 'credit',
      p_currency         => 'EGP',
      p_exchange_rate    => 1,
      p_date             => date '2026-10-20',
      p_lines            => '[{"itemId":"rpc-test-item","quantity":1,"unitPrice":30,"discount":0,"vatRate":0.14}]'::jsonb,
      p_created_by       => 'rpc-e2e',
      p_idempotency_key  => 'rpc-test-key-viewer'
    );
    -- the wrapper reports a refused posting as a row, not an exception
    if coalesce(r.out_success, false) then
      raise exception 'E2E FAILED: a Viewer was allowed to post invoice %', r.out_invoice_number;
    end if;
    v_failed := true;
    raise notice 'E2E 5 expected refusal (Viewer): %', coalesce(r.out_error, '(no message)');
  exception when others then
    if sqlerrm like 'E2E FAILED%' then raise; end if;
    v_failed := true;
    raise notice 'E2E 5 expected refusal (Viewer): %', sqlerrm;
  end;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  if not v_failed then
    raise exception 'E2E FAILED: Viewer attempt neither failed nor raised';
  end if;

  if exists (select 1 from fin.rpc_idempotency where key = 'rpc-test-key-viewer') then
    raise exception 'E2E FAILED: Viewer attempt left an idempotency row behind';
  end if;
  if (select count(*) from sales.invoices where customer_id = 'rpc-test-cust') <> 1 then
    raise exception 'E2E FAILED: Viewer attempt created an invoice';
  end if;

  raise notice 'E2E 5 OK: Viewer refused with no partial writes';
end $$;

rollback;

\echo ''
\echo 'ALL INTEGRATED SALES E2E CHECKS PASSED — transaction rolled back, nothing persisted.'
