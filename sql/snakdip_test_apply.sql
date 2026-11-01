-- =============================================================================
-- snakdip_test_apply.sql
-- Supabase TEST-only DDL/GRANT pack for the integrated sales-receipt path.
--
-- Scope:
--   - Applies ONLY the two server-side functions involved in the integrated
--     invoice + COGS posting path, using the authoritative repository files
--     verbatim (no copied/abbreviated bodies that can drift):
--       * supabase/114_sales_inventory_fifo_issue.sql
--           -> public.post_sales_inventory_issue(text, text, text)
--       * supabase/116_sales_invoice_integrated_POST.sql
--           -> public.post_sales_invoice_integrated(text, text, text, text,
--              text, numeric, date, jsonb, text, text)
--     Each source file also carries its own revoke/grant block, so applying this
--     pack applies the exact definitions AND the exact grants that were reviewed.
--   - Preflights every dependency it does NOT own (schemas, columns, and the
--     functions/tables defined outside this repository) and aborts before any
--     DDL if one is missing or shaped differently.
--
-- What is intentionally OUT of scope here:
--   - public.post_sales_invoice / fin.post_journal / fin.rpc_idempotency are NOT
--     defined in this repository. This pack does not invent them; it verifies
--     they exist with the expected shape and stops if they do not.
--   - Account/mapping/fixture inserts. No INSERT/UPDATE/DELETE of business data.
--   - Any master-data bootstrap, period creation, or localStorage change.
--   - Any production deploy or environment reconfiguration.
--
-- Apply order:
--   1) Apply this file (functions + grants) on TEST only.
--   2) Confirm one open accounting period, the cogs_* / inventory_finished_*
--      mappings, and the master fixtures (see scripts/qa_snakdip_invoice_receipt_harness.sql
--      preflight) OUTSIDE this file. This pack never creates them.
--   3) Run the isolated harness. It rolls back everything it creates.
--
-- Run (psql required: the \ir includes below are psql meta-commands, not SQL):
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f sql/snakdip_test_apply.sql
--
-- Guardian notes (third-party services, integrations, credentials):
--   - No email/SMS/payment/OCR/queue provider is involved. The only integration
--     boundary tested downstream is the Supabase RPC itself.
--   - No password, API key, or connection string is read, printed, or changed.
-- =============================================================================

\set ON_ERROR_STOP on
\encoding UTF8

begin;

-- ---------------------------------------------------------------------
-- 1) Dependency preflight (read-only; nothing is created before it passes).
--    Any missing/incompatible dependency aborts the transaction, so the pack
--    cannot half-apply functions whose dependencies are absent.
-- ---------------------------------------------------------------------
do $preflight$
declare
  v_missing text := '';
  v_n       int;
begin
  -- Tables owned outside this repository
  if to_regclass('sales.invoices') is null then
    v_missing := v_missing || 'table sales.invoices; ';
  end if;
  if to_regclass('sales.invoice_lines') is null then
    v_missing := v_missing || 'table sales.invoice_lines; ';
  end if;
  if to_regclass('inventory.batches') is null then
    v_missing := v_missing || 'table inventory.batches; ';
  end if;
  if to_regclass('inventory.transactions') is null then
    v_missing := v_missing || 'table inventory.transactions; ';
  end if;
  if to_regclass('core.items') is null then
    v_missing := v_missing || 'table core.items; ';
  end if;
  if to_regclass('core.accounts') is null then
    v_missing := v_missing || 'table core.accounts; ';
  end if;
  if to_regclass('core.account_mappings') is null then
    v_missing := v_missing || 'table core.account_mappings; ';
  end if;
  if to_regclass('core.accounting_periods') is null then
    v_missing := v_missing || 'table core.accounting_periods; ';
  end if;
  if to_regclass('core.app_profiles') is null then
    v_missing := v_missing || 'table core.app_profiles; ';
  end if;
  if to_regclass('fin.journal_entries') is null then
    v_missing := v_missing || 'table fin.journal_entries; ';
  end if;
  if to_regclass('fin.journal_lines') is null then
    v_missing := v_missing || 'table fin.journal_lines; ';
  end if;
  if to_regclass('fin.rpc_idempotency') is null then
    v_missing := v_missing || 'table fin.rpc_idempotency; ';
  end if;

  -- Functions owned outside this repository
  select count(*) into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'fin' and p.proname = 'post_journal';
  if v_n = 0 then
    v_missing := v_missing || 'function fin.post_journal; ';
  end if;

  select count(*) into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'post_sales_invoice'
     and pg_get_function_identity_arguments(p.oid) like '%p_is_test%'
     and pg_get_function_identity_arguments(p.oid) like '%p_idempotency_key%'
     and pg_get_function_result(p.oid) like '%invoice_id%'
     and pg_get_function_result(p.oid) like '%invoice_number%'
     and pg_get_function_result(p.oid) like '%success%'
     and pg_get_function_result(p.oid) like '%error%';
  if v_n = 0 then
    v_missing := v_missing || 'function public.post_sales_invoice with p_is_test / p_idempotency_key and (invoice_id, invoice_number, success, error); ';
  end if;

  if to_regprocedure('public.can_write_inventory()') is null then
    v_missing := v_missing || 'function public.can_write_inventory(); ';
  end if;
  if to_regprocedure('auth.uid()') is null then
    v_missing := v_missing || 'function auth.uid(); ';
  end if;

  -- Column-shape probes. Each one fails with undefined_column if the deployed
  -- TEST schema differs from what the repository functions actually use.
  begin
    perform 1
      from sales.invoices i
      join sales.invoice_lines l on l.invoice_id = i.id
     where i.journal_entry_id is not null
       and i.total_amount_egp is not null
       and i.cogs_total is not null
       and i.stock_source is not null
       and l.item_id is not null
       and l.free_quantity is not null
       and l.unit_cost is not null
     limit 0;
  exception when undefined_table or undefined_column then
    v_missing := v_missing || 'columns sales.invoices(journal_entry_id, total_amount_egp, cogs_total, stock_source) / sales.invoice_lines(item_id, free_quantity, unit_cost); ';
  end;

  begin
    perform 1
      from inventory.batches b
     where b.item_id is not null
       and b.warehouse_id is not null
       and b.batch_number is not null
       and b.production_date is not null
       and b.quantity is not null
       and b.unit_cost is not null
     limit 0;
  exception when undefined_table or undefined_column then
    v_missing := v_missing || 'columns inventory.batches(item_id, warehouse_id, batch_number, production_date, quantity, unit_cost); ';
  end;

  begin
    perform 1
      from inventory.transactions t
     where t.document_number is not null
       and t.movement_type is not null
       and t.warehouse_id is not null
       and t.quantity_out is not null
       and t.total_cost is not null
     limit 0;
  exception when undefined_table or undefined_column then
    v_missing := v_missing || 'columns inventory.transactions(document_number, movement_type, warehouse_id, quantity_out, total_cost); ';
  end;

  begin
    perform 1
      from fin.journal_entries e
      join fin.journal_lines l on l.journal_entry_id = e.id
     where e.entry_number is not null
       and e.reference is not null
       and e.source_document_type is not null
       and e.source_document_id is not null
       and e.is_posted is not null
       and l.debit is not null
       and l.credit is not null
     limit 0;
  exception when undefined_table or undefined_column then
    v_missing := v_missing || 'columns fin.journal_entries(entry_number, reference, source_document_type, source_document_id, is_posted) / fin.journal_lines(debit, credit); ';
  end;

  begin
    perform 1 from fin.rpc_idempotency r
     where r.key is not null and r.invoice_id is not null
     limit 0;
  exception when undefined_table or undefined_column then
    v_missing := v_missing || 'columns fin.rpc_idempotency(key, invoice_id); ';
  end;

  if v_missing <> '' then
    raise exception 'snakdip_test_apply preflight failed — nothing was applied. Missing or incompatible: %', v_missing;
  end if;
end
$preflight$;

-- ---------------------------------------------------------------------
-- 2) Apply the authoritative definitions VERBATIM.
--    \ir resolves relative to this script, so no body is copied here and the
--    applied function can never drift from the file that was reviewed.
--    Each source file contains its CREATE OR REPLACE + revoke/grant block.
-- ---------------------------------------------------------------------
\ir ../supabase/114_sales_inventory_fifo_issue.sql
\ir ../supabase/116_sales_invoice_integrated_POST.sql

-- ---------------------------------------------------------------------
-- 3) Post-apply verification (read-only). Signatures and grants must match
--    exactly; a non-empty failure column aborts the transaction below.
-- ---------------------------------------------------------------------
\echo ''
\echo '=== snakdip_test_apply: applied signatures / grants ==='
select n.nspname as schema_name,
       p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as arguments,
       pg_get_function_result(p.oid) as result,
       p.prosecdef as security_definer,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where (n.nspname = 'public' and p.proname in ('post_sales_invoice_integrated', 'post_sales_inventory_issue'))
 order by p.proname;

do $verify$
declare
  v_bad text := '';
  v_n   int;
begin
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'post_sales_invoice_integrated'
     and pg_get_function_identity_arguments(p.oid) =
         'p_customer_id text, p_channel text, p_warehouse_id text, p_payment_method text, p_currency text, p_exchange_rate numeric, p_date date, p_lines jsonb, p_created_by text, p_idempotency_key text'
     and p.prosecdef
     and has_function_privilege('authenticated', p.oid, 'execute')
     and not has_function_privilege('anon', p.oid, 'execute');
  if v_n <> 1 then
    v_bad := v_bad || 'post_sales_invoice_integrated signature/security/grant mismatch; ';
  end if;

  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'post_sales_inventory_issue'
     and pg_get_function_identity_arguments(p.oid) =
         'p_invoice_id text, p_created_by text, p_idempotency_key text'
     and p.prosecdef
     and has_function_privilege('authenticated', p.oid, 'execute')
     and not has_function_privilege('anon', p.oid, 'execute');
  if v_n <> 1 then
    v_bad := v_bad || 'post_sales_inventory_issue signature/security/grant mismatch; ';
  end if;

  if v_bad <> '' then
    raise exception 'snakdip_test_apply verification failed — rolling back: %', v_bad;
  end if;
end
$verify$;

commit;

\echo ''
\echo '=== snakdip_test_apply: committed. No business data, mapping, account, period or fixture was written by this file. ==='
