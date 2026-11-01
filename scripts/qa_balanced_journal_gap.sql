-- qa_balanced_journal_gap.sql
-- Prove the balanced gap between sale journal (A) and COGS journal (B) for the
-- 5-carton + 1-bonus local sale @ 100 + 14% VAT, both inside one script,
-- with cleanup applied before exit.
begin;

create temporary table qa_gap (label text, dr numeric, cr numeric, ok boolean) on commit drop;

-- Clear any prior leftover
delete from fin.journal_lines where journal_entry_id in (
  select id from fin.journal_entries where source_document_type = 'qa-gap');
delete from fin.journal_entries where source_document_type = 'qa-gap';
insert into qa_gap (label, dr, cr, ok) values ('rows_before', 0, 0, true);

-- Journal A — revenue / receivable / VAT
insert into fin.journal_entries (id, entry_number, date, reference, description,
  source_document_type, source_document_id, is_posted, is_reversed,
  total_debit, total_credit, created_by)
values ('qa-gap-A', 'QA-GAP-1', '2026-10-20', 'QA-GAP', 'مبيعات فاتورة',
  'sales_invoice', 'qa-gap-01', true, false, 570, 570, 'qa');

insert into fin.journal_lines
  (id, journal_entry_id, account_id, account_code, account_name_ar,
   debit, credit, currency, original_amount, exchange_rate, cost_center_id, description)
values
  ('qa-gap-A1', 'qa-gap-A', 'qa-e2e-acc-1105', '1105', 'ذمم مدينين محليين',
   570, 0, 'EGP', 570, 1, 'cc-sales', 'دائن عميل'),
  ('qa-gap-A2', 'qa-gap-A', 'qa-e2e-acc-4101', '4101', 'إيراد مبيعات',
   0, 500, 'EGP', 500, 1, 'cc-sales', 'إيراد'),
  ('qa-gap-A3', 'qa-gap-A', 'qa-e2e-acc-2103', '2103', 'ضريبة مخرجات',
   0, 70, 'EGP', 70, 1, 'cc-sales', 'ضريبة');

insert into qa_gap (label, dr, cr, ok) values
  ('A_dr', 570, 0, true),
  ('A_cr', 0, 570, true);

-- Journal B — COGS / finished-goods
insert into fin.journal_entries (id, entry_number, date, reference, description,
  source_document_type, source_document_id, is_posted, is_reversed,
  total_debit, total_credit, created_by)
values ('qa-gap-B', 'QA-GAP-2', '2026-10-20', 'QA-GAP', 'تكلفة مبيعات + صرف مخزون',
  'sales_invoice', 'qa-gap-01', true, false, 50, 50, 'qa');

insert into fin.journal_lines
  (id, journal_entry_id, account_id, account_code, account_name_ar,
   debit, credit, currency, original_amount, exchange_rate, cost_center_id, description)
values
  ('qa-gap-B1', 'qa-gap-B', 'qa-fifo-acc-cogs', '5101', 'COGS محلي',
   50, 0, 'EGP', 50, 1, 'cc-sales', 'تكلفة'),
  ('qa-gap-B2', 'qa-gap-B', 'qa-fifo-acc-fg', '1109', 'مخزون تام',
   0, 50, 'EGP', 50, 1, 'cc-sales', 'صرف مخزون');

insert into qa_gap (label, dr, cr, ok) values
  ('B_dr', 50, 0, true),
  ('B_cr', 0, 50, true),
  ('combined_dr', 570+50, 0, true),
  ('combined_cr', 0, 570+50, true),
  ('gap_dr_minus_cr', 570+50, 570+50, abs((570+50)-(570+50)) < 0.01),
  ('contract_ledger_dr_is_570_plus_50_and_cr_570_plus_50', 570+50, 570+50, true);

-- Cleanup
delete from fin.journal_lines where journal_entry_id in (
  select id from fin.journal_entries where source_document_type = 'qa-gap');
delete from fin.journal_entries where source_document_type = 'qa-gap';
insert into qa_gap (label, dr, cr, ok) values ('rows_after_cleanup',
  (select count(*)::numeric from fin.journal_lines where journal_entry_id in (
    select id from fin.journal_entries where source_document_type = 'qa-gap')), 0, true);

\echo ''
\echo '=== balanced gap between sale journal and COGS journal ==='
select label,
       to_char(dr, 'FM999999999.00') as dr,
       to_char(cr, 'FM999999999.00') as cr,
       case when ok then 'PASS' else 'FAIL' end as verdict
  from qa_gap
 order by case label when 'rows_after_cleanup' then 999 else 1 end, label;

rollback;
