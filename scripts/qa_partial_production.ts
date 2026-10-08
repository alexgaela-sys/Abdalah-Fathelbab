// PERMANENT REGRESSION — PARTIAL (STAGED) PRODUCTION COSTING, 400 → 600.
//
// Root cause this locks down: `ManufacturingEngine.recordDailyProduction` divided
// the order's CUMULATIVE actual cost (every consumption row + every conversion
// entry on the order) by the units of the CURRENT stage only. Producing 400 and
// then 600 therefore charged the 400 units twice:
//
//   stage 1: 121,887.35 / 400 = 304.718375  → batch 121,887.35   (correct)
//   stage 2: 304,718.35 / 600 = 507.863917  → batch 304,718.35   (stage 1 re-charged)
//   batches 426,605.70   vs order actual cost 304,718.35 → residual −121,887.35
//   (GL capitalisation at closure is the cumulative cost, so the break is permanent)
//
// The rule now is INCREMENTAL per stage, and this suite asserts:
//   1. stage 1 carries only the first stage's share, stage 2 only its own;
//   2. the two batches together equal the order's cumulative actual cost;
//   3. the batch ledger equals the FG GL capitalisation posted at closure (residual 0);
//   4. 400 + 600 costs exactly what producing 1,000 in ONE stage costs;
//   5. the single-stage path is untouched (unit cost = cumulative cost / units).
//
// Read-only with respect to production data: everything it creates is TEST-QA
// prefixed and removed afterwards; balances, journals and batches are restored.
import { erpDb } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { WorkflowService } from '../src/services/workflows';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { AccountingEngine } from '../src/services/accounting';
import { ensureTestBom, firstFinishedProductId } from './qa_test_bom';

const TODAY = new Date().toISOString().split('T')[0];
const RID = `PP-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const snap = () => erpDb.getSnapshot();
const ADMIN = { userId: 'usr-admin', userName: 'QA' };

const FG_ACC = AccountingEngine.getMappedAccountId('inventory_finished_local', 'acc-1109');
const BASE = {
  journalEntries: snap().journalEntries.length,
  inventoryTransactions: snap().inventoryTransactions.length,
  accounts: snap().accounts.map(a => ({ id: a.id, b: a.currentBalance })),
  batches: snap().batches.map(b => b.id),
  items: snap().items.map(i => ({ id: i.id, actualCost: i.actualCost })),
};

let pass = 0; let fail = 0;
const check = (label: string, ok: boolean, info = '') => {
  if (ok) { pass++; console.log(`  ✅ ${label}${info ? ` — ${info}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${info ? ` — ${info}` : ''}`); }
};
const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) <= tol;
const DAY = (back: number) => {
  const d = new Date();
  d.setDate(d.getDate() - back);
  return d.toISOString().split('T')[0];
};

/** Total value of the finished-goods batches this order produced, by batch prefix. */
const fgBatchValue = (orderNumber: string) =>
  snap().batches
    .filter(b => String(b.batchNumber || '').startsWith(`PRD-${orderNumber}-`))
    .reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
const fgBatchQty = (orderNumber: string) =>
  snap().batches
    .filter(b => String(b.batchNumber || '').startsWith(`PRD-${orderNumber}-`))
    .reduce((s, b) => s + b.quantity, 0);
/** FG debit actually capitalised by THIS order's closing journal. */
const fgGlCapitalised = (orderId: string) =>
  snap().journalEntries
    .filter(j => j.sourceDocumentType === 'production_order_close' && j.sourceDocumentId === orderId)
    .reduce((s, j) => s + j.lines.filter(l => l.accountId === FG_ACC).reduce((x, l) => x + (l.debit || 0), 0), 0);

console.log('================================================================');
console.log(`🧪 PERMANENT REGRESSION — STAGED PRODUCTION 400 → 600 — ${RID}`);
console.log('================================================================');

const sup = MasterDataService.createSupplier({
  code: `${PFX}-SUP`, name: `مورد ${PFX}`, isTest: true, ...ADMIN,
} as never)!.supplier!;

const fp = snap().items.find(i => i.code === 'FP-SNG-01')!;
const bom = ensureTestBom(fp.id);

/** Stock every BOM component in its OWN batch at a fixed 50/unit, per order. */
function stockMaterials(tag: string) {
  snap().bomLines.filter(l => l.bomId === bom.id).forEach((l, idx) => {
    const r = WorkflowService.createPurchaseInvoice({
      supplierId: sup.id, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
      reference: `${PFX}-MAT-${tag}-${idx}`, date: TODAY,
      lines: [{
        itemId: l.materialItemId, quantity: Math.ceil(l.quantityRequired * 1.2 * 1000) / 1000,
        unitId: l.unitId, unitPrice: 50, batchNumber: `${PFX}-MAT-${tag}-${idx}`,
        productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0,
      }], isTest: true, ...ADMIN,
    } as never);
    if (!r.success) throw new Error(`material stock ${tag}/${idx} failed: ${r.error}`);
  });
}

type Run = { orderId: string; orderNumber: string; qty: number; stageQty: number[]; issueEachStage: boolean };
function run(tag: string, stageQty: number[], issueEachStage: boolean): Run {
  const planned = stageQty.reduce((a, b) => a + b, 0);
  stockMaterials(tag);
  const o = ManufacturingEngine.createProductionOrder({
    productId: fp.id, plannedQuantity: planned, targetMarket: 'local',
    destinationWarehouseId: 'wh-local', expectedCompletionDate: TODAY, isTest: true, ...ADMIN,
  } as never);
  if (!o.success) throw new Error(`order ${tag} failed: ${o.error}`);
  const orderId = o.order!.id;

  stageQty.forEach((qty, stage) => {
    // Each stage is posted on its own day, so its finished goods land in its own
    // batch (`PRD-<order>-<date>`) and the per-stage valuation is directly visible
    // in the batch ledger rather than being averaged into a single layer.
    const stageDate = DAY(stageQty.length - 1 - stage);
    // issue this stage's own share of the BOM, or the whole thing up-front
    const reqs = ManufacturingEngine.calculateBomRequirements(o.order!.bomId!, issueEachStage ? qty : planned);
    const iss = ManufacturingEngine.issueMaterialsToOrder({
      orderId, lines: reqs.map(r => ({ materialItemId: r.materialItemId, quantity: Math.round(r.requiredQuantity * 1000) / 1000 })),
      date: stageDate, ...ADMIN,
    } as never);
    if (!iss.success) throw new Error(`issue ${tag} stage ${stage + 1} failed: ${iss.error}`);
    const p = ManufacturingEngine.recordDailyProduction({
      orderId, goodQuantity: qty, defectiveQuantity: 0, scrapQuantity: 0,
      defectiveAction: 'to_scrap', date: stageDate, isTest: true, ...ADMIN,
    } as never);
    if (!p.success) throw new Error(`production ${tag} stage ${stage + 1} failed: ${p.error}`);
  });

  const c = ManufacturingEngine.closeProductionOrder(orderId, 'usr-admin', 'QA');
  if (!c.success) throw new Error(`close ${tag} failed: ${c.error}`);
  return { orderId, orderNumber: o.order!.orderNumber, qty: planned, stageQty, issueEachStage };
}

// ---------------------------------------------------------------------------
// A) the failing case: 400 then 600, materials issued per stage (40% / 60%)
// B) the control:      1,000 in ONE stage, materials issued up-front
// ---------------------------------------------------------------------------
const staged = run('A', [400, 600], true);
const single = run('B', [1000], false);

console.log('\n── A) 400 → 600 staged production ──');
{
  const order = snap().productionOrders.find(o => o.id === staged.orderId)!;
  const bd = ManufacturingEngine.calculateCostBreakdown(staged.orderId);
  const conversion = bd.actualLaborCost + bd.actualElectricityCost + bd.actualGasCost
    + bd.actualMaintenanceCost + bd.actualSupervisionCost;
  const cumulative = bd.actualMaterialCost + conversion;
  const batches = fgBatchValue(staged.orderNumber);
  const gl = fgGlCapitalised(staged.orderId);
  const oneStageBatches = fgBatchValue(single.orderNumber);
  const oneStageGl = fgGlCapitalised(single.orderId);
  const oneStageBd = ManufacturingEngine.calculateCostBreakdown(single.orderId);

  console.log(`     order actual material        = ${bd.actualMaterialCost.toFixed(2)}`);
  console.log(`     order conversion applied     = ${conversion.toFixed(2)}`);
  console.log(`     order cumulative actual cost = ${cumulative.toFixed(2)}`);
  const prodBatches = snap().batches.filter(b => String(b.batchNumber || '').startsWith(`PRD-${staged.orderNumber}-`));
  console.log(`     stage batches               = ${prodBatches.map(b => `${b.quantity} @ ${(b.unitCost || 0).toFixed(6)} = ${(b.quantity * (b.unitCost || 0)).toFixed(2)}`).join('   |   ')}`);

  // 1/2. batch valuation: every stage carries ONLY its own incremental share.
  // stage 1 books the cost it actually incurred (materials issued for it +
  // conversion applied at 400 produced); stage 2 books exactly what is left.

  check('A two finished-goods batches exist (one per stage)', prodBatches.length === 2, `batches=${prodBatches.length}`);
  check('A stage quantities are 400 and 600',
    prodBatches.some(b => near(b.quantity, 400, 0.001)) && prodBatches.some(b => near(b.quantity, 600, 0.001)),
    prodBatches.map(b => `${b.quantity}@${(b.unitCost || 0).toFixed(6)}`).join(' + '));

  const b400 = prodBatches.find(b => near(b.quantity, 400, 0.001))!;
  const b600 = prodBatches.find(b => near(b.quantity, 600, 0.001))!;
  const stage1Cost = 400 * (b400.unitCost || 0);
  const stage2Cost = 600 * (b600.unitCost || 0);
  // stage 1 booked the cost it actually incurred (40% of the materials it issued,
  // plus the conversion applied at 400 produced) — not a share of the whole order.
  check('A stage-1 (400) batch holds only what stage 1 itself cost',
    stage1Cost < cumulative && stage1Cost > cumulative * 0.3 && stage1Cost < cumulative * 0.5,
    `stage1=${stage1Cost.toFixed(2)} of order ${cumulative.toFixed(2)} (${((stage1Cost / cumulative) * 100).toFixed(2)}% — must be ≈40%, the share it consumed)`);
  // stage 2 holds EXACTLY the remainder of the order cost — nothing more.
  check('A stage-2 (600) batch holds exactly the remaining order cost',
    near(stage2Cost, cumulative - stage1Cost, 0.005),
    `stage2=${stage2Cost.toFixed(2)} remaining=${(cumulative - stage1Cost).toFixed(2)} residual=${(stage2Cost - (cumulative - stage1Cost)).toFixed(2)}`);
  check('A stage 400 + stage 600 = the order cumulative actual cost (EXACT, residual 0.00)',
    near(stage1Cost + stage2Cost, cumulative, 0.005),
    `${stage1Cost.toFixed(2)} + ${stage2Cost.toFixed(2)} = ${(stage1Cost + stage2Cost).toFixed(2)} vs order ${cumulative.toFixed(2)} residual=${(stage1Cost + stage2Cost - cumulative).toFixed(2)}`);
  check('A 400 + 600 batch ledger = the order cumulative actual cost (EXACT, residual 0.00)',
    near(batches, cumulative, 0.005),
    `batches=${batches.toFixed(2)} orderCost=${cumulative.toFixed(2)} residual=${(batches - cumulative).toFixed(2)}`);

  // 3. GL reconciliation: the batches must equal what was capitalised at closure
  check('A batch ledger ties to the FG GL capitalised at closure (residual 0.00)',
    near(batches, gl, 0.005),
    `batches=${batches.toFixed(2)} GL1109=${gl.toFixed(2)} residual=${(batches - gl).toFixed(2)}`);
  check('A produced quantity is 1,000 with no duplicate output',
    near(order.producedQuantity, 1000, 0.001) && near(fgBatchQty(staged.orderNumber), 1000, 0.001),
    `order=${order.producedQuantity} batches=${fgBatchQty(staged.orderNumber)}`);

  // 4. equivalence with the one-stage run
  check('A cumulative actual cost = the one-stage equivalent cost',
    near(cumulative, oneStageBd.totalActualCost, 0.005),
    `staged=${cumulative.toFixed(2)} oneStage=${oneStageBd.totalActualCost.toFixed(2)}`);
  check('A total FG batch value = the one-stage FG batch value',
    near(batches, oneStageBatches, 0.005),
    `staged=${batches.toFixed(2)} oneStage=${oneStageBatches.toFixed(2)}`);
  check('A FG GL capitalisation = the one-stage FG GL capitalisation',
    near(gl, oneStageGl, 0.005),
    `staged=${gl.toFixed(2)} oneStage=${oneStageGl.toFixed(2)}`);

  // the exact regression signature: stage 2 must NOT carry stage 1's cost again
  const preFixStage2UnitCost = cumulative / 600;
  const stage2UnitCost = b600.unitCost || 0;
  check('A stage-2 unit cost is incremental, not cumulative ÷ stage qty',
    stage2UnitCost < preFixStage2UnitCost - 0.01,
    `stage2=${stage2UnitCost.toFixed(6)} vs the defective ${preFixStage2UnitCost.toFixed(6)}`);
}

console.log('\n── B) single-stage behaviour unchanged (1,000 in one stage) ──');
{
  const bd = ManufacturingEngine.calculateCostBreakdown(single.orderId);
  const batches = fgBatchValue(single.orderNumber);
  const gl = fgGlCapitalised(single.orderId);
  const prodBatches = snap().batches.filter(b => String(b.batchNumber || '').startsWith(`PRD-${single.orderNumber}-`));
  check('B one finished-goods batch for the whole order', prodBatches.length === 1, `batches=${prodBatches.length}`);
  check('B single-stage unit cost = cumulative actual cost / units',
    near(prodBatches[0]?.unitCost || 0, bd.totalActualCost / 1000, 1e-6),
    `unit=${(prodBatches[0]?.unitCost || 0).toFixed(9)} expected=${(bd.totalActualCost / 1000).toFixed(9)}`);
  check('B batch ledger ties to the FG GL capitalised at closure',
    near(batches, gl, 0.005),
    `batches=${batches.toFixed(2)} GL1109=${gl.toFixed(2)} residual=${(batches - gl).toFixed(2)}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);

// ---------------------------------------------------------------- cleanup
erpDb.mutate(draft => {
  draft.suppliers = draft.suppliers.filter(s => s.id !== sup.id);
  draft.journalEntries = draft.journalEntries.slice(0, BASE.journalEntries);
  draft.inventoryTransactions = draft.inventoryTransactions.slice(0, BASE.inventoryTransactions);
  const baseIds = new Set(BASE.batches);
  draft.batches = draft.batches.filter(b => baseIds.has(b.id));
  draft.productionOrders = draft.productionOrders.filter(o => o.id !== staged.orderId && o.id !== single.orderId);
  draft.productionConsumptions = draft.productionConsumptions.filter(c => c.productionOrderId !== staged.orderId && c.productionOrderId !== single.orderId);
  draft.productionWastes = draft.productionWastes.filter(w => w.productionOrderId !== staged.orderId && w.productionOrderId !== single.orderId);
  draft.auditLogs = draft.auditLogs.filter(a => !String(a.description || '').includes(PFX));
  BASE.accounts.forEach(b => { const a = draft.accounts.find(x => x.id === b.id); if (a) a.currentBalance = b.b; });
  BASE.items.forEach(b => { const i = draft.items.find(x => x.id === b.id); if (i) i.actualCost = b.actualCost; });
});
const after = snap();
const leftovers = after.suppliers.filter(s => String(s.code).includes(PFX)).length
  + after.batches.filter(b => String(b.batchNumber || '').includes(PFX)).length
  + after.productionOrders.filter(o => o.id === staged.orderId || o.id === single.orderId).length;
console.log(`  cleanup: leftover TEST-QA records = ${leftovers}; journals ${after.journalEntries.length}/${BASE.journalEntries}`
  + `; balances restored = ${BASE.accounts.every(b => Math.abs((snap().accounts.find(a => a.id === b.id)?.currentBalance || 0) - b.b) < 0.01)}`);
process.exit(fail || leftovers ? 1 : 0);