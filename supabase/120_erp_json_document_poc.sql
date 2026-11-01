-- 120_erp_json_document_poc.sql
-- TEST-ONLY proof of concept: store ONE synthetic ERP JSON document in Supabase
-- with server-side compare-and-swap (optimistic concurrency).
--
-- Scope guards baked in:
--   * only the literal scope 'snakdip-test-poc' is accepted,
--   * no production data, no localStorage data, no ERP business logic,
--   * writes are possible ONLY through public.erp_doc_cas (SECURITY DEFINER),
--     which checks auth.uid() against public.erp_doc_test_writers,
--   * direct INSERT/UPDATE/DELETE on the documents table is revoked from
--     anon/authenticated; only SELECT is granted (RLS-filtered).
--
-- Idempotent: safe to re-run. Does not touch any pre-existing object.
-- Rollback: supabase/rollback/120_erp_json_document_poc_down.sql

begin;

create table if not exists public.erp_json_documents (
  id          uuid primary key default gen_random_uuid(),
  scope       text not null,
  doc_key     text not null,
  version     bigint not null check (version >= 1),
  payload     jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  constraint erp_json_documents_scope_key_uq unique (scope, doc_key),
  constraint erp_json_documents_test_scope_only check (scope = 'snakdip-test-poc'),
  constraint erp_json_documents_key_len check (length(doc_key) between 1 and 64),
  constraint erp_json_documents_payload_size check (octet_length(payload::text) <= 262144)
);

-- Administrative allowlist. No client-facing write policy exists on this table,
-- so an authenticated user cannot add themselves: only the table owner
-- (project admin via TEST_DATABASE_URL / SQL editor) can insert here.
create table if not exists public.erp_doc_test_writers (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  note      text,
  added_at  timestamptz not null default now()
);

alter table public.erp_json_documents enable row level security;
alter table public.erp_doc_test_writers enable row level security;

-- Read: only allowlisted authenticated users, only the test scope.
drop policy if exists erp_json_documents_poc_select on public.erp_json_documents;
create policy erp_json_documents_poc_select
  on public.erp_json_documents
  for select
  to authenticated
  using (
    scope = 'snakdip-test-poc'
    and exists (
      select 1 from public.erp_doc_test_writers w where w.user_id = (select auth.uid())
    )
  );

-- No insert/update/delete policies on purpose: writes go through the RPC only.

-- Allowlist table: no policies at all (owner-only). A user may read only their
-- own allowlist row; they can never insert/update/delete.
drop policy if exists erp_doc_test_writers_self_select on public.erp_doc_test_writers;
create policy erp_doc_test_writers_self_select
  on public.erp_doc_test_writers
  for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.erp_json_documents from anon, authenticated;
grant select on table public.erp_json_documents to authenticated;

revoke all on table public.erp_doc_test_writers from anon, authenticated;
grant select on table public.erp_doc_test_writers to authenticated;

-- Atomic compare-and-swap.
--   * first create only succeeds with p_expected_version = 0 (no row);
--   * update only succeeds when the stored version equals p_expected_version;
--   * version is incremented by the server; the client value is never trusted;
--   * concurrent callers with the same expected version: exactly one wins.
create or replace function public.erp_doc_cas(
  p_scope text,
  p_doc_key text,
  p_expected_version bigint,
  p_payload jsonb
)
returns table (status text, version bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_version bigint;
begin
  if p_scope is distinct from 'snakdip-test-poc' then
    return query select 'invalid_scope'::text, null::bigint;
    return;
  end if;

  if p_doc_key is null or length(p_doc_key) < 1 or length(p_doc_key) > 64 then
    return query select 'invalid_key'::text, null::bigint;
    return;
  end if;

  if p_payload is null then
    return query select 'invalid_payload'::text, null::bigint;
    return;
  end if;

  if octet_length(p_payload::text) > 262144 then
    return query select 'payload_too_large'::text, null::bigint;
    return;
  end if;

  if p_expected_version is null or p_expected_version < 0 then
    return query select 'invalid_expected_version'::text, null::bigint;
    return;
  end if;

  if v_uid is null then
    return query select 'not_authenticated'::text, null::bigint;
    return;
  end if;

  if not exists (
    select 1 from public.erp_doc_test_writers w where w.user_id = v_uid
  ) then
    return query select 'not_authorized'::text, null::bigint;
    return;
  end if;

  -- Single atomic statement: the row lock plus the version predicate guarantee
  -- that only one of several concurrent callers can update a given version.
  update public.erp_json_documents d
     set payload    = p_payload,
         version    = d.version + 1,
         updated_at = now(),
         updated_by = v_uid
   where d.scope   = p_scope
     and d.doc_key = p_doc_key
     and d.version = p_expected_version
  returning d.version into v_version;

  if v_version is not null then
    return query select 'updated'::text, v_version;
    return;
  end if;

  -- Nothing updated: either the document does not exist yet, or the version
  -- is stale. Creation is allowed only when the caller expects version 0.
  if p_expected_version = 0 then
    begin
      insert into public.erp_json_documents as d (scope, doc_key, version, payload, updated_by)
      values (p_scope, p_doc_key, 1, p_payload, v_uid)
      returning d.version into v_version;

      return query select 'created'::text, v_version;
      return;
    exception when unique_violation then
      -- Lost the create race: somebody else already created the document.
      return query
        select 'conflict'::text,
               (select d.version from public.erp_json_documents d
                 where d.scope = p_scope and d.doc_key = p_doc_key);
      return;
    end;
  end if;

  return query
    select 'conflict'::text,
           (select d.version from public.erp_json_documents d
             where d.scope = p_scope and d.doc_key = p_doc_key);
end;
$$;

revoke all on function public.erp_doc_cas(text, text, bigint, jsonb) from public, anon;
grant execute on function public.erp_doc_cas(text, text, bigint, jsonb) to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- Administrative allowlist grant (run manually, NOT part of the transaction
-- above so that it is a conscious, auditable action):
--
--   insert into public.erp_doc_test_writers (user_id, note)
--   select id, 'qa cloud test account'
--     from auth.users
--    where email_confirmed_at is not null
--    order by created_at
--    limit 1
--   on conflict (user_id) do nothing;
-- ---------------------------------------------------------------------------
