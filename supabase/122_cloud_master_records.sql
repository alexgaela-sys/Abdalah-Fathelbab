-- 122_cloud_master_records.sql
-- Cloud master-data layer (TEST only) for items / units / customers / suppliers.
--
-- Design notes:
--   * one table keyed by (entity, id) keeps the slice small and auditable while
--     still giving per-row atomic CAS,
--   * domain-specific fields that the local model carries beyond code/name/active
--     live in `payload` jsonb — no accounting or inventory arithmetic is derived
--     from these rows yet, so the cloud copy stays a mirror, not a second truth,
--   * writes ONLY through public.erp_master_cas (SECURITY DEFINER + allowlist),
--   * direct INSERT/UPDATE/DELETE revoked; SELECT gated by RLS,
--   * env pinned to 'test' so production can never be written here,
--   * idempotent. Rollback: supabase/rollback/122_cloud_master_records_down.sql

begin;

create table if not exists public.erp_master_records (
  entity     text not null,
  id         text not null,
  env        text not null default 'test',
  code       text not null,
  name_ar    text not null,
  active     boolean not null default true,
  payload    jsonb not null default '{}'::jsonb,
  version    bigint not null check (version >= 1),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint erp_master_records_pkey primary key (entity, id),
  constraint erp_master_records_entity_allowed
    check (entity in ('items', 'units', 'customers', 'suppliers')),
  constraint erp_master_records_env_test_only check (env = 'test'),
  constraint erp_master_records_code_len check (length(code) between 1 and 40),
  constraint erp_master_records_name_len check (length(name_ar) between 1 and 160),
  constraint erp_master_records_payload_size check (octet_length(payload::text) <= 32768),
  constraint erp_master_records_code_uq unique (entity, code)
);

alter table public.erp_master_records enable row level security;

drop policy if exists erp_master_records_select on public.erp_master_records;
create policy erp_master_records_select
  on public.erp_master_records
  for select
  to authenticated
  using (
    exists (
      select 1 from public.erp_doc_test_writers w where w.user_id = (select auth.uid())
    )
  );

revoke all on table public.erp_master_records from anon, authenticated;
grant select on table public.erp_master_records to authenticated;

-- Atomic compare-and-swap upsert for master records.
--   p_expected_version = 0  -> row must not exist (create once, version 1),
--   p_expected_version >= 1 -> row must exist at that exact version,
--   concurrent callers with the same expected version: exactly one wins.
create or replace function public.erp_master_cas(
  p_entity text,
  p_id text,
  p_code text,
  p_name_ar text,
  p_active boolean,
  p_payload jsonb,
  p_expected_version bigint
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

  if p_entity is null or p_entity not in ('items', 'units', 'customers', 'suppliers') then
    return query select 'invalid_entity'::text, null::bigint;
    return;
  end if;

  if p_id is null or length(p_id) < 1 or length(p_id) > 64 then
    return query select 'invalid_id'::text, null::bigint;
    return;
  end if;

  if p_code is null or length(trim(p_code)) < 1 or length(p_code) > 40 then
    return query select 'invalid_code'::text, null::bigint;
    return;
  end if;

  if p_name_ar is null or length(trim(p_name_ar)) < 1 or length(p_name_ar) > 160 then
    return query select 'invalid_name'::text, null::bigint;
    return;
  end if;

  if p_payload is not null and octet_length(p_payload::text) > 32768 then
    return query select 'payload_too_large'::text, null::bigint;
    return;
  end if;

  if p_expected_version is null or p_expected_version < 0 then
    return query select 'invalid_expected_version'::text, null::bigint;
    return;
  end if;

  update public.erp_master_records m
     set code       = p_code,
         name_ar    = p_name_ar,
         active     = coalesce(p_active, true),
         payload    = coalesce(p_payload, '{}'::jsonb),
         version    = m.version + 1,
         updated_at = now(),
         updated_by = v_uid
   where m.entity = p_entity
     and m.id = p_id
     and m.version = p_expected_version
  returning m.version into v_version;

  if v_version is not null then
    return query select 'updated'::text, v_version;
    return;
  end if;

  if p_expected_version = 0 then
    begin
      insert into public.erp_master_records as m
        (entity, id, env, code, name_ar, active, payload, version, updated_by)
      values
        (p_entity, p_id, 'test', p_code, p_name_ar, coalesce(p_active, true),
         coalesce(p_payload, '{}'::jsonb), 1, v_uid)
      returning m.version into v_version;

      return query select 'created'::text, v_version;
      return;
    exception when unique_violation then
      return query
        select 'conflict'::text,
               (select m.version from public.erp_master_records m
                 where m.entity = p_entity and m.id = p_id);
      return;
    end;
  end if;

  return query
    select 'conflict'::text,
           (select m.version from public.erp_master_records m
             where m.entity = p_entity and m.id = p_id);
end;
$$;

revoke all on function public.erp_master_cas(text, text, text, text, boolean, jsonb, bigint)
  from public, anon;
grant execute on function public.erp_master_cas(text, text, text, text, boolean, jsonb, bigint)
  to authenticated;

commit;
