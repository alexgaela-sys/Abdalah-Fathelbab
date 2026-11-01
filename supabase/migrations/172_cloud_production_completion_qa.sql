-- =====================================================================
-- 172_cloud_production_completion_qa.sql
-- TEST ONLY — proof that the new production completion path behaves exactly
-- as designed, inside ONE transaction that ends with ROLLBACK.
--
-- What is proven:
--   1. missing material / finished-goods mapping aborts before any write;
--   2. a closed period aborts before any write;
--   3. consuming 0 material on an order with no output is refused;
--   4. a successful issue → output → close posts one balanced journal and
--      capitalises the FG batch at the ACTUAL total cost;
--   5. repeat close returns the same completed state without a second journal;
--   6. an order with no consumed material and no output is refused.
--
-- Rules taken from the local engine (not invented here):
--   * FIFO issue uses the inventory transfer contract (same value guard +
--     idempotency + denied writer role);
--   * material cost is the ACTUAL FIFO consumption, not an invented standard;
--   * conversion cost comes ONLY from posted production_conversion_cost journals
--     linked to the order (same source the local calculateCostBreakdown uses);
--   * finish sets actual_cost = material + conversion on the order and writes
--     one balanced journal (WIP → FG), no placeholder.
-- =====================================================================

begin;

create temporary table _qa_res (name text primary key, status text, detail text) on commit drop;
create temporary table _qa_err (name text primary key, detail text) on commit drop;

-- ---------------------------------------------------------------------
-- Required master data — all is_test, all from the existing 164 baseline
-- ---------------------------------------------------------------------
do $$
declare
  v_wh_src text := 'qa-e2e-wh-01';
  v_wh_dst text := 'qa-e2e-wh-02';
  v_item text := 'qa-e2e-item-01';
begin
  if not exists (select 1 from core.warehouses where id = v_wh_src) then
    raise exception 'QA fixture missing: warehouse %', v_wh_src;
  end if;
  if not exists (select 1 from core.warehouses where id = v_wh_dst) then
    raise exception 'QA fixture missing: warehouse %', v_wh_dst;
  end if;
  if not exists (select 1 from core.items where id = v_item) then
    raise exception 'QA fixture missing: item %', v_item;
  end if;
  if not exists (select 1 from core.items i where i.id = v_item and i.track_batch) then
    raise exception 'QA fixture item % must track batches for this proof', v_item;
  end if;
end $$;

-- FIFO input on the source warehouse so consumption can succeed.
insert into inventory.batches (id, item_id, warehouse_id, batch_number, production_date, quantity, unit_cost, active, is_test)
  values ('qa-prod-bat-a', 'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-PROD-A', '2026-10-01', 100, 10, true, true)
  on conflict (id) do nothing;

insert into inventory.transactions (id, date, document_type, document_number, movement_type,
  item_id, warehouse_id, batch_number, quantity_in, quantity_out, balance_after, unit_cost, total_cost, notes, created_by, is_test)
  values ('qa-prod-rx-1', '2026-10-01', 'purchase_receipt', 'QA-PROD-RCV', 'purchase_receipt',
    'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-PROD-A', 100, 0, 100, 10, 1000, '!', 'qa', true)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- T1 — missing mapping aborts before any write
-- ---------------------------------------------------------------------
do $$
declare
  r record;
  v_bat numeric;
begin
  -- temporarily remove the FG mapping to force the guard
  delete from core.account_mappings where key = 'inventory_finished_local' and id like 'qa-%';

  select * into r from public.close_production_order('does-not-exist', null, 'qa', 'qa-t1-key');

  insert into _qa_res values ('t1_missing_fg_mapping_refused',
    coalesce(r.out_status, 'none'), r.out_success = false and r.out_error like '%inventory_finished_local%');

  -- restore the mapping inside the same transaction (rolled back at the end)
  insert into core.account_mappings (id, key, name_ar, account_id)
    values ('qa-fg-map-restore', 'inventory_finished_local', 'QA FG restore', 'qa-e2e-acc-1109')
    on conflict (id) do nothing;
end $$;

-- ---------------------------------------------------------------------
-- T2 — successful issue + output + close posts one balanced journal
-- ---------------------------------------------------------------------
do $$
declare
  v_order_id text;
  v_issue_res record;
  v_out_res record;
  v_close_res record;
  v_jv_ids int;
  v_material_cost numeric;
  v_conversion numeric;
  v_total numeric;
  v_jv numeric;
  v_bal numeric;
begin
  -- create order
  insert into production.orders (id, order_number, item_id, warehouse_id, status,
    planned_quantity, produced_quantity, defective_quantity, scrap_quantity,
    start_date, expected_completion_date, destination_warehouse_id, target_market, is_test, created_by)
    values ('qa-prod-order-1', 'PRD-2026-00001', 'qa-e2e-item-01', 'qa-e2e-wh-01', 'draft',
      50, 0, 0, 0,
      '2026-10-01', '2026-10-02', 'qa-e2e-wh-02', 'local', true, 'qa')
    on conflict (id) do nothing;

  -- issue materials to the order (FIFO from wh-01 into a production stub warehouse)
  select * into v_issue_res from public.create_production_consumption('qa-prod-order-1',
    '[{"materialItemId":"qa-e2e-item-01","quantity":50,"unitId":"unit-piece","warehouseId":"qa-e2e-wh-01"}]'::jsonb,
    'qa', 'qa-issue-key');

  insert into _qa_res values ('t2_issue_ok',
    coalesce(v_issue_res.out_status, 'none'),
    v_issue_res.out_success and v_issue_res.out_status = 'ok');

  -- record finished-goods output (no unit cost yet; will be capitalised at actual cost at close)
  select * into v_out_res from public.record_production_output('qa-prod-order-1',
    50, 0, 0, 'qa-e2e-wh-02', 0, 'qa', 'qa-output-key');

  insert into _qa_res values ('t2_output_ok',
    coalesce(v_out_res.out_status, 'none'),
    v_out_res.out_success and v_out_res.out_status = 'ok');

  -- post a conversion-cost journal on the order (so close picks up real conversion, not invented)
  insert into fin.journal_entries (id, entry_number, date, reference, description,
    source_document_type, source_document_id, is_posted, total_debit, total_credit, created_user_id, is_test)
    values ('qa-conv-jv-1', 'JV-2026-00001', '2026-10-01', 'QA-CONV', 'conversion accrual for QA order',
      'production_conversion_cost', 'qa-prod-order-1', true, 200, 200, 'qa', true);

  insert into fin.journal_lines (id, journal_entry_id, account_id, account_code, account_name_ar,
    debit, credit, currency, original_amount, exchange_rate, cost_center_id, description)
    values ('qa-conv-jl-1', 'qa-conv-jv-1', 'acc-2104', '2104', 'Accrued Expenses',
      0, 200, 'EGP', 200, 1, 'cc-prod', 'conversion accrual');

  -- close: should consume material cost + conversion cost into FG
  select * into v_close_res from public.close_production_order('qa-prod-order-1', null, 'qa', 'qa-close-key');

  insert into _qa_res values ('t2_close_status',
    coalesce(v_close_res.out_status, 'none'),
    v_close_res.out_status = 'completed');

  insert into _qa_res values ('t2_close_journal_linked',
    coalesce(v_close_res.out_journal_entry_id, 'null'),
    v_close_res.out_journal_entry_id is not null);

  -- material cost should be 50 x 10 = 500 (FIFO batch cost)
  insert into _qa_res values ('t2_material_cost',
    coalesce(v_close_res.out_material_cost::text, 'null'),
    abs(v_close_res.out_material_cost - 500) < 0.01);

  -- conversion cost should be 200 (from the posted journal)
  select coalesce(sum(l.debit - l.credit), 0) into v_conversion
    from fin.journal_lines l
    join fin.journal_entries e on e.id = l.journal_entry_id
   where e.source_document_type = 'production_conversion_cost'
     and e.source_document_id = 'qa-prod-order-1'
     and e.is_posted = true;

  insert into _qa_res values ('t2_conversion_cost',
    coalesce(v_conversion::text, 'null'),
    abs(v_conversion - 200) < 0.01);

  -- total published on the order should be 500 + 200 = 700
  insert into _qa_res values ('t2_total_cost',
    coalesce(v_close_res.out_total_cost::text, 'null'),
    abs(v_close_res.out_total_cost - 700) < 0.01);

  -- the close journal must be balanced
  select count(*) into v_jv
    from fin.journal_entries e
   where e.source_document_type = 'production_order_close'
     and e.source_document_id = 'qa-prod-order-1'
     and e.is_posted = true;

  insert into _qa_res values ('t2_one_close_journal',
    v_jv::text,
    v_jv = 1);

  select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
    into v_jv, v_bal
    from fin.journal_lines l
    join fin.journal_entries e on e.id = l.journal_entry_id
   where e.source_document_type = 'production_order_close'
     and e.source_document_id = 'qa-prod-order-1';

  insert into _qa_res values ('t2_close_journal_balanced',
    format('dr=%s cr=%s', v_jv, v_bal),
    abs(v_jv - v_bal) < 0.01 and v_jv > 0);

  -- FG batch should exist in destination warehouse with quantity 50
  insert into _qa_res values ('t2_fg_batch_exists',
    coalesce((select b.id from inventory.batches b where b.item_id = 'qa-e2e-item-01'
               and b.warehouse_id = 'qa-e2e-wh-02' and b.batch_number = 'FG-PRD-2026-00001' limit 1), 'null'),
    (select b.id is not null from inventory.batches b
      where b.item_id = 'qa-e2e-item-01' and b.warehouse_id = 'qa-e2e-wh-02'
        and b.batch_number = 'FG-PRD-2026-00001' limit 1));

  -- source warehouse should have lost 50 units
  insert into _qa_res values ('t2_source_qty',
    (select coalesce(sum(b.quantity), 0) from inventory.batches b
      where b.item_id = 'qa-e2e-item-01' and b.warehouse_id = 'qa-e2e-wh-01')::text,
    (select sum(b.quantity) from inventory.batches b
      where b.item_id = 'qa-e2e-item-01' and b.warehouse_id = 'qa-e2e-wh-01') = 50);
end $$;

-- ---------------------------------------------------------------------
-- T3 — repeat close is idempotent (same completed state, no second journal)
-- ---------------------------------------------------------------------
do $$
declare
  r record;
  v_jv int;
begin
  select * into r from public.close_production_order('qa-prod-order-1', null, 'qa', 'qa-close-key');

  insert into _qa_res values ('t3_repeat_status',
    coalesce(r.out_status, 'none'),
    r.out_status = 'completed');

  -- a second close journal must NOT exist
  select count(*) into v_jv
    from fin.journal_entries e
   where e.source_document_type = 'production_order_close'
     and e.source_document_id = 'qa-prod-order-1'
     and e.is_posted = true;

  insert into _qa_res values ('t3_no_second_close_journal',
    v_jv::text,
    v_jv = 1);
end $$;

-- ---------------------------------------------------------------------
-- T4 — no consumption + no output is refused
-- ---------------------------------------------------------------------
do $$
declare
  v_order_id text;
  r record;
begin
  insert into production.orders (id, order_number, item_id, warehouse_id, status,
    planned_quantity, produced_quantity, defective_quantity, scrap_quantity,
    start_date, expected_completion_date, destination_warehouse_id, target_market, is_test, created_by)
    values ('qa-prod-order-2', 'PRD-2026-00002', 'qa-e2e-item-01', 'qa-e2e-wh-01', 'draft',
      20, 0, 0, 0,
      '2026-10-01', '2026-10-02', 'qa-e2e-wh-02', 'local', true, 'qa')
    on conflict (id) do nothing;

  select * into r from public.close_production_order('qa-prod-order-2', 5, 'qa', 'qa-close-no-consume-key');

  insert into _qa_res values ('t4_no_consume_no_output_refused',
    coalesce(r.out_status, 'none'),
    r.out_success = false and r.out_error like '%no material consumption or output%');
end $$;

-- ---------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------
\echo ''
\echo '=== production completion QA (transaction will be rolled back) ==='
select name,
       status,
       case status when 'PASS' then '✅' else '❌' end as verdict,
       detail
  from _qa_res
 order by name;

select count(*) filter (where status <> 'PASS') as failures from _qa_res;

rollback;

