-- =====================================================================
-- 150_rls_and_grants.sql — part 6 of 6: RLS and privileges
--
-- Model:
--   * anon: nothing. No schema usage, no table privilege, no policy target.
--   * authenticated: SELECT only, and only on rows whose module the caller's
--     ERP role may `view` (core.user_can, which mirrors permissions.ts).
--     Every write goes through a SECURITY DEFINER RPC that re-checks the
--     caller's role, so a compromised browser session cannot INSERT/UPDATE.
--
-- Safety on an already-deployed database: a new permissive policy is only
-- added when the table has NO select-capable policy yet. If a table already
-- has its own policy (e.g. the erp_doc_test_writers gate), this file leaves
-- it alone and raises a notice instead of silently widening access.
-- =====================================================================

do $$
declare
  t record;
  v_policy text;
begin
  for t in
    select * from (values
      ('core','companies','settings'),
      ('core','warehouses','inventory'),
      ('core','units','items'),
      ('core','unit_conversions','items'),
      ('core','items','items'),
      ('core','customers','customers'),
      ('core','suppliers','suppliers'),
      ('core','sales_reps','representatives'),
      ('core','rep_custody','representatives'),
      ('core','custody_movements','representatives'),
      ('core','cost_centers','accounting'),
      ('core','accounts','accounting'),
      ('core','account_mappings','accounting'),
      ('core','accounting_periods','accounting'),
      ('core','standard_cost_rates','costing'),
      ('core','sales_forecasts','sales'),
      ('core','app_settings','settings'),
      ('core','app_profiles','users'),
      ('audit','app_audit_log','audit'),
      ('sales','invoices','sales'),
      ('sales','invoice_lines','sales'),
      ('sales','returns','sales'),
      ('sales','return_lines','sales'),
      -- deployed canonical names (see 160_drop_shadow_tables.sql)
      ('core','withholding_adjustments','sales'),
      ('core','scrap_sale_documents','sales'),
      ('purchasing','invoices','purchasing'),
      ('purchasing','invoice_lines','purchasing'),
      ('purchasing','returns','purchasing'),
      ('purchasing','return_lines','purchasing'),
      ('inventory','batches','inventory'),
      ('inventory','transactions','inventory'),
      ('inventory','counts','inventory'),
      ('inventory','count_lines','inventory'),
      ('core','boms','manufacturing'),
      ('core','bom_lines','manufacturing'),
      ('production','orders','manufacturing'),
      ('production','consumptions','manufacturing'),
      ('production','wastes','manufacturing'),
      ('core','production_payroll_distributions','costing'),
      ('production','quality_inspections','quality'),
      ('fin','payments','treasury'),
      ('fin','payment_allocations','treasury'),
      ('fin','cheques','cheques'),
      ('core','bank_accounts','banks'),
      ('fin','bank_transactions','banks'),
      ('fin','treasury_transactions','treasury'),
      ('fin','expenses','expenses'),
      ('fin','journal_entries','accounting'),
      ('fin','journal_lines','accounting'),
      ('sales','export_shipments','export')
    ) as v(sch, tbl, module)
  loop
    -- A table may legitimately be absent (a fresh database that has not had the
    -- deployed objects yet, or a shadow removed by 160). Never fail the whole
    -- migration for that: skip it and say so.
    if to_regclass(t.sch || '.' || t.tbl) is null then
      raise notice 'RLS: %.% does not exist — skipped', t.sch, t.tbl;
      continue;
    end if;

    -- RLS must be on before any policy can protect the table.
    execute format('alter table %I.%I enable row level security', t.sch, t.tbl);

    -- anon never touches ERP data
    execute format('revoke all on table %I.%I from anon', t.sch, t.tbl);

    -- writes are RPC-only (SECURITY DEFINER); the browser gets read access
    execute format('revoke insert, update, delete, truncate, references, trigger on table %I.%I from authenticated', t.sch, t.tbl);
    execute format('grant select on table %I.%I to authenticated', t.sch, t.tbl);

    v_policy := format('%s_%s_role_view', t.sch, t.tbl);

    if exists (
      select 1 from pg_policies p
       where p.schemaname = t.sch and p.tablename = t.tbl
         and p.cmd in ('SELECT','ALL')
    ) then
      raise notice 'RLS: %.% already has its own SELECT policy — left unchanged', t.sch, t.tbl;
    else
      execute format('drop policy if exists %I on %I.%I', v_policy, t.sch, t.tbl);
      execute format(
        'create policy %I on %I.%I for select to authenticated using (core.user_can(%L, %L))',
        v_policy, t.sch, t.tbl, t.module, 'view'
      );
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Profiles stay CLOSED to clients.
--
-- The UI never needs the table: the ERP role is read through
-- public.current_erp_role() and permissions through public.user_can(), both
-- SECURITY DEFINER. Granting SELECT here (even row-scoped to the caller) made
-- core.app_profiles readable over PostgREST, which the access probe treats as
-- a regression: a client could enumerate its own profile row, including the
-- permissions JSON, and any policy bug would widen that to other rows.
-- Keep the ACL closed; role resolution stays in the RPC.
-- ---------------------------------------------------------------------
drop policy if exists app_profiles_self_view on core.app_profiles;
revoke all on table core.app_profiles from anon, authenticated;

-- ---------------------------------------------------------------------
-- The idempotency ledger is server-internal: no client grant at all.
-- ---------------------------------------------------------------------
alter table fin.rpc_idempotency enable row level security;
revoke all on table fin.rpc_idempotency from anon, authenticated;

-- ---------------------------------------------------------------------
-- Settings and company records are singletons read by every signed-in user
-- (the invoice template, the company header and WH list are needed by any
-- screen that prints a document).
-- ---------------------------------------------------------------------
drop policy if exists app_settings_authenticated_view on core.app_settings;
create policy app_settings_authenticated_view on core.app_settings
  for select to authenticated
  using (core.current_role() is not null);

drop policy if exists companies_authenticated_view on core.companies;
create policy companies_authenticated_view on core.companies
  for select to authenticated
  using (core.current_role() is not null);

drop policy if exists warehouses_authenticated_view on core.warehouses;
create policy warehouses_authenticated_view on core.warehouses
  for select to authenticated
  using (core.current_role() is not null);
