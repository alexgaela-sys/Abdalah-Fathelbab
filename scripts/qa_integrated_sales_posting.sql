-- qa_integrated_sales_posting.sql
-- Path A integrated tests (TEST only). Everything runs inside ONE transaction
-- and the script ends with ROLLBACK, so no row it creates can survive.
--
-- Rules asserted here are taken from the LOCAL engine
-- (src/services/workflows.ts createSalesInvoice + src/services/inventory.ts
-- planFifoConsumption), NOT invented:
--   * issued qty per line = quantity + freeQuantity (bonus cartons leave the
--     warehouse and ARE costed, they are just never priced),
--   * FIFO cost comes from the actual layers that leave the warehouse,
--   * negative stock / insufficient balance is rejected BEFORE any write.
--
-- Expected numbers for the SUCCESS case (5 paid + 1 bonus @ cost 10):
--   issued qty = 6, COGS = 60, sale journal = 500 + 70 VAT = 570.
--
-- Channel/payment choice: TEST only carries the mapping keys
--   sales_vat_output / customer_receivable_local / cash_treasury /
--   sales_retail_revenue
-- so channel='retail' + payment='cash' is the only combination where
-- fin.post_sales_invoice posts a REAL sale journal instead of falling back to
-- its journal-less test placeholder. All 31 existing TEST invoices are retail.
--
-- Run: psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/qa_integrated_sales_posting.sql

begin;

create temporary table qa_res (name text primary key, status text, detail text) on commit drop;

create temporary table qa_base (label text, n bigint) on commit drop;
insert into qa_base
select 'sales.invoices', count(*) from sales.invoices
union all select 'sales.invoice_lines', count(*) from sales.invoice_lines
union all select 'inventory.transactions', count(*) from inventory.transactions
union all select 'inventory.batches', count(*) from inventory.batches
union all select 'fin.journal_entries', count(*) from fin.journal_entries
union all select 'fin.journal_lines', count(*) from fin.journal_lines
union all select 'fin.rpc_idempotency', count(*) from fin.rpc_idempotency;

-- Accounts / mappings the companion needs. They are created inside this
-- transaction only (rolled back at the end); no mapping is invented for
-- production, and the three QA accounts are never used as a real chart of
-- accounts — they only exist so the NO-MAPPING guard is not the failure cause.
insert into core.accounts (id, code, name_ar, name_en, category, is_header, level)
values
  ('qa-fifo-acc-cogs', '5101', 'QA COGS', 'QA COGS', 'COGS', false, 2),
  ('qa-fifo-acc-fg', '1109', 'QA Finished Goods', 'QA Finished Goods', 'Assets', false, 2)
on conflict (id) do nothing;

insert into core.account_mappings (id, key, name_ar, account_id)
values
  ('qa-int-map-cogs', 'cogs_local', 'QA COGS', 'qa-fifo-acc-cogs'),
  ('qa-int-map-fg', 'inventory_finished_local', 'QA Finished Goods', 'qa-fifo-acc-fg')
on conflict (id) do nothing;

do $$
declare
  r          record;
  r2         record;
  r3         record;
  v_err      text;
  v_before   int;
  v_after    int;
  v_inv_id   text;
  v_inv      record;
  v_tx_count int;
  v_tx_qty   numeric;
  v_tx_cost  numeric;
  v_bat_qty  numeric;
  v_je_count int;
  v_dr       numeric;
  v_cr       numeric;
  v_gate_key text;
begin
  -- ============================================================
  -- 1) INSUFFICIENT STOCK -> companion refuses -> wrapper must RAISE
  --    so that the sales-side invoice/journal can NEVER be committed
  --    without the matching inventory issue and COGS.
  -- ============================================================
  select count(*) into v_before from sales.invoices where customer_id = 'qa-e2e-cust-01';
  v_err := null;
  begin
    select * into r from public.post_sales_invoice_integrated(
      'qa-e2e-cust-01', 'retail', 'qa-e2e-wh-01', 'cash', 'EGP', 1,
      '2026-10-20',
      '[{"itemId":"qa-e2e-item-01","quantity":5,"unitPrice":100,"vatRate":0.14}]',
      'qa', 'qa-key-no-stock');
    v_err := 'NO EXCEPTION RAISED (returned status=' || coalesce(r.out_status, '?') || ')';
  exception when others then
    v_err := SQLERRM;
  end;
  select count(*) into v_after from sales.invoices where customer_id = 'qa-e2e-cust-01';

  insert into qa_res (name, status, detail) values
    ('NO_STOCK_rejects_entire_wrapper',
      case when v_err like '%ولا يكفي لصرف%' or v_err like '%الرصيد المتاح%'
           then 'PASS' else 'FAIL' end, v_err),
    ('NO_STOCK_no_partial_invoice',
      case when v_before = v_after then 'PASS' else 'FAIL' end,
      format('sales invoices for the QA customer before=%s after=%s', v_before, v_after)),
    ('NO_STOCK_no_idempotency_row',
      case when not exists (select 1 from fin.rpc_idempotency where key = 'qa-key-no-stock')
           then 'PASS' else 'FAIL' end,
      'a failed call must not leave its idempotency key');

  -- ============================================================
  -- 2) SUCCESS case: build isolated FIFO stock, then post integrated.
  -- ============================================================
  insert into inventory.batches
    (id, item_id, warehouse_id, batch_number, production_date, expiry_date,
     quantity, unit_cost, active)
  values
    ('qa-int-bat-A', 'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-INT-A', '2026-01-10', null,
     10, 10, true)
  on conflict (id) do nothing;

  insert into inventory.transactions
    (id, date, document_type, document_number, movement_type, item_id, warehouse_id,
     batch_number, quantity_in, quantity_out, balance_after, unit_cost, total_cost,
     notes, created_by, is_test)
  values
    ('qa-int-tx-A', '2026-10-01', 'اختبار داخلي', 'QA-INT-RCV', 'purchase_receipt',
     'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-INT-A', 10, 0, 10, 10, 100,
     '!', 'qa', true)
  on conflict (id) do nothing;

  v_err := null;
  begin
    select * into r from public.post_sales_invoice_integrated(
      'qa-e2e-cust-01', 'retail', 'qa-e2e-wh-01', 'cash', 'EGP', 1,
      '2026-10-20',
      '[{"itemId":"qa-e2e-item-01","quantity":5,"freeQuantity":1,"unitPrice":100,"vatRate":0.14}]',
      'qa', 'qa-key-success');
  exception when others then
    v_err := SQLERRM;
  end;

  insert into qa_res (name, status, detail) values
    ('SUCCESS_issue_returned',
      case when v_err is null and coalesce(r.out_success, false) = true
                and r.out_status = 'issued'
           then 'PASS' else 'FAIL' end,
      coalesce(v_err, coalesce(r.out_error, r.out_status))),
    -- workflows.ts: cogsTotal += cost.totalUnits * unitCost, totalUnits = qty + free
    ('SUCCESS_cogs_equals_60',
      case when coalesce(r.out_cogs, -1) = 60 then 'PASS' else 'FAIL' end,
      coalesce(r.out_cogs::text, 'null')),
    ('SUCCESS_invoice_number_present',
      case when r.out_invoice_number is not null and r.out_invoice_number <> ''
           then 'PASS' else 'FAIL' end,
      coalesce(r.out_invoice_number, 'null')),
    ('SUCCESS_journal_number_present',
      case when r.out_journal_number is not null and r.out_journal_number <> ''
           then 'PASS' else 'FAIL' end,
      coalesce(r.out_journal_number, 'null'));

  -- ============================================================
  -- 3) READ-BACK of the state the wrapper committed.
  -- ============================================================
  select i.id into v_inv_id from sales.invoices i
   where i.invoice_number = r.out_invoice_number;

  if v_inv_id is null then
    insert into qa_res (name, status, detail)
      values ('READBACK_invoice_exists', 'FAIL',
              'no invoice with number ' || coalesce(r.out_invoice_number, 'null'));
    return;
  end if;

  select * into v_inv from sales.invoices where id = v_inv_id;

  insert into qa_res (name, status, detail) values
    ('READBACK_invoice_status_posted',
      case when v_inv.status = 'posted' then 'PASS' else 'FAIL' end, v_inv.status),
    ('READBACK_invoice_cogs_60',
      case when coalesce(v_inv.cogs_total, -1) = 60 then 'PASS' else 'FAIL' end,
      coalesce(v_inv.cogs_total::text, 'null')),
    ('READBACK_invoice_warehouse',
      case when v_inv.warehouse_id = 'qa-e2e-wh-01' and v_inv.stock_source = 'warehouse'
           then 'PASS' else 'FAIL' end,
      v_inv.warehouse_id || '/' || v_inv.stock_source),
    ('READBACK_invoice_totals',
      case when v_inv.subtotal = 500 and v_inv.vat_amount = 70 and v_inv.total_amount = 570
           then 'PASS' else 'FAIL' end,
      v_inv.subtotal::text || '/' || v_inv.vat_amount::text || '/' || v_inv.total_amount::text);

  -- one movement row, qty = paid + free, cost = 6 x 10
  select count(*), coalesce(sum(t.quantity_out), 0), coalesce(sum(t.total_cost), 0)
    into v_tx_count, v_tx_qty, v_tx_cost
    from inventory.transactions t
   where t.document_number = v_inv.invoice_number
     and t.movement_type = 'sales';

  insert into qa_res (name, status, detail) values
    ('READBACK_one_sales_movement',
      case when v_tx_count = 1 then 'PASS' else 'FAIL' end, v_tx_count::text),
    ('READBACK_movement_qty_6',
      case when v_tx_qty = 6 then 'PASS' else 'FAIL' end, v_tx_qty::text),
    ('READBACK_movement_cost_60',
      case when v_tx_cost = 60 then 'PASS' else 'FAIL' end, v_tx_cost::text);

  select coalesce(sum(b.quantity), 0) into v_bat_qty
    from inventory.batches b
   where b.item_id = 'qa-e2e-item-01' and b.warehouse_id = 'qa-e2e-wh-01';

  insert into qa_res (name, status, detail) values
    ('READBACK_batch_reduced_to_4',
      case when v_bat_qty = 4 then 'PASS' else 'FAIL' end, v_bat_qty::text);

  -- Sale journal: posted by fin.post_sales_invoice, linked by source_document_id
  select count(*), coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
    into v_je_count, v_dr, v_cr
    from fin.journal_lines l
    join fin.journal_entries e on e.id = l.journal_entry_id
   where e.source_document_type = 'sales_invoice'
     and e.source_document_id = v_inv.id
     and e.is_posted = true;

  insert into qa_res (name, status, detail) values
    ('READBACK_sale_journal_exists',
      case when v_je_count > 0 then 'PASS' else 'FAIL' end, v_je_count::text),
    ('READBACK_sale_journal_balanced_570',
      case when v_je_count > 0 and abs(v_dr - v_cr) < 0.01 and v_dr = 570
           then 'PASS' else 'FAIL' end,
      v_dr::text || '/' || v_cr::text);

  -- COGS journal: posted through fin.post_journal, which leaves
  -- source_document_id NULL and carries the invoice number as reference.
  select count(*), coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
    into v_je_count, v_dr, v_cr
    from fin.journal_lines l
    join fin.journal_entries e on e.id = l.journal_entry_id
   where e.source_document_type = 'sales_invoice'
     and e.reference = v_inv.invoice_number
     and e.source_document_id is null
     and e.is_posted = true;

  insert into qa_res (name, status, detail) values
    ('READBACK_cogs_journal_exists',
      case when v_je_count > 0 then 'PASS' else 'FAIL' end, v_je_count::text),
    ('READBACK_cogs_journal_balanced_60',
      case when v_je_count > 0 and abs(v_dr - v_cr) < 0.01 and v_dr = 60
           then 'PASS' else 'FAIL' end,
      v_dr::text || '/' || v_cr::text);

  -- ============================================================
  -- 4) REPEAT with the same key -> already_posted, nothing new.
  -- ============================================================
  select count(*) into v_before from sales.invoices where customer_id = 'qa-e2e-cust-01';
  select count(*) into v_tx_count from inventory.transactions
   where document_number = v_inv.invoice_number and movement_type = 'sales';

  v_err := null;
  begin
    select * into r2 from public.post_sales_invoice_integrated(
      'qa-e2e-cust-01', 'retail', 'qa-e2e-wh-01', 'cash', 'EGP', 1,
      '2026-10-20',
      '[{"itemId":"qa-e2e-item-01","quantity":5,"freeQuantity":1,"unitPrice":100,"vatRate":0.14}]',
      'qa', 'qa-key-success');
  exception when others then
    v_err := SQLERRM;
  end;
  select count(*) into v_after from sales.invoices where customer_id = 'qa-e2e-cust-01';

  insert into qa_res (name, status, detail) values
    ('REPEAT_returns_already_posted',
      case when v_err is null and r2.out_status = 'already_posted'
                and coalesce(r2.out_success, false) = true
           then 'PASS' else 'FAIL' end,
      coalesce(v_err, coalesce(r2.out_error, r2.out_status))),
    ('REPEAT_invoice_count_unchanged',
      case when v_before = v_after then 'PASS' else 'FAIL' end,
      format('before=%s after=%s', v_before, v_after)),
    ('REPEAT_movement_count_unchanged',
      case when v_tx_count = (select count(*) from inventory.transactions
                               where document_number = v_inv.invoice_number
                                 and movement_type = 'sales')
           then 'PASS' else 'FAIL' end,
      v_tx_count::text);

  -- ============================================================
  -- 5) CENTRAL GATE: a key that exists but points at no invoice must be
  --    refused with an explicit error (never reported as success).
  -- ============================================================
  v_gate_key := 'qa-key-forced-refusal-' || substr(gen_random_uuid()::text, 1, 8);
  insert into fin.rpc_idempotency (key, invoice_id)
    values (v_gate_key, 'qa-dummy')
    on conflict (key) do nothing;

  v_err := null;
  begin
    select * into r3 from public.post_sales_invoice_integrated(
      'qa-e2e-cust-01', 'retail', 'qa-e2e-wh-01', 'cash', 'EGP', 1,
      '2026-10-21',
      '[{"itemId":"qa-e2e-item-01","quantity":1,"unitPrice":10,"vatRate":0.14}]',
      'qa', v_gate_key);
  exception when others then
    v_err := SQLERRM;
  end;

  insert into qa_res (name, status, detail) values
    ('CENTRAL_GATE_refuses_existing_key',
      case when v_err is null and coalesce(r3.out_success, false) = false
                and r3.out_error like '%no invoice is linked%'
           then 'PASS' else 'FAIL' end,
      coalesce(v_err, coalesce(r3.out_error, 'no error returned')));

  delete from fin.rpc_idempotency where key = v_gate_key;
end $$;

-- ============================================================
-- Verdict
-- ============================================================
\echo ''
\echo '=== qa_integrated_sales_posting verdict (all synthetic, rolled back) ==='
select name, status as verdict, detail
  from qa_res
 order by
   case name
     when 'NO_STOCK_rejects_entire_wrapper'    then 1
     when 'NO_STOCK_no_partial_invoice'        then 2
     when 'NO_STOCK_no_idempotency_row'        then 3
     when 'SUCCESS_issue_returned'             then 4
     when 'SUCCESS_cogs_equals_60'             then 5
     when 'SUCCESS_invoice_number_present'     then 6
     when 'SUCCESS_journal_number_present'     then 7
     when 'READBACK_invoice_exists'            then 8
     when 'READBACK_invoice_status_posted'     then 9
     when 'READBACK_invoice_cogs_60'           then 10
     when 'READBACK_invoice_warehouse'         then 11
     when 'READBACK_invoice_totals'            then 12
     when 'READBACK_one_sales_movement'        then 13
     when 'READBACK_movement_qty_6'            then 14
     when 'READBACK_movement_cost_60'          then 15
     when 'READBACK_batch_reduced_to_4'        then 16
     when 'READBACK_sale_journal_exists'       then 17
     when 'READBACK_sale_journal_balanced_570' then 18
     when 'READBACK_cogs_journal_exists'       then 19
     when 'READBACK_cogs_journal_balanced_60'  then 20
     when 'REPEAT_returns_already_posted'      then 21
     when 'REPEAT_invoice_count_unchanged'     then 22
     when 'REPEAT_movement_count_unchanged'    then 23
     when 'CENTRAL_GATE_refuses_existing_key'  then 24
     else 99
   end, name;

with s as (select count(*)::int as failures from qa_res where status = 'FAIL')
select (select count(*) from qa_res) as checks, (select failures from s) as failures;

\echo ''
\echo '=== row counts now vs baseline (must be equal; ROLLBACK below discards everything) ==='
select b.label, b.n as baseline,
       case b.label
         when 'sales.invoices' then (select count(*) from sales.invoices)
         when 'sales.invoice_lines' then (select count(*) from sales.invoice_lines)
         when 'inventory.transactions' then (select count(*) from inventory.transactions)
         when 'inventory.batches' then (select count(*) from inventory.batches)
         when 'fin.journal_entries' then (select count(*) from fin.journal_entries)
         when 'fin.journal_lines' then (select count(*) from fin.journal_lines)
         when 'fin.rpc_idempotency' then (select count(*) from fin.rpc_idempotency)
       end as now_n
  from qa_base b
 order by b.label;

rollback;

\echo ''
\echo '=== transaction rolled back: nothing from this run persisted ==='
