-- =====================================================================
-- scripts/qa_rest_full_cycle_verify.sql
--
-- Server-side verification of the invoice posted by
-- scripts/qa_rest_full_cycle.mjs. Read-only: it asserts, never writes.
--
-- Run:
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
--        -v inv=SINV-2026-00125 -f scripts/qa_rest_full_cycle_verify.sql
-- =====================================================================
\set ON_ERROR_STOP on
\if :{?inv}
\else
  \echo 'usage: psql ... -v inv=<invoice_number> -f scripts/qa_rest_full_cycle_verify.sql'
  \quit 3
\endif

-- psql does not substitute :vars inside dollar-quoted bodies, so the invoice
-- number is handed to the block through a session setting.
select set_config('qa.inv', :'inv', false);

do $$
declare
  v_inv_no   text := current_setting('qa.inv');
  v_inv      record;
  v_sales    record;
  v_cogs     record;
  v_dr       numeric;
  v_cr       numeric;
  v_moves    int;
  v_out_qty  numeric;
  v_out_cost numeric;
  v_idem     int;
  v_failed_attempts int;
begin
  select * into v_inv from sales.invoices where invoice_number = v_inv_no;
  if v_inv.id is null then
    raise exception 'VERIFY FAILED: invoice % not found', v_inv_no;
  end if;
  if v_inv.status <> 'posted' then
    raise exception 'VERIFY FAILED: invoice % status is %', v_inv_no, v_inv.status;
  end if;
  if v_inv.journal_entry_id is null then
    raise exception 'VERIFY FAILED: invoice % has no sales journal link', v_inv_no;
  end if;

  -- (1) sales journal: posted, balanced, and the one the invoice points at
  select * into v_sales from fin.journal_entries where id = v_inv.journal_entry_id;
  if not coalesce(v_sales.is_posted, false) then
    raise exception 'VERIFY FAILED: sales journal % is not posted', v_sales.entry_number;
  end if;
  select coalesce(sum(l.debit),0), coalesce(sum(l.credit),0)
    into v_dr, v_cr from fin.journal_lines l where l.journal_entry_id = v_sales.id;
  if abs(v_dr - v_cr) > 0.01 or v_dr <= 0 then
    raise exception 'VERIFY FAILED: sales journal % unbalanced (% / %)', v_sales.entry_number, v_dr, v_cr;
  end if;
  if abs(v_dr - 171) > 0.01 then
    raise exception 'VERIFY FAILED: sales journal total % (expected 171 = 150 + 14%% VAT)', v_dr;
  end if;

  -- (2) COGS journal: a different, posted, balanced entry linked to the invoice
  select * into v_cogs
    from fin.journal_entries e
   where e.is_posted
     and e.id <> v_sales.id
     and (e.reference = v_inv.invoice_number or e.source_document_id = v_inv.id)
   order by e.created_at desc
   limit 1;
  if v_cogs.id is null then
    raise exception 'VERIFY FAILED: no posted COGS journal linked to %', v_inv_no;
  end if;
  select coalesce(sum(l.debit),0), coalesce(sum(l.credit),0)
    into v_dr, v_cr from fin.journal_lines l where l.journal_entry_id = v_cogs.id;
  if abs(v_dr - v_cr) > 0.01 or v_dr <= 0 then
    raise exception 'VERIFY FAILED: COGS journal % unbalanced (% / %)', v_cogs.entry_number, v_dr, v_cr;
  end if;
  if abs(v_dr - 54) > 0.01 then
    raise exception 'VERIFY FAILED: COGS journal total % (expected 54 = 3*10 + 2*12)', v_dr;
  end if;
  if abs(v_inv.cogs_total - 54) > 0.01 then
    raise exception 'VERIFY FAILED: invoice cogs_total % (expected 54)', v_inv.cogs_total;
  end if;

  -- (3) FIFO movements recorded against the invoice
  select count(*), coalesce(sum(t.quantity_out),0), coalesce(sum(t.total_cost),0)
    into v_moves, v_out_qty, v_out_cost
    from inventory.transactions t
   where t.document_number = v_inv.invoice_number and t.quantity_out > 0;
  if v_moves = 0 then
    raise exception 'VERIFY FAILED: no inventory movement for %', v_inv_no;
  end if;
  if abs(v_out_qty - 5) > 0.0001 or abs(v_out_cost - 54) > 0.01 then
    raise exception 'VERIFY FAILED: issued % units costing % (expected 5 / 54)', v_out_qty, v_out_cost;
  end if;

  -- (4) the failing attempt left nothing behind
  select count(*) into v_failed_attempts
    from sales.invoices where customer_id = 'rpc-rest-cust' and invoice_number <> v_inv_no;
  if v_failed_attempts <> 0 then
    raise exception 'VERIFY FAILED: % extra invoice(s) exist for the test customer', v_failed_attempts;
  end if;
  if exists (select 1 from fin.rpc_idempotency where key = 'rpc-rest-fail') then
    raise exception 'VERIFY FAILED: the refused call left an idempotency row';
  end if;

  -- (5) the idempotency key is bound to this one invoice
  select count(*) into v_idem from fin.rpc_idempotency
   where key = 'rpc-rest-key-1' and invoice_id = v_inv.id;
  if v_idem <> 1 then
    raise exception 'VERIFY FAILED: key rpc-rest-key-1 is not bound to %', v_inv_no;
  end if;

  raise notice 'VERIFY OK: % posted; sales JV % (171 balanced), COGS JV % (54 balanced), FIFO 5 units / 54 cost, idempotency bound',
    v_inv.invoice_number, v_sales.entry_number, v_cogs.entry_number;
end $$;

select e.entry_number, e.reference, e.is_posted,
       (select sum(l.debit) from fin.journal_lines l where l.journal_entry_id = e.id) as debit,
       (select sum(l.credit) from fin.journal_lines l where l.journal_entry_id = e.id) as credit
  from fin.journal_entries e
 where e.id in (select journal_entry_id from sales.invoices where invoice_number = :'inv')
    or e.reference = :'inv'
 order by e.entry_number;
