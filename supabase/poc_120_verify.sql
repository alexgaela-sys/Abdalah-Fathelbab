-- poc_120_verify.sql — TEST-ONLY sequential verification for
-- 120_erp_json_document_poc.sql.
--
-- Runs as the project owner but switches to the `authenticated` role with an
-- injected JWT `sub` claim, so RLS and the function's own authorization checks
-- are exercised exactly as a signed-in client would exercise them.
-- Synthetic payloads only. Nothing is printed but statuses/versions.

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

do $$
declare
  v_key  text := 'verify-' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_row  record;
  v_seed int;
begin
  -- 1) first create wins, version starts at 1
  select * into v_row from public.erp_doc_cas('snakdip-test-poc', v_key, 0, '{"seed":1}'::jsonb);
  if v_row.status <> 'created' or v_row.version <> 1 then
    raise exception 'POC VERIFY FAIL create: status=% version=%', v_row.status, v_row.version;
  end if;

  -- 2) duplicate create with expected 0 is rejected
  select * into v_row from public.erp_doc_cas('snakdip-test-poc', v_key, 0, '{"seed":2}'::jsonb);
  if v_row.status <> 'conflict' or v_row.version <> 1 then
    raise exception 'POC VERIFY FAIL duplicate create: status=% version=%', v_row.status, v_row.version;
  end if;

  -- 3) read back through RLS as the signed-in user
  select (payload->>'seed')::int into v_seed
    from public.erp_json_documents
   where scope = 'snakdip-test-poc' and doc_key = v_key;
  if v_seed is distinct from 1 then
    raise exception 'POC VERIFY FAIL read: seed=%', v_seed;
  end if;

  -- 4) matching-version update increments
  select * into v_row from public.erp_doc_cas('snakdip-test-poc', v_key, 1, '{"seed":3}'::jsonb);
  if v_row.status <> 'updated' or v_row.version <> 2 then
    raise exception 'POC VERIFY FAIL update: status=% version=%', v_row.status, v_row.version;
  end if;

  -- 5) stale version is rejected and does not overwrite
  select * into v_row from public.erp_doc_cas('snakdip-test-poc', v_key, 1, '{"seed":99}'::jsonb);
  if v_row.status <> 'conflict' or v_row.version <> 2 then
    raise exception 'POC VERIFY FAIL stale: status=% version=%', v_row.status, v_row.version;
  end if;
  select (payload->>'seed')::int into v_seed
    from public.erp_json_documents
   where scope = 'snakdip-test-poc' and doc_key = v_key;
  if v_seed is distinct from 3 then
    raise exception 'POC VERIFY FAIL stale overwrote payload: seed=%', v_seed;
  end if;

  -- 6) any scope other than the test scope is refused
  select * into v_row from public.erp_doc_cas('production', v_key, 0, '{}'::jsonb);
  if v_row.status <> 'invalid_scope' then
    raise exception 'POC VERIFY FAIL scope guard: status=%', v_row.status;
  end if;

  raise notice 'POC VERIFY OK sequential (doc_key=%)', v_key;
end $$;

-- 7) an authenticated user that is NOT on the writer allowlist is refused
select set_config(
  'request.jwt.claims',
  json_build_object('sub', gen_random_uuid()::text, 'role', 'authenticated')::text,
  true
);

do $$
declare
  v_row record;
begin
  select * into v_row from public.erp_doc_cas('snakdip-test-poc', 'verify-denied', 0, '{}'::jsonb);
  if v_row.status <> 'not_authorized' then
    raise exception 'POC VERIFY FAIL allowlist: status=%', v_row.status;
  end if;
  raise notice 'POC VERIFY OK non-allowlisted user refused';
end $$;

commit;
