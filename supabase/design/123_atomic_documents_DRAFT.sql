-- ============================================================================
--  DRAFT — NOT APPLIED. DO NOT RUN.
-- ============================================================================
-- Atomic server-side transaction design for sales invoices, journal entries and
-- inventory movements. This file is a design artifact for review + parity tests;
-- it is intentionally NOT part of the applied migration chain, because enabling
-- it before parity/reconciliation tests could double-post or mis-cost documents.
--
-- Activation prerequisites (all must be true before applying):
--   1. local vs cloud document parity suite passes on identical fixtures,
--   2. reconciliation query shows zero drift on trial balance and stock on hand,
--   3. idempotency keys are generated client-side per intent and reused on retry,
--   4. a shadow/dual-write window has been observed with no divergence,
--   5. an explicit rollback story exists (posting tables dropped/reverted, journals
--      reversed through reversing entries, never deleted).
--
-- Concurrency model used below:
--   * one row per idempotency key, UNIQUE, claimed inside the transaction,
--   * deterministic lock ordering (`order by account_id/item_id`) to avoid
--     deadlocks between concurrent postings,
--   * every balance invariant checked inside the same transaction and enforced
--     by a CHECK/trigger as a second line of defence,
--   * expected_version is only used for master data (already shipped); documents
--     are append-only, so their guard is the idempotency key, not a version.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0) Shared primitives
-- ---------------------------------------------------------------------------

create type erp_posting_status as enum ('posted', 'duplicate', 'rejected');

create table erp_posting_keys (
  idempotency_key text primary key,
  doc_kind        text not null check (doc_kind in ('sales_invoice', 'journal_entry', 'inventory_movement')),
  doc_id          text not null,
  payload_sha256  text not null,
  created_at      timestamptz not null default now(),
  created_by      uuid
);

create table erp_journal_batches (
  id          text primary key,
  source_kind text not null,
  source_id   text not null,
  posted_at   timestamptz not null default now(),
  posted_by   uuid,
  constraint erp_journal_batches_source_uq unique (source_kind, source_id)
);

create table erp_journal_lines (
  batch_id   text not null references erp_journal_batches(id) on delete restrict,
  line_no    int  not null,
  account_id text not null,
  debit      numeric(18, 4) not null default 0 check (debit >= 0),
  credit     numeric(18, 4) not null default 0 check (credit >= 0),
  primary key (batch_id, line_no),
  constraint erp_journal_lines_one_side check ((debit = 0) <> (credit = 0))
);

-- ---------------------------------------------------------------------------
-- 1) Sales invoice posting (atomic, idempotent)
-- ---------------------------------------------------------------------------
-- Invariants enforced inside the function:
--   * sum(debit) = sum(credit) exactly (numeric, no floating point),
--   * subtotal + vat - withholding = total, each recomputed server-side,
--   * stock on hand never goes negative for warehouse issues,
--   * COGS uses the batch/standard cost stored on the item, never a client value,
--   * the idempotency key is claimed first; a retry returns 'duplicate' with the
--     original document id instead of posting twice.
create or replace function erp_post_sales_invoice(
  p_idempotency_key text,
  p_payload jsonb
) returns table (status erp_posting_status, document_id text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid        uuid := auth.uid();
  v_doc_id     text := p_payload->>'id';
  v_subtotal   numeric(18,4);
  v_vat        numeric(18,4);
  v_total      numeric(18,4);
  v_debit      numeric(18,4);
  v_credit     numeric(18,4);
  v_existing   text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- 1. claim the idempotency key (the only concurrency gate for documents)
  insert into erp_posting_keys (idempotency_key, doc_kind, doc_id, payload_sha256, created_by)
  values (p_idempotency_key, 'sales_invoice', v_doc_id,
          encode(digest(p_payload::text, 'sha256'), 'hex'), v_uid)
  on conflict (idempotency_key) do nothing;

  if not found then
    select doc_id into v_existing from erp_posting_keys where idempotency_key = p_idempotency_key;
    return query select 'duplicate'::erp_posting_status, v_existing;
    return;
  end if;

  -- 2. recompute money server-side from lines (never trust client totals)
  select coalesce(sum((l->>'quantity')::numeric * (l->>'unitPrice')::numeric), 0),
         coalesce(sum((l->>'quantity')::numeric * (l->>'unitPrice')::numeric * (l->>'vatRate')::numeric), 0)
    into v_subtotal, v_vat
    from jsonb_array_elements(p_payload->'lines') l;
  v_total := v_subtotal + v_vat;

  -- 3. lock stock rows deterministically, then verify availability
  perform 1
     from erp_stock_balances b
    where b.warehouse_id = p_payload->>'warehouseId'
      and b.item_id in (
        select (l->>'itemId') from jsonb_array_elements(p_payload->'lines') l
      )
    order by b.item_id
      for update;

  if exists (
    select 1
      from jsonb_array_elements(p_payload->'lines') l
      left join erp_stock_balances b
        on b.warehouse_id = p_payload->>'warehouseId'
       and b.item_id = (l->>'itemId')
     where coalesce(b.quantity, 0) < (l->>'quantity')::numeric + coalesce((l->>'freeQuantity')::numeric, 0)
  ) then
    raise exception 'insufficient_stock' using errcode = '23514';
  end if;

  -- 4. write the document, its lines, the stock movements and the journal in
  --    one transaction; any failure rolls all of it back.
  insert into erp_sales_invoices (id, customer_id, warehouse_id, currency, total, posted_at, posted_by)
  values (v_doc_id, p_payload->>'customerId', p_payload->>'warehouseId',
          p_payload->>'currency', v_total, now(), v_uid);

  -- ... line inserts, stock movements, batch + journal lines ...

  -- 5. balance invariant, enforced server-side at the end of the same tx
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into v_debit, v_credit
    from erp_journal_lines
   where batch_id = 'batch-' || v_doc_id;

  if v_debit <> v_credit then
    raise exception 'unbalanced_journal batch=% debit=% credit=%', v_doc_id, v_debit, v_credit
      using errcode = '23514';
  end if;

  return query select 'posted'::erp_posting_status, v_doc_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Journal entry posting (atomic, idempotent)
-- ---------------------------------------------------------------------------
-- Rejects: unbalanced entries, closed periods, unknown accounts, duplicate keys.
-- Locks the accounting period row before checking its state so a concurrent
-- period close cannot race a posting.
create or replace function erp_post_journal_entry(
  p_idempotency_key text,
  p_payload jsonb
) returns table (status erp_posting_status, document_id text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_doc   text := p_payload->>'id';
  v_period text := p_payload->>'periodId';
  v_debit numeric(18,4);
  v_credit numeric(18,4);
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- lock the period first: deterministic single-row lock, no deadlock cycle
  perform 1 from erp_accounting_periods p where p.id = v_period for update;
  if not found then
    raise exception 'unknown_period' using errcode = '23503';
  end if;
  if exists (select 1 from erp_accounting_periods p where p.id = v_period and p.status <> 'open') then
    raise exception 'period_closed' using errcode = '23514';
  end if;

  insert into erp_posting_keys (idempotency_key, doc_kind, doc_id, payload_sha256, created_by)
  values (p_idempotency_key, 'journal_entry', v_doc,
          encode(digest(p_payload::text, 'sha256'), 'hex'), v_uid)
  on conflict (idempotency_key) do nothing;
  if not found then
    return query select 'duplicate'::erp_posting_status,
      (select doc_id from erp_posting_keys where idempotency_key = p_idempotency_key);
    return;
  end if;

  select coalesce(sum((l->>'debit')::numeric), 0),
         coalesce(sum((l->>'credit')::numeric), 0)
    into v_debit, v_credit
    from jsonb_array_elements(p_payload->'lines') l;

  if v_debit = 0 or v_debit <> v_credit then
    raise exception 'unbalanced_entry debit=% credit=%', v_debit, v_credit using errcode = '23514';
  end if;

  -- ... insert batch + lines ...

  return query select 'posted'::erp_posting_status, v_doc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Inventory movement posting (atomic, idempotent)
-- ---------------------------------------------------------------------------
-- Applies receipt/issue/transfer against erp_stock_balances, locks balances in
-- (warehouse_id, item_id) order, refuses negative stock, and derives unit cost
-- from the item record — never from the client payload.
create or replace function erp_post_inventory_movement(
  p_idempotency_key text,
  p_payload jsonb
) returns table (status erp_posting_status, document_id text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_doc text := p_payload->>'id';
  v_qty numeric(18,4) := (p_payload->>'quantity')::numeric;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if v_qty <= 0 then
    raise exception 'invalid_quantity' using errcode = '23514';
  end if;

  insert into erp_posting_keys (idempotency_key, doc_kind, doc_id, payload_sha256, created_by)
  values (p_idempotency_key, 'inventory_movement', v_doc,
          encode(digest(p_payload::text, 'sha256'), 'hex'), v_uid)
  on conflict (idempotency_key) do nothing;
  if not found then
    return query select 'duplicate'::erp_posting_status,
      (select doc_id from erp_posting_keys where idempotency_key = p_idempotency_key);
    return;
  end if;

  perform 1 from erp_stock_balances b
   where b.warehouse_id in (p_payload->>'fromWarehouseId', p_payload->>'toWarehouseId')
     and b.item_id = p_payload->>'itemId'
   order by b.warehouse_id
     for update;

  -- ... apply the movement, enforce quantity >= 0, write the stock ledger ...

  return query select 'posted'::erp_posting_status, v_doc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Parity / reconciliation queries (run before activation)
-- ---------------------------------------------------------------------------
--   a) trial balance drift:
--        select account_id, sum(debit) - sum(credit) from erp_journal_lines group by 1 having sum(debit) <> sum(credit);
--   b) stock drift vs local export:
--        compare erp_stock_balances against the exported local inventory snapshot;
--   c) duplicate-post attempts must be rejected:
--        call erp_post_sales_invoice twice with the same key -> ('posted', 'duplicate').
-- ============================================================================
-- END OF DRAFT — nothing here has been applied to the TEST database.
-- ============================================================================
