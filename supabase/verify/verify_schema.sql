-- =====================================================================
-- supabase/verify/verify_schema.sql
--
-- READ-ONLY. Every statement here is a SELECT on the system catalogs or a
-- count; nothing is inserted, updated, deleted, created or dropped.
-- Safe to paste into the Supabase SQL Editor for snakdip-shared-test
-- (ref xrqksgjtqzddzqcwfnaj), and safe to run when migrations are pending.
--
-- It answers one question per section:
--   1. am I even on the TEST project, and as whom?
--   2. which schemas and tables exist, and is RLS on?
--   3. does the deployed shape of the RPC-critical tables match the repo?
--   4. do the functions exist with the expected signatures/security?
--   5. are the four COGS/inventory account mappings present?
--   6. is there an OPEN period for the test date?
--   7. are the isolation fixtures present?
-- =====================================================================

-- 1) identity ------------------------------------------------------------
select current_database()                as database,
       current_user                      as role,
       (select count(*) from auth.users) as auth_users,
       now()                             as checked_at;

-- 2) schemas / tables / RLS ---------------------------------------------
select n.nspname                                     as schema,
       count(*)                                      as tables,
       count(*) filter (where c.relrowsecurity)      as rls_on,
       count(*) filter (where not c.relrowsecurity)  as rls_off
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where c.relkind = 'r'
   and n.nspname in ('core','sales','purchasing','inventory','production','quality','treasury','fin','audit','public')
 group by n.nspname
 order by n.nspname;

-- 3) drift check on the tables the deployed RPCs depend on --------------
--    (columns actually referenced by the SQL in supabase/, nothing else)
with expected(sch, tbl, col) as (
  values
    ('sales','invoices','id'), ('sales','invoices','invoice_number'),
    ('sales','invoices','customer_id'), ('sales','invoices','channel'),
    ('sales','invoices','warehouse_id'), ('sales','invoices','payment_method'),
    ('sales','invoices','currency'), ('sales','invoices','exchange_rate'),
    ('sales','invoices','date'), ('sales','invoices','total_amount'),
    ('sales','invoices','total_amount_egp'), ('sales','invoices','cogs_total'),
    ('sales','invoices','status'), ('sales','invoices','journal_entry_id'),
    ('sales','invoices','stock_source'), ('sales','invoices','is_test'),
    ('sales','invoice_lines','invoice_id'), ('sales','invoice_lines','item_id'),
    ('sales','invoice_lines','quantity'), ('sales','invoice_lines','free_quantity'),
    ('sales','invoice_lines','unit_cost'),
    ('inventory','batches','item_id'), ('inventory','batches','warehouse_id'),
    ('inventory','batches','batch_number'), ('inventory','batches','production_date'),
    ('inventory','batches','expiry_date'), ('inventory','batches','quantity'),
    ('inventory','batches','unit_cost'),
    ('inventory','transactions','document_number'), ('inventory','transactions','movement_type'),
    ('inventory','transactions','quantity_in'), ('inventory','transactions','quantity_out'),
    ('inventory','transactions','unit_cost'), ('inventory','transactions','total_cost'),
    ('fin','journal_entries','entry_number'), ('fin','journal_entries','reference'),
    ('fin','journal_entries','source_document_type'), ('fin','journal_entries','source_document_id'),
    ('fin','journal_entries','is_posted'),
    ('fin','journal_lines','journal_entry_id'), ('fin','journal_lines','account_id'),
    ('fin','journal_lines','debit'), ('fin','journal_lines','credit'),
    ('fin','rpc_idempotency','key'), ('fin','rpc_idempotency','invoice_id'),
    ('core','account_mappings','key'), ('core','account_mappings','account_id'),
    ('core','accounts','is_header'), ('core','accounts','code'),
    ('core','accounting_periods','start_date'), ('core','accounting_periods','end_date'),
    ('core','accounting_periods','is_closed'),
    ('core','app_profiles','supabase_auth_id'), ('core','app_profiles','role'),
    ('core','app_profiles','active')
)
select e.sch || '.' || e.tbl as table_name,
       count(*)                                                              as columns_checked,
       count(col.column_name)                                                as columns_present,
       string_agg(e.col, ', ' order by e.col) filter (where col.column_name is null) as missing_columns,
       case when exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                          where n.nspname=e.sch and c.relname=e.tbl and c.relkind='r')
            then 'table exists' else 'TABLE MISSING' end                     as table_state
  from expected e
  left join information_schema.columns col
         on col.table_schema = e.sch and col.table_name = e.tbl and col.column_name = e.col
 group by e.sch, e.tbl
 order by e.sch, e.tbl;

-- 4) functions: signatures, security, volatility ------------------------
select n.nspname                       as schema,
       p.proname                       as function,
       pg_get_function_identity_arguments(p.oid) as args,
       case when p.prosecdef then 'SECURITY DEFINER' else 'security invoker' end as security,
       p.provolatile                   as volatility,
       pg_get_userbyid(p.proowner)     as owner
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where (n.nspname, p.proname) in (
        ('public','post_sales_invoice'),
        ('public','post_sales_invoice_integrated'),
        ('public','post_sales_inventory_issue'),
        ('public','post_inventory_transfer'),
        ('public','can_write_inventory'),
        ('public','current_erp_role'),
        ('public','erp_core_master_read'),
        ('public','erp_master_cas'),
        ('public','erp_warehouse_cas'),
        ('public','erp_doc_cas'),
        ('fin','post_journal'),
        ('fin','post_sales_invoice'),
        ('fin','journal_entries_for_invoice'))
 order by n.nspname, p.proname;

-- 4b) EXECUTE grants for anon / authenticated ---------------------------
--     has_function_privilege() also reports privileges inherited from PUBLIC.
select n.nspname || '.' || p.proname as function,
       pg_get_function_identity_arguments(p.oid) as args,
       r.rolname as grantee,
       case when has_function_privilege(r.oid, p.oid, 'EXECUTE')
            then 'EXECUTE' else '-' end as privilege
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 cross join (values ('anon'), ('authenticated')) as g(rolname)
  join pg_roles r on r.rolname = g.rolname
 where n.nspname in ('public','fin')
   and p.proname in ('post_sales_invoice','post_sales_invoice_integrated',
                     'post_sales_inventory_issue','post_journal','post_inventory_transfer')
 order by 1, 3;

-- 5) the four account mappings the COGS/inventory path requires ---------
select k.key,
       case when m.key is null then 'MISSING' else 'ok' end as mapping_state,
       m.account_id,
       a.code  as account_code,
       a.name_ar as account_name_ar,
       a.is_header,
       case when m.account_id is not null and a.id is null then 'account row missing'
            when coalesce(a.is_header, false) then 'points at HEADER (posting will be refused)'
            when m.key is null then 'add this mapping before posting COGS'
            else 'usable' end as verdict
  from (values ('cogs_local'), ('inventory_finished_local'),
               ('cogs_export'), ('inventory_finished_export')) as k(key)
  left join core.account_mappings m on m.key = k.key
  left join core.accounts a on a.id = m.account_id;

-- 6) open accounting period covering today ------------------------------
select p.name_ar, p.start_date, p.end_date, p.is_closed
  from core.accounting_periods p
 where current_date between p.start_date and p.end_date
 order by p.start_date;

select count(*) filter (where not p.is_closed) as open_periods,
       count(*) filter (where p.is_closed)     as closed_periods,
       min(p.start_date)                       as earliest,
       max(p.end_date)                         as latest
  from core.accounting_periods p;

-- 7) isolation fixtures (test-scoped rows only) -------------------------
select 'customers'  as entity, count(*) filter (where is_test) as test_rows, count(*) as all_rows from core.customers
union all
select 'items',      count(*) filter (where is_test), count(*) from core.items
union all
select 'warehouses', count(*) filter (where is_test), count(*) from core.warehouses
union all
select 'batches',    count(*) filter (where is_test), count(*) from inventory.batches
union all
select 'units',      0, count(*) from core.units;

-- 7b) documents already in the database (counts only, no invoice data) --
select 'sales.invoices'            as object, count(*) as rows,
       count(*) filter (where journal_entry_id is null) as without_journal
  from sales.invoices
union all
select 'fin.journal_entries', count(*), count(*) filter (where not is_posted) from fin.journal_entries
union all
select 'inventory.transactions', count(*), 0 from inventory.transactions;
