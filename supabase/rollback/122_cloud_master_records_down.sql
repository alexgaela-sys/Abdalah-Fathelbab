-- Rollback for 122_cloud_master_records.sql (TEST only). NOT executed automatically.

begin;

drop function if exists public.erp_master_cas(text, text, text, text, boolean, jsonb, bigint);
drop table if exists public.erp_master_records;

commit;
