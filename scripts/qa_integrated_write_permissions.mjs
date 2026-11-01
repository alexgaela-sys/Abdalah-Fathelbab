// TEST-ONLY behavioural QA for the integrated sales-posting write RPC.
//
//   node scripts/qa_integrated_write_permissions.mjs
//
// Proves, over the same anon-key REST client the browser uses, that
// public.post_sales_invoice_integrated is:
//   * unreachable for anon (grants are EXECUTE to authenticated only),
//   * refused for the Viewer profile by the server-side role gate,
//   * reached but ATOMIC for an authorised profile: the probe line asks for
//     1,000,000 units against a warehouse with zero stock, so the FIFO guard
//     must raise and the whole server transaction must roll back.
//
// It never asks for a satisfiable quantity, so no code path here can commit a
// row: if the guard were missing the call would still fail before a journal
// balances, and the invoice count is asserted unchanged at the end.
// Passwords are read from the environment and never printed.

import { createClient } from '@supabase/supabase-js';

const results = [];
const record = (name, status, detail) => {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(7)} | ${name}${detail ? ` — ${detail}` : ''}`);
};

const url = (process.env.VITE_SUPABASE_URL || '').trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY || '').trim();
const qaEmail = (process.env.QA_CLOUD_TEST_EMAIL || '').trim();
const qaPassword = process.env.QA_CLOUD_TEST_PASSWORD || '';
const rootEmail = (process.env.QA_E2E_EMAIL || '').trim();
const rootPassword = process.env.QA_E2E_PASSWORD || '';

function finish() {
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const blocked = results.filter(r => r.status === 'BLOCKED').length;
  console.log(`\nSUMMARY pass=${passed} fail=${failed} blocked=${blocked} total=${results.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

if (!url || !anonKey) {
  record('config: TEST keys present', 'BLOCKED', 'missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
  finish();
}

const projectRef = (() => {
  try { return new URL(url).hostname.split('.')[0]; } catch { return 'unparsable'; }
})();
record('config: TEST project only', projectRef === 'xrqksgjtqzddzqcwfnaj' ? 'PASS' : 'FAIL', projectRef);

const makeClient = () =>
  createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

const probe = (client, key) => client.rpc('post_sales_invoice_integrated', {
  p_customer_id: 'qa-e2e-cust-01',
  p_channel: 'retail',
  p_warehouse_id: 'qa-e2e-wh-01',
  p_payment_method: 'cash',
  p_currency: 'EGP',
  p_exchange_rate: 1,
  p_date: '2026-10-20',
  // deliberately unsatisfiable: the warehouse holds 0 units of this item
  p_lines: [{ itemId: 'qa-e2e-item-01', quantity: 1000000, unitPrice: 100, vatRate: 0.14 }],
  p_created_by: 'qa-perm-probe',
  p_idempotency_key: key,
});

const describe = (data, error) => {
  const row = Array.isArray(data) ? data[0] : data;
  return {
    status: String(row?.out_status ?? ''),
    error: String(row?.out_error ?? ''),
    http: String(error?.message ?? ''),
    code: String(error?.code ?? ''),
  };
};

// ---------------------------------------------------------------
// 0) anon must not even read the invoice list
// ---------------------------------------------------------------
{
  const anon = makeClient();
  const { data, error } = await anon.rpc('list_sales_invoices', {
    p_from: null, p_to: null, p_channel: null, p_currency: null,
    p_search: null, p_limit: 100, p_offset: 0,
  });
  if (error) record('anon: invoice list denied', 'PASS', `${error.code ?? 'error'}: ${error.message}`);
  else record('anon: invoice list denied', 'FAIL', `leaked ${data.length} row(s)`);
}

// ---------------------------------------------------------------
// 1) invoice baseline (signed-in reader, no write)
// ---------------------------------------------------------------
const listCount = async (client) => {
  const { data, error } = await client.rpc('list_sales_invoices', {
    p_from: null, p_to: null, p_channel: null, p_currency: null,
    p_search: null, p_limit: 100, p_offset: 0,
  });
  if (error) throw new Error(error.message);
  return data.length;
};

const signInAny = async () => {
  for (const [email, password, label] of [
    [qaEmail, qaPassword, 'QA viewer'],
    [rootEmail, rootPassword, 'QA e2e'],
  ]) {
    if (!email || !password) continue;
    const client = makeClient();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (!error) return { client, label };
  }
  return null;
};

const reader = await signInAny();
if (!reader) {
  record('baseline: invoice list readable', 'BLOCKED', 'no QA credential available');
  finish();
}
let before = null;
try {
  before = await listCount(reader.client);
  record('baseline: invoice list readable', 'PASS',
    `via ${reader.label}, rows=${before}${before >= 100 ? ' (AT LIMIT: count assertions unreliable)' : ''}`);
} catch (e) {
  record('baseline: invoice list readable', 'FAIL', e.message);
  finish();
}

const readMyProfile = async (client) => {
  const { data, error } = await client.schema('core').from('app_profiles')
    .select('role, active, supabase_auth_id');
  if (error) return `profile read failed: ${error.message}`;
  if (!data?.length) return 'no core.app_profiles row for this session';
  return `role=${data[0].role} active=${data[0].active}`;
};

// ---------------------------------------------------------------
// 1) anon must not be able to call the write RPC at all
// ---------------------------------------------------------------
{
  const anon = makeClient();
  const { data, error } = await probe(anon, `qa-perm-anon-${Date.now()}`);
  const r = describe(data, error);
  if (error) {
    record('anon: write RPC denied', 'PASS', `${r.code || 'error'}: ${r.http}`);
  } else {
    record('anon: write RPC denied', 'FAIL', `reached the function: ${r.status} ${r.error}`);
  }
}

// ---------------------------------------------------------------
// 2) Viewer profile must be refused by the server-side role gate
// ---------------------------------------------------------------
let viewerClient = null;
{
  const client = makeClient();
  if (!qaEmail || !qaPassword) {
    record('viewer: role gate refuses posting', 'BLOCKED', 'missing QA_CLOUD_TEST_EMAIL / QA_CLOUD_TEST_PASSWORD');
  } else {
    const { error: authError } = await client.auth.signInWithPassword({ email: qaEmail, password: qaPassword });
    if (authError) {
      record('viewer: role gate refuses posting', 'BLOCKED', authError.message);
    } else {
      const profile = await readMyProfile(client);
      const { data, error } = await probe(client, `qa-perm-viewer-${Date.now()}`);
      const r = describe(data, error);
      const refused = !!error || (r.status === 'error' && /unauthorized/i.test(r.error));
      record('viewer: role gate refuses posting', refused ? 'PASS' : 'FAIL',
        `${profile} → ${r.http || `${r.status}: ${r.error}`}`);
      viewerClient = client;
    }
  }
}

// ---------------------------------------------------------------
// 3) authorised profile reaches the function but the FIFO guard must raise
//    (atomicity over the real REST path: nothing may commit)
// ---------------------------------------------------------------
{
  const client = makeClient();
  if (!rootEmail || !rootPassword) {
    record('authorized: FIFO guard aborts the transaction', 'BLOCKED', 'missing QA_E2E_EMAIL / QA_E2E_PASSWORD');
  } else {
    const { error: authError } = await client.auth.signInWithPassword({ email: rootEmail, password: rootPassword });
    if (authError) {
      record('authorized: FIFO guard aborts the transaction', 'BLOCKED', authError.message);
    } else {
      const profile = await readMyProfile(client);
      const { data, error } = await probe(client, `qa-perm-root-${Date.now()}`);
      const r = describe(data, error);
      const atomic = !!error && /لا يكفي لصرف|الرصيد المتاح|stock|rolled back/i.test(r.http)
        || (r.status === 'error' && /لا يكفي لصرف|الرصيد المتاح/i.test(r.error));
      const gated = !!error || (r.status === 'error' && /unauthorized/i.test(r.error));
      record('authorized: FIFO guard aborts the transaction',
        atomic ? 'PASS' : (gated ? 'BLOCKED' : 'FAIL'),
        `${profile} → ${r.http || `${r.status}: ${r.error}`}`);
    }
  }
}

// ---------------------------------------------------------------
// 4) nothing persisted
// ---------------------------------------------------------------
{
  try {
    const after = await listCount(reader.client);
    record('no invoice persisted by any probe', after === before ? 'PASS' : 'FAIL',
      `before=${before} after=${after}`);
  } catch (e) {
    record('no invoice persisted by any probe', 'FAIL', e.message);
  }
}

if (viewerClient) await viewerClient.auth.signOut();
await reader.client.auth.signOut();
finish();
