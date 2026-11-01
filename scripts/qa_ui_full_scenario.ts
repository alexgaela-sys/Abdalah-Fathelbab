// scripts/qa_ui_full_scenario.ts — TEST only.
//
// One integrated scenario across the cloud screens, calling exactly the modules
// the UI calls (no copies, no direct SQL):
//
//   1. sign in with Supabase Auth (TEST account),
//   2. read the ERP role and the invoice form options,
//   3. post a sales invoice through postCloudSalesInvoice
//      (invoice + sales journal + FIFO issue + COGS journal, atomic server-side),
//   4. re-read the REPORTS screen services and prove the posted invoice moved
//      the numbers: revenue +subtotal, COGS +cost, inventory closing −qty,
//   5. read the users directory and the company settings,
//   6. confirm the trial balance still balances after the new posting.
//
// Nothing is deleted: posted documents are immutable by design. Every fixture
// this test uses is an is_test record from supabase/164.
//
// Run: bun x tsx scripts/qa_ui_full_scenario.ts

import {
  signInSupabaseTest,
  signOutSupabaseTest,
  supabaseTestUserEmail,
  supabaseTestUserPassword,
} from '../src/services/supabaseTestClient';
import {
  loadSalesOptions,
  postCloudSalesInvoice,
  readCloudSalesRole,
} from '../src/services/cloudSalesWrite';
import {
  loadInventoryMovement,
  loadProfitAndLoss,
  loadTrialBalance,
} from '../src/services/cloudReports';
import { listCloudProfiles, loadCloudSettings } from '../src/services/cloudUsers';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ` — ${detail}` : ''}`);
};

const near = (a: number, b: number, eps = 0.02): boolean => Math.abs(a - b) <= eps;

const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const period = { from: '2026-01-01', to: '2026-12-31' };

const main = async (): Promise<number> => {
  const email = supabaseTestUserEmail();
  const password = supabaseTestUserPassword();
  if (!email || !password) {
    record('config: TEST credentials present', false, 'SUPABASE_TEST_USER_EMAIL/PASSWORD missing');
    return 2;
  }

  const signIn = await signInSupabaseTest(email, password);
  if (!signIn.ok) {
    record('auth: sign in', false, signIn.message);
    return 1;
  }
  record('auth: sign in', true, signIn.email ?? email);

  const role = await readCloudSalesRole();
  if (!role.ok || !role.canPostSales) {
    record('sales: role can post', false, role.ok ? role.role : role.messageAr);
    return 1;
  }
  record('sales: role can post', true, role.role);

  const opts = await loadSalesOptions();
  if (!opts.ok) {
    record('sales: form options load', false, opts.messageAr);
    return 1;
  }
  const item = opts.data.items.find(i => i.code === 'QA-ITEM-01');
  const customer = opts.data.customers.find(c => c.id === 'qa-e2e-cust-01');
  const warehouse = opts.data.warehouses.find(w => w.id === 'qa-e2e-wh-01');
  record(
    'sales: fixtures present (item/customer/warehouse)',
    Boolean(item && customer && warehouse),
    `item=${item?.code ?? '-'} customer=${customer?.code ?? '-'} wh=${warehouse?.code ?? '-'}`,
  );
  if (!item || !customer || !warehouse) return 1;

  // ---------------- baseline ----------------
  const before = await loadProfitAndLoss(period.from, period.to);
  const beforeTb = await loadTrialBalance(period.from, period.to);
  const beforeMv = await loadInventoryMovement(period.from, period.to);
  if (!before.ok || !beforeTb.ok || !beforeMv.ok) {
    record('reports: baseline load', false, 'P&L / trial balance / movement failed');
    return 1;
  }
  const sum = (rows: typeof before.data, key: string) =>
    rows.find(l => l.lineType === 'subtotal' && l.section === key)?.amount ?? 0;
  const revenue0 = sum(before.data, 'revenue_total');
  const cogs0 = sum(before.data, 'cogs_total');
  const closing0 =
    beforeMv.data.find(m => m.itemId === item.id && m.warehouseId === warehouse.id)?.closingQty ?? 0;
  record(
    'reports: baseline captured',
    true,
    `revenue=${revenue0} cogs=${cogs0} closing=${closing0}`,
  );

  // ---------------- post through the UI service ----------------
  const quantity = 2;
  const unitPrice = 30;
  // the RPC takes VAT as a ratio (0.14 = 14%), not a percentage
  const vatRate = 0.14;
  const subtotal = quantity * unitPrice;
  const posted = await postCloudSalesInvoice({
    customerId: customer.id,
    // retail + credit is the channel that has a complete mapping set in TEST
    // (sales_retail_revenue / customer_receivable_local / sales_vat_output).
    // wholesale and export revenue mappings do not exist yet and are rejected
    // server-side instead of being posted against a guessed account.
    channel: 'retail',
    warehouseId: warehouse.id,
    paymentMethod: 'credit',
    currency: 'EGP',
    exchangeRate: 1,
    date: today(),
    lines: [{ itemId: item.id, quantity, unitPrice, discount: 0, vatRate }],
  });

  if (!posted.ok) {
    record('sales: post invoice (invoice + sales JV + FIFO + COGS)', false, posted.messageAr);
    return 1;
  }
  record(
    'sales: post invoice (invoice + sales JV + FIFO + COGS)',
    Boolean(posted.data.invoiceNumber) && posted.data.cogs > 0 && Boolean(posted.data.cogsJournalNumber),
    `${posted.data.invoiceNumber} · cogs=${posted.data.cogs} · cogsJV=${posted.data.cogsJournalNumber} · ${posted.data.status}`,
  );

  // ---------------- reports reflect the posting ----------------
  const after = await loadProfitAndLoss(period.from, period.to);
  const afterTb = await loadTrialBalance(period.from, period.to);
  const afterMv = await loadInventoryMovement(period.from, period.to);
  if (!after.ok || !afterTb.ok || !afterMv.ok) {
    record('reports: post-posting load', false, 'P&L / trial balance / movement failed');
    return 1;
  }
  const revenue1 = sum(after.data, 'revenue_total');
  const cogs1 = sum(after.data, 'cogs_total');
  const closing1 =
    afterMv.data.find(m => m.itemId === item.id && m.warehouseId === warehouse.id)?.closingQty ?? 0;

  record(
    'reports: revenue increased by the invoice subtotal',
    near(revenue1 - revenue0, subtotal),
    `Δ=${(revenue1 - revenue0).toFixed(2)} expected=${subtotal}`,
  );
  record(
    'reports: COGS increased by the FIFO cost',
    near(cogs1 - cogs0, posted.data.cogs),
    `Δ=${(cogs1 - cogs0).toFixed(2)} expected=${posted.data.cogs}`,
  );
  record(
    'reports: inventory closing decreased by the sold quantity',
    near(closing0 - closing1, quantity, 0.0005),
    `${closing0} → ${closing1}`,
  );
  record(
    'reports: gross profit = revenue − cogs after posting',
    near(
      sum(after.data, 'gross_profit'),
      revenue1 - cogs1,
    ),
    `${sum(after.data, 'gross_profit')} vs ${revenue1 - cogs1}`,
  );

  const tbDebit = afterTb.data.reduce((s, r) => s + r.debit, 0);
  const tbCredit = afterTb.data.reduce((s, r) => s + r.credit, 0);
  record('reports: trial balance still balanced after posting', near(tbDebit, tbCredit), `${tbDebit} vs ${tbCredit}`);

  // ---------------- users + settings ----------------
  const profiles = await listCloudProfiles();
  record(
    'users: directory readable',
    profiles.ok && profiles.data.length > 0,
    profiles.ok ? `profiles=${profiles.data.length}` : profiles.messageAr,
  );

  const settings = await loadCloudSettings();
  record(
    'settings: company identity readable',
    settings.ok && String(settings.data.company.name_ar ?? '').length > 0,
    settings.ok ? String(settings.data.company.name_ar) : settings.messageAr,
  );

  await signOutSupabaseTest();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('FAILED:');
    failed.forEach(f => console.log(`  - ${f.name} (${f.detail})`));
    return 1;
  }
  return 0;
};

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error('FATAL', err);
    process.exit(1);
  });
