-- =====================================================================
-- 140_accounting_guards.sql — part 5b: the invariants, enforced in the DB
--
-- These are the rules the ERP must never be able to break, enforced where no
-- client and no future RPC can bypass them:
--   1. a posted journal entry is balanced (total debit = total credit),
--   2. a journal line never points at a header account or a missing account,
--   3. nothing is posted into a CLOSED accounting period,
--   4. accounting periods never overlap (the period lookup is by date),
--   5. stock never goes negative unless a controlled switch is on,
--   6. a batch's expiry is derived from the item's expiry_period_days, never
--      an invented 180 days, and never earlier than its production date,
--   7. posted financial documents are never deleted (cancel = reversal).
--
-- The balance check is a DEFERRABLE constraint trigger: fin.post_journal
-- inserts the header and the lines in sequence inside one transaction, so the
-- check must run at COMMIT, not per statement.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) a posted entry must balance
-- ---------------------------------------------------------------------
create or replace function fin.assert_entry_balanced()
returns trigger
language plpgsql
security definer
set search_path = fin, core, pg_temp
as $$
declare
  v_debit numeric := 0;
  v_credit numeric := 0;
  v_lines integer := 0;
begin
  if new.is_posted is not true then
    return null;
  end if;

  select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0), count(*)
    into v_debit, v_credit, v_lines
    from fin.journal_lines l
   where l.journal_entry_id = new.id;

  if v_lines < 2 then
    raise exception 'journal entry % (%.%): a posted entry needs at least two lines, found %',
      new.entry_number, new.source_document_type, coalesce(new.source_document_id, '-'), v_lines
      using errcode = 'check_violation';
  end if;

  if v_debit <= 0 or abs(v_debit - v_credit) > 0.01 then
    raise exception 'journal entry % (%.%) is unbalanced: debit % / credit % — posting rejected',
      new.entry_number, new.source_document_type, coalesce(new.source_document_id, '-'),
      v_debit, v_credit
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

drop trigger if exists trg_journal_entry_balanced on fin.journal_entries;
create constraint trigger trg_journal_entry_balanced
  after insert or update of is_posted on fin.journal_entries
  deferrable initially deferred
  for each row execute function fin.assert_entry_balanced();

-- ---------------------------------------------------------------------
-- 2) journal lines: real, detail accounts only
-- ---------------------------------------------------------------------
create or replace function fin.guard_journal_line()
returns trigger
language plpgsql
security definer
set search_path = fin, core, pg_temp
as $$
declare
  v_is_header boolean;
begin
  select a.is_header into v_is_header
    from core.accounts a
   where a.id = new.account_id;

  if not found then
    raise exception 'journal line references account % which does not exist in core.accounts — posting rejected',
      coalesce(new.account_id, '(null)')
      using errcode = 'check_violation';
  end if;

  if coalesce(v_is_header, false) then
    raise exception 'account % (%) is a HEADER account: posting to a header is never allowed',
      new.account_id, coalesce(new.account_code, '-')
      using errcode = 'check_violation';
  end if;

  if new.debit > 0 and new.credit > 0 then
    raise exception 'journal line % has both debit and credit amounts — a line must be one-sided',
      new.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_journal_line_guard on fin.journal_lines;
create trigger trg_journal_line_guard
  before insert or update on fin.journal_lines
  for each row execute function fin.guard_journal_line();

-- ---------------------------------------------------------------------
-- 3) closed-period guard
-- ---------------------------------------------------------------------
create or replace function fin.guard_closed_period()
returns trigger
language plpgsql
security definer
set search_path = fin, core, pg_temp
as $$
declare
  v_name text;
  v_closed boolean;
begin
  if new.is_posted is not true then
    return new;
  end if;

  select p.name_ar, p.is_closed into v_name, v_closed
    from core.accounting_periods p
   where new.date >= p.start_date and new.date <= p.end_date
   order by p.start_date asc
   limit 1;

  if found and coalesce(v_closed, false) then
    raise exception 'الفترة المالية (%) مغلقة — لا يمكن الترحيل على تاريخ %',
      v_name, new.date
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_journal_closed_period on fin.journal_entries;
create trigger trg_journal_closed_period
  before insert or update of is_posted, date on fin.journal_entries
  for each row execute function fin.guard_closed_period();

-- ---------------------------------------------------------------------
-- 4) periods must not overlap (new/edited periods only)
-- ---------------------------------------------------------------------
create or replace function core.guard_period_overlap()
returns trigger
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_other text;
begin
  select p.code into v_other
    from core.accounting_periods p
   where p.id <> new.id
     and p.start_date <= new.end_date
     and p.end_date >= new.start_date
   limit 1;

  if found then
    raise exception 'accounting period % overlaps existing period % (start % end %)',
      coalesce(new.code, new.id), v_other, new.start_date, new.end_date
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_accounting_period_overlap on core.accounting_periods;
create trigger trg_accounting_period_overlap
  before insert or update of start_date, end_date on core.accounting_periods
  for each row execute function core.guard_period_overlap();

-- ---------------------------------------------------------------------
-- 5) no negative stock
--
-- Escape hatch (only a controlled, permission-gated RPC may use it):
--     set local erp.allow_negative_stock = 'on';
-- It is `local`, so it dies with the transaction and can never leak into
-- another request on the same pooled connection.
-- ---------------------------------------------------------------------
create or replace function inventory.guard_negative_stock()
returns trigger
language plpgsql
as $$
begin
  if new.quantity < 0
     and coalesce(current_setting('erp.allow_negative_stock', true), 'off') <> 'on' then
    raise exception 'negative stock rejected: item % warehouse % batch % would go to % — allow_negative_stock is off',
      new.item_id, new.warehouse_id, new.batch_number, new.quantity
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_batch_negative_stock on inventory.batches;
create trigger trg_batch_negative_stock
  before update of quantity on inventory.batches
  for each row execute function inventory.guard_negative_stock();

-- ---------------------------------------------------------------------
-- 6) expiry comes from the item's configured shelf life
--    (never an invented 180 days, never before the production date)
-- ---------------------------------------------------------------------
create or replace function inventory.guard_batch_dates()
returns trigger
language plpgsql
security definer
set search_path = inventory, core, pg_temp
as $$
declare
  v_track_expiry boolean;
  v_shelf_life integer;
begin
  select i.track_expiry, i.expiry_period_days
    into v_track_expiry, v_shelf_life
    from core.items i
   where i.id = new.item_id;

  -- derive only when nothing was supplied: an explicit expiry is always kept
  if new.expiry_date is null and coalesce(v_track_expiry, false)
     and new.production_date is not null and coalesce(v_shelf_life, 0) > 0 then
    new.expiry_date := new.production_date + v_shelf_life;
  end if;

  if new.expiry_date is not null and new.production_date is not null
     and new.expiry_date < new.production_date then
    raise exception 'batch % of item % expires (%) before it was produced (%)',
      new.batch_number, new.item_id, new.expiry_date, new.production_date
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_batch_dates on inventory.batches;
create trigger trg_batch_dates
  before insert or update of expiry_date, production_date on inventory.batches
  for each row execute function inventory.guard_batch_dates();

-- ---------------------------------------------------------------------
-- 7) posted documents are permanent
-- ---------------------------------------------------------------------
create or replace function fin.refuse_delete_of_posted()
returns trigger
language plpgsql
as $$
begin
  raise exception 'posted % record cannot be deleted (cancel/reverse it instead)', tg_table_name
    using errcode = 'check_violation';
  return null;
end;
$$;

drop trigger if exists trg_journal_entries_no_delete on fin.journal_entries;
create trigger trg_journal_entries_no_delete
  before delete on fin.journal_entries
  for each row when (old.is_posted is true)
  execute function fin.refuse_delete_of_posted();

drop trigger if exists trg_sales_invoices_no_delete on sales.invoices;
create trigger trg_sales_invoices_no_delete
  before delete on sales.invoices
  for each row when (old.status = 'posted')
  execute function fin.refuse_delete_of_posted();

drop trigger if exists trg_inventory_transactions_no_delete on inventory.transactions;
create trigger trg_inventory_transactions_no_delete
  before delete on inventory.transactions
  for each row execute function fin.refuse_delete_of_posted();
