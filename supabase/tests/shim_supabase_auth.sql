-- =====================================================================
-- supabase/tests/shim_supabase_auth.sql
--
-- LOCAL VALIDATION ONLY. Never apply this file to Supabase TEST or
-- Production: on Supabase auth.users, auth.uid(), the anon/authenticated
-- roles and the real JWT claims already exist.
--
-- Purpose: make supabase/migrations/*.sql apply on a stock PostgreSQL 14
-- instance so syntax, constraints, triggers and RLS policies are proven
-- before anyone touches a hosted project.
-- =====================================================================

create schema if not exists auth;
create schema if not exists extensions;

create table if not exists auth.users (
  id uuid primary key,
  email text unique,
  created_at timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon');
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;
