-- Self-test for 001_erp_store.sql (runs on a throwaway local PostgreSQL).
-- Every check raises on failure; the final line prints ALL PASSED.
\set ON_ERROR_STOP on

create schema if not exists t;
create or replace function t.check(p_name text, p_ok boolean) returns void
language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAILED: %', p_name; end if;
  raise notice 'ok  - %', p_name;
end $$;
grant usage on schema t to authenticated, anon;
grant execute on function t.check(text, boolean) to authenticated, anon;

-- users: u1 = member, u2 = signed-in but NOT a member
insert into auth.users values
  ('11111111-1111-1111-1111-111111111111', 'member@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'outsider@example.test');
insert into public.erp_members (user_id, note, status, role) values ('11111111-1111-1111-1111-111111111111', 'test member', 'approved', 'admin');

-- ============ outsider (authenticated, not approved) ============
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

select t.check('outsider: apply is forbidden',
  (public.erp_apply_changes('[{"collection":"items","id":"a","op":"upsert","base_version":0,"data":{"x":1}}]'::jsonb, 'dev-x') ->> 'status') = 'forbidden');
select t.check('outsider: load_page is forbidden', (public.erp_load_page('', 0, 10) ->> 'status') = 'forbidden');
select t.check('outsider: changes_since is forbidden', (public.erp_changes_since(0, 10) ->> 'status') = 'forbidden');
select t.check('outsider: stats is forbidden', (public.erp_stats() ->> 'status') = 'forbidden');
select t.check('outsider: head_seq is null', public.erp_head_seq() is null);
select t.check('outsider: cannot read records directly', (select count(*) from public.erp_records) = 0);

-- ============ anonymous ============
reset role;
set role anon;
do $$ begin
  begin
    perform public.erp_head_seq();
    raise exception 'anon was able to execute erp_head_seq';
  exception when insufficient_privilege then
    raise notice 'ok  - anon cannot execute the RPCs';
  end;
end $$;
reset role;

-- ============ member ============
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

-- direct writes are impossible even for a member
do $$ begin
  begin
    insert into public.erp_records (collection, id, data) values ('items', 'direct', '{}'::jsonb);
    raise exception 'direct insert succeeded';
  exception when insufficient_privilege then
    raise notice 'ok  - direct INSERT is refused (RPC is the only write path)';
  end;
end $$;

-- insert two records
select t.check('insert two records -> ok, head 2',
  (select r ->> 'status' = 'ok' and (r ->> 'head')::int = 2 and jsonb_array_length(r -> 'versions') = 2
     from (select public.erp_apply_changes(
       '[{"collection":"items","id":"i1","op":"upsert","base_version":0,"data":{"name":"A","qty":1}},
         {"collection":"items","id":"i2","op":"upsert","base_version":0,"data":{"name":"B","qty":2}}]'::jsonb,
       'dev-1') r) s));

select t.check('new records have version 1',
  (select bool_and(version = 1) from public.erp_records where collection = 'items'));

-- update with the right base version
select t.check('update with correct base -> version 2',
  (select r ->> 'status' = 'ok' and (r -> 'versions' -> 0 ->> 'version')::int = 2
     from (select public.erp_apply_changes(
       '[{"collection":"items","id":"i1","op":"upsert","base_version":1,"data":{"name":"A","qty":5}}]'::jsonb, 'dev-1') r) s));

-- stale update is refused AND atomic: the valid change in the same batch is not applied
select t.check('stale update -> conflict (stale)',
  (select r ->> 'status' = 'conflict' and r -> 'conflicts' -> 0 ->> 'reason' = 'stale'
     from (select public.erp_apply_changes(
       '[{"collection":"items","id":"i2","op":"upsert","base_version":1,"data":{"name":"B","qty":99}},
         {"collection":"items","id":"i1","op":"upsert","base_version":1,"data":{"name":"A","qty":77}}]'::jsonb, 'dev-2') r) s));
select t.check('conflict is all-or-nothing (i2 untouched)',
  (select data ->> 'qty' = '2' and version = 1 from public.erp_records where collection = 'items' and id = 'i2'));
select t.check('conflict is all-or-nothing (i1 untouched)',
  (select data ->> 'qty' = '5' and version = 2 from public.erp_records where collection = 'items' and id = 'i1'));

-- insert over an existing id
select t.check('insert existing id -> conflict (exists)',
  (select r -> 'conflicts' -> 0 ->> 'reason' = 'exists'
     from (select public.erp_apply_changes(
       '[{"collection":"items","id":"i1","op":"upsert","base_version":0,"data":{"name":"dup"}}]'::jsonb) r) s));

-- update of a record that does not exist
select t.check('update missing id -> conflict (deleted)',
  (select r -> 'conflicts' -> 0 ->> 'reason' = 'deleted'
     from (select public.erp_apply_changes(
       '[{"collection":"items","id":"ghost","op":"upsert","base_version":3,"data":{"name":"g"}}]'::jsonb) r) s));

-- deletes
select t.check('stale delete -> conflict',
  (select r ->> 'status' = 'conflict'
     from (select public.erp_apply_changes('[{"collection":"items","id":"i2","op":"delete","base_version":9}]'::jsonb) r) s));
select t.check('delete with right version -> ok',
  (select r ->> 'status' = 'ok' from (select public.erp_apply_changes(
     '[{"collection":"items","id":"i2","op":"delete","base_version":1}]'::jsonb, 'dev-1') r) s));
select t.check('...and the row is gone',
  not exists (select 1 from public.erp_records where collection = 'items' and id = 'i2'));
select t.check('deleting an already-deleted record is a harmless no-op',
  (select r ->> 'status' = 'ok' from (select public.erp_apply_changes(
     '[{"collection":"items","id":"i2","op":"delete","base_version":1}]'::jsonb, 'dev-1') r) s));
select t.check('no-op delete wrote no extra change row',
  (select count(*) from public.erp_changes where collection = 'items' and id = 'i2' and op = 'delete') = 1);

-- document numbers
select t.check('first SINV number accepted',
  (select r ->> 'status' = 'ok' from (select public.erp_apply_changes(
     '[{"collection":"salesInvoices","id":"inv-a","op":"upsert","base_version":0,"data":{"invoiceNumber":"SINV-2026-00001","total":10}}]'::jsonb) r) s));
select t.check('same SINV number from another device -> duplicate_number',
  (select r -> 'conflicts' -> 0 ->> 'reason' = 'duplicate_number'
     from (select public.erp_apply_changes(
       '[{"collection":"salesInvoices","id":"inv-b","op":"upsert","base_version":0,"data":{"invoiceNumber":"SINV-2026-00001","total":20}}]'::jsonb) r) s));
select t.check('duplicate numbers inside one batch -> conflict',
  (select r ->> 'status' = 'conflict' from (select public.erp_apply_changes(
     '[{"collection":"salesInvoices","id":"inv-c","op":"upsert","base_version":0,"data":{"invoiceNumber":"SINV-2026-00002"}},
       {"collection":"salesInvoices","id":"inv-d","op":"upsert","base_version":0,"data":{"invoiceNumber":"SINV-2026-00002"}}]'::jsonb) r) s));
select t.check('editing an existing invoice keeps its own number (no false duplicate)',
  (select r ->> 'status' = 'ok' from (select public.erp_apply_changes(
     '[{"collection":"salesInvoices","id":"inv-a","op":"upsert","base_version":1,"data":{"invoiceNumber":"SINV-2026-00001","total":11}}]'::jsonb) r) s));
select t.check('same number in a DIFFERENT collection is fine',
  (select r ->> 'status' = 'ok' from (select public.erp_apply_changes(
     '[{"collection":"purchaseInvoices","id":"p-a","op":"upsert","base_version":0,"data":{"invoiceNumber":"SINV-2026-00001"}}]'::jsonb) r) s));

-- invalid input
select t.check('bad shape -> invalid',
  (public.erp_apply_changes('[{"collection":"items","op":"upsert","base_version":0,"data":{}}]'::jsonb) ->> 'status') = 'invalid');
select t.check('non-array -> invalid',
  (public.erp_apply_changes('{"a":1}'::jsonb) ->> 'status') = 'invalid');
select t.check('same key twice in a batch -> invalid',
  (public.erp_apply_changes('[{"collection":"items","id":"z","op":"upsert","base_version":0,"data":{}},{"collection":"items","id":"z","op":"upsert","base_version":0,"data":{}}]'::jsonb) ->> 'status') = 'invalid');
select t.check('empty batch -> ok',
  (public.erp_apply_changes('[]'::jsonb) ->> 'status') = 'ok');

-- bulk import: inserts only, numbering not re-checked
select t.check('bulk insert accepts legacy duplicate numbers',
  (select r ->> 'status' = 'ok' from (select public.erp_apply_changes(
     '[{"collection":"payments","id":"pay-1","op":"upsert","base_version":0,"data":{"paymentNumber":"RCPT-2026-00001"}},
       {"collection":"payments","id":"pay-2","op":"upsert","base_version":0,"data":{"paymentNumber":"RCPT-2026-00001"}}]'::jsonb, 'import', true) r) s));
select t.check('bulk refuses updates',
  (public.erp_apply_changes('[{"collection":"items","id":"i1","op":"upsert","base_version":2,"data":{}}]'::jsonb, 'import', true) ->> 'status') = 'invalid');

-- change feed
select t.check('changes_since(0) lists every change in order',
  (select (r ->> 'status') = 'ok'
      and (select bool_and(s.seq = lag_seq + 1) from (
             select (c ->> 'seq')::bigint as seq, lag((c ->> 'seq')::bigint) over (order by (c ->> 'seq')::bigint) as lag_seq
               from jsonb_array_elements(r -> 'changes') c) s where lag_seq is not null)
     from (select public.erp_changes_since(0, 500) r) s));
select t.check('feed shows the CURRENT data of i1 (qty 5, version 2)',
  (select (c ->> 'version')::int = 2 and c -> 'data' ->> 'qty' = '5'
     from jsonb_array_elements(public.erp_changes_since(0, 500) -> 'changes') c
    where c ->> 'id' = 'i1' order by (c ->> 'seq')::bigint desc limit 1));
select t.check('feed reports i2 as a delete',
  (select c ->> 'op' = 'delete'
     from jsonb_array_elements(public.erp_changes_since(0, 500) -> 'changes') c
    where c ->> 'id' = 'i2' order by (c ->> 'seq')::bigint desc limit 1));
select t.check('paging: limit 3 -> more = true, last = 3',
  (select (r ->> 'more')::boolean and (r ->> 'last')::int = 3 and jsonb_array_length(r -> 'changes') = 3
     from (select public.erp_changes_since(0, 3) r) s));
select t.check('caught-up device gets nothing new',
  (select jsonb_array_length(r -> 'changes') = 0 and not (r ->> 'more')::boolean
     from (select public.erp_changes_since((public.erp_head_seq()), 500) r) s));
select t.check('cursor ahead of head -> reset',
  (public.erp_changes_since(public.erp_head_seq() + 100, 10) ->> 'status') = 'reset');

-- full load paging
select t.check('load_page pages through every record exactly once',
  (with recursive pg(rows, nxt, done, n) as (
      select r -> 'rows', r -> 'next', (r ->> 'done')::boolean, 1
        from (select public.erp_load_page('', 0, 2) r) s
      union all
      select r -> 'rows', r -> 'next', (r ->> 'done')::boolean, pg.n + 1
        from pg, lateral (select public.erp_load_page(pg.nxt ->> 'collection', (pg.nxt ->> 'ord')::bigint, 2) r) s
       where not pg.done and pg.n < 50
   ),
   flat as (select (e ->> 'collection') || '/' || (e ->> 'id') as k from pg, jsonb_array_elements(pg.rows) e)
   select (select count(*) from flat) = (select count(*) from public.erp_records)
      and (select count(distinct k) from flat) = (select count(*) from public.erp_records)));

-- insertion order survives a reload even when ids sort differently
select public.erp_apply_changes('[{"collection":"orderTest","id":"z-first","op":"upsert","base_version":0,"data":{"n":1}},
                                  {"collection":"orderTest","id":"m-second","op":"upsert","base_version":0,"data":{"n":2}},
                                  {"collection":"orderTest","id":"a-third","op":"upsert","base_version":0,"data":{"n":3}}]'::jsonb);
select public.erp_apply_changes('[{"collection":"orderTest","id":"z-first","op":"upsert","base_version":1,"data":{"n":10}}]'::jsonb);
select t.check('insertion order is kept (z-first, m-second, a-third) and survives an update',
  (select string_agg(e ->> 'id', ',' order by ordinality)
     from jsonb_array_elements(public.erp_load_page('orderTest', 0, 10) -> 'rows') with ordinality as x(e, ordinality)
    where e ->> 'collection' = 'orderTest') = 'z-first,m-second,a-third');

select t.check('stats count per collection',
  (select (public.erp_stats() -> 'counts' ->> 'salesInvoices')::int = 1
      and (public.erp_stats() -> 'counts' ->> 'items')::int = 1));

-- retention: a device whose cursor was pruned must reload
reset role;
delete from public.erp_changes where seq <= 5;
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select t.check('pruned history -> reset for a device that is too far behind',
  (public.erp_changes_since(1, 10) ->> 'status') = 'reset');
select t.check('pruned history -> a device at the boundary still works',
  (public.erp_changes_since(5, 10) ->> 'status') = 'ok');

-- ============ roles + blocked collections ============
-- Permissions must come from the caller's own Auth identity and the role the
-- database holds for it, and a login record must be unreadable by everybody.
reset role;
insert into auth.users values
  ('33333333-3333-3333-3333-333333333333', 'accountant@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'warehouse@example.test');
insert into public.erp_members (user_id, note, status, role) values
  ('33333333-3333-3333-3333-333333333333', 'accountant', 'approved', 'accountant'),
  ('44444444-4444-4444-4444-444444444444', 'warehouse', 'approved', 'warehouse');

-- staff: ordinary employee, full data scope, but cannot touch ERP user records
insert into auth.users values ('66666666-6666-6666-6666-666666666666', 'staff@example.test');
insert into public.erp_members (user_id, note, status, role) values
  ('66666666-6666-6666-6666-666666666666', 'staff', 'approved', 'staff');

-- ---------- admin (u1, default role) ----------
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

select t.check('admin default role is admin', public.erp_role() = 'admin');
select t.check('admin can still write a normal collection',
  (public.erp_apply_changes(
     '[{"collection":"items","id":"role-ok","op":"upsert","base_version":0,"data":{"x":1}}]'::jsonb,
     'dev-1') ->> 'status') = 'ok');
select t.check('admin CAN write an ERP user record (no password)',
  (public.erp_apply_changes(
     '[{"collection":"users","id":"usr-1","op":"upsert","base_version":0,"data":{"username":"sara","role":"Accountant","active":true}}]'::jsonb,
     'dev-1') ->> 'status') = 'ok');
select t.check('a password can never be stored on a user record',
  (public.erp_apply_changes(
     '[{"collection":"users","id":"usr-pw","op":"upsert","base_version":0,"data":{"username":"x","password":"S3cret"}}]'::jsonb,
     'dev-1') ->> 'reason') = 'password_not_allowed');
select t.check('admin sees the users collection in stats and load_page',
  (public.erp_stats() -> 'counts' ->> 'users')::int = 1
  and (select count(*) from jsonb_array_elements(public.erp_load_page('', 0, 5000) -> 'rows') e
        where e ->> 'collection' = 'users') = 1);

-- ---------- staff (u6) ----------
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '66666666-6666-6666-6666-666666666666', false);
select t.check('staff role is read from erp_members', public.erp_role() = 'staff');
select t.check('staff CAN write normal collections of every module',
  (public.erp_apply_changes(
     '[{"collection":"journalEntries","id":"je-staff","op":"upsert","base_version":0,"data":{"x":1}},
       {"collection":"inventoryTransactions","id":"it-staff","op":"upsert","base_version":0,"data":{"x":1}}]'::jsonb,
     'dev-s') ->> 'status') = 'ok');
select t.check('staff CAN read the user list',
  (select count(*) from public.erp_records where collection = 'users') = 1);
select t.check('staff CANNOT change ERP users (no self-promotion)',
  (public.erp_apply_changes(
     '[{"collection":"users","id":"usr-1","op":"upsert","base_version":1,"data":{"username":"sara","role":"Super Admin","active":true}}]'::jsonb,
     'dev-s') ->> 'reason') = 'users_admin_only');
select t.check('staff CANNOT use the bulk import path',
  (public.erp_apply_changes(
     '[{"collection":"items","id":"it-bulk-s","op":"upsert","base_version":0,"data":{"x":1}}]'::jsonb,
     'dev-s', true) ->> 'reason') = 'bulk_requires_admin');

-- ---------- accountant (u3) ----------
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

select t.check('accountant role is read from erp_members', public.erp_role() = 'accountant');
select t.check('accountant CAN write a financial collection',
  (public.erp_apply_changes(
     '[{"collection":"journalEntries","id":"je-acc","op":"upsert","base_version":0,"data":{"x":1}}]'::jsonb,
     'dev-a') ->> 'status') = 'ok');
select t.check('accountant CANNOT write a warehouse collection',
  (public.erp_apply_changes(
     '[{"collection":"inventoryTransactions","id":"it-block","op":"upsert","base_version":0,"data":{"x":1}}]'::jsonb,
     'dev-a') ->> 'reason') = 'collection_not_permitted');
select t.check('accountant cannot see warehouse rows (RLS on SELECT)',
  (select count(*) from public.erp_records where collection = 'inventoryTransactions') = 0);
select t.check('accountant cannot see users (RLS on SELECT)',
  (select count(*) from public.erp_records where collection = 'users') = 0);
select t.check('accountant load_page hides warehouse + users',
  (select count(*) from jsonb_array_elements(public.erp_load_page('', 0, 5000) -> 'rows') e
    where e ->> 'collection' in ('inventoryTransactions', 'users')) = 0);
select t.check('accountant changes_since hides warehouse changes',
  (select count(*) from jsonb_array_elements(public.erp_changes_since(0, 2000) -> 'changes') e
    where e ->> 'collection' = 'inventoryTransactions') = 0);
select t.check('accountant stats has no warehouse or users counts',
  (public.erp_stats() -> 'counts' -> 'inventoryTransactions') is null
  and (public.erp_stats() -> 'counts' -> 'users') is null);

-- ---------- warehouse (u4) ----------
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);

select t.check('warehouse role is read from erp_members', public.erp_role() = 'warehouse');
select t.check('warehouse CAN write a stock collection',
  (public.erp_apply_changes(
     '[{"collection":"inventoryTransactions","id":"it-wh","op":"upsert","base_version":0,"data":{"x":1}}]'::jsonb,
     'dev-w') ->> 'status') = 'ok');
select t.check('warehouse CANNOT write a financial collection',
  (public.erp_apply_changes(
     '[{"collection":"journalEntries","id":"je-block","op":"upsert","base_version":0,"data":{"x":1}}]'::jsonb,
     'dev-w') ->> 'reason') = 'collection_not_permitted');
select t.check('warehouse cannot see financial rows (RLS on SELECT)',
  (select count(*) from public.erp_records where collection = 'journalEntries') = 0);
select t.check('warehouse cannot see users (RLS on SELECT)',
  (select count(*) from public.erp_records where collection = 'users') = 0);

-- ---------- no self-escalation through direct access ----------
do $$ begin
  begin
    insert into public.erp_role_scope (role, collection) values ('warehouse', '*');
    raise exception 'role-scope escalation succeeded';
  exception when insufficient_privilege then
    raise notice 'ok  - a member cannot widen their own role scope';
  end;
end $$;

do $$ begin
  begin
    update public.erp_members set role = 'admin'
     where user_id = '44444444-4444-4444-4444-444444444444';
    raise exception 'role self-elevation succeeded';
  exception when insufficient_privilege then
    raise notice 'ok  - a member cannot change their own role';
  end;
end $$;

do $$ begin
  begin
    insert into public.erp_members (user_id, role)
    values ('55555555-5555-5555-5555-555555555555', 'admin');
    raise exception 'membership self-grant succeeded';
  exception when insufficient_privilege then
    raise notice 'ok  - a member cannot approve themselves';
  end;
end $$;

-- ---------- fixes found in review ----------
-- bulk import is admin-only (warehouse u4 is the current caller)
select t.check('non-admin cannot use the bulk import path',
  (public.erp_apply_changes(
     '[{"collection":"inventoryTransactions","id":"it-bulk","op":"upsert","base_version":0,"data":{"x":1}}]'::jsonb,
     'dev-w', true) ->> 'reason') = 'bulk_requires_admin');

-- feed cursor for a role that cannot see the newest change
select set_config('t.h0', public.erp_head_seq()::text, false);
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select t.check('accountant writes a change the warehouse cannot see',
  (public.erp_apply_changes(
     '[{"collection":"journalEntries","id":"je-hidden","op":"upsert","base_version":0,"data":{"x":1}}]'::jsonb,
     'dev-a') ->> 'status') = 'ok');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);
select t.check('hidden newest change: more=false and cursor reaches head (no endless polling)',
  (public.erp_changes_since(current_setting('t.h0')::bigint, 500) ->> 'more') = 'false'
  and (public.erp_changes_since(current_setting('t.h0')::bigint, 500) ->> 'last')::bigint = public.erp_head_seq()
  and public.erp_head_seq() > current_setting('t.h0')::bigint);

-- document numbers: cannot be reused by EDITING an existing record, nor by production orders
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select t.check('two invoices with different numbers are accepted',
  (public.erp_apply_changes(
     '[{"collection":"salesInvoices","id":"dup-a","op":"upsert","base_version":0,"data":{"invoiceNumber":"DUP-1"}},
       {"collection":"salesInvoices","id":"dup-b","op":"upsert","base_version":0,"data":{"invoiceNumber":"DUP-2"}}]'::jsonb,
     'dev-1') ->> 'status') = 'ok');
select t.check('editing an invoice to a number already in use is refused',
  (public.erp_apply_changes(
     '[{"collection":"salesInvoices","id":"dup-b","op":"upsert","base_version":1,"data":{"invoiceNumber":"DUP-1"}}]'::jsonb,
     'dev-1') -> 'conflicts' -> 0 ->> 'reason') = 'duplicate_number');
select t.check('editing an invoice keeping its own number is fine',
  (public.erp_apply_changes(
     '[{"collection":"salesInvoices","id":"dup-b","op":"upsert","base_version":1,"data":{"invoiceNumber":"DUP-2","note":"x"}}]'::jsonb,
     'dev-1') ->> 'status') = 'ok');
select t.check('production order numbers cannot repeat',
  (public.erp_apply_changes(
     '[{"collection":"productionOrders","id":"po-1","op":"upsert","base_version":0,"data":{"orderNumber":"PRD-1"}}]'::jsonb,
     'dev-1') ->> 'status') = 'ok'
  and (public.erp_apply_changes(
     '[{"collection":"productionOrders","id":"po-2","op":"upsert","base_version":0,"data":{"orderNumber":"PRD-1"}}]'::jsonb,
     'dev-1') -> 'conflicts' -> 0 ->> 'reason') = 'duplicate_number');
select t.check('stats tells the caller their role', (public.erp_stats() ->> 'role') = 'admin');


reset role;
\echo ALL PASSED
