-- 120_erp_json_document_poc_down.sql
-- Rollback for 120_erp_json_document_poc.sql (TEST project only).
-- NOT executed automatically. Run manually only if the POC must be removed.
--
-- This drops ONLY the POC objects created by 120_*. It does not touch any
-- pre-existing table, auth user, or ERP data.

begin;

drop function if exists public.erp_doc_cas(text, text, bigint, jsonb);

drop table if exists public.erp_json_documents;
drop table if exists public.erp_doc_test_writers;

commit;
