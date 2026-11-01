-- =====================================================================
-- 121_purchasing_documents.sql — part 3b: purchasing documents
--
-- New schema: nothing in TEST references these yet, so the FK graph is real
-- and complete. Batch numbers on purchase lines are the FIFO identity of the
-- received stock (inventory.batches is created/updated from them).
-- =====================================================================

create table if not exists purchasing.invoices (
  id text primary key,
  invoice_number text not null unique,
  date date not null,
  supplier_id text not null,
  warehouse_id text not null,
  payment_terms text not null default '',
  payment_method text not null default 'credit',
  currency text not null default 'EGP',
  exchange_rate numeric(18,6) not null default 1,
  reference text not null default '',
  subtotal numeric(18,4) not null default 0,
  vat_amount numeric(18,4) not null default 0,
  total_amount numeric(18,4) not null default 0,
  total_amount_egp numeric(18,4) not null default 0,
  status text not null default 'posted',
  journal_entry_id text,
  notes text,
  created_by text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchase_invoices_status_chk check (status in ('posted','cancelled')),
  constraint purchase_invoices_currency_chk check (currency in ('EGP','USD')),
  constraint purchase_invoices_payment_chk check (payment_method in ('cash','bank_transfer','credit','cheque')),
  constraint purchase_invoices_egp_rate_chk check (currency <> 'EGP' or exchange_rate = 1),
  constraint purchase_invoices_usd_rate_chk check (currency <> 'USD' or exchange_rate > 0),
  constraint purchase_invoices_totals_chk check (subtotal >= 0 and vat_amount >= 0
    and total_amount >= 0 and total_amount_egp >= 0)
);
create index if not exists purchase_invoices_supplier_idx on purchasing.invoices (supplier_id);
create index if not exists purchase_invoices_date_idx on purchasing.invoices (date desc);

create table if not exists purchasing.invoice_lines (
  id text primary key,
  purchase_invoice_id text not null references purchasing.invoices(id) on delete cascade,
  item_id text not null,
  quantity numeric(18,4) not null,
  unit_id text,
  unit_price numeric(18,4) not null default 0,
  batch_number text not null default '',
  production_date date,
  expiry_date date,
  vat_rate numeric(9,6) not null default 0,
  vat_amount numeric(18,4) not null default 0,
  net_total numeric(18,4) not null default 0,
  constraint purchase_invoice_lines_qty_chk check (quantity > 0),
  constraint purchase_invoice_lines_price_chk check (unit_price >= 0),
  constraint purchase_invoice_lines_vat_chk check (vat_rate >= 0 and vat_rate <= 1),
  constraint purchase_invoice_lines_expiry_chk check (
    expiry_date is null or production_date is null or expiry_date >= production_date)
);
create index if not exists purchase_invoice_lines_invoice_idx
  on purchasing.invoice_lines (purchase_invoice_id);

create table if not exists purchasing.returns (
  id text primary key,
  return_number text not null unique,
  purchase_invoice_id text references purchasing.invoices(id),
  supplier_id text not null,
  warehouse_id text not null,
  date date not null,
  reason text not null default '',
  total_amount numeric(18,4) not null default 0,
  total_vat numeric(18,4) not null default 0,
  status text not null default 'posted',
  journal_entry_id text,
  created_by text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchase_returns_status_chk check (status in ('posted','cancelled')),
  constraint purchase_returns_totals_chk check (total_amount >= 0 and total_vat >= 0)
);
create index if not exists purchase_returns_supplier_idx on purchasing.returns (supplier_id);

create table if not exists purchasing.return_lines (
  id text primary key,
  return_id text not null references purchasing.returns(id) on delete cascade,
  item_id text not null,
  quantity numeric(18,4) not null,
  unit_id text,
  unit_price numeric(18,4) not null default 0,
  vat_rate numeric(9,6) not null default 0,
  vat_amount numeric(18,4) not null default 0,
  net_total numeric(18,4) not null default 0,
  batch_number text,
  issued_unit_cost numeric(18,4),
  issued_cost_total numeric(18,4),
  constraint purchase_return_lines_qty_chk check (quantity > 0),
  constraint purchase_return_lines_cost_chk check (
    (issued_unit_cost is null or issued_unit_cost >= 0)
    and (issued_cost_total is null or issued_cost_total >= 0))
);
create index if not exists purchase_return_lines_return_idx
  on purchasing.return_lines (return_id);

do $$
declare t record;
begin
  for t in
    select c.relname as tbl
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r' and n.nspname = 'purchasing'
  loop
    execute format('drop trigger if exists trg_%1$s_touch on purchasing.%1$I', t.tbl);
    execute format('create trigger trg_%1$s_touch before update on purchasing.%1$I
                    for each row execute function core.touch_updated_at()', t.tbl);
  end loop;
end $$;
