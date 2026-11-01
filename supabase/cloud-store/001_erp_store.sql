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

create or replace function public.erp_is_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.erp_members m where m.user_id = (select auth.uid())
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

drop policy if exists erp_records_member_select on public.erp_records;
create policy erp_records_member_select on public.erp_records
  for select to authenticated using (public.erp_is_member());

drop policy if exists erp_changes_member_select on public.erp_changes;
create policy erp_changes_member_select on public.erp_changes
  for select to authenticated using (public.erp_is_member());

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
    'payrollDistributions',   'distributionNumber'
  );
begin
  if v_uid is null or not public.erp_is_member() then
    return jsonb_build_object('status', 'forbidden');
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

    if v_op = 'upsert' and (v_data is null or jsonb_typeof(v_data) <> 'object') then
      return jsonb_build_object('status', 'invalid', 'reason', 'data_must_be_object');
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
      elsif v_base = 0 and not p_bulk and v_numfields ? v_coll then
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
       where (r.collection, r.ord) > (coalesce(p_after_collection, ''), coalesce(p_after_ord, 0))
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
      select * from public.erp_changes where seq > p_after order by seq limit v_lim
    ) c
    left join public.erp_records r on r.collection = c.collection and r.id = c.id;

  return jsonb_build_object(
    'status', 'ok', 'head', v_head, 'changes', v_rows,
    'last', coalesce(v_last, p_after),
    'more', coalesce(v_last, p_after) < v_head
  );
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
    'counts', coalesce((
      select jsonb_object_agg(s.collection, s.n)
        from (select collection, count(*) as n from public.erp_records group by collection) s
    ), '{}'::jsonb),
    'head', (select coalesce(max(seq), 0) from public.erp_changes)
  );
end;
$$;

-- 6) Function permissions ----------------------------------------------------------
revoke all on function public.erp_is_member() from public, anon;
revoke all on function public.erp_apply_changes(jsonb, text, boolean) from public, anon;
revoke all on function public.erp_head_seq() from public, anon;
revoke all on function public.erp_load_page(text, bigint, int) from public, anon;
revoke all on function public.erp_changes_since(bigint, int) from public, anon;
revoke all on function public.erp_stats() from public, anon;

grant execute on function public.erp_is_member() to authenticated;
grant execute on function public.erp_apply_changes(jsonb, text, boolean) to authenticated;
grant execute on function public.erp_head_seq() to authenticated;
grant execute on function public.erp_load_page(text, bigint, int) to authenticated;
grant execute on function public.erp_changes_since(bigint, int) to authenticated;
grant execute on function public.erp_stats() to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- After running this file (once), approve the people who may use the system.
-- Create their logins first: Dashboard -> Authentication -> Users -> Add user
-- (and turn OFF "Allow new users to sign up" under Authentication settings).
-- Then, in the SQL editor:
--
--   insert into public.erp_members (user_id, note)
--   select id, email from auth.users
--   on conflict (user_id) do nothing;
--
-- Optional housekeeping (service role / SQL editor only, never exposed to the app):
--   delete from public.erp_changes where created_at < now() - interval '60 days';
--   -- devices that were offline longer than that simply reload everything.
-- ---------------------------------------------------------------------------
