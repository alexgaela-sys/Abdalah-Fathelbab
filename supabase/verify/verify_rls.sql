-- =====================================================================
-- supabase/verify/verify_rls.sql
--
-- READ-ONLY. Paste into the Supabase SQL Editor on snakdip-shared-test.
-- Nothing here writes: only catalog SELECTs and privilege checks.
-- =====================================================================

-- 1) one row per ERP table: is RLS on, and which policies exist? --------
select n.nspname                                        as schema,
       c.relname                                        as table_name,
       c.relrowsecurity                                 as rls_enabled,
       c.relforcerowsecurity                            as rls_forced,
       -- p.polcmd is "char"; casting is required or PG17 reports
       -- "operator is not unique: text || \"char\"".
       coalesce(string_agg(p.polname || ':' || p.polcmd::text, ', ' order by p.polname), '(none)') as policies
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_policy p on p.polrelid = c.oid
 where c.relkind = 'r'
   and n.nspname in ('core','sales','purchasing','inventory','production','quality','treasury','fin','audit')
 group by n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
 order by n.nspname, c.relname;

-- 2) policy definitions (expression text, so nothing is assumed) --------
select schemaname, tablename, policyname,
       cmd        as command,
       roles,
       qual       as using_expression,
       with_check as with_check_expression
  from pg_policies
 where schemaname in ('core','sales','purchasing','inventory','production','quality','treasury','fin','audit')
 order by schemaname, tablename, policyname;

-- 3) anon must have NO privilege on any ERP table ------------------------
select n.nspname || '.' || c.relname as table_name,
       has_table_privilege('anon', c.oid, 'SELECT') as anon_can_select,
       has_table_privilege('anon', c.oid, 'INSERT') as anon_can_insert,
       has_table_privilege('anon', c.oid, 'UPDATE') as anon_can_update,
       has_table_privilege('anon', c.oid, 'DELETE') as anon_can_delete
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where c.relkind = 'r'
   and n.nspname in ('core','sales','purchasing','inventory','production','quality','treasury','fin','audit')
   and (has_table_privilege('anon', c.oid, 'SELECT')
        or has_table_privilege('anon', c.oid, 'INSERT')
        or has_table_privilege('anon', c.oid, 'UPDATE')
        or has_table_privilege('anon', c.oid, 'DELETE'))
 order by 1;
-- Expect ZERO rows. Any row here is an anon data leak.

-- 4) authenticated must be read-only: SELECT yes, writes no --------------
select n.nspname || '.' || c.relname as table_name,
       has_table_privilege('authenticated', c.oid, 'SELECT') as can_select,
       has_table_privilege('authenticated', c.oid, 'INSERT') as can_insert,
       has_table_privilege('authenticated', c.oid, 'UPDATE') as can_update,
       has_table_privilege('authenticated', c.oid, 'DELETE') as can_delete
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where c.relkind = 'r'
   and n.nspname in ('core','sales','purchasing','inventory','production','quality','treasury','fin','audit')
   and (has_table_privilege('authenticated', c.oid, 'INSERT')
        or has_table_privilege('authenticated', c.oid, 'UPDATE')
        or has_table_privilege('authenticated', c.oid, 'DELETE'))
 order by 1;
-- Expect ZERO rows once 150_rls_and_grants.sql is applied.

-- 5) the permission resolver is callable and returns the matrix ----------
select proname, prosecdef as security_definer
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'core' and p.proname in ('user_can','current_profile','current_role','role_matrix')
 order by 1;

-- 6) sanity: the role matrix holds 13 roles; report their module counts ---
select r.key                        as role,
       count(m.module)              as modules,
       count(*) filter (where m.actions ? 'post') as modules_that_can_post
  from jsonb_each(core.role_matrix()) r
  cross join lateral jsonb_each(r.value) as m(module, actions)
 group by r.key
 order by 1;
