-- =====================================================================
-- 160_drop_shadow_tables.sql — part 7: remove duplicate "shadow" tables
--
-- Why: migrations 110/120/122/130 re-declared entities that ALREADY exist in
-- TEST under their deployed names (the names the deployed RPCs actually use).
-- Because they used `create table if not exists`, the deployed tables were
-- left untouched and empty parallel copies appeared in a different schema:
--
--   audit.logs                        shadow of audit.app_audit_log
--   core.rep_custody                  shadow of core.representative_custodies
--   core.sales_reps                   shadow of core.sales_representatives
--   core.scrap_sale_documents         (deployed, kept)
--   sales.scrap_sales                 shadow of core.scrap_sale_documents
--   sales.withholding_adjustments     shadow of core.withholding_adjustments
--   production.boms                   shadow of core.boms
--   production.bom_lines              shadow of core.bom_lines
--   production.payroll_distributions  shadow of core.production_payroll_distributions
--   quality.inspections               shadow of production.quality_inspections
--   fin.export_shipments              shadow of sales.export_shipments
--   treasury.*                        shadows of fin.*  (7 tables)
--
-- Two tables for one entity is how reads and writes drift apart, so the
-- shadows go. The deployed names stay authoritative because every deployed
-- function references them (measured: shadows 0 references, canonicals >= 1).
--
-- Safety rules (this migration can never destroy data):
--   1. a shadow is dropped ONLY when its canonical table exists;
--   2. a shadow is dropped ONLY when it holds zero rows — otherwise it is
--      reported and left in place for a human decision;
--   3. re-running is a no-op.
-- =====================================================================

do $$
declare
  v_pairs constant text[][] := array[
    ['audit.logs',                        'audit.app_audit_log'],
    ['core.rep_custody',                  'core.representative_custodies'],
    ['core.sales_reps',                   'core.sales_representatives'],
    ['sales.scrap_sales',                 'core.scrap_sale_documents'],
    ['sales.withholding_adjustments',     'core.withholding_adjustments'],
    ['production.boms',                   'core.boms'],
    ['production.bom_lines',              'core.bom_lines'],
    ['production.payroll_distributions',  'core.production_payroll_distributions'],
    ['quality.inspections',               'production.quality_inspections'],
    ['fin.export_shipments',              'sales.export_shipments'],
    ['treasury.payments',                 'fin.payments'],
    ['treasury.payment_allocations',      'fin.payment_allocations'],
    ['treasury.cheques',                  'fin.cheques'],
    ['treasury.bank_accounts',            'core.bank_accounts'],
    ['treasury.bank_transactions',        'fin.bank_transactions'],
    ['treasury.transactions',             'fin.treasury_transactions'],
    ['treasury.expenses',                 'fin.expenses']
  ];
  v_i int;
  v_shadow text;
  v_canonical text;
  v_rows bigint;
  v_dropped int := 0;
  v_kept int := 0;
begin
  for v_i in 1 .. array_length(v_pairs, 1) loop
    v_shadow := v_pairs[v_i][1];
    v_canonical := v_pairs[v_i][2];

    if to_regclass(v_shadow) is null then
      continue;  -- already clean
    end if;

    if to_regclass(v_canonical) is null then
      raise notice 'SHADOW KEPT: % has no canonical % — left in place', v_shadow, v_canonical;
      v_kept := v_kept + 1;
      continue;
    end if;

    execute format('select count(*) from %s', v_shadow) into v_rows;
    if v_rows > 0 then
      raise notice 'SHADOW KEPT: % holds % row(s) — not dropped, needs a human decision', v_shadow, v_rows;
      v_kept := v_kept + 1;
      continue;
    end if;

    execute format('drop table %s cascade', v_shadow);
    raise notice 'SHADOW DROPPED: % (empty) — % stays authoritative', v_shadow, v_canonical;
    v_dropped := v_dropped + 1;
  end loop;

  raise notice 'shadow cleanup: % dropped, % kept', v_dropped, v_kept;
end $$;
