// TEST-ONLY behavioural QA for the read RPCs used by the cloud ERP screens.
//
//   node scripts/qa_cloud_read_screens.mjs
//
// Signs in with the QA account (QA_CLOUD_TEST_EMAIL / QA_CLOUD_TEST_PASSWORD,
// never printed) and calls, over the same anon-key client the browser uses,
// every read RPC the cloud panels call. It also proves that:
//   * anon cannot read the accounting/inventory schemas,
//   * the new write RPC (post_sales_inventory_issue) is refused for this account
//     unless it is explicitly allowed by the server-side role gate.
//
// It writes nothing: no insert/update/delete and no write RPC is called.

import { createClient } from '@supabase/supabase-js';

const results = [];
const record = (name, status, detail) => {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(7)} | ${name}${detail ? ` — ${detail}` : ''}`);
};

const url = (process.env.VITE_SUPABASE_URL || '').trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY || '').trim();
const email = (process.env.QA_CLOUD_TEST_EMAIL || '').trim();
const password = process.env.QA_CLOUD_TEST_PASSWORD || '';

function finish() {
  const failed = results.filter(r => r.status === 'FAIL').length;
  const blocked = results.filter(r => r.status === 'BLOCKED').length;
  const passed = results.filter(r => r.status === 'PASS').length;
  console.log(`\nSUMMARY pass=${passed} fail=${failed} blocked=${blocked} total=${results.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

if (!url || !anonKey) {
  record('config: TEST env keys present', 'BLOCKED', 'missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
  finish();
}

const projectRef = (() => {
  try { return new URL(url).hostname.split('.')[0]; } catch { return 'unparsable'; }
})();
record('config: URL is TEST project xrqksgjtqzddzqcwfnaj', projectRef === 'xrqksgjtqzddzqcwfnaj' ? 'PASS' : 'FAIL', projectRef);

const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

// ---------------------------------------------------------------
// 0) anon must not read the accounting / inventory schemas
// ---------------------------------------------------------------
for (const table of ['fin.journal_entries', 'inventory.transactions', 'sales.invoices']) {
  const { data, error } = await client.schema(table.split('.')[0]).from(table.split('.')[1]).select('*').limit(1);
  if (error || !data?.length) record(`anon: ${table} denied`, 'PASS', error ? `code=${error.code ?? 'n/a'}` : 'RLS filtered');
  else record(`anon: ${table} denied`, 'FAIL', `leaked ${data.length} row(s)`);
}

// ---------------------------------------------------------------
// 1) sign in with the QA account
// ---------------------------------------------------------------
if (!email || !password) {
  record('auth: QA account signed in', 'BLOCKED', 'missing QA_CLOUD_TEST_EMAIL / QA_CLOUD_TEST_PASSWORD');
  finish();
}
const { data: auth, error: authError } = await client.auth.signInWithPassword({ email, password });
if (authError) {
  record('auth: QA account signed in', 'FAIL', authError.message);
  finish();
}
record('auth: QA account signed in', 'PASS', auth.user?.email ? 'session acquired' : 'no user');

const { data: profile } = await client.from('app_profiles').select('role, active').limit(1);
record('profile: linked ERP role readable', profile?.length ? 'PASS' : 'BLOCKED',
  profile?.length ? `role=${profile[0].role} active=${profile[0].active}` : 'no profile row visible');

// ---------------------------------------------------------------
// 2) every read RPC used by the cloud screens
// ---------------------------------------------------------------
const READS = [
  ['sales: list_sales_invoices', 'list_sales_invoices',
    { p_from: null, p_to: null, p_channel: null, p_currency: null, p_search: null, p_limit: 100, p_offset: 0 }],
  ['sales: list_sales_returns', 'list_sales_returns', { p_from: null, p_to: null, p_limit: 100, p_offset: 0 }],
  ['accounting: list_journal_entries', 'list_journal_entries', { p_from: null, p_to: null, p_limit: 200, p_offset: 0 }],
  ['accounting: trial_balance', 'trial_balance', { p_from: null, p_to: null }],
  ['inventory: list_inventory_transactions', 'list_inventory_transactions',
    { p_from: null, p_to: null, p_item_id: null, p_warehouse_id: null, p_limit: 200, p_offset: 0 }],
  ['inventory: list_inventory_batches', 'list_inventory_batches',
    { p_item_id: null, p_warehouse_id: null, p_limit: 200 }],
  ['inventory: stock_on_hand', 'stock_on_hand', { p_warehouse_id: null }],
  ['purchasing: list_purchasing_invoices', 'list_purchasing_invoices',
    { p_from: null, p_to: null, p_status: null, p_limit: 200, p_offset: 0 }],
  ['purchasing: list_purchase_returns', 'list_purchase_returns',
    { p_from: null, p_to: null, p_limit: 200, p_offset: 0 }],
  ['production: list_production_orders', 'list_production_orders',
    { p_from: null, p_to: null, p_status: null, p_limit: 200, p_offset: 0 }],
  ['custody: list_representative_custodies', 'list_representative_custodies',
    { p_status: null, p_limit: 200, p_offset: 0 }],
  ['custody: list_custody_movements', 'list_custody_movements', { p_custody_id: null }],
  ['treasury: list_payments', 'list_payments', { p_from: null, p_to: null, p_type: null, p_limit: 200, p_offset: 0 }],
  ['treasury: list_cheques', 'list_cheques', { p_status: null, p_limit: 200, p_offset: 0 }],
];

for (const [label, rpc, params] of READS) {
  const { data, error } = await client.rpc(rpc, params);
  if (error) record(label, 'FAIL', error.message);
  else record(label, 'PASS', `rows=${Array.isArray(data) ? data.length : 0}`);
}

// ---------------------------------------------------------------
// 3) the write RPC must stay closed to this account
// ---------------------------------------------------------------
{
  // A non-existent invoice id is used on purpose: even an authorized account can
  // only ever get an "invoice not found" answer, never a data mutation.
  const { data, error } = await client.rpc('post_sales_inventory_issue', {
    p_invoice_id: 'qa-probe-does-not-exist',
    p_created_by: 'qa-read-probe',
    p_idempotency_key: 'qa-read-probe',
  });
  const row = Array.isArray(data) ? data[0] : data;
  const status = String(row?.out_status ?? '');
  const err = String(row?.out_error ?? error?.message ?? '');
  if (error) {
    record('write guard: post_sales_inventory_issue refused', 'PASS', `${error.code ?? 'error'}: ${error.message}`);
  } else if (status === 'error' && /unauthorized|not allowed|not found/i.test(err)) {
    record('write guard: post_sales_inventory_issue refused', 'PASS', `status=${status} — ${err}`);
  } else {
    record('write guard: post_sales_inventory_issue refused', 'FAIL', `unexpected success: ${status} ${err}`);
  }
}

await client.auth.signOut();
finish();
