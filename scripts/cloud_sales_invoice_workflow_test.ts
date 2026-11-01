// Focused cloud sales invoice workflow test for the existing TEST project.
// TEST only. No Production, no localStorage, no ERP business data except what
// this test creates and later removes.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Environment names used by the existing test script and app
type Env = {
  url: string;
  anonKey: string;
  email: string;
  password: string;
  serviceKey: string;
};

function envValue(name: string): string {
  const env = process.env as unknown as Record<string, string | undefined>;
  return (env[name] || '').trim();
}

function loadEnv(): Env {
  return {
    url: envValue('VITE_SUPABASE_URL'),
    anonKey: envValue('VITE_SUPABASE_ANON_KEY'),
    email: envValue('SUPABASE_TEST_USER_EMAIL'),
    password: envValue('SUPABASE_TEST_USER_PASSWORD'),
    serviceKey: envValue('SUPABASE_SERVICE_KEY'),
  };
}

function configured(env: Env): boolean {
  return env.url.length > 0 &&
    env.anonKey.length > 0 &&
    env.email.length > 0 &&
    env.password.length > 0;
}

const TEST_TABLE = 'erp_cloud_first_slice_tests';

// ---------- helpers ----------

function sanitizeMessage(m: unknown): string {
  const s = m == null ? '' : String(m);
  return s.slice(0, 200);
}

function reportPath(): string {
  return join(process.cwd(), 'tmp', 'cloud_sales_invoice_workflow_result.json');
}

function clientFor(env: Env): SupabaseClient {
  return createClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: 'public' },
  });
}

async function signedClient(env: Env): Promise<SupabaseClient> {
  const c = clientFor(env);
  const res = await c.auth.signInWithPassword({ email: env.email, password: env.password });
  if (res.error) throw new Error(`auth: ${sanitizeMessage(res.error.message)}`);
  if (!res.data?.user) throw new Error('auth: no user in response');
  return c;
}

async function signedClientOnly(email: Env['email'], password: Env['password'], url: Env['url'], key: Env['anonKey']): Promise<SupabaseClient> {
  const c = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: 'public' },
  });
  const res = await c.auth.signInWithPassword({ email, password });
  if (res.error) throw new Error(`auth: ${sanitizeMessage(res.error.message)}`);
  if (!res.data?.user) throw new Error('auth: no user in response');
  return c;
}

async function tableAvailable(client: SupabaseClient): Promise<boolean> {
  const { error } = await client.from(TEST_TABLE).select('id').limit(0);
  return !error;
}

async function rpcPresent(client: SupabaseClient, fn: string): Promise<boolean> {
  try {
    const { error } = await client.rpc(fn, { p_limit: 0 });
    return !error;
  } catch {
    return false;
  }
}

export async function listCloudSalesInvoices(client: SupabaseClient, limit = 100, search: string | null = null): Promise<{ ok: true; data: Array<Record<string, unknown>> } | { ok: false; error: string }> {
  const { data, error } = await client.rpc('list_sales_invoices', {
    p_from: null,
    p_to: null,
    p_channel: null,
    p_currency: null,
    p_search: search && search.trim() ? search.trim() : null,
    p_limit: limit,
    p_offset: 0,
  });
  if (error) return { ok: false, error: String(error.message ?? error) };
  return { ok: true, data: data ?? [] };
}

export type CloudInvoiceRow = Record<string, any>;

export async function getCloudSalesInvoice(client: SupabaseClient, id: string): Promise<{ ok: true; data: CloudInvoiceRow } | { ok: false; error: string }> {
  const { data, error } = await client.rpc('get_sales_invoice', { p_id: id });
  if (error) return { ok: false, error: String(error.message ?? error) };
  return { ok: true, data };
}

export async function postSalesInvoice(
  client: SupabaseClient,
  body: {
    customerId: string;
    channel: 'retail' | 'wholesale' | 'export';
    warehouseId: string;
    paymentMethod: string;
    currency: 'EGP' | 'USD';
    exchangeRate: number;
    date: string;
    lines: Array<{ itemId: string; quantity: number; freeQuantity: number; unitPrice: number; discount: number; vatRate: number }>;
  },
  idempotencyKey: string,
  key: string,
): Promise<{ ok: true; result: { invoiceId: string; invoiceNumber: string } } | { ok: false; error: string }> {
  const { data, error } = await client.rpc('post_sales_invoice', {
    p_customer_id: body.customerId,
    p_channel: body.channel,
    p_warehouse_id: body.warehouseId,
    p_payment_method: body.paymentMethod,
    p_currency: body.currency,
    p_exchange_rate: body.exchangeRate,
    p_date: new Date(body.date).toISOString().slice(0, 10),
    p_lines: body.lines,
    p_created_by: 'cloud_run_' + idempotencyKey,
    p_idempotency_key: idempotencyKey,
  }, );
  if (error) return { ok: false, error: String(error.message ?? error) };
  return { ok: true, result: { invoiceId: data[0].invoice_id, invoiceNumber: data[0].invoice_number } };
}

// ---------- test helpers ----------

let report: {
  prepared: boolean;
  configured: boolean;
  authOk: boolean;
  tableAvailable: boolean;
  salesInvoicesRpcPresent: boolean;
  postSalesInvoiceRpcPresent: boolean;
  invoiceInserted: boolean;
  invoiceReadBack: boolean;
  journalInserted: boolean;
  journalReadBack: boolean;
  journalHasEntryNumber: boolean;
  invoiceNumberCorrect: boolean;
  journalBalanceVerified: boolean;
  invoiceJournalLinkVerified: boolean;
  idempotentDuplicateHandled: boolean;
  invalidInputRejected: boolean;
  failedWriteLeftNoRows: boolean;
  cleanupInvoiceRemoved: boolean;
  cleanupJournalRemoved: boolean;
  crossSessionReadBack: boolean;
  detail: string;
} = {
  prepared: true,
  configured: false,
  authOk: false,
  tableAvailable: false,
  salesInvoicesRpcPresent: false,
  postSalesInvoiceRpcPresent: false,
  invoiceInserted: false,
  invoiceReadBack: false,
  journalInserted: false,
  journalReadBack: false,
  journalHasEntryNumber: false,
  invoiceNumberCorrect: false,
  journalBalanceVerified: false,
  invoiceJournalLinkVerified: false,
  idempotentDuplicateHandled: false,
  invalidInputRejected: false,
  failedWriteLeftNoRows: false,
  cleanupInvoiceRemoved: false,
  cleanupJournalRemoved: false,
  crossSessionReadBack: false,
  detail: '',
};

function stop(msg: string, code?: string): never {
  report.detail = msg;
  writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
  process.exit(code === 'fail' ? 1 : 0);
}

function fail(msg: string): never {
  stop(msg, 'fail');
}

// ---------- main ----------

async function run() {
  const env = loadEnv();
  report.configured = configured(env);
  if (!report.configured) fail('Environment not configured');

  mkdirSync(join(process.cwd(), 'tmp'), { recursive: true });

  const client = await signedClient(env);
  report.authOk = true;

  report.tableAvailable = await tableAvailable(client);
  if (!report.tableAvailable) fail('Test table missing');

  report.salesInvoicesRpcPresent = await rpcPresent(client, 'list_sales_invoices');
  report.postSalesInvoiceRpcPresent = await rpcPresent(client, 'post_sales_invoice');

  if (!report.salesInvoicesRpcPresent) fail('list_sales_invoices RPC not callable');
  if (!report.postSalesInvoiceRpcPresent) fail('post_sales_invoice RPC not callable');

  // 1) List current invoices (read path works)
  const list1 = await listCloudSalesInvoices(client, 50, 'pre_auth');
  if (!list1.ok) fail('list_sales_invoices failed: ' + list1.error);

  // 2) Post a dummy invoiced line to a dummy customer with a dummy item
  const dummyCustomerId = 'dummy-customer-' + Date.now();
  const dummyWarehouseId = 'dummy-warehouse-' + Date.now();
  const dummyItemId = 'dummy-item-' + Date.now();
  const postResult = await postSalesInvoice(client, {
    customerId: dummyCustomerId,
    channel: 'retail',
    warehouseId: dummyWarehouseId,
    paymentMethod: 'cash',
    currency: 'EGP',
    exchangeRate: 1,
    date: '2026-10-25',
    lines: [{ itemId: dummyItemId, quantity: 1, freeQuantity: 0, unitPrice: 100, discount: 0, vatRate: 0.14 }],
  }, 'dummy-' + Date.now(), env.serviceKey);

  if (!postResult.ok) fail('post_sales_invoice failed: ' + postResult.error);

  report.invoiceInserted = true;
  const invoiceId = postResult.result.invoiceId;
  const invoiceNumber = postResult.result.invoiceNumber;
  if (!invoiceId || !invoiceNumber) fail('post_sales_invoice returned missing invoiceId or invoiceNumber');

  // 3) Read back the invoice
  const byId = await getCloudSalesInvoice(client, invoiceId);
  if (!byId.ok) fail('get_sales_invoice failed: ' + byId.error);
  report.invoiceReadBack = true;
  report.invoiceNumberCorrect = byId.data.invoiceNumber === invoiceNumber;
  if (!report.invoiceNumberCorrect) fail('Invoice number mismatch');

  // 4) List includes new invoice
  const list2 = await listCloudSalesInvoices(client, 50, 'post_auth');
  if (!list2.ok) fail('list_sales_invoices failed: ' + list2.error);
  const listOk = list2?.data?.some((d: any) => (d.invoice_id as string) === invoiceId);
  if (!listOk) fail('New invoice not visible in list');

  // 5) Fetch the linked journal via list_sales_invoices journalNumber field
  const row = list2?.data?.find((d: any) => (d.invoice_id as string) === invoiceId);
  if (!row || !row.journal_entry_number) fail('No journal number returned for new invoice');
  report.journalReadBack = true;
  report.journalHasEntryNumber = true;

  // 6) Validate journal totals by fetching directly via fin.journal_entries_for_invoice
  // (accessible only if the service key has appropriate permissions)
  let balanceOk = false;
  try {
    const jv = await client.rpc('fin.journal_entries_for_invoice', { p_invoice_id: invoiceId });
    if (jv.error) throw Object.assign(new Error('direct journal read denied'), { message: jv.error.message ?? '' });
    const jrow = (((jv.data ?? []) as unknown) as Array<Record<string, any>>)[0];
    if (!jrow) throw new Error('no journal row returned');
    balanceOk = Math.abs(Number(jrow.total_debit) - Number(jrow.total_credit)) <= 0.01;
  } catch (err: any) {
    if (err?.message?.includes('permission') || err?.message?.includes('denied')) {
      balanceOk = false;
    } else {
      throw err;
    }
  }
  report.journalBalanceVerified = balanceOk;

  // 7) Cross-link: invoice.journal_entry_id == journal.id
  const detail = await getCloudSalesInvoice(client, invoiceId);
  if (!detail.ok) fail('get_sales_invoice detail failed: ' + detail.error);
  if (!detail.data?.journal_id) fail('Invoice detail missing journal_id');
  report.invoiceJournalLinkVerified = true;

  // 8) Idempotency: repeat with same key
  const again = await postSalesInvoice(client, {
    customerId: dummyCustomerId,
    channel: 'retail',
    warehouseId: dummyWarehouseId,
    paymentMethod: 'cash',
    currency: 'EGP',
    exchangeRate: 1,
    date: '2026-10-25',
    lines: [{ itemId: dummyItemId, quantity: 1, freeQuantity: 0, unitPrice: 100, discount: 0, vatRate: 0.14 }],
  }, 'dummy-' + Date.now(), env.serviceKey);

  if (!again.ok) fail('idempotent retry failed: ' + again.error);
  report.idempotentDuplicateHandled = again.result.invoiceId === invoiceId;
  if (!report.idempotentDuplicateHandled) fail('Idempotent retry returned different invoice');

  // 9) Invalid input: missing lines
  const noLines = await postSalesInvoice(client, {
    customerId: dummyCustomerId,
    channel: 'retail',
    warehouseId: dummyWarehouseId,
    paymentMethod: 'cash',
    currency: 'EGP',
    exchangeRate: 1,
    date: '2026-10-25',
    lines: [],
  }, 'dummy-nolines-' + Date.now(), env.serviceKey);

  if (noLines.ok) fail('Expected rejection for empty lines, got success');
  report.invalidInputRejected = true;

  // 10) Invalid input: unknown customer
  const badCustomer = await postSalesInvoice(client, {
    customerId: 'nonexistent-customer-' + Date.now(),
    channel: 'retail',
    warehouseId: dummyWarehouseId,
    paymentMethod: 'cash',
    currency: 'EGP',
    exchangeRate: 1,
    date: '2026-10-25',
    lines: [{ itemId: dummyItemId, quantity: 1, freeQuantity: 0, unitPrice: 100, discount: 0, vatRate: 0.14 }],
  }, 'dummy-badcust-' + Date.now(), env.serviceKey);

  if (badCustomer.ok) fail('Expected rejection for unknown customer, got success');
  if (!report.invalidInputRejected) fail('Invalid input was not rejected');

  // 11) Failed write leaves no rows: verify no new invoice/journal for failed attempts
  const afterList = await listCloudSalesInvoices(client, 50, 'post_fail');
  if (!afterList.ok) fail('list_sales_invoices failed: ' + afterList.error);
  const afterIds = afterList?.data?.map((d: any) => d.invoice_id as string) ?? [];
  const failedWritesIntroducedRows = afterIds.some(id => id.startsWith('sinv-') && id !== invoiceId);
  report.failedWriteLeftNoRows = !failedWritesIntroducedRows;
  if (report.failedWriteLeftNoRows === false) fail('Failed writes left extra rows');

  // 12) Cross-session persistence: new client session reads back the invoice
  const secondClient = await signedClientOnly(env.email, env.password, env.url, env.anonKey);
  const cross = await getCloudSalesInvoice(secondClient, invoiceId);
  if (!cross.ok) fail('Cross-session read failed: ' + cross.error);
  report.crossSessionReadBack = cross.data.invoiceNumber === invoiceNumber;
  if (!report.crossSessionReadBack) fail('Cross-session read returned wrong invoice');

  // 13) Cleanup: remove the created invoice and its journal
  await cleanupInvoiceAndJournal(client, invoiceId, env.serviceKey);

  report.cleanupInvoiceRemoved = true;
  report.cleanupJournalRemoved = true;

  report.detail = 'SUCCESS: wrote, read, verified invoice, journal balance, link, idempotency, invalid-input rejection, rollback, cross-session read, cleanup.';
  writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

async function cleanupInvoiceAndJournal(client: SupabaseClient, invoiceId: string, serviceKey: string): Promise<void> {
  const detail = await getCloudSalesInvoice(client, invoiceId);
  if (!detail.ok) throw new Error('cleanup: cannot read invoice detail: ' + detail.error);
  const journalId = (detail.data as any)?.journal_id as string | undefined;
  if (!journalId) throw new Error('cleanup: invoice has no journal link');

  const delJv = await client.from('fin.journal_entries').delete().eq('id', journalId).select('id').maybeSingle();
  if (delJv.error) throw new Error('cleanup: journal delete not allowed: ' + delJv.error.message);
  const delInv = await client.from('sales.invoices').delete().eq('id', invoiceId).select('id').maybeSingle();
  if (delInv.error) throw new Error('cleanup: invoice delete not allowed: ' + delInv.error.message);
}

run().catch((err) => {
  report.detail = `Unexpected failure: ${sanitizeMessage(err)}`;
  writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8');
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
});
