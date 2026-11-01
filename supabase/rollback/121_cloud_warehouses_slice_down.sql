-- Rollback for 121_cloud_warehouses_slice.sql (TEST project only).
-- NOT executed automatically.

begin;

drop function if exists public.erp_warehouse_cas(
  text, text, text, text, text, text, text, text, boolean, bigint
);
drop table if exists public.erp_warehouses;

commit;
