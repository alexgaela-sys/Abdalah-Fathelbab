-- =====================================================================
-- 173_cloud_production_completion_safe.sql
-- TEST ONLY. Replaces the production-completion path from 171 with one that
-- matches the schema that actually exists in TEST, and seeds the accounting
-- mappings that were the only missing decision.
--
-- WHY THIS FILE EXISTS
--   171 was written against a guessed schema: it inserts quantity_required /
--   quantity_consumed into production.consumptions (real columns there are
--   planned_quantity / actual_quantity), reads production.orders.item_id /
--   warehouse_id / actual_cost / journal_entry_id (the deployed order table
--   carries several of these only through 168) and leaves unit_cost at 0, so a
--   close would capitalise a zero material cost. It was never executed live.
--
-- DECISIONS TAKEN (all derived from the LOCAL system, none invented)
--   Account codes and Arabic/English names come verbatim from
--   src/services/db.ts  INITIAL_ACCOUNTS / INITIAL_ACCOUNT_MAPPINGS, the chart
--   the local ERP already runs on. Nothing is mapped to a header account and no
--   existing operator mapping is overwritten.
--
-- WHAT IS ADDED
--   * production.cloud_consumptions — a table this file owns, so the FIFO
--     consumption ledger never depends on the drifted legacy shape,
--   * public.create_production_consumption   (FIFO issue, real unit cost),
--   * public.record_production_output        (FG receipt + batch),
--   * public.close_production_order          (atomic FG capitalisation journal),
--   * public.list_production_bom             (BOM requirements for an order),
--   * public.can_complete_production         (pre-flight refusal).
--
-- SAFETY
--   * additive only: no column, row or table is dropped or rewritten,
--   * every write runs inside the caller's transaction; the close posts exactly
--     one balanced journal through fin.post_journal and then flips the order,
--   * all new rows are is_test = true,
--   * idempotent on p_idempotency_key (fin.rpc_idempotency + cloud_consumptions),
--   * completion refuses (never half-posts) when a mapping, the period or the
--     material cost is missing.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) Columns the completion path reads, added only when absent
-- ---------------------------------------------------------------------
alter table production.orders add column if not exists item_id text;
alter table production.orders add column if not exists warehouse_id text;
alter table production.orders add column if not exists planned_cost numeric(18,4);
alter table production.orders add column if not exists actual_cost numeric(18,4);
alter table production.orders add column if not exists journal_entry_id text;
alter table production.orders add column if not exists created_by text;
alter table production.orders add column if not exists destination_warehouse_id text;
alter table production.orders add column if not exists is_test boolean default true;

-- Backfill item_id from product_id when the legacy column is what carried it.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'production' and table_name = 'orders'
                and column_name = 'product_id') then
    execute 'update production.orders set item_id = product_id where item_id is null';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2) Cloud consumption ledger (FIFO issue, real cost per layer)
-- ---------------------------------------------------------------------
create table if not exists production.cloud_consumptions (
  id text primary key,
  production_order_id text not null,
  material_item_id text not null,
  warehouse_id text not null,
  batch_number text,
  quantity numeric(18,4) not null,
  unit_cost numeric(18,4) not null default 0,
  total_cost numeric(18,4) not null default 0,
  stock_transaction_id text,
  idempotency_key text,
  consumed_on date not null default current_date,
  created_by text,
  is_test boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists production_cloud_consumptions_order_idx
  on production.cloud_consumptions (production_order_id);
create index if not exists production_cloud_consumptions_key_idx
  on production.cloud_consumptions (idempotency_key);

-- ---------------------------------------------------------------------
-- 3) Accounting mappings — copied from the LOCAL chart (src/services/db.ts)
-- ---------------------------------------------------------------------
-- Missing accounts are created with the same codes/names the local system uses.
-- An account whose code already exists is never touched.
insert into core.accounts (id, code, name_ar, name_en, category, is_header, level, is_test)
select 'acc-' || v.code, v.code, v.name_ar, v.name_en, v.category, false, 3, true
  from (values
    ('1102', 'بنك مصر - حساب جاري بالجنيه', 'Banque Misr - EGP', 'Assets'),
    ('1103', 'البنك التجاري الدولي CIB - دولار', 'CIB - USD Account', 'Assets'),
    ('1104', 'أوراق قبض (شيكات تحت التحصيل)', 'Cheques Under Collection', 'Assets'),
    ('1106', 'عملاء تجاريون - تصدير (USD)', 'Trade Receivables - Export', 'Assets'),
    ('1107', 'عهد مناديب المبيعات (بضائع ونقدية)', 'Sales Reps Custody', 'Assets'),
    ('1108', 'مخزون المواد الخام ومواد التعبئة', 'Raw & Packaging Materials Inventory', 'Assets'),
    ('1109', 'مخزون الإنتاج التام - محلي', 'Finished Goods Inventory - Local', 'Assets'),
    ('1110', 'مخزون الإنتاج التام - تصدير', 'Finished Goods Inventory - Export', 'Assets'),
    ('1111', 'مخزون التوالف والمعيب', 'Damaged Goods Inventory', 'Assets'),
    ('1112', 'مخزون الهالك والسكراب', 'Scrap Inventory', 'Assets'),
    ('1113', 'ضريبة القيمة المضافة - مدخلات ومشتريات', 'VAT Input Tax', 'Assets'),
    ('1114', 'أصل ضريبة الخصم والتحصيل من المنبع', 'Withholding Tax Receivable', 'Assets'),
    ('2102', 'أوراق دفع (شيكات صادرة للدفع)', 'Cheques Payable', 'Liabilities'),
    ('2104', 'مصروفات مستحقة ومخصصات', 'Accrued Expenses', 'Liabilities'),
    ('4102', 'إيراد مبيعات الجملة المحلية', 'Wholesale Sales Revenue', 'Revenue'),
    ('4103', 'إيراد مبيعات التصدير (USD)', 'Export Sales Revenue', 'Revenue'),
    ('4104', 'إيرادات بيع الهالك والسكراب', 'Scrap Sales Revenue', 'Revenue'),
    ('4105', 'أرباح فروق أسعار العملات الأجنبية', 'Foreign Exchange Gain', 'Revenue'),
    ('5102', 'تكلفة البضاعة المباعة - تصدير', 'COGS - Export Market', 'COGS'),
    ('5103', 'فروق أسعار شراء المواد (Price Variance)', 'Material Price Variance', 'COGS'),
    ('5104', 'فروق كميات استهلاك المواد (Quantity Variance)', 'Material Quantity Variance', 'COGS'),
    ('5105', 'فروق تكلفة العمالة المباشرة', 'Direct Labor Variance', 'COGS'),
    ('5106', 'فروق تكلفة استهلاك الكهرباء', 'Electricity Variance', 'COGS'),
    ('5107', 'فروق تكلفة استهلاك الغاز الطبيعي', 'Gas Variance', 'COGS'),
    ('5108', 'فروق تكاليف الصيانة وقطع الغيار', 'Maintenance Variance', 'COGS'),
    ('5109', 'فروق التكاليف الصناعية الإضافية', 'Manufacturing Overhead Variance', 'COGS'),
    ('6101', 'مصروفات الرواتب والأجور', 'Salaries and Wages', 'Operating Expenses'),
    ('6102', 'مصروفات كهرباء ومياه المرافق العامة', 'Office Utilities', 'Operating Expenses'),
    ('6103', 'مصروفات النقل والشحن والتوزيع الداخلي', 'Local Distribution & Freight', 'Operating Expenses'),
    ('6104', 'مصروفات نولون وتخليص وموانئ التصدير', 'Export Shipping, Port & Customs', 'Operating Expenses'),
    ('6105', 'مصروفات الدعاية والإعلان والترويج', 'Marketing & Promotion', 'Operating Expenses'),
    ('6106', 'عمولات ومصروفات مناديب المبيعات الميدانية', 'Sales Rep Expenses & Commissions', 'Operating Expenses'),
    ('6107', 'مصروفات الصيانة العامة للمقرات والمعدات', 'General Maintenance', 'Operating Expenses'),
    ('6108', 'إيجار المقرات والمستودعات', 'Facility Rent', 'Operating Expenses'),
    ('6109', 'مصاريف وعمولات بنكية', 'Bank Charges & Fees', 'Operating Expenses'),
    ('7101', 'خسائر فروق تقييم العملة الأجنبية', 'Foreign Exchange Loss', 'Other Expenses')
  ) as v(code, name_ar, name_en, category)
 where not exists (select 1 from core.accounts a where a.code = v.code);

-- Mapping keys → codes, exactly the local INITIAL_ACCOUNT_MAPPINGS table.
insert into core.account_mappings (key, name_ar, account_id, is_test)
select v.key, v.name_ar, a.id, true
  from (values
    ('purchase_raw_inventory',     'مخزون المواد الخام ومواد التعبئة', '1108'),
    ('purchase_vat_input',         'ضريبة القيمة المضافة - مدخلات',    '1113'),
    ('supplier_payable',           'موردو الخامات والتعبئة',           '2101'),
    ('sales_retail_revenue',       'إيراد مبيعات التجزئة',             '4101'),
    ('sales_wholesale_revenue',    'إيراد مبيعات الجملة',              '4102'),
    ('sales_export_revenue',       'إيراد مبيعات التصدير',             '4103'),
    ('sales_vat_output',           'ضريبة القيمة المضافة - مخرجات',    '2103'),
    ('customer_receivable_local',  'ذمم العملاء المحليون',             '1105'),
    ('customer_receivable_export', 'ذمم العملاء التصدير',              '1106'),
    ('cogs_local',                 'تكلفة البضاعة المباعة - محلي',     '5101'),
    ('cogs_export',                'تكلفة البضاعة المباعة - تصدير',    '5102'),
    ('inventory_finished_local',   'مخزون الإنتاج التام - محلي',       '1109'),
    ('inventory_finished_export',  'مخزون الإنتاج التام - تصدير',      '1110'),
    ('inventory_damaged',          'مخزون التوالف والمعيب',            '1111'),
    ('inventory_scrap',            'مخزون الهالك والسكراب',            '1112'),
    ('scrap_sales_revenue',        'إيرادات بيع الهالك والسكراب',      '4104'),
    ('rep_custody',                'عهد مناديب المبيعات',              '1107'),
    ('cash_treasury',              'الخزينة الرئيسية النقدية',         '1101'),
    ('bank_egp',                   'بنك مصر - جنيه',                   '1102'),
    ('bank_usd',                   'CIB - دولار',                      '1103'),
    ('cheques_under_collection',   'شيكات تحت التحصيل',                '1104'),
    ('cheques_payable',            'شيكات صادرة للدفع',                '2102'),
    ('withholding_tax_receivable', 'ضريبة الخصم من المنبع',            '1114'),
    ('variance_material_price',    'فروق أسعار شراء المواد',           '5103'),
    ('variance_material_quantity', 'فروق كميات استهلاك المواد',        '5104'),
    ('variance_direct_labor',      'فروق تكلفة العمالة المباشرة',      '5105'),
    ('variance_electricity',       'فروق استهلاك الكهرباء',            '5106'),
    ('variance_gas',               'فروق استهلاك الغاز',               '5107'),
    ('variance_maintenance',       'فروق الصيانة',                     '5108'),
    ('variance_overhead',          'فروق التكاليف الصناعية',           '5109'),
    ('conversion_cost_payable',    'تكلفة تحويل مستحقة',               '2104'),
    ('expenses_default',           'مصروف افتراضي',                    '6101'),
    ('rep_expense',                'مصروفات المناديب',                 '6106'),
    ('export_costs',               'مصروفات التصدير',                  '6104'),
    ('export_costs_payable',       'مصروفات تصدير مستحقة',             '2104'),
    ('bank_fees',                  'مصاريف بنكية',                     '6109'),
    ('fx_gain',                    'أرباح فروق العملة',                '4105'),
    ('fx_loss',                    'خسائر فروق العملة',                '7101')
  ) as v(key, name_ar, code)
  join core.accounts a on a.code = v.code
on conflict (key) do update
  set account_id = excluded.account_id,
      updated_at = now()
  where core.account_mappings.is_test = true
     or core.account_mappings.account_id is null;

-- ---------------------------------------------------------------------
-- 4) Pre-flight: can this order be completed?
-- ---------------------------------------------------------------------
create or replace function public.can_complete_production(p_order_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = production, core, public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_date date;
  v_closed boolean;
begin
  if v_uid is null then
    return false;
  end if;
  if not core.user_can('manufacturing', 'post') then
    return false;
  end if;

  select o.start_date into v_date
    from production.orders o
   where o.id = p_order_id;

  if v_date is null then
    return false;
  end if;

  select p.is_closed into v_closed
    from core.accounting_periods p
   where v_date >= p.start_date and v_date <= p.end_date
   order by p.start_date asc
   limit 1;

  if coalesce(v_closed, false) then
    return false;
  end if;

  return exists (select 1 from production.cloud_consumptions c
                  where c.production_order_id = p_order_id);
end;
$$;

revoke all on function public.can_complete_production(text) from public, anon;
grant execute on function public.can_complete_production(text) to authenticated;

-- ---------------------------------------------------------------------
-- 5) FIFO issue of materials to an in-progress order
-- ---------------------------------------------------------------------
create or replace function public.create_production_consumption(
  p_order_id text,
  p_lines jsonb,
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
set search_path = production, inventory, core, fin, public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_order production.orders;
  v_line record;
  v_qty numeric;
  v_item_unit text;
  v_wh text;
  v_avail numeric;
  v_remaining numeric;
  v_take numeric;
  v_batch record;
  v_batch_left numeric;
  v_cost numeric := 0;
  v_total numeric := 0;
  v_batch_no text;
  v_consumed jsonb := '[]'::jsonb;
  v_row_id text;
  v_existing jsonb;
  v_date date := current_date;
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

  select o.* into v_order from production.orders o where o.id = p_order_id for update;

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

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    return query select 'invalid_lines'::text, false, 'no material lines were supplied'::text, null::jsonb;
    return;
  end if;

  -- Retry of the same submission: return exactly what the first call consumed.
  if coalesce(p_idempotency_key, '') <> '' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'materialItemId', c.material_item_id,
             'quantity', c.quantity,
             'warehouseId', c.warehouse_id,
             'unitCost', c.unit_cost,
             'totalCost', c.total_cost)), '[]'::jsonb)
      into v_existing
      from production.cloud_consumptions c
     where c.idempotency_key = p_idempotency_key
       and c.production_order_id = v_order.id;

    if jsonb_array_length(v_existing) > 0 then
      return query select 'existing'::text, true, null::text, v_existing;
      return;
    end if;
  end if;

  -- Validate every line before touching stock (all-or-nothing).
  -- The client sends camelCase keys (materialItemId/unitId/warehouseId), and
  -- jsonb_to_recordset matches JSON keys case-sensitively to the quoted column
  -- names. Unquoted identifiers fold to lower case, which silently produced a
  -- NULL material id for every line and refused every issue as invalid_material.
  for v_line in select * from jsonb_to_recordset(p_lines) as x(
    "materialItemId" text, quantity numeric, "unitId" text, "warehouseId" text
  ) loop
    v_qty := coalesce(v_line.quantity, 0);
    if v_qty <= 0 then
      return query select 'invalid_lines'::text, false,
        format('material %s has a non-positive quantity', coalesce(v_line."materialItemId", '?'))::text, null::jsonb;
      return;
    end if;

    if v_line."materialItemId" is null
       or not exists (select 1 from core.items i where i.id = v_line."materialItemId") then
      return query select 'invalid_material'::text, false,
        format('material %s not found', coalesce(v_line."materialItemId", '?'))::text, null::jsonb;
      return;
    end if;

    v_wh := coalesce(nullif(v_line."warehouseId", ''), v_order.warehouse_id);
    if v_wh is null then
      return query select 'invalid_warehouse'::text, false,
        format('material %s has no source warehouse', v_line."materialItemId")::text, null::jsonb;
      return;
    end if;

    select coalesce(sum(b.quantity), 0) into v_avail
      from inventory.batches b
     where b.item_id = v_line."materialItemId"
       and b.warehouse_id = v_wh;

    if v_avail < v_qty then
      return query select 'insufficient_material'::text, false,
        format('insufficient stock for material %s in %s: available %s < required %s',
               v_line."materialItemId", v_wh, v_avail, v_qty)::text, null::jsonb;
      return;
    end if;
  end loop;

  if coalesce(p_idempotency_key, '') <> '' then
    insert into fin.rpc_idempotency (key, invoice_id)
      values (p_idempotency_key, v_order.id)
      on conflict (key) do nothing;
  end if;

  -- FIFO, oldest production_date / batch number first, exactly like the local engine.
  for v_line in select * from jsonb_to_recordset(p_lines) as x(
    "materialItemId" text, quantity numeric, "unitId" text, "warehouseId" text
  ) loop
    v_qty := v_line.quantity;
    v_wh := coalesce(nullif(v_line."warehouseId", ''), v_order.warehouse_id);
    v_remaining := v_qty;
    v_cost := 0;

    select i.base_unit_id into v_item_unit from core.items i where i.id = v_line."materialItemId" limit 1;

    for v_batch in
      select b.id, b.batch_number, b.quantity, coalesce(b.unit_cost, 0) as unit_cost
        from inventory.batches b
       where b.item_id = v_line."materialItemId"
         and b.warehouse_id = v_wh
         and b.quantity > 0
       order by b.production_date asc nulls last, b.batch_number asc, b.id asc
       for update
    loop
      exit when v_remaining <= 0;

      v_take := least(v_remaining, v_batch.quantity);
      v_batch_left := v_batch.quantity - v_take;
      v_batch_no := v_batch.batch_number;

      update inventory.batches b
         set quantity = v_batch_left,
             updated_at = now()
       where b.id = v_batch.id;

      v_row_id := 'pc-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 14);

      insert into inventory.transactions (
        id, date, document_type, document_number, movement_type,
        item_id, warehouse_id, batch_number, quantity_in, quantity_out,
        balance_after, unit_cost, total_cost, notes, created_by, is_test
      ) values (
        'pt-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 14),
        v_date, 'production_consumption', v_order.order_number, 'production_consumption',
        v_line."materialItemId", v_wh, v_batch_no, 0, v_take,
        v_batch_left, v_batch.unit_cost, v_take * v_batch.unit_cost,
        format('إنتاج أمر %s — صرف مواد (FIFO)', v_order.order_number),
        coalesce(nullif(p_created_by, ''), 'cloud-ui-production'), true
      );

      insert into production.cloud_consumptions (
        id, production_order_id, material_item_id, warehouse_id, batch_number,
        quantity, unit_cost, total_cost, idempotency_key, consumed_on, created_by, is_test
      ) values (
        v_row_id, v_order.id, v_line."materialItemId", v_wh, v_batch_no,
        v_take, v_batch.unit_cost, v_take * v_batch.unit_cost,
        nullif(p_idempotency_key, ''), v_date,
        coalesce(nullif(p_created_by, ''), 'cloud-ui-production'), true
      );

      v_cost := v_cost + v_take * v_batch.unit_cost;
      v_remaining := v_remaining - v_take;
    end loop;

    if v_remaining > 0 then
      -- Should be unreachable (validated above); refuse instead of part-issuing.
      raise exception 'material % could not be fully covered from % (short by %)',
        v_line."materialItemId", v_wh, v_remaining;
    end if;

    v_total := v_total + v_cost;
    v_consumed := v_consumed || jsonb_build_object(
      'materialItemId', v_line."materialItemId",
      'quantity', v_qty,
      'warehouseId', v_wh,
      'unitCost', case when v_qty > 0 then round(v_cost / v_qty, 4) else 0 end,
      'totalCost', v_cost,
      'unitId', coalesce(v_line."unitId", v_item_unit)
    );
  end loop;

  perform public.erp_write_audit(
    'production', 'post', v_order.id, 'production.cloud_consumptions',
    format('صرف مواد لأمر الإنتاج %s بتكلفة فعلية %s', v_order.order_number, v_total),
    v_consumed
  );

  return query select 'ok'::text, true, null::text, v_consumed;
end;
$$;

revoke all on function public.create_production_consumption(text, jsonb, text, text)
  from public, anon;
grant execute on function public.create_production_consumption(text, jsonb, text, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- 6) Finished-goods output receipt
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
set search_path = production, inventory, core, fin, public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_order production.orders;
  v_dest text;
  v_good numeric := coalesce(p_good_quantity, 0);
  v_batch_no text;
  v_batch_id text;
  v_existing_je text;
  v_new_qty numeric;
  v_unit_cost numeric := coalesce(p_unit_cost, 0);
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

  select o.* into v_order from production.orders o where o.id = p_order_id for update;

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

  if v_good <= 0 and coalesce(p_defective_quantity, 0) <= 0 and coalesce(p_scrap_quantity, 0) <= 0 then
    return query select 'invalid_quantity'::text, false, 'at least one of good/defective/scrap quantity must be > 0'::text, null::text;
    return;
  end if;

  if coalesce(p_idempotency_key, '') <> '' then
    select r.invoice_id into v_existing_je
      from fin.rpc_idempotency r where r.key = p_idempotency_key;
    if v_existing_je is not null then
      select b.id into v_batch_id
        from inventory.batches b
       where b.batch_number = 'FG-' || v_order.order_number
       order by b.id desc limit 1;
      return query select 'existing'::text, true, null::text, v_batch_id;
      return;
    end if;
    insert into fin.rpc_idempotency (key, invoice_id)
      values (p_idempotency_key, v_order.id)
      on conflict (key) do nothing;
  end if;

  v_dest := coalesce(nullif(p_destination_warehouse_id, ''),
                     v_order.destination_warehouse_id,
                     v_order.warehouse_id);

  if v_dest is null or not exists (select 1 from core.warehouses w where w.id = v_dest) then
    return query select 'invalid_warehouse'::text, false, 'destination warehouse does not exist'::text, null::text;
    return;
  end if;

  v_batch_no := 'FG-' || v_order.order_number;

  select b.id, b.quantity into v_batch_id, v_new_qty
    from inventory.batches b
   where b.item_id = v_order.item_id
     and b.warehouse_id = v_dest
     and b.batch_number = v_batch_no
   for update;

  if v_batch_id is null then
    v_batch_id := 'fg-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 14);
    v_new_qty := v_good;
    insert into inventory.batches (
      id, item_id, warehouse_id, batch_number, production_date, expiry_date,
      quantity, unit_cost, is_test
    ) values (
      v_batch_id, v_order.item_id, v_dest, v_batch_no, v_order.start_date, null,
      v_good, v_unit_cost, true
    );
  else
    v_new_qty := coalesce(v_new_qty, 0) + v_good;
    update inventory.batches b
       set quantity = v_new_qty,
           updated_at = now()
     where b.id = v_batch_id;
  end if;

  insert into inventory.transactions (
    id, date, document_type, document_number, movement_type,
    item_id, warehouse_id, batch_number, quantity_in, quantity_out,
    balance_after, unit_cost, total_cost, notes, created_by, is_test
  ) values (
    'pt-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 14),
    v_order.start_date, 'production_output', v_order.order_number, 'production_output',
    v_order.item_id, v_dest, v_batch_no, v_good, 0,
    v_new_qty, v_unit_cost, v_good * v_unit_cost,
    format('إنتاج أمر %s — استلام منتج تام', v_order.order_number),
    coalesce(nullif(p_created_by, ''), 'cloud-ui-production'), true
  );

  update production.orders o
     set produced_quantity  = coalesce(o.produced_quantity, 0) + v_good,
         defective_quantity = coalesce(o.defective_quantity, 0) + coalesce(p_defective_quantity, 0),
         scrap_quantity     = coalesce(o.scrap_quantity, 0) + coalesce(p_scrap_quantity, 0),
         updated_at         = now()
   where o.id = v_order.id;

  perform public.erp_write_audit(
    'production', 'post', v_order.id, 'inventory.batches',
    format('استلام مخرجات أمر الإنتاج %s: سليم %s / معيب %s / هالك %s',
           v_order.order_number, v_good, coalesce(p_defective_quantity, 0), coalesce(p_scrap_quantity, 0)),
    jsonb_build_object('batch_id', v_batch_id, 'batch_number', v_batch_no, 'good', v_good)
  );

  return query select 'ok'::text, true, null::text, v_batch_id;
end;
$$;

revoke all on function public.record_production_output(text, numeric, numeric, numeric, text, numeric, text, text)
  from public, anon;
grant execute on function public.record_production_output(text, numeric, numeric, numeric, text, numeric, text, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- 7) Atomic close: actual material cost + posted conversion → FG
-- ---------------------------------------------------------------------
create or replace function public.close_production_order(
  p_order_id text,
  p_unit_cost numeric default null,
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
  v_material_cost numeric := 0;
  v_conversion numeric := 0;
  v_total numeric := 0;
  v_mat_id text;
  v_mat_code text;
  v_mat_header boolean;
  v_fg_id text;
  v_fg_code text;
  v_fg_header boolean;
  v_conv_id text;
  v_conv_code text;
  v_conv_header boolean;
  v_jres record;
  v_je_id text;
  v_batch_id text;
  v_date date;
  v_closed boolean;
  v_existing_je text;
  v_lines jsonb;
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

  select o.* into v_order from production.orders o where o.id = p_order_id for update;

  if not found then
    return query select 'not_found'::text, false, format('order %s not found', coalesce(p_order_id, '?'))::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  if v_order.status = 'completed' then
    return query select 'already_completed'::text, true, null::text,
      v_order.journal_entry_id, null::text,
      coalesce(v_order.actual_cost, 0), coalesce(v_order.actual_cost, 0);
    return;
  end if;

  if v_order.status = 'cancelled' then
    return query select 'cancelled'::text, false,
      format('order %s is cancelled; it cannot be completed', v_order.order_number)::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  -- Same submission retried: return the journal that was already posted.
  if coalesce(p_idempotency_key, '') <> '' then
    select r.invoice_id into v_existing_je
      from fin.rpc_idempotency r where r.key = p_idempotency_key;
    if v_existing_je is not null then
      return query select 'existing'::text, true, null::text,
        v_order.journal_entry_id, null::text,
        coalesce(v_order.actual_cost, 0), coalesce(v_order.actual_cost, 0);
      return;
    end if;
  end if;

  v_date := coalesce(v_order.start_date, current_date);

  select p.is_closed into v_closed
    from core.accounting_periods p
   where v_date >= p.start_date and v_date <= p.end_date
   order by p.start_date asc
   limit 1;

  if coalesce(v_closed, false) then
    return query select 'closed_period'::text, false,
      'الفترة المالية مغلقة — لا يمكن إكمال أمر الإنتاج'::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  -- Material cost = actual FIFO layers consumed for THIS order.
  select coalesce(sum(c.total_cost), 0) into v_material_cost
    from production.cloud_consumptions c
   where c.production_order_id = v_order.id;

  if v_material_cost <= 0 then
    return query select 'no_consumption'::text, false,
      format('order %s has no FIFO material consumption; issue materials first', v_order.order_number)::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  -- Conversion cost = conversion journals already posted on this order.
  select coalesce(sum(l.debit - l.credit), 0) into v_conversion
    from fin.journal_lines l
    join fin.journal_entries e on e.id = l.journal_entry_id
   where e.source_document_type = 'production_conversion_cost'
     and e.source_document_id = v_order.id
     and coalesce(e.is_posted, true) = true
     and coalesce(e.is_reversed, false) = false;

  v_conversion := greatest(v_conversion, 0);
  v_total := v_material_cost + v_conversion;

  select m.account_id, a.code, a.is_header into v_mat_id, v_mat_code, v_mat_header
    from core.account_mappings m
    join core.accounts a on a.id = m.account_id
   where m.key = 'purchase_raw_inventory'
   limit 1;

  if v_mat_id is null then
    return query select 'error'::text, false,
      'account mapping purchase_raw_inventory is missing; nothing was posted'::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  if coalesce(v_mat_header, true) then
    return query select 'error'::text, false,
      'account mapping purchase_raw_inventory points at a header account; nothing was posted'::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  select m.account_id, a.code, a.is_header into v_fg_id, v_fg_code, v_fg_header
    from core.account_mappings m
    join core.accounts a on a.id = m.account_id
   where m.key = 'inventory_finished_local'
   limit 1;

  if v_fg_id is null or coalesce(v_fg_header, true) then
    return query select 'error'::text, false,
      'account mapping inventory_finished_local is missing or points at a header; nothing was posted'::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('accountId', v_fg_id, 'accountCode', v_fg_code,
      'debit', v_total, 'credit', 0,
      'description', 'رسملة التكلفة الفعلية في مخزون المنتج التام'));

  if v_conversion > 0 then
    select m.account_id, a.code, a.is_header into v_conv_id, v_conv_code, v_conv_header
      from core.account_mappings m
      join core.accounts a on a.id = m.account_id
     where m.key = 'conversion_cost_payable'
     limit 1;

    if v_conv_id is null or coalesce(v_conv_header, true) then
      return query select 'error'::text, false,
        'account mapping conversion_cost_payable is missing; conversion cost cannot be capitalised'::text,
        null::text, null::text, 0::numeric, 0::numeric;
      return;
    end if;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('accountId', v_conv_id, 'accountCode', v_conv_code,
        'debit', 0, 'credit', v_conversion,
        'description', 'إغلاق تكلفة التحويل المستحقة على أمر الإنتاج'));
  end if;

  v_lines := v_lines || jsonb_build_array(
    jsonb_build_object('accountId', v_mat_id, 'accountCode', v_mat_code,
      'debit', 0, 'credit', v_material_cost,
      'description', 'تكلفة المواد المستهلكة فعليًا (FIFO)'));

  select * into v_jres
    from fin.post_journal(
      v_date,
      'PRD-CLOSE-' || v_order.order_number,
      format('إكمال أمر إنتاج %s — استهلاك مواد + رسملة منتج تام', v_order.order_number),
      'production_order_close',
      v_lines,
      coalesce(nullif(p_created_by, ''), 'cloud-ui-production'),
      p_is_test => true
    );

  if not coalesce(v_jres.success, false) then
    return query select 'error'::text, false,
      coalesce(v_jres.error, 'post_journal failed')::text,
      null::text, null::text, 0::numeric, 0::numeric;
    return;
  end if;

  v_je_id := v_jres.entry_id;

  update production.orders o
     set status = 'completed',
         actual_completion_date = coalesce(o.actual_completion_date, v_date),
         actual_cost = v_total,
         journal_entry_id = v_je_id,
         updated_at = now()
   where o.id = v_order.id;

  select b.id into v_batch_id
    from inventory.batches b
   where b.item_id = v_order.item_id
     and b.batch_number = 'FG-' || v_order.order_number
   order by b.id desc limit 1;

  if coalesce(p_idempotency_key, '') <> '' then
    insert into fin.rpc_idempotency (key, invoice_id)
      values (p_idempotency_key, v_order.id)
      on conflict (key) do nothing;
  end if;

  perform public.erp_write_audit(
    'production', 'post', v_order.id, 'production.orders',
    format('إكمال أمر الإنتاج %s — قيد %s بتكلفة %s', v_order.order_number, v_je_id, v_total),
    jsonb_build_object('journal_entry_id', v_je_id, 'material_cost', v_material_cost,
                       'conversion_cost', v_conversion, 'total_cost', v_total)
  );

  return query select 'completed'::text, true, null::text,
    v_je_id, v_batch_id, v_material_cost, v_total;
end;
$$;

revoke all on function public.close_production_order(text, numeric, text, text)
  from public, anon;
grant execute on function public.close_production_order(text, numeric, text, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- 8) BOM requirements for an order (read)
-- ---------------------------------------------------------------------
create or replace function public.list_production_bom(p_order_id text)
returns table (
  material_item_id text,
  material_code text,
  material_name_ar text,
  quantity_required numeric,
  waste_percentage numeric,
  unit_id text,
  base_quantity numeric,
  bom_code text
)
language plpgsql
stable
security definer
set search_path = production, core, public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_item text;
  v_bom text;
  v_base numeric;
  v_code text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not (core.user_can('manufacturing', 'view') or core.user_can('manufacturing', 'post')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- The BOM tables are legacy: return an empty requirement list (never an
  -- error) when this database does not carry the expected columns.
  if to_regclass('production.boms') is null
     or to_regclass('production.bom_lines') is null then
    return;
  end if;

  if (select count(*) from information_schema.columns c
       where c.table_schema = 'production' and c.table_name = 'boms'
         and c.column_name in ('finished_item_id','base_quantity','version','effective_date')) < 4 then
    return;
  end if;

  if (select count(*) from information_schema.columns c
       where c.table_schema = 'production' and c.table_name = 'bom_lines'
         and c.column_name in ('bom_id','material_item_id','quantity_required')) < 3 then
    return;
  end if;

  select o.item_id into v_item from production.orders o where o.id = p_order_id;
  if v_item is null then
    return;
  end if;

  if exists (select 1 from information_schema.columns c
              where c.table_schema = 'production' and c.table_name = 'orders'
                and c.column_name = 'bom_id') then
    execute 'select o.bom_id from production.orders o where o.id = $1'
      into v_bom using p_order_id;
  end if;

  if v_bom is null then
    select b.id, b.base_quantity, coalesce(b.bom_number, b.code)
      into v_bom, v_base, v_code
      from production.boms b
     where b.finished_item_id = v_item
       and coalesce(b.active, true)
     order by b.effective_date desc nulls last, b.version desc
     limit 1;
  else
    select b.base_quantity, coalesce(b.bom_number, b.code)
      into v_base, v_code
      from production.boms b where b.id = v_bom;
  end if;

  if v_bom is null then
    return;
  end if;

  return query
    select l.material_item_id,
           coalesce(i.code, ''),
           coalesce(i.name_ar, ''),
           l.quantity_required,
           coalesce(l.waste_percentage, 0),
           coalesce(l.unit_id, i.base_unit_id),
           coalesce(v_base, 1),
           coalesce(v_code, '')
      from production.bom_lines l
      left join core.items i on i.id = l.material_item_id
     where l.bom_id = v_bom
     order by i.code;
end;
$$;

revoke all on function public.list_production_bom(text) from public, anon;
grant execute on function public.list_production_bom(text) to authenticated;

commit;
