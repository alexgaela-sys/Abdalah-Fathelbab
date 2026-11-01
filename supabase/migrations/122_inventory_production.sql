-- =====================================================================
-- 122_inventory_production.sql — part 4 of 6: stock, production, quality
--
-- inventory.batches and inventory.transactions already exist in TEST (the
-- FIFO RPC writes them), so they are reconciled, not redefined. Their new
-- constraints are added NOT VALID: the check applies to every new row while
-- historical rows stay untouched until someone validates them deliberately.
-- =====================================================================

create table if not exists inventory.batches (
  id text primary key,
  item_id text not null,
  warehouse_id text not null,
  batch_number text not null,
  production_date date,
  expiry_date date,
  quantity numeric(18,4) not null default 0,
  unit_cost numeric(18,4) not null default 0,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- No `quantity >= 0` CHECK on purpose: negative stock is a business decision
  -- gated by a controlled permission (140_accounting_guards.sql, trigger
  -- trg_batch_negative_stock). A table CHECK would make that switch impossible.
  constraint inventory_batches_expiry_chk check (
    expiry_date is null or production_date is null or expiry_date >= production_date)
);
alter table inventory.batches add column if not exists id text;
alter table inventory.batches add column if not exists production_date date;
alter table inventory.batches add column if not exists expiry_date date;
alter table inventory.batches add column if not exists unit_cost numeric(18,4) default 0;
alter table inventory.batches add column if not exists is_test boolean default false;
alter table inventory.batches add column if not exists created_at timestamptz default now();
alter table inventory.batches add column if not exists updated_at timestamptz default now();
create index if not exists inventory_batches_fifo_idx
  on inventory.batches (item_id, warehouse_id, production_date, batch_number);
create index if not exists inventory_batches_expiry_idx
  on inventory.batches (expiry_date) where expiry_date is not null;

-- A (item, warehouse, batch_number) triple is the FIFO layer identity. The
-- deployed issuance RPC already assumes exactly one row per triple (it errors
-- on row_count <> 1), so enforce it — but never fail the migration if a
-- legacy duplicate exists: warn instead and leave the data for review.
do $$
begin
  begin
    create unique index if not exists inventory_batches_identity_uq
      on inventory.batches (item_id, warehouse_id, batch_number);
  exception when unique_violation then
    raise warning 'inventory.batches has duplicate (item_id, warehouse_id, batch_number) rows; uniqueness NOT enforced — review before adding';
  end;
end $$;

create table if not exists inventory.transactions (
  id text primary key,
  date date not null,
  document_type text not null default '',
  document_number text not null default '',
  movement_type text not null,
  item_id text not null,
  warehouse_id text not null,
  batch_number text,
  quantity_in numeric(18,4) not null default 0,
  quantity_out numeric(18,4) not null default 0,
  balance_after numeric(18,4),
  unit_cost numeric(18,4) not null default 0,
  total_cost numeric(18,4) not null default 0,
  notes text,
  created_by text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  constraint inventory_transactions_qty_chk check (quantity_in >= 0 and quantity_out >= 0),
  constraint inventory_transactions_one_side_chk check (quantity_in = 0 or quantity_out = 0),
  constraint inventory_transactions_type_chk check (movement_type in
    ('purchase_receipt','purchase_return','warehouse_transfer','production_consumption',
     'production_issue','production_return','production_output','sales','sales_return',
     'rep_loading','rep_return','scrap','recycling','inventory_adjustment','physical_inventory'))
);
alter table inventory.transactions add column if not exists created_by text;
alter table inventory.transactions add column if not exists is_test boolean default false;
alter table inventory.transactions add column if not exists created_at timestamptz default now();
create index if not exists inventory_transactions_doc_idx
  on inventory.transactions (document_number, movement_type);
create index if not exists inventory_transactions_item_wh_idx
  on inventory.transactions (item_id, warehouse_id, date);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_transactions_type_chk') then
    alter table inventory.transactions add constraint inventory_transactions_type_chk
      check (movement_type in
        ('purchase_receipt','purchase_return','warehouse_transfer','production_consumption',
         'production_issue','production_return','production_output','sales','sales_return',
         'rep_loading','rep_return','scrap','recycling','inventory_adjustment','physical_inventory'))
      not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inventory_transactions_qty_chk') then
    alter table inventory.transactions add constraint inventory_transactions_qty_chk
      check (quantity_in >= 0 and quantity_out >= 0) not valid;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Physical inventory counts
-- ---------------------------------------------------------------------
create table if not exists inventory.counts (
  id text primary key,
  count_number text not null unique,
  date date not null,
  warehouse_id text not null,
  status text not null default 'draft',
  notes text,
  approved_by text,
  journal_entry_id text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_counts_status_chk check (status in ('draft','approved','posted'))
);

create table if not exists inventory.count_lines (
  id text primary key,
  count_id text not null references inventory.counts(id) on delete cascade,
  item_id text not null,
  batch_number text,
  system_quantity numeric(18,4) not null default 0,
  physical_quantity numeric(18,4) not null default 0,
  variance_quantity numeric(18,4) not null default 0,
  unit_cost numeric(18,4) not null default 0,
  variance_cost numeric(18,4) not null default 0,
  constraint inventory_count_lines_physical_chk check (physical_quantity >= 0),
  constraint inventory_count_lines_variance_chk
    check (variance_quantity = physical_quantity - system_quantity)
);
create index if not exists inventory_count_lines_count_idx
  on inventory.count_lines (count_id);

-- ---------------------------------------------------------------------
-- Production
-- ---------------------------------------------------------------------
create table if not exists production.boms (
  id text primary key,
  bom_number text,
  finished_item_id text not null,
  code text,
  name_ar text,
  version integer not null default 1,
  base_quantity numeric(18,4) not null,
  unit_id text,
  active boolean not null default true,
  effective_date date not null default current_date,
  notes text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint boms_base_qty_chk check (base_quantity > 0),
  constraint boms_version_chk check (version >= 1)
);
create index if not exists boms_finished_item_idx on production.boms (finished_item_id);

create table if not exists production.bom_lines (
  id text primary key,
  bom_id text not null references production.boms(id) on delete cascade,
  material_item_id text not null,
  quantity_required numeric(18,4) not null,
  unit_id text,
  waste_percentage numeric(9,4),
  constraint bom_lines_qty_chk check (quantity_required > 0),
  constraint bom_lines_waste_chk check (waste_percentage is null
    or (waste_percentage >= 0 and waste_percentage <= 100))
);
create index if not exists bom_lines_bom_idx on production.bom_lines (bom_id);

create table if not exists production.orders (
  id text primary key,
  order_number text not null unique,
  product_id text not null,
  bom_id text,
  planned_quantity numeric(18,4) not null,
  produced_quantity numeric(18,4) not null default 0,
  defective_quantity numeric(18,4) not null default 0,
  scrap_quantity numeric(18,4) not null default 0,
  remaining_quantity numeric(18,4) not null default 0,
  start_date date not null,
  expected_completion_date date,
  actual_completion_date date,
  status text not null default 'draft',
  close_mode text,
  close_reason text,
  closed_by_user_id text,
  closed_by_name text,
  closed_at timestamptz,
  fg_capitalized_cost numeric(18,4),
  fg_conversion_capitalized numeric(18,4),
  material_reconciliation jsonb,
  destination_warehouse_id text not null,
  target_market text not null default 'local',
  bom_snapshot jsonb,
  quantity_edit_history jsonb,
  notes text,
  created_user_id text not null default '',
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint production_orders_status_chk check (status in
    ('draft','released','in_progress','completed','cancelled')),
  constraint production_orders_close_mode_chk check (close_mode is null or close_mode in ('full','partial')),
  constraint production_orders_market_chk check (target_market in ('local','export')),
  -- a partial close must always carry its persisted reason
  constraint production_orders_partial_reason_chk check (close_mode is distinct from 'partial' or length(coalesce(close_reason,'')) > 0),
  constraint production_orders_planned_chk check (planned_quantity > 0),
  constraint production_orders_qty_nonneg_chk check (
    produced_quantity >= 0 and defective_quantity >= 0 and scrap_quantity >= 0)
);
create index if not exists production_orders_status_idx on production.orders (status, start_date desc);

create table if not exists production.consumptions (
  id text primary key,
  production_order_id text not null references production.orders(id) on delete cascade,
  material_item_id text not null,
  batch_id text,
  warehouse_id text not null,
  unit_id text,
  planned_quantity numeric(18,4) not null default 0,
  actual_quantity numeric(18,4) not null default 0,
  unit_cost numeric(18,4) not null default 0,
  date date not null,
  batch_allocations jsonb,
  returned_quantity numeric(18,4) not null default 0,
  approved_variance_quantity numeric(18,4) not null default 0,
  approved_variance_reason text,
  issue_kind text,
  substitute_for_material_item_id text,
  issue_reason text,
  issued_by_user_id text,
  issued_by_name text,
  constraint production_consumptions_qty_chk check (
    actual_quantity >= 0 and planned_quantity >= 0 and returned_quantity >= 0),
  constraint production_consumptions_issue_kind_chk check (issue_kind is null
    or issue_kind in ('bom','substitute','additional')),
  -- non-BOM issues require a reason (approved outside the BOM)
  constraint production_consumptions_reason_chk check (
    issue_kind is null or issue_kind = 'bom' or length(coalesce(issue_reason,'')) > 0)
);
create index if not exists production_consumptions_order_idx
  on production.consumptions (production_order_id);

create table if not exists production.wastes (
  id text primary key,
  production_order_id text not null references production.orders(id) on delete cascade,
  material_item_id text not null,
  batch_number text not null default '',
  quantity numeric(18,4) not null,
  waste_type text not null,
  destination_warehouse_id text not null,
  reason text not null default '',
  action_taken text not null,
  date date not null,
  user_id text not null default '',
  constraint production_wastes_qty_chk check (quantity > 0),
  constraint production_wastes_type_chk check (waste_type in ('scrap','damaged','recyclable')),
  constraint production_wastes_action_chk check (action_taken in ('to_scrap','to_recycling'))
);
create index if not exists production_wastes_order_idx on production.wastes (production_order_id);

create table if not exists production.payroll_distributions (
  id text primary key,
  distribution_number text not null unique,
  period text not null,
  cost_type text not null,
  cost_type_name_ar text not null default '',
  total_amount numeric(18,4) not null,
  source_description text not null default '',
  allocations jsonb not null default '[]'::jsonb,
  status text not null default 'posted',
  reversed_at timestamptz,
  posted_at timestamptz not null default now(),
  user_id text not null default '',
  user_name text not null default '',
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_distributions_period_chk check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint payroll_distributions_type_chk check (cost_type in ('direct_labor','supervision')),
  constraint payroll_distributions_status_chk check (status in ('posted','reversed')),
  constraint payroll_distributions_amount_chk check (total_amount <> 0),
  -- one posting per (period, cost type): the expense can never be recognized twice
  constraint payroll_distributions_uq unique (period, cost_type)
);

-- ---------------------------------------------------------------------
-- Quality
-- ---------------------------------------------------------------------
create table if not exists quality.inspections (
  id text primary key,
  document_type text not null,
  document_number text not null default '',
  item_id text not null,
  batch_number text not null default '',
  inspected_quantity numeric(18,4) not null,
  date date not null,
  inspector_name text not null default '',
  result text not null,
  reason text,
  destination text not null,
  destination_warehouse_id text not null,
  notes text,
  created_by text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quality_inspections_doc_chk check (document_type in
    ('purchase_receipt','production_output','sales_return')),
  constraint quality_inspections_result_chk check (result in ('passed','rejected','conditional')),
  constraint quality_inspections_destination_chk check (destination in
    ('saleable','raw_materials','damaged','scrap','recycling')),
  constraint quality_inspections_qty_chk check (inspected_quantity > 0),
  -- a rejected inspection must say why
  constraint quality_inspections_reason_chk check (result = 'passed' or length(coalesce(reason,'')) > 0)
);
create index if not exists quality_inspections_doc_idx
  on quality.inspections (document_type, document_number);

do $$
declare t record;
begin
  for t in
    select n.nspname as sch, c.relname as tbl
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r'
       and ((n.nspname = 'inventory' and c.relname in ('counts'))
            or (n.nspname = 'production')
            or (n.nspname = 'quality'))
  loop
    execute format('drop trigger if exists trg_%1$s_touch on %2$I.%1$I', t.tbl, t.sch);
    execute format('create trigger trg_%1$s_touch before update on %2$I.%1$I
                    for each row execute function core.touch_updated_at()', t.tbl, t.sch);
  end loop;
end $$;
