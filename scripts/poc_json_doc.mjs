// TEST-ONLY POC test runner for the JSON document + CAS function.
//
//   node scripts/poc_json_doc.mjs
//
// Reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY and QA_CLOUD_TEST_EMAIL /
// QA_CLOUD_TEST_PASSWORD from the environment at runtime (never prints them).
// Uses synthetic JSON only. No service_role, no ERP data, no localStorage.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const SCOPE = 'snakdip-test-poc';
const KEY = `poc-run-${Date.now()}`;
const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(7)} | ${name}${detail ? ` — ${detail}` : ''}`);
}

function synthetic(seed) {
  return {
    kind: 'snakdip-poc-synthetic',
    seed,
    counter: 1,
    sample: { items: [{ code: 'POC-ITEM-1', price: 12.5 }], totals: { total: 142.5, currency: 'EGP' } },
  };
}

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
record('config: Supabase URL points at TEST project ref', projectRef === 'xrqksgjtqzddzqcwfnaj' ? 'PASS' : 'FAIL', projectRef);

const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

// 1) Anonymous access must be denied by RLS/grants.
{
  const { data, error } = await anon.from('erp_json_documents').select('version').limit(1);
  if (error) record('anon: direct SELECT denied', 'PASS', `code=${error.code ?? 'n/a'}`);
  else if (!data || data.length === 0) record('anon: direct SELECT returns no rows', 'PASS', 'RLS filtered');
  else record('anon: direct SELECT denied', 'FAIL', `leaked ${data.length} row(s)`);
}
{
  const { data, error } = await anon.rpc('erp_doc_cas', {
    p_scope: SCOPE, p_doc_key: KEY, p_expected_version: 0, p_payload: synthetic(1),
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error) record('anon: RPC erp_doc_cas denied', 'PASS', `code=${error.code ?? 'n/a'}`);
  else if (row?.status === 'not_authenticated') record('anon: RPC erp_doc_cas denied', 'PASS', 'not_authenticated');
  else record('anon: RPC erp_doc_cas denied', 'FAIL', `status=${row?.status}`);
}

// 2) Authenticate the existing QA account.
const sb = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
if (!email || !password) {
  record('auth: QA credentials available in env', 'BLOCKED', 'QA_CLOUD_TEST_EMAIL / QA_CLOUD_TEST_PASSWORD missing');
  finish();
}
{
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    record('auth: sign in with existing QA account', 'BLOCKED', `error=${error.message}`);
    finish();
  }
  record('auth: sign in with existing QA account', 'PASS', `user=${data.user?.id ? 'resolved' : 'unknown'}`);
}

// 3) First creation wins exactly once.
{
  const { data, error } = await sb.rpc('erp_doc_cas', {
    p_scope: SCOPE, p_doc_key: KEY, p_expected_version: 0, p_payload: synthetic(100),
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error) record('write: first create (expected 0)', 'FAIL', `error=${error.message}`);
  else if (row?.status === 'created' && Number(row.version) === 1) record('write: first create (expected 0)', 'PASS', 'status=created version=1');
  else record('write: first create (expected 0)', 'FAIL', `status=${row?.status} version=${row?.version}`);
}

// 4) Read back.
{
  const { data, error } = await sb.from('erp_json_documents')
    .select('version,payload,updated_at').eq('scope', SCOPE).eq('doc_key', KEY).maybeSingle();
  if (error) record('read: load JSON document', 'FAIL', `error=${error.message}`);
  else if (data && Number(data.version) === 1 && data.payload?.seed === 100) record('read: load JSON document', 'PASS', 'version=1 payload matches');
  else record('read: load JSON document', 'FAIL', `data=${JSON.stringify(data)?.slice(0, 160)}`);
}

// 5) Second create attempt with expected 0 must conflict (write-once per version).
{
  const { data, error } = await sb.rpc('erp_doc_cas', {
    p_scope: SCOPE, p_doc_key: KEY, p_expected_version: 0, p_payload: synthetic(200),
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error) record('write: duplicate create rejected', 'FAIL', `error=${error.message}`);
  else if (row?.status === 'conflict' && Number(row.version) === 1) record('write: duplicate create rejected', 'PASS', 'status=conflict version=1');
  else record('write: duplicate create rejected', 'FAIL', `status=${row?.status} version=${row?.version}`);
}

// 6) Valid update increments the version.
{
  const { data, error } = await sb.rpc('erp_doc_cas', {
    p_scope: SCOPE, p_doc_key: KEY, p_expected_version: 1, p_payload: synthetic(300),
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error) record('write: update with matching version', 'FAIL', `error=${error.message}`);
  else if (row?.status === 'updated' && Number(row.version) === 2) record('write: update with matching version', 'PASS', 'status=updated version=2');
  else record('write: update with matching version', 'FAIL', `status=${row?.status} version=${row?.version}`);
}

// 7) Stale write is rejected and does not overwrite.
{
  const { data, error } = await sb.rpc('erp_doc_cas', {
    p_scope: SCOPE, p_doc_key: KEY, p_expected_version: 1, p_payload: synthetic(999),
  });
  const row = Array.isArray(data) ? data[0] : data;
  const { data: check } = await sb.from('erp_json_documents')
    .select('version,payload').eq('scope', SCOPE).eq('doc_key', KEY).maybeSingle();
  if (error) record('concurrency: stale write rejected', 'FAIL', `error=${error.message}`);
  else if (row?.status === 'conflict' && Number(row.version) === 2 && Number(check?.version) === 2 && check?.payload?.seed === 300)
    record('concurrency: stale write rejected', 'PASS', 'status=conflict, stored version still 2');
  else record('concurrency: stale write rejected', 'FAIL', `status=${row?.status} storedVersion=${check?.version} seed=${check?.payload?.seed}`);
}

// 8) Two concurrent writes with the same expected version: exactly one wins.
{
  const attempt = (seed) => sb.rpc('erp_doc_cas', {
    p_scope: SCOPE, p_doc_key: KEY, p_expected_version: 2, p_payload: synthetic(seed),
  });
  const [a, b] = await Promise.all([attempt(401), attempt(402)]);
  const ra = Array.isArray(a.data) ? a.data[0] : a.data;
  const rb = Array.isArray(b.data) ? b.data[0] : b.data;
  const statuses = [ra?.status, rb?.status].sort().join('|');
  const { data: check } = await sb.from('erp_json_documents')
    .select('version').eq('scope', SCOPE).eq('doc_key', KEY).maybeSingle();
  if (a.error || b.error) record('concurrency: parallel CAS same version', 'FAIL', `errors=${a.error?.message ?? ''}/${b.error?.message ?? ''}`);
  else if (statuses === 'conflict|updated' && Number(check?.version) === 3)
    record('concurrency: parallel CAS same version', 'PASS', `statuses=${statuses} finalVersion=3`);
  else record('concurrency: parallel CAS same version', 'FAIL', `statuses=${statuses} finalVersion=${check?.version}`);
}

// 9) A non-allowlisted authenticated user is not testable without an admin API key.
record('authz: non-allowlisted authenticated user rejected', 'BLOCKED',
  'كل مستخدمي TEST الحاليين مُدرجون في قائمة الكتابة؛ لا يوجد حساب مصادَق غير مُصرَّح به لاختباره، وإنشاء واحد يتطلب مفتاح إدارة لا نملكه (ولن نضعه في المتصفح)');

// 10) Local ERP path and localStorage untouched (static proof).
{
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const mode = read('src/data/mode.ts');
  // Strip comments so "does not touch localStorage" prose is not mistaken for usage.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const service = stripComments(read('src/services/jsonDocPoc.ts'));
  const panel = stripComments(read('src/components/modules/cloud/JsonDocPocPanel.tsx'));
  const modeLocal = /return\s+'local'/.test(mode);
  const noLocalStorage =
    !/localStorage\s*(\.\s*(getItem|setItem|removeItem|clear|key)\b|\[)/.test(service + panel);
  const noErpDb = !/from '.*services\/db'/.test(service + panel);
  const noErpKey = !/['"]abdullah_erp_db_v1['"]/.test(service + panel);
  if (modeLocal && noLocalStorage && noErpDb && noErpKey)
    record('isolation: local mode unchanged, POC ignores localStorage/erpDb', 'PASS',
      'resolveDataMode=local, no localStorage, no erpDb, no abdullah_erp_db_v1 reference');
  else
    record('isolation: local mode unchanged, POC ignores localStorage/erpDb', 'FAIL',
      JSON.stringify({ modeLocal, noLocalStorage, noErpDb, noErpKey }));
}

finish();

function finish() {
  const failed = results.filter(r => r.status === 'FAIL').length;
  const blocked = results.filter(r => r.status === 'BLOCKED').length;
  const passed = results.filter(r => r.status === 'PASS').length;
  console.log(`\nSUMMARY pass=${passed} fail=${failed} blocked=${blocked} docKey=${KEY}`);
  process.exit(failed > 0 ? 1 : 0);
}
