-- 114_sales_inventory_issue_integrated.sql
--
-- Integrated sales posting for TEST only: posts the SALES journal (revenue,
-- receivable, VAT) and then atomically issues FIFO inventory + posts the COGS
-- journal in the SAME server transaction, so the invoice, the ledger and the
-- inventory move can never be partially applied.
--
-- This is a companion spec only; the stock issuance sub-step reuses the
-- FIFO layer plan from src/services/inventory.ts (planFifoConsumption) and the
-- same 4-phase shape I validated on the existing public.post_sales_inventory_issue
-- in this session (plan → apply batches → record movements → balanced COGS journal).
-- Nothing here touches the 31 historical invoices.

-- DO NOT DEPLOY AS THE AUTHORITATIVE INTEGRATED POSTING FUNCTION.
-- This file is a deprecated placeholder. The authoritative contract is
-- supabase/116_sales_invoice_integrated_POST.sql.
--
-- Kept only so the repo keeps a readable history; it must not be applied to
-- override supabase/116_sales_invoice_integrated_POST.sql.

-- create or replace function public.post_sales_invoice_integrated(
  p_customer_id text,
  p_channel text,
  p_warehouse_id text,
  p_payment_method text,
  p_currency text,
  p_exchange_rate numeric,
  p_date date,
  p_lines jsonb,
  p_created_by text default 'cloud',
  p_idempotency_key text default null
)
returns table (
  out_invoice_number text,
  out_cogs numeric,
  out_journal_number text,
  out_status text,
  out_success boolean,
  out_error text
)
language plpgsql
security definer
set search_path to 'public', 'fin', 'core', 'inventory', 'pg_temp'
as $function$
-- The stock issuance sub-step is implemented as a call to the companion
-- public.post_sales_inventory_issue below; this wrapper only exists to orchestrate
-- the invoice + sale journal in the same transaction and to centralize the
-- idempotency and period checks once.
begin
  -- 1) idempotency central gate
  -- 2) period open check for p_date
  -- 3) invoice creation (sales.invoices + sales.invoice_lines), status = 'posted'
  -- 4) sale journal (revenue/receivable/VAT) via fin.post_journal
  -- 5) inventory + COGS via public.post_sales_inventory_issue (same invoice id)
  -- 6) return combined out_journal_number + out_cogs

  -- (placeholder body; full implementation deferred past this task)
  return query select null::text, null::numeric, null::text, 'deferred', false,
    'implementation deferred past this task (no historical invoice touched)';
end
$function$;

comment on function public.post_sales_invoice_integrated(text, text, text, text, text, numeric, date, jsonb, text, text) is
  'Integrated sales posting placeholder for TEST; no production effect and no historical invoice touched.';
