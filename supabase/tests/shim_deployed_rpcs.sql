-- =====================================================================
-- supabase/tests/shim_deployed_rpcs.sql
--
-- LOCAL VALIDATION ONLY. Never apply this file to Supabase TEST or
-- Production.
--
-- Two functions the production-completion path calls already exist on the
-- hosted TEST project but are NOT created by supabase/migrations/*.sql:
--   * public.can_write_inventory()  — the inventory writer gate,
--   * fin.post_journal(...)         — the ledger posting RPC.
-- On a scratch PostgreSQL (scripts/verify_migrations_local.sh) they must be
-- shimmed, otherwise 173 cannot be executed at all and the cycle stays
-- unproven even locally.
--
-- The shim reproduces the CONTRACT the migrations rely on — two-sided journal,
-- debit = credit within 0.01, per-key idempotency, returns
-- (success, entry_id, entry_number, error) — and nothing more. It is not a
-- replacement for the hosted function and grants no rights anywhere.
-- =====================================================================

-- audit.app_audit_log and its enum are pre-existing on TEST (168 only writes to
-- them). They must exist locally or every audited RPC fails.
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                  where n.nspname = 'audit' and t.typname = 'audit_action') then
    create schema if not exists audit;
    create type audit.audit_action as enum
      ('view','create','edit','delete','post','reverse','approve','cancel','export');
  end if;
end $$;

create table if not exists audit.app_audit_log (
  id text primary key,
  "timestamp" timestamptz not null default now(),
  user_id text,
  user_name text,
  module text,
  action audit.audit_action,
  record_id text,
  record_table text,
  new_value jsonb,
  description text
);

create or replace function public.can_write_inventory()
returns boolean
language sql
stable
as $$
  select true;
$$;

create sequence if not exists fin.qa_journal_seq;

drop function if exists fin.post_journal(date, text, text, text, jsonb, text, text, boolean);

create or replace function fin.post_journal(
  p_date date,
  p_reference text,
  p_description text,
  p_source_document_type text,
  p_lines jsonb,
  p_created_by text default 'system',
  p_idempotency_key text default null,
  p_is_test boolean default false
)
returns table (
  success boolean,
  entry_id text,
  entry_number text,
  error text
)
language plpgsql
as $$
declare
  v_id text;
  v_number text;
  v_debit numeric := 0;
  v_credit numeric := 0;
  v_lines int := coalesce(jsonb_array_length(p_lines), 0);
  v_existing text;
begin
  if v_lines < 2 then
    return query select false, null::text, null::text, 'journal needs at least two lines'::text;
    return;
  end if;

  select coalesce(sum((l ->> 'debit')::numeric), 0), coalesce(sum((l ->> 'credit')::numeric), 0)
    into v_debit, v_credit
    from jsonb_array_elements(p_lines) l;

  if abs(v_debit - v_credit) > 0.01 then
    return query select false, null::text, null::text,
      format('journal is not balanced: debit %s <> credit %s', v_debit, v_credit)::text;
    return;
  end if;

  if coalesce(p_idempotency_key, '') <> '' then
    select e.id into v_existing
      from fin.journal_entries e
     where e.reference = p_reference
       and e.source_document_type = p_source_document_type
     order by e.created_at desc
     limit 1;
    if v_existing is not null then
      select e.id, e.entry_number into v_id, v_number
        from fin.journal_entries e where e.id = v_existing;
      return query select true, v_id, v_number, null::text;
      return;
    end if;
  end if;

  v_id := 'qa-je-' || nextval('fin.qa_journal_seq')::text;
  v_number := 'QA-JV-' || lpad(nextval('fin.qa_journal_seq')::text, 6, '0');

  insert into fin.journal_entries (
    id, entry_number, date, reference, description, source_document_type,
    source_document_id, is_posted, posted_at, total_debit, total_credit,
    created_user_id, is_test
  ) values (
    v_id, v_number, p_date, coalesce(p_reference, ''), coalesce(p_description, ''),
    coalesce(p_source_document_type, ''), null, true, now(), v_debit, v_credit,
    p_created_by, coalesce(p_is_test, false)
  );

  insert into fin.journal_lines (
    id, journal_entry_id, account_id, account_code, account_name_ar,
    debit, credit, currency, original_amount, exchange_rate, description
  )
  select 'qa-jl-' || v_id || '-' || row_number() over (),
         v_id,
         l."accountId",
         coalesce(l."accountCode", ''),
         coalesce((select a.name_ar from core.accounts a where a.id = l."accountId"), ''),
         coalesce(l.debit, 0),
         coalesce(l.credit, 0),
         'EGP',
         coalesce(l.debit, 0) + coalesce(l.credit, 0),
         1,
         l.description
    from jsonb_to_recordset(p_lines) as l(
      "accountId" text, "accountCode" text, debit numeric, credit numeric, description text
    );

  return query select true, v_id, v_number, null::text;
end;
$$;
