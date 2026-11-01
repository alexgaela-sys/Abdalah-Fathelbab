-- =====================================================================
-- 168_cloud_audit_production_quality_costing.sql
--
-- Completes the operational modules that had NO cloud surface at all:
--
--   * public.list_audit_log              — the audit trail screen,
--   * public.list_posting_accounts       — sub-accounts for a manual journal,
--     (posting itself uses the EXISTING public.post_journal / fin.post_journal,
--      which already enforces role, open period, header-account and balance
--      rules — no second implementation is created here,)
--   * public.create_production_order /
--     public.set_production_order_status — draft order + non-financial status
--                                          transitions only,
--   * public.list_quality_inspections /
--     public.create_quality_inspection   — inspection records (the local
--                                          engine also only records the row;
--                                          it does not move stock),
--   * public.list_standard_cost_rates /
--     public.create_standard_cost_rate /
--     public.expire_standard_cost_rate   — standard cost master data.
--
-- Deliberately NOT implemented, because the accounting rule does not exist yet:
--   production completion (consumption/WIP/labour journals) and the treasury /
--   banks / cheques / expenses / custody postings. They would need account
--   mappings that TEST does not have; inventing them is not allowed.
--
-- Security: every function is SECURITY DEFINER, requires auth.uid(), and gates
-- on core.user_can(<module>, <action>). anon gets no grant. Every accepted write
-- appends an audit.app_audit_log row through public.erp_write_audit, which is
-- itself revoked from clients so it cannot be used to forge audit entries.
--
-- Idempotent. TEST only. No existing data is updated or deleted.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0) Audit writer (internal only)
-- ---------------------------------------------------------------------
create or replace function public.erp_write_audit(
  p_module text,
  p_action text,
  p_record_id text,
  p_record_table text,
  p_description text,
  p_new_value jsonb default null
)
returns void
language plpgsql
volatile
security definer
set search_path = audit, core, public, pg_temp
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_name text;
begin
  select coalesce(p.name, p.email, p.id) into v_name
    from core.app_profiles p
   where p.supabase_auth_id = v_uid::text;

  insert into audit.app_audit_log
    (id, "timestamp", user_id, user_name, module, action, record_id, record_table,
     new_value, description)
  values
    ('aud-' || replace(gen_random_uuid()::text, '-', ''),
     now(), coalesce(v_uid::text, 'system'), coalesce(v_name, ''),
     p_module, p_action::audit_action, p_record_id, p_record_table,
     p_new_value, p_description);
end;
$$;

revoke all on function public.erp_write_audit(text, text, text, text, text, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 1) Audit trail (read)
-- ---------------------------------------------------------------------
create or replace function public.list_audit_log(
  p_module text default null,
  p_action text default null,
  p_from date default null,
  p_to date default null,
  p_limit integer default 200,
  p_offset integer default 0
)
returns table (
  audit_id      text,
  occurred_at   timestamptz,
  user_id       text,
  user_name     text,
  module        text,
  action        text,
  record_id     text,
  record_table  text,
  description   text,
  previous_value jsonb,
  new_value     jsonb
)
language plpgsql
stable
security definer
set search_path = audit, core, public, pg_temp
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not core.user_can('audit', 'view') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  return query
    select a.id,
           a."timestamp",
           a.user_id,
           a.user_name,
           a.module,
           a.action::text,
           a.record_id,
           a.record_table,
           a.description,
           a.previous_value,
           a.new_value
      from audit.app_audit_log a
     where (p_module is null or p_module = '' or a.module = p_module)
       and (p_action is null or p_action = '' or a.action::text = p_action)
       and (p_from is null or a."timestamp" >= p_from)
       and (p_to is null or a."timestamp" < (p_to + 1))
     order by a."timestamp" desc, a.id desc
     limit least(greatest(coalesce(p_limit, 200), 1), 1000)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.list_audit_log(text, text, date, date, integer, integer)
  from public, anon;
grant execute on function public.list_audit_log(text, text, date, date, integer, integer)
  to authenticated;

-- ---------------------------------------------------------------------
-- 2) Sub-accounts for a manual journal entry
-- ---------------------------------------------------------------------
create or replace function public.list_posting_accounts()
returns table (
  account_id text,
  code       text,
  name_ar    text,
  category   text,
  is_header  boolean
)
language plpgsql
stable
security definer
set search_path = core, public, pg_temp
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not core.user_can('accounting', 'view') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  return query
    select a.id, a.code, a.name_ar, a.category::text, a.is_header
      from core.accounts a
     order by a.code;
end;
$$;

revoke all on function public.list_posting_accounts() from public, anon;
grant execute on function public.list_posting_accounts() to authenticated;

-- ---------------------------------------------------------------------
-- 3) Production orders — create draft + non-financial transitions
-- ---------------------------------------------------------------------
create sequence if not exists production.production_order_number_seq;

create or replace function public.create_production_order(
  p_item_id                 text,
  p_warehouse_id            text,
  p_destination_warehouse_id text,
  p_planned_quantity        numeric,
  p_start_date              date,
  p_expected_completion_date date,
  p_target_market           text,
  p_notes                   text,
  p_created_by              text,
  p_idempotency_key         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = production, core, fin, public, pg_temp
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_existing text;
  v_order_id text;
  v_number   text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not core.user_can('manufacturing', 'create') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select r.invoice_id into v_existing
      from fin.rpc_idempotency r
     where r.key = p_idempotency_key;

    if v_existing is not null then
      return jsonb_build_object(
        'status', 'existing',
        'order_id', v_existing,
        'order_number', (select o.order_number from production.orders o where o.id = v_existing)
      );
    end if;
  end if;

  if p_item_id is null or not exists (select 1 from core.items i where i.id = p_item_id) then
    return jsonb_build_object('status', 'invalid_item');
  end if;

  if p_warehouse_id is null or not exists (select 1 from core.warehouses w where w.id = p_warehouse_id) then
    return jsonb_build_object('status', 'invalid_warehouse');
  end if;

  if p_destination_warehouse_id is not null
     and not exists (select 1 from core.warehouses w where w.id = p_destination_warehouse_id) then
    return jsonb_build_object('status', 'invalid_destination');
  end if;

  if p_planned_quantity is null or p_planned_quantity <= 0 then
    return jsonb_build_object('status', 'invalid_quantity');
  end if;

  if coalesce(p_target_market, '') not in ('local', 'export') then
    return jsonb_build_object('status', 'invalid_market');
  end if;

  v_order_id := 'po-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  v_number := 'PRD-' || to_char(coalesce(p_start_date, current_date), 'YYYY') || '-' ||
              lpad(nextval('production.production_order_number_seq')::text, 5, '0');

  insert into production.orders
    (id, order_number, item_id, warehouse_id, status,
     planned_quantity, produced_quantity, defective_quantity, scrap_quantity,
     start_date, expected_completion_date, actual_completion_date,
     planned_cost, actual_cost, notes,
     destination_warehouse_id, target_market, is_test, created_by)
  values
    (v_order_id, v_number, p_item_id, p_warehouse_id, 'draft',
     p_planned_quantity, 0, 0, 0,
     p_start_date, p_expected_completion_date, null,
     null, null, nullif(trim(p_notes), ''),
     coalesce(p_destination_warehouse_id, p_warehouse_id),
     p_target_market, true,
     coalesce(nullif(trim(p_created_by), ''), 'cloud-ui'));

  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into fin.rpc_idempotency (key, invoice_id)
    values (p_idempotency_key, v_order_id)
    on conflict (key) do update set invoice_id = excluded.invoice_id;
  end if;

  perform public.erp_write_audit(
    'production', 'create', v_order_id, 'production.orders',
    format('إنشاء أمر إنتاج %s بكمية مخططة %s (مسودة — بلا حركة مخزون ولا قيد)',
           v_number, p_planned_quantity),
    jsonb_build_object('order_number', v_number, 'status', 'draft',
                       'item_id', p_item_id, 'planned_quantity', p_planned_quantity));

  return jsonb_build_object('status', 'created', 'order_id', v_order_id, 'order_number', v_number);
end;
$$;

create or replace function public.set_production_order_status(
  p_order_id text,
  p_status   text
)
returns jsonb
language plpgsql
security definer
set search_path = production, core, public, pg_temp
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_current text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not core.user_can('manufacturing', 'edit') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select o.status::text into v_current
    from production.orders o
   where o.id = p_order_id;

  if v_current is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Completion is an accounting event (material consumption + WIP + labour +
  -- finished-goods capitalization). The mappings for it do not exist in TEST,
  -- so this endpoint refuses instead of posting a half-truth.
  if p_status = 'completed' then
    return jsonb_build_object('status', 'completion_not_available');
  end if;

  if p_status is null or p_status not in ('released', 'in_progress', 'cancelled') then
    return jsonb_build_object('status', 'invalid_status');
  end if;

  if not (
       (v_current = 'draft'    and p_status in ('released', 'cancelled'))
    or (v_current = 'released' and p_status in ('in_progress', 'cancelled'))
  ) then
    return jsonb_build_object('status', 'invalid_transition', 'current', v_current);
  end if;

  update production.orders o
     set status = p_status::production_order_status,
         updated_at = now()
   where o.id = p_order_id;

  perform public.erp_write_audit(
    'production',
    case p_status when 'cancelled' then 'cancel' else 'edit' end,
    p_order_id, 'production.orders',
    format('تغيير حالة أمر إنتاج من %s إلى %s (بلا أثر مالي)', v_current, p_status),
    jsonb_build_object('from', v_current, 'to', p_status));

  return jsonb_build_object('status', 'updated', 'order_status', p_status);
end;
$$;

revoke all on function public.create_production_order(text, text, text, numeric, date, date, text, text, text, text)
  from public, anon;
revoke all on function public.set_production_order_status(text, text) from public, anon;
grant execute on function public.create_production_order(text, text, text, numeric, date, date, text, text, text, text)
  to authenticated;
grant execute on function public.set_production_order_status(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4) Quality inspections
-- ---------------------------------------------------------------------
create or replace function public.list_quality_inspections(
  p_from   date default null,
  p_to     date default null,
  p_result text default null,
  p_limit  integer default 200,
  p_offset integer default 0
)
returns table (
  inspection_id           text,
  production_order_id     text,
  order_number            text,
  item_id                 text,
  item_code               text,
  item_name_ar            text,
  quantity                numeric,
  inspection_date         date,
  result                  text,
  destination_warehouse_id text,
  destination_code        text,
  notes                   text,
  created_at              timestamptz
)
language plpgsql
stable
security definer
set search_path = production, core, public, pg_temp
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not core.user_can('quality', 'view') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  return query
    select q.id,
           q.production_order_id,
           o.order_number,
           q.item_id,
           i.code,
           i.name_ar,
           q.quantity,
           q.inspection_date,
           q.result::text,
           q.destination_warehouse_id,
           w.code,
           q.notes,
           q.created_at
      from production.quality_inspections q
      left join production.orders o on o.id = q.production_order_id
      left join core.items i on i.id = q.item_id
      left join core.warehouses w on w.id = q.destination_warehouse_id
     where (p_from is null or q.inspection_date >= p_from)
       and (p_to is null or q.inspection_date <= p_to)
       and (p_result is null or p_result = '' or q.result::text = p_result)
     order by q.inspection_date desc, q.created_at desc
     limit least(greatest(coalesce(p_limit, 200), 1), 1000)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create or replace function public.create_quality_inspection(
  p_production_order_id     text,
  p_item_id                 text,
  p_quantity                numeric,
  p_date                    date,
  p_result                  text,
  p_destination_warehouse_id text,
  p_notes                   text,
  p_idempotency_key         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = production, core, fin, public, pg_temp
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_existing text;
  v_id       text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not core.user_can('quality', 'create') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select r.invoice_id into v_existing
      from fin.rpc_idempotency r where r.key = p_idempotency_key;
    if v_existing is not null then
      return jsonb_build_object('status', 'existing', 'inspection_id', v_existing);
    end if;
  end if;

  if p_result is null or p_result not in ('passed', 'rejected', 'conditional') then
    return jsonb_build_object('status', 'invalid_result');
  end if;

  if p_quantity is null or p_quantity <= 0 then
    return jsonb_build_object('status', 'invalid_quantity');
  end if;

  if p_item_id is null or not exists (select 1 from core.items i where i.id = p_item_id) then
    return jsonb_build_object('status', 'invalid_item');
  end if;

  if p_production_order_id is not null
     and not exists (select 1 from production.orders o where o.id = p_production_order_id) then
    return jsonb_build_object('status', 'invalid_order');
  end if;

  if p_destination_warehouse_id is not null
     and not exists (select 1 from core.warehouses w where w.id = p_destination_warehouse_id) then
    return jsonb_build_object('status', 'invalid_destination');
  end if;

  v_id := 'qi-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);

  insert into production.quality_inspections
    (id, production_order_id, item_id, quantity, inspection_date, result,
     destination_warehouse_id, notes)
  values
    (v_id, nullif(trim(p_production_order_id), ''), p_item_id, p_quantity,
     coalesce(p_date, current_date), p_result::quality_result,
     nullif(trim(p_destination_warehouse_id), ''), nullif(trim(p_notes), ''));

  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into fin.rpc_idempotency (key, invoice_id)
    values (p_idempotency_key, v_id)
    on conflict (key) do update set invoice_id = excluded.invoice_id;
  end if;

  perform public.erp_write_audit(
    'quality', 'create', v_id, 'production.quality_inspections',
    format('تسجيل فحص جودة بكمية %s — النتيجة %s (سجل فقط، بلا حركة مخزون)', p_quantity, p_result),
    jsonb_build_object('result', p_result, 'quantity', p_quantity,
                       'item_id', p_item_id, 'production_order_id', p_production_order_id));

  return jsonb_build_object('status', 'created', 'inspection_id', v_id);
end;
$$;

revoke all on function public.list_quality_inspections(date, date, text, integer, integer)
  from public, anon;
revoke all on function public.create_quality_inspection(text, text, numeric, date, text, text, text, text)
  from public, anon;
grant execute on function public.list_quality_inspections(date, date, text, integer, integer)
  to authenticated;
grant execute on function public.create_quality_inspection(text, text, numeric, date, text, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- 5) Standard cost rates
--
-- Schema defect found while wiring this module: the table carries the
-- trg_standard_cost_rates_touch trigger (BEFORE UPDATE -> core.touch_updated_at)
-- but has no updated_at column, so EVERY update on it aborted with
--   record "new" has no field "updated_at"
-- which made an active rate impossible to expire. The additive column below
-- matches every other core table and lets the existing trigger work.
-- ---------------------------------------------------------------------
alter table core.standard_cost_rates
  add column if not exists updated_at timestamptz not null default now();
create or replace function public.list_standard_cost_rates(
  p_status text default null,
  p_limit  integer default 200,
  p_offset integer default 0
)
returns table (
  rate_id           text,
  cost_type         text,
  cost_type_name_ar text,
  product_family    text,
  product_id        text,
  item_code         text,
  item_name_ar      text,
  base_quantity     numeric,
  rate              numeric,
  effective_from    date,
  effective_to      date,
  status            text,
  created_at        timestamptz
)
language plpgsql
stable
security definer
set search_path = core, public, pg_temp
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not core.user_can('costing', 'view') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  return query
    select r.id, r.cost_type::text, r.cost_type_name_ar, r.product_family, r.product_id,
           i.code, i.name_ar, r.base_quantity, r.rate, r.effective_from, r.effective_to,
           r.status::text, r.created_at
      from core.standard_cost_rates r
      left join core.items i on i.id = r.product_id
     where (p_status is null or p_status = '' or r.status::text = p_status)
     order by r.effective_from desc, r.cost_type::text
     limit least(greatest(coalesce(p_limit, 200), 1), 1000)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create or replace function public.create_standard_cost_rate(
  p_cost_type        text,
  p_cost_type_name_ar text,
  p_product_family   text,
  p_product_id       text,
  p_base_quantity    numeric,
  p_rate             numeric,
  p_effective_from   date,
  p_idempotency_key  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = core, fin, public, pg_temp
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_existing text;
  v_id       text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not core.user_can('costing', 'create') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if p_cost_type is null or p_cost_type not in
     ('direct_labor', 'electricity', 'gas', 'maintenance', 'supervision', 'overhead') then
    return jsonb_build_object('status', 'invalid_cost_type');
  end if;

  if p_rate is null or p_rate < 0 then
    return jsonb_build_object('status', 'invalid_rate');
  end if;

  if p_base_quantity is null or p_base_quantity <= 0 then
    return jsonb_build_object('status', 'invalid_base_quantity');
  end if;

  if p_product_id is not null and p_product_id <> ''
     and not exists (select 1 from core.items i where i.id = p_product_id) then
    return jsonb_build_object('status', 'invalid_item');
  end if;

  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select r.invoice_id into v_existing
      from fin.rpc_idempotency r where r.key = p_idempotency_key;
    if v_existing is not null then
      return jsonb_build_object('status', 'existing', 'rate_id', v_existing);
    end if;
  end if;

  v_id := 'scr-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);

  insert into core.standard_cost_rates
    (id, cost_type, cost_type_name_ar, product_family, product_id,
     base_quantity, rate, effective_from, effective_to, status)
  values
    (v_id, p_cost_type::cost_type,
     coalesce(nullif(trim(p_cost_type_name_ar), ''), p_cost_type),
     nullif(trim(p_product_family), ''),
     nullif(trim(p_product_id), ''),
     p_base_quantity, p_rate, coalesce(p_effective_from, current_date), null, 'active');

  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into fin.rpc_idempotency (key, invoice_id)
    values (p_idempotency_key, v_id)
    on conflict (key) do update set invoice_id = excluded.invoice_id;
  end if;

  perform public.erp_write_audit(
    'costing', 'create', v_id, 'core.standard_cost_rates',
    format('إضافة معدل تكلفة معياري %s = %s / %s', p_cost_type, p_rate, p_base_quantity),
    jsonb_build_object('cost_type', p_cost_type, 'rate', p_rate,
                       'base_quantity', p_base_quantity, 'effective_from', p_effective_from));

  return jsonb_build_object('status', 'created', 'rate_id', v_id);
end;
$$;

create or replace function public.expire_standard_cost_rate(
  p_id             text,
  p_effective_to   date
)
returns jsonb
language plpgsql
security definer
set search_path = core, public, pg_temp
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_current text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not core.user_can('costing', 'edit') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select r.status::text into v_current
    from core.standard_cost_rates r where r.id = p_id;

  if v_current is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_current = 'expired' then
    return jsonb_build_object('status', 'already_expired');
  end if;

  update core.standard_cost_rates r
     set status = 'expired',
         effective_to = coalesce(p_effective_to, current_date)
   where r.id = p_id;

  perform public.erp_write_audit(
    'costing', 'edit', p_id, 'core.standard_cost_rates',
    format('إنهاء سريان معدل تكلفة معياري بتاريخ %s', coalesce(p_effective_to, current_date)),
    jsonb_build_object('status', 'expired', 'effective_to', coalesce(p_effective_to, current_date)));

  return jsonb_build_object('status', 'updated');
end;
$$;

revoke all on function public.list_standard_cost_rates(text, integer, integer) from public, anon;
revoke all on function public.create_standard_cost_rate(text, text, text, text, numeric, numeric, date, text)
  from public, anon;
revoke all on function public.expire_standard_cost_rate(text, date) from public, anon;
grant execute on function public.list_standard_cost_rates(text, integer, integer) to authenticated;
grant execute on function public.create_standard_cost_rate(text, text, text, text, numeric, numeric, date, text)
  to authenticated;
grant execute on function public.expire_standard_cost_rate(text, date) to authenticated;

commit;
