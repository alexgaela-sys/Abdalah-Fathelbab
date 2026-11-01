-- qa_client_privileges.sql — TEST only.
-- Documents what the PostgREST client role (authenticated) can actually do
-- DIRECTLY on tables, versus what it can do through the RPCs.
-- Everything runs in one transaction and is rolled back.
--
-- Run: psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/qa_client_privileges.sql

begin;

create temporary table qa_res (name text primary key, status text, detail text) on commit drop;
grant all on table qa_res to authenticated;

create temporary table qa_ident (label text primary key, auth_id text) on commit drop;
-- Exactly one posting identity: more than one Super Admin profile exists now, and
-- the probe only needs one of them.
insert into qa_ident
select 'admin', p.supabase_auth_id
  from core.app_profiles p
 where p.active = true and p.role = 'Super Admin'
 order by p.id
 limit 1;
grant all on table qa_ident to authenticated;

select set_config('request.jwt.claims',
  json_build_object('sub', (select auth_id from qa_ident where label = 'admin'))::text, true);

set role authenticated;

do $$
declare
  v_detail text;
begin
  -- direct read of a document table
  begin
    perform 1 from sales.invoices limit 1;
    insert into qa_res values ('direct_read_sales_invoices', 'READABLE', 'client can SELECT sales.invoices');
  exception when others then
    insert into qa_res values ('direct_read_sales_invoices', 'DENIED', SQLERRM);
  end;

  -- direct read of the role table
  begin
    perform 1 from core.app_profiles limit 1;
    insert into qa_res values ('direct_read_app_profiles', 'READABLE', 'client can SELECT core.app_profiles');
  exception when others then
    insert into qa_res values ('direct_read_app_profiles', 'DENIED', SQLERRM);
  end;

  -- direct insert into an RLS-protected stock table (policy: can_write_inventory)
  begin
    insert into inventory.batches (id, item_id, warehouse_id, batch_number,
      production_date, quantity, unit_cost, active)
    values ('qa-priv-probe', 'qa-e2e-item-01', 'qa-e2e-wh-01', 'PRIV-PROBE',
      '2026-01-01', 1, 1, true);
    insert into qa_res values ('direct_insert_inventory_batches', 'ALLOWED',
      'client INSERT reached the stock table directly');
  exception when others then
    insert into qa_res values ('direct_insert_inventory_batches', 'DENIED', SQLERRM);
  end;

  -- direct insert into a table with RLS switched off
  begin
    insert into fin.rpc_idempotency (key, invoice_id) values ('qa-priv-probe', 'x');
    insert into qa_res values ('direct_insert_rpc_idempotency', 'ALLOWED',
      'client INSERT reached a non-RLS table directly');
  exception when others then
    insert into qa_res values ('direct_insert_rpc_idempotency', 'DENIED', SQLERRM);
  end;

  -- and through the guarded write RPC
  begin
    perform * from public.post_inventory_transfer(
      'qa-e2e-item-01', 'qa-e2e-wh-01', 'qa-e2e-wh-02', 1, null, null, null, 'qa-priv-rpc');
    insert into qa_res values ('rpc_write_transfer', 'REACHED', 'write RPC executed');
  exception when others then
    insert into qa_res values ('rpc_write_transfer', 'DENIED', SQLERRM);
  end;
end $$;

reset role;

\echo ''
\echo '=== what the cloud client can do (simulated PostgREST session) ==='
select name, status, detail from qa_res order by name;

rollback;

\echo '=== rolled back ==='
