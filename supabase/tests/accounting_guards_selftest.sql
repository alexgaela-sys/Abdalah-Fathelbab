-- =====================================================================
-- supabase/tests/accounting_guards_selftest.sql
--
-- LOCAL VALIDATION ONLY (needs the shim in supabase/tests/shim_supabase_auth.sql
-- and the migrations applied to a scratch database). Never run against TEST or
-- Production: it writes throw-away rows.
--
-- Proves the invariants in 140_accounting_guards.sql actually fire:
--   1. a balanced posted entry is accepted,
--   2. an unbalanced posted entry is rejected,
--   3. a one-line posted entry is rejected,
--   4. posting to a HEADER account is rejected,
--   5. posting into a CLOSED period is rejected,
--   6. negative stock is rejected unless the controlled switch is on,
--   7. batch expiry is derived from the item's expiry_period_days,
--   8. a posted journal entry cannot be deleted.
--
-- Any failure raises with 'SELFTEST FAILED' and psql exits non-zero.
-- =====================================================================

do $$
declare
  v_id text;
begin
  -- fixtures (test-scoped ids only)
  insert into core.accounts (id, code, name_ar, category, is_header, level)
  values ('st-acc-fg', 'ST1999', 'Selftest finished goods', 'Assets', false, 4),
         ('st-acc-cogs', 'ST5999', 'Selftest COGS', 'COGS', false, 4),
         ('st-acc-header', 'ST1000', 'Selftest header', 'Assets', true, 2)
  on conflict (id) do nothing;

  insert into core.units (id, code, name_ar, is_base) values ('st-unit', 'STU', 'Selftest unit', true)
  on conflict (id) do nothing;

  insert into core.warehouses (id, code, name_ar, type) values ('st-wh', 'ST-WH', 'Selftest warehouse', 'local_finished')
  on conflict (id) do nothing;

  insert into core.items (id, code, name_ar, item_type, base_unit_id, track_batch, track_expiry,
                          expiry_period_days, standard_cost)
  values ('st-item', 'ST-ITEM', 'Selftest item', 'finished_product', 'st-unit', true, true, 60, 10)
  on conflict (id) do nothing;

  -- ---------------------------------------------------------------- 1
  insert into fin.journal_entries (id, entry_number, date, reference, description,
    source_document_type, source_document_id, is_posted, total_debit, total_credit, created_user_id)
  values ('st-je-ok', 'ST-JE-OK', current_date, 'ST', 'selftest balanced', 'selftest', 'st', true, 100, 100, 'selftest');

  insert into fin.journal_lines (id, journal_entry_id, account_id, account_code, account_name_ar,
    debit, credit, currency, original_amount, exchange_rate)
  values ('st-jl-1', 'st-je-ok', 'st-acc-cogs', 'ST5999', 'COGS', 100, 0, 'EGP', 100, 1),
         ('st-jl-2', 'st-je-ok', 'st-acc-fg', 'ST1999', 'FG', 0, 100, 'EGP', 100, 1);

  set constraints all immediate;  -- fires the deferred balance trigger
  raise notice 'SELFTEST 1 OK: balanced entry accepted';

  -- ---------------------------------------------------------------- 2
  begin
    insert into fin.journal_entries (id, entry_number, date, reference, description,
      source_document_type, is_posted, created_user_id)
    values ('st-je-bad', 'ST-JE-BAD', current_date, 'ST', 'selftest unbalanced', 'selftest', true, 'selftest');
    insert into fin.journal_lines (id, journal_entry_id, account_id, account_code, account_name_ar,
      debit, credit, currency, original_amount, exchange_rate)
    values ('st-jl-3', 'st-je-bad', 'st-acc-cogs', 'ST5999', 'COGS', 100, 0, 'EGP', 100, 1),
           ('st-jl-4', 'st-je-bad', 'st-acc-fg', 'ST1999', 'FG', 0, 90, 'EGP', 90, 1);
    set constraints all immediate;
    raise exception 'SELFTEST FAILED: unbalanced entry was accepted';
  exception when check_violation then
    raise notice 'SELFTEST 2 OK: unbalanced entry rejected';
  end;

  -- ---------------------------------------------------------------- 3
  begin
    insert into fin.journal_entries (id, entry_number, date, reference, description,
      source_document_type, is_posted, created_user_id)
    values ('st-je-one', 'ST-JE-ONE', current_date, 'ST', 'selftest single line', 'selftest', true, 'selftest');
    insert into fin.journal_lines (id, journal_entry_id, account_id, account_code, account_name_ar,
      debit, credit, currency, original_amount, exchange_rate)
    values ('st-jl-5', 'st-je-one', 'st-acc-cogs', 'ST5999', 'COGS', 0, 0, 'EGP', 0, 1);
    set constraints all immediate;
    raise exception 'SELFTEST FAILED: a single-line posted entry was accepted';
  exception when check_violation then
    raise notice 'SELFTEST 3 OK: single-line posted entry rejected';
  end;

  -- ---------------------------------------------------------------- 4
  begin
    insert into fin.journal_entries (id, entry_number, date, reference, description,
      source_document_type, is_posted, created_user_id)
    values ('st-je-hdr', 'ST-JE-HDR', current_date, 'ST', 'selftest header', 'selftest', false, 'selftest');
    insert into fin.journal_lines (id, journal_entry_id, account_id, account_code, account_name_ar,
      debit, credit, currency, original_amount, exchange_rate)
    values ('st-jl-6', 'st-je-hdr', 'st-acc-header', 'ST1000', 'header', 10, 0, 'EGP', 10, 1);
    raise exception 'SELFTEST FAILED: a header account accepted a posting';
  exception when check_violation then
    raise notice 'SELFTEST 4 OK: header-account posting rejected';
  end;

  -- ---------------------------------------------------------------- 5
  insert into core.accounting_periods (id, code, name_ar, start_date, end_date, is_closed)
  values ('st-period-closed', 'ST-PER', 'Selftest closed period', current_date - 1, current_date + 1, true)
  on conflict (id) do nothing;

  begin
    insert into fin.journal_entries (id, entry_number, date, reference, description,
      source_document_type, is_posted, created_user_id)
    values ('st-je-closed', 'ST-JE-CLOSED', current_date, 'ST', 'selftest closed', 'selftest', true, 'selftest');
    raise exception 'SELFTEST FAILED: posting into a closed period was accepted';
  exception when check_violation then
    raise notice 'SELFTEST 5 OK: closed-period posting rejected';
  end;

  -- ---------------------------------------------------------------- 6
  insert into inventory.batches (id, item_id, warehouse_id, batch_number, production_date, quantity, unit_cost)
  values ('st-batch', 'st-item', 'st-wh', 'ST-B1', current_date, 5, 10)
  on conflict (id) do nothing;

  begin
    update inventory.batches set quantity = -1 where id = 'st-batch';
    raise exception 'SELFTEST FAILED: negative stock was accepted';
  exception when check_violation then
    raise notice 'SELFTEST 6 OK: negative stock rejected';
  end;

  -- the controlled switch allows it, and dies with the transaction
  set local erp.allow_negative_stock = 'on';
  update inventory.batches set quantity = -1 where id = 'st-batch';
  update inventory.batches set quantity = 5 where id = 'st-batch';
  set local erp.allow_negative_stock = 'off';
  raise notice 'SELFTEST 6b OK: controlled negative-stock switch honoured';

  -- ---------------------------------------------------------------- 7
  select b.expiry_date::text into v_id from inventory.batches b where b.id = 'st-batch';
  if v_id <> (current_date + 60)::text then
    raise exception 'SELFTEST FAILED: expiry should be production + 60 days from the item, got %', v_id;
  end if;
  raise notice 'SELFTEST 7 OK: batch expiry derived from item.expiry_period_days (no invented 180)';

  -- ---------------------------------------------------------------- 8
  begin
    delete from fin.journal_entries where id = 'st-je-ok';
    raise exception 'SELFTEST FAILED: a posted journal entry was deleted';
  exception when check_violation then
    raise notice 'SELFTEST 8 OK: deleting a posted journal entry rejected';
  end;
end $$;
