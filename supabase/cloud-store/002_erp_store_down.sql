-- 002_erp_store_down.sql
-- Rollback for 001_erp_store.sql.
-- WARNING: this DELETES every record stored in the cloud store. Export a backup
-- from the app (Settings -> backup) before running it.

begin;

-- Tables first (their policies depend on erp_is_member), then the functions.
drop table if exists public.erp_changes;
drop table if exists public.erp_records;
drop table if exists public.erp_members;

drop function if exists public.erp_stats();
drop function if exists public.erp_changes_since(bigint, int);
drop function if exists public.erp_load_page(text, bigint, int);
drop function if exists public.erp_head_seq();
drop function if exists public.erp_apply_changes(jsonb, text, boolean);
drop function if exists public.erp_is_member();

commit;
