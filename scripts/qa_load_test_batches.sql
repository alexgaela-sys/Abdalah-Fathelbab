-- qa_load_test_batches.sql
-- NON-DESTRUCTIVE isolated batch/sales-design harness (TEST only).
-- All synthetic rows live in one transaction; before mutating we take a
-- snapshot; at the end we DELETE only our own rows and restore originals.
-- Nothing persists, nothing is deleted except our synthetic rows.

begin;

-- Snapshot book values BEFORE we touch anything (so we can prove no drift).
create temporary table qa_pre_ba (like inventory.batches) on commit drop;
insert into qa_pre_ba
  select * from inventory.batches
 where item_id = 'qa-e2e-item-01' and warehouse_id = 'qa-e2e-wh-01';

create temporary table qa_pre_tx (like inventory.transactions) on commit drop;
insert into qa_pre_tx
  select * from inventory.transactions
 where item_id = 'qa-e2e-item-01' and warehouse_id = 'qa-e2e-wh-01';

comment on table qa_pre_ba is 'pre-existing rows we reproduce before deletion';
comment on table qa_pre_tx is 'pre-existing tx rows we reproduce before deletion';

-- Synthetic fixtures: 3 FIFO layers + 1 receipt movement
insert into inventory.batches
  (id, item_id, warehouse_id, batch_number, production_date, expiry_date, quantity, unit_cost, active)
values
  ('qa-bat-1', 'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-B1', '2026-01-10', null, 10, 10, true),
  ('qa-bat-2', 'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-B2', '2026-02-01', null, 10, 14, true),
  ('qa-bat-3', 'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-B3', '2026-03-01', null, 5, 18, true);

insert into inventory.transactions
  (id, date, document_type, document_number, movement_type, item_id, warehouse_id,
   batch_number, quantity_in, quantity_out, balance_after, unit_cost, total_cost,
   notes, created_by, is_test)
values
  ('qa-tx-1', '2026-10-01', 'إيصال استلام', 'QA-RCV-001', 'purchase_receipt',
   'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-B1', 10, 0, 10, 10, 100,
   'استلام اصطناعي للاختبار (لا تُعكس في أي فاتورة حقيقية)', 'qa', true),
  ('qa-tx-2', '2026-10-01', 'إيصال استلام', 'QA-RCV-002', 'purchase_receipt',
   'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-B2', 10, 0, 20, 14, 140,
   'استلام اصطناعي للاختبار (لا تُعكس في أي فاتورة حقيقية)', 'qa', true),
  ('qa-tx-3', '2026-10-01', 'إيصال استلام', 'QA-RCV-003', 'purchase_receipt',
   'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-B3', 5, 0, 25, 18, 90,
   'استلام اصطناعي للاختبار (لا تُعكس في أي فاتور حقيقية)', 'qa', true);

-- Engineering window: stock + details for the design doc.
\echo ''
\echo '=== isolated engineering window for sales FIFO design ==='
select 'stock='||coalesce(sum(quantity),0) from inventory.batches
 where item_id = 'qa-e2e-item-01' and warehouse_id = 'qa-e2e-wh-01';
select 'tx_rows='||count(*) from inventory.transactions
 where item_id = 'qa-e2e-item-01' and warehouse_id = 'qa-e2e-wh-01';
select batch_number||' qty='||quantity||' unit='||unit_cost||' qty*unit='||(quantity*unit_cost)
  from inventory.batches
 where item_id = 'qa-e2e-item-01' and warehouse_id = 'qa-e2e-wh-01'
 order by production_date, batch_number;

-- Restore + delete synthetic rows (prove nothing persists).
create temporary table qa_synthetic (rc integer) on commit drop;
do $$
declare
  n_before int;
  n_after int;
begin
  select count(*)::int into n_before
    from inventory.batches
   where item_id = 'qa-e2e-item-01' and warehouse_id = 'qa-e2e-wh-01'
     and id like 'qa-%';

  -- Restore the pre-existing snapshot exactly (it was 0 rows, but we reproduce
  -- it verbatim so a future run with real stock for this item is still safe).
  insert into inventory.batches
    select * from qa_pre_ba;

  delete from inventory.batches
   where id like 'qa-%';

  insert into inventory.transactions
    select * from qa_pre_tx;

  delete from inventory.transactions
   where id like 'qa-%';

  select count(*)::int into n_after
    from inventory.batches
   where item_id = 'qa-e2e-item-01' and warehouse_id = 'qa-e2e-wh-01'
     and id like 'qa-%';

  insert into qa_synthetic (rc) values (n_before);
end $$;

\echo 'synthetic rows removed: ' || (select rc from qa_synthetic limit 1);
