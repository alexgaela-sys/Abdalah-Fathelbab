// Probe Supabase TEST: session, production RPC availability, master data needed
// to run a real production cycle. Read-only apart from auth.
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const email = process.env.QA_CLOUD_TEST_EMAIL;
const password = process.env.QA_CLOUD_TEST_PASSWORD;

const out = { steps: [] };
const rec = (name, value) => { out.steps.push({ name, value }); };

if (!url || !anon || !email || !password) {
  console.log(JSON.stringify({ fatal: 'missing env', have: { url: !!url, anon: !!anon, email: !!email, password: !!password } }, null, 2));
  process.exit(2);
}

const sb = createClient(url, anon, { auth: { persistSession: false } });

const signIn = await sb.auth.signInWithPassword({ email, password });
rec('signin', signIn.error ? { error: signIn.error.message } : { ok: true, user: signIn.data.user?.id });
if (signIn.error) { console.log(JSON.stringify(out, null, 2)); process.exit(1); }

async function rpc(name, params) {
  const { data, error } = await sb.rpc(name, params);
  return error ? { error: error.message, code: error.code } : { data };
}
async function tbl(schema, table, cols, limit = 5) {
  const { data, error } = await sb.schema(schema).from(table).select(cols).limit(limit);
  return error ? { error: error.message, code: error.code } : { rows: data };
}
async function countOf(schema, table) {
  const { count, error } = await sb.schema(schema).from(table).select('*', { count: 'exact', head: true });
  return error ? { error: error.message } : { count };
}

rec('rpc.create_production_consumption', await rpc('create_production_consumption', {
  p_order_id: '__probe_missing_order__', p_lines: [], p_created_by: 'probe', p_idempotency_key: 'probe-' + Date.now(),
}));
rec('rpc.record_production_output', await rpc('record_production_output', {
  p_order_id: '__probe_missing_order__', p_good_quantity: 1, p_created_by: 'probe', p_idempotency_key: 'probe-' + Date.now(),
}));
rec('rpc.close_production_order', await rpc('close_production_order', {
  p_order_id: '__probe_missing_order__', p_created_by: 'probe', p_idempotency_key: 'probe-' + Date.now(),
}));
rec('rpc.can_complete_production', await rpc('can_complete_production', { p_order_id: '__probe_missing_order__' }));
rec('rpc.can_write_inventory', await rpc('can_write_inventory', {}));

rec('counts.boms', await countOf('core', 'boms'));
rec('counts.bom_lines', await countOf('core', 'bom_lines'));
rec('counts.items', await countOf('core', 'items'));
rec('counts.batches', await countOf('inventory', 'batches'));
rec('counts.orders', await countOf('production', 'orders'));
rec('counts.consumptions', await countOf('production', 'consumptions'));
rec('counts.mappings', await countOf('core', 'account_mappings'));

rec('boms', await tbl('core', 'boms', '*', 10));
rec('mappings', await tbl('core', 'account_mappings', 'key,account_id', 200));
rec('consumption_cols_probe', await tbl('production', 'consumptions', '*', 1));
rec('orders_probe', await tbl('production', 'orders', '*', 1));

console.log(JSON.stringify(out, null, 2));
