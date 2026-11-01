-- =====================================================================
-- 120_sales_documents.sql — part 3 of 6: sales documents
--
-- sales.invoices / sales.invoice_lines already exist in TEST and are read
-- and written by the deployed RPCs, so they are created `if not exists`
-- with the exact deployed column names and extended additively.
-- The return / withholding / scrap documents are new.
-- =====================================================================

create table if not exists sales.invoices (
  id text primary key,
  invoice_number text not null,
  date date not null,
  customer_id text not null,
  channel text not null default 'retail',
  warehouse_id text not null,
  rep_id text,
  payment_method text not null default 'cash',
  currency text not null default 'EGP',
  exchange_rate numeric(18,6) not null default 1,
  subtotal numeric(18,4) not null default 0,
  discount_amount numeric(18,4) not null default 0,
  vat_amount numeric(18,4) not null default 0,
  total_amount numeric(18,4) not null default 0,
  total_amount_egp numeric(18,4) not null default 0,
  cogs_total numeric(18,4) not null default 0,
  status text not null default 'posted',
  journal_entry_id text,
  stock_source text not null default 'warehouse',
  custody_id text,
  export_shipment_id text,
  tax_treatment text,
  bonus_quantity numeric(18,4),
  cash_amount numeric(18,4),
  withholding_amount numeric(18,4),
  withholding_reason text,
  withholding_rate numeric(9,6),
  withholding_enabled boolean,
  withholding_base numeric(18,4),
  notes text,
  created_by text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_invoices_channel_chk check (channel in ('retail','wholesale','export')),
  constraint sales_invoices_status_chk check (status in ('posted','cancelled')),
  constraint sales_invoices_currency_chk check (currency in ('EGP','USD')),
  constraint sales_invoices_payment_chk check (payment_method in ('cash','bank_transfer','credit','cheque')),
  constraint sales_invoices_stock_source_chk check (stock_source in ('warehouse','rep_custody')),
  constraint sales_invoices_egp_rate_chk check (currency <> 'EGP' or exchange_rate = 1),
  constraint sales_invoices_usd_rate_chk check (currency <> 'USD' or exchange_rate > 0),
  constraint sales_invoices_tax_treatment_chk check (tax_treatment is null or tax_treatment in ('taxable','exempt')),
  -- a rep_custody invoice must name the custody it was issued from
  constraint sales_invoices_custody_chk check (stock_source <> 'rep_custody' or custody_id is not null),
  constraint sales_invoices_totals_chk check (
    subtotal >= 0 and discount_amount >= 0 and vat_amount >= 0
    and total_amount >= 0 and total_amount_egp >= 0 and cogs_total >= 0
  )
);
alter table sales.invoices add column if not exists rep_id text;
alter table sales.invoices add column if not exists export_shipment_id text;
alter table sales.invoices add column if not exists tax_treatment text;
alter table sales.invoices add column if not exists bonus_quantity numeric(18,4);
alter table sales.invoices add column if not exists cash_amount numeric(18,4);
alter table sales.invoices add column if not exists withholding_amount numeric(18,4);
alter table sales.invoices add column if not exists withholding_reason text;
alter table sales.invoices add column if not exists withholding_rate numeric(9,6);
alter table sales.invoices add column if not exists withholding_enabled boolean;
alter table sales.invoices add column if not exists withholding_base numeric(18,4);
alter table sales.invoices add column if not exists notes text;
alter table sales.invoices add column if not exists created_by text;
alter table sales.invoices add column if not exists is_test boolean default false;
alter table sales.invoices add column if not exists created_at timestamptz default now();
alter table sales.invoices add column if not exists updated_at timestamptz default now();
create unique index if not exists sales_invoices_number_uq on sales.invoices (invoice_number);
create index if not exists sales_invoices_date_idx on sales.invoices (date desc);
create index if not exists sales_invoices_customer_idx on sales.invoices (customer_id);
create index if not exists sales_invoices_journal_idx on sales.invoices (journal_entry_id);

create table if not exists sales.invoice_lines (
  id text primary key,
  invoice_id text not null references sales.invoices(id) on delete cascade,
  item_id text not null,
  batch_id text,
  quantity numeric(18,4) not null,
  free_quantity numeric(18,4) not null default 0,
  unit_price numeric(18,4) not null default 0,
  unit_cost numeric(18,4) not null default 0,
  discount numeric(18,4) not null default 0,
  vat_rate numeric(9,6) not null default 0,
  vat_amount numeric(18,4) not null default 0,
  total_before_vat numeric(18,4) not null default 0,
  net_total numeric(18,4) not null default 0,
  withholding_amount numeric(18,4),
  constraint sales_invoice_lines_qty_chk check (quantity > 0 and free_quantity >= 0),
  constraint sales_invoice_lines_price_chk check (unit_price >= 0 and discount >= 0),
  constraint sales_invoice_lines_vat_chk check (vat_rate >= 0 and vat_rate <= 1)
);
alter table sales.invoice_lines add column if not exists batch_id text;
alter table sales.invoice_lines add column if not exists withholding_amount numeric(18,4);
create index if not exists sales_invoice_lines_invoice_idx on sales.invoice_lines (invoice_id);
create index if not exists sales_invoice_lines_item_idx on sales.invoice_lines (item_id);

-- ---------------------------------------------------------------------
-- Sales returns
-- ---------------------------------------------------------------------
create table if not exists sales.returns (
  id text primary key,
  return_number text not null unique,
  invoice_id text references sales.invoices(id),
  customer_id text not null,
  date date not null,
  reason text not null default '',
  total_amount numeric(18,4) not null default 0,
  total_vat numeric(18,4) not null default 0,
  status text not null default 'pending_inspection',
  journal_entry_id text,
  withholding_reversed_amount_egp numeric(18,4) not null default 0,
  created_by text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_returns_status_chk check (status in
    ('pending_inspection','inspected','posted','cancelled')),
  constraint sales_returns_totals_chk check (total_amount >= 0 and total_vat >= 0
    and withholding_reversed_amount_egp >= 0)
);
create index if not exists sales_returns_invoice_idx on sales.returns (invoice_id);
create index if not exists sales_returns_date_idx on sales.returns (date desc);

create table if not exists sales.return_lines (
  id text primary key,
  return_id text not null references sales.returns(id) on delete cascade,
  item_id text not null,
  quantity numeric(18,4) not null,
  unit_price numeric(18,4) not null default 0,
  batch_number text not null default '',
  free_quantity numeric(18,4) not null default 0,
  vat_rate numeric(9,6) not null default 0,
  quality_destination text,
  destination_warehouse_id text,
  constraint sales_return_lines_qty_chk check (quantity > 0 and free_quantity >= 0),
  constraint sales_return_lines_destination_chk check (quality_destination is null
    or quality_destination in ('saleable','raw_materials','damaged','scrap','recycling'))
);
create index if not exists sales_return_lines_return_idx on sales.return_lines (return_id);

-- ---------------------------------------------------------------------
-- Withholding-at-source reversal documents (F-WH fix)
-- ---------------------------------------------------------------------
create table if not exists sales.withholding_adjustments (
  id text primary key,
  adjustment_number text not null unique,
  type text not null default 'return_reversal',
  adjustment_date date not null,
  payment_id text not null,
  invoice_id text references sales.invoices(id),
  sales_return_id text references sales.returns(id),
  amount_egp numeric(18,4) not null,
  journal_entry_id text,
  reason text not null default '',
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint withholding_adjustments_type_chk check (type = 'return_reversal'),
  constraint withholding_adjustments_amount_chk check (amount_egp > 0)
);

-- ---------------------------------------------------------------------
-- Internal scrap sales (ITEM 12) — a document, never a normal invoice
-- ---------------------------------------------------------------------
create table if not exists sales.scrap_sales (
  id text primary key,
  doc_number text not null unique,
  date date not null,
  item_id text not null,
  quantity numeric(18,4) not null,
  unit_id text,
  unit_price numeric(18,4) not null default 0,
  unit_cost numeric(18,4) not null default 0,
  total_value numeric(18,4) not null default 0,
  book_value numeric(18,4) not null default 0,
  buyer_name text not null default '',
  payment_method text not null default 'cash',
  warehouse_id text not null,
  status text not null default 'posted',
  journal_entry_id text,
  cost_journal_entry_id text,
  reversal_journal_entry_ids text[],
  notes text,
  created_by_user_id text not null default '',
  created_by_name text not null default '',
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scrap_sales_qty_chk check (quantity > 0),
  constraint scrap_sales_payment_chk check (payment_method in ('cash','credit')),
  constraint scrap_sales_status_chk check (status in ('posted','cancelled')),
  constraint scrap_sales_values_chk check (total_value >= 0 and book_value >= 0)
);

do $$
declare t record;
begin
  for t in
    select c.relname as tbl
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r' and n.nspname = 'sales'
       and c.relname in ('invoices','returns','withholding_adjustments','scrap_sales')
  loop
    execute format('drop trigger if exists trg_%1$s_touch on sales.%1$I', t.tbl);
    execute format('create trigger trg_%1$s_touch before update on sales.%1$I
                    for each row execute function core.touch_updated_at()', t.tbl);
  end loop;
end $$;
