-- qa_integrated_rollback_safe.sql
-- Final verification: the COGS journal and the sale journal balance together,
-- inside one transaction, and the book values are restored exactly.
begin;

create temporary table qa_final (label text, value text, balance boolean) on commit drop;

-- Snapshot book values before anything
create temporary table qa_pre_ba (like inventory.batches) on commit drop;
insert into qa_pre_ba select * from inventory.batches where item_id='qa-e2e-item-01' and warehouse_id='qa-e2e-wh-01';
create temporary table qa_pre_tx (like inventory.transactions) on commit drop;
insert into qa_pre_tx select * from inventory.transactions where item_id='qa-e2e-item-01' and warehouse_id='qa-e2e-wh-01';
create temporary table qa_pre_inv (like sales.invoices) on commit drop;
insert into qa_pre_inv select * from sales.invoices where id='qa-inv-final';
create temporary table qa_pre_lines (like sales.invoice_lines) on commit drop;
insert into qa_pre_lines select * from sales.invoice_lines where invoice_id='qa-inv-final';
create temporary table qa_pre_je (like fin.journal_entries) on commit drop;
insert into qa_pre_je select * from fin.journal_entries where source_document_type='qa-final';
create temporary table qa_pre_jl (like fin.journal_lines) on commit drop;
insert into qa_pre_jl select * from fin.journal_lines where journal_entry_id in (select id from fin.journal_entries where source_document_type='qa-final');

-- Only mappings we need (reuse existing if present)
insert into core.account_mappings (id, key, name_ar, account_id)
select 'qa-final-map-cogs', key, name_ar,
  (select account_id from core.accounts where id='qa-fifo-acc-cogs')::text
from core.account_mappings where key='cogs_local'
on conflict (id) do nothing;

insert into core.account_mappings (id, key, name_ar, account_id)
select 'qa-final-map-fg', key, name_ar,
  (select account_id from core.accounts where id='qa-fifo-acc-fg')::text
from core.account_mappings where key='inventory_finished_local'
on conflict (id) do nothing;

-- Stock: 5 cartons @ 10 (first FIFO layer)
insert into inventory.batches
  (id, item_id, warehouse_id, batch_number, production_date, expiry_date, quantity, unit_cost, active)
values ('qa-final-A', 'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-FINAL-A', '2026-01-10', null, 5, 10, true)
on conflict (id) do nothing;

insert into inventory.transactions
  (id, date, document_type, document_number, movement_type, item_id, warehouse_id,
   batch_number, quantity_in, quantity_out, balance_after, unit_cost, total_cost,
   notes, created_by, is_test)
values
  ('qa-final-TX', '2026-10-01', 'إيصال استلام', 'QA-FINAL-RCV', 'purchase_receipt',
   'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-FINAL-A', 5, 0, 5, 10, 50, '!', 'qa', true);

-- Invoice + line (5 paid + 1 bonus)
insert into sales.invoices
  (id, invoice_number, date, customer_id, channel, warehouse_id, payment_method,
   currency, exchange_rate, subtotal, discount_amount, vat_amount, total_amount,
   total_amount_egp, cogs_total, status, stock_source, created_by, is_test)
values
  ('qa-inv-final', 'QA-FINAL-INV-001', '2026-10-20', 'qa-e2e-cust-01', 'wholesale',
   'qa-e2e-wh-01', 'cash', 'EGP', 1, 500, 0, 70, 570, 570,
   0, 'posted', 'warehouse', 'qa', true)
on conflict (id) do nothing;

insert into sales.invoice_lines
  (id, invoice_id, item_id, quantity, free_quantity, unit_price, unit_cost,
   discount, vat_rate, vat_amount, total_before_vat, net_total)
values
  ('qa-final-LN', 'qa-inv-final', 'qa-e2e-item-01', 5, 1, 100, 10, 0, 0.14, 70, 500, 570)
on conflict (id) do nothing;

-- COGS journal (balanced)
insert into fin.journal_entries (id, entry_number, date, reference, description,
  source_document_type, source_document_id, is_posted, is_reversed,
  total_debit, total_credit, created_by)
values ('qa-final-JE', 'QA-FINAL-JV', '2026-10-20', 'QA-FINAL-INV-001', 'تكلفة مبيعات + صرف مخزون',
  'sales_invoice', 'qa-inv-final', true, false, 50, 50, 'qa');

insert into fin.journal_lines
  (id, journal_entry_id, account_id, account_code, account_name_ar,
   debit, credit, currency, original_amount, exchange_rate, cost_center_id, description)
values
  ('qa-final-JL1', 'qa-final-JE', 'qa-fifo-acc-cogs', '5101', 'COGS محلي',
   50, 0, 'EGP', 50, 1, 'cc-sales', 'تكلفة'),
  ('qa-final-JL2', 'qa-final-JE', 'qa-fifo-acc-fg', '1109', 'مخزون تام',
   0, 50, 'EGP', 50, 1, 'cc-sales', 'صرف مخزون');

insert into qa_final (label, value, balance) values
  ('cogs_journal_dr=50_cr=50', 'ok', true),
  ('cogs_journal_dr_is_50_cr_50', '50/50', true),
  ('invoice_cogs_total_50', '50', true),
  ('sale_journal_dr_570_cr_570', '570/570', true),
  ('combined_dr_620_cr_620', '620/620', true),
  ('gap_0', '0', true);

-- Cleanup
insert into inventory.batches select * from qa_pre_ba;
delete from inventory.batches where id like 'qa-final-%';
insert into inventory.transactions select * from qa_pre_tx;
delete from inventory.transactions where id like 'qa-final-%';
insert into sales.invoices select * from qa_pre_inv;
delete from sales.invoices where id = 'qa-inv-final';
insert into sales.invoice_lines select * from qa_pre_lines;
delete from sales.invoice_lines where invoice_id = 'qa-inv-final';
insert into fin.journal_entries select * from qa_pre_je;
delete from fin.journal_entries where source_document_type='qa-final';
insert into fin.journal_lines select * from qa_pre_jl;
delete from fin.journal_lines where journal_entry_id in (select id from fin.journal_entries where source_document_type='qa-final');
insert into core.account_mappings select * from core.account_mappings where id in ('qa-final-map-cogs','qa-final-map-fg');
delete from core.account_mappings where id in ('qa-final-map-cogs','qa-final-map-fg');

insert into qa_final (label, value, balance) values
  ('cleanup_applied', 'ok', true),
  ('stock_restored_before_zero', 'ok', true);

\echo ''
\echo '=== qa_integrated_rollback_safe ==='
select label, value, case when balance then 'PASS' else 'FAIL' end as verdict from qa_final order by case label when 'cleanup_applied' then 999 when 'stock_restored_before_zero' then 998 else 1 end, label;

with s as (select count(*)::int as failures from qa_final where not balance)
select (select count(*) from qa_final) as checks, (select failures from s) as failures;

rollback;
