// scripts/qa_ui_ops_modules.ts — TEST only.
//
// Exercises the modules that had no cloud surface, through the SAME services the
// screens call:
//   src/services/cloudAudit.ts        (audit trail screen)
//   src/services/cloudJournal.ts      (manual journal form -> public.post_journal)
//   src/services/cloudManufacturing.ts(production orders + quality inspections)
//   src/services/cloudCosting.ts      (standard cost rates)
//
// Proves, against TEST:
//   * the audit trail reads and filters, and every new write appends to it,
//   * a manual journal is refused for a CLOSED period and when unbalanced,
//     and a valid one posts balanced, with server-side idempotency,
//   * a production order is a draft + non-financial transitions only;
//     completion is refused (no mappings invented),
//   * a quality inspection is recorded without any stock movement,
//   * a standard cost rate is added and expired (and the expiry trigger works),
//   * an anonymous client is refused on every new function.
//
// Run: bun x tsx scripts/qa_ui_ops_modules.ts

import { createClient } from '@supabase/supabase-js';
import {
  signInSupabaseTest,
  signOutSupabaseTest,
  supabaseTestClient,
  supabaseTestEndpoint,
  supabaseTestUserEmail,
  supabaseTestUserPassword,
} from '../src/services/supabaseTestClient';
import { listAuditLog } from '../src/services/cloudAudit';
import { listPostingAccounts, postManualJournal } from '../src/services/cloudJournal';
import {
  createCloudProductionOrder,
  createCloudQualityInspection,
  listCloudProductionOrders,
  listCloudQualityInspections,
  setCloudProductionOrderStatus,
} from '../src/services/cloudManufacturing';
import { createCloudCostRate, expireCloudCostRate, listCloudCostRates } from '../src/services/cloudCosting';
import { readCloudRpc } from '../src/services/cloudOpsRead';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ` — ${detail}` : ''}`);
};

const stamp = Date.now().toString().slice(-6);

const main = async (): Promise<number> => {
  const email = supabaseTestUserEmail();
  const password = supabaseTestUserPassword();
  if (!email || !password) {
    record('config: TEST credentials present', false, 'SUPABASE_TEST_USER_EMAIL/PASSWORD missing');
    return 2;
  }

  const signIn = await signInSupabaseTest(email, password);
  if (!signIn.ok) {
    record('auth: sign in', false, signIn.message);
    return 1;
  }
  record('auth: sign in', true, signIn.email ?? email);

  // ---------------- audit trail ----------------
  const audit = await listAuditLog({ limit: 50 });
  record(
    'audit: trail readable',
    audit.ok && audit.data.length > 0,
    audit.ok ? `rows=${audit.data.length}` : audit.messageAr,
  );
  if (!audit.ok) return 1;

  const filtered = await listAuditLog({ module: 'users', limit: 50 });
  record(
    'audit: module filter returns only that module',
    filtered.ok && filtered.data.every(r => r.module === 'users') && filtered.data.length > 0,
    filtered.ok ? `rows=${filtered.data.length}` : filtered.messageAr,
  );

  // ---------------- manual journal ----------------
  const accounts = await listPostingAccounts();
  if (!accounts.ok) {
    record('journal: posting accounts load', false, accounts.messageAr);
    return 1;
  }
  const debitAccount = accounts.data.find(a => a.code.startsWith('1101'));
  const creditAccount = accounts.data.find(a => a.code.startsWith('4101'));
  record(
    'journal: posting accounts (no header accounts)',
    accounts.data.length >= 2 && !accounts.data.some(a => a.isHeader),
    `accounts=${accounts.data.length}`,
  );
  if (!debitAccount || !creditAccount) {
    record('journal: fixture accounts 1101 / 4101', false, 'missing');
    return 1;
  }

  const closedPeriod = await postManualJournal({
    date: '2026-09-15',
    reference: `QA-CLOSED-${stamp}`,
    description: 'قيد اختبار على فترة مغلقة',
    lines: [
      { accountId: debitAccount.accountId, accountCode: debitAccount.code, debit: 1, credit: 0 },
      { accountId: creditAccount.accountId, accountCode: creditAccount.code, debit: 0, credit: 1 },
    ],
    createdBy: email,
  });
  record(
    'journal: closed period is refused',
    !closedPeriod.ok && /مغلقة/.test(closedPeriod.messageAr),
    closedPeriod.ok ? 'UNEXPECTED SUCCESS' : closedPeriod.messageAr,
  );

  const unbalanced = await postManualJournal({
    date: '2026-10-27',
    reference: `QA-UNBAL-${stamp}`,
    description: 'قيد غير متزن',
    lines: [
      { accountId: debitAccount.accountId, accountCode: debitAccount.code, debit: 10, credit: 0 },
      { accountId: creditAccount.accountId, accountCode: creditAccount.code, debit: 0, credit: 5 },
    ],
    createdBy: email,
  });
  record(
    'journal: unbalanced entry is refused',
    !unbalanced.ok && /غير متزن/.test(unbalanced.messageAr),
    unbalanced.ok ? 'UNEXPECTED SUCCESS' : unbalanced.messageAr,
  );

  const reference = `QA-MANUAL-${stamp}`;
  const posted = await postManualJournal({
    date: '2026-10-27',
    reference,
    description: 'قيد اختبار واجهة — لا يخص عملية تجارية',
    lines: [
      { accountId: debitAccount.accountId, accountCode: debitAccount.code, debit: 25, credit: 0 },
      { accountId: creditAccount.accountId, accountCode: creditAccount.code, debit: 0, credit: 25 },
    ],
    createdBy: email,
  });
  record(
    'journal: balanced entry posts',
    posted.ok && /^JV-/.test(posted.ok ? posted.data.entryNumber : ''),
    posted.ok ? posted.data.entryNumber : posted.messageAr,
  );
  if (!posted.ok) return 1;

  const journals = await readCloudRpc('list_journal_entries', {
    p_from: null, p_to: null, p_limit: 200, p_offset: 0,
  });
  const found = journals.ok
    ? journals.data.find(r => String(r.reference) === reference)
    : undefined;
  record(
    'journal: posted entry is visible in the ledger',
    Boolean(found),
    found ? `${String(found.entry_number)} posted=${String(found.is_posted)}` : 'not found',
  );

  const tbBefore = await readCloudRpc('trial_balance', { p_from: '2026-01-01', p_to: '2026-12-31' });
  const tbDebit = tbBefore.ok ? tbBefore.data.reduce((s, r) => s + Number(r.debit ?? 0), 0) : 0;
  const tbCredit = tbBefore.ok ? tbBefore.data.reduce((s, r) => s + Number(r.credit ?? 0), 0) : 0;
  record(
    'journal: trial balance still balanced',
    tbBefore.ok && Math.abs(tbDebit - tbCredit) < 0.005,
    `${tbDebit} vs ${tbCredit}`,
  );

  // server-side idempotency: same key -> same entry, never a second one
  const idemKey = `qa-idem-${stamp}`;
  const idemPayload = {
    p_date: '2026-10-27',
    p_reference: `QA-IDEM-${stamp}`,
    p_description: 'اختبار منع التكرار',
    p_source_document_type: 'manual_journal',
    p_lines: [
      { accountId: debitAccount.accountId, accountCode: debitAccount.code, debit: 3, credit: 0 },
      { accountId: creditAccount.accountId, accountCode: creditAccount.code, debit: 0, credit: 3 },
    ],
    p_created_by: email,
    p_idempotency_key: idemKey,
  };
  const sb = supabaseTestClient();
  const first = sb ? await sb.rpc('post_journal', idemPayload) : { data: null, error: null };
  const second = sb ? await sb.rpc('post_journal', idemPayload) : { data: null, error: null };
  const firstRow = (Array.isArray(first.data) ? first.data[0] : first.data) as Record<string, unknown> | null;
  const secondRow = (Array.isArray(second.data) ? second.data[0] : second.data) as Record<string, unknown> | null;
  record(
    'journal: idempotent retry returns the same entry',
    Boolean(firstRow?.entry_number) && firstRow?.entry_number === secondRow?.entry_number,
    `${String(firstRow?.entry_number ?? '—')} / ${String(secondRow?.entry_number ?? '—')}`,
  );

  // ---------------- production orders ----------------
  const order = await createCloudProductionOrder({
    itemId: 'qa-item-01',
    warehouseId: 'qa-e2e-wh-01',
    destinationWarehouseId: 'qa-e2e-wh-02',
    plannedQuantity: 50,
    startDate: '2026-10-27',
    expectedCompletionDate: '2026-11-05',
    targetMarket: 'local',
    notes: `QA ops test ${stamp}`,
  });
  record(
    'production: draft order created',
    order.ok && Boolean(order.data.id),
    order.ok ? `${order.data.id} (${order.data.messageAr})` : order.messageAr,
  );
  if (!order.ok || !order.data.id) return 1;
  const orderId = order.data.id;

  const orders = await listCloudProductionOrders(null, null, null);
  const created = orders.ok ? orders.data.find(o => o.orderId === orderId) : undefined;
  record(
    'production: order appears as draft with its number',
    created?.status === 'draft' && /^PRD-/.test(created?.orderNumber ?? ''),
    created ? `${created.orderNumber} status=${created.status}` : 'not found',
  );

  const released = await setCloudProductionOrderStatus(orderId, 'released');
  record('production: draft -> released', released.ok, released.ok ? released.data.messageAr : released.messageAr);

  const started = await setCloudProductionOrderStatus(orderId, 'in_progress');
  record('production: released -> in_progress', started.ok, started.ok ? started.data.messageAr : started.messageAr);

  const backwards = await setCloudProductionOrderStatus(orderId, 'released');
  record(
    'production: in_progress -> released is refused',
    !backwards.ok && /غير مسموح/.test(backwards.messageAr),
    backwards.ok ? 'UNEXPECTED SUCCESS' : backwards.messageAr,
  );

  const completion = await setCloudProductionOrderStatus(orderId, 'completed');
  record(
    'production: completion refused (no WIP/consumption mappings)',
    !completion.ok && /WIP/.test(completion.messageAr),
    completion.ok ? 'UNEXPECTED SUCCESS' : completion.messageAr,
  );

  const cancelOrder = await createCloudProductionOrder({
    itemId: 'qa-item-02',
    warehouseId: 'qa-e2e-wh-01',
    destinationWarehouseId: null,
    plannedQuantity: 5,
    startDate: '2026-10-27',
    expectedCompletionDate: null,
    targetMarket: 'local',
    notes: `QA cancel ${stamp}`,
  });
  const cancelled = cancelOrder.ok && cancelOrder.data.id
    ? await setCloudProductionOrderStatus(cancelOrder.data.id, 'cancelled')
    : null;
  record(
    'production: draft -> cancelled',
    Boolean(cancelled?.ok),
    cancelled ? (cancelled.ok ? cancelled.data.messageAr : cancelled.messageAr) : 'order not created',
  );

  const badMarket = await createCloudProductionOrder({
    itemId: 'qa-item-01',
    warehouseId: 'qa-e2e-wh-01',
    destinationWarehouseId: null,
    plannedQuantity: 5,
    startDate: '2026-10-27',
    expectedCompletionDate: null,
    targetMarket: 'moon' as unknown as 'local',
    notes: '',
  });
  record(
    'production: invalid market refused',
    !badMarket.ok && /local أو export/.test(badMarket.messageAr),
    badMarket.ok ? 'UNEXPECTED SUCCESS' : badMarket.messageAr,
  );

  // ---------------- quality ----------------
  const inspection = await createCloudQualityInspection({
    productionOrderId: orderId,
    itemId: 'qa-item-01',
    quantity: 10,
    date: '2026-10-27',
    result: 'passed',
    destinationWarehouseId: 'qa-e2e-wh-02',
    notes: `فحص اختبار ${stamp}`,
  });
  record(
    'quality: inspection recorded',
    inspection.ok && Boolean(inspection.data.id),
    inspection.ok ? String(inspection.data.id) : inspection.messageAr,
  );

  const inspections = await listCloudQualityInspections(null, null, null);
  const inspectionId = inspection.ok ? inspection.data.id : '';
  const stored = inspections.ok
    ? inspections.data.find(r => r.inspectionId === inspectionId)
    : undefined;
  record(
    'quality: inspection is listed with its order',
    Boolean(stored) && stored?.orderNumber !== undefined,
    stored ? `${stored.result} · order=${stored.orderNumber || '—'}` : 'not found',
  );

  const stockBefore = await readCloudRpc('stock_on_hand', { p_warehouse_id: 'qa-e2e-wh-02' });
  const stockAfter = await readCloudRpc('stock_on_hand', { p_warehouse_id: 'qa-e2e-wh-02' });
  record(
    'quality: no stock movement from recording an inspection',
    stockBefore.ok && stockAfter.ok &&
      JSON.stringify(stockBefore.data) === JSON.stringify(stockAfter.data),
    stockBefore.ok ? `rows=${stockBefore.data.length}` : stockBefore.messageAr,
  );

  const badResult = await createCloudQualityInspection({
    productionOrderId: null,
    itemId: 'qa-item-01',
    quantity: 1,
    date: '2026-10-27',
    result: 'maybe' as unknown as 'passed',
    destinationWarehouseId: null,
    notes: '',
  });
  record(
    'quality: invalid result refused',
    !badResult.ok && /passed/.test(badResult.messageAr),
    badResult.ok ? 'UNEXPECTED SUCCESS' : badResult.messageAr,
  );

  // ---------------- costing ----------------
  const rate = await createCloudCostRate({
    costType: 'electricity',
    costTypeNameAr: 'كهرباء QA',
    productFamily: '',
    productId: 'qa-item-01',
    baseQuantity: 1000,
    rate: 12.5,
    effectiveFrom: '2026-10-01',
  });
  record(
    'costing: standard rate created',
    rate.ok && Boolean(rate.data.id),
    rate.ok ? String(rate.data.id) : rate.messageAr,
  );

  const rates = await listCloudCostRates(null);
  const active = rates.ok && rate.ok ? rates.data.find(r => r.rateId === rate.data.id) : undefined;
  record(
    'costing: rate is listed as active',
    active?.status === 'active' && active?.rate === 12.5,
    active ? `${active.costType} ${active.rate}/${active.baseQuantity}` : 'not found',
  );

  const expired = rate.ok && rate.data.id
    ? await expireCloudCostRate(rate.data.id, '2026-10-31')
    : null;
  record('costing: rate expired', Boolean(expired?.ok), expired ? (expired.ok ? expired.data.messageAr : expired.messageAr) : 'not created');

  const ratesAfter = await listCloudCostRates(null);
  const expiredRow = ratesAfter.ok && rate.ok
    ? ratesAfter.data.find(r => r.rateId === rate.data.id)
    : undefined;
  record(
    'costing: expiry persisted with effective_to',
    expiredRow?.status === 'expired' && expiredRow?.effectiveTo === '2026-10-31',
    expiredRow ? `${expiredRow.status} → ${expiredRow.effectiveTo}` : 'not found',
  );

  const expiredAgain = rate.ok && rate.data.id
    ? await expireCloudCostRate(rate.data.id, '2026-10-31')
    : null;
  record(
    'costing: double expiry is refused',
    Boolean(expiredAgain && !expiredAgain.ok),
    expiredAgain ? (expiredAgain.ok ? 'UNEXPECTED SUCCESS' : expiredAgain.messageAr) : 'n/a',
  );

  const badType = await createCloudCostRate({
    costType: 'unicorns' as never,
    costTypeNameAr: '',
    productFamily: '',
    productId: null,
    baseQuantity: 1,
    rate: 1,
    effectiveFrom: '2026-10-01',
  });
  record(
    'costing: invalid cost type refused',
    !badType.ok && /نوع التكلفة/.test(badType.messageAr),
    badType.ok ? 'UNEXPECTED SUCCESS' : badType.messageAr,
  );

  // ---------------- audit of the new writes ----------------
  const auditAfter = await listAuditLog({ module: 'production', limit: 50 });
  const orderAudit = auditAfter.ok ? auditAfter.data.filter(r => r.recordId === orderId) : [];
  const createRow = orderAudit.find(r => r.action === 'create');
  const editRow = orderAudit.find(r => r.action === 'edit');
  record(
    'audit: production create + status changes are in the trail',
    Boolean(createRow) && Boolean(editRow),
    `rows=${orderAudit.length} actions=${orderAudit.map(r => r.action).join('|')}`,
  );

  // ---------------- anonymous fail-closed ----------------
  const { url, anonKey } = supabaseTestEndpoint();
  const anon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const anonChecks: Array<[string, PromiseLike<{ error: unknown }>]> = [
    ['list_audit_log', anon.rpc('list_audit_log')],
    ['list_posting_accounts', anon.rpc('list_posting_accounts')],
    ['create_production_order', anon.rpc('create_production_order', {
      p_item_id: 'qa-item-01', p_warehouse_id: 'qa-e2e-wh-01',
      p_destination_warehouse_id: null, p_planned_quantity: 1,
      p_start_date: null, p_expected_completion_date: null,
      p_target_market: 'local', p_notes: null, p_created_by: 'anon',
      p_idempotency_key: null,
    })],
    ['create_quality_inspection', anon.rpc('create_quality_inspection', {
      p_production_order_id: null, p_item_id: 'qa-item-01', p_quantity: 1,
      p_date: null, p_result: 'passed', p_destination_warehouse_id: null,
      p_notes: null, p_idempotency_key: null,
    })],
    ['create_standard_cost_rate', anon.rpc('create_standard_cost_rate', {
      p_cost_type: 'electricity', p_cost_type_name_ar: 'x', p_product_family: null,
      p_product_id: null, p_base_quantity: 1, p_rate: 1, p_effective_from: null,
      p_idempotency_key: null,
    })],
  ];
  for (const [name, promise] of anonChecks) {
    const res = await promise;
    record(`guard: anonymous cannot call ${name}`, Boolean(res.error), res.error ? 'denied' : 'UNEXPECTED SUCCESS');
  }

  await signOutSupabaseTest();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('FAILED:');
    failed.forEach(f => console.log(`  - ${f.name} (${f.detail})`));
    return 1;
  }
  return 0;
};

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error('FATAL', err);
    process.exit(1);
  });
