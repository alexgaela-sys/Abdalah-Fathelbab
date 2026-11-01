-- =====================================================================
-- 166_cloud_reports_users_settings.sql — the last three cloud surfaces
--
-- Adds ONLY what the existing schema cannot answer over PostgREST:
--
--   * public.profit_and_loss            — P&L sections + subtotals, computed
--                                         in SQL from POSTED journal lines,
--   * public.inventory_movement_report   — opening / in / out / closing per
--                                         item+warehouse from the perpetual
--                                         inventory ledger,
--   * public.erp_user_can                — the screen-permission resolver the
--                                         UI needs (core.user_can is not
--                                         exposed to the client),
--   * public.list_app_profiles           — read the user directory without
--                                         granting SELECT on core.app_profiles,
--   * public.set_profile_role /
--     public.set_profile_permissions /
--     public.set_profile_active          — the three mutations of the users
--                                         screen.
--
-- trial_balance (reports) and list_expenses / list_representative_custodies /
-- list_custody_movements already exist; nothing is duplicated here.
--
-- Security model (unchanged from 150 / 115):
--   * anon: no grant at all, and every SECURITY DEFINER body re-checks
--     auth.uid() and core.user_can(...) before touching a row,
--   * core.app_profiles stays CLOSED (no SELECT grant); the directory is
--     projected by list_app_profiles behind core.user_can('users','view'),
--   * writes only through SECURITY DEFINER; the actor can never change their
--     own role/active flag, and the last active Super Admin is protected,
--   * every user mutation writes an audit.app_audit_log row,
--   * reports are SECURITY INVOKER and therefore stay subject to RLS: a role
--     without accounting/inventory read access sees zero rows, not a leak.
--
-- Idempotent: create or replace only. No data is created or deleted, no
-- mapping is invented. TEST only.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) Profit & loss (posted lines only, all subtotals computed here)
-- ---------------------------------------------------------------------
create or replace function public.profit_and_loss(p_from date, p_to date default null)
returns table (
  line_type      text,
  section        text,
  sort_order     integer,
  label_ar       text,
  account_code   text,
  account_name_ar text,
  amount         numeric
)
language sql
stable
set search_path = public, pg_temp
as $$
  with account_totals as (
    select a.id,
           a.code,
           a.name_ar,
           a.category::text as category,
           coalesce(sum(l.debit), 0)  as debit,
           coalesce(sum(l.credit), 0) as credit
      from core.accounts a
      join fin.journal_lines l on l.account_id = a.id
      join fin.journal_entries e on e.id = l.journal_entry_id
     where e.is_posted = true
       and (p_from is null or e.date >= p_from)
       and (p_to is null or e.date <= p_to)
       and a.category::text in ('Revenue', 'COGS', 'Operating Expenses', 'Other Income', 'Other Expenses')
     group by a.id, a.code, a.name_ar, a.category
  ),
  classified as (
    select t.code,
           t.name_ar,
           case t.category
             when 'Revenue'            then 'revenue'
             when 'COGS'               then 'cogs'
             when 'Operating Expenses' then 'expense'
             when 'Other Income'       then 'other_income'
             else 'other_expense'
           end as section,
           case t.category
             when 'Revenue'            then 10
             when 'COGS'               then 20
             when 'Operating Expenses' then 30
             when 'Other Income'       then 40
             else 50
           end as base_order,
           case t.category
             when 'Revenue'            then t.credit - t.debit
             when 'COGS'               then t.debit - t.credit
             when 'Operating Expenses' then t.debit - t.credit
             when 'Other Income'       then t.credit - t.debit
             else t.debit - t.credit
           end as amount
      from account_totals t
  ),
  totals as (
    select coalesce(sum(case when section = 'revenue'       then amount end), 0) as revenue,
           coalesce(sum(case when section = 'cogs'          then amount end), 0) as cogs,
           coalesce(sum(case when section = 'expense'       then amount end), 0) as opex,
           coalesce(sum(case when section = 'other_income'  then amount end), 0) as other_income,
           coalesce(sum(case when section = 'other_expense' then amount end), 0) as other_expense
      from classified
  )
  select 'account'::text,
         c.section,
         (c.base_order * 1000 + row_number() over (partition by c.section order by c.code))::integer,
         c.name_ar,
         c.code,
         c.name_ar,
         c.amount
    from classified c

  union all
  select 'subtotal', 'revenue_total', 1999, 'إجمالي الإيرادات', null::text, null::text, t.revenue
    from totals t
  union all
  select 'subtotal', 'cogs_total', 2999, 'إجمالي تكلفة المبيعات', null::text, null::text, t.cogs
    from totals t
  union all
  select 'subtotal', 'gross_profit', 3990, 'مجمل الربح', null::text, null::text, t.revenue - t.cogs
    from totals t
  union all
  select 'subtotal', 'opex_total', 4999, 'إجمالي المصروفات التشغيلية', null::text, null::text, t.opex
    from totals t
  union all
  select 'subtotal', 'net_profit', 5999, 'صافي الربح', null::text, null::text,
         t.revenue - t.cogs - t.opex + t.other_income - t.other_expense
    from totals t
  order by 3;
$$;

comment on function public.profit_and_loss(date, date) is
  'P&L from POSTED journal lines only. Subtotal rows (revenue_total, cogs_total, gross_profit, opex_total, net_profit) are computed in SQL so the client never aggregates money itself.';

-- ---------------------------------------------------------------------
-- 2) Inventory movement (perpetual ledger, per item + warehouse)
-- ---------------------------------------------------------------------
create or replace function public.inventory_movement_report(p_from date, p_to date default null)
returns table (
  item_id        text,
  item_code      text,
  item_name_ar   text,
  warehouse_id   text,
  warehouse_code text,
  opening_qty    numeric,
  qty_in         numeric,
  qty_out        numeric,
  closing_qty    numeric,
  movement_value numeric
)
language sql
stable
set search_path = public, pg_temp
as $$
  with scoped as (
    select t.item_id,
           t.warehouse_id,
           -- everything before p_from is the opening balance
           case when p_from is not null and t.date < p_from
                then coalesce(t.quantity_in, 0) - coalesce(t.quantity_out, 0)
                else 0 end as opening_delta,
           case when p_from is null or t.date >= p_from then coalesce(t.quantity_in, 0)  else 0 end as in_qty,
           case when p_from is null or t.date >= p_from then coalesce(t.quantity_out, 0) else 0 end as out_qty,
           case when p_from is null or t.date >= p_from
                then coalesce(t.quantity_in, 0)  * coalesce(t.unit_cost, 0)
                   - coalesce(t.quantity_out, 0) * coalesce(t.unit_cost, 0)
                else 0 end as value_delta
      from inventory.transactions t
     where p_to is null or t.date <= p_to
  ),
  agg as (
    select s.item_id,
           s.warehouse_id,
           sum(s.opening_delta)                                        as opening_qty,
           sum(s.in_qty)                                               as qty_in,
           sum(s.out_qty)                                              as qty_out,
           sum(s.opening_delta) + sum(s.in_qty) - sum(s.out_qty)       as closing_qty,
           sum(s.value_delta)                                          as movement_value
      from scoped s
     group by s.item_id, s.warehouse_id
  )
  select a.item_id,
         coalesce(i.code, ''),
         coalesce(i.name_ar, ''),
         a.warehouse_id,
         coalesce(w.code, ''),
         a.opening_qty,
         a.qty_in,
         a.qty_out,
         a.closing_qty,
         a.movement_value
    from agg a
    left join core.items i on i.id = a.item_id
    left join core.warehouses w on w.id = a.warehouse_id
   where a.opening_qty <> 0 or a.qty_in <> 0 or a.qty_out <> 0
   order by i.code nulls last, w.code nulls last;
$$;

comment on function public.inventory_movement_report(date, date) is
  'Opening / in / out / closing per item+warehouse from inventory.transactions (perpetual ledger). Closing value delta uses each movement''s recorded unit_cost.';

-- ---------------------------------------------------------------------
-- 3) Screen permission resolver for the client
--    core.user_can is SECURITY DEFINER over a CLOSED table; expose only the
--    boolean answer, never the profile row.
-- ---------------------------------------------------------------------
create or replace function public.erp_user_can(p_module text, p_action text)
returns boolean
language sql
stable
security definer
set search_path = core, public, pg_temp
as $$
  select coalesce(core.user_can(p_module, p_action), false);
$$;

revoke all on function public.erp_user_can(text, text) from public, anon;
grant execute on function public.erp_user_can(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4) User directory (read)
-- ---------------------------------------------------------------------
create or replace function public.list_app_profiles()
returns table (
  id            text,
  username      text,
  name          text,
  email         text,
  role          text,
  active        boolean,
  is_test       boolean,
  permissions   jsonb,
  warehouse_ids text[],
  last_login    timestamptz,
  updated_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = core, public, pg_temp
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not core.user_can('users', 'view') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  return query
    select p.id,
           p.username,
           p.name,
           p.email,
           p.role,
           coalesce(p.active, false),
           coalesce(p.is_test, false),
           coalesce(p.permissions, '{}'::jsonb),
           p.warehouse_ids,
           p.last_login,
           p.updated_at
      from core.app_profiles p
     order by p.role, p.name nulls last, p.id;
end;
$$;

revoke all on function public.list_app_profiles() from public, anon;
grant execute on function public.list_app_profiles() to authenticated;

-- ---------------------------------------------------------------------
-- 5) User mutations — role / permissions / active
--
-- Shared rules, enforced in every function:
--   * auth.uid() required, core.user_can('users','edit') required,
--   * the actor cannot change their OWN role, permissions or active flag
--     (no self-privilege-escalation, no self-lockout),
--   * the last ACTIVE Super Admin can never be demoted or deactivated,
--   * Super Admin permission overrides are refused (user_can already returns
--     true for that role, so storing an override would be a lie),
--   * every accepted change is audited.
-- ---------------------------------------------------------------------
create or replace function public.set_profile_role(p_profile_id text, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = core, public, pg_temp
as $$
declare
  v_uid          uuid := (select auth.uid());
  v_target       core.app_profiles;
  v_actor        text;
  v_known_roles  text[];
  v_active_supers integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not core.user_can('users', 'edit') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select p.* into v_target from core.app_profiles p where p.id = p_profile_id;
  if v_target.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_target.supabase_auth_id = v_uid::text then
    return jsonb_build_object('status', 'self_change_forbidden');
  end if;

  select array_agg(k) into v_known_roles from jsonb_object_keys(core.role_matrix()) k;
  if p_role is null or not (p_role = any (v_known_roles)) then
    return jsonb_build_object('status', 'invalid_role');
  end if;

  if v_target.role = 'Super Admin' and p_role <> 'Super Admin' then
    select count(*) into v_active_supers
      from core.app_profiles p
     where p.role = 'Super Admin' and coalesce(p.active, false);
    if v_active_supers <= 1 then
      return jsonb_build_object('status', 'last_super_admin');
    end if;
  end if;

  update core.app_profiles p
     set role = p_role,
         updated_at = now()
   where p.id = p_profile_id;

  select coalesce(p.name, p.email, p.id) into v_actor
    from core.app_profiles p where p.supabase_auth_id = v_uid::text;

  insert into audit.app_audit_log
    (id, "timestamp", user_id, user_name, module, action, record_id, record_table,
     previous_value, new_value, description)
  values
    (gen_random_uuid()::text, now(), v_uid::text, coalesce(v_actor, ''), 'users', 'edit',
     p_profile_id, 'core.app_profiles',
     jsonb_build_object('role', v_target.role),
     jsonb_build_object('role', p_role),
     'تغيير دور مستخدم في قاعدة TEST');

  return jsonb_build_object('status', 'updated', 'role', p_role);
end;
$$;

create or replace function public.set_profile_permissions(p_profile_id text, p_permissions jsonb)
returns jsonb
language plpgsql
security definer
set search_path = core, public, pg_temp
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_target    core.app_profiles;
  v_actor     text;
  v_modules   text[];
  v_clean     jsonb;
  v_module    text;
  v_actions   jsonb;
  v_action    text;
  v_allowed   text[] := array['view', 'create', 'edit', 'delete', 'approve', 'post'];
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not core.user_can('users', 'edit') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select p.* into v_target from core.app_profiles p where p.id = p_profile_id;
  if v_target.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_target.supabase_auth_id = v_uid::text then
    return jsonb_build_object('status', 'self_change_forbidden');
  end if;

  if v_target.role = 'Super Admin' then
    return jsonb_build_object('status', 'super_admin_immutable');
  end if;

  if p_permissions is null or jsonb_typeof(p_permissions) <> 'object' then
    return jsonb_build_object('status', 'invalid_permissions');
  end if;

  -- The whitelist is the union of every module in the matrix. Using one role's
  -- row (e.g. Viewer) would wrongly reject a legitimate override on a module
  -- that role does not have, such as users or settings.
  select array_agg(k) into v_modules from jsonb_object_keys(core.role_matrix() -> 'Super Admin') k;

  v_clean := '{}'::jsonb;

  for v_module, v_actions in select key, value from jsonb_each(p_permissions) loop
    if not (v_module = any (v_modules)) then
      return jsonb_build_object('status', 'invalid_permissions', 'module', v_module);
    end if;
    if jsonb_typeof(v_actions) <> 'array' then
      return jsonb_build_object('status', 'invalid_permissions', 'module', v_module);
    end if;

    -- only the six assignable actions, de-duplicated, order stabilised
    v_clean := jsonb_set(
      v_clean,
      array[v_module],
      coalesce((
        select jsonb_agg(a order by a)
          from (select distinct value #>> '{}' as a from jsonb_array_elements(v_actions)) s
         where s.a = any (v_allowed)
      ), '[]'::jsonb),
      true
    );
  end loop;

  update core.app_profiles p
     set permissions = v_clean,
         updated_at = now()
   where p.id = p_profile_id;

  select coalesce(p.name, p.email, p.id) into v_actor
    from core.app_profiles p where p.supabase_auth_id = v_uid::text;

  insert into audit.app_audit_log
    (id, "timestamp", user_id, user_name, module, action, record_id, record_table,
     previous_value, new_value, description)
  values
    (gen_random_uuid()::text, now(), v_uid::text, coalesce(v_actor, ''), 'users', 'edit',
     p_profile_id, 'core.app_profiles',
     jsonb_build_object('permissions', coalesce(v_target.permissions, '{}'::jsonb)),
     jsonb_build_object('permissions', v_clean),
     'تعديل صلاحيات شاشات مستخدم في قاعدة TEST');

  return jsonb_build_object('status', 'updated', 'permissions', v_clean);
end;
$$;

create or replace function public.set_profile_active(p_profile_id text, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = core, public, pg_temp
as $$
declare
  v_uid           uuid := (select auth.uid());
  v_target        core.app_profiles;
  v_actor         text;
  v_active_supers integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not core.user_can('users', 'edit') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select p.* into v_target from core.app_profiles p where p.id = p_profile_id;
  if v_target.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_target.supabase_auth_id = v_uid::text then
    return jsonb_build_object('status', 'self_change_forbidden');
  end if;

  if p_active is null then
    return jsonb_build_object('status', 'invalid_active');
  end if;

  if p_active = false and v_target.role = 'Super Admin' then
    select count(*) into v_active_supers
      from core.app_profiles p
     where p.role = 'Super Admin' and coalesce(p.active, false);
    if v_active_supers <= 1 then
      return jsonb_build_object('status', 'last_super_admin');
    end if;
  end if;

  update core.app_profiles p
     set active = p_active,
         updated_at = now()
   where p.id = p_profile_id;

  select coalesce(p.name, p.email, p.id) into v_actor
    from core.app_profiles p where p.supabase_auth_id = v_uid::text;

  insert into audit.app_audit_log
    (id, "timestamp", user_id, user_name, module, action, record_id, record_table,
     previous_value, new_value, description)
  values
    (gen_random_uuid()::text, now(), v_uid::text, coalesce(v_actor, ''), 'users', 'edit',
     p_profile_id, 'core.app_profiles',
     jsonb_build_object('active', v_target.active),
     jsonb_build_object('active', p_active),
     'تفعيل/تعطيل حساب مستخدم في قاعدة TEST');

  return jsonb_build_object('status', 'updated', 'active', p_active);
end;
$$;

revoke all on function public.set_profile_role(text, text) from public, anon;
revoke all on function public.set_profile_permissions(text, jsonb) from public, anon;
revoke all on function public.set_profile_active(text, boolean) from public, anon;
grant execute on function public.set_profile_role(text, text) to authenticated;
grant execute on function public.set_profile_permissions(text, jsonb) to authenticated;
grant execute on function public.set_profile_active(text, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 6) Settings snapshot (company identity + system settings)
--    One round-trip, gated on the 'settings' module, and the logo blob (which
--    can be hundreds of KB) is replaced by a boolean.
-- ---------------------------------------------------------------------
create or replace function public.get_cloud_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = core, public, pg_temp
as $$
declare
  v_company  jsonb;
  v_settings jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not core.user_can('settings', 'view') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select (to_jsonb(c) - 'logo_data_url')
         || jsonb_build_object('has_logo', (c.logo_data_url is not null and c.logo_data_url <> ''))
    into v_company
    from core.companies c
   order by c.id
   limit 1;

  select to_jsonb(s) into v_settings
    from core.app_settings s
   order by s.id
   limit 1;

  return jsonb_build_object(
    'company', coalesce(v_company, '{}'::jsonb),
    'settings', coalesce(v_settings, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.get_cloud_settings() from public, anon;
grant execute on function public.get_cloud_settings() to authenticated;

-- Reports are read RPCs: authenticated only, RLS still applies inside them.
revoke all on function public.profit_and_loss(date, date) from public, anon;
revoke all on function public.inventory_movement_report(date, date) from public, anon;
grant execute on function public.profit_and_loss(date, date) to authenticated;
grant execute on function public.inventory_movement_report(date, date) to authenticated;

commit;
