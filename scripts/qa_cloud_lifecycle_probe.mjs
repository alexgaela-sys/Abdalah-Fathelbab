// scripts/qa_cloud_lifecycle_probe.mjs — TEST only, read-only.
//
// Is the production-completion surface (173_cloud_production_completion_safe.sql)
// actually deployed on the TEST project?
//
// PostgREST answers 404 PGRST202 both when a function is absent and when no
// overload matches the supplied arguments, so every probe here sends the REAL
// parameter names used by src/services/cloudManufacturingLifecycle.ts. A 404
// then means "no such signature", while 401/42501 means "deployed, not allowed
// for this role" and 200/400 means "deployed and executed".
//
// Nothing is written: every probe is called with a null/empty id, so even a
// deployed function only returns its own not_found refusal.

const url = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const candidates = [
  ['VITE_SUPABASE_ANON_KEY', (process.env.VITE_SUPABASE_ANON_KEY || '').trim()],
  ['SUPABASE_ANON_KEY', (process.env.SUPABASE_ANON_KEY || '').trim()],
];

const PROBES = [
  ['list_production_bom', { p_order_id: null }],
  ['can_complete_production', { p_order_id: null }],
  [
    'create_production_consumption',
    {
      p_order_id: null,
      p_lines: [],
      p_created_by: 'probe',
      p_idempotency_key: 'probe-readonly-' + Date.now(),
    },
  ],
  [
    'record_production_output',
    {
      p_order_id: null,
      p_good_quantity: 0,
      p_defective_quantity: 0,
      p_scrap_quantity: 0,
      p_destination_warehouse_id: null,
      p_unit_cost: null,
      p_created_by: 'probe',
      p_idempotency_key: 'probe-readonly-' + Date.now(),
    },
  ],
  [
    'close_production_order',
    {
      p_order_id: null,
      p_unit_cost: null,
      p_created_by: 'probe',
      p_idempotency_key: 'probe-readonly-' + Date.now(),
    },
  ],
  ['list_production_orders', { p_status: null, p_from: null, p_to: null }],
  ['trial_balance', { p_from: null, p_to: null }],
];

const main = async () => {
  if (!url) {
    console.log('BLOCKED | no SUPABASE_URL / VITE_SUPABASE_URL in the environment');
    process.exit(2);
  }
  let keyName = '';
  let key = '';
  for (const [name, value] of candidates) {
    if (!value || value.length < 20) continue;
    const res = await fetch(`${url}/auth/v1/health`, { headers: { apikey: value } });
    if (res.ok) {
      keyName = name;
      key = value;
      break;
    }
  }
  if (!key) {
    console.log('BLOCKED | no usable public key in the environment (see qa_env_diag.mjs)');
    process.exit(2);
  }
  console.log(`INFO    | using the public key from ${keyName}`);

  // Optional live session, so the same probe can also report "deployed + allowed".
  const email = (process.env.QA_CLOUD_TEST_EMAIL || process.env.SUPABASE_TEST_USER_EMAIL || '').trim();
  const password = process.env.QA_CLOUD_TEST_PASSWORD || process.env.SUPABASE_TEST_USER_PASSWORD || '';
  let token = '';
  if (email && password) {
    const auth = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await auth.json().catch(() => ({}));
    if (auth.ok && body?.access_token) {
      token = body.access_token;
      console.log('INFO    | signed in as the configured TEST user');
    } else {
      console.log(
        `WARN    | TEST user sign-in refused: HTTP ${auth.status} ${body?.error_description || body?.msg || body?.error || ''}`,
      );
    }
  }

  const headers = {
    apikey: key,
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  let missing = 0;
  for (const [fn, params] of PROBES) {
    const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });
    const text = await r.text();
    const absent = r.status === 404 && /PGRST202/.test(text);
    if (absent) missing += 1;
    const verdict = absent ? 'absent  ' : r.status === 401 || r.status === 403 ? 'deployed (role-gated)' : 'deployed';
    console.log(`${verdict.padEnd(22)} | ${fn.padEnd(30)} | HTTP ${r.status} ${text.slice(0, 110).replace(/\s+/g, ' ')}`);
  }

  console.log(`\nSUMMARY | probed=${PROBES.length} absent=${missing} deployed=${PROBES.length - missing}`);
  process.exit(missing ? 1 : 0);
};

await main();
