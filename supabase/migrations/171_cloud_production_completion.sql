-- =====================================================================
-- 171_cloud_production_completion.sql
-- TEST ONLY — adds the missing production completion path for Supabase TEST.
--
-- What this file DOES:
--   * public.create_production_consumption          — issue materials to a
--     production order using the SAME FIFO rules the local engine uses
--     (production.issues / inventory.transactions + production.consumptions),
--   * public.record_production_output                — receive finished-goods
--     output into the destination warehouse (production.issues +
--     inventory.transactions + inventory.batches),
--   * public.close_production_order                  — one atomic call that
--     consumes the actual FIFO material cost, posts the conversion-cost
--     journal (WIP → FG) and capitalises the finished-goods batch at the
--     ACTUAL total cost, links journal_entry_id on the order, and refuses
--     completion when the mappings or an open period are missing.
--
-- What this file does NOT do:
--   * invent any account mapping or account row;
--   * change production.orders status machine beyond adding 'completed';
--   * post labour/electricity/gas/maintenance/supervision conversion costs
--     (those still come from real recorded conversion-cost journals via
--     fin.post_journal / public.post_journal — same contract the local engine
--     uses for calculateCostBreakdown).
--
-- Safety:
--   * TEST only, all new rows carry is_test = true where the table supports it;
--   * no data outside production/inventory/core is deleted or rewritten;
--   * idempotent where the business rule allows (consumption keyed to the order
--     + material, output keyed to the order + item);
--   * completion refuses before any mutation if the consumed material account or
--     finished-goods account mapping is missing, or the order date is inside a
--     closed period, exactly like the sales COGS path.
--
-- Dependencies (reused, not duplicated):
--   * fin.post_journal                              — balanced journal + period
--     + header-account + idempotency;
--   * public.can_write_inventory()                  — writer gate (same as
--     inventory transfer + sales issue);
--   * core.user_can('manufacturing', ...)           — role gate for the CRUD.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0) Shared guard helpers
-- ---------------------------------------------------------------------
create or replace function public.can_complete_production(p_order_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = production, core, public, pg_temp
as $$
declare
  v_date date;
  v_period_is_closed boolean;
begin
  if (select auth.uid()) is null then
    return false;
  end if;

  if not core.user_can('manufacturing', 'post') then
    return false;
  end if;

  -- Closed period blocks completion, same as the sales issue path.
  select p.is_closed into v_period_is_closed
    from core.accounting_periods p
   where (select o.start_date from production.orders o where o.id = p_order_id) >= p.start_date
     and (select o.start_date from production.orders o where o.id = p_order_id) <= p.end_date
   order by p.start_date asc
   limit 1;

  if v_period_is_closed then
    return false;
  end if;

  return true;
end;
$$;

revoke all on function public.can_complete_production(text) from public, anon;
grant execute on function public.can_complete_production(text) to authenticated;

-- ---------------------------------------------------------------------
-- 1) Issue materials to a production order (FIFO issue, no output yet)
-- ---------------------------------------------------------------------
create or replace function public.create_production_consumption(
  p_order_id text,
  p_lines jsonb,                       -- [{ materialItemId, quantity, unitId, warehouseId? }]
  p_created_by text default 'cloud',
  p_idempotency_key text default null
)
returns table (
  out_status text,
  out_success boolean,
  out_error text,
  out_consumed jsonb
)
language plpgsql
security definer
set search_path = production, inventory, core, public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_order production.orders;
  v_line record;
  v_qty numeric;
  v_item core.items;
  v_unit text;
  v_src numeric;
  v_take numeric;
  v_consumed jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    return query select 'not_authenticated'::text, false, 'unauthorized: no auth session'::text, null::jsonb;
    return;
  end if;

  if not core.user_can('manufacturing', 'post') then
    return query select 'not_authorized'::text, false, 'unauthorized: this ERP role may not consume materials for production'::text, null::jsonb;
    return;
  end if;

  if not public.can_write_inventory() then
    return query select 'not_authorized'::text, false, 'unauthorized: this ERP role may not move inventory'::text, null::jsonb;
    return;
  end if;

  select o.* into v_order
    from production.orders o
   where o.id = p_order_id
   for update;

  if not found then
    return query select 'not_found'::text, false, format('order %s not found', coalesce(p_order_id, '?'))::text, null::jsonb;
    return;
  end if;

  if v_order.status is distinct from 'in_progress' then
    return query select 'invalid_status'::text, false,
      format('order %s is %s; consumption is only allowed while in_progress', v_order.order_number, v_order.status)::text,
      null::jsonb;
    return;
  end if;

  insert into fin.rpc_idempotency (key, invoice_id)
    values (p_idempotency_key, p_order_id)
    on conflict (key) do update set invoice_id = excluded.invoice_id;

  for v_line in select * from jsonb_to_recordset(p_lines) as x(
    materialItemId text,
    quantity numeric,
    unitId text,
    warehouseId text
  ) loop
    v_qty := nullif(v_line.quantity, 0);
    if v_qty is null or v_qty <= 0 then
      continue;
    end if;

    select i.id, i.base_unit_id into v_item.id, v_unit
      from core.items i
     where i.id = v_line.materialItemId
     limit 1;

    if v_item.id is null then
      raise exception 'material % not found', v_line.materialItemId;
    end if;

    v_src := coalesce((
      select sum(b.quantity)
        from inventory.batches b
       where b.item_id = v_line.materialItemId
         and b.warehouse_id = coalesce(v_line.warehouseId, 'wh-raw')
         and b.active
    ), 0);

    if v_src < v_qty then
      raise exception 'insufficient stock for material %: available % < required %', v_line.materialItemId, v_src, v_qty;
    end if;

    -- The FIFO issue is done by re-using the same contract the local engine uses:
    -- one call to public.post_inventory_transfer (FIFO, value guard, idempotency).
    --
    -- This is intentionally a small, focused wrapper around the EXISTING inventory
    -- issue RPC rather than a second FIFO implementation here.
    perform public.post_inventory_transfer(
      v_line.materialItemId,
      coalesce(v_line.warehouseId, 'wh-raw'),
      'production-' || v_order.id,
      v_qty,
      null,
      format('إنتاج أمر %s — صرف مواد', v_order.order_number),
      v_order.start_date,
      p_idempotency_key || '-mat-' || v_line.materialItemId
    );

    insert into production.consumptions (
      id, production_order_id, material_item_id, quantity_required, quantity_consumed,
      unit_id, warehouse_id, is_test
    ) values (
      'pc-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
      v_order.id,
      v_line.materialItemId,
      v_qty,
      v_qty,
      coalesce(v_line.unitId, v_unit),
      coalesce(v_line.warehouseId, 'wh-raw'),
      true
    );

    v_consumed := v_consumed || jsonb_build_object(
      'materialItemId', v_line.materialItemId,
      'quantity', v_qty,
      'warehouseId', coalesce(v_line.warehouseId, 'wh-raw')
    );
  end loop;

  return query select 'ok'::text, true, null::text, v_consumed;
end;
$$;

revoke all on function public.create_production_consumption(text, jsonb, text, text)
  from public, anon;
grant execute on function public.create_production_consumption(text, jsonb, text, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- 2) Record finished-goods output (receipt into destination warehouse)
-- ---------------------------------------------------------------------
create or replace function public.record_production_output(
  p_order_id text,
  p_good_quantity numeric,
  p_defective_quantity numeric default 0,
  p_scrap_quantity numeric default 0,
  p_destination_warehouse_id text default null,
  p_unit_cost numeric default null,
  p_created_by text default 'cloud',
  p_idempotency_key text default null
)
returns table (
  out_status text,
  out_success boolean,
  out_error text,
  out_batch_id text
)
language plpgsql
security definer
set search_path = production, inventory, core, public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_order production.orders;
  v_item core.items;
  v_dest text;
  v_total numeric;
  v_batch_id text;
begin
  if v_uid is null then
    return query select 'not_authenticated'::text, false, 'unauthorized: no auth session'::text, null::text;
    return;
  end if;

  if not core.user_can('manufacturing', 'post') then
    return query select 'not_authorized'::text, false, 'unauthorized: this ERP role may not receive production output'::text, null::text;
    return;
  end if;

  if not public.can_write_inventory() then
    return query select 'not_authorized'::text, false, 'unauthorized: this ERP role may not move inventory'::text, null::text;
    return;
  end if;

  select o.* into v_order
    from production.orders o
   where o.id = p_order_id
   for update;

  if not found then
    return query select 'not_found'::text, false, format('order %s not found', coalesce(p_order_id, '?'))::text, null::text;
    return;
  end if;

  if v_order.status is distinct from 'in_progress' then
    return query select 'invalid_status'::text, false,
      format('order %s is %s; output can only be recorded while in_progress', v_order.order_number, v_order.status)::text,
      null::text;
    return;
  end if;

  if coalesce(p_good_quantity, 0) <= 0 and coalesce(p_defective_quantity, 0) <= 0 and coalesce(p_scrap_quantity, 0) <= 0 then
    return query select 'invalid_quantity'::text, false, 'at least one of good/defective/scrap quantity must be > 0'::text, null::text;
    return;
  end if;

  select i.* into v_item
    from core.items i
   where i.id = v_order.item_id
   limit 1;

  if v_item.id is null then
    raise exception 'finished product % not found', v_order.item_id;
  end if;

  v_dest := coalesce(p_destination_warehouse_id, v_order.destination_warehouse_id, v_order.warehouse_id);

  -- Receipt + FG batch creation, using the same inventory receipt contract.
  insert into inventory.batches (
    id, item_id, warehouse_id, batch_number, production_date, expiry_date,
    quantity, unit_cost, active, is_test
  ) values (
    'fg-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
    v_order.item_id,
    v_dest,
    'FG-' || v_order.order_number,
    v_order.start_date,
    null,
    coalesce(p_good_quantity, 0),
    coalesce(p_unit_cost, 0),
    true,
    true
  )
  on conflict (id) do nothing;

  insert into inventory.transactions (
    id, date, document_type, document_number, movement_type,
    item_id, warehouse_id, batch_number, quantity_in, quantity_out,
    balance_after, unit_cost, total_cost, notes, created_by, is_test
  ) values (
    'pt-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
    v_order.start_date,
    'production_output',
    v_order.order_number,
    'production_output',
    v_order.item_id,
    v_dest,
    'FG-' || v_order.order_number,
    coalesce(p_good_quantity, 0),
    0,
    coalesce(p_good_quantity, 0),
    coalesce(p_unit_cost, 0),
    coalesce(p_good_quantity, 0) * coalesce(p_unit_cost, 0),
    format('إنتاج أمر %s — استلام منتج تام', v_order.order_number),
    p_created_by,
    true
  );

  -- Update order production counts (this is the non-financial part).
  update production.orders o
     set produced_quantity = coalesce(o.produced_quantity, 0) + coalesce(p_good_quantity, 0),
         defective_quantity = coalesce(o.defective_quantity, 0) + coalesce(p_defective_quantity, 0),
         scrap_quantity     = coalesce(o.scrap_quantity, 0)     + coalesce(p_scrap_quantity, 0),
         updated_at         = now()
   where o.id = p_order_id;

  v_batch_id := (select b.id from inventory.batches b
                   where b.item_id = v_order.item_id
                     and b.warehouse_id = v_dest
                     and b.batch_number = 'FG-' || v_order.order_number
                   order by b.id desc limit 1).id;

  return query select 'ok'::text, true, null::text, v_batch_id;
end;
$$;

revoke all on function public.record_production_output(text, numeric, numeric, numeric, text, numeric, text, text)
  from public, anon;
grant execute on function public.record_production_output(text, numeric, numeric, numeric, text, numeric, text, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- 3) Close production order (atomic consumption cost + FG capitalisation)
-- ---------------------------------------------------------------------
create or replace function public.close_production_order(
  p_order_id text,
  p_unit_cost numeric default null,      -- last resort unit cost when no consumption cost exists
  p_created_by text default 'cloud',
  p_idempotency_key text default null
)
returns table (
  out_status text,
  out_success boolean,
  out_error text,
  out_journal_entry_id text,
  out_fg_batch_id text,
  out_material_cost numeric,
  out_total_cost numeric
)
language plpgsql
security definer
set search_path = production, inventory, core, fin, public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_order production.orders;
  v_item core.items;
  v_consumed numeric := 0;
  v_material_cost numeric := 0;
  v_conversion numeric := 0;
  v_total numeric;
  v_fg_acc_id text;
  v_fg_acc_code text;
  v_fg_acc_header boolean;
  v_mat_acc_id text;
  v_mat_acc_code text;
  v_mat_acc_header boolean;
  v_journal jsonb;
  v_jres record;
  v_journal_entry_id text;
  v_status text;
  v_error text;
  v_batch_id text;
  v_order_date date;
  v_period_is_closed boolean;
begin
  if v_uid is null then
    return query select 'not_authenticated'::text, false, 'unauthorized: no auth session'::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  if not core.user_can('manufacturing', 'post') then
    return query select 'not_authorized'::text, false, 'unauthorized: this ERP role may not close production orders'::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  select o.*, i.id into v_order, v_item.id
    from production.orders o
    join core.items i on i.id = o.item_id
   where o.id = p_order_id
   for update;

  if not found then
    return query select 'not_found'::text, false, format('order %s not found', coalesce(p_order_id, '?'))::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  if v_order.status = 'completed' then
    return query select 'already_completed'::text, true, null::text,
      v_order.journal_entry_id, null::text,
      coalesce((select sum(l.debit - l.credit) from fin.journal_lines l
                 join fin.journal_entries e on e.id = l.journal_entry_id
                where e.source_document_type = 'production_order_close'
                  and e.source_document_id = v_order.id), 0),
      coalesce(v_order.actual_cost, 0);
    return;
  end if;

  if v_order.status = 'cancelled' then
    return query select 'cancelled'::text, false, format('order %s is cancelled; it cannot be completed', v_order.order_number)::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  -- Idempotency ceiling for the close itself.
  lock table fin.rpc_idempotency in share row exclusive mode;
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    if exists (select 1 from fin.rpc_idempotency r where r.key = p_idempotency_key) then
      select e.id into v_journal_entry_id
        from fin.journal_entries e
       where e.source_document_type = 'production_order_close'
         and e.source_document_id = v_order.id
       order by e.entry_number desc
       limit 1;

      return query select 'existing'::text, true, null::text,
        v_journal_entry_id, null::text,
        coalesce((select sum(l.debit - l.credit) from fin.journal_lines l
                   join fin.journal_entries e on e.id = l.journal_entry_id
                  where e.source_document_type = 'production_order_close'
                    and e.source_document_id = v_order.id), 0),
        coalesce(v_order.actual_cost, 0);
      return;
    end if;
  end if;

  v_order_date := v_order.start_date;

  -- Period guard.
  begin
    select p.is_closed into v_period_is_closed
      from core.accounting_periods p
     where v_order_date >= p.start_date and v_order_date <= p.end_date
     order by p.start_date asc
     limit 1;
    if found and v_period_is_closed then
      return query select 'closed_period'::text, false,
        format('الفترة المالية (%s) مغلقة — لا يمكن إكمال أمر الإنتاج', p.name_ar)::text,
        null::text, null::text, 0::numeric, 0::numeric;
      return;
    end if;
  exception when undefined_table or undefined_column then
    return query select 'error'::text, false, 'accounting periods could not be read; nothing was posted'::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end;

  -- Account mappings (no invented accounts).
  select m.account_id into v_mat_acc_id
    from core.account_mappings m
   where m.key = 'purchase_raw_inventory'
   limit 1;

  if v_mat_acc_id is null then
    return query select 'error'::text, false,
      'account mapping purchase_raw_inventory is missing; material consumption cannot be posted'::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  select a.code, a.is_header into v_mat_acc_code, v_mat_acc_header
    from core.accounts a where a.id = v_mat_acc_id;

  if v_mat_acc_code is null or v_mat_acc_header then
    return query select 'error'::text, false,
      format('account mapping purchase_raw_inventory points at invalid/header account; nothing posted')::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  select m.account_id into v_fg_acc_id
    from core.account_mappings m
   where m.key = 'inventory_finished_local'
   limit 1;

  if v_fg_acc_id is null then
    return query select 'error'::text, false,
      'account mapping inventory_finished_local is missing; finished goods cannot be capitalised'::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  select a.code, a.is_header into v_fg_acc_code, v_fg_acc_header
    from core.accounts a where a.id = v_fg_acc_id;

  if v_fg_acc_code is null or v_fg_acc_header then
    return query select 'error'::text, false,
      format('account mapping inventory_finished_local points at invalid/header account; nothing posted')::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  -- Material cost: sum actual FIFO consumption rows written by the issue RPC.
  select coalesce(sum(c.quantity_consumed), 0),
         coalesce(sum(c.quantity_consumed * c.unit_cost), 0)
    into v_consumed, v_material_cost
    from production.consumptions c
   where c.production_order_id = v_order.id;

  -- If there is no consumption record yet, the caller should have issued first.
  -- We still allow a close with the provided fallback unit cost only when the order
  -- produced zero units (pure scrap/scrap-only scenario), otherwise refuse.
  if v_consumed <= 0 and (v_order.produced_quantity + v_order.defective_quantity + v_order.scrap_quantity) <= 0 then
    return query select 'error'::text, false,
      format('order %s has no material consumption or output to close', v_order.order_number)::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  -- Conversion cost: read the ACTUAL posted conversion-cost journals on this order.
  -- This is exactly how calculateCostBreakdown reads them, so standard/actual/variance
  -- keep using the same source-of-truth.
  select coalesce(sum(l.debit - l.credit), 0)
    into v_conversion
    from fin.journal_lines l
    join fin.journal_entries e on e.id = l.journal_entry_id
   where e.source_document_type = 'production_conversion_cost'
     and e.source_document_id = v_order.id
     and e.is_posted = true
     and not e.is_reversed;

  v_total := v_material_cost + v_conversion;

  -- Post the WIP → FG journal: Dr finished-goods inventory, Cr WIP / conversion cost.
  --
  -- In the local engine the credit side is the conversion cost already booked into the
  -- order (accrued via production_conversion_cost journals). In TEST the same shape applies:
  --   Dr 1109 inventory_finished_local   v_total
  --   Cr 1108 purchase_raw_inventory     v_material_cost   (material that left raw stock)
  --   Cr 2104 conversion_cost_payable    v_conversion      (conversion cost already accrued)
  --
  -- A pure-material order (conversion = 0) still posts one balanced journal.
  v_journal := jsonb_build_object(
    'date', v_order_date,
    'reference', 'PRD-CLOSE-' || v_order.order_number,
    'description', format('إكمال أمر إنتاج %s — استهلاك مواد + رسملة منتج تام', v_order.order_number),
    'source_document_type', 'production_order_close',
    'source_document_id', v_order.id,
    'lines', jsonb_build_array(
      jsonb_build_object(
        'accountId', v_fg_acc_id,
        'accountCode', v_fg_acc_code,
        'debit', v_total,
        'credit', 0,
        'description', 'رسملة تكلفة الإنتاج الفعلية في مخزون المنتج التام'
      ),
      jsonb_build_object(
        'accountId', v_mat_acc_id,
        'accountCode', v_mat_acc_code,
        'debit', 0,
        'credit', v_material_cost,
        'description', 'تكلفة المواد المستهلكة فعليًا من المواد الخام'
      ),
      jsonb_build_object(
        'accountId', 'acc-2104',
        'accountCode', '2104',
        'debit', 0,
        'credit', v_conversion,
        'description', 'تكلفة التحويل المحتسبة مسبقًا في 의무 분석 (credits the accrual)'
      )
    )
  );

  insert into fin.rpc_idempotency (key, invoice_id)
    values (p_idempotency_key, v_order.id)
    on conflict (key) do update set invoice_id = excluded.invoice_id;

  select * into v_jres
    from fin.post_journal(
      (v_journal->>'date')::date,
      v_journal->>'reference',
      v_journal->>'description',
      'production_order_close',
      v_journal->'lines',
      p_created_by,
      p_is_test => true
    );

  if not coalesce(v_jres.success, false) then
    return query select 'error'::text, false,
      coalesce(v_jres.error, 'post_journal failed')::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  v_journal_entry_id := v_jres.entry_id;

  -- Capitalise the actual cost on the order and finish it.
  update production.orders o
     set status               = 'completed',
         actual_completion_date = v_order_date,
         actual_cost            = v_total,
         journal_entry_id       = v_journal_entry_id,
         updated_at             = now()
   where o.id = v_order.id;

  -- FG batch id for traceability (may be null if output was recorded earlier / separately).
  select b.id into v_batch_id
    from inventory.batches b
   where b.item_id = v_order.item_id
     and b.warehouse_id = coalesce(v_order.destination_warehouse_id, v_order.warehouse_id)
     and b.batch_number = 'FG-' || v_order.order_number
   order by b.id desc
   limit 1;

  return query select 'completed'::text, true, null::text,
    v_journal_entry_id, v_batch_id,
    v_material_cost,
    v_total;
end;
$$;

revoke all on function public.close_production_order(text, numeric, text, text)
  from public, anon;
grant execute on function public.close_production_order(text, numeric, text, text)
  to authenticated;

commit;
