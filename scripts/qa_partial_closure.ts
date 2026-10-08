// QA BATCH Q — PARTIAL PRODUCTION CLOSURE / FATE OF UNPRODUCED QUANTITY.
//
// FIX 2 REGRESSION HARNESS (it previously only measured the defect).
//
// The question: a production order is planned for 1,000 units, materials are
// issued for the full 1,000, only 700 units are produced, and the order is then
// closed. What happens to the 300 unproduced units and to the raw materials
// that were issued for them?
//
// What is asserted now:
//   • a plain close of a partially produced order is REFUSED (never silent);
//   • only the explicit partial-close workflow (mode + persisted reason +
//     per-material disposition) may close it;
//   • ISSUED = CONSUMED + RETURNED + APPROVED_VARIANCE for EVERY material,
//     derived per material from its own BOM line (never a flat percentage);
//   • returned material goes back to its ORIGINAL batches (lot/expiry intact,
//     no auto-numbered replacement batch);
//   • finished goods are capitalised at the CONSUMED cost only;
//   • GL and the batch ledger tie after the close, every journal balances.
//
// Everything here is EXECUTED through the real service layer
// (MasterDataService / WorkflowService / ManufacturingEngine / InventoryEngine)
// against the in-memory database, then measured. No behaviour is inferred from
// reading the source.
//
// Scenarios executed — each in a FRESH database so warehouse and FIFO figures
// are attributable to that scenario alone:
//   A) 1,000 planned · full issue · 700 good produced · 0 defective · 0 scrap
//   B) 1,000 planned · full issue · 700 good · 15 defective · 5 scrap
//   C) OVER-ISSUE: 1,000 planned · materials issued for 1.4x the plan
//      · 700 good produced  (the "100 KG issued / 70 KG consumed / 30 KG left")
//
// Isolation: every record it creates is TEST-QA prefixed and `isTest: true`.
// Each scenario starts from a pristine `createEmptyDatabase()` + migrations, and
// the ORIGINAL in-memory database is restored at the very end, so the script
// leaves no trace of its own.
import { erpDb, createEmptyDatabase, applyMasterDataMigration, applyUomMigration } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { WorkflowService } from '../src/services/workflows';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { ensureTestBom } from './qa_test_bom';
import type { ERPDatabaseSchema } from '../src/services/db';

const TODAY = new Date().toISOString().split('T')[0];
const RID = `PC-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const ADMIN = { userId: 'usr-admin', userName: 'QA' };
const REASON = 'Customer order reduced — partial production';

// A pristine baseline used to re-seed each scenario in isolation.
const PRISTINE = applyUomMigration(applyMasterDataMigration(createEmptyDatabase()));
const snap = () => erpDb.getSnapshot();

// The EXACT database state this process started with, captured BEFORE anything
// is written, and restored at the very end so the script leaves no trace.
const PRISTINE_LIVE: ERPDatabaseSchema = JSON.parse(JSON.stringify(erpDb.getSnapshot()));

// Inventory-side GL accounts: 1107 custody, 1108 raw, 1109 FG local,
// 1110 FG export, 1111 damaged, 1112 scrap.
const INV_CODES = ['1107', '1108', '1109', '1110', '1111', '1112'];
const glBal = (code: string) => snap().accounts.find(a => a.code === code)?.currentBalance || 0;
const glInv = () => INV_CODES.reduce((s, c) => s + glBal(c), 0);
const batchVal = () => n2(snap().batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0));
const whVal = (itemId: string, whId: string) =>
  n2(snap().batches.filter(b => b.itemId === itemId && b.warehouseId === whId)
    .reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0));
const whQty = (itemId: string, whId: string) =>
  n3(snap().batches.filter(b => b.itemId === itemId && b.warehouseId === whId)
    .reduce((s, b) => s + b.quantity, 0));
function n2(v: number) { return Number(v.toFixed(2)); }
function n3(v: number) { return Number(v.toFixed(3)); }

// ---------------------------------------------------------------- assertions
let pass = 0; let fail = 0;
const findings: string[] = [];
const check = (label: string, ok: boolean, info = '') => {
  if (ok) { pass++; console.log(`  ✅ ${label}${info ? ` — ${info}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${info ? ` — ${info}` : ''}`); }
};
const finding = (id: string, text: string) => { findings.push(`${id}: ${text}`); console.log(`  🟠 FINDING ${id} — ${text}`); };
const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) <= tol;

console.log('='.repeat(96));
console.log(`🔬 PARTIAL PRODUCTION CLOSURE (FIX 2) — ${RID}`);
console.log('='.repeat(96));

// ---------------------------------------------------------------- fixtures
const fp = PRISTINE.items.find(i => i.code === 'FP-SNG-01')!;
// BATCH P removed the seeded BOMs from the product; the fixture rebuilds one.
// It is created against a scratch database first, so its recipe can be read
// without touching the live database this process must leave untouched.
erpDb.restore(JSON.parse(JSON.stringify(PRISTINE)) as ERPDatabaseSchema);
const bom = ensureTestBom(fp.id);
const bomLines = snap().bomLines.filter(l => l.bomId === bom.id);
const matIds = bomLines.map(l => l.materialItemId);
const reqQtyByMat = new Map<string, number>(bomLines.map(l => [l.materialItemId, l.quantityRequired]));
const itemName = (id: string) => PRISTINE.items.find(i => i.id === id)?.nameAr || id;
const itemCode = (id: string) => PRISTINE.items.find(i => i.id === id)?.code || id;

/** Reset to a pristine database so every scenario is measured in isolation. */
function freshDb(): string {
  erpDb.restore(JSON.parse(JSON.stringify(PRISTINE)) as ERPDatabaseSchema);
  ensureTestBom(fp.id);
  const s = MasterDataService.createSupplier({
    code: `${PFX}-SUP`, name: `مورد ${PFX}`, isTest: true, ...ADMIN,
  } as never)!.supplier!;
  return s.id;
}

let SUP_ID = '';

/** Buy `factor` × the 1,000-unit BOM requirement of every material, at 50/unit. */
function stockMaterials(tag: string, factor: number) {
  snap().bomLines.filter(l => l.bomId === bom.id).forEach((l, idx) => {
    const r = WorkflowService.createPurchaseInvoice({
      supplierId: SUP_ID, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
      reference: `${PFX}-${tag}-${idx}`, date: TODAY,
      lines: [{
        itemId: l.materialItemId, quantity: n3(l.quantityRequired * factor),
        unitId: l.unitId, unitPrice: 50, batchNumber: `${PFX}-${tag}-${idx}`,
        productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0,
      }], isTest: true, ...ADMIN,
    } as never);
    if (!r.success) throw new Error(`stock ${tag}/${idx} failed: ${r.error}`);
  });
}

type Run = {
  tag: string; orderId: string; orderNumber: string; planned: number;
  issueFactor: number; good: number; defective: number; scrap: number;
};

function run(r: Omit<Run, 'orderId' | 'orderNumber'>): Run {
  stockMaterials(r.tag, r.issueFactor);
  const o = ManufacturingEngine.createProductionOrder({
    productId: fp.id, plannedQuantity: r.planned, targetMarket: 'local',
    destinationWarehouseId: 'wh-local', expectedCompletionDate: TODAY, isTest: true, ...ADMIN,
  } as never);
  if (!o.success) throw new Error(`order ${r.tag} failed: ${o.error}`);
  const orderId = o.order!.id;

  const reqs = ManufacturingEngine.calculateBomRequirements(o.order!.bomId!, r.planned);
  const iss = ManufacturingEngine.issueMaterialsToOrder({
    orderId,
    lines: reqs.map(x => ({ materialItemId: x.materialItemId, quantity: n3(x.requiredQuantity * r.issueFactor) })),
    date: TODAY, ...ADMIN,
  } as never);
  if (!iss.success) throw new Error(`issue ${r.tag} failed: ${iss.error}`);

  const p = ManufacturingEngine.recordDailyProduction({
    orderId, goodQuantity: r.good, defectiveQuantity: r.defective, scrapQuantity: r.scrap,
    defectiveAction: 'to_scrap', wasteReason: `${PFX} هالك`, date: TODAY, isTest: true, ...ADMIN,
  } as never);
  if (!p.success) throw new Error(`production ${r.tag} failed: ${p.error}`);
  return { ...r, orderId, orderNumber: o.order!.orderNumber };
}

type Meters = {
  rawValue: number; fgValue: number; damagedValue: number; scrapValue: number; custody: number;
  glInv: number; batchTotal: number; gl: Record<string, number>;
};

function meter(_x: Run): Meters {
  const gl: Record<string, number> = {};
  INV_CODES.forEach(c => { gl[c] = glBal(c); });
  const prod = snap().batches.filter(b => String(b.batchNumber || '').startsWith(`PRD-${_x.orderNumber}-`));
  const sum = (l: typeof prod) => n2(l.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0));
  return {
    rawValue: n2(matIds.reduce((s, m) => s + whVal(m, 'wh-raw'), 0)),
    fgValue: sum(prod.filter(b => b.warehouseId === 'wh-local')),
    damagedValue: sum(prod.filter(b => b.warehouseId === 'wh-damaged')),
    scrapValue: sum(prod.filter(b => b.warehouseId === 'wh-scrap')),
    custody: glBal('1107'),
    glInv: n2(glInv()),
    batchTotal: batchVal(),
    gl,
  };
}

function orderFields(orderId: string) {
  const o = snap().productionOrders.find(x => x.id === orderId)!;
  return {
    status: o.status, planned: o.plannedQuantity, produced: o.producedQuantity,
    defective: o.defectiveQuantity, scrap: o.scrapQuantity, remaining: o.remainingQuantity,
    completion: o.actualCompletionDate || '-', closeMode: o.closeMode || '-',
    closeReason: o.closeReason || '-',
    reconciliation: o.materialReconciliation || [],
  };
}

/** The disposition set a caller must supply for a partial close. */
const dispositionsOf = (orderId: string) =>
  ManufacturingEngine.getMaterialReconciliation(orderId)
    .filter(r => r.remainderQuantity > 0)
    .map(r => ({ materialItemId: r.materialItemId, returnQuantity: r.remainderQuantity }));

const closePartial = (orderId: string) =>
  ManufacturingEngine.closeProductionOrder(orderId, 'usr-admin', 'QA', {
    mode: 'partial', reason: REASON, dispositions: dispositionsOf(orderId),
  });
const closePlain = (orderId: string) =>
  ManufacturingEngine.closeProductionOrder(orderId, 'usr-admin', 'QA');

/** Per-material ledger for one order, from its OWN transactions. */
function materialTable(x: Run) {
  const db = snap();
  const cs = db.productionConsumptions.filter(c => c.productionOrderId === x.orderId);
  const rets = db.inventoryTransactions.filter(
    t => t.documentNumber === x.orderNumber && String(t.movementType) === 'production_return');
  const waste = db.productionWastes.filter(w => w.productionOrderId === x.orderId);
  console.log(`\n  PER RAW MATERIAL — scenario ${x.tag}`);
  console.log(`     ${'Item'.padEnd(29)}${'Issued'.padStart(10)}${'Returned'.padStart(10)}${'Consumed'.padStart(10)}${'Waste'.padStart(7)}   Final location of the returned quantity`);
  const rows = matIds.map(m => {
    const c = cs.filter(z => z.materialItemId === m);
    const issuedQty = n3(c.reduce((s, z) => s + z.actualQuantity, 0));
    const issuedVal = n2(c.reduce((s, z) => s + z.actualQuantity * z.unitCost, 0));
    const r = rets.filter(z => z.itemId === m);
    const retQty = n3(r.reduce((s, z) => s + (z.quantityIn || 0), 0));
    const retVal = n2(r.reduce((s, z) => s + (z.totalCost || 0), 0));
    const wstQty = n3(waste.filter(z => z.materialItemId === m).reduce((s, z) => s + z.quantity, 0));
    const loc = r.length ? r.map(z => `${z.warehouseId} / batch ${z.batchNumber}`).join(', ') : '— (never left WH-01)';
    console.log(`     ${`${itemCode(m)} ${itemName(m)}`.slice(0, 28).padEnd(29)}${String(issuedQty).padStart(10)}${String(retQty).padStart(10)}`
      + `${String(n3(issuedQty - retQty)).padStart(10)}${String(wstQty).padStart(7)}   ${loc}`);
    return { m, issuedQty, issuedVal, retQty, retVal, loc };
  });
  const totIssued = n2(rows.reduce((s, r) => s + r.issuedVal, 0));
  const totRet = n2(rows.reduce((s, r) => s + r.retVal, 0));
  console.log(`     ${'TOTAL value (EGP)'.padEnd(29)}${String(totIssued).padStart(10)}${String(totRet).padStart(10)}`
    + `${String(n2(totIssued - totRet)).padStart(10)}`);
  return { rows, totIssued, totRet };
}

/** Print the close journal and the batch movements the close created. */
function closeForensics(x: Run) {
  const db = snap();
  const jv = db.journalEntries.filter(j => j.sourceDocumentType === 'production_order_close' && j.sourceDocumentId === x.orderId);
  console.log(`\n  JOURNAL ENTRIES posted by the close: ${jv.length}`);
  jv.forEach(j => {
    const dr = n2(j.lines.reduce((s, l) => s + l.debit, 0));
    const cr = n2(j.lines.reduce((s, l) => s + l.credit, 0));
    console.log(`     ${j.reference}  [${j.sourceDocumentType}]  Dr=${dr.toFixed(2)}  Cr=${cr.toFixed(2)}  balanced=${near(dr, cr, 0.02)}`);
    j.lines.forEach(l => console.log(`        ${l.accountCode}  ${l.accountNameAr.slice(0, 32).padEnd(34)} Dr ${n2(l.debit).toFixed(2).padStart(13)}  Cr ${n2(l.credit).toFixed(2).padStart(13)}`));
  });
  const returns = db.inventoryTransactions.filter(t => t.documentNumber === x.orderNumber && String(t.movementType) === 'production_return');
  console.log(`\n  BATCH MOVEMENTS created by the close: ${returns.length} production_return transactions`);
  returns.forEach(t => console.log(`     ${itemCode(t.itemId).padEnd(13)} in=${String(t.quantityIn).padStart(9)} @${(t.unitCost || 0).toFixed(4)} = ${n2(t.totalCost || 0).toFixed(2).padStart(12)}  → ${t.warehouseId} / ${t.batchNumber}`));
  const origBatches = new Set(db.batches.filter(b => String(b.batchNumber || '').startsWith(PFX)).map(b => b.batchNumber));
  const retToNew = returns.filter(t => !origBatches.has(String(t.batchNumber)));
  return { jv, returns, retToNew };
}

/** The shared FIX 2 assertions every scenario must satisfy. */
function assertPartialClose(x: Run, tag: string, metersAfter: Meters) {
  const ord = orderFields(x.orderId);
  const recon = snap().productionOrders.find(o => o.id === x.orderId)!.materialReconciliation || [];
  check(`${tag} the closure mode is PARTIAL and its reason is persisted`,
    ord.closeMode === 'partial' && ord.closeReason === REASON,
    `mode=${ord.closeMode} reason="${ord.closeReason}"`);
  check(`${tag} status = completed and the output quantities are unchanged`,
    ord.status === 'completed' && ord.produced === x.good
    && ord.defective === x.defective && ord.scrap === x.scrap,
    `status=${ord.status} produced=${ord.produced} defective=${ord.defective} scrap=${ord.scrap}`);
  check(`${tag} a reconciliation row exists for EVERY material`,
    recon.length === matIds.length, `rows=${recon.length} / materials=${matIds.length}`);
  check(`${tag} IDENTITY holds for every material: issued = consumed + returned + approvedVariance`,
    recon.length > 0 && recon.every(r => near(r.issuedQuantity, r.consumedQuantity + r.returnedQuantity + r.approvedVarianceQuantity, 0.001)),
    recon.map(r => `${itemCode(r.materialItemId)}: ${n3(r.issuedQuantity)} = ${n3(r.consumedQuantity)} + ${n3(r.returnedQuantity)} + ${n3(r.approvedVarianceQuantity)}`).join(' | '));

  const forensics = closeForensics(x);
  check(`${tag} exactly ONE closure journal is posted (no duplicate posting)`,
    forensics.jv.length === 1, `journals=${forensics.jv.length}`);
  check(`${tag} the closing journal balances (SUM(debits) = SUM(credits))`,
    forensics.jv.every(j => near(j.lines.reduce((s, l) => s + l.debit, 0), j.lines.reduce((s, l) => s + l.credit, 0), 0.02)));
  check(`${tag} returned material goes back to its ORIGINAL batches (no new batch number)`,
    forensics.retToNew.length === 0,
    forensics.retToNew.length === 0 ? `${forensics.returns.length} return(s) into original batches`
      : `NEW batch: ${forensics.retToNew.map(t => t.batchNumber).join(', ')}`);

  // GL ↔ batch ledger: the absolute balances must agree after the close.
  check(`${tag} INVENTORY SUBLEDGER ties to GL after the close (residual 0.00)`,
    near(metersAfter.glInv, metersAfter.batchTotal, 0.05),
    `GL=${metersAfter.glInv.toFixed(2)} batches=${metersAfter.batchTotal.toFixed(2)} residual=${n2(metersAfter.glInv - metersAfter.batchTotal)}`);
  return forensics;
}

// ============================================================================
// SCENARIO A — 1,000 planned · full issue · 700 produced · close
// ============================================================================
console.log('\n' + '='.repeat(96));
console.log('SCENARIO A — planned 1,000 · issue for 1,000 · produce 700 good · close');
console.log('='.repeat(96));
SUP_ID = freshDb();

const A = run({ tag: 'A', planned: 1000, issueFactor: 1, good: 700, defective: 0, scrap: 0 });
const aBefore = meter(A);
const aBeforeOrd = orderFields(A.orderId);
{
  const cs = snap().productionConsumptions.filter(c => c.productionOrderId === A.orderId);
  console.log(`\n  BEFORE CLOSE`);
  console.log(`     status / planned / produced / defective / scrap / unproduced`);
  console.log(`       = ${aBeforeOrd.status} / ${aBeforeOrd.planned} / ${aBeforeOrd.produced} / ${aBeforeOrd.defective} / ${aBeforeOrd.scrap} / ${aBeforeOrd.remaining}`);
  console.log(`     issue (consumption) lines = ${cs.length}, qty = ${n3(cs.reduce((s, c) => s + c.actualQuantity, 0))}, FIFO value = ${n2(cs.reduce((s, c) => s + c.actualQuantity * c.unitCost, 0))}`);
  console.log(`     raw material batch quantities / value in WH-01 = ${matIds.map(m => `${itemCode(m)}:${whQty(m, 'wh-raw')}`).join(' ')}`);
  console.log(`     raw material inventory value (batch ledger)  = ${aBefore.rawValue}`);
  console.log(`     FG batch value (batch ledger)                = ${aBefore.fgValue}`);
  console.log(`     GL: ${INV_CODES.map(c => `${c}=${aBefore.gl[c].toFixed(2)}`).join('  ')}`);
  console.log(`     total inventory GL = ${aBefore.glInv}   total batch ledger = ${aBefore.batchTotal}`);
}

// ---- FIX 2: the plain close must be refused first ------------------------
const aPlain = closePlain(A.orderId);
console.log(`\n  PLAIN CLOSE: ${aPlain.success ? '❌ ALLOWED (defect)' : `✅ REFUSED — ${aPlain.error}`}`);
check('A a plain close of a 1,000 planned / 700 produced order is BLOCKED',
  !aPlain.success && /كامر|كأمر/.test(aPlain.error || ''), aPlain.success ? 'ACCEPTED' : String(aPlain.error));
check('A the order is still OPEN after the refused close',
  orderFields(A.orderId).status !== 'completed', orderFields(A.orderId).status);

const aClose = closePartial(A.orderId);
const aAfter = meter(A);
const aAfterOrd = orderFields(A.orderId);
{
  console.log(`\n  PARTIAL CLOSE: ${aClose.success ? '✅ CLOSED' : `❌ REFUSED — ${aClose.error}`}`);
  console.log(`\n  AFTER CLOSE`);
  console.log(`     status / produced / unproduced / completion = ${aAfterOrd.status} / ${aAfterOrd.produced} / ${aAfterOrd.remaining} / ${aAfterOrd.completion}`);
  console.log(`     mode / reason = ${aAfterOrd.closeMode} / "${aAfterOrd.closeReason}"`);
  console.log(`     raw material inventory value (WH-01) = ${aAfter.rawValue}   Δ = ${n2(aAfter.rawValue - aBefore.rawValue)}`);
  console.log(`     FG batch value                       = ${aAfter.fgValue}   Δ = ${n2(aAfter.fgValue - aBefore.fgValue)}`);
  console.log(`     GL deltas: ${INV_CODES.map(c => `${c}: Δ${n2(aAfter.gl[c] - aBefore.gl[c]).toFixed(2)}`).join('  ')}`);
}

check('A the partial close SUCCEEDS with an explicit reason and dispositions',
  aClose.success === true, aClose.success ? 'closed' : String(aClose.error));
const aMat = materialTable(A);
const aForensics = assertPartialClose(A, 'A', aAfter);
check('A unused materials were returned to WH-01 by an explicit disposition',
  aMat.totRet > 0, `returned ${aMat.totRet} of issued ${aMat.totIssued}`);

{
  const recon = ManufacturingEngine.getMaterialReconciliation(A.orderId);
  const consumedCost = recon.reduce((s, r) => s + r.consumedCost, 0);
  const issuedCost = recon.reduce((s, r) => s + r.issuedCost, 0);
  check('A finished goods are capitalised at the CONSUMED cost, not the whole issue',
    near(aAfter.fgValue, consumedCost, 0.05),
    `FG batches=${aAfter.fgValue.toFixed(2)} vs consumed ${consumedCost.toFixed(2)} (issued ${issuedCost.toFixed(2)})`);
  const fgJv = aForensics.jv.reduce((s, j) => s + j.lines.filter(l => l.accountCode === '1109').reduce((x, l) => x + (l.debit || 0), 0), 0);
  check('A GL 1109 was debited with the same consumed amount',
    near(fgJv, consumedCost, 0.05), `1109=${fgJv.toFixed(2)} vs consumed ${consumedCost.toFixed(2)}`);
}

// ============================================================================
// SCENARIO B — 700 good + 15 defective + 5 scrap (unproduced = 285)
// ============================================================================
console.log('\n' + '='.repeat(96));
console.log('SCENARIO B — planned 1,000 · full issue · 700 good + 15 defective + 5 scrap · close');
console.log('='.repeat(96));
SUP_ID = freshDb();

const B = run({ tag: 'B', planned: 1000, issueFactor: 1, good: 700, defective: 15, scrap: 5 });
const bBefore = meter(B);
const bBeforeOrd = orderFields(B.orderId);
const bPlain = closePlain(B.orderId);
const bClose = closePartial(B.orderId);
const bAfter = meter(B);
const bAfterOrd = orderFields(B.orderId);
{
  console.log(`\n  before: status=${bBeforeOrd.status} produced=${bBeforeOrd.produced} defective=${bBeforeOrd.defective} scrap=${bBeforeOrd.scrap} unproduced=${bBeforeOrd.remaining}`);
  console.log(`  plain close : ${bPlain.success ? '❌ ALLOWED (defect)' : `✅ REFUSED — ${bPlain.error}`}`);
  console.log(`  partial close: ${bClose.success ? '✅ CLOSED' : `❌ ${bClose.error}`}`);
  console.log(`  after : status=${bAfterOrd.status} produced=${bAfterOrd.produced} mode=${bAfterOrd.closeMode}`);
  console.log(`  GL 1111 damaged=${bAfter.gl['1111']}   GL 1112 scrap=${bAfter.gl['1112']}   damaged batches=${bAfter.damagedValue}  scrap batches=${bAfter.scrapValue}`);

  check('B a plain close of the partial order is BLOCKED', !bPlain.success, bPlain.success ? 'ACCEPTED' : String(bPlain.error));
  check('B the partial close succeeds', bClose.success === true, bClose.success ? 'closed' : String(bClose.error));
  check('B defective and scrap were routed to their own warehouses and accounts',
    bAfter.damagedValue > 0 && bAfter.scrapValue > 0 && bAfter.gl['1111'] > 0 && bAfter.gl['1112'] > 0,
    `damaged batches=${bAfter.damagedValue} scrap batches=${bAfter.scrapValue}`);
  const bMat = materialTable(B);
  check('B unused materials were returned by an explicit disposition', bMat.totRet > 0,
    `returned ${bMat.totRet} of issued ${bMat.totIssued}`);
  assertPartialClose(B, 'B', bAfter);
}

// ============================================================================
// SCENARIO C — OVER-ISSUE: 100 KG issued / 70 KG consumed / 30 KG remaining
// ============================================================================
console.log('\n' + '='.repeat(96));
console.log('SCENARIO C — OVER-ISSUE: planned 1,000 · materials issued for 1.4× the plan · 700 produced');
console.log('='.repeat(96));
SUP_ID = freshDb();

const C = run({ tag: 'C', planned: 1000, issueFactor: 1.4, good: 700, defective: 0, scrap: 0 });
const cIssued = snap().productionConsumptions.filter(x => x.productionOrderId === C.orderId);
const cIssuedQty = n3(cIssued.reduce((s, c) => s + c.actualQuantity, 0));
const cIssuedVal = n2(cIssued.reduce((s, c) => s + c.actualQuantity * c.unitCost, 0));
// What the 700 produced units actually need = the 1,000-unit requirement × 70%.
const cNeededQty = n3(matIds.reduce((s, m) => s + (reqQtyByMat.get(m) || 0), 0) * 0.7);
const cFlat30 = n3(cIssuedQty * 0.3);
const cBefore = meter(C);
const cBeforeOrd = orderFields(C.orderId);
const cPlain = closePlain(C.orderId);
const cClose = closePartial(C.orderId);
const cAfter = meter(C);
const cAfterOrd = orderFields(C.orderId);
{
  const cRet = snap().inventoryTransactions.filter(t => t.documentNumber === C.orderNumber && String(t.movementType) === 'production_return');
  const retQty = n3(cRet.reduce((s, t) => s + (t.quantityIn || 0), 0));
  const retVal = n2(cRet.reduce((s, t) => s + (t.totalCost || 0), 0));
  const stranded = n3(cIssuedQty - retQty - cNeededQty);
  console.log(`\n  before close: status=${cBeforeOrd.status} produced=${cBeforeOrd.produced} unproduced=${cBeforeOrd.remaining}`);
  console.log(`  ISSUED to the order                       : ${cIssuedQty}  (1.4× the 1,000-unit plan)  value ${cIssuedVal}`);
  console.log(`  CONSUMED — what 700 units actually need   : ${cNeededQty}`);
  console.log(`  RETURNED to WH-01 by the explicit disposition: ${retQty}  value ${retVal}`);
  console.log(`  STRANDED — issued, not returned, not used : ${stranded}`);
  console.log(`  a FLAT 1 − 700/1000 = 30% return would have been: ${cFlat30}`);
  console.log(`  plain close  : ${cPlain.success ? '❌ ALLOWED (defect)' : `✅ REFUSED — ${cPlain.error}`}`);
  console.log(`  partial close: ${cClose.success ? '✅ CLOSED' : `❌ ${cClose.error}`}`);
  console.log(`  after : status=${cAfterOrd.status} produced=${cAfterOrd.produced}`);
  materialTable(C);

  check('C a plain close of the partial order is BLOCKED', !cPlain.success, cPlain.success ? 'ACCEPTED' : String(cPlain.error));
  check('C the over-issued order closes only through the partial-close workflow',
    cClose.success === true, cClose.success ? 'closed' : String(cClose.error));
  check('C the return is derived from each material\'s own BOM line, NOT a flat 30% of issued',
    near(retQty, cNeededQty, 0.5) && !near(retQty, cFlat30, 0.5),
    `returned ${retQty} = the 700-unit requirement (${cNeededQty}); a flat 30% would be ${cFlat30}`);
  check('C no over-issued material is left stranded on the order', near(stranded, 0, 0.5),
    `stranded=${stranded}`);
  check('C the FG batch value is identical to the non-over-issued scenario A',
    near(cAfter.fgValue, aAfter.fgValue, 0.05),
    `C=${cAfter.fgValue.toFixed(2)} vs A=${aAfter.fgValue.toFixed(2)} (over-issue does not inflate FG)`);
  assertPartialClose(C, 'C', cAfter);
}

// ============================================================================
// SUMMARY
// ============================================================================
console.log('\n' + '='.repeat(96));
console.log(`RESULT — ${pass} passed, ${fail} failed`);
console.log('='.repeat(96));
if (findings.length > 0) {
  console.log('\nOPEN FINDINGS:');
  findings.forEach(f => console.log(`  🟠 ${f}`));
} else {
  console.log('\nNo open findings.');
}

// ---------------------------------------------------------------- cleanup
// Restore the exact in-memory database this process started with.
erpDb.restore(PRISTINE_LIVE);
const after = snap();
const leftovers = after.suppliers.filter(s => String(s.code).includes(PFX)).length
  + after.batches.filter(b => String(b.batchNumber || '').includes(PFX)).length;
const restored = JSON.stringify(after) === JSON.stringify(PRISTINE_LIVE);
console.log(`\n  cleanup: the original in-memory database is byte-identical to the pre-run state = ${restored}`
  + `; leftover TEST-QA records = ${leftovers}`);
process.exit(fail || leftovers || !restored ? 1 : 0);
