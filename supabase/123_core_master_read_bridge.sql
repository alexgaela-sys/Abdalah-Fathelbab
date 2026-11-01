-- 123_core_master_read_bridge.sql
-- Read-only bridge from the client to the EXISTING normalized ERP schema
-- (core.items / core.units / core.customers / core.suppliers / core.warehouses).
--
-- Why a bridge instead of broad grants:
--   * core.* is reachable through PostgREST only when the caller is authenticated
--     AND has a core.app_profiles row (RLS on public.current_erp_role()); anon is
--     rejected with 42501,
--   * this function gives the POC screens a stable, explicitly allowlisted
--     projection (chosen columns, unified shape) and NEVER widens access — it adds
--     no grants on core.*, and no INSERT/UPDATE/DELETE path anywhere,
--   * it is a convenience projection, not a security boundary: RLS on the core
--     tables remains the real gate for direct queries.
--
-- TEST only. Idempotent. Rollback: supabase/rollback/123_core_master_read_bridge_down.sql

begin;

create or replace function public.erp_core_master_read(p_entity text)
returns table (
  id         text,
  code       text,
  name_ar    text,
  active     boolean,
  payload    jsonb,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = core, public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not exists (select 1 from public.erp_doc_test_writers w where w.user_id = v_uid) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if p_entity = 'items' then
    return query
      select i.id::text, i.code, i.name_ar, i.active,
             to_jsonb(i) - 'id' - 'code' - 'name_ar' - 'active' - 'created_at' - 'updated_at',
             i.updated_at
        from core.items i
       order by i.code;
  elsif p_entity = 'units' then
    return query
      select u.id::text, u.code, u.name_ar, true,
             to_jsonb(u) - 'id' - 'code' - 'name_ar' - 'created_at',
             null::timestamptz
        from core.units u
       order by u.code;
  elsif p_entity = 'customers' then
    return query
      select c.id::text, c.code, c.name_ar, c.active,
             to_jsonb(c) - 'id' - 'code' - 'name_ar' - 'active' - 'created_at' - 'updated_at',
             c.updated_at
        from core.customers c
       order by c.code;
  elsif p_entity = 'suppliers' then
    return query
      select s.id::text, s.code, s.name_ar, s.active,
             to_jsonb(s) - 'id' - 'code' - 'name_ar' - 'active' - 'created_at' - 'updated_at',
             s.updated_at
        from core.suppliers s
       order by s.code;
  elsif p_entity = 'warehouses' then
    return query
      select w.id::text, w.code, w.name_ar, w.active,
             to_jsonb(w) - 'id' - 'code' - 'name_ar' - 'active' - 'created_at' - 'updated_at',
             w.updated_at
        from core.warehouses w
       order by w.code;
  else
    raise exception 'invalid_entity' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.erp_core_master_read(text) from public, anon;
grant execute on function public.erp_core_master_read(text) to authenticated;

commit;
