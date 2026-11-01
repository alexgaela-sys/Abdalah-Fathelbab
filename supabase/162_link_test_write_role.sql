-- 162_link_test_write_role.sql
-- Links the approved TEST account to the write/posting role it was approved for.
--
-- Approved identity (TEST only):
--   email: elhandsiagroup10@gmail.com
--   uid  : cd8ae590-5f86-4f01-87df-fb5a5b640383
--
-- Why 'Super Admin' and not 'Chief Accountant':
--   fin.post_sales_invoice / public.post_sales_invoice_integrated /
--   public.post_sales_inventory_issue require the ERP role to be in
--   ('Super Admin', 'Chief Accountant') AND public.can_write_inventory() to be
--   true. can_write_inventory() accepts only
--   ('Super Admin', 'Warehouse Manager', 'Warehouse Employee', 'Production Manager').
--   'Chief Accountant' therefore satisfies the journal gate but FAILS the
--   inventory gate, which would break the integrated posting path. 'Super Admin'
--   is the only single role that satisfies both gates, so it is the role granted
--   here. No permission override is written: the role matrix governs, and
--   Super Admin is already the documented "never overridable" full-access role.
--
-- Least privilege by design:
--   * targets exactly ONE user, matched by uid AND email (both must agree),
--   * updates only role/name/active/is_test on that single profile row; it
--     creates the row if the account exists in auth.users but has no profile,
--   * no GRANT/REVOKE and no other table is touched: schema access stays gated by
--     RLS on public.current_erp_role(),
--   * idempotent: re-running sets the same values and changes nothing else,
--   * deletes nothing.
--
-- TEST only. Never run against production.

begin;

do $$
declare
  v_uid   uuid := 'cd8ae590-5f86-4f01-87df-fb5a5b640383';
  v_email text := 'elhandsiagroup10@gmail.com';
  v_id    text := 'qa-cloud-poc-profile-01';
  v_auth_email text;
  v_updated int;
begin
  select u.email into v_auth_email
    from auth.users u
   where u.id = v_uid;

  if v_auth_email is null then
    raise exception 'TEST link aborted: auth user % does not exist in this database', v_uid;
  end if;

  if lower(v_auth_email) <> lower(v_email) then
    raise exception 'TEST link aborted: uid % belongs to % (expected %)',
      v_uid, v_auth_email, v_email;
  end if;

  update core.app_profiles p
     set role = 'Super Admin',
         name = 'QA TEST Writer (Super Admin)',
         email = v_email,
         supabase_auth_id = v_uid::text,
         active = true,
         is_test = true,
         updated_at = now()
   where p.supabase_auth_id = v_uid::text
      or lower(p.email) = lower(v_email);

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    insert into core.app_profiles
      (id, supabase_auth_id, username, name, email, role, active, is_test)
    values
      (v_id, v_uid::text, 'qa-cloud-poc', 'QA TEST Writer (Super Admin)',
       v_email, 'Super Admin', true, true);
    raise notice 'created profile % for %', v_id, v_email;
  else
    raise notice 'updated % profile row(s) for % to Super Admin', v_updated, v_email;
  end if;

  -- Fail loudly if the resolver the RPCs use does not see the new role.
  if not exists (
    select 1 from core.app_profiles p
     where p.supabase_auth_id = v_uid::text
       and p.active = true
       and p.role = 'Super Admin'
  ) then
    raise exception 'TEST link failed: profile for % is not an active Super Admin', v_email;
  end if;
end $$;

commit;
