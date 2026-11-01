-- 124_link_qa_profile_viewer.sql
-- Links the TEST QA account to core.app_profiles so that public.current_erp_role()
-- resolves for it, WITHOUT widening any privilege.
--
-- Least privilege by design:
--   * role = 'Viewer'  -> passes can_read_module(...) for reading,
--                         fails can_write_master_data() and every write guard,
--   * is_test = true   -> clearly marked test identity,
--   * no GRANT/REVOKE on core.*, sales.*, fin.*, inventory.*, production.* is
--     executed here (and none was needed): those schemas are already exposed
--     through PostgREST and gated by RLS on public.current_erp_role().
--     Verified reality: anon gets 42501, a linked Viewer can read master data,
--     a signed-in user WITHOUT a profile row sees zero rows.
--     public.erp_core_master_read stays as a narrow, explicitly allowlisted
--     projection for the POC screens — it is NOT a security boundary,
--   * targets exactly ONE user: the newest account on the POC writer allowlist,
--   * idempotent and non-destructive: inserts only if missing, deletes nothing.
--
-- TEST only.

begin;

insert into core.app_profiles (id, supabase_auth_id, username, name, email, role, active, is_test)
select 'qa-cloud-poc-profile-01',
       u.id::text,
       'qa-cloud-poc',
       'QA Cloud POC (Viewer)',
       u.email,
       'Viewer',
       true,
       true
  from auth.users u
 where u.id::text = (
         select w.user_id::text
           from public.erp_doc_test_writers w
          order by w.added_at desc
          limit 1
       )
   and not exists (
     select 1 from core.app_profiles p where p.supabase_auth_id = u.id::text
   );

commit;
