-- =====================================================================
-- scripts/qa_rest_full_cycle_setup.sql
--
-- Provisions the isolated fixtures used by the REST full-cycle test
-- (scripts/qa_rest_full_cycle.mjs). Committed on purpose: PostgREST runs every
-- call in its own transaction, so the client-side call cannot see rows created
-- by a test transaction.
--
-- Isolation contract:
--   * every id starts with `rpc-rest-`, so nothing real is touched,
--   * the customer, the item and the batches are marked is_test = true,
--   * no account, mapping, period or user is created here; the script fails
--     closed if a required mapping/unit/warehouse is missing.
--
-- Run: psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
--        -f scripts/qa_rest_full_cycle_setup.sql
-- =====================================================================
\set ON_ERROR_STOP on

do $$
declare
  v_missing text;
begin
  select string_agg(k, ', ') into v_missing
    from (values ('sales_vat_output'),('customer_receivable_local'),
                 ('sales_retail_revenue'),('cogs_local'),('inventory_finished_local')) t(k)
   where not exists (select 1 from core.account_mappings m where m.key = t.k);
  if v_missing is not null then
    raise exception 'SETUP FAILED: required account mapping(s) missing: %', v_missing;
  end if;

  if not exists (select 1 from core.warehouses where id = 'qa-e2e-wh-01') then
    raise exception 'SETUP FAILED: warehouse qa-e2e-wh-01 is missing';
  end if;
  if not exists (select 1 from core.units where id = 'qa-e2e-unit-ctn') then
    raise exception 'SETUP FAILED: unit qa-e2e-unit-ctn is missing';
  end if;
  if not exists (select 1 from core.accounting_periods
                  where not is_closed and current_date between start_date and end_date) then
    raise exception 'SETUP FAILED: no open accounting period covering today';
  end if;
end $$;

-- clean state for a re-run: only the isolated fixtures are reset, and only
-- while no posted document references them.
delete from inventory.batches b
 where b.id in ('rpc-rest-b1', 'rpc-rest-b2')
   and not exists (select 1 from inventory.transactions t
                    where t.item_id = b.item_id
                      and t.warehouse_id = b.warehouse_id
                      and t.batch_number = b.batch_number);

delete from core.items i
 where i.id = 'rpc-rest-item'
   and not exists (select 1 from inventory.transactions t where t.item_id = i.id)
   and not exists (select 1 from sales.invoice_lines l where l.item_id = i.id);

delete from core.customers c
 where c.id = 'rpc-rest-cust'
   and not exists (select 1 from sales.invoices i where i.customer_id = c.id);

insert into core.customers (id, code, name_ar, customer_type, currency, active, is_test)
values ('rpc-rest-cust', 'RPC-REST-01', 'عميل اختبار REST', 'retail', 'EGP', true, true)
on conflict (id) do nothing;

insert into core.items (id, code, name_ar, name_en, item_type, base_unit_id,
                        track_batch, track_expiry, expiry_period_days,
                        standard_cost, active, is_test)
values ('rpc-rest-item', 'RPC-REST-ITEM', 'صنف اختبار REST', 'RPC REST test item',
        'finished_product', 'qa-e2e-unit-ctn', true, true, 60, 11, true, true)
on conflict (id) do nothing;

-- two FIFO layers: the older/cheaper layer must be consumed first
insert into inventory.batches (id, item_id, warehouse_id, batch_number,
                               production_date, expiry_date, quantity, unit_cost,
                               active, is_test)
values ('rpc-rest-b1', 'rpc-rest-item', 'qa-e2e-wh-01', 'RPC-REST-B1',
        date '2026-09-01', date '2026-10-31', 3, 10, true, true),
       ('rpc-rest-b2', 'rpc-rest-item', 'qa-e2e-wh-01', 'RPC-REST-B2',
        date '2026-10-01', date '2026-11-30', 10, 12, true, true)
on conflict (id) do nothing;

-- The receipt movements that a real goods receipt would have written next to
-- the batch rows. Without them the transaction ledger (what stock_on_hand sums)
-- and the batch quantities would disagree, and the FIFO issue would look like it
-- drove stock negative.
insert into inventory.transactions (id, date, document_type, document_number, movement_type,
                                    item_id, warehouse_id, batch_number, quantity_in, quantity_out,
                                    balance_after, unit_cost, total_cost, notes, created_by, is_test)
select 'rpc-rest-rx-1', date '2026-09-01', 'goods_receipt', 'RPC-REST-SETUP', 'purchase_receipt',
       'rpc-rest-item', 'qa-e2e-wh-01', 'RPC-REST-B1', 3, 0, 3, 10, 30,
       'QA REST fixture receipt', 'qa-rest-setup', true
 where not exists (select 1 from inventory.transactions t where t.id = 'rpc-rest-rx-1');

insert into inventory.transactions (id, date, document_type, document_number, movement_type,
                                    item_id, warehouse_id, batch_number, quantity_in, quantity_out,
                                    balance_after, unit_cost, total_cost, notes, created_by, is_test)
select 'rpc-rest-rx-2', date '2026-10-01', 'goods_receipt', 'RPC-REST-SETUP', 'purchase_receipt',
       'rpc-rest-item', 'qa-e2e-wh-01', 'RPC-REST-B2', 10, 0, 13, 12, 120,
       'QA REST fixture receipt', 'qa-rest-setup', true
 where not exists (select 1 from inventory.transactions t where t.id = 'rpc-rest-rx-2');

\echo 'SETUP OK: rpc-rest-cust / rpc-rest-item / rpc-rest-b1 (3@10) / rpc-rest-b2 (10@12) + 2 receipts'
