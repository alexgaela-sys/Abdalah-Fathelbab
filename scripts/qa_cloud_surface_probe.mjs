// scripts/qa_cloud_surface_probe.mjs — TEST only, read-only.
//
// Answers, without any user credentials: WHICH cloud RPCs are deployed on the
// TEST project, and with which parameter names?
//
// It reads PostgREST's OpenAPI document (`GET /rest/v1/`), which lists every
// function the API exposes. This matters because a plain RPC POST with `{}`
// returns 404 "Could not find the function … in the schema cache" BOTH when a
// function is absent AND when no overload matches the supplied arguments — so
// an empty-body probe cannot tell "missing" from "wrong params". The catalog can.
//
// No secret is printed: only the env NAME that carried a usable public key.

const url = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const candidates = [
  ['VITE_SUPABASE_ANON_KEY', (process.env.VITE_SUPABASE_ANON_KEY || '').trim()],
  ['SUPABASE_ANON_KEY', (process.env.SUPABASE_ANON_KEY || '').trim()],
];

const REQUIRED = [
  // manufacturing cycle (BOM → requirements → FIFO issue → output → close)
  'list_production_orders',
  'list_production_bom',
  'can_complete_production',
  'create_production_consumption',
  'record_production_output',
  'close_production_order',
  // operational writes already wired in the UI
  'post_sales_invoice_integrated',
  'post_inventory_transfer',
  'post_journal',
  'post_purchase_invoice',
  // reads used by the dashboard / reports / screens
  'trial_balance',
  'profit_and_loss',
  'stock_on_hand',
  'inventory_movement_report',
  'current_erp_role',
  'list_app_profiles',
  'list_sales_invoices',
  'list_inventory_transactions',
  'list_inventory_batches',
  'list_quality_inspections',
  'list_standard_cost_rates',
  'list_audit_log',
  'get_cloud_settings',
];

const main = async () => {
  if (!url) {
    console.log('BLOCKED | no VITE_SUPABASE_URL / SUPABASE_URL in the environment');
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
    console.log('BLOCKED | no usable public anon key in the environment (see qa_env_diag.mjs)');
    process.exit(2);
  }
  console.log(`INFO    | using the public key from ${keyName}`);

  // The catalog is served to the `apikey` header only; sending a publishable key
  // as a bearer token makes PostgREST reject the request before it looks at it.
  let res = await fetch(`${url}/rest/v1/`, { headers: { apikey: key } });
  if (!res.ok) {
    res = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
  }
  if (!res.ok) {
    // A catalog-free probe with an empty body cannot tell "function missing"
    // from "no overload for zero parameters", so it is not attempted here:
    // scripts/qa_cloud_lifecycle_probe.mjs sends the real parameter names and
    // is the authoritative check for the production surface.
    console.log(`BLOCKED | OpenAPI catalog refused: HTTP ${res.status}`);
    console.log('          use: node scripts/qa_cloud_lifecycle_probe.mjs');
    process.exit(2);
  }
  const spec = await res.json();
  const paths = spec?.paths ?? {};

  const found = new Map();
  for (const [path, ops] of Object.entries(paths)) {
    const m = /^\/rpc\/(.+)$/.exec(path);
    if (!m) continue;
    const params = new Set();
    for (const op of Object.values(ops ?? {})) {
      for (const p of op?.parameters ?? []) {
        const name = p?.name ?? p?.$ref?.split('/').pop();
        if (name) params.add(name);
      }
    }
    found.set(m[1], [...params].sort());
  }

  const missing = [];
  for (const fn of REQUIRED) {
    if (found.has(fn)) {
      const params = found.get(fn);
      console.log(`deployed | ${fn.padEnd(32)} | params: ${params.join(', ') || '(none)'}`);
    } else {
      missing.push(fn);
      console.log(`missing  | ${fn.padEnd(32)} |`);
    }
  }

  console.log(`\nCATALOG | ${found.size} RPCs exposed by the API`);
  console.log(
    `SUMMARY | required=${REQUIRED.length} deployed=${REQUIRED.length - missing.length} missing=${missing.length}`,
  );
  if (missing.length) console.log(`MISSING | ${missing.join(', ')}`);
  process.exit(missing.length ? 1 : 0);
};

await main();
