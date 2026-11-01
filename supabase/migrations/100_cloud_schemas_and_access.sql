-- =====================================================================
-- 100_cloud_schemas_and_access.sql
--
-- The complete SnakDip ERP cloud schema — part 1 of 6: schemas, the shared
-- permission resolver and the role matrix.
--
-- Target: Supabase TEST (snakdip-shared-test, ref xrqksgjtqzddzqcwfnaj).
-- Idempotent: safe to re-run; no data is modified by this file.
--
-- Naming contract with the RPCs that already run in TEST
-- (public.post_sales_invoice, public.post_sales_inventory_issue,
--  fin.post_journal, public.erp_*_cas):
--   core.<master>, sales.<documents>, inventory.<stock>, fin.<ledger>
-- Keep these names: the deployed functions reference them by name.
--
-- Write model (deliberate, inherited from the existing cloud slices):
--   * clients never INSERT/UPDATE/DELETE these tables directly;
--   * every write goes through a SECURITY DEFINER RPC that re-checks the
--     caller's role, the accounting period and the ledger balance;
--   * RLS here governs SELECT for the browser, so a leaked anon key can only
--     read what the signed-in ERP role may view.
-- =====================================================================

create schema if not exists core;
create schema if not exists sales;
create schema if not exists purchasing;
create schema if not exists inventory;
create schema if not exists production;
create schema if not exists quality;
create schema if not exists treasury;
create schema if not exists fin;
create schema if not exists audit;

comment on schema core is 'Master data + security: company, warehouses, items, units, parties, accounts, mappings, periods, profiles.';
comment on schema sales is 'Sales documents: invoices, lines, returns, withholding adjustments, scrap sales.';
comment on schema purchasing is 'Purchasing documents: purchase invoices, lines, returns, return lines.';
comment on schema inventory is 'Perpetual stock: batches (FIFO layers), movements, physical counts.';
comment on schema production is 'BOM, production orders, material consumption, waste, payroll cost distribution.';
comment on schema quality is 'Quality inspections of receipts, production output and sales returns.';
comment on schema treasury is 'Cash boxes, payments, cheques, bank accounts and bank movements.';
comment on schema fin is 'General ledger, idempotency ledger and export shipments.';
comment on schema audit is 'Append-only audit trail.';

grant usage on schema core, sales, purchasing, inventory, production, quality, treasury, fin, audit
  to authenticated;
-- anon gets no schema usage at all: the cloud UI must sign in first.

-- ---------------------------------------------------------------------
-- updated_at maintenance (one trigger function, used by every table)
-- ---------------------------------------------------------------------
create or replace function core.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Role matrix — the SQL mirror of src/services/permissions.ts (MATRIX).
--
-- It lives in one place so the TypeScript UI and the database can never drift:
-- if the matrix changes in code, this literal and 150_rls_and_grants.sql's
-- behaviour change together. Keys are ModuleKey values, values are the
-- PermissionAction arrays exactly as the TS file declares them.
-- ---------------------------------------------------------------------
create or replace function core.role_matrix()
returns jsonb
language sql
immutable
as $fn$
  select '{
    "Super Admin": {"dashboard":["view","create","edit","delete","approve","post","cancel","export"],"items":["view","create","edit","delete","approve","post","cancel","export"],"inventory":["view","create","edit","delete","approve","post","cancel","export"],"manufacturing":["view","create","edit","delete","approve","post","cancel","export"],"quality":["view","create","edit","delete","approve","post","cancel","export"],"costing":["view","create","edit","delete","approve","post","cancel","export"],"sales":["view","create","edit","delete","approve","post","cancel","export"],"purchasing":["view","create","edit","delete","approve","post","cancel","export"],"customers":["view","create","edit","delete","approve","post","cancel","export"],"suppliers":["view","create","edit","delete","approve","post","cancel","export"],"representatives":["view","create","edit","delete","approve","post","cancel","export"],"export":["view","create","edit","delete","approve","post","cancel","export"],"treasury":["view","create","edit","delete","approve","post","cancel","export"],"banks":["view","create","edit","delete","approve","post","cancel","export"],"cheques":["view","create","edit","delete","approve","post","cancel","export"],"expenses":["view","create","edit","delete","approve","post","cancel","export"],"accounting":["view","create","edit","delete","approve","post","cancel","export"],"reports":["view","create","edit","delete","approve","post","cancel","export"],"users":["view","create","edit","delete","approve","post","cancel","export"],"settings":["view","create","edit","delete","approve","post","cancel","export"],"audit":["view","create","edit","delete","approve","post","cancel","export"]},
    "General Manager": {"dashboard":["view","create","edit","delete","approve","post","cancel","export"],"items":["view","export"],"inventory":["view","export"],"manufacturing":["view","export"],"quality":["view","export"],"costing":["view","export"],"sales":["view","export"],"purchasing":["view","export"],"customers":["view","export"],"suppliers":["view","export"],"representatives":["view","export"],"export":["view","export"],"treasury":["view","export"],"banks":["view","export"],"cheques":["view","export"],"expenses":["view","export"],"accounting":["view","export"],"reports":["view","create","edit","delete","approve","post","cancel","export"],"audit":["view","export"]},
    "Chief Accountant": {"dashboard":["view","export"],"items":["view"],"inventory":["view","export"],"manufacturing":["view"],"quality":["view"],"costing":["view","create","edit","delete","approve","post","cancel","export"],"sales":["view","create","edit","export","approve"],"purchasing":["view","create","edit","export","approve"],"customers":["view","create","edit","export","approve"],"suppliers":["view","create","edit","export","approve"],"representatives":["view","export"],"export":["view","export"],"treasury":["view","create","edit","delete","approve","post","cancel","export"],"banks":["view","create","edit","delete","approve","post","cancel","export"],"cheques":["view","create","edit","delete","approve","post","cancel","export"],"expenses":["view","create","edit","delete","approve","post","cancel","export"],"accounting":["view","create","edit","delete","approve","post","cancel","export"],"reports":["view","create","edit","delete","approve","post","cancel","export"],"audit":["view","export"]},
    "Accountant": {"dashboard":["view"],"items":["view"],"inventory":["view","export"],"sales":["view","create","edit","export"],"purchasing":["view","create","edit","export"],"customers":["view","create","edit","export"],"suppliers":["view","create","edit","export"],"treasury":["view","create","edit","export"],"banks":["view","create","edit","export"],"cheques":["view","create","edit","export"],"expenses":["view","create","edit","export"],"accounting":["view","create","edit","export"],"reports":["view","export"]},
    "Cost Accountant": {"dashboard":["view"],"items":["view","export"],"inventory":["view","export"],"manufacturing":["view","export"],"costing":["view","create","edit","delete","approve","post","cancel","export"],"quality":["view"],"sales":["view"],"purchasing":["view"],"reports":["view","export"],"accounting":["view"]},
    "Warehouse Manager": {"dashboard":["view"],"items":["view","create","edit","export","approve"],"inventory":["view","create","edit","delete","approve","post","cancel","export"],"manufacturing":["view","create","edit","export"],"quality":["view","create","edit","export"],"reports":["view","export"]},
    "Warehouse Employee": {"dashboard":["view"],"items":["view"],"inventory":["view","create","edit","export"],"quality":["view"]},
    "Sales Manager": {"dashboard":["view"],"items":["view","export"],"inventory":["view","export"],"sales":["view","create","edit","delete","approve","post","cancel","export"],"customers":["view","create","edit","export","approve"],"representatives":["view","create","edit","export","approve"],"export":["view","create","edit","export"],"reports":["view","export"]},
    "Sales Representative": {"dashboard":["view"],"items":["view"],"customers":["view","create"],"representatives":["view","create","edit"],"sales":["view","create"]},
    "Purchasing Manager": {"dashboard":["view"],"items":["view","create","edit","export","approve"],"purchasing":["view","create","edit","delete","approve","post","cancel","export"],"suppliers":["view","create","edit","export","approve"],"inventory":["view","export"],"reports":["view","export"]},
    "Production Manager": {"dashboard":["view"],"items":["view","export"],"inventory":["view","create","edit","export"],"manufacturing":["view","create","edit","delete","approve","post","cancel","export"],"quality":["view","create","edit","export"],"costing":["view","export"],"reports":["view","export"]},
    "Treasury Accountant": {"dashboard":["view"],"treasury":["view","create","edit","delete","approve","post","cancel","export"],"banks":["view","create","edit","delete","approve","post","cancel","export"],"cheques":["view","create","edit","delete","approve","post","cancel","export"],"expenses":["view","create","edit","export"],"accounting":["view"],"reports":["view","export"]},
    "Viewer": {"dashboard":["view"],"items":["view"],"inventory":["view"],"sales":["view"],"purchasing":["view"],"customers":["view"],"suppliers":["view"],"manufacturing":["view"],"quality":["view"],"costing":["view"],"export":["view"],"treasury":["view"],"banks":["view"],"cheques":["view"],"expenses":["view"],"accounting":["view"],"reports":["view"],"audit":["view"]}
  }'::jsonb;
$fn$;

-- core.current_profile() / core.user_can(module, action) live in
-- 115_access_functions.sql: they read core.app_profiles, which 110 creates.
