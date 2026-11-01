-- =====================================================================
-- 110_core_master_data.sql — part 2 of 6: core master data
--
-- Every entity from src/types/erp.ts that is master/configuration data.
-- Money is numeric(18,4), quantities numeric(18,4), FX rates numeric(18,6).
-- Dates are real `date` columns (the deployed RPCs already compare them to
-- core.accounting_periods.start_date/end_date as dates).
--
-- Two groups of tables below:
--   (a) tables that ALREADY exist in TEST and are referenced by deployed
--       RPCs — created with `if not exists` plus additive `alter ... add
--       column if not exists`, so re-running can never fight the live shape;
--   (b) new tables that hold the entities the cloud schema was missing.
-- Historical-row foreign keys are deliberately NOT added to group (a):
-- validating years of existing rows is a separate, reviewable step (see
-- supabase/verify/verify_schema.sql). Group (b) gets real FKs.
-- =====================================================================

-- ---------------------------------------------------------------------
-- (a) already deployed — reconciliating definitions
-- ---------------------------------------------------------------------

-- ERP users / profiles (deployed: supabase_auth_id, user_id, role, active)
create table if not exists core.app_profiles (
  id text primary key,
  user_id uuid,
  supabase_auth_id text,
  username text,
  name text,
  email text,
  phone text,
  avatar text,
  role text,
  active boolean not null default true,
  permissions jsonb not null default '{}'::jsonb,
  warehouse_ids text[],
  last_login timestamptz,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table core.app_profiles add column if not exists user_id uuid;
alter table core.app_profiles add column if not exists supabase_auth_id text;
alter table core.app_profiles add column if not exists username text;
alter table core.app_profiles add column if not exists name text;
alter table core.app_profiles add column if not exists email text;
alter table core.app_profiles add column if not exists phone text;
alter table core.app_profiles add column if not exists avatar text;
alter table core.app_profiles add column if not exists role text;
alter table core.app_profiles add column if not exists active boolean default true;
alter table core.app_profiles add column if not exists permissions jsonb default '{}'::jsonb;
alter table core.app_profiles add column if not exists warehouse_ids text[];
alter table core.app_profiles add column if not exists last_login timestamptz;
alter table core.app_profiles add column if not exists is_test boolean default false;
alter table core.app_profiles add column if not exists created_at timestamptz default now();
alter table core.app_profiles add column if not exists updated_at timestamptz default now();
create index if not exists app_profiles_auth_uid_idx on core.app_profiles (supabase_auth_id);

-- Chart of accounts (deployed: id, code, name_ar, is_header, ...)
create table if not exists core.accounts (
  id text primary key,
  code text not null,
  name_ar text not null,
  name_en text not null default '',
  category text not null default 'Assets',
  is_header boolean not null default false,
  parent_id text references core.accounts(id),
  current_balance numeric(18,4) not null default 0,
  level integer not null default 1,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounts_code_key unique (code),
  constraint accounts_category_chk check (category in
    ('Assets','Liabilities','Equity','Revenue','COGS','Operating Expenses','Other Income','Other Expenses')),
  -- a header account aggregates; it must never carry a balance of its own
  constraint accounts_header_no_balance_chk check (is_header = false or current_balance = 0),
  constraint accounts_level_chk check (level between 1 and 9)
);
alter table core.accounts add column if not exists name_en text default '';
alter table core.accounts add column if not exists category text default 'Assets';
alter table core.accounts add column if not exists is_header boolean default false;
alter table core.accounts add column if not exists parent_id text;
alter table core.accounts add column if not exists current_balance numeric(18,4) default 0;
alter table core.accounts add column if not exists level integer default 1;
alter table core.accounts add column if not exists is_test boolean default false;
alter table core.accounts add column if not exists created_at timestamptz default now();
alter table core.accounts add column if not exists updated_at timestamptz default now();
create index if not exists accounts_parent_idx on core.accounts (parent_id);
create unique index if not exists accounts_code_uq on core.accounts (code);

-- Account mappings — the ONLY place a posting RPC may look up an account.
-- Keys required by the deployed sales/COGS path:
--   cogs_local, inventory_finished_local, cogs_export, inventory_finished_export
create table if not exists core.account_mappings (
  key text primary key,
  name_ar text not null default '',
  account_id text not null references core.accounts(id),
  is_test boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table core.account_mappings add column if not exists name_ar text default '';
alter table core.account_mappings add column if not exists is_test boolean default false;
alter table core.account_mappings add column if not exists updated_at timestamptz default now();

-- Accounting periods (deployed: start_date, end_date, is_closed, name_ar)
create table if not exists core.accounting_periods (
  id text primary key,
  code text,
  name_ar text not null default '',
  start_date date not null,
  end_date date not null,
  is_closed boolean not null default false,
  closed_at timestamptz,
  closed_by text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_periods_range_chk check (end_date >= start_date)
);
alter table core.accounting_periods add column if not exists code text;
alter table core.accounting_periods add column if not exists name_ar text default '';
alter table core.accounting_periods add column if not exists is_closed boolean default false;
alter table core.accounting_periods add column if not exists closed_at timestamptz;
alter table core.accounting_periods add column if not exists closed_by text;
alter table core.accounting_periods add column if not exists is_test boolean default false;
create index if not exists accounting_periods_range_idx
  on core.accounting_periods (start_date, end_date);

-- Units (deployed: id, code, name_ar, is_base)
create table if not exists core.units (
  id text primary key,
  code text not null,
  name_ar text not null,
  is_base boolean not null default false,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table core.units add column if not exists is_test boolean default false;
alter table core.units add column if not exists created_at timestamptz default now();
alter table core.units add column if not exists updated_at timestamptz default now();

-- Warehouses (deployed; WH-01..WH-05)
create table if not exists core.warehouses (
  id text primary key,
  code text not null,
  name_ar text not null,
  type text not null default 'raw_materials',
  location text not null default '',
  manager_name text,
  manager_user_id text,
  disabled_reason text,
  active boolean not null default true,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint warehouses_type_chk check (type in
    ('raw_materials','local_finished','export_finished','damaged','scrap'))
);
alter table core.warehouses add column if not exists manager_name text;
alter table core.warehouses add column if not exists manager_user_id text;
alter table core.warehouses add column if not exists disabled_reason text;
alter table core.warehouses add column if not exists active boolean default true;
alter table core.warehouses add column if not exists is_test boolean default false;
create unique index if not exists warehouses_code_uq on core.warehouses (code);

-- Items (deployed: id, code, name_ar, standard_cost, ...)
create table if not exists core.items (
  id text primary key,
  code text not null,
  barcode text,
  name_ar text not null,
  name_en text not null default '',
  item_type text not null default 'finished_product',
  product_family text,
  flavor text,
  base_unit_id text,
  purchase_unit_id text,
  vat_rate numeric(9,6) not null default 0,
  vat_category text not null default 'standard',
  track_batch boolean not null default false,
  track_expiry boolean not null default false,
  expiry_period_days integer,
  standard_cost numeric(18,4) not null default 0,
  actual_cost numeric(18,4) not null default 0,
  selling_price_retail numeric(18,4) not null default 0,
  selling_price_wholesale numeric(18,4) not null default 0,
  selling_price_export_usd numeric(18,4) not null default 0,
  active boolean not null default true,
  min_stock_level numeric(18,4) not null default 0,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint items_type_chk check (item_type in
    ('finished_product','raw_material','packaging_material','damaged','scrap','recyclable')),
  constraint items_family_chk check (product_family is null or product_family in ('Single','Duo')),
  constraint items_vat_rate_chk check (vat_rate >= 0 and vat_rate <= 1),
  constraint items_expiry_days_chk check (expiry_period_days is null or expiry_period_days > 0),
  constraint items_cost_nonneg_chk check (standard_cost >= 0 and actual_cost >= 0)
);
alter table core.items add column if not exists barcode text;
alter table core.items add column if not exists name_en text default '';
alter table core.items add column if not exists item_type text default 'finished_product';
alter table core.items add column if not exists product_family text;
alter table core.items add column if not exists flavor text;
alter table core.items add column if not exists base_unit_id text;
alter table core.items add column if not exists purchase_unit_id text;
alter table core.items add column if not exists vat_rate numeric(9,6) default 0;
alter table core.items add column if not exists vat_category text default 'standard';
alter table core.items add column if not exists track_batch boolean default false;
alter table core.items add column if not exists track_expiry boolean default false;
alter table core.items add column if not exists expiry_period_days integer;
alter table core.items add column if not exists standard_cost numeric(18,4) default 0;
alter table core.items add column if not exists actual_cost numeric(18,4) default 0;
alter table core.items add column if not exists selling_price_retail numeric(18,4) default 0;
alter table core.items add column if not exists selling_price_wholesale numeric(18,4) default 0;
alter table core.items add column if not exists selling_price_export_usd numeric(18,4) default 0;
alter table core.items add column if not exists active boolean default true;
alter table core.items add column if not exists min_stock_level numeric(18,4) default 0;
alter table core.items add column if not exists is_test boolean default false;
create unique index if not exists items_code_uq on core.items (code);
create index if not exists items_type_idx on core.items (item_type) where active;

-- Customers / suppliers (deployed)
create table if not exists core.customers (
  id text primary key,
  code text not null,
  name text not null,
  customer_type text not null default 'retail',
  channel text not null default '',
  address text not null default '',
  phone text not null default '',
  tax_number text,
  currency text not null default 'EGP',
  credit_limit numeric(18,4) not null default 0,
  current_balance numeric(18,4) not null default 0,
  payment_terms text,
  opening_balance numeric(18,4) not null default 0,
  active boolean not null default true,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_type_chk check (customer_type in ('retail','wholesale','export')),
  constraint customers_currency_chk check (currency in ('EGP','USD'))
);
alter table core.customers add column if not exists customer_type text default 'retail';
alter table core.customers add column if not exists channel text default '';
alter table core.customers add column if not exists address text default '';
alter table core.customers add column if not exists phone text default '';
alter table core.customers add column if not exists tax_number text;
alter table core.customers add column if not exists currency text default 'EGP';
alter table core.customers add column if not exists credit_limit numeric(18,4) default 0;
alter table core.customers add column if not exists current_balance numeric(18,4) default 0;
alter table core.customers add column if not exists payment_terms text;
alter table core.customers add column if not exists opening_balance numeric(18,4) default 0;
alter table core.customers add column if not exists active boolean default true;
alter table core.customers add column if not exists is_test boolean default false;
create unique index if not exists customers_code_uq on core.customers (code);

create table if not exists core.suppliers (
  id text primary key,
  code text not null,
  name text not null,
  tax_number text,
  contact_person text,
  phone text not null default '',
  address text not null default '',
  payment_terms text,
  currency text not null default 'EGP',
  opening_balance numeric(18,4) not null default 0,
  current_balance numeric(18,4) not null default 0,
  active boolean not null default true,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint suppliers_currency_chk check (currency in ('EGP','USD'))
);
alter table core.suppliers add column if not exists tax_number text;
alter table core.suppliers add column if not exists contact_person text;
alter table core.suppliers add column if not exists payment_terms text;
alter table core.suppliers add column if not exists currency text default 'EGP';
alter table core.suppliers add column if not exists opening_balance numeric(18,4) default 0;
alter table core.suppliers add column if not exists current_balance numeric(18,4) default 0;
alter table core.suppliers add column if not exists active boolean default true;
alter table core.suppliers add column if not exists is_test boolean default false;
create unique index if not exists suppliers_code_uq on core.suppliers (code);

-- ---------------------------------------------------------------------
-- (b) new core tables
-- ---------------------------------------------------------------------

create table if not exists core.companies (
  id text primary key,
  code text not null default 'COMP-1',
  name_ar text not null,
  name_en text not null default '',
  tax_number text not null default '',
  commercial_register text not null default '',
  address text not null default '',
  phone text not null default '',
  email text,
  website text,
  contact_name text,
  contact_phone text,
  logo_data_url text,
  base_currency text not null default 'EGP',
  export_currency text not null default 'USD',
  current_usd_exchange_rate numeric(18,6) not null default 1,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_base_currency_chk check (base_currency = 'EGP'),
  constraint companies_export_currency_chk check (export_currency = 'USD'),
  constraint companies_usd_rate_chk check (current_usd_exchange_rate > 0)
);

create table if not exists core.unit_conversions (
  id text primary key,
  from_unit_id text not null references core.units(id),
  to_unit_id text not null references core.units(id),
  factor numeric(18,6) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint unit_conversions_factor_chk check (factor > 0),
  constraint unit_conversions_distinct_chk check (from_unit_id <> to_unit_id),
  constraint unit_conversions_uq unique (from_unit_id, to_unit_id)
);

create table if not exists core.cost_centers (
  id text primary key,
  code text not null unique,
  name_ar text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.sales_reps (
  id text primary key,
  code text not null unique,
  name text not null,
  phone text not null default '',
  active boolean not null default true,
  target_monthly_sales numeric(18,4) not null default 0,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.rep_custody (
  id text primary key,
  custody_number text not null unique,
  rep_id text not null references core.sales_reps(id),
  status text not null default 'open',
  open_date date not null,
  settle_date date,
  close_date date,
  notes text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rep_custody_status_chk check (status in ('open','settled','reconciled')),
  constraint rep_custody_dates_chk check (close_date is null or close_date >= open_date)
);

create table if not exists core.custody_movements (
  id text primary key,
  custody_id text not null references core.rep_custody(id),
  item_id text not null,
  movement_type text not null,
  quantity numeric(18,4) not null,
  unit_cost numeric(18,4),
  unit_price numeric(18,4) not null default 0,
  batch_number text,
  date date not null,
  reference_doc text,
  created_at timestamptz not null default now(),
  constraint custody_movements_type_chk check (movement_type in ('loaded','sold','returned')),
  constraint custody_movements_qty_chk check (quantity > 0)
);

create table if not exists core.standard_cost_rates (
  id text primary key,
  cost_type text not null,
  cost_type_name_ar text not null default '',
  product_family text,
  product_id text,
  base_quantity numeric(18,4) not null default 1,
  rate numeric(18,4) not null default 0,
  effective_from date not null,
  effective_to date,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint standard_cost_rates_type_chk check (cost_type in
    ('direct_labor','electricity','gas','maintenance','supervision','overhead')),
  constraint standard_cost_rates_status_chk check (status in ('active','expired')),
  constraint standard_cost_rates_range_chk check (effective_to is null or effective_to >= effective_from),
  constraint standard_cost_rates_base_chk check (base_quantity > 0),
  constraint standard_cost_rates_rate_chk check (rate >= 0)
);

create table if not exists core.sales_forecasts (
  id text primary key,
  period text not null,
  product_id text not null,
  forecast_quantity numeric(18,4) not null default 0,
  actual_quantity numeric(18,4) not null default 0,
  variance_quantity numeric(18,4) not null default 0,
  accuracy_percentage numeric(9,4) not null default 0,
  unit_id text,
  updated_by_user_id text,
  updated_by_name text,
  notes text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_forecasts_period_chk check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint sales_forecasts_uq unique (period, product_id)
);

create table if not exists core.app_settings (
  id text primary key default 'default',
  expiry_warning_days integer not null default 10,
  invoice_template jsonb,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_settings_singleton_chk check (id = 'default'),
  constraint app_settings_expiry_days_chk check (expiry_warning_days between 1 and 365)
);

-- Append-only audit trail (no UPDATE/DELETE grants; see 150)
create table if not exists audit.logs (
  id text primary key,
  timestamp timestamptz not null default now(),
  user_id text not null default '',
  user_name text not null default '',
  module text not null,
  action text not null,
  record_id text not null default '',
  previous_value text,
  new_value text,
  description text not null default '',
  is_test boolean not null default false,
  constraint audit_logs_action_chk check (action in
    ('login','create','edit','approve','post','cancel','reverse'))
);
create index if not exists audit_logs_timestamp_idx on audit.logs (timestamp desc);
create index if not exists audit_logs_record_idx on audit.logs (module, record_id);

-- ---------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------
do $$
declare
  t record;
begin
  for t in
    select n.nspname as sch, c.relname as tbl
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r'
       and n.nspname in ('core')
       and c.relname in ('companies','warehouses','units','unit_conversions','items',
                         'customers','suppliers','sales_reps','rep_custody','cost_centers',
                         'accounts','account_mappings','accounting_periods',
                         'standard_cost_rates','sales_forecasts','app_settings','app_profiles')
  loop
    execute format('drop trigger if exists trg_%1$s_touch on %2$I.%1$I', t.tbl, t.sch);
    execute format('create trigger trg_%1$s_touch before update on %2$I.%1$I
                    for each row execute function core.touch_updated_at()', t.tbl, t.sch);
  end loop;
end $$;
