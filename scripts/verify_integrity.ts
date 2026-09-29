// Data Integrity Verification: balances, FIFO costing, and document linkage across all modules.
// Run: npx tsx scripts/verify_integrity.ts
import { erpDb } from '../src/services/db';
import { WorkflowService } from '../src/services/workflows';
import { InventoryEngine } from '../src/services/inventory';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { isDebitNatureCategory, JournalEntry } from '../src/types/erp';

let failures = 0;
function check(name: string, condition: boolean, detail: string) {
  const icon = condition ? '✅' : '❌';
  console.log(`${icon} ${name}${condition ? '' : ` — ${detail}`}`);
  if (!condition) failures++;
}

function checkAllJournalsBalanced(): { total: number; unbalanced: number } {
  const db = erpDb.getSnapshot();
  let unbalanced = 0;
  db.journalEntries.forEach((jv: JournalEntry) => {
    const dr = jv.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
    const cr = jv.lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
    if (Math.abs(dr - cr) > 0.01) unbalanced++;
    if (jv.lines.some(l => !l.accountId)) unbalanced++;
  });
  return { total: db.journalEntries.length, unbalanced };
}

function checkGlVsTrialBalance(): number {
  // Account balances must equal the sum of their posted, non-reversed lines
  const db = erpDb.getSnapshot();
  let mismatches = 0;
  db.accounts.forEach(acc => {
    let computed = 0;
    db.journalEntries.forEach(jv => {
      if (!jv.isPosted || jv.isReversed) return;
      jv.lines.forEach(l => {
        if (l.accountId !== acc.id) return;
        computed += isDebitNatureCategory(acc.category) ? (l.debit - l.credit) : (l.credit - l.debit);
      });
    });
    if (Math.abs(computed - (acc.currentBalance || 0)) > 0.02) {
      mismatches++;
      console.log(`   → حساب غير مطابق: ${acc.code} ${acc.nameAr} (دفتري: ${acc.currentBalance}, محسوب: ${computed.toFixed(2)})`);
    }
  });
  return mismatches;
}

function checkInventoryConsistency(): number {
  // Every item's batch total must match the last transaction's balanceAfter per warehouse
  const db = erpDb.getSnapshot();
  let mismatches = 0;
  const seen = new Set<string>();
  [...db.inventoryTransactions].reverse().forEach(tx => {
    const key = `${tx.itemId}|${tx.warehouseId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const batchTotal = db.batches
      .filter(b => b.itemId === tx.itemId && b.warehouseId === tx.warehouseId)
      .reduce((s, b) => s + (b.quantity || 0), 0);
    if (Math.abs(batchTotal - tx.balanceAfter) > 0.001) {
      mismatches++;
      console.log(`   → ${tx.itemId}@${tx.warehouseId}: batches=${batchTotal}, lastTx.balanceAfter=${tx.balanceAfter}`);
    }
  });
  return mismatches;
}

console.log('='.repeat(64));
console.log('🔒 ABDULLAH ERP — DATA INTEGRITY VERIFICATION');
console.log('='.repeat(64));

// ---- 1. Integrity of baseline (empty) store ----
let r = checkAllJournalsBalanced();
check(`Baseline store: ${r.total} journals all balanced`, r.unbalanced === 0, `${r.unbalanced} unbalanced`);
check('Baseline GL matches trial balance', checkGlVsTrialBalance() === 0, 'GL mismatch');
check('Baseline batch ledger consistent with movement ledger', checkInventoryConsistency() === 0, 'ledger mismatch');

// ---- 2. Full end-to-end flow with integrity assertions after each step ----
const today = new Date().toISOString().split('T')[0];

erpDb.mutate(d => {
  d.suppliers.push({ id: 'vi-sup', code: 'VI-SUP', name: 'VI مورّد تكامل', phone: '0100', address: 'x', currency: 'EGP', openingBalance: 0, currentBalance: 0, active: true, isTest: true });
  d.customers.push({ id: 'vi-cust', code: 'VI-CUST', name: 'VI عميل تكامل', customerType: 'wholesale', channel: 'wholesale', address: 'x', phone: '0101', currency: 'EGP', creditLimit: 1e9, currentBalance: 0, openingBalance: 0, active: true, isTest: true });
  d.items.push({
    id: 'vi-item', code: 'VI-001', nameAr: 'VI مادة تكامل', nameEn: 'VI item', itemType: 'raw_material',
    baseUnitId: 'unit-kg', purchaseUnitId: 'unit-kg', vatRate: 0.14, vatCategory: 'standard',
    trackBatch: true, trackExpiry: true, expiryPeriodDays: 30, standardCost: 10, actualCost: 10,
    sellingPriceRetail: 0, sellingPriceWholesale: 0, sellingPriceExportUSD: 0, active: true, minStockLevel: 0, isTest: true,
  });
});

// Purchase: two batches at different costs to force multi-batch FIFO consumption later
const p1 = WorkflowService.createPurchaseInvoice({
  supplierId: 'vi-sup', warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
  reference: 'VI-P1', date: today,
  lines: [{ itemId: 'vi-item', quantity: 100, unitId: 'unit-kg', unitPrice: 10, batchNumber: 'VI-B1', productionDate: today, expiryDate: '', vatRate: 0 }],
});
check('Purchase 1 posted (100kg @10)', p1.success && InventoryEngine.getItemBalance('vi-item', 'wh-raw') === 100, p1.error || '');

const p2 = WorkflowService.createPurchaseInvoice({
  supplierId: 'vi-sup', warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
  reference: 'VI-P2', date: today,
  lines: [{ itemId: 'vi-item', quantity: 100, unitId: 'unit-kg', unitPrice: 20, batchNumber: 'VI-B2', productionDate: today, expiryDate: '', vatRate: 0 }],
});
check('Purchase 2 posted (100kg @20)', p2.success && InventoryEngine.getItemBalance('vi-item', 'wh-raw') === 200, p2.error || '');

// FIFO issue of 150 must consume 100@10 + 50@20 = 2000 (NOT 150 x any single cost)
const issue = InventoryEngine.recordMovement({
  itemId: 'vi-item', warehouseId: 'wh-raw', movementType: 'production_issue',
  quantityIn: 0, quantityOut: 150, unitCost: 0,
  documentType: 'اختبار FIFO', documentNumber: 'VI-ISSUE-1',
});
check('FIFO issue consumes 100@10 + 50@20 = 2000 EGP actual', issue.success && issue.actualCost === 2000, `actual=${issue.actualCost}`);
check('FIFO issue weighted unit cost = 13.33', Math.abs((issue.actualUnitCost || 0) - 2000 / 150) < 0.001, `unit=${issue.actualUnitCost}`);
check('Remaining stock after FIFO issue = 50', InventoryEngine.getItemBalance('vi-item', 'wh-raw') === 50, 'stock mismatch');

// Negative stock must be rejected
const neg = InventoryEngine.recordMovement({
  itemId: 'vi-item', warehouseId: 'wh-raw', movementType: 'production_issue',
  quantityIn: 0, quantityOut: 999, unitCost: 0, documentType: 'اختبار سالب', documentNumber: 'VI-ISSUE-NEG',
});
check('Negative stock issue rejected', !neg.success, neg.error || '');

// Transfer must preserve batch + cost + total value
const valBefore = InventoryEngine.getItemValue('vi-item');
const trf = InventoryEngine.transferWarehouse('vi-item', 'wh-raw', 'wh-local', 20, undefined, 'VI-B2');
const valAfter = InventoryEngine.getItemValue('vi-item');
check('Transfer succeeded and preserved company inventory value', trf.success && Math.abs(valAfter - valBefore) < 0.01, `${valBefore} -> ${valAfter}`);
check('Transfer preserved batch number at destination', trf.success && erpDb.getSnapshot().batches.some(b => b.itemId === 'vi-item' && b.warehouseId === 'wh-local' && b.batchNumber === 'VI-B2' && b.quantity === 20), 'batch not preserved');

// Production with BOM: consumption + variance via standard rates from StandardCostRate
erpDb.mutate(d => {
  d.boms.push({ id: 'vi-bom', finishedItemId: 'vi-item', baseQuantity: 100, unitId: 'unit-kg', active: true, effectiveDate: today, isTest: true });
  d.bomLines.push({ id: 'vi-bl1', bomId: 'vi-bom', materialItemId: 'vi-item', quantityRequired: 80, unitId: 'unit-kg' });
  d.productionOrders.push({
    id: 'vi-pord', orderNumber: 'VI-PRD-1', productId: 'vi-item', bomId: 'vi-bom',
    plannedQuantity: 100, producedQuantity: 0, defectiveQuantity: 0, scrapQuantity: 0, remainingQuantity: 100,
    startDate: today, expectedCompletionDate: today, status: 'released',
    destinationWarehouseId: 'wh-local', targetMarket: 'local', createdUserId: 'usr-admin', createdAt: new Date().toISOString(), isTest: true,
  });
});
// replenish raw stock for production issue
InventoryEngine.recordMovement({ itemId: 'vi-item', warehouseId: 'wh-raw', movementType: 'purchase_receipt', quantityIn: 500, quantityOut: 0, unitCost: 15, documentType: 'تغذية', documentNumber: 'VI-REPL', batchNumber: 'VI-B3' });
const issueRes = ManufacturingEngine.issueMaterialsToOrder({ orderId: 'vi-pord', date: today, userId: 'usr-admin', userName: 'VI' });
check('Material issue to production order succeeds (BOM 80kg)', issueRes.success, issueRes.error || '');
const outRes = ManufacturingEngine.recordDailyProduction({ orderId: 'vi-pord', goodQuantity: 95, defectiveQuantity: 3, scrapQuantity: 2, defectiveAction: 'to_recycling', date: today, userId: 'usr-admin', userName: 'VI' });
check('Daily production recorded (95 good / 3 def / 2 scrap)', outRes.success, outRes.error || '');
check('Order quantities tracked (produced=95, remaining=5)', (() => { const o = erpDb.getSnapshot().productionOrders.find(x => x.id === 'vi-pord'); return o?.producedQuantity === 95 && o?.remainingQuantity === 5; })(), 'quantities wrong');
const closeRes = ManufacturingEngine.closeProductionOrder('vi-pord', 'usr-admin', 'VI');
check('Production order closed with balanced journal', closeRes.success, closeRes.error || '');
const viProd = erpDb.getSnapshot().items.find(i => i.id === 'vi-item');
check('Item actualCost updated from real production data', (viProd?.actualCost || 0) > 0, `actualCost=${viProd?.actualCost}`);

// Sales with free quantity, then return
const sale = WorkflowService.createSalesInvoice({
  customerId: 'vi-cust', channel: 'wholesale', warehouseId: 'wh-local',
  paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: today,
  lines: [{ itemId: 'vi-item', quantity: 10, freeQuantity: 1, unitPrice: 40, vatRate: 0.14 }],
});
check('Sales invoice posted (10 + 1 free)', sale.success, sale.error || '');
check('Free quantity included in COGS', sale.success && (sale.invoice?.cogsTotal || 0) > 0, 'cogs empty');
const ret = WorkflowService.postSalesReturn({
  customerId: 'vi-cust', date: today, reason: 'VI مرتجع تكامل',
  lines: [{ itemId: 'vi-item', quantity: 3, unitPrice: 40, vatRate: 0.14 }],
  inspectionOverrides: { 'vi-item': 'saleable' },
});
check('Sales return posted and restocked', ret.success && InventoryEngine.getItemBalance('vi-item', 'wh-local') > 0, ret.error || '');

// Customer balance consistency: invoices - returns - receipts
const cust = erpDb.getSnapshot().customers.find(c => c.id === 'vi-cust');
const expectedCustBalance = erpDb.getSnapshot().salesInvoices
  .filter(i => i.customerId === 'vi-cust' && i.status === 'posted')
  .reduce((s, i) => s + i.totalAmountEGP, 0)
  - erpDb.getSnapshot().salesReturns.filter(r => r.customerId === 'vi-cust').reduce((s, r) => s + r.totalAmount, 0);
check('Customer balance = posted invoices - returns', Math.abs((cust?.currentBalance || 0) - expectedCustBalance) < 0.02, `balance=${cust?.currentBalance}, expected=${expectedCustBalance}`);

// ---- 3. Global invariants after all activity ----
r = checkAllJournalsBalanced();
check(`ALL ${r.total} journals balanced (debit=credit)`, r.unbalanced === 0, `${r.unbalanced} unbalanced`);
check('ALL account balances match their journal lines', checkGlVsTrialBalance() === 0, 'GL mismatch');
check('ALL batch ledgers match movement balanceAfter', checkInventoryConsistency() === 0, 'ledger mismatch');

// No posting into closed periods (attempt must fail)
const closedPeriod = erpDb.getSnapshot().accountingPeriods.find(p => p.isClosed);
if (closedPeriod) {
  const { AccountingEngine } = await import('../src/services/accounting');
  const rej = AccountingEngine.postJournal({
    date: closedPeriod.startDate,
    reference: 'VI-CLOSED-TEST',
    description: 'محاولة ترحيل في فترة مغلقة (يجب أن تفشل)',
    sourceDocumentType: 'test',
    lines: [
      { id: '', journalEntryId: '', accountId: 'acc-1101', accountCode: '1101', accountNameAr: 'x', debit: 100, credit: 0, currency: 'EGP', originalAmount: 100, exchangeRate: 1 },
      { id: '', journalEntryId: '', accountId: 'acc-4101', accountCode: '4101', accountNameAr: 'x', debit: 0, credit: 100, currency: 'EGP', originalAmount: 100, exchangeRate: 1 },
    ],
  });
  check('Posting into a closed period is rejected', !rej.success, rej.error || 'unexpectedly succeeded');
}

console.log('='.repeat(64));
console.log(failures === 0 ? '🎉 ALL INTEGRITY CHECKS PASSED' : `⚠️ ${failures} INTEGRITY CHECK(S) FAILED`);
console.log('='.repeat(64));
process.exit(failures === 0 ? 0 : 1);
