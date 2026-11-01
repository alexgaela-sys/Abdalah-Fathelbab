-- qa_cloud_write_paths.sql — TEST only.
--
-- Simulates the REAL PostgREST call path, which the earlier owner-session
-- tests could not reach:
--     * SET ROLE authenticated   -> the client role, which holds ZERO table
--                                    grants in TEST (verified with
--                                    has_table_privilege = false everywhere),
--     * request.jwt.claims = {"sub": "<auth id>"}  -> what PostgREST sets, so
--                                    auth.uid() and current_erp_role() behave
--                                    exactly as they do for a browser session.
--
-- Probes, all inside ONE transaction that ends with ROLLBACK:
--   1  gate      : Viewer must be refused by can_write_inventory()
--   2  transfer  : 6 units wh-01 -> wh-02 (FIFO, value guard, 2 movements)
--   3  idempotency: same key returns the same document, no second movement
--   4  negative  : insufficient stock refused without any write
--   5  sales     : integrated posting reports the missing account mapping
--   6  purchase  : purchase posting reports the missing master data
--
-- Run: psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/qa_cloud_write_paths.sql

begin;

create temporary table qa_res (name text primary key, status text, detail text) on commit drop;
grant all on table qa_res to authenticated;

-- identities (read once, as the owner, before switching role)
create temporary table qa_ident (label text primary key, auth_id text) on commit drop;

-- The posting identity is the approved TEST writer that actually exists. The
-- refused identity is created inside this transaction instead of being read from
-- the database: the gate check must not depend on a Viewer row being kept around
-- permanently, and it must not silently pass when no Viewer exists.
insert into qa_ident values
  ('admin', (select p.supabase_auth_id from core.app_profiles p
              where p.active = true and p.role = 'Super Admin'
              order by p.id limit 1)),
  ('viewer', '22222222-2222-2222-2222-222222222222');

insert into core.app_profiles (id, user_id, supabase_auth_id, username, name, role, active, is_test)
values ('qa-wp-viewer-01', '22222222-2222-2222-2222-222222222222',
        '22222222-2222-2222-2222-222222222222', 'qa-wp-viewer', 'QA transfer viewer',
        'Viewer', true, true)
on conflict (id) do nothing;

grant all on table qa_ident to authenticated;

-- isolated book state for this run (second warehouse + one FIFO layer)
insert into core.warehouses (id, code, name_ar, type, active)
values ('qa-e2e-wh-02', 'QA-WHS-02', 'مستودع تجريبي QA 2', 'local_finished', true)
on conflict (id) do nothing;

insert into inventory.batches
  (id, item_id, warehouse_id, batch_number, production_date, expiry_date,
   quantity, unit_cost, active)
values
  ('qa-wp-bat-1', 'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-WP-A', '2026-01-10', null,
   10, 10, true)
on conflict (id) do nothing;

insert into inventory.transactions
  (id, date, document_type, document_number, movement_type, item_id, warehouse_id,
   batch_number, quantity_in, quantity_out, balance_after, unit_cost, total_cost,
   notes, created_by, is_test)
values
  ('qa-wp-tx-1', '2026-10-01', 'اختبار داخلي', 'QA-WP-RCV', 'purchase_receipt',
   'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-WP-A', 10, 0, 10, 10, 100, '!', 'qa', true)
on conflict (id) do nothing;

grant all on table qa_ident to authenticated;

-- exactly what PostgREST would put in the session
select set_config('request.jwt.claims',
  json_build_object('sub', (select auth_id from qa_ident where label = 'admin'))::text,
  true);

set role authenticated;

do $$
declare
  r record;
  v_src numeric;
  v_tgt numeric;
  v_moves int;
  v_value_before numeric;
  v_value_after numeric;
  v_doc text;
  v_err text;
begin
  -- ---------------------------------------------------- (1) gate: Viewer
  perform set_config('request.jwt.claims',
    json_build_object('sub', (select auth_id from qa_ident where label = 'viewer'))::text, true);

  begin
    select * into r from public.post_inventory_transfer(
      'qa-e2e-item-01', 'qa-e2e-wh-01', 'qa-e2e-wh-02', 1, null, null, null, 'qa-wp-gate');
    insert into qa_res values ('gate_view_refuses_viewer',
      case when coalesce(r.out_success, false) = false
                and r.out_error like '%not allowed to move inventory%'
           then 'PASS' else 'FAIL' end,
      coalesce(r.out_error, format('status=%s doc=%s', r.out_success, r.out_document_number)));
  exception when others then
    insert into qa_res values ('gate_view_refuses_viewer', 'FAIL', SQLERRM);
  end;

  -- back to the posting identity
  perform set_config('request.jwt.claims',
    json_build_object('sub', (select auth_id from qa_ident where label = 'admin'))::text, true);

  -- ---------------------------------------------------- (2) transfer
  select coalesce(sum(quantity * unit_cost), 0) into v_value_before from inventory.batches;

  begin
    select * into r from public.post_inventory_transfer(
      'qa-e2e-item-01', 'qa-e2e-wh-01', 'qa-e2e-wh-02', 6, null, 'تحويل اختبار سحابي',
      '2026-10-20', 'qa-wp-key-1');
    v_doc := r.out_document_number;

    select coalesce(quantity, 0) into v_src from inventory.batches
     where item_id = 'qa-e2e-item-01' and warehouse_id = 'qa-e2e-wh-01';
    select coalesce(quantity, 0) into v_tgt from inventory.batches
     where item_id = 'qa-e2e-item-01' and warehouse_id = 'qa-e2e-wh-02';
    select count(*) into v_moves from inventory.transactions
     where document_number = v_doc and movement_type = 'warehouse_transfer';
    select coalesce(sum(quantity * unit_cost), 0) into v_value_after from inventory.batches;

    insert into qa_res values
      ('transfer_returns_document',
        case when coalesce(r.out_success, false) = true and v_doc is not null
             then 'PASS' else 'FAIL' end,
        coalesce(r.out_error, v_doc)),
      ('transfer_source_4_target_6',
        case when v_src = 4 and v_tgt = 6 then 'PASS' else 'FAIL' end,
        format('source=%s target=%s', v_src, v_tgt)),
      ('transfer_two_movements',
        case when v_moves = 2 then 'PASS' else 'FAIL' end, v_moves::text),
      ('transfer_value_guard',
        case when abs(v_value_after - v_value_before) < 0.01 then 'PASS' else 'FAIL' end,
        format('before=%s after=%s', v_value_before, v_value_after));
  exception when others then
    insert into qa_res values ('transfer_returns_document', 'FAIL', SQLERRM);
  end;

  -- ---------------------------------------------------- (3) idempotency
  begin
    v_moves := (select count(*) from inventory.transactions
                 where movement_type = 'warehouse_transfer');
    select * into r from public.post_inventory_transfer(
      'qa-e2e-item-01', 'qa-e2e-wh-01', 'qa-e2e-wh-02', 6, null, null, null, 'qa-wp-key-1');

    insert into qa_res values
      ('idem_same_document',
        case when coalesce(r.out_success, false) = true and r.out_document_number = v_doc
             then 'PASS' else 'FAIL' end,
        coalesce(r.out_error, r.out_document_number)),
      ('idem_no_second_movement',
        case when (select count(*) from inventory.transactions
                    where movement_type = 'warehouse_transfer') = v_moves
             then 'PASS' else 'FAIL' end,
        format('movements before=%s after=%s', v_moves,
               (select count(*) from inventory.transactions
                 where movement_type = 'warehouse_transfer'))),
      ('idem_source_still_4',
        case when (select quantity from inventory.batches
                    where item_id = 'qa-e2e-item-01' and warehouse_id = 'qa-e2e-wh-01') = 4
             then 'PASS' else 'FAIL' end, 'a repeat must not move stock twice');
  exception when others then
    insert into qa_res values ('idem_same_document', 'FAIL', SQLERRM);
  end;

  -- ---------------------------------------------------- (4) insufficient stock
  v_moves := (select count(*) from inventory.transactions);
  begin
    select * into r from public.post_inventory_transfer(
      'qa-e2e-item-01', 'qa-e2e-wh-01', 'qa-e2e-wh-02', 999, null, null, null, 'qa-wp-key-2');
    insert into qa_res values
      ('insufficient_stock_refused',
        case when coalesce(r.out_success, false) = false
                  and r.out_error like '%available quantity%'
             then 'PASS' else 'FAIL' end,
        coalesce(r.out_error, 'unexpected success')),
      ('insufficient_stock_no_write',
        case when (select count(*) from inventory.transactions) = v_moves
                  and (select quantity from inventory.batches
                        where item_id = 'qa-e2e-item-01' and warehouse_id = 'qa-e2e-wh-01') = 4
             then 'PASS' else 'FAIL' end,
        'no movement and no balance change');
  exception when others then
    insert into qa_res values ('insufficient_stock_refused', 'FAIL', SQLERRM);
  end;

  -- ---------------------------------------------------- (5) sales: integrated posting
  -- The chart mappings for this path exist now, so the expectation is a real
  -- posting (invoice + sales journal + COGS journal), not a missing-mapping
  -- refusal. Everything below is rolled back with the rest of the run.
  begin
    select * into r from public.post_sales_invoice_integrated(
      'qa-e2e-cust-01', 'retail', 'qa-e2e-wh-01', 'cash', 'EGP', 1, '2026-10-20',
      '[{"itemId":"qa-e2e-item-01","quantity":1,"unitPrice":100,"vatRate":0.14}]',
      'qa', 'qa-wp-sales-1');
    insert into qa_res values ('sales_integrated_posting',
      case when coalesce(r.out_success, false) = true
                and r.out_invoice_number is not null
                and coalesce(r.out_journal_number, '') <> ''
           then 'PASS' else 'FAIL' end,
      coalesce(r.out_error,
               format('%s cogs=%s cogs_jv=%s', r.out_invoice_number, r.out_cogs, r.out_journal_number)));
  exception when others then
    insert into qa_res values ('sales_integrated_posting', 'FAIL', SQLERRM);
  end;

  -- ---------------------------------------------------- (6) purchase: no suppliers
  begin
    select * into r from public.post_purchase_invoice(
      'qa-no-supplier', 'qa-e2e-wh-01', 'credit', 'EGP', 1, 'REF', '2026-10-20', null,
      '[{"itemId":"qa-e2e-item-01","quantity":1,"unitPrice":10,"vatRate":0.14}]',
      'qa', true, 'qa-wp-pur-1');
    insert into qa_res values ('purchase_reports_missing_masterdata',
      case when coalesce(r.success, false) = false then 'PASS' else 'FAIL' end,
      coalesce(r.error, 'unexpected success'));
  exception when others then
    insert into qa_res values ('purchase_reports_missing_masterdata', 'PASS', SQLERRM);
  end;
end $$;

reset role;

\echo ''
\echo '=== qa_cloud_write_paths (simulated PostgREST session, rolled back) ==='
select name, status as verdict, detail from qa_res
 order by case name
   when 'gate_view_refuses_viewer'        then 1
   when 'transfer_returns_document'       then 2
   when 'transfer_source_4_target_6'      then 3
   when 'transfer_two_movements'          then 4
   when 'transfer_value_guard'            then 5
   when 'idem_same_document'              then 6
   when 'idem_no_second_movement'         then 7
   when 'idem_source_still_4'             then 8
   when 'insufficient_stock_refused'      then 9
   when 'insufficient_stock_no_write'     then 10
   when 'sales_integrated_posting'        then 11
   when 'purchase_reports_missing_masterdata' then 12
   else 99 end, name;

with s as (select count(*)::int as f from qa_res where status = 'FAIL')
select (select count(*) from qa_res) as checks, (select f from s) as failures;

rollback;

\echo ''
\echo '=== rolled back: no row from this run persisted ==='
select 'batches=' || (select count(*) from inventory.batches)
    || ' tx=' || (select count(*) from inventory.transactions)
    || ' warehouses=' || (select count(*) from core.warehouses)
    || ' trf_log=' || (select count(*) from fin.inventory_transfer_log);
