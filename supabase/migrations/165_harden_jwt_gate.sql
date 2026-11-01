-- =====================================================================
-- 165_harden_jwt_gate.sql — make the JWT gate treat an empty claims value as
-- "no session".
--
-- Every write RPC here skips its authorization gate for a trusted direct
-- database session (no JWT) and enforces it for a PostgREST request. The idiom
-- used was `current_setting('request.jwt.claims', true) is not null`.
--
-- That is wrong on a pooled connection: after any transaction that ran
-- `set_config('request.jwt.claims', …, true)` and rolled back, the server
-- connection can hand the next session an EMPTY STRING instead of NULL. The
-- gate then engages, auth.uid() is NULL, and a legitimate owner session is
-- refused with "unauthorized: no auth session" — while a real PostgREST request
-- always carries a JSON document and is unaffected.
--
-- The fix is textual and one-directional: `null` and `''` both mean "no JWT".
-- Nothing about the roles, checks or fail-closed behaviour changes.
--
-- Applies to the functions defined in this repository (114/116 already carry the
-- fix in their own files) AND to the deployed-only finance RPCs, which have no
-- source file here. The rewrite is verified function by function: the new
-- definition may differ from the old one ONLY in that condition.
-- =====================================================================
\set ON_ERROR_STOP on

do $$
declare
  f        record;
  v_def    text;
  v_new    text;
  v_before int;
  v_after  int;
  v_changed int := 0;
begin
  for f in
    select n.nspname, p.proname, p.oid
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'fin', 'core', 'sales', 'inventory', 'purchasing', 'production')
       and p.prokind = 'f'
       and pg_get_functiondef(p.oid) ~* 'current_setting\(''request\.jwt\.claims'', true\)\s+is\s+not\s+null'
  loop
    v_def := pg_get_functiondef(f.oid);

    v_new := regexp_replace(
      v_def,
      'current_setting\(''request\.jwt\.claims'', true\)(\s+)is\s+not\s+null',
      'coalesce(current_setting(''request.jwt.claims'', true), '''') <> ''''',
      'gi'
    );

    -- Count the fragile conditions before/after: every occurrence must change,
    -- and nothing else may.
    select count(*) into v_before
      from regexp_matches(v_def, 'current_setting\(''request\.jwt\.claims'', true\)\s+is\s+not\s+null', 'gi');
    select count(*) into v_after
      from regexp_matches(v_new, 'current_setting\(''request\.jwt\.claims'', true\)\s+is\s+not\s+null', 'gi');

    if v_before = 0 then
      continue;
    end if;
    if v_after <> 0 then
      raise exception '165: could not rewrite every JWT gate in %.% (% left)', f.nspname, f.proname, v_after;
    end if;

    execute v_new;
    v_changed := v_changed + 1;
    raise notice '165: hardened %.% (% gate(s))', f.nspname, f.proname, v_before;
  end loop;

  raise notice '165: % function(s) hardened', v_changed;
end $$;

-- Proof for the reviewer: list what still matches the fragile idiom (expected 0).
select n.nspname || '.' || p.proname as function_name
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public', 'fin', 'core', 'sales', 'inventory', 'purchasing', 'production')
   and p.prokind = 'f'
   and pg_get_functiondef(p.oid) ~* 'current_setting\(''request\.jwt\.claims'', true\)\s+is\s+not\s+null';
