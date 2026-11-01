// TEST-only probe for the CLOUD SESSION + the finance read RPCs.
//
//   node scripts/qa_cloud_session_probe.mjs
//
// Verifies, over the anon-key client the browser uses:
//   * a password sign-in works and yields an auth session,
//   * public.current_erp_role() is callable by `authenticated` and returns only
//     THIS user's ERP role (the role source the cloud login gate will use —
//     core.app_profiles itself is not SELECT-able from the client),
//   * the read RPCs the newly wired panels call actually return rows/columns.
// Nothing is written: only read RPCs are called. Credentials come from the
// environment and are never printed.

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
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const blocked = results.filter(r => r.status === 'BLOCKED').length;
  console.log(`\nSUMMARY pass=${passed} fail=${failed} blocked=${blocked} total=${results.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

if (!url || !anonKey || !email || !password) {
  record('config: TEST keys + QA credential present', 'BLOCKED',
    'missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / QA_CLOUD_TEST_*');
  finish();
}

const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

const { error: authError } = await client.auth.signInWithPassword({ email, password });
if (authError) {
  record('auth: QA sign-in', 'FAIL', authError.message);
  finish();
}
record('auth: QA sign-in', 'PASS', 'session acquired');

// ---------------------------------------------------------------- role source
{
  const { data, error } = await client.rpc('current_erp_role');
  if (error) {
    record('role: current_erp_role callable', 'FAIL', `${error.code ?? 'error'}: ${error.message}`);
  } else if (typeof data !== 'string' || data.length === 0) {
    record('role: current_erp_role callable', 'FAIL', `empty role: ${JSON.stringify(data)}`);
  } else {
    record('role: current_erp_role callable', 'PASS', `role=${data}`);
  }
}

// table-level read of app_profiles must stay denied (role comes from the RPC)
{
  const { error } = await client.schema('core').from('app_profiles').select('role');
  if (error) record('role: app_profiles table stays denied', 'PASS', error.message);
  else record('role: app_profiles table stays denied', 'FAIL', 'table was readable');
}

// ------------------------------------------------------------ read RPCs wired
const READS = [
  ['banks: list_bank_accounts', 'list_bank_accounts', {}],
  ['banks: list_bank_transactions', 'list_bank_transactions',
    { p_from: null, p_to: null, p_bank_account_id: null, p_limit: 200, p_offset: 0 }],
  ['cheques: list_cheques', 'list_cheques', { p_status: null, p_limit: 200, p_offset: 0 }],
  ['expenses: list_expenses', 'list_expenses',
    { p_from: null, p_to: null, p_limit: 200, p_offset: 0 }],
  ['export: list_export_shipments', 'list_export_shipments',
    { p_from: null, p_to: null, p_limit: 200, p_offset: 0 }],
  ['sales: list_sales_returns', 'list_sales_returns',
    { p_from: null, p_to: null, p_limit: 200, p_offset: 0 }],
  // data path behind the new transfer form (pickers)
  ['transfer picker: warehouses', 'erp_core_master_read', { p_entity: 'warehouses' }],
  ['transfer picker: items', 'erp_core_master_read', { p_entity: 'items' }],
  ['transfer balance: stock_on_hand', 'stock_on_hand', { p_warehouse_id: null }],
];

for (const [label, rpc, params] of READS) {
  const { data, error } = await client.rpc(rpc, params);
  if (error) {
    record(label, 'FAIL', `${error.code ?? 'error'}: ${error.message}`);
    continue;
  }
  const rows = Array.isArray(data) ? data : [];
  const cols = rows.length ? Object.keys(rows[0]).length : 0;
  record(label, 'PASS', `rows=${rows.length} columns=${cols}`);
}

// the write RPC must be REACHABLE for this session but refused by its gate
{
  const { data, error } = await client.rpc('post_inventory_transfer', {
    p_item_id: 'qa-e2e-item-01',
    p_source_warehouse_id: 'qa-e2e-wh-01',
    p_target_warehouse_id: 'qa-e2e-wh-02',
    p_quantity: 1,
    p_batch_number: null,
    p_notes: 'probe',
    p_date: null,
    p_idempotency_key: `probe-${Date.now()}`,
  });
  const row = Array.isArray(data) ? data[0] : data;
  const err = String(row?.out_error ?? error?.message ?? '');
  const refused = !!error || row?.out_success === false;
  record('write: transfer gate answers this session', refused ? 'PASS' : 'FAIL',
    err || 'unexpected success');
}

await client.auth.signOut();
finish();
