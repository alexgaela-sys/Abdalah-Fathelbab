// TEST-ONLY tests for the cloud master-data layer (122_cloud_master_records).
//
//   node scripts/cloud_master_test.mjs
//
// Uses the anon key + QA account from env (never printed) and synthetic rows.

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
  record('config: TEST env keys present', 'BLOCKED', 'missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
  finish();
}
const projectRef = (() => { try { return new URL(url).hostname.split('.')[0]; } catch { return 'unparsable'; } })();
record('config: URL is TEST project xrqksgjtqzddzqcwfnaj', projectRef === 'xrqksgjtqzddzqcwfnaj' ? 'PASS' : 'FAIL', projectRef);

const stamp = Date.now();
const ENTITIES = ['items', 'units', 'customers', 'suppliers'];

const payload = (entity, id, code, nameAr, over = {}) => ({
  p_entity: entity,
  p_id: id,
  p_code: code,
  p_name_ar: nameAr,
  p_active: true,
  p_payload: { source: 'cloud-master-test', seed: stamp },
  p_expected_version: 0,
  ...over,
});

const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

// 1) anon denied
{
  const { data, error } = await anon.from('erp_master_records').select('id').limit(1);
  if (error) record('anon: SELECT erp_master_records denied', 'PASS', `code=${error.code ?? 'n/a'}`);
  else if (!data?.length) record('anon: SELECT erp_master_records denied', 'PASS', 'RLS filtered');
  else record('anon: SELECT erp_master_records denied', 'FAIL', `leaked ${data.length} row(s)`);
}
{
  const { data, error } = await anon.rpc('erp_master_cas', payload('items', `anon-${stamp}`, `AN${stamp}`.slice(0, 12), 'x'));
  const row = Array.isArray(data) ? data[0] : data;
  if (error) record('anon: RPC erp_master_cas denied', 'PASS', `code=${error.code ?? 'n/a'}`);
  else if (row?.status === 'not_authenticated') record('anon: RPC erp_master_cas denied', 'PASS', 'not_authenticated');
  else record('anon: RPC erp_master_cas denied', 'FAIL', `status=${row?.status}`);
}

// 2) auth
const sb = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
{
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    record('auth: sign in with QA account', 'BLOCKED', `error=${error.message}`);
    finish();
  }
  record('auth: sign in with QA account', 'PASS', 'session established');
}

// 3) every entity is loadable (workspace load is all-or-nothing)
for (const entity of ENTITIES) {
  const { data, error } = await sb.from('erp_master_records').select('id,version').eq('entity', entity).limit(5);
  if (error) record(`read: list ${entity}`, 'FAIL', `error=${error.message}`);
  else record(`read: list ${entity}`, 'PASS', `${data.length} row(s) visible`);
}

// 4) create / duplicate / update / stale on items
const itemId = `item-poc-${stamp}`;
const itemCode = `IT${String(stamp).slice(-6)}`;
{
  const { data, error } = await sb.rpc('erp_master_cas', payload('items', itemId, itemCode, 'صنف اختبار سحابي'));
  const row = Array.isArray(data) ? data[0] : data;
  if (error) record('write: create item (expected 0)', 'FAIL', `error=${error.message}`);
  else if (row?.status === 'created' && Number(row.version) === 1) record('write: create item (expected 0)', 'PASS', 'created v1');
  else record('write: create item (expected 0)', 'FAIL', `status=${row?.status} version=${row?.version}`);
}
{
  const { data } = await sb.rpc('erp_master_cas', payload('items', itemId, itemCode, 'صنف اختبار سحابي'));
  const row = Array.isArray(data) ? data[0] : data;
  record('write: duplicate create rejected', row?.status === 'conflict' ? 'PASS' : 'FAIL', `status=${row?.status} version=${row?.version}`);
}
{
  const { data } = await sb.rpc('erp_master_cas', payload('items', itemId, itemCode, 'صنف اختبار سحابي', { p_expected_version: 1 }));
  const row = Array.isArray(data) ? data[0] : data;
  record('write: update with matching version', row?.status === 'updated' && Number(row.version) === 2 ? 'PASS' : 'FAIL',
    `status=${row?.status} version=${row?.version}`);
}
{
  const { data } = await sb.rpc('erp_master_cas', payload('items', itemId, itemCode, 'محاولة قديمة', { p_expected_version: 1 }));
  const row = Array.isArray(data) ? data[0] : data;
  const { data: check } = await sb.from('erp_master_records').select('version,name_ar').eq('entity', 'items').eq('id', itemId).maybeSingle();
  const ok = row?.status === 'conflict' && Number(check?.version) === 2 && check?.name_ar === 'صنف اختبار سحابي';
  record('concurrency: stale write rejected', ok ? 'PASS' : 'FAIL',
    `status=${row?.status} storedVersion=${check?.version} name=${check?.name_ar}`);
}

// 5) parallel CAS with the same expected version
{
  const attempt = (suffix) => sb.rpc('erp_master_cas', payload('items', itemId, itemCode, `متزامن ${suffix}`, { p_expected_version: 2 }));
  const [a, b] = await Promise.all([attempt('A'), attempt('B')]);
  const ra = Array.isArray(a.data) ? a.data[0] : a.data;
  const rb = Array.isArray(b.data) ? b.data[0] : b.data;
  const statuses = [ra?.status, rb?.status].sort().join('|');
  const { data: check } = await sb.from('erp_master_records').select('version').eq('entity', 'items').eq('id', itemId).maybeSingle();
  record('concurrency: parallel CAS same version', statuses === 'conflict|updated' && Number(check?.version) === 3 ? 'PASS' : 'FAIL',
    `statuses=${statuses} finalVersion=${check?.version}`);
}

// 6) entity whitelist + cross-entity isolation
{
  const { data } = await sb.rpc('erp_master_cas', payload('invoices', `x-${stamp}`, `XX${stamp}`.slice(0, 10), 'غير مسموح'));
  const row = Array.isArray(data) ? data[0] : data;
  record('guard: unknown entity rejected', row?.status === 'invalid_entity' ? 'PASS' : 'FAIL', `status=${row?.status}`);
}
{
  const sameId = `shared-${stamp}`;
  const unit = await sb.rpc('erp_master_cas', payload('units', sameId, `UN${String(stamp).slice(-6)}`, 'وحدة اختبار'));
  const supplier = await sb.rpc('erp_master_cas', payload('suppliers', sameId, `SU${String(stamp).slice(-6)}`, 'مورد اختبار'));
  const u = Array.isArray(unit.data) ? unit.data[0] : unit.data;
  const s = Array.isArray(supplier.data) ? supplier.data[0] : supplier.data;
  const { data: rows } = await sb.from('erp_master_records').select('entity,id').eq('id', sameId);
  const entities = (rows ?? []).map(r => r.entity).sort().join(',');
  record('isolation: same id in two entities stays separate',
    u?.status === 'created' && s?.status === 'created' && entities === 'suppliers,units' ? 'PASS' : 'FAIL',
    `unit=${u?.status} supplier=${s?.status} rows=${entities}`);
}

// 7) static isolation of the new client modules
{
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const slice = strip(readFileSync(new URL('../src/services/masterDataCloudSlice.ts', import.meta.url), 'utf8'));
  const view = strip(readFileSync(new URL('../src/components/modules/cloud/CloudWorkspaceView.tsx', import.meta.url), 'utf8'));
  const noLocalStorage = !/localStorage\s*(\.\s*(getItem|setItem|removeItem|clear|key)\b|\[)/.test(slice + view);
  const noErpDb = !/services\/db/.test(slice + view);
  const noErpKey = !/['"]abdullah_erp_db_v1['"]/.test(slice + view);
  record('isolation: cloud layer ignores localStorage and erpDb', noLocalStorage && noErpDb && noErpKey ? 'PASS' : 'FAIL',
    JSON.stringify({ noLocalStorage, noErpDb, noErpKey }));
}

// 8) read-only bridge to the normalized core.* schema (real ERP master data)
for (const entity of ['warehouses', 'items', 'units', 'customers', 'suppliers']) {
  const { data, error } = await sb.rpc('erp_core_master_read', { p_entity: entity });
  if (error) record(`core read: ${entity}`, 'FAIL', `error=${error.message}`);
  else record(`core read: ${entity}`, 'PASS', `${(data ?? []).length} row(s) via allowlist bridge`);
}
{
  const { error } = await sb.rpc('erp_core_master_read', { p_entity: 'journal_entries' });
  record('core read: unknown entity rejected', error ? 'PASS' : 'FAIL', error ? 'rpc refused' : 'unexpectedly allowed');
}
{
  const { data, error } = await anon.rpc('erp_core_master_read', { p_entity: 'items' });
  record('core read: anon denied', error || !(data ?? []).length ? 'PASS' : 'FAIL', error ? `code=${error.code ?? 'n/a'}` : 'leaked rows');
}

// 9) real PostgREST reachability of core.* (what a browser client can actually do)
{
  const coreAnon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'core' },
  });
  const { data, error } = await coreAnon.from('items').select('id').limit(1);
  const denied = Boolean(error) || (data ?? []).length === 0;
  record('postgrest: core schema not exposed to anon', denied ? 'PASS' : 'FAIL',
    error ? `code=${error.code ?? 'n/a'}` : `rows=${(data ?? []).length}`);
}
{
  const coreAuth = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'core' },
  });
  await coreAuth.auth.signInWithPassword({ email, password });
  const { data, error } = await coreAuth.from('items').select('id').limit(1);
  // Documented reality: core.* IS exposed through PostgREST and gated by RLS on
  // current_erp_role(); a linked Viewer therefore reads master data directly.
  // The allowlist bridge is a narrow projection, not a security boundary.
  record('postgrest: core readable for linked Viewer (RLS-gated, documented)',
    !error && (data ?? []).length > 0 ? 'PASS' : 'FAIL',
    error ? `code=${error.code ?? 'n/a'} msg=${String(error.message).slice(0, 60)}` : `rows=${(data ?? []).length}`);
}

finish();

function finish() {
  const failed = results.filter(r => r.status === 'FAIL').length;
  const blocked = results.filter(r => r.status === 'BLOCKED').length;
  const passed = results.filter(r => r.status === 'PASS').length;
  console.log(`\nSUMMARY pass=${passed} fail=${failed} blocked=${blocked} itemId=item-poc-${stamp}`);
  process.exit(failed > 0 ? 1 : 0);
}
