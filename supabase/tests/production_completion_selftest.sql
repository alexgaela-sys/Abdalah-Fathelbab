-- =====================================================================
-- supabase/tests/production_completion_selftest.sql
--
-- LOCAL VALIDATION ONLY — runs on the scratch database created by
-- scripts/verify_migrations_local.sh after 173_cloud_production_completion_safe.sql
-- and supabase/tests/shim_deployed_rpcs.sql.
--
-- It EXECUTES the real server-side cycle (not a description of it):
--   1. BOM requirements for an in-progress order,
--   2. refusal when stock cannot cover the request — nothing partial,
--   3. FIFO issue across two cost layers (10 @ 5 + 2 @ 7 = 64),
--   4. idempotent re-issue returns the first result and moves no stock,
--   5. finished-goods receipt into its own batch,
--   6. atomic close: actual material cost capitalised, one balanced journal,
--   7. repeat close by key and after completion posts no second journal.
--
-- Everything happens inside ONE transaction that ends with ROLLBACK, so the
-- scratch database is left exactly as the migrations built it.
-- =====================================================================

begin;

\set ON_ERROR_STOP on

create temporary table _qa_res (name text primary key, status text, detail text) on commit drop;

-- ---------------------------------------------------------------------
-- Fixtures (all is_test)
-- ---------------------------------------------------------------------
insert into core.units (id, code, name_ar, is_base, is_test)
values ('qa-u-piece', 'PCS', 'قطعة', true, true)
on conflict (id) do nothing;

insert into core.warehouses (id, code, name_ar, type, location, active, is_test)
values
  ('qa-wh-raw', 'QA-RAW', 'مستودع خامات QA', 'raw_materials', 'QA', true, true),
  ('qa-wh-fg',  'QA-FG',  'مستودع تام QA',    'local_finished', 'QA', true, true)
on conflict (id) do nothing;

insert into core.items (id, code, name_ar, name_en, item_type, base_unit_id, track_batch, active, is_test)
values
  ('qa-item-fg',  'QA-FG-1',  'منتج تام QA', 'QA finished',  'finished_product', 'qa-u-piece', false, true, true),
  ('qa-item-mat', 'QA-MAT-1', 'مادة خام QA', 'QA material',  'raw_material',     'qa-u-piece', true,  true, true)
on conflict (id) do nothing;

insert into inventory.batches (id, item_id, warehouse_id, batch_number, production_date, quantity, unit_cost, is_test)
values
  ('qa-bat-a', 'qa-item-mat', 'qa-wh-raw', 'QA-LOT-A', current_date - 10, 10, 5, true),
  ('qa-bat-b', 'qa-item-mat', 'qa-wh-raw', 'QA-LOT-B', current_date - 5,  10, 7, true)
on conflict (id) do nothing;

insert into production.boms (id, bom_number, finished_item_id, code, name_ar, version, base_quantity, unit_id, active, effective_date, is_test)
values ('qa-bom-1', 'QA-BOM-1', 'qa-item-fg', 'QA-BOM-1', 'قائمة مواد QA', 1, 1, 'qa-u-piece', true, current_date - 30, true)
on conflict (id) do nothing;

insert into production.bom_lines (id, bom_id, material_item_id, quantity_required, unit_id, waste_percentage)
values ('qa-bom-line-1', 'qa-bom-1', 'qa-item-mat', 12, 'qa-u-piece', 0)
on conflict (id) do nothing;

insert into production.orders (
  id, order_number, product_id, item_id, bom_id, planned_quantity, produced_quantity,
  start_date, status, destination_warehouse_id, warehouse_id, target_market, created_user_id, is_test
) values (
  'qa-ord-1', 'QA-PO-1', 'qa-item-fg', 'qa-item-fg', 'qa-bom-1', 12, 0,
  current_date, 'in_progress', 'qa-wh-fg', 'qa-wh-raw', 'local', 'qa-selftest', true
) on conflict (id) do nothing;

-- A Super Admin profile so core.user_can('manufacturing','post') is true.
insert into core.app_profiles (id, supabase_auth_id, username, name, role, active, is_test)
values ('qa-profile-1', '00000000-0000-4000-8000-000000000001', 'qa-selftest', 'QA Selftest', 'Super Admin', true, true)
on conflict (id) do nothing;

-- One open accounting period covering today (a closed one would refuse the close).
insert into core.accounting_periods (id, code, name_ar, start_date, end_date, is_closed, is_test)
values ('qa-period-1', 'QA-2026', 'فترة QA', current_date - 30, current_date + 30, false, true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Assertion helper
-- ---------------------------------------------------------------------
create or replace function pg_temp._qa(p_name text, p_ok boolean, p_detail text)
returns void language plpgsql as $$
begin
  insert into _qa_res (name, status, detail)
  values (p_name, case when p_ok then 'PASS' else 'FAIL' end, p_detail)
  on conflict (name) do update set status = excluded.status, detail = excluded.detail;
end;
$$;

-- ---------------------------------------------------------------------
-- The cycle
-- ---------------------------------------------------------------------
do $$
declare
  v_uid text := '00000000-0000-4000-8000-000000000001';
  v_bom record;
  v_bom_count int := 0;
  v_issue record;
  v_out record;
  v_close record;
  v_retry record;
  v_again record;
  v_stock numeric;
  v_fg_qty numeric;
  v_cost numeric;
  v_layer_a numeric;
  v_layer_b numeric;
  v_consumptions int;
  v_journals int;
  v_debit numeric;
  v_credit numeric;
  v_status text;
  v_actual numeric;
  v_journal_id text;
  v_journal_after text;
begin
  perform set_config('request.jwt.claim.sub', v_uid, true);

  -- 1) BOM requirements
  for v_bom in select * from public.list_production_bom('qa-ord-1') loop
    v_bom_count := v_bom_count + 1;
    perform pg_temp._qa(
      '01 BOM requirements are returned for the order',
      v_bom.material_item_id = 'qa-item-mat' and v_bom.quantity_required = 12,
      format('lines=%s material=%s qty=%s', v_bom_count, v_bom.material_item_id, v_bom.quantity_required)
    );
  end loop;
  if v_bom_count = 0 then
    perform pg_temp._qa('01 BOM requirements are returned for the order', false, 'no BOM line returned');
  end if;

  -- 2) Insufficient material: refused, nothing moved
  select * into v_issue from public.create_production_consumption(
    'qa-ord-1',
    jsonb_build_array(jsonb_build_object('materialItemId', 'qa-item-mat', 'quantity', 25, 'warehouseId', 'qa-wh-raw')),
    'qa-selftest',
    'qa-key-insufficient'
  );
  select coalesce(sum(quantity), 0) into v_stock from inventory.batches where item_id = 'qa-item-mat';
  select count(*) into v_consumptions from production.cloud_consumptions where production_order_id = 'qa-ord-1';
  perform pg_temp._qa(
    '02 insufficient stock refused, stock untouched',
    v_issue.out_status = 'insufficient_material' and v_stock = 20 and v_consumptions = 0,
    format('status=%s stock=%s consumptions=%s', v_issue.out_status, v_stock, v_consumptions)
  );

  -- 3) FIFO issue of 12 units (2 layers)
  select * into v_issue from public.create_production_consumption(
    'qa-ord-1',
    jsonb_build_array(jsonb_build_object('materialItemId', 'qa-item-mat', 'quantity', 12, 'warehouseId', 'qa-wh-raw')),
    'qa-selftest',
    'qa-key-consume-1'
  );
  select quantity into v_layer_a from inventory.batches where id = 'qa-bat-a';
  select quantity into v_layer_b from inventory.batches where id = 'qa-bat-b';
  select coalesce(sum(total_cost), 0) into v_cost from production.cloud_consumptions where production_order_id = 'qa-ord-1';
  select count(*) into v_consumptions from production.cloud_consumptions where production_order_id = 'qa-ord-1';
  perform pg_temp._qa(
    '03 FIFO issue consumes the oldest layer first at actual cost',
    v_issue.out_status = 'ok' and v_layer_a = 0 and v_layer_b = 8 and v_cost = 64 and v_consumptions = 2,
    format('status=%s layerA=%s layerB=%s cost=%s rows=%s',
           v_issue.out_status, v_layer_a, v_layer_b, v_cost, v_consumptions)
  );

  -- 4) Idempotent re-issue: same key, no second movement
  select * into v_retry from public.create_production_consumption(
    'qa-ord-1',
    jsonb_build_array(jsonb_build_object('materialItemId', 'qa-item-mat', 'quantity', 12, 'warehouseId', 'qa-wh-raw')),
    'qa-selftest',
    'qa-key-consume-1'
  );
  select quantity into v_layer_b from inventory.batches where id = 'qa-bat-b';
  select count(*) into v_consumptions from production.cloud_consumptions where production_order_id = 'qa-ord-1';
  perform pg_temp._qa(
    '04 re-issue with the same key returns the first result',
    v_retry.out_status = 'existing' and v_layer_b = 8 and v_consumptions = 2,
    format('status=%s layerB=%s rows=%s', v_retry.out_status, v_layer_b, v_consumptions)
  );

  -- 5) Finished-goods receipt
  select * into v_out from public.record_production_output(
    'qa-ord-1', 12, 1, 0, 'qa-wh-fg', null, 'qa-selftest', 'qa-key-output-1'
  );
  select coalesce(sum(b.quantity), 0) into v_fg_qty
    from inventory.batches b
   where b.item_id = 'qa-item-fg' and b.warehouse_id = 'qa-wh-fg' and b.batch_number = 'FG-QA-PO-1';
  perform pg_temp._qa(
    '05 finished goods received into the FG warehouse batch',
    v_out.out_status = 'ok' and v_fg_qty = 12
      and exists (select 1 from inventory.batches b where b.id = v_out.out_batch_id and b.batch_number = 'FG-QA-PO-1'),
    format('status=%s fgQty=%s batchId=%s', v_out.out_status, v_fg_qty, v_out.out_batch_id)
  );

  -- 6) Atomic close: cost, journal, order state
  select * into v_close from public.close_production_order('qa-ord-1', null, 'qa-selftest', 'qa-key-close-1');

  -- The order is the authoritative link to its journal (production.orders.journal_entry_id),
  -- so the assertions read the entry through it rather than through a source id
  -- that fin.post_journal does not receive.
  select status, coalesce(actual_cost, 0), journal_entry_id
    into v_status, v_actual, v_journal_id
    from production.orders where id = 'qa-ord-1';

  select count(*) into v_journals from fin.journal_entries e where e.id = v_journal_id;

  select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0) into v_debit, v_credit
    from fin.journal_lines l
   where l.journal_entry_id = v_journal_id;

  perform pg_temp._qa(
    '06 close capitalises actual cost and posts one balanced journal',
    v_close.out_status = 'completed'
      and v_close.out_material_cost = 64
      and v_close.out_total_cost = 64
      and v_status = 'completed'
      and v_actual = 64
      and v_journals = 1
      and v_debit = 64 and v_credit = 64
      and abs(v_debit - v_credit) < 0.01,
    format('status=%s material=%s total=%s orderStatus=%s journals=%s debit=%s credit=%s',
           v_close.out_status, v_close.out_material_cost, v_close.out_total_cost,
           v_status, v_journals, v_debit, v_credit)
  );

  -- 7) Retry of the same close: no second journal
  select * into v_retry from public.close_production_order('qa-ord-1', null, 'qa-selftest', 'qa-key-close-1');
  select journal_entry_id into v_journal_after from production.orders where id = 'qa-ord-1';
  perform pg_temp._qa(
    '07 retried close returns the same journal and posts no second one',
    v_retry.out_status in ('existing', 'already_completed')
      and v_retry.out_journal_entry_id is not distinct from v_journal_id
      and v_journal_after = v_journal_id
      and (select count(*) from fin.journal_entries e where e.id = v_journal_id) = 1,
    format('status=%s journal=%s before=%s after=%s',
           v_retry.out_status, v_retry.out_journal_entry_id, v_journal_id, v_journal_after)
  );

  -- 8) Close again with a different key after completion
  select * into v_again from public.close_production_order('qa-ord-1', null, 'qa-selftest', 'qa-key-close-2');
  select journal_entry_id into v_journal_after from production.orders where id = 'qa-ord-1';
  perform pg_temp._qa(
    '08 a completed order short-circuits without a new journal',
    v_again.out_status = 'already_completed' and v_journal_after = v_journal_id,
    format('status=%s journal=%s', v_again.out_status, v_journal_after)
  );

  -- 9) Stock reconciliation: raw 20 -> 8, FG 0 -> 12
  select coalesce(sum(quantity), 0) into v_stock from inventory.batches where item_id = 'qa-item-mat';
  select coalesce(sum(quantity), 0) into v_fg_qty from inventory.batches where item_id = 'qa-item-fg';
  perform pg_temp._qa(
    '09 inventory matches the posted movement',
    v_stock = 8 and v_fg_qty = 12,
    format('raw=%s fg=%s', v_stock, v_fg_qty)
  );
end $$;

\echo ''
\echo '=== production completion self-test (transaction will be rolled back) ==='
select name, status, case status when 'PASS' then 'OK' else 'FAIL' end as verdict, detail
  from _qa_res
 order by name;

select count(*) filter (where status <> 'PASS') as failures from _qa_res;

do $$
declare
  v_fail int;
  v_detail text;
begin
  select count(*) into v_fail from _qa_res where status <> 'PASS';
  if v_fail > 0 then
    select string_agg(name || ' (' || coalesce(detail, '') || ')', '; ') into v_detail
      from _qa_res where status <> 'PASS';
    raise exception 'production completion self-test FAILED: % check(s): %', v_fail, v_detail;
  end if;
end $$;

rollback;
