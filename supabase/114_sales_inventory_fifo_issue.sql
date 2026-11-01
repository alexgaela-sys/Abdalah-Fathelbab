-- 114_sales_inventory_fifo_issue.sql
--
-- Companion RPC for sales invoices: it performs the INVENTORY side that
-- fin.post_sales_invoice deliberately does not do (documented scope: that RPC
-- posts revenue/VAT/receivable only and always sets cogs_total = 0).
--
-- Rules are taken from the LOCAL engine, not invented here:
--   * src/services/workflows.ts  createSalesInvoice:
--       - issued quantity per line = quantity + freeQuantity (the bonus carton
--         leaves inventory and IS costed, but is never priced),
--       - stock is validated BEFORE posting, negative stock is rejected,
--       - the cost of every line is resolved from the ACTUAL layers that leave
--         the warehouse (FIFO); a cost is never invented,
--       - COGS is booked in EGP base value (once), revenue only is converted,
--       - Dr COGS / Cr finished-goods inventory (export channel uses the
--         export mapping keys).
--   * src/services/inventory.ts   planFifoConsumption:
--       - FIFO order: production_date ascending (nulls first), batch_number as
--         the deterministic tiebreak,
--       - resolveActualUnitCost priority: FIFO layer cost, then a legitimately
--         configured item.standard_cost (> 0), otherwise FAIL.
--
-- Guarantees of this function:
--   * atomic: everything happens in the caller's transaction; any error leaves
--     no trace (batches, transactions, invoice totals and journal all roll back),
--   * idempotent: a natural guard (existing 'sales' inventory movements for the
--     invoice number) plus an explicit key stored in fin.rpc_idempotency,
--   * no negative stock: coverage is planned and validated for ALL lines before
--     a single batch row is touched,
--   * concurrency safe: batch rows are updated with a quantity >= take guard and
--     any lost race aborts the whole call,
--   * balanced journal through the existing fin.post_journal (period checks,
--     balance check and idempotency are reused, not duplicated),
--   * no invented accounts: the COGS / finished-goods accounts must exist as
--     core.account_mappings keys, otherwise the call fails before writing.
--
-- It does NOT touch the 31 existing invoices. It is opt-in per invoice id and
-- must only be enabled from the UI after parity tests pass.

create or replace function public.post_sales_inventory_issue(
  p_invoice_id text,
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
declare
  v_inv            record;
  v_line           record;
  v_layer          record;
  v_qty            numeric;
  v_remaining      numeric;
  v_take           numeric;
  v_shortfall      numeric;
  v_line_cost      numeric;
  v_plan_cost      numeric;
  v_total_cogs     numeric := 0;
  v_standard_cost  numeric;
  v_cogs_acc       text;
  v_fg_acc         text;
  v_cogs_code      text;
  v_fg_code        text;
  v_cogs_header    boolean;
  v_fg_header      boolean;
  v_cogs_key       text;
  v_fg_key         text;
  v_journal        jsonb;
  v_jres           record;
  v_journal_number text;
  v_journal_id     text;
  v_journal_posted boolean;
  v_dr             numeric;
  v_cr             numeric;
  v_existing_docs  int;
  v_balance        numeric;
  v_idem           text;
  v_period_closed  boolean;
  v_period_name    text;
  v_updated        int;
  v_doc_type       text := 'فاتورة مبيعات';
begin
  -- ---------------------------------------------------------------
  -- Authorization — same gate as fin.post_journal (this RPC writes a journal).
  -- Owner sessions from psql (no JWT claims) are exempt, like the other RPCs.
  -- ---------------------------------------------------------------
  -- A pooled connection can leave request.jwt.claims set to an EMPTY string
  -- after a transaction-local set_config, and PostgREST always sends a JSON
  -- document for a real request. Treating "empty" as "no session" keeps a
  -- trusted database session trusted instead of refusing it with
  -- 'no auth session' while the gate was never actually meant to run.
  if coalesce(current_setting('request.jwt.claims', true), '') <> '' then
    if auth.uid() is null then
      return query select null::text, null::numeric, null::text, 'error', false,
        'unauthorized: no auth session'::text;
      return;
    end if;
    if not exists (
      select 1 from core.app_profiles p
       where p.supabase_auth_id = auth.uid()::text
         and p.active = true
         and p.role in ('Super Admin', 'Chief Accountant')
    ) then
      return query select null::text, null::numeric, null::text, 'error', false,
        'unauthorized: this ERP role may not post inventory issuance for sales'::text;
      return;
    end if;
    if not public.can_write_inventory() then
      return query select null::text, null::numeric, null::text, 'error', false,
        'unauthorized: this ERP role may not move inventory'::text;
      return;
    end if;
  end if;

  -- ---------------------------------------------------------------
  -- Invoice lock + validation
  -- ---------------------------------------------------------------
  select * into v_inv
    from sales.invoices i
   where i.id = p_invoice_id
     for update;

  if not found then
    return query select null::text, null::numeric, null::text, 'error', false,
      format('invoice %s was not found', coalesce(p_invoice_id, '?'))::text;
    return;
  end if;

  if v_inv.status is distinct from 'posted' then
    return query select v_inv.invoice_number, null::numeric, null::text, 'error', false,
      format('invoice %s is not posted (status=%s); the journal was rolled back',
             v_inv.invoice_number, coalesce(v_inv.status, 'null'))::text;
    return;
  end if;

  if v_inv.stock_source is distinct from 'warehouse' then
    return query select v_inv.invoice_number, null::numeric, null::text, 'error', false,
      'rep_custody documents are not covered: the custody account was already relieved when the goods were loaded'::text;
    return;
  end if;

  -- Local isPeriodOpen: a date covered by a CLOSED period must never receive a
  -- new movement/journal. Checked BEFORE any mutation.
  begin
    select p.is_closed, p.name_ar into v_period_closed, v_period_name
      from core.accounting_periods p
     where v_inv.date >= p.start_date and v_inv.date <= p.end_date
     order by p.start_date asc
     limit 1;
    if found and v_period_closed then
      return query select v_inv.invoice_number, null::numeric, null::text, 'error', false,
        format('الفترة المالية (%s) مغلقة ماليًا — لا يمكن صرف مخزون أو ترحيل تكلفة عليها', v_period_name)::text;
      return;
    end if;
  exception when undefined_table or undefined_column then
    return query select v_inv.invoice_number, null::numeric, null::text, 'error', false,
      'accounting periods could not be read; nothing was posted'::text;
    return;
  end;

  -- ---------------------------------------------------------------
  -- Idempotency — natural guard first (never issue twice for one invoice)
  -- ---------------------------------------------------------------
  select count(*) into v_existing_docs
    from inventory.transactions t
   where t.document_number = v_inv.invoice_number
     and t.movement_type = 'sales'
     and t.warehouse_id = v_inv.warehouse_id;

  -- The COGS journal is NOT sales.invoices.journal_entry_id (that link belongs
  -- to the sales journal). A repeat must return the COGS entry that carries this
  -- invoice as its document reference, and a different id from the sales entry.
  if v_existing_docs > 0 then
    select e.entry_number into v_journal_number
      from fin.journal_entries e
     where e.source_document_type = 'sales_invoice'
       and (e.reference = v_inv.invoice_number or e.source_document_id = v_inv.id)
       and e.is_posted = true
       and e.id is distinct from v_inv.journal_entry_id
     order by e.entry_number desc
     limit 1;

    return query select v_inv.invoice_number, v_inv.cogs_total, v_journal_number,
      'already_posted'::text, true, null::text;
    return;
  end if;

  v_idem := coalesce(nullif(trim(p_idempotency_key), ''), 'sales_issue:' || v_inv.id);

  lock table fin.rpc_idempotency in share row exclusive mode;
  if exists (select 1 from fin.rpc_idempotency r where r.key = v_idem) then
    select e.entry_number into v_journal_number
      from fin.journal_entries e
     where e.source_document_type = 'sales_invoice'
       and (e.reference = v_inv.invoice_number or e.source_document_id = v_inv.id)
       and e.is_posted = true
       and e.id is distinct from v_inv.journal_entry_id
     order by e.entry_number desc
     limit 1;

    return query select v_inv.invoice_number, v_inv.cogs_total, v_journal_number,
      'already_posted'::text, true, null::text;
    return;
  end if;

  -- ---------------------------------------------------------------
  -- Account mapping (no invented accounts)
  -- ---------------------------------------------------------------
  if v_inv.channel = 'export' then
    v_cogs_key := 'cogs_export';
    v_fg_key   := 'inventory_finished_export';
  else
    v_cogs_key := 'cogs_local';
    v_fg_key   := 'inventory_finished_local';
  end if;

  select m.account_id into v_cogs_acc from core.account_mappings m where m.key = v_cogs_key limit 1;
  select m.account_id into v_fg_acc   from core.account_mappings m where m.key = v_fg_key   limit 1;

  if v_cogs_acc is null or v_fg_acc is null then
    return query select v_inv.invoice_number, null::numeric, null::text, 'error', false,
      format('account mapping is incomplete: %s / %s must exist in core.account_mappings before COGS can be posted',
             v_cogs_key, v_fg_key)::text;
    return;
  end if;

  -- A mapped account must really exist and must not be a header account.
  -- fin.post_journal also refuses headers; this makes the failure explicit
  -- before any stock row is touched and names the offending key.
  select a.code, a.is_header into v_cogs_code, v_cogs_header
    from core.accounts a where a.id = v_cogs_acc;
  if v_cogs_code is null then
    return query select v_inv.invoice_number, null::numeric, null::text, 'error', false,
      format('account mapping %s points at account %s which does not exist in core.accounts — nothing was posted',
             v_cogs_key, v_cogs_acc)::text;
    return;
  end if;
  if coalesce(v_cogs_header, false) then
    return query select v_inv.invoice_number, null::numeric, null::text, 'error', false,
      format('account mapping %s points at header account %s; COGS must post to a detail account — nothing was posted',
             v_cogs_key, v_cogs_acc)::text;
    return;
  end if;

  select a.code, a.is_header into v_fg_code, v_fg_header
    from core.accounts a where a.id = v_fg_acc;
  if v_fg_code is null then
    return query select v_inv.invoice_number, null::numeric, null::text, 'error', false,
      format('account mapping %s points at account %s which does not exist in core.accounts — nothing was posted',
             v_fg_key, v_fg_acc)::text;
    return;
  end if;
  if coalesce(v_fg_header, false) then
    return query select v_inv.invoice_number, null::numeric, null::text, 'error', false,
      format('account mapping %s points at header account %s; finished goods must post to a detail account — nothing was posted',
             v_fg_key, v_fg_acc)::text;
    return;
  end if;

  -- ---------------------------------------------------------------
  -- Phase 1 — plan ALL lines (pure, no mutation) ------------------
  -- ---------------------------------------------------------------
  create temporary table if not exists pg_temp._si_layers (
    invoice_line_id text,
    item_id         text,
    batch_number    text,
    take            numeric,
    unit_cost       numeric,
    ordering        int
  ) on commit drop;
  truncate pg_temp._si_layers;

  -- Virtual availability per layer: the plan for line 2 must continue where
  -- line 1 stopped (the local engine also consumes layer by layer, line by line).
  create temporary table if not exists pg_temp._si_avail (
    item_id         text,
    batch_number    text,
    production_date date,
    unit_cost       numeric,
    remaining       numeric
  ) on commit drop;
  truncate pg_temp._si_avail;

  insert into pg_temp._si_avail (item_id, batch_number, production_date, unit_cost, remaining)
  select b.item_id, b.batch_number, b.production_date, coalesce(b.unit_cost, 0), b.quantity
    from inventory.batches b
   where b.warehouse_id = v_inv.warehouse_id
     and b.quantity > 0;

  for v_line in
    select l.* from sales.invoice_lines l
     where l.invoice_id = v_inv.id
     order by l.id
  loop
    v_qty := coalesce(v_line.quantity, 0) + coalesce(v_line.free_quantity, 0);
    if v_qty <= 0 then
      continue;
    end if;

    v_remaining := v_qty;
    v_plan_cost := 0;
    v_shortfall := v_qty;

    -- FIFO: production_date asc nulls first, batch_number deterministic tiebreak
    -- (identical ordering to planFifoConsumption in src/services/inventory.ts).
    for v_layer in
      select a.batch_number, a.remaining, a.unit_cost
        from pg_temp._si_avail a
       where a.item_id = v_line.item_id
         and a.remaining > 0
       order by a.production_date asc nulls first, a.batch_number asc
    loop
      exit when v_remaining <= 0;
      v_take := least(v_layer.remaining, v_remaining);
      continue when v_take <= 0;

      update pg_temp._si_avail a
         set remaining = a.remaining - v_take
       where a.item_id = v_line.item_id and a.batch_number = v_layer.batch_number;

      insert into pg_temp._si_layers (invoice_line_id, item_id, batch_number, take, unit_cost, ordering)
      values (v_line.id, v_line.item_id, v_layer.batch_number, v_take, coalesce(v_layer.unit_cost, 0),
              (select coalesce(max(ordering), 0) + 1 from pg_temp._si_layers));

      v_plan_cost := v_plan_cost + v_take * coalesce(v_layer.unit_cost, 0);
      v_remaining := v_remaining - v_take;
      v_shortfall := v_shortfall - v_take;
    end loop;

    if v_shortfall > 0 then
      select coalesce(sum(a.remaining), 0) into v_balance
        from pg_temp._si_avail a where a.item_id = v_line.item_id;
      return query select v_inv.invoice_number, null::numeric, null::text, 'error', false,
        format('الرصيد المتاح من الصنف (%s) في المستودع هو %s ولا يكفي لصرف %s (نقص %s) — لم يتم أي تعديل',
               v_line.item_id, v_balance, v_qty, v_shortfall)::text;
      return;
    end if;

    -- Same priority order as InventoryEngine.resolveActualUnitCost.
    if v_plan_cost = 0 then
      select coalesce(i.standard_cost, 0) into v_standard_cost
        from core.items i where i.id = v_line.item_id;
      if coalesce(v_standard_cost, 0) > 0 then
        v_plan_cost := v_standard_cost * v_qty;
      else
        return query select v_inv.invoice_number, null::numeric, null::text, 'error', false,
          format('لا توجد تكلفة فعلية أو معيارية معرَّفة للصنف (%s) في المستودع المحدد — لم يتم أي تعديل',
                 v_line.item_id)::text;
        return;
      end if;
    end if;

    v_total_cogs := v_total_cogs + v_plan_cost;
  end loop;

  -- An issued quantity with no resolvable cost must never produce a "success"
  -- row without a COGS journal.
  if v_total_cogs <= 0 then
    return query select v_inv.invoice_number, null::numeric, null::text, 'error', false,
      format('resolved COGS for invoice %s is %s; refusing to issue stock without a costed journal',
             v_inv.invoice_number, v_total_cogs)::text;
    return;
  end if;

  -- ---------------------------------------------------------------
  -- Phase 2 — apply batches (guarded updates) --------------------
  -- ---------------------------------------------------------------
  for v_layer in
    select * from pg_temp._si_layers order by ordering asc
  loop
    update inventory.batches b
       set quantity = b.quantity - v_layer.take,
           updated_at = now()
     where b.item_id = v_layer.item_id
       and b.warehouse_id = v_inv.warehouse_id
       and b.batch_number = v_layer.batch_number
       and b.quantity >= v_layer.take;

    get diagnostics v_updated = row_count;
    if v_updated <> 1 then
      raise exception 'concurrent stock change on item % batch % — invoice issuance rolled back',
        v_layer.item_id, v_layer.batch_number;
    end if;
  end loop;

  -- Inventory transactions + line costs (one movement row per line, primary
  -- batch = first consumed layer, unit cost = weighted actual cost).
  for v_line in
    select l.* from sales.invoice_lines l
     where l.invoice_id = v_inv.id
     order by l.id
  loop
    v_qty := coalesce(v_line.quantity, 0) + coalesce(v_line.free_quantity, 0);
    continue when v_qty <= 0;

    select coalesce(sum(lay.take * lay.unit_cost), 0) into v_line_cost
      from pg_temp._si_layers lay where lay.invoice_line_id = v_line.id;

    -- zero-cost layers + configured standard cost -> book the standard rate
    if v_line_cost = 0 then
      select coalesce(i.standard_cost, 0) into v_standard_cost from core.items i where i.id = v_line.item_id;
      v_line_cost := coalesce(v_standard_cost, 0) * v_qty;
    end if;

    update sales.invoice_lines l
       set unit_cost = case when v_qty > 0 then v_line_cost / v_qty else 0 end
     where l.id = v_line.id;

    select coalesce(sum(b.quantity), 0) into v_balance
      from inventory.batches b
     where b.item_id = v_line.item_id and b.warehouse_id = v_inv.warehouse_id;

    insert into inventory.transactions
      (id, date, document_type, document_number, movement_type, item_id, warehouse_id,
       batch_number, quantity_in, quantity_out, balance_after, unit_cost, total_cost,
       notes, created_by, is_test)
    values
      ('itx-' || replace(gen_random_uuid()::text, '-', ''), v_inv.date, v_doc_type,
       v_inv.invoice_number, 'sales', v_line.item_id, v_inv.warehouse_id,
       (select lay.batch_number from pg_temp._si_layers lay
         where lay.invoice_line_id = v_line.id order by lay.ordering asc limit 1),
       0, v_qty, v_balance,
       case when v_qty > 0 then v_line_cost / v_qty else 0 end,
       v_line_cost,
       format('صرف مخزون لفاتورة بيع %s (FIFO)', v_inv.invoice_number),
       coalesce(nullif(trim(p_created_by), ''), 'system'),
       coalesce(v_inv.is_test, false));
  end loop;

  update sales.invoices i
     set cogs_total = v_total_cogs,
         updated_at = now()
   where i.id = v_inv.id;

  -- ---------------------------------------------------------------
  -- Phase 3 — balanced COGS journal through the existing RPC ------
  -- ---------------------------------------------------------------
  if v_total_cogs > 0 then
    v_journal := jsonb_build_array(
      jsonb_build_object(
        'accountId', v_cogs_acc,
        'accountCode', v_cogs_code,
        'debit', v_total_cogs, 'credit', 0,
        'currency', 'EGP', 'originalAmount', v_total_cogs, 'exchangeRate', 1,
        'costCenterId', case when v_inv.channel = 'export' then 'cc-export' else 'cc-sales' end,
        'description', format('تكلفة مبيعات فاتورة %s (FIFO)', v_inv.invoice_number)
      ),
      jsonb_build_object(
        'accountId', v_fg_acc,
        'accountCode', v_fg_code,
        'debit', 0, 'credit', v_total_cogs,
        'currency', 'EGP', 'originalAmount', v_total_cogs, 'exchangeRate', 1,
        'costCenterId', case when v_inv.channel = 'export' then 'cc-export' else 'cc-sales' end,
        'description', format('صرف مخزون تام لفاتورة %s', v_inv.invoice_number)
      )
    );

    select * into v_jres
      from fin.post_journal(
        v_inv.date,
        v_inv.invoice_number,
        format('تكلفة مبيعات فاتورة %s', v_inv.invoice_number),
        'sales_invoice',
        v_journal,
        coalesce(nullif(trim(p_created_by), ''), 'system'),
        v_idem || ':cogs'
      );

    if not coalesce(v_jres.success, false) then
      raise exception 'COGS journal was rejected (%); inventory issuance rolled back', v_jres.error;
    end if;

    v_journal_id := v_jres.entry_id;
    v_journal_number := v_jres.entry_number;

    if v_journal_id is null then
      raise exception 'fin.post_journal reported success without a journal id for invoice %; inventory issuance rolled back', v_inv.invoice_number;
    end if;

    v_journal_posted := null;
    select e.is_posted, e.entry_number
      into v_journal_posted, v_journal_number
      from fin.journal_entries e
     where e.id = v_journal_id;

    if not coalesce(v_journal_posted, false) then
      raise exception 'the COGS journal % for invoice % is missing or not posted; inventory issuance rolled back',
        coalesce(v_journal_number, v_journal_id), v_inv.invoice_number;
    end if;

    if not exists (
      select 1 from fin.journal_entries e
       where e.id = v_journal_id
         and (e.reference = v_inv.invoice_number or e.source_document_id = v_inv.id)
    ) then
      raise exception 'the COGS journal % is not linked to invoice % (reference/source_document_id); inventory issuance rolled back',
        coalesce(v_journal_number, v_journal_id), v_inv.invoice_number;
    end if;

    select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
      into v_dr, v_cr
      from fin.journal_lines l
     where l.journal_entry_id = v_journal_id;

    if v_dr <= 0 or abs(v_dr - v_cr) > 0.01 or abs(v_dr - v_total_cogs) > 0.01 then
      raise exception 'the COGS journal % is not balanced for invoice % (debit %, credit %, expected %); inventory issuance rolled back',
        coalesce(v_journal_number, v_journal_id), v_inv.invoice_number, v_dr, v_cr, v_total_cogs;
    end if;

    -- Deliberately NOT updating sales.invoices.journal_entry_id here: that
    -- column is the invoice's link to its SALES journal. Overwriting it with the
    -- COGS entry would leave the invoice with no pointer to revenue/VAT and would
    -- make later reads (and the integrated retry) report the COGS entry as the
    -- sales entry. The COGS journal is linked to the invoice by its document
    -- reference (reference = invoice_number / source_document_id = invoice id).
  end if;

  insert into fin.rpc_idempotency (key, invoice_id)
  values (v_idem, v_inv.id)
  on conflict (key) do nothing;

  return query select v_inv.invoice_number, v_total_cogs, v_journal_number,
    'issued'::text, true, null::text;
end
$function$;

comment on function public.post_sales_inventory_issue(text, text, text) is
  'Atomically issues FIFO inventory and posts COGS for one posted sales invoice. TEST-only, opt-in per invoice. Never auto-applies to historical invoices.';

revoke all on function public.post_sales_inventory_issue(text, text, text) from public;
revoke all on function public.post_sales_inventory_issue(text, text, text) from anon;
grant execute on function public.post_sales_inventory_issue(text, text, text) to authenticated;
