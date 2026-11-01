-- =====================================================================
-- 130_finance_treasury.sql — part 5 of 6: ledger + treasury
--
-- fin.journal_entries / fin.journal_lines / fin.rpc_idempotency already exist
-- in TEST and are written by fin.post_journal and the sales RPCs, so they are
-- reconciled with the exact deployed column names. The balance / header /
-- closed-period guards live in 140_accounting_guards.sql.
-- =====================================================================

create table if not exists fin.journal_entries (
  id text primary key,
  entry_number text not null,
  date date not null,
  reference text not null default '',
  description text not null default '',
  source_document_type text not null default '',
  source_document_id text,
  is_posted boolean not null default false,
  posted_at timestamptz,
  is_reversed boolean not null default false,
  reversed_by_entry_id text,
  total_debit numeric(18,4) not null default 0,
  total_credit numeric(18,4) not null default 0,
  created_user_id text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  constraint journal_entries_totals_chk check (total_debit >= 0 and total_credit >= 0),
  -- a posted entry must be balanced at the header level too
  constraint journal_entries_balanced_header_chk check (
    is_posted = false or abs(total_debit - total_credit) <= 0.01)
);
alter table fin.journal_entries add column if not exists is_reversed boolean default false;
alter table fin.journal_entries add column if not exists reversed_by_entry_id text;
alter table fin.journal_entries add column if not exists total_debit numeric(18,4) default 0;
alter table fin.journal_entries add column if not exists total_credit numeric(18,4) default 0;
alter table fin.journal_entries add column if not exists created_user_id text;
alter table fin.journal_entries add column if not exists is_test boolean default false;
alter table fin.journal_entries add column if not exists created_at timestamptz default now();
create unique index if not exists journal_entries_number_uq on fin.journal_entries (entry_number);
create index if not exists journal_entries_date_idx on fin.journal_entries (date desc);
create index if not exists journal_entries_source_idx
  on fin.journal_entries (source_document_type, source_document_id);

create table if not exists fin.journal_lines (
  id text primary key,
  journal_entry_id text not null references fin.journal_entries(id) on delete cascade,
  account_id text not null,
  account_code text not null default '',
  account_name_ar text not null default '',
  debit numeric(18,4) not null default 0,
  credit numeric(18,4) not null default 0,
  currency text not null default 'EGP',
  original_amount numeric(18,4) not null default 0,
  exchange_rate numeric(18,6) not null default 1,
  cost_center_id text,
  description text,
  constraint journal_lines_amounts_chk check (debit >= 0 and credit >= 0),
  -- one side only: a line is a debit or a credit, never both
  constraint journal_lines_one_side_chk check (debit = 0 or credit = 0),
  constraint journal_lines_nonzero_chk check (debit > 0 or credit > 0),
  constraint journal_lines_currency_chk check (currency in ('EGP','USD'))
);
alter table fin.journal_lines add column if not exists currency text default 'EGP';
alter table fin.journal_lines add column if not exists original_amount numeric(18,4) default 0;
alter table fin.journal_lines add column if not exists exchange_rate numeric(18,6) default 1;
alter table fin.journal_lines add column if not exists cost_center_id text;
alter table fin.journal_lines add column if not exists description text;
create index if not exists journal_lines_entry_idx on fin.journal_lines (journal_entry_id);
create index if not exists journal_lines_account_idx on fin.journal_lines (account_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'journal_lines_one_side_chk') then
    alter table fin.journal_lines add constraint journal_lines_one_side_chk
      check (debit = 0 or credit = 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'journal_lines_amounts_chk') then
    alter table fin.journal_lines add constraint journal_lines_amounts_chk
      check (debit >= 0 and credit >= 0) not valid;
  end if;
end $$;

-- Idempotency ledger: one row per RPC key. The deployed RPCs lock this table.
create table if not exists fin.rpc_idempotency (
  key text primary key,
  invoice_id text,
  created_at timestamptz not null default now()
);
alter table fin.rpc_idempotency add column if not exists invoice_id text;
alter table fin.rpc_idempotency add column if not exists created_at timestamptz default now();

-- ---------------------------------------------------------------------
-- Payments + allocations
-- ---------------------------------------------------------------------
create table if not exists treasury.payments (
  id text primary key,
  payment_number text not null unique,
  payment_type text not null,
  party_id text not null,
  date date not null,
  payment_method text not null default 'cash',
  bank_account_id text,
  cheque_id text,
  amount numeric(18,4) not null,
  currency text not null default 'EGP',
  exchange_rate numeric(18,6) not null default 1,
  amount_egp numeric(18,4) not null default 0,
  reference text not null default '',
  notes text,
  journal_entry_id text,
  withholding_amount_egp numeric(18,4),
  withholding_certificate_no text,
  withholding_document_date date,
  withholding_invoice_id text,
  withholding_reversed_amount_egp numeric(18,4) not null default 0,
  created_by text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_type_chk check (payment_type in ('customer_receipt','supplier_payment')),
  constraint payments_method_chk check (payment_method in ('cash','bank','cheque')),
  constraint payments_currency_chk check (currency in ('EGP','USD')),
  constraint payments_amount_chk check (amount > 0 and amount_egp > 0),
  constraint payments_withholding_chk check (
    (withholding_amount_egp is null or withholding_amount_egp >= 0)
    and withholding_reversed_amount_egp >= 0),
  -- a cheque payment must name its cheque; a bank payment must name its account
  constraint payments_cheque_chk check (payment_method <> 'cheque' or cheque_id is not null),
  constraint payments_bank_chk check (payment_method <> 'bank' or bank_account_id is not null)
);
create index if not exists payments_party_idx on treasury.payments (party_id, date desc);

create table if not exists treasury.payment_allocations (
  id text primary key,
  payment_id text not null references treasury.payments(id) on delete cascade,
  invoice_id text not null,
  invoice_type text not null,
  allocated_amount numeric(18,4) not null,
  constraint payment_allocations_type_chk check (invoice_type in ('sales','purchase')),
  constraint payment_allocations_amount_chk check (allocated_amount > 0)
);
create index if not exists payment_allocations_payment_idx
  on treasury.payment_allocations (payment_id);

-- ---------------------------------------------------------------------
-- Cheques
-- ---------------------------------------------------------------------
create table if not exists treasury.cheques (
  id text primary key,
  cheque_number text not null,
  type text not null,
  party_type text not null,
  party_id text not null,
  bank_name text not null default '',
  amount numeric(18,4) not null,
  currency text not null default 'EGP',
  exchange_rate numeric(18,6),
  issue_date date not null,
  due_date date not null,
  status text not null default 'received',
  status_date date not null,
  related_transaction_id text,
  notes text,
  journal_entry_id text,
  receipt_journal_id text,
  created_by text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cheques_type_chk check (type in ('incoming','outgoing')),
  constraint cheques_party_chk check (party_type in ('customer','supplier')),
  constraint cheques_currency_chk check (currency in ('EGP','USD')),
  constraint cheques_status_chk check (status in
    ('received','under_collection','collected','returned','bounced','issued','due','paid')),
  constraint cheques_amount_chk check (amount > 0),
  -- USD cheques must carry the documented rate; never a silent rate of 1
  constraint cheques_usd_rate_chk check (currency <> 'USD' or (exchange_rate is not null and exchange_rate > 0)),
  constraint cheques_due_date_chk check (due_date >= issue_date)
);
create index if not exists cheques_party_idx on treasury.cheques (party_type, party_id);
create index if not exists cheques_status_idx on treasury.cheques (status, due_date);

-- ---------------------------------------------------------------------
-- Banks
-- ---------------------------------------------------------------------
create table if not exists treasury.bank_accounts (
  id text primary key,
  account_number text not null unique,
  bank_name text not null default '',
  branch text not null default '',
  currency text not null default 'EGP',
  current_balance numeric(18,4) not null default 0,
  gl_account_id text not null references core.accounts(id),
  active boolean not null default true,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bank_accounts_currency_chk check (currency in ('EGP','USD'))
);

create table if not exists treasury.bank_transactions (
  id text primary key,
  transaction_number text not null unique,
  bank_account_id text not null references treasury.bank_accounts(id),
  type text not null,
  amount numeric(18,4) not null,
  currency text,
  date date not null,
  reference text not null default '',
  description text not null default '',
  journal_entry_id text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bank_transactions_type_chk check (type in ('deposit','withdrawal','transfer','bank_fee')),
  constraint bank_transactions_amount_chk check (amount > 0)
);
create index if not exists bank_transactions_account_idx
  on treasury.bank_transactions (bank_account_id, date desc);

-- ---------------------------------------------------------------------
-- Cash box and expenses
-- ---------------------------------------------------------------------
create table if not exists treasury.transactions (
  id text primary key,
  receipt_number text not null unique,
  type text not null,
  amount numeric(18,4) not null,
  party_name text,
  date date not null,
  description text not null default '',
  gl_account_id text not null references core.accounts(id),
  document_type text,
  journal_entry_id text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint treasury_transactions_type_chk check (type in
    ('cash_receipt','cash_payment','cash_transfer','advance_custody')),
  constraint treasury_transactions_amount_chk check (amount > 0)
);
create index if not exists treasury_transactions_date_idx
  on treasury.transactions (date desc);

create table if not exists treasury.expenses (
  id text primary key,
  expense_number text not null unique,
  date date not null,
  gl_account_id text not null references core.accounts(id),
  cost_center_id text,
  category text,
  sales_rep_id text,
  amount numeric(18,4) not null default 0,
  vat_amount numeric(18,4) not null default 0,
  total_amount numeric(18,4) not null default 0,
  payment_method text not null default 'cash',
  bank_account_id text,
  description text not null default '',
  reference text not null default '',
  journal_entry_id text,
  created_by text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expenses_method_chk check (payment_method in ('cash','bank')),
  constraint expenses_amounts_chk check (amount >= 0 and vat_amount >= 0 and total_amount >= 0),
  constraint expenses_bank_chk check (payment_method <> 'bank' or bank_account_id is not null),
  constraint expenses_total_chk check (abs(total_amount - (amount + vat_amount)) <= 0.01)
);
create index if not exists expenses_date_idx on treasury.expenses (date desc);

-- ---------------------------------------------------------------------
-- Export shipments (revenue/COGS are posted ONLY by the linked invoice)
-- ---------------------------------------------------------------------
create table if not exists fin.export_shipments (
  id text primary key,
  shipment_number text not null unique,
  customer_id text not null,
  shipment_date date not null,
  port_of_origin text not null default '',
  destination_port text not null default '',
  container_number text,
  usd_revenue numeric(18,4) not null default 0,
  exchange_rate numeric(18,6) not null default 1,
  egp_value numeric(18,4) not null default 0,
  product_cost numeric(18,4) not null default 0,
  shipping_cost numeric(18,4) not null default 0,
  port_costs numeric(18,4) not null default 0,
  customs_cost numeric(18,4) not null default 0,
  other_export_costs numeric(18,4) not null default 0,
  total_costs numeric(18,4) not null default 0,
  net_profit_egp numeric(18,4) not null default 0,
  profit_margin_percent numeric(9,4) not null default 0,
  collection_status text not null default 'pending',
  collected_usd numeric(18,4) not null default 0,
  status text not null default 'draft',
  sales_invoice_id text references sales.invoices(id),
  notes text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint export_shipments_collection_chk check (collection_status in
    ('pending','partially_collected','collected')),
  constraint export_shipments_status_chk check (status in ('draft','shipped','delivered','closed')),
  constraint export_shipments_usd_rate_chk check (exchange_rate > 0),
  constraint export_shipments_collected_chk check (collected_usd >= 0 and collected_usd <= usd_revenue + 0.01)
);

do $$
declare t record;
begin
  for t in
    select n.nspname as sch, c.relname as tbl
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r'
       and ((n.nspname = 'treasury') or (n.nspname = 'fin' and c.relname = 'export_shipments'))
  loop
    execute format('drop trigger if exists trg_%1$s_touch on %2$I.%1$I', t.tbl, t.sch);
    execute format('create trigger trg_%1$s_touch before update on %2$I.%1$I
                    for each row execute function core.touch_updated_at()', t.tbl, t.sch);
  end loop;
end $$;
