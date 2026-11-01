-- qa_link_profile_viewer.sql
-- Links the dedicated TEST Auth user to core.app_profiles so that
-- fin.post_sales_invoice and related server-side gates accept the session.
--
-- Run against the TEST database only using the existing TEST auth user identity.
-- This script is idempotent and intentionally narrow.

DO $$
DECLARE
  v_auth_id uuid;
  v_email text := 'elhandsiagroup10@gmail.com';
BEGIN
  -- find the auth user id for the dedicated TEST user
  SELECT u.id
    INTO v_auth_id
    FROM auth.users u
   WHERE u.email = v_email
   LIMIT 1;

  IF v_auth_id IS NULL THEN
    RAISE NOTICE 'no auth user found for %', v_email;
    RETURN;
  END IF;

  -- insert or ignore the app profile row
  INSERT INTO core.app_profiles (
    id,
    supabase_auth_id,
    username,
    name,
    email,
    role,
    active,
    is_test
  ) VALUES (
    gen_random_uuid(),
    v_auth_id,
    'qa_test_viewer',
    'QA TEST Viewer',
    v_email,
    'Chief Accountant',
    TRUE,
    TRUE
  )
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'linked auth user % to core.app_profiles', v_auth_id;
END;
$$;
