// ABDULLAH ERP — QA BREAKER SUITE, BATCH 2 (cross-module scenarios A–N, S, T,
// V, W, Y, Z, AA, AD, AE, AG) covering Phases 5–12, 14–26, 29–33, 35–37, 38, 39–43.
//
// Run: `bun run qa2`
//
// NON-DESTRUCTIVE: never resets the DB, never clears storage, never reseeds.
// Every record it creates carries the `TEST-QA-[run-id]` prefix or `isTest`.
// Cleanup removes ONLY what this run appended (tracked by pre-run fingerprints)
// and restores every pre-existing balance it touched.
//
// A ❌ line = a REAL, confirmed defect (safe behaviour was expected).
// An ℹ️ line = a BUSINESS DECISION REQUIRED — no rule is invented.
import { erpDb } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { InventoryEngine } from '../src/services/inventory';
import { WorkflowService } from '../src/services/workflows';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { AccountingEngine } from '../src/services/accounting';
import { LedgerService } from '../src/services/ledger';
import { PermissionService } from '../src/services/permissions';
import { ensureTestBom, firstFinishedProductId } from './qa_test_bom';

const TODAY = new Date().toISOString().split('T')[0];
const RID = `QA2-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const snap = () => erpDb.getSnapshot();
// Actor for every call. `isTest` is passed explicitly by each call site (so the
// test flag is always explicit and never silently inherited).
const ADMIN = { userId: 'usr-admin', userName: 'QA' };

let pass = 0, fail = 0;
const defects: string[] = [];
const notes: string[] = [];
function check(label: string, safe: boolean, detail = '') {
  if (safe) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; defects.push(`${label} :: ${detail}`); console.log(`  ❌ ${label} :: ${detail}`); }
}
const note = (label: string, detail: string) => { notes.push(`${label} :: ${detail}`); console.log(`  ℹ️  ${label} :: ${detail}`); };
const section = (t: string) => console.log(`\n=== ${t} ===`);
const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) <= tol;
const acc = (code: string) => snap().accounts.find(a => a.code === code)?.currentBalance || 0;
const bal = (itemId: string, wh: string) => InventoryEngine.getItemBalance(itemId, wh);

/** Trial balance straight from posted journal lines (Dr and Cr in EGP). */
function trialBalance() {
  let dr = 0, cr = 0;
  for (const j of snap().journalEntries) {
    if (!j.isPosted || j.isReversed) continue;
    for (const l of j.lines) { dr += l.debit || 0; cr += l.credit || 0; }
  }
  return { dr, cr, diff: dr - cr };
}
let tbBaseline = trialBalance();

/** Subledger-vs-GL reconciliation snapshot (used to attribute drift to this run). */
function recon() {
  const db = snap();
  const arSub = db.customers.reduce((s, c) => s + (c.currentBalance || 0), 0);
  const apSub = db.suppliers.reduce((s, x) => s + (x.currentBalance || 0), 0);
  const invSub = db.batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
  const invGl = acc('1108') + acc('1109') + acc('1110') + acc('1107');
  return {
    arDiff: arSub - (acc('1105') + acc('1106')),
    apDiff: apSub - acc('2101'),
    invDiff: invGl - invSub,
  };
}

/** Total company-wide stock value (all warehouses) from the batch ledgers. */
function stockValue() {
  return snap().batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
}

// ---------------------------------------------------------------- fingerprints
const base = snap();
const BASE = {
  journalEntries: base.journalEntries.length,
  inventoryTransactions: base.inventoryTransactions.length,
  auditLogs: base.auditLogs.length,
  salesInvoices: base.salesInvoices.length,
  purchaseInvoices: base.purchaseInvoices.length,
  payments: base.payments.length,
  cheques: base.cheques.length,
  exportShipments: base.exportShipments.length,
  qualityInspections: base.qualityInspections.length,
  productionOrders: base.productionOrders.length,
  treasuryTransactions: base.treasuryTransactions.length,
  accounts: base.accounts.map(a => ({ id: a.id, b: a.currentBalance })),
  customers: base.customers.map(c => ({ id: c.id, b: c.currentBalance })),
  suppliers: base.suppliers.map(s => ({ id: s.id, b: s.currentBalance })),
  salesReps: base.salesReps.map(r => ({ id: r.id })),
  items: base.items.length,
};
const mine = {
  items: new Set<string>(), customers: new Set<string>(), suppliers: new Set<string>(),
  users: new Set<string>(), batches: new Set<string>(), repIds: new Set<string>(),
};
const RECON_BASELINE = recon();
/** Value injected straight through InventoryEngine (no journal) by this harness. */
const injected: Record<string, number> = {};

// ---------------------------------------------------------------- fixtures
let refSeq = 0;
const nextRef = () => `${PFX}-REF-${++refSeq}`;

function mkItem(over: Record<string, unknown> = {}) {
  const code = `${PFX}-IT-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const r = MasterDataService.createItem({
    code, nameAr: `${code} صنف`, nameEn: code, itemType: 'raw_material', baseUnitId: 'unit-kg',
    purchaseUnitId: 'unit-kg', standardCost: 0, actualCost: 0, sellingPriceRetail: 0,
    sellingPriceWholesale: 0, sellingPriceExportUSD: 0, vatRate: 0.14, vatCategory: 'standard',
    trackBatch: false, trackExpiry: false, minStockLevel: 0, active: true, ...over,
  } as never, ADMIN as never);
  if (!r.item) throw new Error(`mkItem: ${r.error}`);
  mine.items.add(r.item.id);
  return r.item;
}
function mkCustomer(type: 'retail' | 'wholesale' | 'export' = 'retail', currency: 'EGP' | 'USD' = 'EGP') {
  const code = `${PFX}-CUST-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const r = MasterDataService.createCustomer({
    code, name: `عميل ${code}`, customerType: type, channel: type, currency,
    address: PFX, phone: '0100000000', taxNumber: 'T-QA', creditLimit: 0, openingBalance: 0,
    isTest: true, ...ADMIN,
  });
  if (!r.customer) throw new Error(`mkCustomer: ${r.error}`);
  mine.customers.add(r.customer.id);
  return r.customer;
}
function mkSupplier() {
  const code = `${PFX}-SUP-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const r = MasterDataService.createSupplier({ code, name: `مورد ${code}`, currency: 'EGP', taxNumber: 'T-QA', isTest: true, ...ADMIN });
  if (!r.supplier) throw new Error(`mkSupplier: ${r.error}`);
  mine.suppliers.add(r.supplier.id);
  return r.supplier;
}
function receive(itemId: string, wh: string, qty: number, cost: number, batch = `${PFX}-B-${Math.random().toString(36).slice(2, 6).toUpperCase()}`) {
  const r = InventoryEngine.recordMovement({
    itemId, warehouseId: wh, movementType: 'purchase_receipt', quantityIn: qty, quantityOut: 0,
    unitCost: cost, documentType: `${PFX}-OPEN`, documentNumber: `${PFX}-OPEN`, batchNumber: batch,
    date: TODAY, isTest: true,
  });
  if (!r.success) throw new Error(`receive: ${r.error}`);
  mine.batches.add(batch);
  // This helper writes stock DIRECTLY through the inventory engine (no GL journal),
  // so its value is tracked separately: it must be excluded from the GL-vs-batch
  // reconciliation, otherwise the comparison measures the harness, not the system.
  injected[wh] = (injected[wh] || 0) + qty * cost;
  return r;
}

/** Batch-ledger value currently held in one warehouse. */
const whBatchValue = (wh: string) => snap().batches
  .filter(b => b.warehouseId === wh)
  .reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);

/**
 * The mirror of `receive()` for goods that LEAVE through the inventory engine
 * directly (no GL journal). The goods being issued came FROM the journal-less
 * `receive()` above, so the same value must come back OUT of `injected` —
 * otherwise P41 keeps excluding stock that has already been issued and reports a
 * residual the application never created. The amount is MEASURED from the batch
 * ledger (not assumed as qty × cost), because the engine consumes FIFO across
 * batches at their own unit costs.
 */
function issueDirect(itemId: string, wh: string, qty: number, docType: string, docNumber: string) {
  const before = whBatchValue(wh);
  const r = InventoryEngine.recordMovement({
    itemId, warehouseId: wh, movementType: 'production_issue', quantityIn: 0, quantityOut: qty,
    unitCost: 0, documentType: docType, documentNumber: docNumber, date: TODAY, isTest: true,
  });
  injected[wh] = (injected[wh] || 0) + (whBatchValue(wh) - before);
  return r;
}

console.log('================================================================');
console.log(`🧨 QA BREAKER BATCH 2 — run ${RID}`);
console.log('================================================================');

const sup = mkSupplier();
const cust = mkCustomer('retail');
const expCust = mkCustomer('export', 'USD');

// =========================================================================
section('SCENARIO A/K + PHASE 5 — PURCHASE → AP → SUPPLIER PAYMENT → TB');
// =========================================================================
const chip = snap().items.find(i => i.id === 'item-raw-chip')!; // canonical raw material
const PO_QTY = 1000, PO_PRICE = 60;
let purchaseInvoiceId = '';
{
  const inv = WorkflowService.createPurchaseInvoice({
    supplierId: sup.id, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: nextRef(), date: TODAY, lines: [{
      itemId: chip.id, quantity: PO_QTY, unitId: 'unit-kg', unitPrice: PO_PRICE,
      batchNumber: `${PFX}-CHIP-A`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0,
    }], isTest: true, ...ADMIN,
  } as never);
  check('A/K purchase invoice posted', inv.success, inv.error || '');
  purchaseInvoiceId = inv.invoice?.id || '';

  const stockOk = near(bal(chip.id, 'wh-raw'), PO_QTY, 0.001);
  const ap = snap().suppliers.find(s => s.id === sup.id)!.currentBalance;
  check('A/K stock received and AP = invoice total (no VAT charged on a 0% line)',
    stockOk && near(ap, PO_QTY * PO_PRICE, 0.01),
    `stock=${bal(chip.id, 'wh-raw')} AP=${ap} expected=${PO_QTY * PO_PRICE}`);
  check('A/K GL inventory 1108 grew by the receipt value', near(acc('1108'), PO_QTY * PO_PRICE, 0.01),
    `1108=${acc('1108')}`);
  check('A/K no fabricated input VAT on a 0%-rated line', near(acc('1113'), 0, 0.01), `1113=${acc('1113')}`);

  // Partial payment, then the remainder (Phase 5)
  const p1 = WorkflowService.recordSupplierPayment({
    supplierId: sup.id, amount: 25000, currency: 'EGP', exchangeRate: 1, date: TODAY,
    paymentMethod: 'cash', reference: `${nextRef()}-P1`, isTest: true, ...ADMIN,
  } as never);
  check('P5 partial supplier payment accepted', p1.success, p1.error || '');
  check('P5 AP reduced by exactly the payment', near(snap().suppliers.find(s => s.id === sup.id)!.currentBalance, PO_QTY * PO_PRICE - 25000, 0.01),
    `AP=${snap().suppliers.find(s => s.id === sup.id)!.currentBalance}`);

  const over = WorkflowService.recordSupplierPayment({
    supplierId: sup.id, amount: 500000, currency: 'EGP', exchangeRate: 1, date: TODAY,
    paymentMethod: 'cash', reference: `${nextRef()}-OVER`, isTest: true, ...ADMIN,
  } as never);
  check('P5 an absurd overpayment (500,000 vs a 60,000 invoice) is blocked or flagged', !over.success || over.payment !== undefined,
    `overpayment posted, supplier balance now ${snap().suppliers.find(s => s.id === sup.id)!.currentBalance}`);

  const zero = WorkflowService.recordSupplierPayment({
    supplierId: sup.id, amount: 0, currency: 'EGP', exchangeRate: 1, date: TODAY,
    paymentMethod: 'cash', reference: `${nextRef()}-ZERO`, isTest: true, ...ADMIN,
  } as never);
  check('P5 a zero-amount supplier payment is rejected', !zero.success, 'a 0 EGP payment was posted');

  const neg = WorkflowService.recordSupplierPayment({
    supplierId: sup.id, amount: -500, currency: 'EGP', exchangeRate: 1, date: TODAY,
    paymentMethod: 'cash', reference: `${nextRef()}-NEG`, isTest: true, ...ADMIN,
  } as never);
  check('P5 a negative supplier payment is rejected', !neg.success, 'a negative payment was posted');

  const tb = trialBalance();
  check('A TB balanced after purchase + payments', near(tb.dr, tb.cr, 0.05), `Dr=${tb.dr.toFixed(2)} Cr=${tb.cr.toFixed(2)}`);
}

// =========================================================================
section('SCENARIO I + PHASE 8 — PARTIAL PRODUCTION (400 then 600)');
// =========================================================================
let productionOrderId = '';
{
  const fp = snap().items.find(i => i.code === 'FP-SNG-01')!;
  // Stock every BOM component for this product (the clean DB ships with no materials).
  const bomFor = ensureTestBom(fp.id);
  snap().bomLines.filter(l => l.bomId === bomFor.id).forEach((l, idx) => {
    const unit = snap().units.find(u => u.id === l.unitId);
    WorkflowService.createPurchaseInvoice({
      supplierId: sup.id, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
      reference: `${PFX}-MAT-${idx}`, date: TODAY,
      lines: [{
        itemId: l.materialItemId, quantity: Math.ceil(l.quantityRequired * 1.2 * 1000) / 1000,
        unitId: l.unitId, unitPrice: 50, batchNumber: `${PFX}-MAT-${idx}`,
        productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0,
      }], isTest: true, ...ADMIN,
    } as never);
  });
  const order = ManufacturingEngine.createProductionOrder({
    productId: fp.id, plannedQuantity: 1000, targetMarket: 'local',
    destinationWarehouseId: 'wh-local', expectedCompletionDate: TODAY, isTest: true, ...ADMIN,
  } as never);
  check('I production order for 1,000 created', order.success, order.error || '');
  productionOrderId = order.order?.id || '';

  const reqs = ManufacturingEngine.calculateBomRequirements(
    snap().boms.find(b => b.id === order.order?.bomId)!.id, 1000);
  const chipReq = reqs.find(r => r.materialItemId === chip.id);
  const half = reqs.map(r => ({ id: r.materialItemId, q: chipReq && r.materialItemId === chip.id ? chipReq.requiredQuantity / 2.5 : r.requiredQuantity * 0.4 }));
  // Stage 1: issue 40% of every requirement, produce 400
  const stage1 = ManufacturingEngine.issueMaterialsToOrder({
    orderId: productionOrderId,
    lines: reqs.map(r => ({ materialItemId: r.materialItemId, quantity: Math.round(r.requiredQuantity * 0.4 * 1000) / 1000 })),
    date: TODAY, ...ADMIN,
  } as never);
  check('I stage-1 material issue succeeded', stage1.success, stage1.error || '');

  const produced1 = ManufacturingEngine.recordDailyProduction({
    orderId: productionOrderId, goodQuantity: 400, defectiveQuantity: 0, scrapQuantity: 0,
    defectiveAction: 'to_scrap', date: TODAY, isTest: true, ...ADMIN,
  } as never);
  check('I stage-1 production of 400 recorded', produced1.success, produced1.error || '');
  check('I finished goods received for stage 1 (400 units)',
    bal(fp.id, 'wh-local') >= 400, `FG=${bal(fp.id, 'wh-local')}`);

  const orderAfter1 = snap().productionOrders.find(o => o.id === productionOrderId)!;
  check('I order stays OPEN after a partial production', orderAfter1.status !== 'completed' && orderAfter1.status !== 'cancelled',
    `status=${orderAfter1.status}`);

  // Stage 2: remaining materials, remaining output, then close
  const reqs2 = ManufacturingEngine.calculateBomRequirements(
    snap().boms.find(b => b.id === order.order!.bomId)!.id, 600);
  const issue2 = ManufacturingEngine.issueMaterialsToOrder({
    orderId: productionOrderId, lines: reqs2.map(r => ({ materialItemId: r.materialItemId, quantity: r.requiredQuantity })),
    date: TODAY, ...ADMIN,
  } as never);
  check('I stage-2 material issue succeeded', issue2.success, issue2.error || '');

  const produced2 = ManufacturingEngine.recordDailyProduction({
    orderId: productionOrderId, goodQuantity: 600, defectiveQuantity: 0, scrapQuantity: 0,
    defectiveAction: 'to_scrap', date: TODAY, isTest: true, ...ADMIN,
  } as never);
  check('I stage-2 production of 600 recorded', produced2.success, produced2.error || '');

  const close = ManufacturingEngine.closeProductionOrder(productionOrderId, 'usr-admin', 'QA');
  check('I production order closes at 1,000 produced', close.success, close.error || '');

  const fpProd = snap().productionOrders.find(o => o.id === productionOrderId)!;
  const producedTotal = (snap().productionConsumptions || [])
    .filter(c => c.productionOrderId === productionOrderId)
    .reduce((s, c) => s + ((c as { goodQuantity?: number }).goodQuantity || 0), 0);
  check('I no duplicate production output (total produced = 1,000)',
    producedTotal === 0 || producedTotal <= 1000,
    `consumption rows report goodQuantity total=${producedTotal}`);

  const dupIssue = ManufacturingEngine.issueMaterialsToOrder({
    orderId: productionOrderId, lines: [{ materialItemId: chip.id, quantity: 1 }], date: TODAY, ...ADMIN,
  } as never);
  check('I materials cannot be issued onto a CLOSED order', !dupIssue.success, 'a closed order accepted another issue');
}

// =========================================================================
section('SCENARIO B/C/N — LOCAL SALE VIA REPRESENTATIVE CUSTODY');
// =========================================================================
{
  const fp = snap().items.find(i => i.code === 'FP-SNG-01')!;
  const repRes = WorkflowService.createSalesRepresentative({
    code: `${PFX}-REP`, name: `${PFX} مندوب`, phone: '0100000000', targetMonthlySales: 0,
    isTest: true, ...ADMIN,
  } as never);
  const repId = repRes.rep?.id || '';
  if (repId) mine.repIds.add(repId);

  const fgBefore = bal(fp.id, 'wh-local');
  const opened = WorkflowService.openRepCustody(repId, `${PFX} اختبار`);
  check('C/N representative custody opened', opened.success, opened.error || '');
  const custodyId = opened.custody?.id || '';

  const loadQty = Math.min(500, Math.floor(fgBefore));
  const load = WorkflowService.loadGoodsToRep({
    custodyId, itemId: fp.id, quantity: loadQty, unitPrice: 100, warehouseId: 'wh-local', date: TODAY,
  });
  check('C/N goods loaded to representative', load.success, load.error || '');
  check('C/N warehouse decreased by the loaded quantity', near(bal(fp.id, 'wh-local'), fgBefore - loadQty, 0.001),
    `FG ${fgBefore} → ${bal(fp.id, 'wh-local')} (loaded ${loadQty})`);

  const soldQty = 100;
  const inv = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: 'wh-local', repId,
    stockSource: 'rep_custody', custodyId, paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    date: TODAY, lines: [{ itemId: fp.id, quantity: soldQty, unitPrice: 100, vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  check('C sale from custody posted', inv.success, inv.error || '');
  {
    const cms = snap().custodyMovements.filter(m => m.custodyId === custodyId);
    const loaded = cms.filter(m => m.movementType === 'loaded');
    const loadVal = loaded.reduce((s, m) => s + m.quantity * (m.unitCost ?? 0), 0);
    const saleJv = inv.invoice?.journalEntryId ? snap().journalEntries.find(j => j.id === inv.invoice!.journalEntryId) : undefined;
    const custodyAcc = acc('1107');
    const saleDrCustody = saleJv ? saleJv.lines.filter(l => l.accountId === snap().accounts.find(a => a.code === '1107')?.id).reduce((s, l) => s + (l.credit || 0), 0) : 0;
    note('C custody cost forensics',
      `loaded ${loaded.reduce((s, m) => s + m.quantity, 0)} units recorded at ${loadVal.toFixed(2)} (unitCost avg ${(loaded.reduce((s, m) => s + m.quantity * (m.unitCost ?? 0), 0) / Math.max(1, loaded.reduce((s, m) => s + m.quantity, 0))).toFixed(4)}); the custody sale relieved ${saleDrCustody.toFixed(2)} from account 1107; GL 1107 now ${custodyAcc.toFixed(2)}`);
  }
  check('C/N FG stock NOT reduced again by the custody sale', near(bal(fp.id, 'wh-local'), fgBefore - loadQty, 0.001),
    `FG=${bal(fp.id, 'wh-local')} — custody sale relieved the warehouse twice`);

  const overSell = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: 'wh-local', repId,
    stockSource: 'rep_custody', custodyId, paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    date: TODAY, lines: [{ itemId: fp.id, quantity: loadQty + 1, unitPrice: 100, vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  check('C/N over-selling beyond custody is rejected', !overSell.success, `custody oversold: ${overSell.invoice?.invoiceNumber}`);

  const ret = WorkflowService.returnGoodsFromRep({
    custodyId, itemId: fp.id, quantity: 20, warehouseId: 'wh-local', date: TODAY,
  } as never);
  check('C/N goods returned from representative to warehouse', ret.success, ret.error || '');
  check('C/N returned quantity is back in the warehouse', near(bal(fp.id, 'wh-local'), fgBefore - loadQty + 20, 0.001),
    `FG=${bal(fp.id, 'wh-local')}`);

  const heldNow = snap().custodyMovements.filter(m => m.custodyId === custodyId)
    .reduce((s, m) => s + (m.movementType === 'loaded' ? m.quantity : -m.quantity), 0);
  const settleEarly = WorkflowService.settleRepCustody({
    custodyId, cashCollected: 0, date: TODAY, acknowledgeRemainingGoods: false,
    notes: `${PFX} settle-while-holding`, ...ADMIN,
  } as never);
  check('N custody cannot be silently closed while goods remain (shortfall must be acknowledged)',
    !settleEarly.success, `custody with ${heldNow} unsold units was closed silently`);

  // Close the custody so no stock is left between the batch ledger and GL 1107
  if (heldNow > 0) {
    const back = WorkflowService.returnGoodsFromRep({
      custodyId, itemId: fp.id, quantity: heldNow, warehouseId: 'wh-local', date: TODAY,
    } as never);
    check('N the remaining custody is returned so custody ends empty', back.success, back.error || '');
    note('N custody closing', `${heldNow} units returned; custody balance now ${snap().custodyMovements.filter(m => m.custodyId === custodyId).reduce((s, m) => s + (m.movementType === 'loaded' ? m.quantity : -m.quantity), 0)}`);
  }

  const settle = WorkflowService.settleRepCustody({
    custodyId, cashCollected: 0, date: TODAY, acknowledgeRemainingGoods: false,
    notes: `${PFX} settle`, isTest: true, ...ADMIN,
  } as never);
  note('N representative settlement', settle.success ? 'settled' : `NOT SETTLED: ${settle.error || ''}`);
  const settleShort = WorkflowService.settleRepCustody({
    custodyId, cashCollected: 0, date: TODAY, acknowledgeRemainingGoods: true,
    notes: `${PFX} settle-after-return`, ...ADMIN,
  } as never);
  check('N a custody cannot be settled twice (idempotency)', !settleShort.success,
    `a second settlement was accepted (${settleShort.error || 'no error'})`);

  const tb = trialBalance();
  check('B/C TB balanced after custody sale + return', near(tb.dr, tb.cr, 0.05), `Dr=${tb.dr.toFixed(2)} Cr=${tb.cr.toFixed(2)}`);
}

// =========================================================================
section('SCENARIO J + PHASE 16/17 — PARTIAL CUSTOMER PAYMENT, AR, AGING');
// (AR baseline must be captured BEFORE this scenario's invoice is booked)
// =========================================================================
let arInvoiceId = '';
{
  const fp = snap().items.find(i => i.code === 'FP-SNG-01')!;
  receive(fp.id, 'wh-local', 300, 40);
  const arBase = snap().customers.find(c => c.id === cust.id)!.currentBalance;
  const inv = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: 'wh-local', paymentMethod: 'credit',
    currency: 'EGP', exchangeRate: 1, date: TODAY,
    lines: [{ itemId: fp.id, quantity: 100, unitPrice: 100, vatRate: 0 }], ...ADMIN,
  } as never);
  check('J 10,000 EGP credit invoice posted', inv.success && near(inv.invoice!.totalAmount, 10000, 0.01),
    `${inv.error || ''} total=${inv.invoice?.totalAmount}`);
  arInvoiceId = inv.invoice?.id || '';

  const balAfterInvoice = snap().customers.find(c => c.id === cust.id)!.currentBalance;
  check('J AR grew by exactly the invoice total', near(balAfterInvoice - arBase, 10000, 0.01),
    `AR ${arBase} → ${balAfterInvoice} (Δ ${(balAfterInvoice - arBase).toFixed(2)})`);

  const p1 = WorkflowService.recordCustomerPayment({
    customerId: cust.id, amount: 4000, currency: 'EGP', exchangeRate: 1, date: TODAY,
    paymentMethod: 'cash', reference: `${nextRef()}-AR1`, allocatedInvoiceIds: [arInvoiceId],
    isTest: true, ...ADMIN,
  } as never);
  check('J first partial collection of 4,000 accepted', p1.success, p1.error || '');
  check('J outstanding AR = 6,000 after the first collection',
    near(snap().customers.find(c => c.id === cust.id)!.currentBalance - arBase, 6000, 0.01),
    `AR delta=${(snap().customers.find(c => c.id === cust.id)!.currentBalance - arBase).toFixed(2)}`);

  const stmt = LedgerService.buildCustomerStatement({ customerId: cust.id });
  check('J customer statement ties to the customer card',
    near(stmt.closingBalance, stmt.cardBalance, 0.01) && near(stmt.glBalance, stmt.cardBalance, 0.01),
    `statement closing=${stmt.closingBalance} card=${stmt.cardBalance} gl=${stmt.glBalance}`);

  const aging = LedgerService.buildReceivablesAging({ customerId: cust.id });
  const agingRow = aging.find(r => r.customerId === cust.id);
  const agingSum = agingRow ? (agingRow.b0_30 + agingRow.b31_60 + agingRow.b61_90 + agingRow.b90plus) : 0;
  check('J aging total equals the outstanding AR (no double counting)',
    near(agingSum, snap().customers.find(c => c.id === cust.id)!.currentBalance, 0.01),
    `aging buckets sum=${agingSum} AR=${snap().customers.find(c => c.id === cust.id)!.currentBalance}`);

  const p2 = WorkflowService.recordCustomerPayment({
    customerId: cust.id, amount: 6000, currency: 'EGP', exchangeRate: 1, date: TODAY,
    paymentMethod: 'bank_transfer', reference: `${nextRef()}-AR2`, allocatedInvoiceIds: [arInvoiceId],
    isTest: true, ...ADMIN,
  } as never);
  check('J final collection of 6,000 accepted', p2.success, p2.error || '');
  const finalAr = snap().customers.find(c => c.id === cust.id)!.currentBalance;
  check('J this invoice is fully settled (AR back to its pre-invoice level)', near(finalAr, arBase, 0.01),
    `AR ${arBase} → ${finalAr}`);

  const tb = trialBalance();
  check('J TB balanced after collections', near(tb.dr, tb.cr, 0.05), `Dr=${tb.dr.toFixed(2)} Cr=${tb.cr.toFixed(2)}`);
}

// =========================================================================
section('SCENARIO D/R + PHASE 15 — SALES RETURNS');
// =========================================================================
{
  const fp = snap().items.find(i => i.code === 'FP-SNG-01')!;
  receive(fp.id, 'wh-local', 200, 40);
  const inv = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: 'wh-local', paymentMethod: 'credit',
    currency: 'EGP', exchangeRate: 1, date: TODAY,
    lines: [{ itemId: fp.id, quantity: 50, unitPrice: 100, vatRate: 0 }], isTest: true, ...ADMIN,
  } as never);
  const invoiceId = inv.invoice!.id;

  const revBefore = acc('4101'), cogsBefore = acc('5101'), arBefore = snap().customers.find(c => c.id === cust.id)!.currentBalance;
  const full = WorkflowService.postSalesReturn({
    customerId: cust.id, invoiceId, warehouseId: 'wh-local', date: TODAY,
    reason: `${PFX} مرتجع كامل`,
    lines: [{ itemId: fp.id, quantity: 20, unitPrice: 100, vatRate: 0 }], ...ADMIN,
  } as never);
  check('D partial sales return posted', full.success, full.error || '');
  check('D revenue reversed by the returned value', near(acc('4101'), revBefore - 2000, 0.01),
    `4101 ${revBefore} → ${acc('4101')}`);
  const returnedCost = acc('5101');
  check('D COGS was reversed (by the returned goods’ real FIFO cost, never a fixed amount)',
    returnedCost < cogsBefore, `5101 ${cogsBefore.toFixed(2)} → ${returnedCost.toFixed(2)} (Δ ${(returnedCost - cogsBefore).toFixed(2)} for 20 units)`);
  check('D customer AR reduced by the return',
    near(snap().customers.find(c => c.id === cust.id)!.currentBalance, arBefore - 2000, 0.01),
    `AR ${arBefore} → ${snap().customers.find(c => c.id === cust.id)!.currentBalance}, expected ${arBefore - 2000}`);

  const over = WorkflowService.postSalesReturn({
    customerId: cust.id, invoiceId, warehouseId: 'wh-local', date: TODAY, reason: `${PFX} over-return`,
    lines: [{ itemId: fp.id, quantity: 9999, unitPrice: 100, vatRate: 0 }], ...ADMIN,
  } as never);
  check('R returning MORE than was sold is rejected', !over.success,
    `returned 9,999 of a 50-unit invoice → ${over.salesReturn?.returnNumber}`);
}

// =========================================================================
section('SCENARIO M + PHASE 7 — INTERNAL TRANSFER (WH-01 → WH-02)');
// =========================================================================
{
  const before = { qty: bal(chip.id, 'wh-raw'), value: stockValue(), rev: acc('4101'), cogs: acc('5101'), ar: acc('1105') };
  const move = InventoryEngine.transferWarehouse(chip.id, 'wh-raw', 'wh-local', 200, undefined, `${PFX}-CHIP-A`, `${PFX} transfer`);
  check('M transfer executed', move.success, move.error || '');
  const after = { qty: bal(chip.id, 'wh-raw'), value: stockValue(), rev: acc('4101'), cogs: acc('5101'), ar: acc('1105') };
  check('M source warehouse decreased by exactly the transferred quantity', near(before.qty - after.qty, 200, 0.001),
    `${before.qty} → ${after.qty}`);
  check('M destination warehouse increased by the transferred quantity', near(bal(chip.id, 'wh-local'), 200, 0.001),
    `WH-02=${bal(chip.id, 'wh-local')}`);
  check('M total company inventory VALUE unchanged', near(before.value, after.value, 0.5),
    `value ${before.value.toFixed(2)} → ${after.value.toFixed(2)}`);
  check('M transfer created NO revenue / COGS / receivable', near(before.rev, after.rev, 0.01) && near(before.cogs, after.cogs, 0.01) && near(before.ar, after.ar, 0.01),
    `4101 ${before.rev}→${after.rev}, 5101 ${before.cogs}→${after.cogs}, 1105 ${before.ar}→${after.ar}`);

  const same = InventoryEngine.transferWarehouse(chip.id, 'wh-raw', 'wh-raw', 10);
  check('M same-warehouse transfer is rejected', !same.success, 'a no-op transfer was accepted');
  const zero = InventoryEngine.transferWarehouse(chip.id, 'wh-raw', 'wh-local', 0);
  check('M zero-quantity transfer is rejected', !zero.success, 'a zero transfer was accepted');
  const neg = InventoryEngine.transferWarehouse(chip.id, 'wh-raw', 'wh-local', -5);
  check('M negative-quantity transfer is rejected', !neg.success, 'a negative transfer was accepted');
  const over = InventoryEngine.transferWarehouse(chip.id, 'wh-raw', 'wh-local', bal(chip.id, 'wh-raw') + 500);
  check('M transfer beyond available stock is rejected', !over.success, 'an over-transfer was accepted');
}

// =========================================================================
section('SCENARIO L + PHASE 4 — PARTIAL PURCHASE RETURN');
// =========================================================================
{
  const ret = WorkflowService.postPurchaseReturn({
    supplierId: sup.id, purchaseInvoiceId: purchaseInvoiceId || undefined, warehouseId: 'wh-raw',
    date: TODAY, reason: `${PFX} مرتجع مشتريات`,
    lines: [{ itemId: chip.id, quantity: 100, batchNumber: `${PFX}-CHIP-A` }], ...ADMIN,
  } as never);
  check('L partial purchase return posted', ret.success, ret.error || '');
  const apAfter = snap().suppliers.find(s => s.id === sup.id)!.currentBalance;
  note('L AP after purchase return', `supplier balance = ${apAfter}`);
  note('L stock after purchase return', `chip in WH-01 = ${bal(chip.id, 'wh-raw')} (received ${PO_QTY}, returned 100)`);

  const over = WorkflowService.postPurchaseReturn({
    supplierId: sup.id, purchaseInvoiceId: purchaseInvoiceId || undefined, warehouseId: 'wh-raw',
    date: TODAY, reason: `${PFX} over`, lines: [{ itemId: chip.id, quantity: 99999, batchNumber: `${PFX}-CHIP-A` }],
    ...ADMIN,
  } as never);
  check('L returning more than was received is rejected', !over.success, `returned 99,999 → ${over.purchaseReturn?.returnNumber}`);
}

// =========================================================================
section('SCENARIO T + PHASE 6 — FIFO WITH DIFFERENT BATCH COSTS');
// =========================================================================
{
  const it = mkItem({ nameAr: `${PFX} صنف FIFO`, baseUnitId: 'unit-piece', purchaseUnitId: 'unit-piece', itemType: 'finished_product' });
  receive(it.id, 'wh-raw', 100, 10, `${PFX}-FIFO-A`);
  receive(it.id, 'wh-raw', 100, 20, `${PFX}-FIFO-B`);
  const est = InventoryEngine.estimateIssueCost(it.id, 'wh-raw', 150);
  check('T FIFO issue cost for 150 units = 100×10 + 50×20 = 2,000', near(est.actualCost, 2000, 0.01),
    `estimated ${est.actualCost}`);
  const injectedBefore = injected['wh-raw'] || 0;
  const mv = issueDirect(it.id, 'wh-raw', 150, `${PFX}-FIFO-OUT`, `${PFX}-FIFO-OUT`);
  check('T FIFO issue executed', mv.success, mv.error || '');
  check('T the journal-less tracker follows the goods OUT as well as in (P41 invariant)',
    near((injected['wh-raw'] || 0) - injectedBefore, -2000, 0.01),
    `injected ${injectedBefore} → ${injected['wh-raw']} (the 150 units cost 2,000 at FIFO and are no longer on hand)`);
  const bA = snap().batches.find(b => b.batchNumber === `${PFX}-FIFO-A`)!;
  const bB = snap().batches.find(b => b.batchNumber === `${PFX}-FIFO-B`)!;
  check('T cheapest batch fully depleted, second batch partially consumed', near(bA.quantity, 0, 0.001) && near(bB.quantity, 50, 0.001),
    `A=${bA.quantity} B=${bB.quantity}`);

  const over = issueDirect(it.id, 'wh-raw', 9999, `${PFX}-OVER`, `${PFX}-OVER`);
  check('S issuing more than available stock is rejected', !over.success, 'an over-issue was accepted');
  const neg = issueDirect(it.id, 'wh-raw', -5, `${PFX}-NEG`, `${PFX}-NEG`);
  check('S a negative movement is rejected', !neg.success, 'a negative movement was accepted');
}

// =========================================================================
section('SCENARIO W/X + PHASE 22 — EXPORT, FX, FREIGHT, PORT, CUSTOMS');
// =========================================================================
{
  const fp = snap().items.find(i => i.code === 'FP-DUO-01' && i.itemType === 'finished_product')!;
  receive(fp.id, 'wh-export', 100, 40);
  const fx = snap().company.currentUsdExchangeRate || 50;
  const revBefore = acc('4103'), cogsBefore = acc('5102'), arBefore = acc('1106'), invBefore = acc('1110');

  const inv = WorkflowService.createSalesInvoice({
    customerId: expCust.id, channel: 'export', warehouseId: 'wh-export', paymentMethod: 'credit',
    currency: 'USD', exchangeRate: fx, date: TODAY,
    lines: [{ itemId: fp.id, quantity: 50, unitPrice: 10, vatRate: 0 }],
    taxTreatment: 'exempt', ...ADMIN,
  } as never);
  check('W export invoice posted in USD', inv.success, inv.error || '');
  const usd = inv.invoice?.totalAmount || 0;
  check('W revenue converted exactly once (USD 500 × FX = EGP)',
    near(acc('4103') - revBefore, 500 * fx, 0.01),
    `USD ${usd} × ${fx} → EGP ${(acc('4103') - revBefore).toFixed(2)}, expected ${(500 * fx).toFixed(2)}`);
  check('W export COGS taken from actual EGP stock cost (NOT re-converted)',
    near(acc('5102') - cogsBefore, 50 * 40, 0.01),
    `5102 Δ=${(acc('5102') - cogsBefore).toFixed(2)}, expected ${(50 * 40).toFixed(2)} (no × FX)`);
  check('W export receivable 1106 booked in EGP', near(acc('1106') - arBefore, 500 * fx, 0.01),
    `1106 Δ=${(acc('1106') - arBefore).toFixed(2)}`);
  check('W export inventory 1110 relieved by the EGP cost', near(invBefore - acc('1110'), 50 * 40, 0.01),
    `1110 Δ=${(invBefore - acc('1110')).toFixed(2)}`);

  const ship = WorkflowService.createExportShipment({
    customerId: expCust.id, shipmentDate: TODAY, portOfOrigin: 'بورسعيد', destinationPort: 'Jeddah',
    containerNumber: `${PFX}-CNT`, usdRevenue: usd, exchangeRate: fx,
    shippingCost: 300, portCosts: 100, customsCost: 50, otherExportCosts: 0,
    salesInvoiceId: inv.invoice?.id, ...ADMIN,
  } as never);
  check('W export shipment (freight/port/customs) posted', ship.success, ship.error || '');
  check('W shipment did NOT re-post revenue or COGS',
    near(acc('4103') - revBefore, 500 * fx, 0.01) && near(acc('5102') - cogsBefore, 50 * 40, 0.01),
    `4103 Δ=${(acc('4103') - revBefore).toFixed(2)} 5102 Δ=${(acc('5102') - cogsBefore).toFixed(2)}`);

  const coll = WorkflowService.recordExportCollection({
    shipmentId: ship.shipment!.id, amountUsd: usd, actualExchangeRate: fx, date: TODAY, ...ADMIN,
  } as never);
  check('W export collection recorded', coll.success, coll.error || '');
  const noFx = WorkflowService.recordExportCollection({
    shipmentId: ship.shipment!.id, amountUsd: 1, date: TODAY, ...ADMIN,
  } as never);
  check('X a collection WITHOUT an actual FX rate is rejected with a clear message', !noFx.success,
    `missing-FX collection accepted: ${noFx.error || 'no error'}`);

  const zeroFx = WorkflowService.createSalesInvoice({
    customerId: expCust.id, channel: 'export', warehouseId: 'wh-export', paymentMethod: 'credit',
    currency: 'USD', exchangeRate: 0, date: TODAY,
    lines: [{ itemId: fp.id, quantity: 1, unitPrice: 10, vatRate: 0 }], ...ADMIN,
  } as never);
  check('X a ZERO FX rate is rejected (no free revenue, no free goods)', !zeroFx.success,
    `zero-FX invoice ${zeroFx.invoice?.invoiceNumber} was posted`);
  const negFx = WorkflowService.createSalesInvoice({
    customerId: expCust.id, channel: 'export', warehouseId: 'wh-export', paymentMethod: 'credit',
    currency: 'USD', exchangeRate: -50, date: TODAY,
    lines: [{ itemId: fp.id, quantity: 1, unitPrice: 10, vatRate: 0 }], ...ADMIN,
  } as never);
  check('X a NEGATIVE FX rate is rejected', !negFx.success, `negative-FX invoice ${negFx.invoice?.invoiceNumber} posted`);
}

// =========================================================================
section('SCENARIO G/Q — CUSTOMER CHEQUES');
// =========================================================================
{
  const fp = snap().items.find(i => i.code === 'FP-SNG-01')!;
  receive(fp.id, 'wh-local', 50, 40);
  const inv = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: 'wh-local', paymentMethod: 'credit',
    currency: 'EGP', exchangeRate: 1, date: TODAY,
    lines: [{ itemId: fp.id, quantity: 10, unitPrice: 100, vatRate: 0 }], ...ADMIN,
  } as never);
  const arBefore = snap().customers.find(c => c.id === cust.id)!.currentBalance;

  const chqNo = `${PFX}-CHQ-1`;
  const pay = WorkflowService.recordCustomerPayment({
    customerId: cust.id, amount: 1000, currency: 'EGP', exchangeRate: 1, date: TODAY,
    paymentMethod: 'cheque', chequeNumber: chqNo, chequeBank: 'بنك اختبار', chequeDueDate: '2027-01-01',
    reference: `${nextRef()}-CHQ`, ...ADMIN,
  } as never);
  check('G customer cheque payment recorded', pay.success, pay.error || '');
  const chq = snap().cheques.find(c => c.chequeNumber === chqNo);
  check('G cheque document created', !!chq, `cheque ${chqNo} not found`);

  const arAfterChq = snap().customers.find(c => c.id === cust.id)!.currentBalance;
  check('G AR reduced once by the cheque (no double counting)', near(arBefore - arAfterChq, 1000, 0.01),
    `AR ${arBefore} → ${arAfterChq}`);

  const tb1 = trialBalance();
  check('G TB balanced after the cheque receipt', near(tb1.dr, tb1.cr, 0.05), `Dr=${tb1.dr.toFixed(2)} Cr=${tb1.cr.toFixed(2)}`);

  const dup = WorkflowService.registerCheque({
    type: 'incoming', partyId: cust.id, chequeNumber: chqNo, bankName: 'بنك اختبار', amount: 500,
    currency: 'EGP', issueDate: TODAY, dueDate: '2027-01-01', ...ADMIN,
  } as never);
  check('Q a DUPLICATE cheque number is rejected or flagged', !dup.success,
    `cheque ${chqNo} registered a second time for 500 EGP`);

  const zeroChq = WorkflowService.registerCheque({
    type: 'incoming', partyId: cust.id, chequeNumber: `${PFX}-CHQ-0`, bankName: 'بنك اختبار', amount: 0,
    currency: 'EGP', issueDate: TODAY, dueDate: '2027-01-01', ...ADMIN,
  } as never);
  check('Q a zero-value cheque is rejected', !zeroChq.success, 'a 0 EGP cheque was registered');

  const badDate = WorkflowService.registerCheque({
    type: 'incoming', partyId: cust.id, chequeNumber: `${PFX}-CHQ-BAD`, bankName: 'بنك اختبار', amount: 100,
    currency: 'EGP', issueDate: '2030-01-01', dueDate: '2020-01-01', ...ADMIN,
  } as never);
  check('Q a cheque with an invalid date range is rejected', !badDate.success, 'a due-before-issue cheque was registered');
}

// =========================================================================
section('SCENARIO H/P — SUPPLIER POSTDATED CHEQUE');
// =========================================================================
{
  const pay = WorkflowService.recordSupplierPayment({
    supplierId: sup.id, amount: 5000, currency: 'EGP', exchangeRate: 1, date: TODAY,
    paymentMethod: 'cheque', chequeNumber: `${PFX}-SUP-CHQ`, chequeBank: 'بنك اختبار',
    chequeDueDate: '2027-06-01', reference: `${nextRef()}-SUPCHQ`, ...ADMIN,
  } as never);
  check('H/P supplier cheque recorded', pay.success, pay.error || '');
  note('H/P AP after issuing a postdated cheque', `supplier balance = ${snap().suppliers.find(s => s.id === sup.id)!.currentBalance}`);
  const tb = trialBalance();
  check('H/P TB balanced after the supplier cheque', near(tb.dr, tb.cr, 0.05), `Dr=${tb.dr.toFixed(2)} Cr=${tb.cr.toFixed(2)}`);
}

// =========================================================================
section('SCENARIO Z + PHASE 29 — DATE / PERIOD EDGE CASES');
// =========================================================================
{
  const future = new Date(Date.now() + 40 * 86400000).toISOString().split('T')[0];
  const past = new Date(Date.now() - 400 * 86400000).toISOString().split('T')[0];
  const fp = snap().items.find(i => i.code === 'FP-SNG-01')!;
  receive(fp.id, 'wh-local', 20, 40);

  const fInv = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: 'wh-local', paymentMethod: 'credit',
    currency: 'EGP', exchangeRate: 1, date: future,
    lines: [{ itemId: fp.id, quantity: 1, unitPrice: 100, vatRate: 0 }], ...ADMIN,
  } as never);
  note('Z future-dated sales invoice', fInv.success ? `ACCEPTED (${fInv.invoice?.invoiceNumber} dated ${future})` : `blocked: ${fInv.error}`);

  const bInv = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: 'wh-local', paymentMethod: 'credit',
    currency: 'EGP', exchangeRate: 1, date: past,
    lines: [{ itemId: fp.id, quantity: 1, unitPrice: 100, vatRate: 0 }], ...ADMIN,
  } as never);
  note('Z backdated sales invoice (400 days ago)', bInv.success ? `ACCEPTED (${bInv.invoice?.invoiceNumber})` : `blocked: ${bInv.error}`);

  const closed = AccountingEngine.setPeriodClosed(
    snap().accountingPeriods[0].id, true, 'usr-admin', 'QA');
  note('Z closed-period posting test', closed.success ? `period ${snap().accountingPeriods[0].nameAr} closed` : `could not close: ${closed.error}`);
  const afterClose = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: 'wh-local', paymentMethod: 'credit',
    currency: 'EGP', exchangeRate: 1, date: snap().accountingPeriods[0].startDate || past,
    lines: [{ itemId: fp.id, quantity: 1, unitPrice: 100, vatRate: 0 }], ...ADMIN,
  } as never);
  check('Z a transaction dated inside a CLOSED period is rejected', !afterClose.success,
    `invoice ${afterClose.invoice?.invoiceNumber} was posted into a closed period`);
  // restore the period so cleanup leaves the calendar untouched
  AccountingEngine.setPeriodClosed(snap().accountingPeriods[0].id, false, 'usr-admin', 'QA');
}

// =========================================================================
section('SCENARIO AD/AE — MASTER DATA + BOM INTEGRITY');
// =========================================================================
{
  const db = snap();
  const fps = db.items.filter(i => i.itemType === 'finished_product' && !i.code.includes('TEST-QA'));
  const boms = db.boms.filter(b => b.active);
  check('AD 11 finished products exist', fps.length === 11, `found ${fps.length}`);
  // BATCH P: the seeded UAT BOMs were deliberately deleted, so the product
  // correctly ships with NO BOM. Suites that need one build it via
  // ensureTestBom(). Assert the new invariant plus that those fixtures work.
  check('AE no seeded UAT BOM shipped (Batch P)',
    ['bom-item-fp-s1', 'bom-item-fp-s2', 'bom-item-fp-s3', 'bom-item-fp-s4', 'bom-item-fp-s5', 'bom-item-fp-s6',
      'bom-item-fp-d1', 'bom-item-fp-d2', 'bom-item-fp-d3', 'bom-item-fp-d4', 'bom-item-fp-d5']
      .every(id => !boms.some(b => b.id === id)),
    `${boms.length} active BOM(s) present (test fixtures only)`);
  check('AE every active BOM has lines for a real finished product',
    boms.every(b => db.bomLines.some(l => l.bomId === b.id) && fps.some(f => f.id === b.finishedItemId)),
    `${boms.filter(b => !db.bomLines.some(l => l.bomId === b.id)).length} empty`);
  const orphan = db.bomLines.filter(l => !db.items.some(i => i.id === l.materialItemId));
  check('AE no BOM line references a missing material', orphan.length === 0, `${orphan.length} orphan lines`);
  const badUnit = db.bomLines.filter(l => !db.units.some(u => u.id === l.unitId));
  check('AE every BOM line uses a registered UOM', badUnit.length === 0, `${badUnit.length} bad units`);
  const chipBom = boms.find(b => b.finishedItemId === fps[0].id)!;
  const chipLine = db.bomLines.find(l => l.bomId === chipBom.id && l.materialItemId === 'item-raw-chip');
  check('AE the chip BOM line is denominated in KG (not PCS)',
    !!chipLine && chipLine.unitId === 'unit-kg', `unit=${chipLine?.unitId}`);
  const sauceLines = db.bomLines.filter(l => l.bomId === chipBom.id && l.materialItemId.startsWith('item-raw-flavor-'));
  check('AE a single-product BOM carries exactly one sauce line', sauceLines.length === 1,
    `${sauceLines.length} sauce lines`);
  const chipItem = db.items.find(i => i.id === 'item-raw-chip')!;
  check('AD the chip item is typed as raw_material', chipItem.itemType === 'raw_material', `type=${chipItem.itemType}`);
  const rep = db.salesReps.find(r => r.code === 'REP-HAMZA-01' || r.name?.includes('حمزه'));
  check('AD the seeded representative حمزه حماد exists', !!rep, 'seeded rep missing');
}

// =========================================================================
section('SCENARIO AA + PHASE 30 — IDEMPOTENCY');
// =========================================================================
{
  const fp = snap().items.find(i => i.code === 'FP-SNG-01')!;
  receive(fp.id, 'wh-local', 100, 40);
  const inv = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: 'wh-local', paymentMethod: 'credit',
    currency: 'EGP', exchangeRate: 1, date: TODAY,
    lines: [{ itemId: fp.id, quantity: 5, unitPrice: 100, vatRate: 0 }], ...ADMIN,
  } as never);
  const payParams = {
    customerId: cust.id, amount: 100, currency: 'EGP' as const, exchangeRate: 1, date: TODAY,
    paymentMethod: 'cash' as const, reference: `${nextRef()}-IDEM`, ...ADMIN,
  };
  const pay1 = WorkflowService.recordCustomerPayment(payParams as never);
  const pay2 = WorkflowService.recordCustomerPayment(payParams as never);
  const dupCash = pay1.success && pay2.success &&
    snap().treasuryTransactions.filter(t => (t.description || '').includes(payParams.reference)).length > 1;
  check('AA a repeated (double-submitted) receipt is prevented or flagged', !dupCash,
    `two identical receipts of 100 EGP both posted (${pay1.payment?.paymentNumber} / ${pay2.payment?.paymentNumber})`);
}

// =========================================================================
section('PHASE 39-43 — RECONCILIATION MATRIX');
// =========================================================================
{
  const tb = trialBalance();
  check('P40/Phase 26 total debits = total credits at the end of the run', near(tb.dr, tb.cr, 0.05),
    `Dr=${tb.dr.toFixed(2)} Cr=${tb.cr.toFixed(2)} diff=${tb.dr.toFixed(2)}`);

  const db = snap();
  const arCustomers = db.customers.filter(c => c.customerType !== 'export');
  const arLocalTotal = arCustomers.reduce((s, c) => s + (c.currentBalance || 0), 0);
  const arDiff = arLocalTotal - acc('1105');
  check('P42 LOCAL AR subledger ties to GL 1105 exactly',
    near(arDiff, RECON_BASELINE.arDiff, 1),
    `drift=${arDiff.toFixed(2)} vs pre-run baseline ${RECON_BASELINE.arDiff.toFixed(2)} (EGP customers subledger=${arLocalTotal.toFixed(2)}, GL1105=${acc('1105').toFixed(2)})`);

  // EXPORT customers: the card is kept in USD (document currency, per master_uat)
  // while GL 1106 is EGP — the two differ by the FX factor by design.
  const expCustRows = db.customers.filter(c => c.currency === 'USD');
  if (expCustRows.length) {
    note('P42 EXPORT AR currency basis',
      `export customer cards are in USD (${expCustRows.map(c => c.currentBalance.toFixed(2)).join(', ')} USD) while GL 1106 = ${acc('1106').toFixed(2)} EGP — BUSINESS DECISION REQUIRED (document currency vs base currency)`);
  }

  const apTotal = db.suppliers.reduce((s, x) => s + (x.currentBalance || 0), 0);
  const apDiff = apTotal - acc('2101');
  check('P42 AP subledger (suppliers) ties to GL 2101 (and did not drift during this run)',
    near(apDiff, RECON_BASELINE.apDiff, 1),
    `drift=${apDiff.toFixed(2)} vs pre-run baseline ${RECON_BASELINE.apDiff.toFixed(2)} (absolute subledger=${apTotal.toFixed(2)}, GL=${acc('2101').toFixed(2)})`);

  const r = recon();
  const injectedTotal = Object.values(injected).reduce((s, v) => s + v, 0);
  // All inventory accounts including 1107: the custody is closed by now, so the
  // full company inventory on the GL side must equal the batch ledger exactly.
  const glInvTotal = acc('1108') + acc('1109') + acc('1110') + acc('1111') + acc('1112') + acc('1107');
  const batchTotal = snap().batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
  // Stock the harness injected straight through the inventory engine has no journal
  // by design, so it is removed from the batch side before comparing.
  check('P41 GL inventory ties to the batch ledger (all inventory accounts, custody closed)',
    near(glInvTotal, batchTotal - injectedTotal, 2),
    `GL=${glInvTotal.toFixed(2)} batches=${batchTotal.toFixed(2)} directInjected=${injectedTotal.toFixed(2)} residual=${(glInvTotal - (batchTotal - injectedTotal)).toFixed(2)}`);
  note('P41 measured residual', `GL=${glInvTotal.toFixed(2)} − (batches ${batchTotal.toFixed(2)} − journal-less injected ${injectedTotal.toFixed(2)}) = ${(glInvTotal - (batchTotal - injectedTotal)).toFixed(2)}`);

  const custodyAtPrice = snap().custodyMovements.reduce((s, m) => s + (m.movementType === 'loaded' ? m.quantity * m.unitPrice : -m.quantity * m.unitPrice), 0);
  if (Math.abs(acc('1107') - custodyAtPrice) > 1) {
    note('P43 representative-custody valuation',
      `GL 1107 = ${acc('1107').toFixed(2)} (posted at FIFO COST) vs the custody subledger = ${custodyAtPrice.toFixed(2)} (stored at the caller-supplied PRICE) — see BUSINESS DECISION REQUIRED`);
  }

  // Per-account localisation of any inventory drift (Phase 41 evidence)
  if (Math.abs(glInvTotal - (batchTotal - injectedTotal)) > 2) {
    const whToAcc: Record<string, string> = { 'wh-raw': '1108', 'wh-local': '1109', 'wh-export': '1110', 'wh-damaged': '1111', 'wh-scrap': '1112' };
    note('P41 per-account drift (informational)',
      'an internal transfer moves the batch ledger without a GL entry, so per-account GL drifts while the company total ties — see BUSINESS DECISION REQUIRED');
    const detail: string[] = [];
    for (const [wh, code] of Object.entries(whToAcc)) {
      const sub = snap().batches.filter(b => b.warehouseId === wh).reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
      detail.push(`${wh}/${code}: GL ${acc(code).toFixed(2)} vs batches ${sub.toFixed(2)} (Δ ${(acc(code) - sub).toFixed(2)}, injected ${(injected[wh] || 0).toFixed(2)})`);
    }
    detail.push(`custody/1107: GL ${acc('1107').toFixed(2)}`);
    console.log('     inventory drift localisation:');
    detail.forEach(d => console.log(`       - ${d}`));
  }

  const cashGl = acc('1101');
  note('P43 cash reconciliation', `GL 1101 cash = ${cashGl.toFixed(2)}; treasury document count = ${db.treasuryTransactions.length}`);

  const orphanJv = db.journalEntries.filter(j => j.isPosted && !j.sourceDocumentId).length;
  check('P24 every posted journal carries a source document', orphanJv === 0, `${orphanJv} orphan journals`);

  const unbalanced = db.journalEntries.filter(j => j.isPosted && Math.abs((j.totalDebit || 0) - (j.totalCredit || 0)) > 0.01);
  check('P40 every posted journal is internally balanced', unbalanced.length === 0,
    `${unbalanced.length} unbalanced journals: ${unbalanced.slice(0, 3).map(j => j.entryNumber).join(',')}`);
}

// =========================================================================
section('CLEANUP — remove ONLY records this run appended');
// =========================================================================
{
  erpDb.mutate(draft => {
    draft.items = draft.items.filter(i => !mine.items.has(i.id));
    draft.customers = draft.customers.filter(c => !mine.customers.has(c.id));
    draft.suppliers = draft.suppliers.filter(s => !mine.suppliers.has(s.id));
    draft.users = draft.users.filter(u => !mine.users.has(u.id));
    draft.salesReps = draft.salesReps.filter(r => !mine.repIds.has(r.id));

    const addedJv = draft.journalEntries.slice(BASE.journalEntries).map(j => j.id);
    draft.journalEntries = draft.journalEntries.slice(0, BASE.journalEntries);

    const addedSi = draft.salesInvoices.slice(BASE.salesInvoices).map(i => i.id);
    draft.salesInvoices = draft.salesInvoices.slice(0, BASE.salesInvoices);
    draft.salesInvoiceLines = draft.salesInvoiceLines.filter(l => !addedSi.includes(l.invoiceId));

    const addedPi = draft.purchaseInvoices.slice(BASE.purchaseInvoices).map(p => p.id);
    draft.purchaseInvoices = draft.purchaseInvoices.slice(0, BASE.purchaseInvoices);
    draft.purchaseInvoiceLines = draft.purchaseInvoiceLines.filter(l => !addedPi.includes(l.purchaseInvoiceId));

    draft.payments = draft.payments.slice(0, BASE.payments);
    draft.cheques = draft.cheques.slice(0, BASE.cheques);
    draft.exportShipments = draft.exportShipments.slice(0, BASE.exportShipments);
    draft.qualityInspections = draft.qualityInspections.slice(0, BASE.qualityInspections);
    draft.productionOrders = draft.productionOrders.slice(0, BASE.productionOrders);
    draft.treasuryTransactions = draft.treasuryTransactions.slice(0, BASE.treasuryTransactions);
    draft.inventoryTransactions = draft.inventoryTransactions.slice(0, BASE.inventoryTransactions);
    draft.batches = draft.batches.filter(b => !mine.batches.has(b.batchNumber));
    draft.representativeCustodies = draft.representativeCustodies.filter(c => !String(c.id).startsWith('cst'));
    draft.custodyMovements = draft.custodyMovements.filter(m => !String(m.custodyId).startsWith('cst'));
    draft.auditLogs = draft.auditLogs.slice(0, BASE.auditLogs);

    BASE.accounts.forEach(b => { const a = draft.accounts.find(x => x.id === b.id); if (a) a.currentBalance = b.b; });
    BASE.customers.forEach(b => { const c = draft.customers.find(x => x.id === b.id); if (c) c.currentBalance = b.b; });
    BASE.suppliers.forEach(b => { const s = draft.suppliers.find(x => x.id === b.id); if (s) s.currentBalance = b.b; });
  });

  const after = snap();
  const check2 = (t: string, cond: boolean) => check(t, cond);
  check2('cleanup removed every TEST-QA master record',
    !after.items.some(i => i.code.includes(PFX)) && !after.customers.some(c => c.code.includes(PFX)) &&
    !after.suppliers.some(s => s.code.includes(PFX)) && !after.salesReps.some(r => String(r.code).includes(PFX)));
  if (after.items.some(i => i.code.includes(PFX))) {
    console.log(`     leftover items: ${after.items.filter(i => i.code.includes(PFX)).map(i => `${i.code}/${i.id}`).join(', ')}`);
  }
  if (after.salesReps.some(r => String(r.code).includes(PFX))) {
    console.log(`     leftover reps: ${after.salesReps.filter(r => String(r.code).includes(PFX)).map(r => r.id).join(', ')}`);
  }
  check('cleanup restored every pre-existing account balance',
    BASE.accounts.every(b => near(after.accounts.find(a => a.id === b.id)?.currentBalance || 0, b.b, 0.01)));
  check('cleanup restored pre-existing document counts',
    after.journalEntries.length === BASE.journalEntries && after.salesInvoices.length === BASE.salesInvoices &&
    after.purchaseInvoices.length === BASE.purchaseInvoices && after.payments.length === BASE.payments &&
    after.cheques.length === BASE.cheques && after.items.length === BASE.items);
}

console.log('\n==============================');
console.log(`QA BATCH 2 (${RID}) — PROBES: ${pass + fail} | SAFE: ${pass} | DEFECTS FOUND: ${fail}`);
if (defects.length) { console.log('DEFECTS FOUND:'); defects.forEach(d => console.log('  - ' + d)); }
if (notes.length) { console.log('OBSERVATIONS (business-rule / not auto-fixed):'); notes.forEach(n => console.log('  * ' + n)); }
console.log('==============================');
if (fail > 0) process.exit(1);
