-- 117_sales_invoice_integrated_contract_test.sql
--
-- Focused TEST-only contract tests for public.post_sales_invoice_integrated and its
-- downstream companion public.post_sales_inventory_issue.
--
-- This file does NOT apply production schema, does NOT mutate historical invoices,
-- and does NOT invent accounting rules. It only documents the exact failure/success
-- boundaries we must prove exist in the deployed function definitions and permissions.
--
-- Run in the Supabase SQL Editor for project snakdip-shared-test ONLY, with a role
-- that can read pg_proc / information_schema for function fingerprinting and, if
-- desired, execute the RPCs against isolated QA fixtures that already exist or are
-- explicitly created for this test.
--
-- IMPORTANT: this is a TEST probe, not a migration. Do not run it against Production.

begin;

create temporary table _contract_test (
  step text primary key,
  expectation text,
  status text,
  detail text
) on commit drop;

insert into _contract_test values
  ('contract_shape', 'returns table(out_invoice_number text, out_cogs numeric, out_journal_number text, out_status text, out_success boolean, out_error text)', 'pending', ''),
  ('security_definer', 'function must be security definer', 'pending', ''),
  ('auth_gate', 'unauthenticated anon calls must be rejected before any write', 'pending', ''),
  ('role_gate', 'non-SupAdmin/non-ChiefAccountant ERP roles must be rejected', 'pending', ''),
  ('inventory_gate', 'roles without inventory write must be rejected', 'pending', ''),
  ('idempotency_key', 'repeated key must not create a second invoice/journal/movement', 'pending', ''),
  ('period_gate', 'closed period must reject before inventory/COGS', 'pending', ''),
  ('missing_mappings_reject', 'missing COGS/FG account mapping must reject before inventory/COGS', 'pending', ''),
  ('placeholder_journal_reject', 'posted invoice with no linked journal_entry_id must be rejected by the integrated wrapper', 'pending', ''),
  ('unposted_invoice_reject', 'non-posted sales invoice must be rejected by the inventory companion', 'pending', ''),
  ('downstream_cogs_failure_rollback', 'COGS journal failure must leave no invoice/journal/movement', 'pending', ''),
  ('valid_fixture_success', 'valid fixtures with mappings must produce invoice + sale journal + FIFO issue + COGS journal atomically', 'pending', '');

raise notice 'contract probe created; next step: verify deployed function fingerprint and grants, then assert behavior with isolated fixtures.';

rollback;

-- The real pass/fail assertions must be run with a TEST role that has the right grants
-- and with isolated fixtures created explicitly for this probe. Do not assume success
-- from catalog reads alone; proofs require actual calls with rollback-safe cleanup.
