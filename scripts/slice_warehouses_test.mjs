// TEST-ONLY test runner for slice 1: warehouses master data in Supabase.
//
//   node scripts/slice_warehouses_test.mjs
//
// Uses the anon key + the existing QA account (from env, never printed) and
// synthetic warehouses only. It never touches localStorage or local ERP data.

import { readFileSync } from 'node:fs';
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

if (!url || !anonKey) {
  record('config: VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY present', 'BLOCKED', 'missing env keys');
  finish();
}

const projectRef = (() => {
  try { return new URL(url).hostname.split('.')[0]; } catch { return 'unparsable'; }
})();
record('config: Supabase URL is TEST project xrqksgjtqzddzqcwfnaj', projectRef === 'xrqksgjtqzddzqcwfnaj' ? 'PASS' : 'FAIL', projectRef);

const stamp = Date.now();
const id = `slice-wh-${stamp}`;
const code = `SL${String(stamp).slice(-6)}`;

const draft = (overrides = {}) => ({
  p_id: id,
  p_code: code,
  p_name_ar: 'مستودع شريحة اختبار',
  p_type: 'local_finished',
  p_location: 'TEST',
  p_manager_name: null,
  p_manager_user_id: null,
  p_disabled_reason: null,
  p_active: true,
  p_expected_version: 0,
  ...overrides,
});

const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

// 1) Anonymous access must be denied.
{
  const { data, error } = await anon.from('erp_warehouses').select('id').limit(1);
  if (error) record('anon: SELECT erp_warehouses denied', 'PASS', `code=${error.code ?? 'n/a'}`);
  else if (!data || data.length === 0) record('anon: SELECT erp_warehouses denied', 'PASS', 'RLS filtered');
  else record('anon: SELECT erp_warehouses denied', 'FAIL', `leaked ${data.length} row(s)`);
}
{
  const { data, error } = await anon.rpc('erp_warehouse_cas', draft());
  const row = Array.isArray(data) ? data[0] : data;
  if (error) record('anon: RPC erp_warehouse_cas denied', 'PASS', `code=${error.code ?? 'n/a'}`);
  else if (row?.status === 'not_authenticated') record('anon: RPC erp_warehouse_cas denied', 'PASS', 'not_authenticated');
  else record('anon: RPC erp_warehouse_cas denied', 'FAIL', `status=${row?.status}`);
}

// 2) Authenticate the QA account.
if (!email || !password) {
  record('auth: QA credentials available', 'BLOCKED', 'QA_CLOUD_TEST_EMAIL / QA_CLOUD_TEST_PASSWORD missing');
  finish();
}
const sb = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
{
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    record('auth: sign in with QA account', 'BLOCKED', `error=${error.message}`);
    finish();
  }
  record('auth: sign in with QA account', 'PASS', `user=${data.user?.id ? 'resolved' : 'unknown'}`);
}

// 3) Create once.
{
  const { data, error } = await sb.rpc('erp_warehouse_cas', draft());
  const row = Array.isArray(data) ? data[0] : data;
  if (error) record('write: create warehouse (expected 0)', 'FAIL', `error=${error.message}`);
  else if (row?.status === 'created' && Number(row.version) === 1) record('write: create warehouse (expected 0)', 'PASS', 'status=created version=1');
  else record('write: create warehouse (expected 0)', 'FAIL', `status=${row?.status} version=${row?.version}`);
}

// 4) Read it back through RLS.
{
  const { data, error } = await sb.from('erp_warehouses')
    .select('code,name_ar,location,version').eq('id', id).maybeSingle();
  if (error) record('read: list warehouses via RLS', 'FAIL', `error=${error.message}`);
  else if (data && Number(data.version) === 1 && data.code === code) record('read: list warehouses via RLS', 'PASS', 'version=1 code matches');
  else record('read: list warehouses via RLS', 'FAIL', `data=${JSON.stringify(data)?.slice(0, 160)}`);
}

// 5) Duplicate create rejected.
{
  const { data, error } = await sb.rpc('erp_warehouse_cas', draft());
  const row = Array.isArray(data) ? data[0] : data;
  if (error) record('write: duplicate create rejected', 'FAIL', `error=${error.message}`);
  else if (row?.status === 'conflict' && Number(row.version) === 1) record('write: duplicate create rejected', 'PASS', 'status=conflict version=1');
  else record('write: duplicate create rejected', 'FAIL', `status=${row?.status} version=${row?.version}`);
}

// 6) Update with matching version.
{
  const { data, error } = await sb.rpc('erp_warehouse_cas', draft({ p_location: 'TEST-2', p_expected_version: 1 }));
  const row = Array.isArray(data) ? data[0] : data;
  if (error) record('write: update with matching version', 'FAIL', `error=${error.message}`);
  else if (row?.status === 'updated' && Number(row.version) === 2) record('write: update with matching version', 'PASS', 'status=updated version=2');
  else record('write: update with matching version', 'FAIL', `status=${row?.status} version=${row?.version}`);
}

// 7) Stale version rejected and previous values preserved.
{
  const { data, error } = await sb.rpc('erp_warehouse_cas', draft({ p_location: 'STALE', p_expected_version: 1 }));
  const row = Array.isArray(data) ? data[0] : data;
  const { data: check } = await sb.from('erp_warehouses').select('version,location').eq('id', id).maybeSingle();
  if (error) record('concurrency: stale write rejected', 'FAIL', `error=${error.message}`);
  else if (row?.status === 'conflict' && Number(check?.version) === 2 && check?.location === 'TEST-2')
    record('concurrency: stale write rejected', 'PASS', 'status=conflict, stored version 2, location unchanged');
  else record('concurrency: stale write rejected', 'FAIL', `status=${row?.status} storedVersion=${check?.version} location=${check?.location}`);
}

// 8) Two concurrent writes with the same expected version: exactly one wins.
{
  const attempt = (loc) => sb.rpc('erp_warehouse_cas', draft({ p_location: loc, p_expected_version: 2 }));
  const [a, b] = await Promise.all([attempt('RACE-A'), attempt('RACE-B')]);
  const ra = Array.isArray(a.data) ? a.data[0] : a.data;
  const rb = Array.isArray(b.data) ? b.data[0] : b.data;
  const statuses = [ra?.status, rb?.status].sort().join('|');
  const { data: check } = await sb.from('erp_warehouses').select('version,location').eq('id', id).maybeSingle();
  if (a.error || b.error) record('concurrency: parallel CAS same version', 'FAIL', `errors=${a.error?.message ?? ''}/${b.error?.message ?? ''}`);
  else if (statuses === 'conflict|updated' && Number(check?.version) === 3)
    record('concurrency: parallel CAS same version', 'PASS', `statuses=${statuses} finalVersion=3 location=${check?.location}`);
  else record('concurrency: parallel CAS same version', 'FAIL', `statuses=${statuses} finalVersion=${check?.version}`);
}

// 9) Isolation: the slice module must not reach into local storage / erpDb.
{
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const slice = stripComments(readFileSync(new URL('../src/services/cloudWarehouseSlice.ts', import.meta.url), 'utf8'));
  const client = stripComments(readFileSync(new URL('../src/services/supabaseTestClient.ts', import.meta.url), 'utf8'));
  const noLocalStorage = !/localStorage\s*[.[]/.test(slice + client);
  const noErpDb = !/services\/db/.test(slice);
  const noErpKey = !/['"]abdullah_erp_db_v1['"]/.test(slice + client);
  record('isolation: slice ignores localStorage and erpDb', noLocalStorage && noErpDb && noErpKey ? 'PASS' : 'FAIL',
    JSON.stringify({ noLocalStorage, noErpDb, noErpKey }));
}

finish();

function finish() {
  const failed = results.filter(r => r.status === 'FAIL').length;
  const blocked = results.filter(r => r.status === 'BLOCKED').length;
  const passed = results.filter(r => r.status === 'PASS').length;
  console.log(`\nSUMMARY pass=${passed} fail=${failed} blocked=${blocked} warehouseId=${id}`);
  process.exit(failed > 0 ? 1 : 0);
}
