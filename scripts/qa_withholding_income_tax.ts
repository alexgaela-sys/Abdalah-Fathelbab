// QA: Withholding Income Tax at Source — 1% preview + documented withholding,
// customer settlement, dedicated asset account, return reversal and duplicate
// protection.
//
// SAFETY: this script must run in a SEPARATE NODE PROCESS. In Node there is no
// `localStorage`, so src/services/db.ts builds a pristine in-memory database from
// createEmptyDatabase() and never persists anything. The company's real data
// lives in the browser profile's localStorage and is unreachable from here. The
// guard below aborts if `localStorage` exists, so this can never write to it.
import { erpDb } from '../src/services/db';
import { WorkflowService } from '../src/services/workflows';
import { MasterDataService } from '../src/services/masterData';
import { InventoryEngine } from '../src/services/inventory';
import { ensureTestBom } from './qa_test_bom';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import InvoicePrint from '../src/components/modules/InvoicePrint';
import { SalesInvoiceDetails } from '../src/components/salesInvoiceDetails';
import { computeInvoiceNetDue } from '../src/services/companySettings';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const TODAY = new Date().toISOString().split('T')[0];
const PFX = `TEST-WH-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const ADMIN = { userId: 'usr-admin', userName: 'QA' };
const snap = () => erpDb.getSnapshot();
const money = (n: number | undefined | null) => Math.round((Number(n) || 0) * 100) / 100;
const gl = (code: string) => money(snap().accounts.find(a => a.code === code)?.currentBalance || 0);
const card = (customerId: string) => money(snap().customers.find(c => c.id === customerId)?.currentBalance || 0);
const adjustmentsFor = (invoiceId: string) => snap().withholdingAdjustments.filter(a => a.invoiceId === invoiceId);

type Status = 'PASS' | 'FAIL' | 'WARN';
const rows: Array<{ id: string; label: string; expected: string; actual: string; status: Status; note?: string }> = [];

function check(id: string, label: string, expected: number | string | boolean, actual: number | string | boolean, note?: string, tol = 0.01) {
  const pass = typeof expected === 'number' && typeof actual === 'number'
    ? Math.abs(expected - actual) <= tol
    : String(expected) === String(actual);
  rows.push({
    id, label,
    expected: typeof expected === 'number' ? expected.toFixed(2) : String(expected),
    actual: typeof actual === 'number' ? actual.toFixed(2) : String(actual),
    status: pass ? 'PASS' : 'FAIL',
    note,
  });
  return pass;
}

function warn(id: string, label: string, expected: string, actual: string, note?: string) {
  rows.push({ id, label, expected, actual, status: 'WARN', note });
}

function printTable() {
  console.log('\n\n==============================================================================================');
  console.log('📋 WITHHOLDING 1% — PASS / FAIL');
  console.log('==============================================================================================');
  console.log('| # | Status | Check | Expected | Actual | Note |');
  console.log('|---|--------|-------|----------|--------|------|');
  for (const r of rows) {
    const esc = (s: string) => String(s).replace(/\|/g, '/');
    console.log(`| ${r.id} | ${r.status} | ${esc(r.label)} | ${esc(r.expected)} | ${esc(r.actual)} | ${esc(r.note || '')} |`);
  }
  const pass = rows.filter(r => r.status === 'PASS').length;
  const fail = rows.filter(r => r.status === 'FAIL').length;
  const warnCount = rows.filter(r => r.status === 'WARN').length;
  console.log('==============================================================================================');
  console.log(`TOTAL: ${rows.length} checks — PASS ${pass} / FAIL ${fail} / WARN ${warnCount}`);
  console.log('==============================================================================================');
}

function fatal(id: string, label: string, note: string): never {
  rows.push({ id, label, expected: '-', actual: '-', status: 'FAIL', note });
  printTable();
  process.exit(1);
}

function jvTotals(sourceDocumentId: string) {
  const jv = snap().journalEntries.find(j => j.sourceDocumentId === sourceDocumentId);
  if (!jv) return undefined;
  return {
    jv,
    debit: money(jv.lines.reduce((s, l) => s + (l.debit || 0), 0)),
    credit: money(jv.lines.reduce((s, l) => s + (l.credit || 0), 0)),
    leg: (accountId: string) => money(jv.lines
      .filter(l => l.accountId === accountId)
      .reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0)),
  };
}

// ---- Isolation guard -----------------------------------------------------------------
if (typeof (globalThis as { localStorage?: unknown }).localStorage !== 'undefined') {
  console.error('❌ ABORT: localStorage exists in this process — refusing to run against a real store.');
  process.exit(2);
}
const fresh = snap();
if (fresh.salesInvoices.length !== 0 || fresh.payments.length !== 0 || fresh.customers.length !== 0) {
  console.error('❌ ABORT: the in-memory database is not pristine — refusing to run.');
  process.exit(2);
}
check('S0-1', 'Separate process, no localStorage, pristine store', 'isolated', 'isolated');
check('S0-2', 'Dedicated withholding asset account 1114 exists', true, snap().accounts.some(a => a.code === '1114'));
check('S0-3', 'Mapping no longer shares trade receivables 1105', 'acc-1114', snap().accountMappings.withholding_tax_receivable || '');
check('S0-4', 'Trade receivables 1105 is a separate asset', 'acc-1105', snap().accounts.find(a => a.code === '1105')?.id || '');

try {
  const sup = MasterDataService.createSupplier({ code: `${PFX}-SUP`, name: `مورد ${PFX}`, isTest: true, userId: 'usr-admin', userName: 'QA' })!.supplier!;
  const localCust = MasterDataService.createCustomer({ code: `${PFX}-LOC`, name: `عميل محلي ${PFX}`, customerType: 'retail', channel: 'retail', currency: 'EGP', isTest: true, userId: 'usr-admin', userName: 'QA' })!.customer!;
  const exportCust = MasterDataService.createCustomer({ code: `${PFX}-EXP`, name: `عميل تصدير ${PFX}`, customerType: 'export', channel: 'export', currency: 'USD', isTest: true, userId: 'usr-admin', userName: 'QA' })!.customer!;

  const fpLocal = snap().items.find(i => i.code === 'FP-SNG-01')!;
  const fpExport = snap().items.find(i => i.code === 'FP-DUO-01' && i.itemType === 'finished_product')!;
  ensureTestBom(fpLocal.id);

  const stock = (warehouseId: string, itemId: string, batch: string) => WorkflowService.createPurchaseInvoice({
    supplierId: sup.id, warehouseId, paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `${PFX}-STOCK-${warehouseId}`, date: TODAY,
    lines: [{ itemId, quantity: 2000, unitId: 'unit-piece', unitPrice: 40, batchNumber: batch, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (!stock('wh-local', fpLocal.id, `${PFX}-STKB`).success) fatal('S0-5', 'Local stock setup', 'purchase failed');
  if (!stock('wh-export', fpExport.id, `${PFX}-STKB-EXP`).success) fatal('S0-6', 'Export stock setup', 'purchase failed');
  check('S0-5', 'Test fixtures built', 'ok', 'ok');

  function invoice(subtotal: number, opts?: { paymentMethod?: 'cash' | 'credit'; customerId?: string; qty?: number; withholding?: boolean }) {
    const qty = opts?.qty ?? 10;
    const paymentMethod = opts?.paymentMethod ?? 'credit';
    return WorkflowService.createSalesInvoice({
      customerId: opts?.customerId ?? localCust.id, channel: 'retail', warehouseId: 'wh-local',
      paymentMethod,
      // F-WH-MANUAL: credit fixtures opt IN explicitly; cash fixtures stay off
      // (the service refuses the toggle for cash). No automatic eligibility.
      applyWithholding: opts?.withholding ?? (paymentMethod === 'credit'),
      currency: 'EGP', exchangeRate: 1, date: TODAY,
      lines: [{ itemId: fpLocal.id, quantity: qty, unitPrice: subtotal / qty, vatRate: 0.14 }],
      isTest: true, ...ADMIN,
    } as never);
  }

  function returnInvoice(invoiceId: string, quantity?: number) {
    const lines = snap().salesInvoiceLines.filter(l => l.invoiceId === invoiceId);
    return WorkflowService.postSalesReturn({
      customerId: localCust.id, invoiceId, warehouseId: 'wh-local', date: TODAY,
      reason: `${PFX} return`, isTest: true, ...ADMIN,
      lines: lines.map(l => ({
        itemId: l.itemId,
        quantity: quantity ?? l.quantity,
        unitPrice: l.unitPrice,
        vatRate: l.vatRate,
      })),
    } as never);
  }

  // =====================================================================================
  // S1 — Applicability
  // =====================================================================================
  const cashInv = invoice(10000, { paymentMethod: 'cash' });
  if (!cashInv.success) fatal('S1-0', 'Cash invoice', cashInv.error || 'failed');
  check('S1-1', 'Cash invoice has no withholding preview', 0, money(cashInv.invoice!.withholdingAmount));

  const expExempt = WorkflowService.createSalesInvoice({
    customerId: exportCust.id, channel: 'export', warehouseId: 'wh-export', paymentMethod: 'credit',
    currency: 'USD', exchangeRate: 48.5, date: TODAY,
    lines: [{ itemId: fpExport.id, quantity: 20, unitPrice: 10, vatRate: 0 }],
    taxTreatment: 'exempt', isTest: true, ...ADMIN,
  } as never);
  if (!expExempt.success) fatal('S1-2', 'Export invoice', expExempt.error || 'failed');
  check('S1-2', 'Export (USD/exempt) invoice has no withholding preview', 0, money(expExempt.invoice!.withholdingAmount));

  // =====================================================================================
  // S2 — Invoice 10,000: preview is informational only
  // =====================================================================================
  const arBeforeInvoice = gl('1105');
  const assetBeforeInvoice = gl('1114');
  const invRes = invoice(10000);
  if (!invRes.success) fatal('S2-0', 'Credit invoice', invRes.error || 'failed');
  const inv = invRes.invoice!;
  check('S2-1', 'Subtotal', 10000, money(inv.subtotal));
  check('S2-2', 'VAT 14%', 1400, money(inv.vatAmount));
  check('S2-3', 'Total', 11400, money(inv.totalAmount));
  check('S2-4', 'Preview = 1% of subtotal', 100, money(inv.withholdingAmount));
  check('S2-5', 'Preview does not create an asset', 0, money(gl('1114') - assetBeforeInvoice));
  check('S2-6', 'AR debit = full invoice total', 11400, money(gl('1105') - arBeforeInvoice));
  const invJv = jvTotals(inv.id);
  check('S2-7', 'Invoice journal balanced', invJv ? invJv.debit : -2, invJv ? invJv.credit : -1);
  check('S2-8', 'AR debit line on invoice', 11400, invJv ? invJv.leg('acc-1105') : -1);

  // =====================================================================================
  // S3 — Receipt: 9,900 cash + 100 documented withholding (linked to the invoice)
  // =====================================================================================
  const arBeforeReceipt = gl('1105');
  const assetBeforeReceipt = gl('1114');
  const cashBeforeReceipt = gl('1101');
  const cardBeforeReceipt = card(localCust.id);
  const receipt = WorkflowService.recordCustomerPayment({
    customerId: localCust.id, amount: 9900, currency: 'EGP', exchangeRate: 1, paymentMethod: 'cash',
    date: TODAY, reference: `${PFX}-RCPT1`,
    withholdingAmountEGP: 100, withholdingCertificateNo: `${PFX}-CERT-001`, withholdingDocumentDate: TODAY,
    withholdingInvoiceId: inv.id,
    ...ADMIN,
  });
  if (!receipt.success) fatal('S3-0', 'Receipt with documented withholding', receipt.error || 'failed');
  const payment = receipt.payment!;
  check('S3-1', 'Cash leg = 9,900', 9900, money(payment.amountEGP));
  check('S3-2', 'Documented withholding = 100', 100, money(payment.withholdingAmountEGP));
  check('S3-3', 'Receipt linked to the original invoice', inv.id, payment.withholdingInvoiceId || '');
  check('S3-4', 'Cash account +9,900', 9900, money(gl('1101') - cashBeforeReceipt));
  check('S3-5', 'Withholding asset 1114 +100', 100, money(gl('1114') - assetBeforeReceipt));
  check('S3-6', 'Trade receivables 1105 only settles 10,000', -10000, money(gl('1105') - arBeforeReceipt),
    'the asset is NOT mixed into 1105');
  check('S3-7', 'Customer balance reduced by cash + documented withholding', -10000, money(card(localCust.id) - cardBeforeReceipt));
  check('S3-8', 'Customer balance after settlement = 1,400 (VAT only)', 1400, card(localCust.id));
  const payJv = jvTotals(payment.id);
  check('S3-9', 'Receipt journal balanced (debits)', 10000, payJv ? payJv.debit : -1);
  check('S3-10', 'Receipt journal credit = 10,000', 10000, payJv ? payJv.credit : -1);
  check('S3-11', 'Withholding leg posted to 1114', 100, payJv ? payJv.leg('acc-1114') : -1);
  check('S3-12', 'No asset leg posted to 1105', 0, payJv ? payJv.leg('acc-1105') + 10000 : -1,
    '1105 carries only the 10,000 receivable settlement');

  // =====================================================================================
  // S3b — Duplicate submission / re-sent request
  // =====================================================================================
  const entriesBeforeDup = snap().journalEntries.length;
  const arBeforeDup = gl('1105');
  const assetBeforeDup = gl('1114');
  const cardBeforeDup = card(localCust.id);
  const duplicateExact = WorkflowService.recordCustomerPayment({
    customerId: localCust.id, amount: 9900, currency: 'EGP', exchangeRate: 1, paymentMethod: 'cash',
    date: TODAY, reference: `${PFX}-RCPT1`,
    withholdingAmountEGP: 100, withholdingCertificateNo: `${PFX}-CERT-001`, withholdingDocumentDate: TODAY,
    withholdingInvoiceId: inv.id, ...ADMIN,
  });
  check('S4-1', 'Exact re-sent receipt rejected', false, duplicateExact.success);
  check('S4-2', 'Duplicate did not post a journal', entriesBeforeDup, snap().journalEntries.length);
  check('S4-3', 'Duplicate did not move receivables', 0, money(gl('1105') - arBeforeDup));
  check('S4-4', 'Duplicate did not move the withholding asset', 0, money(gl('1114') - assetBeforeDup));
  check('S4-5', 'Duplicate did not move the customer balance', 0, money(card(localCust.id) - cardBeforeDup));

  const duplicateCert = WorkflowService.recordCustomerPayment({
    customerId: localCust.id, amount: 500, currency: 'EGP', exchangeRate: 1, paymentMethod: 'cash',
    date: TODAY, reference: `${PFX}-RCPT1-B`,
    withholdingAmountEGP: 5, withholdingCertificateNo: `${PFX}-CERT-001`, withholdingDocumentDate: TODAY,
    ...ADMIN,
  });
  check('S4-6', 'Same certificate under another reference rejected', false, duplicateCert.success);
  check('S4-7', 'Rejection names the duplicate certificate', true, String(duplicateCert.error || '').includes('شهادة'));

  // =====================================================================================
  // S5 — Partial settlement of a second invoice (5,000 → 5,700)
  // =====================================================================================
  const arBeforePart = gl('1105');
  const partRes = invoice(5000);
  if (!partRes.success) fatal('S5-0', 'Partial invoice', partRes.error || 'failed');
  const partInv = partRes.invoice!;
  const assetBeforePart = gl('1114');
  check('S5-1', 'Partial invoice total', 5700, money(partInv.totalAmount));
  check('S5-2', 'Partial invoice preview (1% of 5,000)', 50, money(partInv.withholdingAmount));

  const partPayRes = WorkflowService.recordCustomerPayment({
    customerId: localCust.id, amount: 2475, currency: 'EGP', exchangeRate: 1, paymentMethod: 'bank',
    bankAccountId: 'bank-1', date: TODAY, reference: `${PFX}-RCPT2`,
    withholdingAmountEGP: 25, withholdingCertificateNo: `${PFX}-CERT-002`, withholdingDocumentDate: TODAY,
    withholdingInvoiceId: partInv.id, ...ADMIN,
  });
  if (!partPayRes.success) fatal('S5-3', 'Partial receipt', partPayRes.error || 'failed');
  check('S5-3', 'Partial cash leg', 2475, money(partPayRes.payment!.amountEGP));
  check('S5-4', 'Partial documented withholding linked', partInv.id, partPayRes.payment!.withholdingInvoiceId || '');
  check('S5-5', 'Receivable movement = invoice − full settlement', 3200, money(gl('1105') - arBeforePart));
  check('S5-6', 'Asset 1114 +25', 25, money(gl('1114') - assetBeforePart));
  check('S5-7', 'Customer balance after partial settlement', 4600, card(localCust.id));

  // =====================================================================================
  // S6 — Partial return: reverse only the attributable withholding
  // =====================================================================================
  const adjBeforePartial = adjustmentsFor(partInv.id).length;
  const assetBeforePartialReturn = gl('1114');
  const arBeforePartialReturn = gl('1105');
  const cardBeforePartialReturn = card(localCust.id);
  const partialReturn = returnInvoice(partInv.id, 5);
  check('S6-1', 'Partial return posted', true, partialReturn.success, partialReturn.error);
  if (partialReturn.success) {
    const expectedReversal = 25; // 50 × (2,500 / 5,000)
    check('S6-2', 'Return records the reversed withholding', expectedReversal, money(partialReturn.salesReturn!.withholdingReversedAmountEGP));
    check('S6-3', 'One withholding adjustment document created', adjBeforePartial + 1, adjustmentsFor(partInv.id).length);
    const adj = adjustmentsFor(partInv.id).slice(-1)[0];
    check('S6-4', 'Adjustment amount = pro-rated withholding', expectedReversal, money(adj?.amountEGP));
    check('S6-5', 'Adjustment linked to the receipt', partPayRes.payment!.id, adj?.paymentId || '');
    check('S6-6', 'Adjustment linked to the return', partialReturn.salesReturn!.id, adj?.salesReturnId || '');
    check('S6-7', 'Withholding asset reduced (not left on 1105)', -expectedReversal, money(gl('1114') - assetBeforePartialReturn));
    check('S6-8', 'Receivable delta = return total − withholding reversal', -2825, money(gl('1105') - arBeforePartialReturn));
    check('S6-9', 'Customer balance follows the same single movement', -2825, money(card(localCust.id) - cardBeforePartialReturn));
    check('S6-10', 'Customer balance after partial return', 1775, card(localCust.id));
    check('S6-11', 'Receipt tracks its reversed amount', 25, money(snap().payments.find(p => p.id === partPayRes.payment!.id)?.withholdingReversedAmountEGP));
    const adjJv = adj ? jvTotals(adj.id) : undefined;
    check('S6-12', 'Adjustment journal balanced', adjJv ? adjJv.debit : -2, adjJv ? adjJv.credit : -1);
    check('S6-13', 'Adjustment debits the customer receivable', expectedReversal, adjJv ? adjJv.leg('acc-1105') : -1);
    check('S6-14', 'Adjustment credits the withholding asset 1114', -expectedReversal, adjJv ? adjJv.leg('acc-1114') : -1);
    check('S6-15', 'Revenue reversal in the return = returned net', 2500, money(partialReturn.salesReturn!.totalAmount - partialReturn.salesReturn!.totalVat));
    check('S6-16', 'VAT reversal in the return = 350', 350, money(partialReturn.salesReturn!.totalVat));
  }

  // Remaining 5 units: attributable withholding 25 but NOTHING documented remains → no reversal.
  const adjBeforeRest = adjustmentsFor(partInv.id).length;
  const assetBeforeRest = gl('1114');
  const restReturn = returnInvoice(partInv.id, 5);
  check('S6-17', 'Second (remaining) return posted', true, restReturn.success, restReturn.error);
  if (restReturn.success) {
    check('S6-18', 'No second reversal when nothing documented remains', adjBeforeRest, adjustmentsFor(partInv.id).length);
    check('S6-19', 'Withholding asset unchanged on the second return', 0, money(gl('1114') - assetBeforeRest));
    check('S6-20', 'No withholding reversal recorded on the return', 0, money(restReturn.salesReturn!.withholdingReversedAmountEGP));
  }

  // =====================================================================================
  // S7 — Full return of the first invoice reverses the full documented withholding
  // =====================================================================================
  const arBeforeFull = gl('1105');
  const assetBeforeFull = gl('1114');
  const cardBeforeFull = card(localCust.id);
  const fullReturn = returnInvoice(inv.id);
  check('S7-1', 'Full return posted', true, fullReturn.success, fullReturn.error);
  if (fullReturn.success) {
    check('S7-2', 'Full return reverses the remaining 100', 100, money(fullReturn.salesReturn!.withholdingReversedAmountEGP));
    check('S7-3', 'Asset 1114 reduced by 100', -100, money(gl('1114') - assetBeforeFull));
    check('S7-4', 'Receivable delta = −11,400 return + 100 reversal', -11300, money(gl('1105') - arBeforeFull));
    check('S7-5', 'Customer balance delta matches the GL', -11300, money(card(localCust.id) - cardBeforeFull));
    check('S7-6', 'Receipt fully reversed (100 of 100)', 100, money(snap().payments.find(p => p.id === payment.id)?.withholdingReversedAmountEGP));
    const adj = adjustmentsFor(inv.id).slice(-1)[0];
    check('S7-7', 'Second adjustment document created', 100, money(adj?.amountEGP));
  }

  const adjBeforeDouble = adjustmentsFor(inv.id).length;
  const assetBeforeDouble = gl('1114');
  const doubleReturn = returnInvoice(inv.id);
  check('S7-8', 'Returning the same invoice again is blocked', false, doubleReturn.success);
  check('S7-9', 'Blocked return created no adjustment', adjBeforeDouble, adjustmentsFor(inv.id).length);
  check('S7-10', 'Blocked return left the asset untouched', 0, money(gl('1114') - assetBeforeDouble));

  // =====================================================================================
  // S8 — No documented withholding → no reversal
  // =====================================================================================
  const noWhRes = invoice(2000);
  if (!noWhRes.success) fatal('S8-0', 'No-withholding invoice', noWhRes.error || 'failed');
  const noWhInv = noWhRes.invoice!;
  check('S8-1', 'Invoice preview exists (20) but nothing documented yet', 20, money(noWhInv.withholdingAmount));
  const assetBeforeS8 = gl('1114');
  const adjBeforeS8 = adjustmentsFor(noWhInv.id).length;
  const noWhReturn = returnInvoice(noWhInv.id);
  check('S8-2', 'Return of an unsettled invoice posted', true, noWhReturn.success, noWhReturn.error);
  check('S8-3', 'No reversal without a documented receipt', 0, money(noWhReturn.salesReturn?.withholdingReversedAmountEGP));
  check('S8-4', 'No adjustment document', adjBeforeS8, adjustmentsFor(noWhInv.id).length);
  check('S8-5', 'Asset unchanged', 0, money(gl('1114') - assetBeforeS8));

  // =====================================================================================
  // S9 — Legacy/unlinked documented withholding → no automatic reversal (documented)
  // =====================================================================================
  const legacyRes = invoice(3000);
  if (!legacyRes.success) fatal('S9-0', 'Legacy invoice', legacyRes.error || 'failed');
  const legacyInv = legacyRes.invoice!;
  const legacyPayRes = WorkflowService.recordCustomerPayment({
    customerId: localCust.id, amount: 2970, currency: 'EGP', exchangeRate: 1, paymentMethod: 'cash',
    date: TODAY, reference: `${PFX}-RCPT3`,
    withholdingAmountEGP: 30, withholdingCertificateNo: `${PFX}-CERT-003`, withholdingDocumentDate: TODAY,
    withholdingInvoiceId: legacyInv.id, ...ADMIN,
  });
  if (!legacyPayRes.success) fatal('S9-1', 'Legacy receipt', legacyPayRes.error || 'failed');
  // Simulate a receipt recorded before invoice linkage existed.
  erpDb.mutate(draft => {
    const p = draft.payments.find(x => x.id === legacyPayRes.payment!.id);
    if (p) p.withholdingInvoiceId = undefined;
  });
  const assetBeforeLegacy = gl('1114');
  const legacyReturn = returnInvoice(legacyInv.id);
  check('S9-2', 'Unlinked legacy receipt is not guessed', 0, money(legacyReturn.salesReturn?.withholdingReversedAmountEGP));
  check('S9-3', 'Asset unchanged for unlinked legacy withholding', 0, money(gl('1114') - assetBeforeLegacy));
  warn('S9-4', 'Legacy receipts without invoice linkage require a manual settlement document', 'documented behavior', 'no auto reversal');

  // =====================================================================================
  // S10 — Different valid documents are still accepted (amount is not a dedupe key)
  // =====================================================================================
  const otherAmount = WorkflowService.recordCustomerPayment({
    customerId: localCust.id, amount: 2475, currency: 'EGP', exchangeRate: 1, paymentMethod: 'cash',
    date: TODAY, reference: `${PFX}-RCPT4`, ...ADMIN,
  });
  check('S10-1', 'A new receipt with the same amount but a new reference is accepted', true, otherAmount.success, otherAmount.error);
  const differentCert = WorkflowService.recordCustomerPayment({
    customerId: localCust.id, amount: 100, currency: 'EGP', exchangeRate: 1, paymentMethod: 'cash',
    date: TODAY, reference: `${PFX}-RCPT5`,
    withholdingAmountEGP: 1, withholdingCertificateNo: `${PFX}-CERT-004`, withholdingDocumentDate: TODAY,
    ...ADMIN,
  });
  check('S10-2', 'Different certificate (even with a similar amount) is accepted', true, differentCert.success, differentCert.error);

  // =====================================================================================
  // S11 — Reconciliation & untouched VAT
  // =====================================================================================
  const ar = gl('1105');
  const customerCard = card(localCust.id);
  const asset = gl('1114');
  const documentedOpen = money(snap().payments
    .filter(p => p.paymentType === 'customer_receipt' && p.partyId === localCust.id)
    .reduce((s, p) => s + (Number(p.withholdingAmountEGP) || 0) - (Number(p.withholdingReversedAmountEGP) || 0), 0));
  check('S11-1', 'Customer subledger equals the trade receivable GL', ar, customerCard);
  check('S11-2', 'Withholding asset equals open documented withholding', documentedOpen, asset,
    'includes the legacy unlinked 30');
  const assetLedgerNet = money(snap().journalEntries
    .flatMap(j => j.lines)
    .filter(l => l.accountId === 'acc-1114')
    .reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0));
  check('S11-3', 'Withholding asset ledger equals the asset account balance', asset, assetLedgerNet);

  const vatInv = invoice(3000);
  if (!vatInv.success) fatal('S11-4', 'VAT invoice', vatInv.error || 'failed');
  check('S11-4', 'VAT still 14%', 420, money(vatInv.invoice!.vatAmount));
  check('S11-5', 'Total still includes full VAT', 3420, money(vatInv.invoice!.totalAmount));
  check('S11-6', 'Inventory still tracked', 1, InventoryEngine.getItemBalance(fpLocal.id, 'wh-local') > 0 ? 1 : 0);

  // =====================================================================================
  // S12 — DISPLAY: the same rate/base/amount must appear on the SAVED invoice
  // screen and on the preview/print document (not only while creating).
  // =====================================================================================
  const htmlText = (markup: string) => markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ');
  const detailsHtml = (invoiceId: string) => htmlText(renderToStaticMarkup(
    React.createElement(SalesInvoiceDetails, { invoiceId }),
  ));
  const printHtml = (invoiceId: string) => htmlText(renderToStaticMarkup(
    React.createElement(InvoicePrint, { invoiceId, onClose: () => {} }),
  ));

  const displayRes = invoice(10000);
  if (!displayRes.success) fatal('S12-0', 'Display invoice', displayRes.error || 'failed');
  // Re-read from the store: this is the persisted document, not form state.
  const saved = snap().salesInvoices.find(i => i.id === displayRes.invoice!.id)!;
  check('S12-1', 'Saved invoice keeps the 1% rate', 0.01, Number(saved.withholdingRate));
  check('S12-2', 'Saved invoice keeps 100 = 1% of the pre-VAT base', 100, money(saved.withholdingAmount));
  check('S12-3', 'Saved base before VAT = 10,000', 10000, money(saved.subtotal));
  check('S12-4', 'VAT unchanged by the withholding preview', 1400, money(saved.vatAmount));
  check('S12-5', 'Withholding is NOT added into the invoice total', 11400, money(saved.totalAmount));

  const dHtml = detailsHtml(saved.id);
  check('S12-6', 'Saved-invoice screen shows the withholding block', true, dHtml.includes('خصم تحت حساب ضريبة الدخل'));
  check('S12-7', 'Saved-invoice screen shows the 1.00% rate', true, dHtml.includes('1.00%'));
  check('S12-8', 'Saved-invoice screen shows the pre-VAT base', true, dHtml.includes('وعاء الحساب قبل ض.ق.م: 10,000.00 EGP'));
  check('S12-9', 'Saved-invoice screen shows the deduction amount', true, dHtml.includes('قيمة الخصم: 100.00 EGP'));
  check('S12-10', 'Saved-invoice screen still shows VAT 1,400.00', true, dHtml.includes('1,400.00'));
  check('S12-11', 'Saved-invoice screen still shows total 11,400.00', true, dHtml.includes('11,400.00'));

  const pHtml = printHtml(saved.id);
  check('S12-12', 'Preview/print shows the 1.00% rate', true, pHtml.includes('1.00%'));
  check('S12-13', 'Preview/print shows the pre-VAT base', true, pHtml.includes('وعاء الحساب قبل ض.ق.م: 10,000.00 EGP'));
  check('S12-14', 'Preview/print shows the deduction amount', true, pHtml.includes('قيمة الخصم: 100.00 EGP'));
  check('S12-15', 'Preview/print keeps VAT at 14% / 1,400.00', true, pHtml.includes('ضريبة القيمة المضافة (14%)') && pHtml.includes('1,400.00'));
  check('S12-16', 'Preview/print total excludes the withholding', true, pHtml.includes('11,400.00'));

  // Ineligible: CASH domestic retail invoice.
  const cashSaved = snap().salesInvoices.find(i => i.id === cashInv.invoice!.id)!;
  const cashDetails = detailsHtml(cashSaved.id);
  const cashPrint = printHtml(cashSaved.id);
  check('S12-17', 'Cash (ineligible) saved screen: no withholding block', false, cashDetails.includes('خصم تحت حساب ضريبة الدخل'));
  check('S12-18', 'Cash (ineligible) preview/print: no withholding rate/base', false,
    cashPrint.includes('خصم تحت حساب ضريبة الدخل') || cashPrint.includes('وعاء الحساب قبل ض.ق.م'));
  check('S12-19', 'Cash (ineligible): VAT 1,400 and total 11,400 unchanged', true,
    cashPrint.includes('1,400.00') && cashPrint.includes('11,400.00'));
  check('S12-20', 'Cash (ineligible) stores zero withholding', 0, money(cashSaved.withholdingAmount));

  // Ineligible: EXPORT (USD) invoice.
  const expSaved = snap().salesInvoices.find(i => i.id === expExempt.invoice!.id)!;
  const expDetails = detailsHtml(expSaved.id);
  const expPrint = printHtml(expSaved.id);
  check('S12-21', 'Export (ineligible) saved screen: no withholding block', false, expDetails.includes('خصم تحت حساب ضريبة الدخل'));
  check('S12-22', 'Export (ineligible) preview/print: no withholding rate/base', false,
    expPrint.includes('خصم تحت حساب ضريبة الدخل') || expPrint.includes('وعاء الحساب قبل ض.ق.م'));
  check('S12-23', 'Export (ineligible) stores zero withholding', 0, money(expSaved.withholdingAmount));

  // Sales totals: across every test invoice, total = subtotal + VAT exactly.
  const totals = snap().salesInvoices;
  const sumTotal = money(totals.reduce((s, i) => s + (Number(i.totalAmount) || 0), 0));
  const sumBaseVat = money(totals.reduce((s, i) => s + (Number(i.subtotal) || 0) + (Number(i.vatAmount) || 0), 0));
  check('S12-24', 'Sales totals never include withholding (Σtotal = Σsubtotal + ΣVAT)', sumBaseVat, sumTotal);

  // =====================================================================================
  // S13 — MANUAL TOGGLE: opt-in only; the old automatic eligibility is gone.
  // =====================================================================================
  const noFlagRes = invoice(10000, { withholding: false });
  if (!noFlagRes.success) fatal('S13-0', 'Credit invoice without the toggle', noFlagRes.error || 'failed');
  const noFlagInv = noFlagRes.invoice!;
  check('S13-1', 'Credit EGP retail invoice WITHOUT the toggle has NO withholding', 0, money(noFlagInv.withholdingAmount));
  check('S13-2', 'Stored choice is off', false, Boolean(noFlagInv.withholdingEnabled));
  check('S13-3', 'Auto-eligibility removed (same invoice used to preview 100)', 0, money(noFlagInv.withholdingAmount),
    'regression against the old local+credit+retail rule');
  const noFlagDetails = detailsHtml(noFlagInv.id);
  const noFlagPrint = printHtml(noFlagInv.id);
  check('S13-4', 'Saved screen of the untoggled invoice shows no withholding block', false,
    noFlagDetails.includes('خصم تحت حساب ضريبة الدخل'));
  check('S13-5', 'Print of the untoggled invoice shows no withholding rate/base/amount', false,
    noFlagPrint.includes('خصم تحت حساب ضريبة الدخل') || noFlagPrint.includes('وعاء الحساب قبل ض.ق.م'));

  const cashWithFlag = WorkflowService.createSalesInvoice({
    customerId: localCust.id, channel: 'retail', warehouseId: 'wh-local', paymentMethod: 'cash',
    currency: 'EGP', exchangeRate: 1, date: TODAY,
    lines: [{ itemId: fpLocal.id, quantity: 1, unitPrice: 100, vatRate: 0.14 }],
    applyWithholding: true, isTest: true, ...ADMIN,
  } as never);
  check('S13-6', 'Toggle + CASH invoice is refused', false, cashWithFlag.success);
  check('S13-7', 'Refusal names the credit-invoice rule', true, String(cashWithFlag.error || '').includes('آجلة'));

  const exportWithFlag = WorkflowService.createSalesInvoice({
    customerId: exportCust.id, channel: 'export', warehouseId: 'wh-export', paymentMethod: 'credit',
    currency: 'USD', exchangeRate: 48.5, date: TODAY,
    lines: [{ itemId: fpExport.id, quantity: 5, unitPrice: 10, vatRate: 0 }],
    taxTreatment: 'exempt', applyWithholding: true, isTest: true, ...ADMIN,
  } as never);
  check('S13-8', 'Toggle + EXPORT/USD invoice is refused', false, exportWithFlag.success);
  check('S13-9', 'Refusal names the export/currency rules', true,
    String(exportWithFlag.error || '').includes('تصدير') && String(exportWithFlag.error || '').includes('جنيه'));

  const exemptWithFlag = WorkflowService.createSalesInvoice({
    customerId: localCust.id, channel: 'retail', warehouseId: 'wh-local', paymentMethod: 'credit',
    currency: 'EGP', exchangeRate: 1, date: TODAY,
    lines: [{ itemId: fpLocal.id, quantity: 1, unitPrice: 100, vatRate: 0 }],
    taxTreatment: 'exempt', applyWithholding: true, isTest: true, ...ADMIN,
  } as never);
  check('S13-10', 'Toggle + EXEMPT invoice is refused', false, exemptWithFlag.success);
  check('S13-11', 'Refusal names the exempt rule', true, String(exemptWithFlag.error || '').includes('المعفاة'));

  // The opted-in invoice (created in S12) keeps the full 5-figure contract.
  const onInv = snap().salesInvoices.find(i => i.id === displayRes.invoice!.id)!;
  check('S13-12', 'Toggle stores the choice on the invoice', true, Boolean(onInv.withholdingEnabled));
  check('S13-13', 'Toggle stores the pre-VAT base', 10000, money(onInv.withholdingBase));
  check('S13-14', 'Rate stored as 1%', 0.01, Number(onInv.withholdingRate));
  check('S13-15', 'Amount = 1% of the pre-VAT base', 100, money(onInv.withholdingAmount));
  check('S13-16', 'Sales pre-VAT / VAT / total unchanged (10,000 + 1,400 = 11,400)', '10000.00/1400.00/11400.00',
    `${money(onInv.subtotal).toFixed(2)}/${money(onInv.vatAmount).toFixed(2)}/${money(onInv.totalAmount).toFixed(2)}`);
  check('S13-17', 'Net due after deduction = 11,300', 11300,
    computeInvoiceNetDue(Number(onInv.totalAmount), Number(onInv.withholdingAmount)));
  const onPrint = printHtml(onInv.id);
  check('S13-18', 'Print shows 10,000 / 1,400 / 11,400 / 100 / 11,300', true,
    ['10,000.00', '1,400.00', '11,400.00', '100.00', '11,300.00'].every(v => onPrint.includes(v)));
  const onDetails = detailsHtml(onInv.id);
  check('S13-19', 'Saved screen shows base, rate, amount and the untouched total', true,
    onDetails.includes('وعاء الحساب قبل ض.ق.م: 10,000.00 EGP')
      && onDetails.includes('1.00%')
      && onDetails.includes('قيمة الخصم: 100.00 EGP')
      && onDetails.includes('11,400.00'));

  // ---- UI wiring: the checkbox the user ticks must be what reaches the
  // service (the service-level checks above would pass even without it).
  const salesViewSrc = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../src/components/modules/SalesView.tsx'),
    'utf8',
  );
  check('S13-20', 'Create screen shows the explicit toggle label', true,
    salesViewSrc.includes('تطبيق خصم تحت حساب ضريبة الدخل 1%'));
  check('S13-21', 'Toggle defaults to OFF and resets after save', true,
    salesViewSrc.includes('useState(false)') && salesViewSrc.includes('setApplyWithholding(false)'));
  check('S13-22', 'Toggle is passed into createSalesInvoice', true,
    /createSalesInvoice\(\{[\s\S]*?applyWithholding,/.test(salesViewSrc));

  printTable();
  console.log('\n⚠️  UNCONFIRMED TAX ASSUMPTIONS (not validated legally by this test):');
  console.log('   1. 1% of the invoice SUBTOTAL before VAT — implementation policy only.');
  console.log('   2. Applied only on EXPLICIT user opt-in per invoice; service boundaries are');
  console.log('      credit + EGP + non-export + non-exempt — ticking the box does NOT prove');
  console.log('      the transaction is legally subject to withholding (accountant sign-off needed).');
  console.log('   3. The reversal debits the customer because the withheld amount is the customer\'s tax credit;');
  console.log('      this treatment needs a tax accountant decision (credit note vs. independent settlement).');
  console.log('   4. Unlinked legacy withholding is never guessed: it needs a manual settlement document.');

  process.exit(rows.some(r => r.status === 'FAIL') ? 1 : 0);
} catch (err) {
  console.error('\n❌ FATAL ERROR:', (err as Error).message);
  rows.push({ id: 'FATAL', label: 'Unhandled failure', expected: '-', actual: '-', status: 'FAIL', note: (err as Error).message });
  printTable();
  process.exit(1);
}
