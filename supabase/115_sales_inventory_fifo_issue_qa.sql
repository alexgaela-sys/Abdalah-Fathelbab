-- 115_sales_inventory_fifo_issue_qa.sql
--
-- Behavioural QA for public.post_sales_inventory_issue (TEST database only).
--
-- SAFETY: the whole script runs inside ONE transaction and ends with ROLLBACK.
-- Every synthetic row (batches, invoice, accounts, mappings, movements, journal)
-- disappears at the end. No existing row is modified permanently, nothing is
-- deleted, no historical invoice is re-posted.
--
-- Run:  psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/115_sales_inventory_fifo_issue_qa.sql
--
-- Expected evidence (printed at the end, before the rollback):
--   t1_mapping_guard_error = true      -- refuses when COGS mapping is absent
--   t2_status              = issued
--   t2_cogs                = 106.00    -- line1 5x10 + 1x14, line2 (2+1)x14
--   t2_batchA              = 0
--   t2_batchB              = 6
--   t2_tx_rows             = 2
--   t2_journal_balanced    = true      -- debit 106 = credit 106
--   t3_repeat_status       = already_posted
--   t3_tx_rows_after_repeat= 2
--   t4_short_status        = error
--   t4_batches_untouched   = true

begin;

-- ---------------------------------------------------------------
-- Synthetic fixtures (rolled back)
-- ---------------------------------------------------------------
do $$
declare
  v_wh  text := 'qa-e2e-wh-01';
  v_item text := 'qa-e2e-item-01';
begin
  if not exists (select 1 from core.warehouses where id = v_wh) then
    raise exception 'QA fixture missing: warehouse % not found', v_wh;
  end if;
  if not exists (select 1 from core.items where id = v_item) then
    raise exception 'QA fixture missing: item % not found', v_item;
  end if;
  if not exists (select 1 from core.customers where id = 'qa-e2e-cust-01') then
    raise exception 'QA fixture missing: customer qa-e2e-cust-01 not found';
  end if;
end $$;

insert into core.accounts (id, code, name_ar, name_en, category, is_header, level)
values
  ('qa-fifo-acc-cogs', 'QA-5101', 'QA تكلفة مبيعات', 'QA COGS', 'COGS', false, 2),
  ('qa-fifo-acc-fg',   'QA-1109', 'QA مخزون تام',    'QA Finished Goods', 'Assets', false, 2);

-- FIFO layers: A (older, 5 @ 10), B (newer, 10 @ 14)
insert into inventory.batches
  (id, item_id, warehouse_id, batch_number, production_date, expiry_date, quantity, unit_cost, active)
values
  ('qa-fifo-batch-a', 'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-FIFO-A', '2026-01-01', null, 5, 10, true),
  ('qa-fifo-batch-b', 'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-FIFO-B', '2026-02-01', null, 10, 14, true);

insert into sales.invoices
  (id, invoice_number, date, customer_id, channel, warehouse_id, payment_method, currency,
   exchange_rate, subtotal, discount_amount, vat_amount, total_amount, total_amount_egp,
   cogs_total, status, stock_source, created_by, is_test)
values
  ('qa-fifo-inv-01', 'QA-FIFO-INV-0001', '2026-10-20', 'qa-e2e-cust-01', 'wholesale',
   'qa-e2e-wh-01', 'cash', 'EGP', 1, 600, 0, 84, 684, 684, 0, 'posted', 'warehouse', 'qa', true),
  ('qa-fifo-inv-02', 'QA-FIFO-INV-0002', '2026-10-20', 'qa-e2e-cust-01', 'wholesale',
   'qa-e2e-wh-01', 'cash', 'EGP', 1, 5000, 0, 700, 5700, 5700, 0, 'posted', 'warehouse', 'qa', true);

insert into sales.invoice_lines
  (id, invoice_id, item_id, quantity, free_quantity, unit_price, unit_cost, discount,
   vat_rate, vat_amount, total_before_vat, net_total)
values
  ('qa-fifo-l1', 'qa-fifo-inv-01', 'qa-e2e-item-01', 6, 0, 100, 0, 0, 0.14, 84, 600, 684),
  ('qa-fifo-l2', 'qa-fifo-inv-01', 'qa-e2e-item-01', 2, 1, 0,   0, 0, 0,    0,  0,   0),
  ('qa-fifo-l3', 'qa-fifo-inv-02', 'qa-e2e-item-01', 999, 0, 5, 0, 0, 0.14, 700, 5000, 5700);

create temporary table qa_results (check_name text, observed text, ok boolean) on commit drop;

-- ---------------------------------------------------------------
-- T1 — missing COGS mapping must abort before any write
-- ---------------------------------------------------------------
do $$
declare
  r record;
  v_before numeric;
  v_after numeric;
begin
  select coalesce(sum(quantity), 0) into v_before
    from inventory.batches where item_id = 'qa-e2e-item-01' and warehouse_id = 'qa-e2e-wh-01';

  select * into r from public.post_sales_inventory_issue('qa-fifo-inv-01', 'qa', 'qa-key-t1');

  select coalesce(sum(quantity), 0) into v_after
    from inventory.batches where item_id = 'qa-e2e-item-01' and warehouse_id = 'qa-e2e-wh-01';

  insert into qa_results
  values ('t1_mapping_guard_error', coalesce(r.out_status, 'none'), r.out_success = false),
         ('t1_no_stock_moved', v_before::text || '->' || v_after::text, v_before = v_after);
end $$;

-- ---------------------------------------------------------------
-- Fixtures needed for the successful path
-- ---------------------------------------------------------------
insert into core.account_mappings (id, key, name_ar, account_id)
values ('qa-fifo-map-cogs', 'cogs_local', 'QA تكلفة مبيعات', 'qa-fifo-acc-cogs'),
       ('qa-fifo-map-fg',   'inventory_finished_local', 'QA مخزون تام', 'qa-fifo-acc-fg');

-- ---------------------------------------------------------------
-- T2 — happy path: FIFO cost, bonus quantity, movements, balanced journal
-- ---------------------------------------------------------------
do $$
declare
  r record;
  v_a numeric;
  v_b numeric;
  v_tx int;
  v_cogs numeric;
  v_line1 numeric;
  v_line2 numeric;
  v_dr numeric;
  v_cr numeric;
  v_entry text;
begin
  select * into r from public.post_sales_inventory_issue('qa-fifo-inv-01', 'qa', 'qa-key-t2');

  insert into qa_results values ('t2_status', coalesce(r.out_status, 'none'), r.out_success and r.out_status = 'issued');
  insert into qa_results values ('t2_cogs', coalesce(r.out_cogs::text, 'null'), r.out_cogs = 106);

  select quantity into v_a from inventory.batches where id = 'qa-fifo-batch-a';
  select quantity into v_b from inventory.batches where id = 'qa-fifo-batch-b';
  insert into qa_results values ('t2_batchA', v_a::text, v_a = 0);
  insert into qa_results values ('t2_batchB', v_b::text, v_b = 6);

  select count(*) into v_tx from inventory.transactions
   where document_number = 'QA-FIFO-INV-0001' and movement_type = 'sales';
  insert into qa_results values ('t2_tx_rows', v_tx::text, v_tx = 2);

  select cogs_total into v_cogs from sales.invoices where id = 'qa-fifo-inv-01';
  insert into qa_results values ('t2_invoice_cogs', v_cogs::text, v_cogs = 106);

  select unit_cost into v_line1 from sales.invoice_lines where id = 'qa-fifo-l1';
  select unit_cost into v_line2 from sales.invoice_lines where id = 'qa-fifo-l2';
  insert into qa_results values ('t2_line1_unit_cost', v_line1::text, abs(v_line1 - (64.0/6)) < 0.0001);
  insert into qa_results values ('t2_line2_unit_cost', v_line2::text, v_line2 = 14);
  insert into qa_results values ('t2_bonus_costed', v_line2::text, v_line2 = 14);

  select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
    into v_dr, v_cr
    from fin.journal_lines l
    join fin.journal_entries e on e.id = l.journal_entry_id
   where e.source_document_type = 'sales_invoice' and e.reference = 'QA-FIFO-INV-0001';

  insert into qa_results values ('t2_journal_balanced',
    format('dr=%s cr=%s entry=%s', v_dr, v_cr, coalesce(r.out_journal_number, 'null')),
    v_dr = 106 and v_cr = 106);

  -- inventory value check: value left the warehouse exactly by the COGS amount
  select coalesce(sum(quantity * unit_cost), 0) into v_cogs
    from inventory.batches where item_id = 'qa-e2e-item-01' and warehouse_id = 'qa-e2e-wh-01';
  insert into qa_results values ('t2_remaining_value', v_cogs::text, v_cogs = 6 * 14);
end $$;

-- ---------------------------------------------------------------
-- T3 — idempotency: same invoice twice must not issue again
-- ---------------------------------------------------------------
do $$
declare
  r record;
  v_tx int;
  v_cogs numeric;
begin
  select * into r from public.post_sales_inventory_issue('qa-fifo-inv-01', 'qa', 'qa-key-t3');
  insert into qa_results values ('t3_repeat_status', coalesce(r.out_status, 'none'), r.out_status = 'already_posted');

  select count(*) into v_tx from inventory.transactions
   where document_number = 'QA-FIFO-INV-0001' and movement_type = 'sales';
  insert into qa_results values ('t3_tx_rows_after_repeat', v_tx::text, v_tx = 2);

  select cogs_total into v_cogs from sales.invoices where id = 'qa-fifo-inv-01';
  insert into qa_results values ('t3_cogs_unchanged', v_cogs::text, v_cogs = 106);
end $$;

-- ---------------------------------------------------------------
-- T4 — insufficient stock must fail with zero writes
-- ---------------------------------------------------------------
do $$
declare
  r record;
  v_a numeric;
  v_b numeric;
  v_tx int;
  v_cogs numeric;
begin
  select * into r from public.post_sales_inventory_issue('qa-fifo-inv-02', 'qa', 'qa-key-t4');
  insert into qa_results values ('t4_short_status', coalesce(r.out_status, 'none'), r.out_success = false);

  select quantity into v_a from inventory.batches where id = 'qa-fifo-batch-a';
  select quantity into v_b from inventory.batches where id = 'qa-fifo-batch-b';
  insert into qa_results values ('t4_batches_untouched', format('%s/%s', v_a, v_b), v_a = 0 and v_b = 6);

  select count(*) into v_tx from inventory.transactions
   where document_number = 'QA-FIFO-INV-0002';
  insert into qa_results values ('t4_no_movements', v_tx::text, v_tx = 0);

  select cogs_total into v_cogs from sales.invoices where id = 'qa-fifo-inv-02';
  insert into qa_results values ('t4_invoice_untouched', v_cogs::text, v_cogs = 0);
end $$;

-- ---------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------
\echo ''
\echo '=== post_sales_inventory_issue QA (transaction will be rolled back) ==='
select check_name, observed, case when ok then 'PASS' else 'FAIL' end as verdict
  from qa_results
 order by check_name;

select count(*) filter (where not ok) as failures from qa_results;

rollback;
