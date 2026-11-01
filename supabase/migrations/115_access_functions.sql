-- =====================================================================
-- 115_access_functions.sql — part 2b: the permission resolver used by RLS
--
-- Split out of 100 because these functions read core.app_profiles, which
-- 110 creates (a SQL/plpgsql function body is resolved at creation time).
-- =====================================================================

-- The signed-in user's ERP profile, or no row. SECURITY DEFINER so the
-- profile is readable without granting SELECT on the table itself.
create or replace function core.current_profile()
returns core.app_profiles
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select p.*
    from core.app_profiles p
   where p.supabase_auth_id = auth.uid()::text
     and p.active = true
   limit 1;
$$;

-- core.user_can(module, action)
--   * signed out / inactive / unknown profile -> false;
--   * Super Admin -> true (never overridable, matching F23 in permissions.ts);
--   * an explicit per-user override for that module REPLACES the role row;
--   * otherwise the role matrix (core.role_matrix) governs.
create or replace function core.user_can(p_module text, p_action text)
returns boolean
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
declare
  v_role text;
  v_active boolean;
  v_permissions jsonb;
begin
  if p_module is null or p_action is null then
    return false;
  end if;

  select p.role, p.active, coalesce(p.permissions, '{}'::jsonb)
    into v_role, v_active, v_permissions
    from core.app_profiles p
   where p.supabase_auth_id = auth.uid()::text
   limit 1;

  if v_role is null or v_active is not true then
    return false;
  end if;

  if v_role = 'Super Admin' then
    return true;
  end if;

  if v_permissions ? p_module then
    return coalesce((v_permissions -> p_module) ? p_action, false);
  end if;

  return coalesce((core.role_matrix() -> v_role -> p_module) ? p_action, false);
end;
$$;

-- core.current_role(): the ERP role name, or NULL when not signed in.
-- Mirrors public.current_erp_role() that the cloud UI already calls.
create or replace function core.current_role()
returns text
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select p.role from core.app_profiles p
   where p.supabase_auth_id = auth.uid()::text and p.active = true
   limit 1;
$$;

revoke all on function core.current_profile() from public, anon;
revoke all on function core.user_can(text, text) from public, anon;
revoke all on function core.current_role() from public, anon;
grant execute on function core.current_profile() to authenticated;
grant execute on function core.user_can(text, text) to authenticated;
grant execute on function core.current_role() to authenticated;
