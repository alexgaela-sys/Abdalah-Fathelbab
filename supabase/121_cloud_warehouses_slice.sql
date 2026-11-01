-- 121_cloud_warehouses_slice.sql
-- First real cloud slice: warehouses master data (TEST project only).
--
-- Why warehouses is the smallest safe slice:
--   * pure master data (9 scalar fields), no accounting/inventory arithmetic,
--   * read-only for sales/inventory/production flows; deleting is already
--     guarded by CompanySettingsService (historical usage check),
--   * it carries no monetary values, so a cloud/serialisation mistake can never
--     corrupt a balance.
--
-- Boundaries:
--   * writes ONLY through public.erp_warehouse_cas (SECURITY DEFINER, atomic CAS),
--   * direct INSERT/UPDATE/DELETE revoked; SELECT restricted by RLS to
--     authenticated users listed in public.erp_doc_test_writers,
--   * env column pinned to 'test' so production rows can never be written here,
--   * idempotent. Rollback in supabase/rollback/121_cloud_warehouses_slice_down.sql.

begin;

create table if not exists public.erp_warehouses (
  id              text primary key,
  env             text not null default 'test',
  code            text not null,
  name_ar         text not null,
  type            text not null,
  location        text not null default '',
  manager_name    text,
  manager_user_id text,
  disabled_reason text,
  active          boolean not null default true,
  version         bigint not null check (version >= 1),
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  constraint erp_warehouses_env_test_only check (env = 'test'),
  constraint erp_warehouses_code_len check (length(code) between 1 and 20),
  constraint erp_warehouses_code_uq unique (code)
);

alter table public.erp_warehouses enable row level security;

drop policy if exists erp_warehouses_slice_select on public.erp_warehouses;
create policy erp_warehouses_slice_select
  on public.erp_warehouses
  for select
  to authenticated
  using (
    exists (
      select 1 from public.erp_doc_test_writers w where w.user_id = (select auth.uid())
    )
  );

revoke all on table public.erp_warehouses from anon, authenticated;
grant select on table public.erp_warehouses to authenticated;

-- Atomic compare-and-swap upsert.
--   * p_expected_version = 0  -> row must not exist (create once, version starts at 1),
--   * p_expected_version >= 1 -> row must exist with that exact version,
--   * concurrent callers with the same expected version: exactly one wins.
create or replace function public.erp_warehouse_cas(
  p_id text,
  p_code text,
  p_name_ar text,
  p_type text,
  p_location text,
  p_manager_name text,
  p_manager_user_id text,
  p_disabled_reason text,
  p_active boolean,
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

  if p_id is null or length(p_id) < 1 or length(p_id) > 64 then
    return query select 'invalid_id'::text, null::bigint;
    return;
  end if;

  if p_code is null or length(trim(p_code)) < 1 or length(p_code) > 20 then
    return query select 'invalid_code'::text, null::bigint;
    return;
  end if;

  if p_name_ar is null or length(trim(p_name_ar)) < 1 or length(p_name_ar) > 120 then
    return query select 'invalid_name'::text, null::bigint;
    return;
  end if;

  if p_type is null or length(trim(p_type)) < 1 or length(p_type) > 40 then
    return query select 'invalid_type'::text, null::bigint;
    return;
  end if;

  if p_expected_version is null or p_expected_version < 0 then
    return query select 'invalid_expected_version'::text, null::bigint;
    return;
  end if;

  update public.erp_warehouses w
     set code            = p_code,
         name_ar         = p_name_ar,
         type            = p_type,
         location        = coalesce(p_location, ''),
         manager_name    = p_manager_name,
         manager_user_id = p_manager_user_id,
         disabled_reason = p_disabled_reason,
         active          = coalesce(p_active, true),
         version         = w.version + 1,
         updated_at      = now(),
         updated_by      = v_uid
   where w.id = p_id
     and w.version = p_expected_version
  returning w.version into v_version;

  if v_version is not null then
    return query select 'updated'::text, v_version;
    return;
  end if;

  if p_expected_version = 0 then
    begin
      insert into public.erp_warehouses as w
        (id, env, code, name_ar, type, location, manager_name, manager_user_id,
         disabled_reason, active, version, updated_by)
      values
        (p_id, 'test', p_code, p_name_ar, p_type, coalesce(p_location, ''),
         p_manager_name, p_manager_user_id, p_disabled_reason, coalesce(p_active, true), 1, v_uid)
      returning w.version into v_version;

      return query select 'created'::text, v_version;
      return;
    exception when unique_violation then
      return query
        select 'conflict'::text, (select w.version from public.erp_warehouses w where w.id = p_id);
      return;
    end;
  end if;

  return query
    select 'conflict'::text, (select w.version from public.erp_warehouses w where w.id = p_id);
end;
$$;

revoke all on function public.erp_warehouse_cas(
  text, text, text, text, text, text, text, text, boolean, bigint
) from public, anon;
grant execute on function public.erp_warehouse_cas(
  text, text, text, text, text, text, text, text, boolean, bigint
) to authenticated;

commit;
