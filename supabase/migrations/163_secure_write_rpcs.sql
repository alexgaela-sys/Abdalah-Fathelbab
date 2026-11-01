-- =====================================================================
-- 163_secure_write_rpcs.sql — make the write RPCs match the 150 model
--
-- 150 revoked INSERT/UPDATE/DELETE on every ERP table from `authenticated`
-- and states the model plainly: "Every write goes through a SECURITY DEFINER
-- RPC that re-checks the caller's role, so a compromised browser session cannot
-- INSERT/UPDATE."
--
-- public.post_inventory_transfer does not follow that model: it is
-- SECURITY INVOKER, and it updates inventory.batches / inventory.transactions
-- itself. After 150 it therefore fails for every caller with
--   permission denied for table batches
-- even when its own role gate passed — the wired inventory-transfer screen
-- cannot write at all. Making it SECURITY DEFINER restores exactly the access it
-- had before 150 without granting the browser any direct table write.
--
-- It is safe to elevate: the function already
--   * refuses any role that fails public.can_write_inventory(),
--   * pins search_path = public, pg_temp,
--   * re-reads balances and keeps its value/idempotency guards.
-- No grant, policy or data is changed here.
-- =====================================================================

do $$
declare
  v_sig regprocedure := to_regprocedure(
    'public.post_inventory_transfer(text,text,text,numeric,text,text,date,text)');
  v_definer boolean;
begin
  if v_sig is null then
    raise notice '163: public.post_inventory_transfer is absent — skipped';
    return;
  end if;

  execute format('alter function %s security definer', v_sig);
  execute format('alter function %s set search_path = public, pg_temp', v_sig);

  select p.prosecdef into v_definer
    from pg_proc p where p.oid = v_sig;

  if not coalesce(v_definer, false) then
    raise exception '163: % is still SECURITY INVOKER — the write path would stay broken', v_sig;
  end if;

  -- The client must reach it, anon must not (unchanged intent, re-asserted
  -- because the function is the only write door for the inventory screen).
  execute format('revoke all on function %s from public', v_sig);
  execute format('revoke all on function %s from anon', v_sig);
  execute format('grant execute on function %s to authenticated', v_sig);

  raise notice '163: % is now SECURITY DEFINER (search_path pinned)', v_sig;
end $$;
