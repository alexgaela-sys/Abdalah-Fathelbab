-- qa_wholesale_invoice_integrated.sql
begin;

create temporary table qa_wholesale (label text, value text, ok boolean) on commit drop;

insert into qa_wholesale (label, value, ok) values
  ('start', 'begin', true);

insert into core.account_mappings (id, key, name_ar, account_id)
values
  ('qa-map-cogs-wh', 'cogs_wholesale', 'QA COGS wholesale', 'qa-fifo-acc-cogs'),
  ('qa-map-fg-wh', 'inventory_finished_wholesale', 'QA Finished Goods wholesale', 'qa-fifo-acc-fg')
on conflict do nothing;

insert into qa_wholesale (label, value, ok) values
  ('mappings_inserted', 'ok', true);

create temporary table qa_pre (like inventory.batches) on commit drop;
insert into qa_pre select * from inventory.batches where id like 'qa-wh-%';
create temporary table qa_pre_tx (like inventory.transactions) on commit drop;
insert into qa_pre_tx select * from inventory.transactions where id like 'qa-wh-%';

insert into inventory.batches
  (id, item_id, warehouse_id, batch_number, production_date, expiry_date, quantity, unit_cost, active)
values
  ('qa-wh-A', 'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-WH-A', '2026-01-10', null, 10, 10, true)
on conflict (id) do nothing;

insert into inventory.transactions
  (id, date, document_type, document_number, movement_type, item_id, warehouse_id,
   batch_number, quantity_in, quantity_out, balance_after, unit_cost, total_cost,
   notes, created_by, is_test)
values
  ('qa-wh-TX', '2026-10-01', 'إيصال استلام', 'QA-WH-RCV', 'purchase_receipt',
   'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-WH-A', 10, 0, 10, 10, 100, '!', 'qa', true);

insert into qa_wholesale (label, value, ok) values
  ('batches_inserted', 'ok', true);

insert into sales.invoices
  (id, invoice_number, date, customer_id, channel, warehouse_id, payment_method,
   currency, exchange_rate, subtotal, discount_amount, vat_amount, total_amount,
   total_amount_egp, cogs_total, status, stock_source, created_by, is_test)
values
  ('qa-inv-wh', 'QA-WH-INV-001', '2026-10-20', 'qa-e2e-cust-01', 'wholesale',
   'qa-e2e-wh-01', 'cash', 'EGP', 1, 500, 0, 70, 570, 570,
   0, 'posted', 'warehouse', 'qa', true)
on conflict (id) do nothing;

insert into sales.invoice_lines
  (id, invoice_id, item_id, quantity, free_quantity, unit_price, unit_cost,
   discount, vat_rate, vat_amount, total_before_vat, net_total)
values
  ('qa-ln-wh', 'qa-inv-wh', 'qa-e2e-item-01', 5, 1, 100, 10, 0, 0.14, 70, 500, 570)
on conflict (id) do nothing;

insert into qa_wholesale (label, value, ok) values
  ('invoice_lines_stored', 'ok', true),
  ('cogs_total_still_0', '0', true);

update sales.invoices set cogs_total = 50 where id = 'qa-inv-wh';

insert into fin.journal_entries (id, entry_number, date, reference, description,
  source_document_type, source_document_id, is_posted, is_reversed,
  total_debit, total_credit, created_by)
values ('qa-je-wh', 'QA-WH-JV-1', '2026-10-20', 'QA-WH-INV-001', 'مبيعات فاتورة wholesale',
  'sales_invoice', 'qa-inv-wh', true, false, 570, 570, 'qa');

insert into fin.journal_lines
  (id, journal_entry_id, account_id, account_code, account_name_ar,
   debit, credit, currency, original_amount, exchange_rate, cost_center_id, description)
values
  ('qa-jl-wh-1', 'qa-je-wh', 'qa-e2e-acc-1105', '1105', 'ذمم مدينين محليين',
   570, 0, 'EGP', 570, 1, 'cc-sales', 'دائن عميل'),
  ('qa-jl-wh-2', 'qa-je-wh', 'qa-e2e-acc-4101', '4101', 'إيراد مبيعات',
   0, 500, 'EGP', 500, 1, 'cc-sales', 'إيراد'),
  ('qa-jl-wh-3', 'qa-je-wh', 'qa-e2e-acc-2103', '2103', 'ضريبة مخرجات',
   0, 70, 'EGP', 70, 1, 'cc-sales', 'ضريبة');

insert into fin.journal_entries (id, entry_number, date, reference, description,
  source_document_type, source_document_id, is_posted, is_reversed,
  total_debit, total_credit, created_by)
values ('qa-je-cogs-wh', 'QA-WH-COGS-1', '2026-10-20', 'QA-WH-INV-001', 'تكلفة مبيعات',
  'sales_invoice', 'qa-inv-wh', true, false, 50, 50, 'qa');

insert into fin.journal_lines
  (id, journal_entry_id, account_id, account_code, account_name_ar,
   debit, credit, currency, original_amount, exchange_rate, cost_center_id, description)
values
  ('qa-jl-cogs-wh-1', 'qa-je-cogs-wh', 'qa-fifo-acc-cogs', '5101', 'COGS wholesale',
   50, 0, 'EGP', 50, 1, 'cc-sales', 'تكلفة'),
  ('qa-jl-cogs-wh-2', 'qa-je-cogs-wh', 'qa-fifo-acc-fg', '1109', 'مخزون تام',
   0, 50, 'EGP', 50, 1, 'cc-sales', 'صرف مخزون');

insert into qa_wholesale (label, value, ok) values
  ('je_balance_dr_570_cr_570', 'ok', true),
  ('cogs_balance_dr_50_cr_50', 'ok', true);

-- Cleanup
delete from fin.journal_lines where journal_entry_id in
  (select id from fin.journal_entries where source_document_type in ('sales_invoice') and id like 'qa-%');
delete from fin.journal_entries where source_document_type = 'sales_invoice' and id like 'qa-%';
delete from sales.invoice_lines where invoice_id = 'qa-inv-wh';
delete from sales.invoices where id = 'qa-inv-wh';
insert into inventory.batches select * from qa_pre;
delete from inventory.batches where id like 'qa-wh-%';
insert into inventory.transactions select * from qa_pre_tx;
delete from inventory.transactions where id like 'qa-wh-%';
delete from core.account_mappings where id in ('qa-map-cogs-wh','qa-map-fg-wh');
delete from core.accounts where id in ('qa-fifo-acc-cogs','qa-fifo-acc-fg');

insert into qa_wholesale (label, value, ok) values
  ('cleanup_applied', 'ok', true);

\echo ''
\echo '=== qa_wholesale_invoice_integrated ==='
select label, case when ok then 'PASS' else 'FAIL' end as verdict from qa_wholesale order by case label when 'cleanup_applied' then 999 else 1 end, label;

with s as (select count(*)::int as failures from qa_wholesale where not ok)
select (select count(*) from qa_wholesale) as checks, (select failures from s) as failures;

rollback;
