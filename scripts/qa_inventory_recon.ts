// QA BATCH D — PRIORITY 1: per-flow inventory reconciliation probe.
//
// For EVERY inventory-affecting flow it measures, in isolation:
//   Δquantity, Δbatch-ledger value, ΔGL inventory, and the RESIDUAL
//   (ΔGL − Δbatches). A non-zero residual names the exact flow that breaks the
//   identity. Read-only with respect to production data: everything it creates
// is TEST-QA prefixed and cleaned up afterwards.
import { erpDb } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { InventoryEngine } from '../src/services/inventory';
import { WorkflowService } from '../src/services/workflows';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { ensureTestBom } from './qa_test_bom';

const TODAY = new Date().toISOString().split('T')[0];
const RID = `INV-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const snap = () => erpDb.getSnapshot();
const ADMIN = { userId: 'usr-admin', userName: 'QA' };

const INVENTORY_ACCOUNTS = ['1108', '1109', '1110', '1111', '1112', '1107'];
const glInv = () => INVENTORY_ACCOUNTS.reduce((s, c) => s + (snap().accounts.find(a => a.code === c)?.currentBalance || 0), 0);
const batchVal = () => snap().batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
const batchQty = () => snap().batches.reduce((s, b) => s + b.quantity, 0);

const created = { items: new Set<string>(), customers: new Set<string>(), suppliers: new Set<string>(), reps: new Set<string>(), batches: new Set<string>() };
const BASE = {
  journalEntries: snap().journalEntries.length,
  inventoryTransactions: snap().inventoryTransactions.length,
  accounts: snap().accounts.map(a => ({ id: a.id, b: a.currentBalance })),
  batches: snap().batches.map(b => b.id),
};

type Row = { flow: string; dQty: number; dBatch: number; dGl: number; residual: number };
const rows: Row[] = [];

function probe(flow: string, fn: () => void) {
  const q0 = batchQty(), b0 = batchVal(), g0 = glInv();
  let error = '';
  try { fn(); } catch (e) { error = (e as Error).message; }
  const q1 = batchQty(), b1 = batchVal(), g1 = glInv();
  const row: Row = {
    flow, dQty: Number((q1 - q0).toFixed(3)), dBatch: Number((b1 - b0).toFixed(2)),
    dGl: Number((g1 - g0).toFixed(2)), residual: Number(((g1 - g0) - (b1 - b0)).toFixed(2)),
  };
  rows.push(row);
  const flag = Math.abs(row.residual) > 0.05 ? '❌ RESIDUAL' : '✅ ties';
  console.log(`  ${flag}  ${flow.padEnd(34)} Δqty=${String(row.dQty).padStart(10)}  Δbatches=${String(row.dBatch).padStart(13)}  ΔGL=${String(row.dGl).padStart(13)}  residual=${String(row.residual).padStart(12)}${error ? `  [threw: ${error}]` : ''}`);
}

console.log('================================================================');
console.log(`🔬 INVENTORY RECONCILIATION PROBE — ${RID}`);
console.log('================================================================');

const sup = MasterDataService.createSupplier({ code: `${PFX}-SUP`, name: `مورد ${PFX}`, isTest: true, userId: 'usr-admin', userName: 'QA' })!.supplier!;
created.suppliers.add(sup.id);
const cust = MasterDataService.createCustomer({ code: `${PFX}-CUST`, name: `عميل ${PFX}`, customerType: 'retail', channel: 'retail', isTest: true, userId: 'usr-admin', userName: 'QA' })!.customer!;
created.customers.add(cust.id);
const expCust = MasterDataService.createCustomer({ code: `${PFX}-EXPC`, name: `عميل تصدير ${PFX}`, customerType: 'export', channel: 'export', currency: 'USD', isTest: true, userId: 'usr-admin', userName: 'QA' })!.customer!;
created.customers.add(expCust.id);

const chip = snap().items.find(i => i.id === 'item-raw-chip')!;
const fpLocal = snap().items.find(i => i.code === 'FP-SNG-01')!;
const fpExport = snap().items.find(i => i.code === 'FP-DUO-01' && i.itemType === 'finished_product')!;
// BATCH P: the seeded UAT BOMs were deleted, so this probe builds its own test
// BOM for the local finished product via the shared fixture.
const bom = ensureTestBom(fpLocal.id);
const reqs = ManufacturingEngine.calculateBomRequirements(bom.id, 1000);

// ---- 1. purchase receipt
let pinvId = '';
probe('1. purchase receipt (invoice)', () => {
  const inv = WorkflowService.createPurchaseInvoice({
    supplierId: sup.id, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `${PFX}-P1`, date: TODAY,
    lines: [{ itemId: chip.id, quantity: 2000, unitId: 'unit-kg', unitPrice: 60, batchNumber: `${PFX}-CHIP`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (!inv.success) throw new Error(inv.error!);
  pinvId = inv.invoice!.id;
  created.batches.add(`${PFX}-CHIP`);
});

// ---- 2. production LIFECYCLE measured as one unit (issue → output → close),
//         because value legitimately sits in the raw ledger until closure.
let orderId = '';
probe('2. production LIFECYCLE (buy+issue+output+close)', () => {
  const o = ManufacturingEngine.createProductionOrder({
    productId: fpLocal.id, plannedQuantity: 1000, targetMarket: 'local', destinationWarehouseId: 'wh-local',
    expectedCompletionDate: TODAY, isTest: true, ...ADMIN,
  } as never);
  if (!o.success) throw new Error(o.error!);
  orderId = o.order!.id;
  snap().bomLines.filter(l => l.bomId === bom.id).forEach((l, i) => {
    WorkflowService.createPurchaseInvoice({
      supplierId: sup.id, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
      reference: `${PFX}-M${i}`, date: TODAY,
      lines: [{ itemId: l.materialItemId, quantity: Math.ceil(l.quantityRequired * 1.2 * 1000) / 1000, unitId: l.unitId, unitPrice: 50, batchNumber: `${PFX}-M${i}`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
      isTest: true, ...ADMIN,
    } as never);
  });
  const iss = ManufacturingEngine.issueMaterialsToOrder({
    orderId, lines: reqs.map(r => ({ materialItemId: r.materialItemId, quantity: r.requiredQuantity })),
    date: TODAY, ...ADMIN,
  } as never);
  if (!iss.success) throw new Error(iss.error!);
  const p = ManufacturingEngine.recordDailyProduction({
    orderId, goodQuantity: 1000, defectiveQuantity: 0, scrapQuantity: 0, defectiveAction: 'to_scrap',
    date: TODAY, isTest: true, ...ADMIN,
  } as never);
  if (!p.success) throw new Error(p.error!);
  const c = ManufacturingEngine.closeProductionOrder(orderId, 'usr-admin', 'QA');
  if (!c.success) throw new Error(c.error!);
});
{
  const bd = ManufacturingEngine.calculateCostBreakdown(orderId);
  const order = snap().productionOrders.find(o => o.id === orderId)!;
  const prod = snap().items.find(i => i.id === fpLocal.id)!;
  const fgBatch = snap().batches.filter(b => b.itemId === fpLocal.id && b.warehouseId === 'wh-local');
  const fgVal = fgBatch.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
  const closeJv = snap().journalEntries.find(j => j.sourceDocumentType === 'production_order_close');
  const fgCredit = closeJv ? closeJv.lines.filter(l => l.accountId === snap().accounts.find(a => a.code === '1109')?.id).reduce((s, l) => s + (l.debit || 0), 0) : 0;
  console.log(`\n  ── production close forensics ──`);
  console.log(`     breakdown.actualMaterialCost = ${bd.actualMaterialCost.toFixed(2)}`);
  console.log(`     conversion applied           = ${(bd.actualLaborCost + bd.actualElectricityCost + bd.actualGasCost + bd.actualMaintenanceCost + bd.actualSupervisionCost).toFixed(2)}`);
  console.log(`     FG batch value (ledger)      = ${fgVal.toFixed(2)}  (${fgBatch.length} batch(es))`);
  console.log(`     FG GL credit in close entry  = ${fgCredit.toFixed(2)}`);
  console.log(`     difference                   = ${(fgCredit - fgVal).toFixed(2)}`);
  console.log(`     item.standardCost = ${prod.standardCost}  item.actualCost = ${prod.actualCost}  order produced = ${order.producedQuantity}`);
}

// ---- 5. warehouse transfer
probe('5. warehouse transfer WH-01 → WH-02', () => {
  const t = InventoryEngine.transferWarehouse(chip.id, 'wh-raw', 'wh-local', 300, undefined, `${PFX}-CHIP`, `${PFX} transfer`);
  if (!t.success) throw new Error(t.error!);
});

// ---- 6/7/8. representative custody load / sale / return
let custodyId = '';
{
  const repRes = WorkflowService.createSalesRepresentative({ code: `${PFX}-REP`, name: `${PFX} مندوب`, targetMonthlySales: 0, isTest: true, ...ADMIN } as never);
  const repId = repRes.rep!.id; created.reps.add(repId);
  const c = WorkflowService.openRepCustody(repId, `${PFX}`);
  custodyId = c.custody!.id;
  // Custody LIFECYCLE measured as one unit: value moves WH-02 → custody(1107)
  // → COGS and back, so per-step deltas are expected to differ.
  // Custody is measured as CLOSED lifecycles (custody ends empty). While goods sit
  // in a custody they are out of the batch ledger but still carried in GL 1107, so
  // only a completed custody can be compared like-for-like.
  probe('6a. custody LIFECYCLE: load 400 → sell all 400', () => {
    const l = WorkflowService.loadGoodsToRep({ custodyId, itemId: fpLocal.id, quantity: 400, unitPrice: 100, warehouseId: 'wh-local', date: TODAY });
    if (!l.success) throw new Error(l.error!);
    const s = WorkflowService.createSalesInvoice({
      customerId: cust.id, channel: 'retail', warehouseId: 'wh-local', repId, stockSource: 'rep_custody', custodyId,
      paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY,
      lines: [{ itemId: fpLocal.id, quantity: 400, unitPrice: 100, vatRate: 0 }], isTest: true, ...ADMIN,
    } as never);
    if (!s.success) throw new Error(s.error!);
  });
  probe('6b. custody LIFECYCLE: load 200 → return all 200', () => {
    const l = WorkflowService.loadGoodsToRep({ custodyId, itemId: fpLocal.id, quantity: 200, unitPrice: 100, warehouseId: 'wh-local', date: TODAY });
    if (!l.success) throw new Error(l.error!);
    const r = WorkflowService.returnGoodsFromRep({ custodyId, itemId: fpLocal.id, quantity: 200, warehouseId: 'wh-local', date: TODAY });
    if (!r.success) throw new Error(r.error!);
  });
}

// ---- 9. warehouse sale issue
probe('9. warehouse sales issue (COGS)', () => {
  const s = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: 'wh-local', paymentMethod: 'credit',
    currency: 'EGP', exchangeRate: 1, date: TODAY,
    lines: [{ itemId: fpLocal.id, quantity: 50, unitPrice: 100, vatRate: 0 }], isTest: true, ...ADMIN,
  } as never);
  if (!s.success) throw new Error(s.error!);
});

// ---- 10. sales return
let saleInvoiceId = '';
probe('10. sales return (restock)', () => {
  const db = snap();
  const inv = db.salesInvoices.filter(i => i.channel === 'retail' && i.customerId === cust.id).pop()!;
  saleInvoiceId = inv.id;
  const r = WorkflowService.postSalesReturn({
    customerId: cust.id, invoiceId: inv.id, warehouseId: 'wh-local', date: TODAY, reason: `${PFX} return`,
    lines: [{ itemId: fpLocal.id, quantity: 10, unitPrice: 100, vatRate: 0 }], isTest: true, ...ADMIN,
  } as never);
  if (!r.success) throw new Error(r.error!);
});

// ---- 11. purchase return
probe('11. purchase return', () => {
  const r = WorkflowService.postPurchaseReturn({
    supplierId: sup.id, purchaseInvoiceId: pinvId, warehouseId: 'wh-raw', date: TODAY, reason: `${PFX} pret`,
    lines: [{ itemId: chip.id, quantity: 100, batchNumber: `${PFX}-CHIP` }], isTest: true, ...ADMIN,
  } as never);
  if (!r.success) throw new Error(r.error!);
});

// ---- 12. defective / scrap production LIFECYCLE
probe('12. production LIFECYCLE with defective+scrap (QC FAIL path)', () => {
  const o = ManufacturingEngine.createProductionOrder({
    productId: fpLocal.id, plannedQuantity: 100, targetMarket: 'local', destinationWarehouseId: 'wh-local',
    expectedCompletionDate: TODAY, isTest: true, ...ADMIN,
  } as never);
  if (!o.success) throw new Error(o.error!);
  const order2 = o.order!.id;
  const r2 = ManufacturingEngine.calculateBomRequirements(bom.id, 100);
  const iss = ManufacturingEngine.issueMaterialsToOrder({
    orderId: order2, lines: r2.map(r => ({ materialItemId: r.materialItemId, quantity: r.requiredQuantity })),
    date: TODAY, ...ADMIN,
  } as never);
  if (!iss.success) throw new Error(iss.error!);
  const p = ManufacturingEngine.recordDailyProduction({
    orderId: order2, goodQuantity: 80, defectiveQuantity: 15, scrapQuantity: 5, defectiveAction: 'to_scrap',
    wasteReason: `${PFX} هالك`, date: TODAY, isTest: true, ...ADMIN,
  } as never);
  if (!p.success) throw new Error(p.error!);
  const c = ManufacturingEngine.closeProductionOrder(order2, 'usr-admin', 'QA');
  if (!c.success) throw new Error(c.error!);
});

// ---- 14. export LIFECYCLE (stock → USD invoice → shipment → collection)
probe('14. export LIFECYCLE (WH-03 stock+invoice+shipment+collection)', () => {
  // real stock for the export product through a purchase receipt (so GL and batches move together)
  const po = WorkflowService.createPurchaseInvoice({
    supplierId: sup.id, warehouseId: 'wh-export', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `${PFX}-EXPSTOCK`, date: TODAY,
    lines: [{ itemId: fpExport.id, quantity: 30, unitId: 'unit-piece', unitPrice: 40, batchNumber: `${PFX}-EXPB`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (!po.success) throw new Error(po.error!);
  created.batches.add(`${PFX}-EXPB`);
  const inv = WorkflowService.createSalesInvoice({
    customerId: expCust.id, channel: 'export', warehouseId: 'wh-export', paymentMethod: 'credit',
    currency: 'USD', exchangeRate: 50, date: TODAY,
    lines: [{ itemId: fpExport.id, quantity: 20, unitPrice: 10, vatRate: 0 }], taxTreatment: 'exempt',
    isTest: true, ...ADMIN,
  } as never);
  if (!inv.success) throw new Error(inv.error!);
  const s = WorkflowService.createExportShipment({
    customerId: expCust.id, shipmentDate: TODAY, portOfOrigin: 'بورسعيد', destinationPort: 'Jeddah',
    usdRevenue: inv.invoice!.totalAmount, exchangeRate: 50, shippingCost: 100, portCosts: 50, customsCost: 25,
    otherExportCosts: 0, salesInvoiceId: inv.invoice!.id, isTest: true, ...ADMIN,
  } as never);
  if (!s.success) throw new Error(s.error!);
  const col = WorkflowService.recordExportCollection({
    shipmentId: s.shipment!.id, amountUsd: inv.invoice!.totalAmount, actualExchangeRate: 50, date: TODAY,
    isTest: true, ...ADMIN,
  } as never);
  if (!col.success) throw new Error(col.error!);
});

// ---- 16. direct stock count / adjustment
probe('16. inventory count adjustment', () => {
  const c = WorkflowService.postInventoryCount({
    warehouseId: 'wh-raw', date: TODAY, notes: `${PFX} count`, isTest: true, ...ADMIN,
    lines: [{ itemId: chip.id, countedQuantity: InventoryEngine.getItemBalance(chip.id, 'wh-raw') }],
  } as never);
  if (!c.success) throw new Error(c.error!);
});

// ---------------------------------------------------------------- summary
console.log('\n=== RESIDUAL SUMMARY (ΔGL − Δbatches; must be 0.00 for every flow) ===');
const bad = rows.filter(r => Math.abs(r.residual) > 0.05);
rows.forEach(r => console.log(`  ${Math.abs(r.residual) > 0.05 ? '❌' : '✅'} ${r.flow.padEnd(34)} residual=${String(r.residual).padStart(13)}`));
console.log(`\n  flows with a residual: ${bad.length} / ${rows.length}`);
if (bad.length) console.log(`  ${bad.map(b => b.flow).join(' | ')}`);

// ---------------------------------------------------------------- cleanup
erpDb.mutate(draft => {
  draft.items = draft.items.filter(i => !created.items.has(i.id));
  draft.customers = draft.customers.filter(c => !created.customers.has(c.id));
  draft.suppliers = draft.suppliers.filter(s => !created.suppliers.has(s.id));
  draft.salesReps = draft.salesReps.filter(r => !created.reps.has(r.id));
  draft.representativeCustodies = draft.representativeCustodies.filter(c => !String(c.id).startsWith('cst'));
  draft.custodyMovements = draft.custodyMovements.filter(m => !String(m.custodyId).startsWith('cst'));
  draft.journalEntries = draft.journalEntries.slice(0, BASE.journalEntries);
  draft.inventoryTransactions = draft.inventoryTransactions.slice(0, BASE.inventoryTransactions);
  const baseIds = new Set(BASE.batches);
  draft.batches = draft.batches.filter(b => baseIds.has(b.id));
  draft.auditLogs = draft.auditLogs.filter(a => !(String(a.description || '').includes(PFX)));
  BASE.accounts.forEach(b => { const a = draft.accounts.find(x => x.id === b.id); if (a) a.currentBalance = b.b; });
});
const after = snap();
const leftover = after.items.filter(i => i.code.includes(PFX)).length + after.customers.filter(c => c.code.includes(PFX)).length
  + after.suppliers.filter(s => s.code.includes(PFX)).length + after.salesReps.filter(r => String(r.code).includes(PFX)).length;
console.log(`\n  cleanup: leftover TEST-QA master records = ${leftover}; journals back to ${after.journalEntries.length}/${BASE.journalEntries}; balances restored = ${BASE.accounts.every(b => Math.abs((snap().accounts.find(a => a.id === b.id)?.currentBalance || 0) - b.b) < 0.01)}`);
process.exit(bad.length ? 1 : 0);