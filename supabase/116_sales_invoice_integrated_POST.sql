-- 116_sales_invoice_integrated_POST.sql
--
-- Path A wrapper: single server call that posts the SALES financial side
-- AND the FIFO inventory + COGS side in the SAME caller transaction, so the
-- invoice, the ledger and the inventory movement can never be partially applied.
--
-- Composes public.post_sales_invoice (sales journal + invoice) and
-- public.post_sales_inventory_issue (FIFO movement + COGS journal). No historical
-- invoice is touched; no default data or mapping is invented.
--
-- Journal ownership (this is the contract, not an implementation detail):
--   * sales.invoices.journal_entry_id  = the SALES journal posted by
--     public.post_sales_invoice (revenue / receivable / VAT). It is written once
--     by that RPC and is NEVER overwritten by the COGS step, so the invoice keeps
--     a single, unambiguous link to its sales entry.
--   * the COGS journal is a SEPARATE balanced entry posted by
--     public.post_sales_inventory_issue through fin.post_journal, linked to the
--     invoice by its document reference (source_document_id = invoice id when the
--     journal RPC stores one, otherwise reference = invoice number).
--   * "linked" therefore means: the sales entry is the one the invoice points at,
--     and the COGS entry is a different, posted, balanced entry that carries the
--     invoice as its document reference.
--
-- Atomicity contract (why failures RAISE instead of returning a row):
--   fin.post_sales_invoice writes invoice + sale journal + idempotency row.
--   If anything afterwards fails and we merely RETURN an error row, the caller
--   (PostgREST/client) commits that half-written state. Raising aborts the whole
--   server transaction, so a failure leaves zero rows behind.
--
-- Fail-closed contract:
--   * a posted invoice whose journal_entry_id is NULL (the p_is_test placeholder
--     path used when mappings are missing) is REJECTED before inventory is
--     touched, and no success row is returned;
--   * a journal entry that exists but is not posted / not balanced / whose debit
--     does not equal the invoice EGP total is rejected as a placeholder;
--   * an inventory/COGS call that returns no journal number, or a number that
--     does not resolve to a different posted, balanced entry linked to the
--     invoice, aborts the call.
--
-- Boundary:
--   * NOT callable from the UI yet.
--   * posting still requires a role that can post accounting AND write inventory;
--     no role is granted or changed here.

create or replace function public.post_sales_invoice_integrated(
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
set search_path to 'public', 'fin', 'sales', 'inventory', 'core', 'audit', 'pg_temp'
as $function$
declare
  -- v_sales mirrors public.post_sales_invoice's return type exactly:
  -- TABLE(invoice_id text, invoice_number text, success boolean, error text)
  v_sales        record;
  v_cogs_result  record;
  v_idem         text;
  v_retry        boolean := false;
  v_sale_id      text;
  v_ceil_id      text;
  v_ceil_inv_no  text;
  v_ceil_cogs    numeric;
  v_ceil_total   numeric;
  v_ceil_status  text;
  v_ceil_stock   text;
  v_ceil_je_id   text;
  v_ceil_jr      text;
  v_sales_posted boolean;
  v_sales_dr     numeric;
  v_sales_cr     numeric;
  v_cogs_je_id   text;
  v_cogs_posted  boolean;
  v_cogs_dr      numeric;
  v_cogs_cr      numeric;
  v_period       text;
  v_closed       boolean;
begin
  -- Auth gate (mirrors the companion inventory function's gate). An EMPTY
  -- claims string is treated as "no session": a pooled connection can leave the
  -- GUC at '' after a transaction-local set_config, and PostgREST always sends a
  -- JSON document for a real request.
  if coalesce(current_setting('request.jwt.claims', true), '') <> '' then
    if auth.uid() is null then
      return query select null::text, null::numeric, null::text, 'error', false,
        'unauthorized: no auth session';
      return;
    end if;
    if not exists (
      select 1 from core.app_profiles p
       where p.supabase_auth_id = auth.uid()::text
         and p.active = true
         and p.role in ('Super Admin', 'Chief Accountant')
    ) then
      return query select null::text, null::numeric, null::text, 'error', false,
        'unauthorized: ERP role for this user may not post sales journals';
      return;
    end if;
    if not public.can_write_inventory() then
      return query select null::text, null::numeric, null::text, 'error', false,
        'unauthorized: ERP role for this user may not move inventory';
      return;
    end if;
  end if;

  -- -----------------------------------------------------------------
  -- Idempotency ceiling.
  -- The key only proves that the SALES side was started. A repeat must not
  -- short-circuit to success: the inventory issue and the COGS journal still
  -- have to be proven by the companion below (it is idempotent by natural
  -- movement guard + its own derived key).
  -- -----------------------------------------------------------------
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    v_idem := p_idempotency_key;
    lock table fin.rpc_idempotency in share row exclusive mode;
    if exists (select 1 from fin.rpc_idempotency r where r.key = v_idem) then
      select r.invoice_id, i.invoice_number, i.cogs_total,
             coalesce(i.total_amount_egp, i.total_amount),
             i.status, i.stock_source, i.journal_entry_id,
             coalesce(e.entry_number, null::text)
        into v_sale_id, v_ceil_inv_no, v_ceil_cogs, v_ceil_total,
             v_ceil_status, v_ceil_stock, v_ceil_je_id, v_ceil_jr
        from fin.rpc_idempotency r
        left join sales.invoices i on i.id = r.invoice_id
        left join fin.journal_entries e on e.id = i.journal_entry_id
       where r.key = v_idem
       limit 1;

      if v_sale_id is null or v_ceil_inv_no is null then
        -- Dangling key: never claim success for an invoice we cannot read back.
        return query select null::text, null::numeric, null::text, 'error', false,
          'idempotency key already exists but no invoice is linked to it; nothing was posted';
        return;
      end if;

      if v_ceil_status is distinct from 'posted' then
        return query select v_ceil_inv_no, null::numeric, null::text, 'error', false,
          format('linked invoice is not posted (status=%s)', coalesce(v_ceil_status, 'null'));
        return;
      end if;

      if v_ceil_stock is distinct from 'warehouse' then
        return query select v_ceil_inv_no, null::numeric, null::text, 'error', false,
          'linked invoice is not a warehouse-stock invoice; the integrated path does not cover it';
        return;
      end if;

      if v_ceil_je_id is null or v_ceil_jr is null then
        -- The earlier call committed a posted invoice without a sales journal.
        -- Never finish it as a success; a placeholder must be repaired, not hidden.
        raise exception 'invoice % has no linked sales journal (placeholder posting) — the integrated path cannot complete it', v_ceil_inv_no;
      end if;

      v_retry := true;
    end if;
  end if;

  if not v_retry then
    v_idem := coalesce(v_idem, 'integrated:' || gen_random_uuid());

    -- Pre-flight (no writes yet -> safe to return an error row)
    if p_customer_id is null or p_customer_id = '' then
      return query select null::text, null::numeric, null::text, 'error', false,
        'customer is required';
      return;
    end if;
    if p_warehouse_id is null or p_warehouse_id = '' then
      return query select null::text, null::numeric, null::text, 'error', false,
        'warehouse is required';
      return;
    end if;
    if p_lines is null or jsonb_array_length(p_lines) = 0 then
      return query select null::text, null::numeric, null::text, 'error', false,
        'at least one invoice line is required';
      return;
    end if;

    p_currency := upper(coalesce(nullif(trim(p_currency), ''), 'EGP'));
    if p_currency = 'EGP' and p_exchange_rate is distinct from 1 then
      return query select null::text, null::numeric, null::text, 'error', false,
        'EGP invoices must use exchange_rate = 1';
      return;
    end if;
    if p_currency = 'USD' and (p_exchange_rate is null or p_exchange_rate <= 0) then
      return query select null::text, null::numeric, null::text, 'error', false,
        'USD invoices require exchange_rate > 0';
      return;
    end if;

    -- ---------------------------------------------------------------
    -- Sales side (invoice + sale journal). From here on, EVERY failure
    -- raises, so the caller transaction cannot keep a partial write.
    -- p_is_test = true is deliberate: this wrapper is the TEST-only path.
    -- ---------------------------------------------------------------
    select * into v_sales
      from public.post_sales_invoice(
        p_customer_id, p_channel, p_warehouse_id, p_payment_method,
        p_currency, p_exchange_rate, p_date, p_lines,
        p_created_by,
        p_is_test => true,
        p_idempotency_key => v_idem
      );

    if not coalesce(v_sales.success, false) then
      -- fin.post_sales_invoice fails closed (no invoice/lines/journal written),
      -- so returning an error row here still commits nothing.
      return query select null::text, null::numeric, null::text, 'error', false,
        coalesce(v_sales.error, 'post_sales_invoice failed');
      return;
    end if;

    v_sale_id := v_sales.invoice_id;
    if v_sale_id is null then
      return query select null::text, null::numeric, null::text, 'error', false,
        'post_sales_invoice returned success without an invoice id';
      return;
    end if;

    -- Read back the COMMITTED sales-side row. The wrapper must not trust the
    -- RPC return flag alone: a posted invoice with a placeholder/unlinked journal
    -- is not a valid integrated posting.
    select i.id, i.invoice_number, i.cogs_total,
           coalesce(i.total_amount_egp, i.total_amount),
           i.status, i.stock_source, i.journal_entry_id,
           coalesce(e.entry_number, null::text)
      into v_ceil_id, v_ceil_inv_no, v_ceil_cogs, v_ceil_total,
           v_ceil_status, v_ceil_stock, v_ceil_je_id, v_ceil_jr
      from sales.invoices i
      left join fin.journal_entries e on e.id = i.journal_entry_id
     where i.id = v_sale_id;

    if v_ceil_id is null then
      raise exception 'created invoice % was not found after post_sales_invoice reported success', v_sale_id;
    end if;

    if v_ceil_status is distinct from 'posted' then
      raise exception 'created invoice % is not posted (status=%)', v_ceil_inv_no, coalesce(v_ceil_status, 'null');
    end if;

    if v_ceil_stock is distinct from 'warehouse' then
      raise exception 'rep_custody invoices are not covered by the integrated path (invoice %)', v_ceil_inv_no;
    end if;

    -- Fail closed on a journal-less or placeholder journal, and name the real
    -- reason when a closed period is what stopped the entry. fin.post_sales_invoice
    -- skips the real journal for a closed period (p_is_test path), so blaming a
    -- missing mapping here would send the accountant hunting for a chart-of-accounts
    -- problem that does not exist.
    if v_ceil_je_id is null or v_ceil_jr is null then
      if exists (select 1 from core.accounting_periods p
                  where p.is_closed
                    and p_date between p.start_date and p.end_date) then
        raise exception 'the accounting period covering % is closed — invoice % was not posted and nothing was written', p_date, v_ceil_inv_no;
      end if;
      raise exception 'the sales journal was not posted for invoice % — no real posted journal exists (a required account mapping may be missing); nothing further was posted', v_ceil_inv_no;
    end if;

    -- Record the sales-side ceiling so the retry path can read it
    insert into fin.rpc_idempotency (key, invoice_id)
      values (v_idem, v_sale_id)
      on conflict (key) do update set invoice_id = v_sale_id;
  end if;

  -- -----------------------------------------------------------------
  -- The sales journal must be a REAL posted, balanced entry for the invoice
  -- EGP total, not merely a non-null foreign key. This runs on first posting
  -- and on every retry, so a placeholder can never be reported as success.
  -- -----------------------------------------------------------------
  v_sales_posted := null;
  select e.is_posted into v_sales_posted
    from fin.journal_entries e
   where e.id = v_ceil_je_id;

  if not coalesce(v_sales_posted, false) then
    raise exception 'the linked sales journal (%) for invoice % is missing or not posted — nothing further was posted', coalesce(v_ceil_jr, 'null'), v_ceil_inv_no;
  end if;

  select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
    into v_sales_dr, v_sales_cr
    from fin.journal_lines l
   where l.journal_entry_id = v_ceil_je_id;

  if v_sales_dr <= 0 or abs(v_sales_dr - v_sales_cr) > 0.01 then
    raise exception 'the sales journal (%) for invoice % is empty or unbalanced (% / %) — nothing further was posted', v_ceil_jr, v_ceil_inv_no, v_sales_dr, v_sales_cr;
  end if;

  if v_ceil_total is not null and abs(v_sales_dr - v_ceil_total) > 0.01 then
    raise exception 'the sales journal (%) total % does not match invoice % EGP total % — refusing to claim the invoice is posted', v_ceil_jr, v_sales_dr, v_ceil_inv_no, v_ceil_total;
  end if;

  -- Period check for the inventory/COGS step.
  -- NOTE: compare DATE to DATE. Comparing invoice_number (text) against
  -- core.accounting_periods.start_date (date) has no operator and would fail.
  begin
    select p.is_closed, p.name_ar
      into v_closed, v_period
      from core.accounting_periods p
     where p_date >= p.start_date and p_date <= p.end_date
     order by p.start_date asc
     limit 1;
  exception when undefined_table or undefined_column then
    raise exception 'accounting periods could not be read; nothing further was posted for invoice %', v_ceil_inv_no;
  end;

  if coalesce(v_closed, false) then
    raise exception 'الفترة المالية (%) مغلقة ماليًا — لم يُنفَّذ أي صرف أو ترحيل تكلفة', v_period;
  end if;

  -- Inventory + COGS via companion.
  -- The companion gates on fin.rpc_idempotency: passing v_idem itself would
  -- make it see our own sales-side row and skip issuance as "already_posted",
  -- so it gets a derived key. Its own natural guard (existing 'sales'
  -- movements for the invoice number) still protects against a double issue.
  select * into v_cogs_result
    from public.post_sales_inventory_issue(
      v_sale_id,
      p_created_by,
      v_idem || ':inv'
    );

  if not coalesce(v_cogs_result.out_success, false) then
    raise exception '%', coalesce(v_cogs_result.out_error,
      format('inventory issuance failed for invoice %s', v_ceil_inv_no));
  end if;

  if coalesce(v_cogs_result.out_journal_number, '') = '' then
    raise exception 'inventory issuance for invoice % returned no COGS journal number — nothing was committed', v_ceil_inv_no;
  end if;

  -- Prove the returned COGS journal number is a real, posted, balanced entry
  -- linked to this invoice and distinct from the sales journal.
  v_cogs_je_id := null;
  v_cogs_posted := null;
  select e.id, e.is_posted into v_cogs_je_id, v_cogs_posted
    from fin.journal_entries e
   where e.entry_number = v_cogs_result.out_journal_number
     and (e.reference = v_ceil_inv_no or e.source_document_id = v_sale_id)
   limit 1;

  if v_cogs_je_id is null then
    raise exception 'the COGS journal number % returned for invoice % does not resolve to a journal linked to the invoice — nothing was committed', v_cogs_result.out_journal_number, v_ceil_inv_no;
  end if;

  if not coalesce(v_cogs_posted, false) then
    raise exception 'the COGS journal (%) for invoice % is not posted — nothing was committed', v_cogs_result.out_journal_number, v_ceil_inv_no;
  end if;

  if v_cogs_je_id = v_ceil_je_id then
    raise exception 'the COGS journal for invoice % resolved to the sales journal; refusing a shared/placeholder entry', v_ceil_inv_no;
  end if;

  select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
    into v_cogs_dr, v_cogs_cr
    from fin.journal_lines l
   where l.journal_entry_id = v_cogs_je_id;

  if v_cogs_dr <= 0 or abs(v_cogs_dr - v_cogs_cr) > 0.01 then
    raise exception 'the COGS journal (%) for invoice % is empty or unbalanced (% / %) — nothing was committed', v_cogs_result.out_journal_number, v_ceil_inv_no, v_cogs_dr, v_cogs_cr;
  end if;

  if abs(v_cogs_dr - coalesce(v_cogs_result.out_cogs, 0)) > 0.01 then
    raise exception 'the COGS journal (%) total % does not match the issued cost % for invoice %', v_cogs_result.out_journal_number, v_cogs_dr, v_cogs_result.out_cogs, v_ceil_inv_no;
  end if;

  return query select v_ceil_inv_no,
    coalesce(v_cogs_result.out_cogs, v_ceil_cogs, 0),
    v_cogs_result.out_journal_number,
    case when coalesce(v_cogs_result.out_status, '') = 'already_posted'
         then 'already_posted' else 'issued' end::text,
    true, null::text;
end
$function$;

comment on function public.post_sales_invoice_integrated(text, text, text, text, text, numeric, date, jsonb, text, text) is
  'Path A integrated sales posting (TEST only). Posts the sales journal via public.post_sales_invoice THEN atomically issues FIFO inventory + COGS via public.post_sales_inventory_issue in the same caller transaction. Success requires a posted balanced sales journal linked to the invoice and a distinct posted balanced COGS journal linked to the invoice; any failure RAISES so no partial state can commit. No historical invoice touched.';

revoke all on function public.post_sales_invoice_integrated(text, text, text, text, text, numeric, date, jsonb, text, text) from public;
revoke all on function public.post_sales_invoice_integrated(text, text, text, text, text, numeric, date, jsonb, text, text) from anon;
grant execute on function public.post_sales_invoice_integrated(text, text, text, text, text, numeric, date, jsonb, text, text) to authenticated;
