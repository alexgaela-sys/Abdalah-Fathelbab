// scripts/qa_ui_sales_write.ts — TEST only.
//
// Exercises the EXACT module the cloud sales screen calls
// (src/services/cloudSalesWrite.ts), not a copy of it:
//   readCloudSalesRole() -> loadSalesOptions() -> postCloudSalesInvoice()
//
// That proves the frontend path (anon key + real session + RPC payload shape +
// idempotency key) reaches public.post_sales_invoice_integrated and returns a
// posted invoice. Server-side invariants are verified separately by
// scripts/qa_rest_full_cycle_verify.sql.
//
// Run: bun x tsx scripts/qa_ui_sales_write.ts

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

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ` — ${detail}` : ''}`);
};

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
  if (!role.ok) {
    record('role: readCloudSalesRole', false, role.messageAr);
    return 1;
  }
  record('role: readCloudSalesRole', role.canPostSales, `role=${role.role} canPost=${role.canPostSales}`);
  if (!role.canPostSales) return 1;

  const opts = await loadSalesOptions();
  if (!opts.ok) {
    record('options: loadSalesOptions', false, opts.messageAr);
    return 1;
  }
  const { customers, warehouses, items } = opts.data;
  record('options: customers/warehouses/items', customers.length > 0 && warehouses.length > 1 && items.length > 0,
    `customers=${customers.length} warehouses=${warehouses.length} items=${items.length}`);
  if (warehouses.length < 2) {
    record('options: a second warehouse exists', false, 'transfer can never be tested with one warehouse');
    return 1;
  }

  const item = items.find(i => i.code === 'QA-ITEM-01') ?? items[0];
  const customer = customers.find(c => c.id === 'qa-e2e-cust-01') ?? customers[0];
  const warehouse = warehouses.find(w => w.id === 'qa-e2e-wh-01') ?? warehouses[0];

  const posted = await postCloudSalesInvoice({
    customerId: customer.id,
    channel: 'retail',
    warehouseId: warehouse.id,
    paymentMethod: 'credit',
    currency: 'EGP',
    exchangeRate: 1,
    date: new Date().toISOString().slice(0, 10),
    lines: [{ itemId: item.id, quantity: 2, unitPrice: 30, discount: 0, vatRate: 0.14 }],
  });

  if (!posted.ok) {
    record('post: postCloudSalesInvoice', false, `${posted.kind}: ${posted.messageAr}`);
    await signOutSupabaseTest();
    return 1;
  }

  record('post: postCloudSalesInvoice', Boolean(posted.data.invoiceNumber),
    `${posted.data.invoiceNumber} cogs=${posted.data.cogs} cogs_jv=${posted.data.cogsJournalNumber} status=${posted.data.status}`);

  // A second submission must be a NEW invoice (fresh key per submit), while the
  // server keeps every invoice internally consistent.
  const again = await postCloudSalesInvoice({
    customerId: customer.id,
    channel: 'retail',
    warehouseId: warehouse.id,
    paymentMethod: 'credit',
    currency: 'EGP',
    exchangeRate: 1,
    date: new Date().toISOString().slice(0, 10),
    lines: [{ itemId: item.id, quantity: 1, unitPrice: 30, discount: 0, vatRate: 0.14 }],
  });
  record('post: a new submission is a new invoice', again.ok && again.data.invoiceNumber !== posted.data.invoiceNumber,
    again.ok ? `${posted.data.invoiceNumber} -> ${again.data.invoiceNumber}` : `${again.kind}: ${again.messageAr}`);

  // An impossible quantity must be refused by the server with the operator message.
  const impossible = await postCloudSalesInvoice({
    customerId: customer.id,
    channel: 'retail',
    warehouseId: warehouse.id,
    paymentMethod: 'credit',
    currency: 'EGP',
    exchangeRate: 1,
    date: new Date().toISOString().slice(0, 10),
    lines: [{ itemId: item.id, quantity: 999999, unitPrice: 30, discount: 0, vatRate: 0.14 }],
  });
  record('post: impossible quantity refused', !impossible.ok, impossible.ok ? 'unexpectedly posted' : impossible.messageAr.slice(0, 120));

  await signOutSupabaseTest();

  const failed = results.filter(r => !r.ok).length;
  console.log(`\nINVOICE=${posted.data.invoiceNumber}`);
  console.log(`SUMMARY pass=${results.length - failed} fail=${failed} total=${results.length}`);
  return failed > 0 ? 1 : 0;
};

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error('FAIL | run:', err);
    process.exit(1);
  });
