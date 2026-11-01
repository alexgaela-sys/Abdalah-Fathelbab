-- poc_120_cas_race.sql — TEST-ONLY concurrency probe for public.erp_doc_cas.
--
-- Run two of these at the same time against the same key/expected version:
--
--   psql "$TEST_DATABASE_URL" -v key=race-1 -v expected=1 -v seed=401 -f supabase/poc_120_cas_race.sql
--   psql "$TEST_DATABASE_URL" -v key=race-1 -v expected=1 -v seed=402 -f supabase/poc_120_cas_race.sql
--
-- Exactly one worker must report status=updated; the other must report
-- status=conflict. The pg_sleep aligns both workers so they contend for the
-- same row lock instead of running back-to-back.

\set ON_ERROR_STOP on

begin;

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (select user_id::text from public.erp_doc_test_writers order by added_at limit 1),
    'role', 'authenticated'
  )::text,
  true
);

set local role authenticated;

select pg_sleep(0.5);

select 'worker_' || :'seed' as worker, r.status, r.version
  from public.erp_doc_cas(
    'snakdip-test-poc',
    :'key',
    :'expected'::bigint,
    jsonb_build_object('seed', :'seed'::int)
  ) r;

commit;
