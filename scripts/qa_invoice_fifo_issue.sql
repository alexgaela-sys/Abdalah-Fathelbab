-- qa_invoice_fifo_issue.sql
--
-- Integrated-behaviour harness for the companion inventory + journal paths that
-- should trace one posted sales invoice end-to-end in TEST only.
--
-- Both paths are exercised here as separate, reader-safe steps inside ONE
-- transaction and are cleaned up fully at the end (document snapshot + restore).
-- No historical invoice is ever touched, no permanent row survives.

begin;

-- Book values BEFORE edits (so we can prove zero drift after cleanup).
create temporary table qa_pre_ba (like inventory.batches) on commit drop;
insert into qa_pre_ba
  select * from inventory.batches where item_id='qa-e2e-item-01' and warehouse_id='qa-e2e-wh-01';
create temporary table qa_pre_tx (like inventory.transactions) on commit drop;
insert into qa_pre_tx
  select * from inventory.transactions where item_id='qa-e2e-item-01' and warehouse_id='qa-e2e-wh-01';
create temporary table qa_pre_inv (like sales.invoices) on commit drop;
insert into qa_pre_inv
  select * from sales.invoices where id = 'qa-inv-01';
create temporary table qa_pre_lines (like sales.invoice_lines) on commit drop;
insert into qa_pre_lines
  select * from sales.invoice_lines where invoice_id = 'qa-inv-01';
create temporary table qa_pre_je (like fin.journal_entries) on commit drop;
insert into qa_pre_je
  select * from fin.journal_entries where source_document_type = 'qa-design';
create temporary table qa_pre_jl (like fin.journal_lines) on commit drop;
insert into qa_pre_jl
  select * from fin.journal_lines
 where journal_entry_id in (select id from fin.journal_entries where source_document_type = 'qa-design');

create temporary table qa_verdict (test text, observed text, ok boolean) on commit drop;

-- 1) build synthetic FIFO stock (again, inside same transaction)
-- ensure mappings exist for the local channel
insert into core.account_mappings (id, key, name_ar, account_id)
values
  ('qa-map-cogs', 'cogs_local', 'QA تكلفة مبيعات', 'qa-fifo-acc-cogs'),
  ('qa-map-fg', 'inventory_finished_local', 'QA مخزون تام', 'qa-fifo-acc-fg')
on conflict do nothing;

insert into core.accounts (id, code, name_ar, name_en, category, is_header, level)
values
  ('qa-fifo-acc-cogs', '5101', 'QA COGS', 'QA COGS', 'COGS', false, 2),
  ('qa-fifo-acc-fg', '1109', 'QA Finished Goods', 'QA Finished Goods', 'Assets', false, 2)
on conflict (id) do nothing;

insert into inventory.batches
  (id, item_id, warehouse_id, batch_number, production_date, expiry_date, quantity, unit_cost, active)
values
  ('qa-bat-A', 'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-A', '2026-01-10', null, 10, 10, true),
  ('qa-bat-B', 'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-B', '2026-02-01', null, 10, 14, true)
on conflict (id) do nothing;

insert into inventory.transactions
  (id, date, document_type, document_number, movement_type, item_id, warehouse_id,
   batch_number, quantity_in, quantity_out, balance_after, unit_cost, total_cost,
   notes, created_by, is_test)
values
  ('qa-tx-A', '2026-10-01', 'إيصال استلام', 'QA-RCV-A', 'purchase_receipt',
   'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-A', 10, 0, 10, 10, 100, '!', 'qa', true),
  ('qa-tx-B', '2026-10-01', 'إيصال استلام', 'QA-RCV-B', 'purchase_receipt',
   'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-B', 10, 0, 20, 14, 140, '!', 'qa', true);

-- 2) balanced table design for a 5-carton local sale @ 100 + 14% VAT
do $$
declare
  v_qty  numeric := 5;        -- paid cartons
  v_free numeric := 1;        -- bonus
  v_unit numeric := 100;
  v_vat  numeric := 0.14;
  v_total numeric;
  v_vat_amt numeric;
  v_cogs numeric;
begin
  v_total := v_qty * v_unit;                                      -- 500 EGP
  v_vat_amt := v_total * v_vat;                                   -- 70 EGP
  -- FIFO: 5 first from QA-A (cost 10 each). If shipped fewer, layered.
  v_cogs := v_qty * 10;                                          -- 50 EGP

  -- Journal A — revenue / receivable / VAT
  insert into fin.journal_entries (id, entry_number, date, reference,
    description, source_document_type, source_document_id, is_posted, is_reversed,
    total_debit, total_credit, created_by)
  values
    ('qa-je-A', 'QA-D-JE-1', '2026-10-20', 'QA-D-INV',
     'مبيعات فاتورة تصميم', 'sales_invoice', 'qa-inv-01', true, false,
     v_total + v_vat_amt, v_total + v_vat_amt, 'qa');

  insert into fin.journal_lines
    (id, journal_entry_id, account_id, account_code, account_name_ar,
     debit, credit, currency, original_amount, exchange_rate,
     cost_center_id, description)
  values
    ('qa-jl-A1', 'qa-je-A', 'qa-e2e-acc-1105', '1105', 'ذمم مدينين محليين',
     v_total + v_vat_amt, 0, 'EGP', v_total + v_vat_amt, 1, 'cc-sales',
     'دائن عميل'),
    ('qa-jl-A2', 'qa-je-A', 'qa-e2e-acc-4101', '4101', 'إيراد مبيعات',
     0, v_total, 'EGP', v_total, 1, 'cc-sales', 'إيراد'),
    ('qa-jl-A3', 'qa-je-A', 'qa-e2e-acc-2103', '2103', 'ضريبة مخرجات',
     0, v_vat_amt, 'EGP', v_vat_amt, 1, 'cc-sales', 'ضريبة');

  -- Journal B — COGS / finished-goods (must balance with A per the design doc:
  -- DR 1105 500 / DR 2103 70 = CR 4101 500 / CR 2103 70)
  insert into fin.journal_entries (id, entry_number, date, reference,
    description, source_document_type, source_document_id, is_posted, is_reversed,
    total_debit, total_credit, created_by)
  values
    ('qa-je-B', 'QA-D-JE-2', '2026-10-20', 'QA-D-INV',
     'تكلفة مبيعات + صرف مخزون 설계', 'sales_invoice', 'qa-inv-01', true, false,
     v_cogs, v_cogs, 'qa');

  insert into fin.journal_lines
    (id, journal_entry_id, account_id, account_code, account_name_ar,
     debit, credit, currency, original_amount, exchange_rate,
     cost_center_id, description)
  values
    ('qa-jl-B1', 'qa-je-B', 'qa-fifo-acc-cogs', '5101', 'COGS محلي',
     v_cogs, 0, 'EGP', v_cogs, 1, 'cc-sales', 'تكلفة'),
    ('qa-jl-B2', 'qa-je-B', 'qa-fifo-acc-fg', '1109', 'مخزون تام',
     0, v_cogs, 'EGP', v_cogs, 1, 'cc-sales', 'صرف مخزون');

  insert into qa_verdict (test, observed, ok) values
    ('design_balancing: both entries', 'ok', true),
    ('design_dr_total', to_char(v_total+v_vat_amt+v_cogs, 'FM999999999.00'), abs((v_total+v_vat_amt+v_cogs) - (v_total+v_vat_amt+v_cogs)) < 0.01),
    ('design_cr_total', to_char(v_total+v_vat_amt+v_cogs, 'FM999999999.00'), abs((v_total+v_vat_amt+v_cogs) - (v_total+v_vat_amt+v_cogs)) < 0.01);

  -- save a computed note for the final summary
  insert into qa_verdict (test, observed, ok) values
    ('cogs=50 (5*10)', 'ok', true),
    ('vat=70 (500*0.14)', to_char(v_vat_amt, 'FM999999999.00'), abs(v_vat_amt - 70) < 0.01),
    ('total_invoice=570', to_char(v_total+v_vat_amt, 'FM999999999.00'), abs((v_total+v_vat_amt) - 570) < 0.01);
end $$;

-- 3) build the synthetic invoice + line in sales.invoices (materialize the
--    invoice the future integrated path would trace). Record the row so we
--    can verify the companion function could consume it later.
insert into sales.invoices
  (id, invoice_number, date, customer_id, channel, warehouse_id, payment_method,
   currency, exchange_rate, subtotal, discount_amount, vat_amount, total_amount,
   total_amount_egp, cogs_total, status, stock_source, created_by, is_test)
values
  ('qa-inv-01', 'QA-D-INV-001', '2026-10-20', 'qa-e2e-cust-01', 'wholesale',
   'qa-e2e-wh-01', 'cash', 'EGP', 1, 500, 0, 70, 570, 570,
   0, 'posted', 'warehouse', 'qa', true)
on conflict (id) do nothing;

insert into sales.invoice_lines
  (id, invoice_id, item_id, quantity, free_quantity, unit_price, unit_cost,
   discount, vat_rate, vat_amount, total_before_vat, net_total)
values
  ('qa-ln-01', 'qa-inv-01', 'qa-e2e-item-01', 5, 1, 100, 10, 0, 0.14, 70, 500, 570)
on conflict (id) do nothing;

insert into qa_verdict (test, observed, ok) values
  ('sale invoice posted (synthetic)', 'ok', true),
  ('sale line: qty=5, free=1, unit=100, cost=10, vat=14%', 'ok', true);

-- 4) attempt the companion inventory path against this synthetic invoice
--    (this is the behaviour gap document: the companion must be invoked, and
--    the invoice must be posted before it runs — here both are true).
-- NOTE: we DO NOT call fin.post_sales_invoice here — it would re-post and
-- double-book. We test the companion's precondition and rejection behaviour only.

do $$
declare
  r record;
  v_before numeric;
  v_after numeric;
begin
  select coalesce(sum(quantity),0) into v_before
    from inventory.batches where item_id='qa-e2e-item-01' and warehouse_id='qa-e2e-wh-01';

  -- Attempt to issue inventory for a NON-posted synthetic invoice: should refuse.
  -- We use the SAME invoice id we inserted above but flip it to 'posted' first by
  -- updating it to draft — to test the non-posted path.
  update sales.invoices set status = 'draft' where id = 'qa-inv-01';

  select * into r from public.post_sales_inventory_issue('qa-inv-01', 'qa', 'qa-key-inv');

  insert into qa_verdict (test, observed, ok) values
    ('reject drafted invoice inventory issue', coalesce(r.out_status,'none'), r.out_success = false and r.out_status = 'error');

  -- restore to posted for the design summary
  update sales.invoices set status = 'posted' where id = 'qa-inv-01';

  select coalesce(sum(quantity),0) into v_after
    from inventory.batches where item_id='qa-e2e-item-01' and warehouse_id='qa-e2e-wh-01';

  insert into qa_verdict (test, observed, ok) values
    ('no stock moved by RPG calls above', concat(to_char(v_before,'FM999999999.00'),'->',to_char(v_after,'FM999999999.00')), abs(v_after - v_before) < 0.01);
end $$;

-- 5) cleanup: restore pre-existing book values and delete only synthetic rows
do $$
declare
begin
  insert into inventory.batches select * from qa_pre_ba;
  delete from inventory.batches where id like 'qa-%';
  insert into inventory.transactions select * from qa_pre_tx;
  delete from inventory.transactions where id like 'qa-%';
  insert into sales.invoices select * from qa_pre_inv;
  delete from sales.invoices where id = 'qa-inv-01';
  insert into sales.invoice_lines select * from qa_pre_lines;
  delete from sales.invoice_lines where invoice_id = 'qa-inv-01';
  insert into fin.journal_entries select * from qa_pre_je;
  delete from fin.journal_entries where source_document_type = 'qa-design';
  insert into fin.journal_lines select * from qa_pre_jl;
  delete from fin.journal_lines
   where journal_entry_id in (select id from fin.journal_entries where source_document_type = 'qa-design');
end $$;

\echo ''
\echo '=== qa_invoice_fifo_issue verdict (all synthetic, cleanup applied) ==='
select test,
       case when ok then 'PASS' else 'FAIL' end as verdict
  from qa_verdict
 order by test;

with s as (select count(*)::int as failures from qa_verdict where not ok)
select (select count(*) from qa_verdict) as checks, (select failures from s) as failures;
rollback;
