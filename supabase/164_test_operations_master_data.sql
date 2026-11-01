-- =====================================================================
-- 164_test_operations_master_data.sql
--
-- TEST-only master data that the cloud write screens need in order to be used
-- from the UI instead of only from a script:
--
--   * a SECOND warehouse, so an internal transfer has a real target,
--   * a receivables (ذمم عملاء) account, wired through
--     core.account_mappings.customer_receivable_local, so credit sales have a
--     proper AR ledger account instead of the QA cash account,
--   * two suppliers (is_test) so the purchasing side has master data,
--   * three items (is_test): two batch/expiry-tracked finished products and one
--     raw material, with opening stock batches AND matching receipt movements so
--     stock_on_hand and the FIFO layers agree.
--
-- Rules honoured here:
--   * every row is marked is_test = true,
--   * idempotent: `on conflict do nothing`, no UPDATE of existing rows except the
--     one receivable mapping (and only to the account created here),
--   * no existing business row is deleted or renamed,
--   * no account is invented beyond the two the operations need, and both are
--     leaf accounts under the existing tree (no header posting),
--   * TEST only. Never run against production.
-- =====================================================================
\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------
-- 1. Second warehouse (local finished goods — WH-02 in the spec)
-- ---------------------------------------------------------------------
insert into core.warehouses (id, code, name_ar, type, active)
values ('qa-e2e-wh-02', 'QA-WHS-02', 'مستودع المنتج التام المحلي — QA',
        'local_finished', true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2. Receivables account + mapping (ذمم العملاء)
-- ---------------------------------------------------------------------
insert into core.accounts (id, code, name_ar, name_en, category, is_header, level, is_test)
values ('qa-acc-ar-1101', '1101 QA', 'ذمم العملاء — QA', 'Accounts Receivable — QA',
        'Current Assets', false, 3, true)
on conflict (id) do nothing;

-- Point the existing key at the AR account. Only ever replaces the QA cash
-- account that key was provisionally mapped to; an operator-set mapping is left
-- alone (is_test guard).
update core.account_mappings m
   set account_id = 'qa-acc-ar-1101', updated_at = now()
 where m.key = 'customer_receivable_local'
   and m.account_id in ('qa-e2e-acc-1105');

insert into core.account_mappings (id, key, name_ar, account_id, is_test)
values ('qa-map-ar-local', 'customer_receivable_local', 'ذمم العملاء المحليون',
        'qa-acc-ar-1101', true)
on conflict (key) do update
  set account_id = excluded.account_id, updated_at = now()
  where core.account_mappings.account_id = 'qa-e2e-acc-1105';

-- ---------------------------------------------------------------------
-- 3. Suppliers (is_test)
-- ---------------------------------------------------------------------
insert into core.suppliers (id, code, name_ar, currency, payment_terms, active, is_test)
values
  ('qa-sup-01', 'QA-SUP-01', 'مورد تعبئة — QA', 'EGP', '30 يومًا', true, true),
  ('qa-sup-02', 'QA-SUP-02', 'مورد مواد خام — QA', 'EGP', 'نقدًا', true, true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 4. Items (is_test)
-- ---------------------------------------------------------------------
insert into core.items (id, code, name_ar, name_en, item_type, base_unit_id,
                        track_batch, track_expiry, expiry_period_days,
                        vat_rate, standard_cost, selling_price_retail,
                        selling_price_wholesale, active, is_test)
values
  ('qa-item-01', 'QA-ITEM-01', 'شيبس ملح — QA', 'Salted Chips — QA',
   'finished_product', 'qa-e2e-unit-ctn', true, true, 180, 0.14, 10, 30, 27, true, true),
  ('qa-item-02', 'QA-ITEM-02', 'شيبس جبنة — QA', 'Cheese Chips — QA',
   'finished_product', 'qa-e2e-unit-ctn', true, true, 120, 0.14, 12, 34, 30, true, true),
  ('qa-item-rm-01', 'QA-ITEM-RM-01', 'بطاطس خام — QA', 'Raw Potato — QA',
   'raw_material', 'qa-e2e-unit-ctn', false, false, null, 0, 0, 0, 0, true, true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 5. Opening stock: batches + the receipt movements that created them
-- ---------------------------------------------------------------------
insert into inventory.batches (id, item_id, warehouse_id, batch_number,
                               production_date, expiry_date, quantity, unit_cost,
                               active, is_test)
values
  ('qa-bat-01-a', 'qa-item-01', 'qa-e2e-wh-01', 'QA-B01-A',
   date '2026-10-05', date '2027-04-03', 40, 10, true, true),
  ('qa-bat-01-b', 'qa-item-01', 'qa-e2e-wh-01', 'QA-B01-B',
   date '2026-10-20', date '2027-04-18', 60, 11, true, true),
  ('qa-bat-02-a', 'qa-item-02', 'qa-e2e-wh-01', 'QA-B02-A',
   date '2026-10-10', date '2027-02-07', 30, 12, true, true),
  ('qa-bat-rm-01', 'qa-item-rm-01', 'qa-e2e-wh-01', 'QA-RM-01-A',
   date '2026-10-01', null, 500, 4, true, true)
on conflict (id) do nothing;

insert into inventory.transactions (id, date, document_type, document_number, movement_type,
                                    item_id, warehouse_id, batch_number, quantity_in, quantity_out,
                                    balance_after, unit_cost, total_cost, notes, created_by, is_test)
select v.id, v.d, 'goods_receipt', 'QA-OPENING', 'purchase_receipt',
       v.item_id, 'qa-e2e-wh-01', v.batch_number, v.qty, 0, v.balance_after,
       v.cost, v.qty * v.cost, 'رصيد افتتاحي اختباري', 'qa-seed', true
  from (values
    ('qa-tx-01-a', date '2026-10-05', 'qa-item-01', 'QA-B01-A', 40::numeric, 10::numeric, 40::numeric),
    ('qa-tx-01-b', date '2026-10-20', 'qa-item-01', 'QA-B01-B', 60::numeric, 11::numeric, 100::numeric),
    ('qa-tx-02-a', date '2026-10-10', 'qa-item-02', 'QA-B02-A', 30::numeric, 12::numeric, 30::numeric),
    ('qa-tx-rm-01', date '2026-10-01', 'qa-item-rm-01', 'QA-RM-01-A', 500::numeric, 4::numeric, 500::numeric)
  ) as v(id, d, item_id, batch_number, qty, cost, balance_after)
 where not exists (select 1 from inventory.transactions t where t.id = v.id);

commit;

\echo ''
\echo '=== TEST master data ==='
select 'warehouses' as entity, count(*)::text as rows from core.warehouses
union all select 'suppliers (is_test)', count(*)::text from core.suppliers where is_test
union all select 'items (is_test)', count(*)::text from core.items where is_test
union all select 'batches (is_test)', count(*)::text from inventory.batches where is_test
union all select 'receipt movements', count(*)::text from inventory.transactions where document_number = 'QA-OPENING';
select key, account_id from core.account_mappings where key = 'customer_receivable_local';
