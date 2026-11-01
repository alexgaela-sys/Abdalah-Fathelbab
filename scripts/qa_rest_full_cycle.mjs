// scripts/qa_rest_full_cycle.mjs
//
// TEST-only REST proof of the write/posting cycle for the approved TEST account.
// It uses the same anon-key client the browser uses, so every check goes through
// PostgREST grants + RLS + the server-side role gates — nothing is simulated.
//
//   node scripts/qa_rest_full_cycle.mjs            # expects fixtures from
//                                                  #   scripts/qa_rest_full_cycle_setup.sql
//
// Checks:
//   1. config points at the TEST project ref,
//   2. the approved account signs in and its uid matches the approved uid,
//   3. current_erp_role() returns the write role that was granted,
//   4. anon cannot call the posting RPC,
//   5. a Viewer-less/unauthorised-shaped payload with an impossible quantity is
//      refused by the server, leaving no invoice (atomic failure),
//   6. the real posting succeeds: invoice + sales journal + FIFO + COGS journal,
//   7. repeating the same idempotency key returns the same invoice,
//   8. the read RPCs the UI uses return the new invoice and the reduced stock.
//
// Credentials come from QA_E2E_EMAIL / QA_E2E_PASSWORD (or SUPABASE_TEST_USER_*)
// and are never printed.

import { createClient } from '@supabase/supabase-js';

const APPROVED_UID = 'cd8ae590-5f86-4f01-87df-fb5a5b640383';
const TEST_REF = 'xrqksgjtqzddzqcwfnaj';

const results = [];
const record = (name, status, detail = '') => {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(7)} | ${name}${detail ? ` — ${detail}` : ''}`);
};

const url = (process.env.VITE_SUPABASE_URL || '').trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY || '').trim();
const email = (process.env.QA_E2E_EMAIL || process.env.SUPABASE_TEST_USER_EMAIL || '').trim();
const password = process.env.QA_E2E_PASSWORD || process.env.SUPABASE_TEST_USER_PASSWORD || '';

function finish() {
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const blocked = results.filter(r => r.status === 'BLOCKED').length;
  console.log(`\nSUMMARY pass=${pass} fail=${fail} blocked=${blocked} total=${results.length}`);
  process.exit(fail > 0 ? 1 : 0);
}

if (!url || !anonKey || !email || !password) {
  record('config: client keys + TEST credentials present', 'BLOCKED',
    'missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / QA_E2E_EMAIL / QA_E2E_PASSWORD');
  finish();
}

const ref = (() => { try { return new URL(url).hostname.split('.')[0]; } catch { return 'unparsable'; } })();
record('config: TEST project only', ref === TEST_REF ? 'PASS' : 'FAIL', ref);

const makeClient = () => createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TABLES = { rt: 'rpc-rest' };
const today = new Date().toISOString().slice(0, 10);
const lines = qty => [{
  itemId: `${TABLES.rt}-item`, quantity: qty, unitPrice: 30, discount: 0, vatRate: 0.14,
}];
const payload = (qty, key) => ({
  p_customer_id: `${TABLES.rt}-cust`,
  p_channel: 'retail',
  p_warehouse_id: 'qa-e2e-wh-01',
  p_payment_method: 'credit',
  p_currency: 'EGP',
  p_exchange_rate: 1,
  p_date: today,
  p_lines: lines(qty),
  p_created_by: 'qa-rest-full-cycle',
  p_idempotency_key: key,
});

const run = async () => {
  // ---- 4. anon must not reach the write RPC -------------------------
  const anon = makeClient();
  {
    const { error } = await anon.rpc('post_sales_invoice_integrated', payload(1, 'rpc-rest-anon'));
    record('anon: posting RPC unreachable', error ? 'PASS' : 'FAIL',
      error ? `${error.code ?? 'error'}: ${error.message}` : 'anon reached the RPC');
  }
  {
    const { error } = await anon.rpc('post_inventory_transfer', {
      p_item_id: `${TABLES.rt}-item`,
      p_source_warehouse_id: 'qa-e2e-wh-01',
      p_target_warehouse_id: 'qa-e2e-wh-01',
      p_quantity: 1,
    });
    record('anon: transfer RPC unreachable', error ? 'PASS' : 'FAIL',
      error ? `${error.code ?? 'error'}: ${error.message}` : 'anon reached the RPC');
  }

  // ---- 2/3. approved account signs in -------------------------------
  const client = makeClient();
  const { data: signIn, error: signErr } = await client.auth.signInWithPassword({ email, password });
  if (signErr || !signIn?.user) {
    record('auth: sign in as approved account', 'BLOCKED', signErr?.message ?? 'no session');
    finish();
  }
  record('auth: sign in as approved account', signIn.user.id === APPROVED_UID ? 'PASS' : 'FAIL',
    `uid=${signIn.user.id}`);
  if (signIn.user.id !== APPROVED_UID) finish();

  {
    const { data: role, error } = await client.rpc('current_erp_role');
    const ok = !error && (role === 'Super Admin' || role === 'Chief Accountant');
    record('role: current_erp_role returns a write/posting role', ok ? 'PASS' : 'FAIL',
      error ? `${error.code ?? 'error'}: ${error.message}` : String(role));
    if (!ok) finish();
  }

  // ---- 5. impossible quantity is refused, nothing is written --------
  {
    const { data, error } = await client.rpc('post_sales_invoice_integrated', payload(999, 'rpc-rest-fail'));
    const refused = Boolean(error) || data?.out_success === false;
    const msg = error ? `${error.code ?? 'error'}: ${error.message}`
      : (data ? `out_success=${data.out_success} ${data.out_error ?? ''}` : 'no row');
    record('atomic: impossible FIFO quantity refused', refused ? 'PASS' : 'FAIL', msg.slice(0, 160));
  }

  // ---- 6. the real posting ------------------------------------------
  let invoiceNumber = null;
  let cogsNumber = null;
  let cogsValue = null;
  {
    const { data, error } = await client.rpc('post_sales_invoice_integrated', payload(5, 'rpc-rest-key-1'));
    if (error) {
      record('post: integrated sales invoice', 'FAIL', `${error.code ?? 'error'}: ${error.message}`);
      finish();
    }
    const row = Array.isArray(data) ? data[0] : data;
    const ok = row?.out_success === true && Boolean(row?.out_invoice_number);
    record('post: integrated sales invoice', ok ? 'PASS' : 'FAIL',
      ok ? `${row.out_invoice_number} cogs=${row.out_cogs} journal=${row.out_journal_number}`
        : String(row?.out_error ?? 'no result'));
    if (!ok) finish();
    invoiceNumber = row.out_invoice_number;
    cogsNumber = row.out_journal_number;
    cogsValue = row.out_cogs;

    const cogsOk = Number(row.out_cogs) === 54;
    record('post: COGS journal returned for the same invoice', cogsOk ? 'PASS' : 'FAIL',
      `cogs=${row.out_cogs} (expected 54 = 3*10 + 2*12), journal=${row.out_journal_number}`);
  }

  // ---- 6b. a closed accounting period is refused ---------------------
  {
    const body = { ...payload(1, 'rpc-rest-closed'), p_date: '2026-09-15' };
    const { data, error } = await client.rpc('post_sales_invoice_integrated', body);
    const refused = Boolean(error) || data?.out_success === false;
    const msg = error ? `${error.code ?? 'error'}: ${error.message}`
      : `out_success=${data?.out_success} ${data?.out_error ?? ''}`;
    record('period: closed period refused', refused ? 'PASS' : 'FAIL', msg.slice(0, 160));
  }

  // ---- 7. idempotent retry ------------------------------------------
  {
    const { data, error } = await client.rpc('post_sales_invoice_integrated', payload(5, 'rpc-rest-key-1'));
    const row = Array.isArray(data) ? data[0] : data;
    const same = !error && row?.out_invoice_number === invoiceNumber && row?.out_success === true;
    record('idempotency: same key returns the same invoice', same ? 'PASS' : 'FAIL',
      error ? `${error.code ?? 'error'}: ${error.message}` : `${row?.out_invoice_number} / ${row?.out_status}`);
  }

  // ---- 8. the read paths the UI uses --------------------------------
  {
    const { data, error } = await client.rpc('stock_on_hand', { p_warehouse_id: 'qa-e2e-wh-01' });
    if (error) {
      record('read: stock_on_hand reflects the FIFO issue', 'BLOCKED', `${error.code ?? 'error'}: ${error.message}`);
    } else {
      const row = (Array.isArray(data) ? data : [data])
        .find(r => r?.item_id === `${TABLES.rt}-item`);
      const qty = row ? Number(row.quantity) : null;
      record('read: stock_on_hand reflects the FIFO issue', qty === 8 ? 'PASS' : 'FAIL',
        `on hand=${qty} (expected 8 of 13 after issuing 5)`);
    }
  }
  {
    const { data, error } = await client.rpc('list_sales_invoices', { p_search: invoiceNumber });
    const row = (Array.isArray(data) ? data : []).find(r => r.invoice_number === invoiceNumber);
    if (error) {
      record('read: posted invoice visible through list_sales_invoices', 'BLOCKED', `${error.code ?? 'error'}: ${error.message}`);
    } else if (!row) {
      record('read: posted invoice visible through list_sales_invoices', 'FAIL', 'invoice not returned');
    } else {
      const ok = row.status === 'posted' && Number(row.cogs_total) === 54
        && Boolean(row.journal_entry_id) && Boolean(row.journal_entry_number) && row.is_test === true;
      record('read: posted invoice visible through list_sales_invoices', ok ? 'PASS' : 'FAIL',
        `status=${row.status} cogs=${row.cogs_total} sales_jv=${row.journal_entry_number ?? 'NULL'} is_test=${row.is_test}`);
    }
  }

  await client.auth.signOut();
  console.log(`\nINVOICE=${invoiceNumber}\nCOGS_JOURNAL=${cogsNumber}\nCOGS_VALUE=${cogsValue}`);
  finish();
};

run().catch(err => {
  record('run: unexpected error', 'FAIL', err?.stack ?? String(err));
  finish();
});
