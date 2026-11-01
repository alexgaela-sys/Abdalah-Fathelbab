-- =============================================================================
-- qa_snakdip_invoice_receipt_harness.sql
-- SnakDip TEST-DB harness for the integrated sales posting path (TEST only).
--
-- What this is:
--   A single-file, single-transaction psql harness that exercises
--   public.post_sales_invoice_integrated and its failure/retry modes, then
--   ROLLBACKs so nothing it creates survives.
--
-- What this is NOT:
--   - It does not touch Production, localStorage, ERP POS data, or cloud state.
--   - It does not run connectivity smoke tests or warehouse tests.
--   - It does not create accounts, mappings, periods, units, items, customers or
--     warehouses. Those are preconditions and are verified read-only below; if
--     one is missing or invalid the harness aborts BEFORE the first write and
--     names exactly what is missing.
--   - It runs no posting RPC until that preflight passes.
--
-- Contract asserted (from supabase/114 and supabase/116, not from comments):
--   1. no stock  -> companion refuses -> wrapper RAISES -> no invoice, no line,
--      no journal, no movement, no idempotency row survives;
--   2. success   -> invoice posted, sales journal is a real posted balanced entry
--      of 570 and is what sales.invoices.journal_entry_id points at, FIFO issue
--      is 6 units at cost 60 (5 paid + 1 bonus), COGS journal is a DIFFERENT
--      posted balanced entry of 60 linked to the invoice;
--   3. repeat    -> same key -> already_posted, no new invoice/movement/journal,
--      and the invoice still points at the SALES journal;
--   4. forced post-sales failure (oversized quantity) -> raises -> the whole
--      call rolls back and the earlier successful invoice is untouched.
--
-- Run (psql only; the transaction is rolled back at the end):
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f scripts/qa_snakdip_invoice_receipt_harness.sql
--
-- Guardian notes (third-party services, integrations, credentials):
--   - No webhook callbacks, message queue, payment gateway, email/SMS provider,
--     OCR/scanning service, or approval routing middleware is involved. The only
--     integration point is the Supabase RPC boundary itself.
--   - No password, API key, or connection string is read, printed, or changed.
--   - DO NOT run this against a database that contains real customer balances or
--     live warehouse stock.
-- =============================================================================

\set ON_ERROR_STOP on
\encoding UTF8

begin;

-- ---------------------------------------------------------------------
-- 0) Result tables (rolled back with the transaction).
-- ---------------------------------------------------------------------
create temporary table qa_res
  (name text primary key, status text, detail text) on commit drop;

create temporary table qa_ctx
  (invoice_number text, invoice_id text, sales_journal_id text, cogs_journal_id text)
  on commit drop;

create temporary table qa_base
  (label text primary key, n bigint) on commit drop;

insert into qa_base
select 'sales.invoices',           count(*) from sales.invoices
union all select 'sales.invoice_lines',    count(*) from sales.invoice_lines
union all select 'inventory.transactions', count(*) from inventory.transactions
union all select 'inventory.batches',      count(*) from inventory.batches
union all select 'fin.journal_entries',    count(*) from fin.journal_entries
union all select 'fin.journal_lines',      count(*) from fin.journal_lines
union all select 'fin.rpc_idempotency',    count(*) from fin.rpc_idempotency;

-- ---------------------------------------------------------------------
-- 1) PREFLIGHT — read only. Nothing is written if any requirement fails.
--    Uses the known TEST state: the COGS account is qa-fifo-acc-cogs, the
--    cash_treasury mapping currently points at the receivables account, and no
--    FIFO layer / base unit has been proven for the QA item. Those are checked,
--    not assumed.
-- ---------------------------------------------------------------------
do $preflight$
declare
  v_missing text := '';
  v_n       int;
  v_unit    text;
  v_stock   numeric;
  v_cash    text;
  v_ar      text;
  v_key     text;
  v_acct    text;
  v_hdr     boolean;
begin
  -- Functions the integrated path depends on.
  if to_regprocedure('public.post_sales_invoice_integrated(text,text,text,text,text,numeric,date,jsonb,text,text)') is null then
    v_missing := v_missing || 'function public.post_sales_invoice_integrated(text,text,text,text,text,numeric,date,jsonb,text,text); ';
  end if;
  if to_regprocedure('public.post_sales_inventory_issue(text,text,text)') is null then
    v_missing := v_missing || 'function public.post_sales_inventory_issue(text,text,text); ';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'post_sales_invoice'
  ) then
    v_missing := v_missing || 'function public.post_sales_invoice; ';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'fin' and p.proname = 'post_journal'
  ) then
    v_missing := v_missing || 'function fin.post_journal; ';
  end if;
  if to_regclass('fin.rpc_idempotency') is null then
    v_missing := v_missing || 'table fin.rpc_idempotency; ';
  end if;

  -- Master fixtures (must already exist; never invented here).
  select count(*) into v_n from core.items where id = 'qa-e2e-item-01' and active;
  if v_n = 0 then
    v_missing := v_missing || 'core.items qa-e2e-item-01 (missing or inactive); ';
  else
    v_unit := null;
    begin
      select i.base_unit_id into v_unit from core.items i where i.id = 'qa-e2e-item-01';
    exception when undefined_table or undefined_column then
      v_missing := v_missing || 'core.items.base_unit_id (column unreadable); ';
      v_unit := null;
    end;
    if v_unit is null then
      v_missing := v_missing || 'base unit for qa-e2e-item-01 (core.items.base_unit_id is empty — the invoice RPC cannot resolve UoM); ';
    elsif not exists (select 1 from core.units u where u.id = v_unit) then
      v_missing := v_missing || format('core.units row %s referenced by qa-e2e-item-01; ', v_unit);
    end if;
  end if;

  select count(*) into v_n from core.customers where id = 'qa-e2e-cust-01' and active;
  if v_n = 0 then
    v_missing := v_missing || 'core.customers qa-e2e-cust-01 (missing or inactive); ';
  end if;

  select count(*) into v_n from core.warehouses where id = 'qa-e2e-wh-01' and active;
  if v_n = 0 then
    v_missing := v_missing || 'core.warehouses qa-e2e-wh-01 (missing or inactive); ';
  end if;

  -- Open accounting period covering the harness date (2026-10-25).
  select count(*) into v_n
    from core.accounting_periods p
   where p.start_date <= date '2026-10-25'
     and p.end_date   >= date '2026-10-25'
     and p.is_closed = false;
  if v_n = 0 then
    v_missing := v_missing || 'an OPEN core.accounting_periods row covering 2026-10-25; ';
  end if;

  -- Account mappings: each key must resolve to an existing, non-header account.
  foreach v_key in array array[
    'cogs_local', 'inventory_finished_local',
    'customer_receivable_local', 'sales_retail_revenue', 'sales_vat_output',
    'cash_treasury'
  ]
  loop
    v_acct := null;
    v_hdr  := null;
    select m.account_id into v_acct
      from core.account_mappings m
     where m.key = v_key
     limit 1;

    if v_acct is null then
      v_missing := v_missing || format('core.account_mappings %s; ', v_key);
      continue;
    end if;

    select a.is_header into v_hdr from core.accounts a where a.id = v_acct;
    if not found then
      v_missing := v_missing || format('core.accounts %s (mapped by %s); ', v_acct, v_key);
    elsif coalesce(v_hdr, false) then
      v_missing := v_missing || format('detail account for %s (currently points at header %s); ', v_key, v_acct);
    end if;
  end loop;

  -- Known TEST defect: cash_treasury currently points at the receivables
  -- account. A "cash" invoice would then debit receivables and still balance,
  -- so the happy path would silently prove the wrong accounting. Refuse it.
  select m.account_id into v_cash
    from core.account_mappings m where m.key = 'cash_treasury' limit 1;
  select m.account_id into v_ar
    from core.account_mappings m where m.key = 'customer_receivable_local' limit 1;
  if v_cash is not null and v_ar is not null and v_cash = v_ar then
    v_missing := v_missing || format('a valid cash account: cash_treasury points at the receivables account (%s), so a cash invoice would debit AR instead of treasury — fix core.account_mappings.cash_treasury before testing; ', v_cash);
  end if;

  -- The no-stock leg is only meaningful on an empty warehouse/item combination.
  select coalesce(sum(b.quantity), 0) into v_stock
    from inventory.batches b
   where b.item_id = 'qa-e2e-item-01'
     and b.warehouse_id = 'qa-e2e-wh-01'
     and b.quantity > 0;
  if v_stock > 0 then
    v_missing := v_missing || format('%s unit(s) of qa-e2e-item-01 already in qa-e2e-wh-01 — the no-stock leg cannot be proven without touching real stock; run this harness on an empty QA warehouse; ', v_stock);
  end if;

  -- Leftover fixture ids from an aborted run would invalidate the assertions.
  if exists (select 1 from inventory.batches where id = 'qa-snk-bat-1') then
    v_missing := v_missing || 'clean fixture id inventory.batches qa-snk-bat-1 (already exists); ';
  end if;
  if exists (select 1 from inventory.transactions where id = 'qa-snk-rcv-1') then
    v_missing := v_missing || 'clean fixture id inventory.transactions qa-snk-rcv-1 (already exists); ';
  end if;
  if exists (select 1 from fin.rpc_idempotency where key like 'qa-snk-key-%') then
    v_missing := v_missing || 'clean idempotency keys qa-snk-key-* (already exist); ';
  end if;

  if v_missing <> '' then
    raise exception 'QA preflight failed — NOTHING was written. Resolve: %', v_missing;
  end if;
end
$preflight$;

-- ---------------------------------------------------------------------
-- 2) FAIL-CLOSED: no FIFO layer exists yet, so the companion must refuse and
--    the wrapper must RAISE, leaving zero partial writes behind.
-- ---------------------------------------------------------------------
do $failclosed$
declare
  v_err text := null;
  r record;
  v_inv_before int; v_inv_after int;
  v_line_before int; v_line_after int;
  v_je_before int;  v_je_after int;
  v_jl_before int;  v_jl_after int;
  v_tx_before int;  v_tx_after int;
  v_idem_before int; v_idem_after int;
begin
  select count(*) into v_inv_before  from sales.invoices;
  select count(*) into v_line_before from sales.invoice_lines;
  select count(*) into v_je_before   from fin.journal_entries;
  select count(*) into v_jl_before   from fin.journal_lines;
  select count(*) into v_tx_before   from inventory.transactions;
  select count(*) into v_idem_before from fin.rpc_idempotency;

  begin
    select * into r
      from public.post_sales_invoice_integrated(
        'qa-e2e-cust-01', 'retail', 'qa-e2e-wh-01', 'cash',
        'EGP', 1, '2026-10-25',
        '[{"itemId":"qa-e2e-item-01","quantity":5,"freeQuantity":0,
          "unitPrice":100,"discount":0,"vatRate":0.14}]',
        'qa', 'qa-snk-key-no-stock');
  exception when others then
    v_err := SQLERRM;
  end;

  select count(*) into v_inv_after  from sales.invoices;
  select count(*) into v_line_after from sales.invoice_lines;
  select count(*) into v_je_after   from fin.journal_entries;
  select count(*) into v_jl_after   from fin.journal_lines;
  select count(*) into v_tx_after   from inventory.transactions;
  select count(*) into v_idem_after from fin.rpc_idempotency;

  insert into qa_res values
    ('FAILCLOSED_no_stock_raises',
      case when v_err is not null
                and (v_err like '%لا يكفي%' or v_err like '%الرصيد%')
           then 'PASS' else 'FAIL' end,
      coalesce(v_err, 'NO EXCEPTION RAISED — the wrapper must raise when issuance fails')),
    ('FAILCLOSED_no_partial_invoice',
      case when v_inv_before = v_inv_after and v_line_before = v_line_after then 'PASS' else 'FAIL' end,
      format('invoices %s->%s, lines %s->%s', v_inv_before, v_inv_after, v_line_before, v_line_after)),
    ('FAILCLOSED_no_partial_journal',
      case when v_je_before = v_je_after and v_jl_before = v_jl_after then 'PASS' else 'FAIL' end,
      format('entries %s->%s, lines %s->%s', v_je_before, v_je_after, v_jl_before, v_jl_after)),
    ('FAILCLOSED_no_partial_movement',
      case when v_tx_before = v_tx_after then 'PASS' else 'FAIL' end,
      format('inventory.transactions %s->%s', v_tx_before, v_tx_after)),
    ('FAILCLOSED_no_partial_idempotency',
      case when v_idem_before = v_idem_after then 'PASS' else 'FAIL' end,
      format('fin.rpc_idempotency %s->%s', v_idem_before, v_idem_after));
end
$failclosed$;

-- ---------------------------------------------------------------------
-- 3) HAPPY PATH: one isolated FIFO layer (rolled back), then integrated post.
-- ---------------------------------------------------------------------
do $happy$
declare
  v_err            text := null;
  r                record;
  v_inv_no         text;
  v_inv_id         text;
  v_status         text;
  v_stock_source   text;
  v_wh             text;
  v_subtotal       numeric;
  v_vat            numeric;
  v_total          numeric;
  v_cogs_total     numeric;
  v_je_id          text;
  v_sales_posted   boolean;
  v_sales_dr       numeric;
  v_sales_cr       numeric;
  v_cogs_id        text;
  v_cogs_no        text;
  v_cogs_count     int;
  v_cogs_dr        numeric;
  v_cogs_cr        numeric;
  v_tx_count       int;
  v_tx_qty         numeric;
  v_tx_cost        numeric;
  v_bat_qty        numeric;
  v_bat            numeric;
  v_ok             boolean := false;
  v_status_out     text;
  v_cogs_out       numeric;
  v_jr_out         text;
  v_err_out        text;
begin
  -- Isolated layer: 10 units @ 10, produced 2026-01-10 (oldest possible layer).
  insert into inventory.batches
    (id, item_id, warehouse_id, batch_number, production_date, expiry_date,
     quantity, unit_cost, active)
  values
    ('qa-snk-bat-1', 'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-SNK-A', '2026-01-10', null,
     10, 10, true);

  insert into inventory.transactions
    (id, date, document_type, document_number, movement_type,
     item_id, warehouse_id, batch_number, quantity_in, quantity_out,
     balance_after, unit_cost, total_cost, notes, created_by, is_test)
  values
    ('qa-snk-rcv-1', '2026-10-01', 'إيصال استلام', 'QA-SNK-RCV',
     'purchase_receipt',
     'qa-e2e-item-01', 'qa-e2e-wh-01', 'QA-SNK-A',
     10, 0, 10, 10, 100, 'QA fixture (rolled back)', 'qa', true);

  select coalesce(sum(quantity), 0) into v_bat
    from inventory.batches
   where id = 'qa-snk-bat-1';
  insert into qa_res values
    ('FIXTURE_layer_10_units',
      case when v_bat = 10 then 'PASS' else 'FAIL' end,
      v_bat::text);

  begin
    select * into r
      from public.post_sales_invoice_integrated(
        'qa-e2e-cust-01', 'retail', 'qa-e2e-wh-01', 'cash',
        'EGP', 1, '2026-10-25',
        '[{"itemId":"qa-e2e-item-01","quantity":5,"freeQuantity":1,
          "unitPrice":100,"discount":0,"vatRate":0.14}]',
        'qa', 'qa-snk-key-success');
    -- Copy out of the record immediately: if the call raised, r is unassigned
    -- and touching r.<field> would abort the whole block.
    v_ok         := coalesce(r.out_success, false);
    v_status_out := r.out_status;
    v_cogs_out   := r.out_cogs;
    v_jr_out     := r.out_journal_number;
    v_err_out    := r.out_error;
    v_inv_no     := r.out_invoice_number;
  exception when others then
    v_err := SQLERRM;
  end;

  insert into qa_res values
    ('HAPPY_issue_returns_success',
      case when v_err is null and v_ok and v_status_out = 'issued'
           then 'PASS' else 'FAIL' end,
      coalesce(v_err, v_err_out, v_status_out, 'no result')),
    ('HAPPY_cogs_equals_60',
      case when v_err is null and v_cogs_out = 60 then 'PASS' else 'FAIL' end,
      coalesce(v_cogs_out::text, 'null')),
    ('HAPPY_invoice_number_present',
      case when v_inv_no is not null and v_inv_no <> '' then 'PASS' else 'FAIL' end,
      coalesce(v_inv_no, 'null')),
    ('HAPPY_journal_number_present',
      case when v_err is null and coalesce(v_jr_out, '') <> '' then 'PASS' else 'FAIL' end,
      coalesce(v_jr_out, 'null'));

  if v_inv_no is null then
    insert into qa_res values
      ('READBACK_invoice_exists', 'FAIL', 'no invoice number returned');
    return;
  end if;

  select i.id, i.status, i.stock_source, i.warehouse_id,
         i.subtotal, i.vat_amount, i.total_amount, i.cogs_total, i.journal_entry_id
    into v_inv_id, v_status, v_stock_source, v_wh,
         v_subtotal, v_vat, v_total, v_cogs_total, v_je_id
    from sales.invoices i
   where i.invoice_number = v_inv_no;

  if v_inv_id is null then
    insert into qa_res values
      ('READBACK_invoice_exists', 'FAIL', 'no invoice row for ' || v_inv_no);
    return;
  end if;

  insert into qa_ctx values (v_inv_no, v_inv_id, v_je_id, null);

  insert into qa_res values
    ('READBACK_invoice_exists', 'PASS', v_inv_id),
    ('READBACK_status_posted',
      case when v_status = 'posted' then 'PASS' else 'FAIL' end, coalesce(v_status, 'null')),
    ('READBACK_warehouse_stock',
      case when v_wh = 'qa-e2e-wh-01' and v_stock_source = 'warehouse' then 'PASS' else 'FAIL' end,
      coalesce(v_wh, 'null') || '/' || coalesce(v_stock_source, 'null')),
    ('READBACK_cogs_60',
      case when coalesce(v_cogs_total, -1) = 60 then 'PASS' else 'FAIL' end,
      coalesce(v_cogs_total::text, 'null')),
    ('READBACK_totals_500_70_570',
      case when v_subtotal = 500 and v_vat = 70 and v_total = 570 then 'PASS' else 'FAIL' end,
      coalesce(v_subtotal::text, 'null') || '/' || coalesce(v_vat::text, 'null') || '/' || coalesce(v_total::text, 'null'));

  -- FIFO issue: one movement row, 6 units (5 paid + 1 bonus), cost 60.
  select count(*), coalesce(sum(t.quantity_out), 0), coalesce(sum(t.total_cost), 0)
    into v_tx_count, v_tx_qty, v_tx_cost
    from inventory.transactions t
   where t.document_number = v_inv_no
     and t.movement_type = 'sales';

  insert into qa_res values
    ('READBACK_one_sales_movement',
      case when v_tx_count = 1 then 'PASS' else 'FAIL' end, v_tx_count::text),
    ('READBACK_movement_qty_6',
      case when v_tx_qty = 6 then 'PASS' else 'FAIL' end, v_tx_qty::text),
    ('READBACK_movement_cost_60',
      case when v_tx_cost = 60 then 'PASS' else 'FAIL' end, v_tx_cost::text);

  select coalesce(sum(b.quantity), 0) into v_bat_qty
    from inventory.batches b
   where b.item_id = 'qa-e2e-item-01' and b.warehouse_id = 'qa-e2e-wh-01';

  insert into qa_res values
    ('READBACK_batch_reduced_to_4',
      case when v_bat_qty = 4 then 'PASS' else 'FAIL' end, v_bat_qty::text);

  -- Sales journal: must be the entry sales.invoices.journal_entry_id points at,
  -- posted, balanced, and equal to the invoice EGP total (570).
  select e.is_posted into v_sales_posted
    from fin.journal_entries e where e.id = v_je_id;

  select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
    into v_sales_dr, v_sales_cr
    from fin.journal_lines l
   where l.journal_entry_id = v_je_id;

  insert into qa_res values
    ('SALES_journal_linked_by_invoice',
      case when v_je_id is not null then 'PASS' else 'FAIL' end,
      coalesce(v_je_id, 'null')),
    ('SALES_journal_posted_balanced_570',
      case when coalesce(v_sales_posted, false)
                and abs(v_sales_dr - v_sales_cr) < 0.01
                and v_sales_dr = 570
           then 'PASS' else 'FAIL' end,
      coalesce(v_sales_dr::text, 'null') || '/' || coalesce(v_sales_cr::text, 'null'));

  -- COGS journal: a DIFFERENT posted entry linked to the invoice, balanced 60.
  select count(*) into v_cogs_count
    from fin.journal_entries e
   where (e.reference = v_inv_no or e.source_document_id = v_inv_id)
     and e.is_posted = true
     and e.id is distinct from v_je_id;

  select e.id, e.entry_number into v_cogs_id, v_cogs_no
    from fin.journal_entries e
   where (e.reference = v_inv_no or e.source_document_id = v_inv_id)
     and e.is_posted = true
     and e.id is distinct from v_je_id
   order by e.entry_number desc
   limit 1;

  select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
    into v_cogs_dr, v_cogs_cr
    from fin.journal_lines l
   where l.journal_entry_id = v_cogs_id;

  update qa_ctx set cogs_journal_id = v_cogs_id where invoice_id = v_inv_id;

  insert into qa_res values
    ('COGS_one_linked_journal',
      case when v_cogs_count = 1 then 'PASS' else 'FAIL' end, v_cogs_count::text),
    ('COGS_journal_differs_from_sales',
      case when v_cogs_id is not null and v_cogs_id is distinct from v_je_id then 'PASS' else 'FAIL' end,
      coalesce(v_cogs_id, 'null')),
    ('COGS_journal_number_matches_result',
      case when v_cogs_no is not null and v_cogs_no = v_jr_out then 'PASS' else 'FAIL' end,
      coalesce(v_cogs_no, 'null') || ' vs ' || coalesce(v_jr_out, 'null')),
    ('COGS_journal_balanced_60',
      case when abs(v_cogs_dr - v_cogs_cr) < 0.01 and v_cogs_dr = 60 then 'PASS' else 'FAIL' end,
      coalesce(v_cogs_dr::text, 'null') || '/' || coalesce(v_cogs_cr::text, 'null'));

  -- The invoice must still point at the SALES journal after the COGS step.
  insert into qa_res values
    ('INVOICE_journal_link_not_overwritten',
      case when v_je_id is not null and v_je_id is distinct from v_cogs_id then 'PASS' else 'FAIL' end,
      coalesce(v_je_id, 'null') || ' vs cogs ' || coalesce(v_cogs_id, 'null'));
end
$happy$;

-- ---------------------------------------------------------------------
-- 4) REPEAT with the same key -> already_posted, no second write, and the
--    invoice still points at the same SALES journal.
-- ---------------------------------------------------------------------
do $repeat$
declare
  v_before_inv  int;
  v_after_inv   int;
  v_before_tx   int;
  v_after_tx    int;
  v_before_je   int;
  v_after_je    int;
  v_err         text := null;
  r             record;
  v_inv_id      text;
  v_inv_no      text;
  v_sales_je    text;
  v_cogs_je     text;
  v_now_sales   text;
  v_now_no      text;
  v_ok          boolean := false;
  v_status_out  text;
  v_jr_out      text;
  v_err_out     text;
begin
  select invoice_id, invoice_number, sales_journal_id, cogs_journal_id
    into v_inv_id, v_inv_no, v_sales_je, v_cogs_je
    from qa_ctx
   limit 1;

  if v_inv_id is null then
    insert into qa_res values
      ('REPEAT_returns_already_posted', 'FAIL', 'no successful invoice from the happy path to retry');
    return;
  end if;

  select count(*) into v_before_inv from sales.invoices;
  select count(*) into v_before_tx
    from inventory.transactions
   where document_number = v_inv_no and movement_type = 'sales';
  select count(*) into v_before_je
    from fin.journal_entries
   where (reference = v_inv_no or source_document_id = v_inv_id) and is_posted = true;

  begin
    select * into r
      from public.post_sales_invoice_integrated(
        'qa-e2e-cust-01', 'retail', 'qa-e2e-wh-01', 'cash',
        'EGP', 1, '2026-10-25',
        '[{"itemId":"qa-e2e-item-01","quantity":5,"freeQuantity":1,
          "unitPrice":100,"discount":0,"vatRate":0.14}]',
        'qa', 'qa-snk-key-success');
    v_ok         := coalesce(r.out_success, false);
    v_status_out := r.out_status;
    v_jr_out     := r.out_journal_number;
    v_err_out    := r.out_error;
  exception when others then
    v_err := SQLERRM;
  end;

  select count(*) into v_after_inv from sales.invoices;
  select count(*) into v_after_tx
    from inventory.transactions
   where document_number = v_inv_no and movement_type = 'sales';
  select count(*) into v_after_je
    from fin.journal_entries
   where (reference = v_inv_no or source_document_id = v_inv_id) and is_posted = true;

  insert into qa_res values
    ('REPEAT_returns_already_posted',
      case when v_err is null and v_ok and v_status_out = 'already_posted'
           then 'PASS' else 'FAIL' end,
      coalesce(v_err, v_err_out, v_status_out, 'no result')),
    ('REPEAT_invoice_count_unchanged',
      case when v_before_inv = v_after_inv then 'PASS' else 'FAIL' end,
      format('%s->%s', v_before_inv, v_after_inv)),
    ('REPEAT_movement_count_unchanged',
      case when v_before_tx = v_after_tx then 'PASS' else 'FAIL' end,
      format('%s->%s', v_before_tx, v_after_tx)),
    ('REPEAT_journal_count_unchanged',
      case when v_before_je = v_after_je then 'PASS' else 'FAIL' end,
      format('%s->%s', v_before_je, v_after_je));

  select journal_entry_id into v_now_sales from sales.invoices where id = v_inv_id;

  insert into qa_res values
    ('REPEAT_sales_link_unchanged',
      case when v_now_sales is not null and v_now_sales = v_sales_je then 'PASS' else 'FAIL' end,
      coalesce(v_now_sales, 'null') || ' vs ' || coalesce(v_sales_je, 'null')),
    ('REPEAT_returns_cogs_journal',
      case when v_err is null
                and coalesce(v_jr_out, '') <> ''
                and v_jr_out = v_cogs_je
           then 'PASS' else 'FAIL' end,
      coalesce(v_jr_out, 'null') || ' vs ' || coalesce(v_cogs_je, 'null'));
end
$repeat$;

-- ---------------------------------------------------------------------
-- 5) FORCED POST-SALES FAILURE: an invoice large enough to exhaust the layer
--    must raise AFTER the sales-side write and roll the whole call back.
-- ---------------------------------------------------------------------
do $forced$
declare
  v_err text := null;
  r record;
  v_inv_no text;
  v_inv_id text;
  v_before_inv int; v_after_inv int;
  v_before_line int; v_after_line int;
  v_before_je int; v_after_je int;
  v_before_jl int; v_after_jl int;
  v_before_tx int; v_after_tx int;
  v_before_idem int; v_after_idem int;
  v_bat numeric;
  v_ok_tx int;
  v_ok_cogs int;
begin
  select invoice_id, invoice_number into v_inv_id, v_inv_no from qa_ctx limit 1;

  select count(*) into v_before_inv  from sales.invoices;
  select count(*) into v_before_line from sales.invoice_lines;
  select count(*) into v_before_je   from fin.journal_entries;
  select count(*) into v_before_jl   from fin.journal_lines;
  select count(*) into v_before_tx   from inventory.transactions;
  select count(*) into v_before_idem from fin.rpc_idempotency;

  begin
    select * into r
      from public.post_sales_invoice_integrated(
        'qa-e2e-cust-01', 'retail', 'qa-e2e-wh-01', 'cash',
        'EGP', 1, '2026-10-25',
        '[{"itemId":"qa-e2e-item-01","quantity":1000,"freeQuantity":0,
          "unitPrice":100,"discount":0,"vatRate":0.14}]',
        'qa', 'qa-snk-key-forced-fail');
  exception when others then
    v_err := SQLERRM;
  end;

  select count(*) into v_after_inv  from sales.invoices;
  select count(*) into v_after_line from sales.invoice_lines;
  select count(*) into v_after_je   from fin.journal_entries;
  select count(*) into v_after_jl   from fin.journal_lines;
  select count(*) into v_after_tx   from inventory.transactions;
  select count(*) into v_after_idem from fin.rpc_idempotency;

  select coalesce(sum(quantity), 0) into v_bat
    from inventory.batches b
   where b.item_id = 'qa-e2e-item-01' and b.warehouse_id = 'qa-e2e-wh-01';

  select count(*) into v_ok_tx
    from inventory.transactions
   where document_number = v_inv_no and movement_type = 'sales';

  select count(*) into v_ok_cogs
    from fin.journal_entries e
   where (e.reference = v_inv_no or e.source_document_id = v_inv_id)
     and e.is_posted = true
     and e.id is distinct from (select journal_entry_id from sales.invoices where id = v_inv_id);

  insert into qa_res values
    ('FORCED_failure_raises',
      case when v_err is not null
                and (v_err like '%لا يكفي%' or v_err like '%الرصيد%')
           then 'PASS' else 'FAIL' end,
      coalesce(v_err, 'NO EXCEPTION RAISED for an unfulfillable quantity')),
    ('FORCED_no_partial_invoice',
      case when v_before_inv = v_after_inv and v_before_line = v_after_line then 'PASS' else 'FAIL' end,
      format('invoices %s->%s, lines %s->%s', v_before_inv, v_after_inv, v_before_line, v_after_line)),
    ('FORCED_no_partial_journal',
      case when v_before_je = v_after_je and v_before_jl = v_after_jl then 'PASS' else 'FAIL' end,
      format('entries %s->%s, lines %s->%s', v_before_je, v_after_je, v_before_jl, v_after_jl)),
    ('FORCED_no_partial_movement',
      case when v_before_tx = v_after_tx then 'PASS' else 'FAIL' end,
      format('%s->%s', v_before_tx, v_after_tx)),
    ('FORCED_no_partial_idempotency',
      case when v_before_idem = v_after_idem then 'PASS' else 'FAIL' end,
      format('%s->%s', v_before_idem, v_after_idem)),
    ('FORCED_stock_unchanged_4',
      case when v_bat = 4 then 'PASS' else 'FAIL' end, v_bat::text),
    ('FORCED_previous_invoice_intact',
      case when v_ok_tx = 1 and v_ok_cogs = 1 then 'PASS' else 'FAIL' end,
      format('movements=%s cogs_entries=%s', v_ok_tx, v_ok_cogs));
end
$forced$;

-- ---------------------------------------------------------------------
-- 6) Verdict
-- ---------------------------------------------------------------------
\echo ''
\echo '=== qa_snakdip_invoice_receipt_harness verdict (all synthetic, rolled back) ==='
select name, status as verdict, detail
  from qa_res
 order by case name
           when 'FAILCLOSED_no_stock_raises'          then 1
           when 'FAILCLOSED_no_partial_invoice'       then 2
           when 'FAILCLOSED_no_partial_journal'       then 3
           when 'FAILCLOSED_no_partial_movement'      then 4
           when 'FAILCLOSED_no_partial_idempotency'   then 5
           when 'FIXTURE_layer_10_units'              then 6
           when 'HAPPY_issue_returns_success'         then 7
           when 'HAPPY_cogs_equals_60'                then 8
           when 'HAPPY_invoice_number_present'        then 9
           when 'HAPPY_journal_number_present'        then 10
           when 'READBACK_invoice_exists'             then 11
           when 'READBACK_status_posted'              then 12
           when 'READBACK_warehouse_stock'            then 13
           when 'READBACK_cogs_60'                    then 14
           when 'READBACK_totals_500_70_570'          then 15
           when 'READBACK_one_sales_movement'         then 16
           when 'READBACK_movement_qty_6'             then 17
           when 'READBACK_movement_cost_60'           then 18
           when 'READBACK_batch_reduced_to_4'         then 19
           when 'SALES_journal_linked_by_invoice'     then 20
           when 'SALES_journal_posted_balanced_570'   then 21
           when 'COGS_one_linked_journal'             then 22
           when 'COGS_journal_differs_from_sales'     then 23
           when 'COGS_journal_number_matches_result'  then 24
           when 'COGS_journal_balanced_60'            then 25
           when 'INVOICE_journal_link_not_overwritten' then 26
           when 'REPEAT_returns_already_posted'       then 27
           when 'REPEAT_invoice_count_unchanged'      then 28
           when 'REPEAT_movement_count_unchanged'     then 29
           when 'REPEAT_journal_count_unchanged'      then 30
           when 'REPEAT_sales_link_unchanged'         then 31
           when 'REPEAT_returns_cogs_journal'         then 32
           when 'FORCED_failure_raises'               then 33
           when 'FORCED_no_partial_invoice'           then 34
           when 'FORCED_no_partial_journal'           then 35
           when 'FORCED_no_partial_movement'          then 36
           when 'FORCED_no_partial_idempotency'       then 37
           when 'FORCED_stock_unchanged_4'            then 38
           when 'FORCED_previous_invoice_intact'      then 39
           else 99
         end,
         name;

with s as (select count(*)::int as failures from qa_res where status = 'FAIL')
select (select count(*) from qa_res) as checks, (select failures from s) as failures;

\echo ''
\echo '=== row counts now vs baseline (must be equal; ROLLBACK below discards everything) ==='
select b.label, b.n as baseline,
       case b.label
         when 'sales.invoices'           then (select count(*) from sales.invoices)
         when 'sales.invoice_lines'      then (select count(*) from sales.invoice_lines)
         when 'inventory.transactions'   then (select count(*) from inventory.transactions)
         when 'inventory.batches'        then (select count(*) from inventory.batches)
         when 'fin.journal_entries'      then (select count(*) from fin.journal_entries)
         when 'fin.journal_lines'        then (select count(*) from fin.journal_lines)
         when 'fin.rpc_idempotency'      then (select count(*) from fin.rpc_idempotency)
       end as now_n
  from qa_base b
 order by b.label;

rollback;

\echo ''
\echo '=== transaction rolled back: nothing from this run persisted ==='
