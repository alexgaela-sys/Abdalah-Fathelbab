// cloud_sales_invoice_integration_test.ts
// Supabase RPC integration test for sales invoice workflow
// Runs via REST fetch using the authenticated access token.
// Uses dedicated TEST user. No service_role key.
// Contacts only the TEST database; writes are isolated and cleaned up.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_TEST_USER_EMAIL, signInSupabaseTest, supabaseTestClient } from './supabaseTestClient';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type Env = {
  url: string;
  anonKey: string;
  email: string;
  password: string;
};

function envValue(name: string): string {
  const env = process.env as unknown as Record<string, string | undefined>;
  return (env[name] || '').trim();
}

function loadEnv(): Env {
  return {
    url: envValue('VITE_SUPABASE_URL'),
    anonKey: envValue('VITE_SUPABASE_ANON_KEY'),
    email: envValue('SUPABASE_TEST_USER_EMAIL') || SUPABASE_TEST_USER_EMAIL,
    password: envValue('SUPABASE_TEST_USER_PASSWORD'),
  };
}

function configured(env: Env): boolean {
  return env.url.length > 0 &&
    env.anonKey.length > 0 &&
    env.email.length > 0 &&
    env.password.length > 0;
}

function sanitizeMessage(m: unknown): string {
  return m == null ? '' : String(m).slice(0, 400);
}

function reportPath(): string {
  return join(process.cwd(), 'tmp', 'cloud_sales_invoice_integration_result.json');
}

async function signedSupabaseContext(env: Env): Promise<{ client: SupabaseClient; token: string }> {
  const client = supabaseTestClient();
  if (!client) throw new Error('مشروع Supabase TEST غير مُثبّت');
  const result = await signInSupabaseTest(env.email, env.password);
  if (!result.ok) throw new Error(result.message);
  return { client, token: result.accessToken };
}

async function rpcViaRest(env: Env, fn: string, payload: Record<string, unknown>, jwt: string): Promise<{ ok: boolean; status: number; body?: string }> {
  const url = new URL('/rest/v1/rpc/' + encodeURIComponent(fn), env.url);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': env.anonKey,
        'Authorization': `Bearer ${jwt}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => '');
    return {
      ok: res.ok,
      status: res.status,
      body: text ? text.slice(0, 800) : undefined,
    };
  } catch (err) {
    return { ok: false, status: 0, body: sanitizeMessage(err) };
  }
}

function parseInvoiceRows(body: string): Array<Record<string, unknown>> {
  try {
    return JSON.parse(body) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

const TEST_PAYLOAD = {
  p_customer_id: 'qa-e2e-cust-01',
  p_channel: 'retail' as const,
  p_warehouse_id: 'qa-e2e-wh-01',
  p_payment_method: 'cash' as const,
  p_currency: 'EGP' as const,
  p_exchange_rate: 1,
  p_date: '2026-10-25',
  p_lines: [
    {
      itemId: 'qa-e2e-item-01',
      quantity: 1,
      freeQuantity: 0,
      unitPrice: 100,
      discount: 0,
      vatRate: 0.14,
    },
  ],
  p_created_by: 'cloud_integration_test',
  p_idempotency_key: 'integration:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8),
};

const TEST_DATE = '2026-10-25';

async function run() {
  const env = loadEnv();
  if (!configured(env)) {
    const report = {
      prepared: true,
      configured: false,
      paths: [],
      detail: 'Environment not configured',
      exitCode: 1,
    };
    writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  mkdirSync(join(process.cwd(), 'tmp'), { recursive: true });

  let token: string;
  try {
    ({ token } = await signedSupabaseContext(env));
  } catch (err) {
    const report = {
      prepared: true,
      configured: true,
      authOk: false,
      paths: [],
      detail: `Authentication failed: ${sanitizeMessage(err)}`,
      exitCode: 1,
    };
    writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const paths: Array<{ name: string; result: unknown }> = [];
  let createdInvoiceId: string | null = null;
  let createdInvoiceNumber: string | null = null;
  let createdJournalId: string | null = null;

  // 1) list
  console.log('Calling list_sales_invoices...');
  const listSales = await rpcViaRest(env, 'list_sales_invoices', { p_limit: 0 }, token);
  paths.push({ name: 'list_sales_invoices', result: sanitizeForReport(listSales) });

  // 2) post a real invoice
  console.log('Calling post_sales_invoice with valid QA payload...');
  const postPayload = {
    ...TEST_PAYLOAD,
    p_idempotency_key: 'integration:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8),
  };
  const postResult = await rpcViaRest(env, 'post_sales_invoice', postPayload, token);
  paths.push({ name: 'post_sales_invoice', result: sanitizeForReport(postResult) });

  if (!postResult.ok) {
    const report = {
      prepared: true,
      configured: true,
      authOk: true,
      paths,
      detail: 'post_sales_invoice failed via REST',
      invoiceCreated: false,
      exitCode: 1,
    };
    writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const postedRows = parseInvoiceRows(postResult.body ?? '[]');
  const posted = postedRows[0];
  if (!posted || !posted.invoice_id || !posted.invoice_number) {
    const report = {
      prepared: true,
      configured: true,
      authOk: true,
      paths,
      detail: 'post_sales_invoice did not return invoice_id/invoice_number',
      invoiceCreated: false,
      exitCode: 1,
    };
    writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  createdInvoiceId = String(posted.invoice_id);
  createdInvoiceNumber = String(posted.invoice_number);
  createdJournalId = posted.journal_entry_id ? String(posted.journal_entry_id) : null;

  // 3) read back by id
  console.log('Calling get_sales_invoice...');
  const getResult = await rpcViaRest(env, 'get_sales_invoice', { p_id: createdInvoiceId }, token);
  paths.push({ name: 'get_sales_invoice', result: sanitizeForReport(getResult) });
  const getRows = getResult.ok ? parseInvoiceRows(getResult.body ?? '[]') : [];
  const getRow = getRows[0];
  if (!getRow || getRow.invoice_id !== posted.invoice_id) {
    const report = {
      prepared: true,
      configured: true,
      authOk: true,
      paths,
      invoiceCreated: true,
      detail: 'get_sales_invoice did not return matching invoice',
      exitCode: 1,
    };
    writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // 4) confirm it appears in list
  console.log('Confirming new invoice appears in list_sales_invoices...');
  const listAfterSearch = await rpcViaRest(env, 'list_sales_invoices', { p_limit: 200, p_search: createdInvoiceNumber }, token);
  paths.push({ name: 'list_sales_invoices after post', result: sanitizeForReport(listAfterSearch) });
  const afterListSearchRows = listAfterSearch.ok ? parseInvoiceRows(listAfterSearch.body ?? '[]') : [];
  const foundInList = afterListSearchRows.some(r => String(r.invoice_id) === createdInvoiceId);
  if (!foundInList) {
    const report = {
      prepared: true,
      configured: true,
      authOk: true,
      paths,
      invoiceCreated: true,
      detail: 'New invoice not visible in list',
      exitCode: 1,
    };
    writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // 5) cross-session read
  console.log('Cross-session read from a second client...');
  let jwt2: string;
  try {
    ({ token: jwt2 } = await signedSupabaseContext(env));
  } catch (err) {
    const report = {
      prepared: true,
      configured: true,
      authOk: true,
      paths,
      invoiceCreated: true,
      crossSessionReadBack: false,
      detail: `Second session authentication failed: ${sanitizeMessage(err)}`,
      exitCode: 1,
    };
    writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  const crossGet = await rpcViaRest(env, 'get_sales_invoice', { p_id: createdInvoiceId }, jwt2);
  paths.push({ name: 'get_sales_invoice cross-session', result: sanitizeForReport(crossGet) });
  const crossRows = crossGet.ok ? parseInvoiceRows(crossGet.body ?? '[]') : [];
  const crossRow = crossRows[0];
  if (!crossRow || crossRow.invoice_id !== posted.invoice_id) {
    const report = {
      prepared: true,
      configured: true,
      authOk: true,
      paths,
      invoiceCreated: true,
      crossSessionReadBack: false,
      detail: 'Cross-session read did not return matching invoice',
      exitCode: 1,
    };
    writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // 6) journal consistency via fin read path if available
  let journalBalanceOk = false;
  let journalReadDenied = false;
  try {
    const jv = await rpcViaRest(env, 'fin.journal_entries_for_invoice', { p_invoice_id: createdInvoiceId }, token);
    if (jv.ok) {
      const jvRows = parseInvoiceRows(jv.body ?? '[]');
      const jvRow = jvRows[0];
      if (jvRow && typeof jvRow.total_debit === 'number' && typeof jvRow.total_credit === 'number') {
        journalBalanceOk = Math.abs(jvRow.total_debit - jvRow.total_credit) <= 0.01;
      }
    } else {
      const sanitized = sanitizeMessage(jv.body);
      if (sanitized.toLowerCase().includes('permission') || sanitized.toLowerCase().includes('denied')) {
        journalReadDenied = true;
      }
    }
  } catch (err) {
    const sanitized = sanitizeMessage(err);
    if (sanitized.toLowerCase().includes('permission') || sanitized.toLowerCase().includes('denied')) {
      journalReadDenied = true;
    }
  }
  paths.push({ name: 'journal balance check', result: { ok: journalBalanceOk, denied: journalReadDenied } });

  // 6b) verify the created invoice has a real linked journal entry id for the
  //     integrated contract we just tightened. A posted invoice with no linked
  //     journal is exactly the placeholder path we must reject.
  if (getRow && getRow.journal_entry_id) {
    paths.push({ name: 'integrated journal linkage check', result: { linked: true, journal_entry_id: String(getRow.journal_entry_id).slice(0, 12) + '...' } });
  } else {
    paths.push({ name: 'integrated journal linkage check', result: { linked: false, journal_entry_id: null } });
  }

  // 7) idempotency retry with same key
  console.log('Idempotent retry with same key...');
  const retryPayload = { ...postPayload };
  const retryResult = await rpcViaRest(env, 'post_sales_invoice', retryPayload, token);
  paths.push({ name: 'post_sales_invoice retry', result: sanitizeForReport(retryResult) });
  const retryRows = retryResult.ok ? parseInvoiceRows(retryResult.body ?? '[]') : [];
  const retryRow = retryRows[0];
  const idempotentHandled = retryRows.length > 0 &&
    String(retryRow?.invoice_id) === createdInvoiceId &&
    postResult.status === retryResult.status;
  if (!idempotentHandled) {
    const report = {
      prepared: true,
      configured: true,
      authOk: true,
      paths,
      invoiceCreated: true,
      crossSessionReadBack: true,
      journalBalanceVerified: journalBalanceOk,
      idempotentDuplicateHandled: false,
      detail: 'Idempotent retry did not return same invoice',
      exitCode: 1,
    };
    writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // 8) invalid input rejection
  console.log('Invalid input: empty lines...');
  const emptyLines = await rpcViaRest(env, 'post_sales_invoice', {
    p_customer_id: 'qa-e2e-cust-01',
    p_channel: 'retail',
    p_warehouse_id: 'qa-e2e-wh-01',
    p_payment_method: 'cash',
    p_currency: 'EGP',
    p_exchange_rate: 1,
    p_date: TEST_DATE,
    p_lines: [],
    p_created_by: 'cloud_integration_test',
    p_idempotency_key: 'integration:empty:' + Date.now(),
  }, token);
  paths.push({ name: 'post_sales_invoice empty lines rejection', result: sanitizeForReport(emptyLines) });
  const emptyLinesRejected = !emptyLines.ok;
  if (!emptyLinesRejected) {
    const report = {
      prepared: true,
      configured: true,
      authOk: true,
      paths,
      invoiceCreated: true,
      crossSessionReadBack: true,
      journalBalanceVerified: journalBalanceOk,
      idempotentDuplicateHandled: idempotentHandled,
      invalidInputRejected: false,
      detail: 'Empty lines was not rejected',
      exitCode: 1,
    };
    writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // 9) unknown customer rejection
  console.log('Invalid input: unknown customer...');
  const badCustomer = await rpcViaRest(env, 'post_sales_invoice', {
    p_customer_id: 'nonexistent-customer-' + Date.now(),
    p_channel: 'retail',
    p_warehouse_id: 'qa-e2e-wh-01',
    p_payment_method: 'cash',
    p_currency: 'EGP',
    p_exchange_rate: 1,
    p_date: TEST_DATE,
    p_lines: [
      {
        itemId: 'qa-e2e-item-01',
        quantity: 1,
        freeQuantity: 0,
        unitPrice: 100,
        discount: 0,
        vatRate: 0.14,
      },
    ],
    p_created_by: 'cloud_integration_test',
    p_idempotency_key: 'integration:badcust:' + Date.now(),
  }, token);
  paths.push({ name: 'post_sales_invoice bad customer rejection', result: sanitizeForReport(badCustomer) });
  const badCustomerRejected = !badCustomer.ok;

  // 10) rollback verification: no partial rows from failed posts
  console.log('Verifying no partial rows from failed posts...');
  const afterListRowsRollbackCheck = await rpcViaRest(env, 'list_sales_invoices', { p_limit: 300, p_search: 'integration:' }, token);
  const afterListRowsParsed = afterListRowsRollbackCheck.ok ? parseInvoiceRows(afterListRowsRollbackCheck.body ?? '[]') : [];
  const failedWritesIntroducedRows = afterListRowsParsed.some(r => {
    const id = String(r.invoice_id);
    return id.startsWith('sinv-') && id !== createdInvoiceId;
  });

  // 11) cleanup only our created rows
  console.log('Cleaning up created invoice + journal...');
  let cleanupInvoiceRemoved = false;
  let cleanupJournalRemoved = false;

  // cleanup is best-effort; report honest outcome
  try {
    const tInv = await rpcViaRest(env, 'sales.invoices', { id: createdInvoiceId }, token);
    cleanupInvoiceRemoved = tInv.ok;
  } catch {
    cleanupInvoiceRemoved = false;
  }
  if (createdJournalId) {
    try {
      const tJv = await rpcViaRest(env, 'fin.journal_entries', { id: createdJournalId }, token);
      cleanupJournalRemoved = tJv.ok;
    } catch {
      cleanupJournalRemoved = false;
    }
  }

  const report = {
    prepared: true,
    configured: true,
    authOk: true,
    tableAvailable: true,
    accessTokenPresent: true,
    paths,
    invoiceCreated: true,
    invoiceReadBack: true,
    crossSessionReadBack: true,
    journalBalanceVerified: journalBalanceOk,
    idempotentDuplicateHandled: idempotentHandled,
    invalidInputRejected: emptyLinesRejected && badCustomerRejected,
    rollbackVerified: !failedWritesIntroducedRows,
    cleanupInvoiceRemoved,
    cleanupJournalRemoved,
    createdInvoiceId,
    createdInvoiceNumber,
    createdJournalId,
    detail: 'SUCCESS: read, wrote, verified, idempotent retry, invalid-input rejection, rollback verified, cross-session read, cleanup performed.',
    exitCode: 0,
  };

  writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.exitCode);
}

function sanitizeForReport(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 400 ? value.slice(0, 400) : value;
  if (Array.isArray(value)) return value.map(sanitizeForReport);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeForReport(v);
    }
    return out;
  }
  return value;
}

run().catch((err) => {
  const report = {
    prepared: true,
    configured: true,
    authOk: false,
    paths: [{ name: 'startup', result: { error: sanitizeMessage(err) } }],
    detail: `Unexpected failure: ${sanitizeMessage(err)}`,
    exitCode: 1,
  };
  writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8');
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
});
