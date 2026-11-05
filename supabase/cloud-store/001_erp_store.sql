-- 001_erp_store.sql
-- ---------------------------------------------------------------------------
-- SnakDip ERP — cloud record store.
--
-- The app keeps its normal in-memory database and all of its accounting logic.
-- This file only gives it a place to persist, shared by many devices:
--
--   erp_records   one row per ERP record  (collection + id, version, jsonb data)
--   erp_changes   append-only change feed (devices poll it to stay in sync)
--   erp_members   who may use the store   (Supabase Auth users you approve)
--
-- Writes go ONLY through public.erp_apply_changes():
--   * all-or-nothing: one transaction per user action,
--   * optimistic concurrency: every record carries a version; a write built on
--     a stale version is refused (so two devices can never silently overwrite
--     each other, or sell the same stock twice from a stale screen),
--   * document numbers (SINV-2026-00007 ...) cannot be issued twice,
--   * writers are serialised, so the change feed is strictly ordered.
--
-- Idempotent: safe to run more than once. Rollback: 002_erp_store_down.sql
-- Run it in: Supabase Dashboard -> SQL Editor.
-- ---------------------------------------------------------------------------

begin;

-- 1) Members -----------------------------------------------------------------
create table if not exists public.erp_members (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  note      text,
  added_at  timestamptz not null default now()
);

alter table public.erp_members enable row level security;

-- 1b) Roles + approval -----------------------------------------------------------
-- Permissions are decided INSIDE the database, from the caller's Auth identity
-- (auth.uid()) and the row erp_members holds for it. Nothing the browser sends
-- can change the answer, so hiding a screen is never part of the security.
--
-- TWO independent gates, both required before anything at all is readable or
-- writable:
--
--   status = 'approved'   an operator approved this member, AND
--   role   is not null    an operator assigned a role.
--
-- A row that has neither is inert: erp_role() answers NULL, so erp_can() is
-- false for every collection, every SELECT policy filters the row away, and
-- every RPC returns 'forbidden'. Creating a member row therefore grants
-- NOTHING by itself — approval and a role must be set deliberately.
--
-- role has NO default and is nullable on purpose. It is never 'admin' unless an
-- operator writes that value.
alter table public.erp_members
  add column if not exists role text;

alter table public.erp_members
  alter column role drop default;
alter table public.erp_members
  alter column role drop not null;

alter table public.erp_members
  drop constraint if exists erp_members_role_chk;
alter table public.erp_members
  add constraint erp_members_role_chk
    check (role is null or role in ('admin', 'staff', 'accountant', 'warehouse'));

-- Approval state. Added inside a DO block so the one-time backfill below runs
-- exactly once: members that existed BEFORE this rule already had access, so
-- approving them preserves today's behaviour, while re-running this file must
-- NOT re-approve a member an operator has since put back to 'pending'.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'erp_members'
       and column_name  = 'status'
  ) then
    alter table public.erp_members add column status text not null default 'pending';
    -- One-time backfill: these accounts could already use the store.
    update public.erp_members set status = 'approved', role = coalesce(role, 'admin');
  end if;
end $$;

alter table public.erp_members
  drop constraint if exists erp_members_status_chk;
alter table public.erp_members
  add constraint erp_members_status_chk
    check (status in ('pending', 'approved'));

-- The gate every read and write path uses. An approved member WITHOUT a role,
-- or a member WITH a role who is not approved, is treated exactly like a
-- stranger.
create or replace function public.erp_is_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.erp_members m
     where m.user_id = (select auth.uid())
       and m.status = 'approved'
       and m.role is not null
  );
$$;

-- 1c) Nobody promotes themselves ---------------------------------------------------
-- Defence in depth on top of the revoked INSERT/UPDATE/DELETE privileges: even
-- if a grant were ever added by mistake, a client session (PostgREST connects
-- as 'anon' / 'authenticated') still cannot insert, promote, demote or delete a
-- membership row. Membership is operator-only, edited from the SQL editor
-- (role 'postgres'), which is what this check allows through.
--
-- Deliberately SECURITY INVOKER (the default): a definer function would run as
-- its owner and current_user would always read 'postgres', defeating the check.
create or replace function public.erp_members_block_client_writes()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'erp_members is operator-managed: clients cannot change membership or roles'
      using errcode = '42501',
            hint    = 'approve the member and assign a role from the SQL editor';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists erp_members_no_client_write on public.erp_members;
create trigger erp_members_no_client_write
  before insert or update or delete on public.erp_members
  for each row execute function public.erp_members_block_client_writes();

-- Which collections a role may read/write. Kept as DATA, not as SQL branches:
-- changing an access boundary is one insert/delete, and 'admin' is simply the
-- role seeded with the '*' wildcard (no privileged code path).
--
-- NOTE: this is an ACCESS boundary only. It does not express accounting truth,
-- and assigning a non-admin role is an operator decision.
create table if not exists public.erp_role_scope (
  role       text not null,
  collection text not null,
  primary key (role, collection)
);

-- Re-runnable: refresh the constraints so a database created by an earlier
-- version picks up the '*' wildcard without manual work.
alter table public.erp_role_scope drop constraint if exists erp_role_scope_role_chk;
alter table public.erp_role_scope add constraint erp_role_scope_role_chk
  check (role in ('admin', 'staff', 'accountant', 'warehouse'));
alter table public.erp_role_scope drop constraint if exists erp_role_scope_coll_chk;
alter table public.erp_role_scope add constraint erp_role_scope_coll_chk
  check (collection = '*' or collection ~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$');

alter table public.erp_role_scope enable row level security;
revoke all on table public.erp_role_scope from anon, authenticated;
grant select on table public.erp_role_scope to authenticated;
drop policy if exists erp_role_scope_read on public.erp_role_scope;
create policy erp_role_scope_read on public.erp_role_scope
  for select to authenticated using (public.erp_is_member());

-- Seed the access boundary.
--   admin       -> '*', i.e. every collection the store holds (still NOT 'users')
--   accountant  -> the financial side, plus the shared invoice documents
--   warehouse   -> stock and movement documents, plus the shared invoices
--
-- '*' keeps today's behaviour for an admin: any collection a future app version
-- adds is readable without a migration, while a narrower role only ever sees
-- what it was explicitly given.
insert into public.erp_role_scope (role, collection) values
  ('admin', '*'),
  ('staff', '*'),

  ('accountant', '__singletons'),
  ('accountant', 'accounts'),
  ('accountant', 'journalEntries'),
  ('accountant', 'accountingPeriods'),
  ('accountant', 'payments'),
  ('accountant', 'paymentAllocations'),
  ('accountant', 'cheques'),
  ('accountant', 'bankAccounts'),
  ('accountant', 'bankTransactions'),
  ('accountant', 'treasuryTransactions'),
  ('accountant', 'expenses'),
  ('accountant', 'costCenters'),
  ('accountant', 'standardCostRates'),
  ('accountant', 'forecasts'),
  ('accountant', 'payrollDistributions'),
  ('accountant', 'withholdingAdjustments'),
  ('accountant', 'auditLogs'),
  ('accountant', 'salesInvoices'),
  ('accountant', 'salesInvoiceLines'),
  ('accountant', 'salesReturns'),
  ('accountant', 'salesReturnLines'),
  ('accountant', 'purchaseInvoices'),
  ('accountant', 'accountMappings'),

  ('warehouse', '__singletons'),
  ('warehouse', 'custodyMovements'),
  ('warehouse', 'inventoryTransactions'),
  ('warehouse', 'inventoryCounts'),
  ('warehouse', 'inventoryCountLines'),
  ('warehouse', 'purchaseInvoiceLines'),
  ('warehouse', 'purchaseReturns'),
  ('warehouse', 'exportShipments'),
  ('warehouse', 'scrapSales'),
  ('warehouse', 'salesInvoices'),
  ('warehouse', 'salesInvoiceLines'),
  ('warehouse', 'salesReturns'),
  ('warehouse', 'salesReturnLines'),
  ('warehouse', 'purchaseInvoices')
on conflict (role, collection) do nothing;

-- The caller's role, read from the trusted row keyed by their Auth identity.
-- Returns NULL for anyone who is not an active member (not approved, or no
-- role assigned) — NULL matches no row in erp_role_scope, so erp_can() is false.
create or replace function public.erp_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.role from public.erp_members m
   where m.user_id = (select auth.uid())
     and m.status = 'approved'
     and m.role is not null;
$$;

-- Collections the store must NEVER serve, to ANY role.
-- 'users' carries the local login records with passwords in plaintext; no
-- database role may read or write them (the client refuses to upload them too).
create table if not exists public.erp_blocked_collection (
  collection text primary key
);
alter table public.erp_blocked_collection enable row level security;
revoke all on table public.erp_blocked_collection from anon, authenticated;
grant select on table public.erp_blocked_collection to authenticated;
drop policy if exists erp_blocked_collection_read on public.erp_blocked_collection;
create policy erp_blocked_collection_read on public.erp_blocked_collection
  for select to authenticated using (public.erp_is_member());
-- 'users' used to be listed here. It is now stored (WITHOUT passwords: sign-in is
-- Supabase Auth) so every device knows who the ERP users are and what they may do.
-- Writes to it are admin-only and a password field is refused (see erp_apply_changes).
delete from public.erp_blocked_collection where collection = 'users';

-- May this caller touch p_collection? Answered only from the two tables above,
-- both read through the caller's own Auth identity — never from anything the
-- client sends. Read and write use the same boundary on purpose.
create or replace function public.erp_can(p_collection text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p_collection is not null
    and not exists (
      select 1 from public.erp_blocked_collection b where b.collection = p_collection
    )
    and exists (
      select 1
        from public.erp_role_scope s
       where s.role = (select public.erp_role())
         and (s.collection = '*' or s.collection = p_collection)
    );
$$;

-- 2) Records + change feed -----------------------------------------------------
create table if not exists public.erp_records (
  collection  text        not null,
  id          text        not null,
  version     bigint      not null default 1 check (version >= 1),
  data        jsonb       not null,
  -- insertion order: the app's lists (invoices, journal entries, ...) keep the
  -- order records were created in; every device rebuilds them in this order.
  ord         bigint      generated always as identity,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  primary key (collection, id),
  constraint erp_records_collection_fmt check (collection ~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$'),
  constraint erp_records_id_len check (length(id) between 1 and 200)
);

create table if not exists public.erp_changes (
  seq         bigint generated always as identity primary key,
  collection  text        not null,
  id          text        not null,
  op          text        not null check (op in ('upsert', 'delete')),
  version     bigint      not null,
  client_id   text,
  created_at  timestamptz not null default now()
);

create index if not exists erp_changes_key_idx on public.erp_changes (collection, id);
create unique index if not exists erp_records_ord_idx on public.erp_records (collection, ord);

-- 3) Row Level Security ----------------------------------------------------------
alter table public.erp_records enable row level security;
alter table public.erp_changes enable row level security;

drop policy if exists erp_members_self_select on public.erp_members;
create policy erp_members_self_select on public.erp_members
  for select to authenticated using (user_id = (select auth.uid()));

-- Reads are scoped by role: erp_can() answers from erp_role_scope using the
-- caller's own Auth identity, so a warehouse login cannot read journalEntries
-- and an accountant cannot read inventory movements — no matter how the client
-- is built (PostgREST direct access is filtered here too).
drop policy if exists erp_records_member_select on public.erp_records;
create policy erp_records_member_select on public.erp_records
  for select to authenticated using (public.erp_can(collection));

drop policy if exists erp_changes_member_select on public.erp_changes;
create policy erp_changes_member_select on public.erp_changes
  for select to authenticated using (public.erp_can(collection));

-- No insert/update/delete policies on purpose: the only write path is the RPC.
revoke all on table public.erp_members from anon, authenticated;
revoke all on table public.erp_records from anon, authenticated;
revoke all on table public.erp_changes from anon, authenticated;
grant select on table public.erp_members to authenticated;
grant select on table public.erp_records to authenticated;
grant select on table public.erp_changes to authenticated;

-- 4) Writes ----------------------------------------------------------------------
-- p_changes: [{ "collection": "salesInvoices", "id": "inv-...", "op": "upsert"|"delete",
--               "base_version": 0 for a new record, else the version the client last saw,
--               "data": {...} }]
-- Returns { status: 'ok', head, versions:[{collection,id,version}] }
--      or { status: 'conflict', conflicts:[{collection,id,reason,current_version}] }
--      or { status: 'forbidden' | 'invalid', reason }
-- p_bulk = true is for the one-time import: inserts only, document-number
-- uniqueness is not re-checked (the data is already numbered).
create or replace function public.erp_apply_changes(
  p_changes   jsonb,
  p_client_id text    default null,
  p_bulk      boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_item      jsonb;
  v_coll      text;
  v_id        text;
  v_op        text;
  v_base      bigint;
  v_data      jsonb;
  v_cur       bigint;
  v_found     boolean;
  v_field     text;
  v_numval    text;
  v_key       text;
  v_new       bigint;
  v_head      bigint;
  v_conflicts jsonb := '[]'::jsonb;
  v_versions  jsonb := '[]'::jsonb;
  v_seen_keys text[] := '{}';
  v_seen_nums text[] := '{}';
  -- document-number field per collection (same fields the app numbers with)
  v_numfields constant jsonb := jsonb_build_object(
    'salesInvoices',          'invoiceNumber',
    'purchaseInvoices',       'invoiceNumber',
    'salesReturns',           'returnNumber',
    'purchaseReturns',        'returnNumber',
    'payments',               'paymentNumber',
    'treasuryTransactions',   'receiptNumber',
    'bankTransactions',       'transactionNumber',
    'expenses',               'expenseNumber',
    'representativeCustodies','custodyNumber',
    'inventoryCounts',        'countNumber',
    'exportShipments',        'shipmentNumber',
    'withholdingAdjustments', 'adjustmentNumber',
    'scrapSales',             'docNumber',
    'payrollDistributions',   'distributionNumber',
    'productionOrders',       'orderNumber'
  );
begin
  if v_uid is null or not public.erp_is_member() then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if p_bulk and public.erp_role() is distinct from 'admin' then
    return jsonb_build_object('status', 'forbidden', 'reason', 'bulk_requires_admin');
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    return jsonb_build_object('status', 'invalid', 'reason', 'changes_must_be_array');
  end if;

  if jsonb_array_length(p_changes) = 0 then
    return jsonb_build_object(
      'status', 'ok', 'versions', '[]'::jsonb,
      'head', (select coalesce(max(seq), 0) from public.erp_changes)
    );
  end if;

  if jsonb_array_length(p_changes) > 2000 then
    return jsonb_build_object('status', 'invalid', 'reason', 'too_many_changes');
  end if;

  -- One writer at a time: makes conflict checks race-free and keeps the change
  -- feed order identical to commit order (no device can miss a change).
  perform pg_advisory_xact_lock(7311201);

  -- Phase 1: validate everything and collect every conflict (nothing written yet).
  for v_item in select * from jsonb_array_elements(p_changes) loop
    v_coll := v_item ->> 'collection';
    v_id   := v_item ->> 'id';
    v_op   := v_item ->> 'op';
    v_data := v_item -> 'data';

    if v_coll is null or v_coll !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$'
       or v_id is null or length(v_id) not between 1 and 200
       or v_op is null or v_op not in ('upsert', 'delete')
       or (v_item ->> 'base_version') is null
       or (v_item ->> 'base_version') !~ '^[0-9]{1,15}$' then
      return jsonb_build_object('status', 'invalid', 'reason', 'bad_change_shape');
    end if;
    v_base := (v_item ->> 'base_version')::bigint;

    -- Role gate on writes: scoped exactly like reads, answered from
    -- erp_role_scope via the caller's Auth identity. 'users' belongs to no
    -- role's scope, so nobody can push login records (or any collection
    -- outside their role) into the store.
    if not public.erp_can(v_coll) then
      return jsonb_build_object(
        'status', 'forbidden', 'reason', 'collection_not_permitted',
        'collection', v_coll);
    end if;

    if v_op = 'upsert' and (v_data is null or jsonb_typeof(v_data) <> 'object') then
      return jsonb_build_object('status', 'invalid', 'reason', 'data_must_be_object');
    end if;

    -- ERP user records decide who may do what inside the app, so only an admin may
    -- change them (nobody can promote themselves), and a password may never be stored.
    if v_coll = 'users' then
      if public.erp_role() is distinct from 'admin' then
        return jsonb_build_object(
          'status', 'forbidden', 'reason', 'users_admin_only', 'collection', v_coll);
      end if;
      if v_op = 'upsert' and v_data ? 'password' then
        return jsonb_build_object('status', 'invalid', 'reason', 'password_not_allowed');
      end if;
    end if;
    if v_op = 'upsert' and octet_length(v_data::text) > 10485760 then
      return jsonb_build_object('status', 'invalid', 'reason', 'record_too_large');
    end if;
    if p_bulk and (v_op <> 'upsert' or v_base <> 0) then
      return jsonb_build_object('status', 'invalid', 'reason', 'bulk_allows_inserts_only');
    end if;

    v_key := v_coll || E'\u0001' || v_id;
    if v_key = any (v_seen_keys) then
      return jsonb_build_object('status', 'invalid', 'reason', 'duplicate_key_in_batch');
    end if;
    v_seen_keys := v_seen_keys || v_key;

    select r.version into v_cur
      from public.erp_records r
     where r.collection = v_coll and r.id = v_id;
    v_found := found;

    if v_op = 'upsert' then
      if v_base = 0 and v_found then
        v_conflicts := v_conflicts || jsonb_build_object(
          'collection', v_coll, 'id', v_id, 'reason', 'exists', 'current_version', v_cur);
      elsif v_base > 0 and not v_found then
        v_conflicts := v_conflicts || jsonb_build_object(
          'collection', v_coll, 'id', v_id, 'reason', 'deleted');
      elsif v_base > 0 and v_cur <> v_base then
        v_conflicts := v_conflicts || jsonb_build_object(
          'collection', v_coll, 'id', v_id, 'reason', 'stale', 'current_version', v_cur);
      elsif not p_bulk and v_numfields ? v_coll then
        v_field  := v_numfields ->> v_coll;
        v_numval := v_data ->> v_field;
        if v_numval is not null and v_numval <> '' then
          if exists (
               select 1 from public.erp_records r
                where r.collection = v_coll and r.data ->> v_field = v_numval and r.id <> v_id
             ) or (v_coll || E'\u0001' || v_numval) = any (v_seen_nums) then
            v_conflicts := v_conflicts || jsonb_build_object(
              'collection', v_coll, 'id', v_id, 'reason', 'duplicate_number', 'number', v_numval);
          else
            v_seen_nums := v_seen_nums || (v_coll || E'\u0001' || v_numval);
          end if;
        end if;
      end if;
    else -- delete
      if v_found and v_cur <> v_base then
        v_conflicts := v_conflicts || jsonb_build_object(
          'collection', v_coll, 'id', v_id, 'reason', 'stale', 'current_version', v_cur);
      end if;
    end if;
  end loop;

  if jsonb_array_length(v_conflicts) > 0 then
    return jsonb_build_object('status', 'conflict', 'conflicts', v_conflicts);
  end if;

  -- Phase 2: apply (still inside the same transaction).
  for v_item in select * from jsonb_array_elements(p_changes) loop
    v_coll := v_item ->> 'collection';
    v_id   := v_item ->> 'id';
    v_op   := v_item ->> 'op';
    v_base := (v_item ->> 'base_version')::bigint;
    v_data := v_item -> 'data';

    if v_op = 'upsert' then
      insert into public.erp_records as r (collection, id, version, data, updated_by)
      values (v_coll, v_id, 1, v_data, v_uid)
      on conflict (collection, id) do update
        set data = excluded.data,
            version = r.version + 1,
            updated_at = now(),
            updated_by = v_uid
      returning r.version into v_new;

      insert into public.erp_changes (collection, id, op, version, client_id)
      values (v_coll, v_id, 'upsert', v_new, p_client_id);

      v_versions := v_versions || jsonb_build_object(
        'collection', v_coll, 'id', v_id, 'version', v_new);
    else
      v_new := null;
      delete from public.erp_records r
       where r.collection = v_coll and r.id = v_id
      returning r.version into v_new;

      if v_new is not null then
        insert into public.erp_changes (collection, id, op, version, client_id)
        values (v_coll, v_id, 'delete', v_new + 1, p_client_id);
      end if;
    end if;
  end loop;

  select coalesce(max(seq), 0) into v_head from public.erp_changes;
  return jsonb_build_object('status', 'ok', 'head', v_head, 'versions', v_versions);
end;
$$;

-- 5) Reads -------------------------------------------------------------------------
-- Current change-feed position. A device records it BEFORE loading the records,
-- then replays everything after it, so nothing slips between the two steps.
create or replace function public.erp_head_seq()
returns bigint
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.erp_is_member() then
    return null;
  end if;
  return (select coalesce(max(seq), 0) from public.erp_changes);
end;
$$;

-- Keyset-paged full load, in insertion order:
--   { status, rows:[{collection,id,version,ord,data}], done, next:{collection,ord} }
create or replace function public.erp_load_page(
  p_after_collection text   default '',
  p_after_ord        bigint default 0,
  p_limit            int    default 1000
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows jsonb;
  v_n    int;
  v_lim  int := greatest(1, least(coalesce(p_limit, 1000), 5000));
begin
  if not public.erp_is_member() then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'collection', t.collection, 'id', t.id, 'version', t.version,
           'ord', t.ord, 'data', t.data
         ) order by t.collection, t.ord), '[]'::jsonb),
         count(*)
    into v_rows, v_n
    from (
      select r.collection, r.id, r.version, r.ord, r.data
        from public.erp_records r
       where public.erp_can(r.collection)
         and (r.collection, r.ord) > (coalesce(p_after_collection, ''), coalesce(p_after_ord, 0))
       order by r.collection, r.ord
       limit v_lim
    ) t;

  if v_n = 0 then
    return jsonb_build_object('status', 'ok', 'rows', '[]'::jsonb, 'done', true);
  end if;

  return jsonb_build_object(
    'status', 'ok', 'rows', v_rows, 'done', v_n < v_lim,
    'next', jsonb_build_object(
      'collection', (v_rows -> (v_n - 1)) ->> 'collection',
      'ord', ((v_rows -> (v_n - 1)) ->> 'ord')::bigint)
  );
end;
$$;

-- Everything that changed after p_after, with the CURRENT state of each record.
-- status 'reset' means the device is too far behind (or the store was reset) and
-- must reload everything.
create or replace function public.erp_changes_since(
  p_after bigint,
  p_limit int default 500
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_head bigint;
  v_min  bigint;
  v_lim  int := greatest(1, least(coalesce(p_limit, 500), 2000));
  v_rows jsonb;
  v_last bigint;
begin
  if not public.erp_is_member() then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select coalesce(max(seq), 0), min(seq) into v_head, v_min from public.erp_changes;
  p_after := coalesce(p_after, 0);

  if p_after > v_head or (v_min is not null and p_after > 0 and p_after < v_min - 1) then
    return jsonb_build_object('status', 'reset', 'head', v_head);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'seq', c.seq, 'collection', c.collection, 'id', c.id,
           'op', case when c.op = 'delete' or r.id is null then 'delete' else 'upsert' end,
           'version', coalesce(r.version, c.version),
           'ord', r.ord,
           'data', r.data
         ) order by c.seq), '[]'::jsonb),
         max(c.seq)
    into v_rows, v_last
    from (
      select * from public.erp_changes
       where seq > p_after and public.erp_can(collection)
       order by seq limit v_lim
    ) c
    left join public.erp_records r on r.collection = c.collection and r.id = c.id;

  -- 'more' must look only at changes THIS role may see; otherwise a role that
  -- cannot see the newest changes would be told there is more forever while the
  -- cursor never advances. When nothing visible remains, the cursor jumps to head.
  if exists (
       select 1 from public.erp_changes c2
        where c2.seq > coalesce(v_last, p_after) and public.erp_can(c2.collection)
     ) then
    return jsonb_build_object(
      'status', 'ok', 'head', v_head, 'changes', v_rows,
      'last', coalesce(v_last, p_after), 'more', true);
  end if;
  return jsonb_build_object(
    'status', 'ok', 'head', v_head, 'changes', v_rows,
    'last', greatest(coalesce(v_last, p_after), v_head), 'more', false);
end;
$$;

-- Row counts per collection (used to verify an import).
create or replace function public.erp_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.erp_is_member() then
    return jsonb_build_object('status', 'forbidden');
  end if;
  return jsonb_build_object(
    'status', 'ok',
    'role', public.erp_role(),
    'counts', coalesce((
      select jsonb_object_agg(s.collection, s.n)
        from (
          select collection, count(*) as n
            from public.erp_records
           where public.erp_can(collection)
           group by collection
        ) s
    ), '{}'::jsonb),
    'head', (select coalesce(max(seq), 0) from public.erp_changes)
  );
end;
$$;

-- 6) Function permissions ----------------------------------------------------------
revoke all on function public.erp_is_member() from public, anon;
revoke all on function public.erp_role() from public, anon;
revoke all on function public.erp_can(text) from public, anon;
revoke all on function public.erp_apply_changes(jsonb, text, boolean) from public, anon;
revoke all on function public.erp_head_seq() from public, anon;
revoke all on function public.erp_load_page(text, bigint, int) from public, anon;
revoke all on function public.erp_changes_since(bigint, int) from public, anon;
revoke all on function public.erp_stats() from public, anon;

grant execute on function public.erp_is_member() to authenticated;
grant execute on function public.erp_role() to authenticated;
grant execute on function public.erp_can(text) to authenticated;
grant execute on function public.erp_apply_changes(jsonb, text, boolean) to authenticated;
grant execute on function public.erp_head_seq() to authenticated;
grant execute on function public.erp_load_page(text, bigint, int) to authenticated;
grant execute on function public.erp_changes_since(bigint, int) to authenticated;
grant execute on function public.erp_stats() to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- After running this file (once), APPROVE the people who may use the system.
-- Creating a login is not enough: a member is inert until both gates are set.
--
--   1. Create their login: Dashboard -> Authentication -> Users -> Add user
--      (and turn OFF "Allow new users to sign up" under Authentication settings).
--   2. Approve them AND give them a role, in the SQL editor:
--
--        update public.erp_members
--           set status = 'approved', role = 'warehouse'
--         where user_id = '<their auth.users id>';
--
--      Values: role  = 'admin' | 'accountant' | 'warehouse'   (no default)
--             status = 'pending' | 'approved'                  (default 'pending')
--
--      Until BOTH are set the login authenticates but reads and writes nothing:
--      every RPC answers 'forbidden' and direct PostgREST SELECTs return empty.
--
-- Members created by an earlier version of this file keep the access they had
-- (status backfilled to 'approved', role backfilled to 'admin'). Restrict them:
--
--        update public.erp_members set status = 'pending'            -- lock out
--        update public.erp_members set role = 'accountant'           -- narrow
--
-- Membership is operator-only: a client session cannot insert, update or delete
-- erp_members rows, so nobody can approve themselves or change their own role.
--
-- Optional housekeeping (service role / SQL editor only, never exposed to the app):
--   delete from public.erp_changes where created_at < now() - interval '60 days';
--   -- devices that were offline longer than that simply reload everything.
-- ---------------------------------------------------------------------------
