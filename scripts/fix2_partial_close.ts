// ============================================================================
// FIX 2 — DEDICATED REGRESSION TESTS (partial production order closure)
//
//   FIX2_PARTIAL_CLOSE        1000 planned / 700 produced ⇒ plain close BLOCKED,
//                             partial close (mode + reason) succeeds
//   FIX2_REASON_REQUIRED      empty / whitespace / missing reason ⇒ BLOCKED
//   FIX2_MATERIAL_RECONCILIATION
//                             ISSUED = CONSUMED + RETURNED + APPROVED_VARIANCE
//                             for EVERY material — derived per material from its
//                             own BOM line, never a flat 1 − produced/planned %
//   FIX2_BATCH_TRACEABILITY   returns go back to the ORIGINAL batches (identity
//                             + expiry preserved, no replacement batch)
//   FIX2_COST                 FG = consumed material + conversion, never the
//                             whole issued amount; GL 1108 ↔ batch ledger tie
//
// Every scenario executes through the REAL service layer against an in-memory
// scratch database. The exact pre-run state is deep-captured before anything is
// written and restored + asserted byte-identical at the end. All created data is
// TEST-QA prefixed and `isTest: true` — no UAT record is touched.
import { erpDb, createEmptyDatabase, applyMasterDataMigration, applyUomMigration } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { InventoryEngine } from '../src/services/inventory';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { WorkflowService } from '../src/services/workflows';

const snap = () => erpDb.getSnapshot();
const TODAY = new Date().toISOString().split('T')[0];
const RID = `F2-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const ADMIN = { userId: 'usr-admin', userName: 'QA' };
const REASON = 'Customer order reduced — partial production';

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}
const near = (a: number, b: number, tol = 0.005) => Math.abs(a - b) <= tol;

const PRISTINE_LIVE = JSON.parse(JSON.stringify(snap()));
const PRISTINE = JSON.parse(JSON.stringify(applyUomMigration(applyMasterDataMigration(createEmptyDatabase()))));

const CHIP = 'item-raw-chip';
const FP = PRISTINE.items.find((i: { code: string }) => i.code === 'FP-SNG-01')!.id;

const glBal = (code: string) => snap().accounts.find(a => a.code === code)?.currentBalance || 0;
const invValue = () => snap().batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
const chipBatches = () => snap().batches.filter(b => b.itemId === CHIP && b.warehouseId === 'wh-raw');

function fresh(): string {
  erpDb.restore(JSON.parse(JSON.stringify(PRISTINE)));
  return MasterDataService.createSupplier({
    code: `${PFX}-SUP`, name: `مورد ${PFX}`, isTest: true, ...ADMIN,
  } as never)!.supplier!.id;
}

function buy(supplierId: string, itemId: string, qty: number, price: number,
             batchNumber: string, productionDate = TODAY, expiryDate = '2027-06-01') {
  const r = WorkflowService.createPurchaseInvoice({
    supplierId, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `${PFX}-P`, date: TODAY,
    lines: [{ itemId, quantity: qty, unitId: 'unit-kg', unitPrice: price, batchNumber, productionDate, expiryDate, vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (!r.success) throw new Error(`purchase failed: ${r.error}`);
}

type Scenario = {
  sup: string; oilId: string; bomId: string; orderId: string;
  chipBatch1: string; chipBatch2: string; oilBatch: string;
};

/**
 * planned = 1000, materials issued for CHIP 1000 KG and OIL 140 KG (the BOM only
 * asks for 110 KG of OIL — a deliberate OVER-issue), then 700 good units.
 *
 *   CHIP: issued 1000 · expected@700 = 700 · remainder 300
 *   OIL : issued  140 · expected@700 =  77 · remainder  63
 * A flat 1 − 700/1000 = 30% would return 42 KG of OIL — it must NOT.
 */
function scenario(): Scenario {
  const sup = fresh();

  const oil = MasterDataService.createItem({
    code: `${PFX}-OIL`, nameAr: `${PFX} زيت`, nameEn: `${PFX} oil`,
    itemType: 'raw_material', baseUnitId: 'unit-kg', vatRate: 0, vatCategory: 'standard',
    trackBatch: true, trackExpiry: false, standardCost: 0, actualCost: 0,
    sellingPriceRetail: 0, sellingPriceWholesale: 0, sellingPriceExportUSD: 0,
    active: true, minStockLevel: 0, isTest: true,
  } as never, { userId: 'usr-admin', userName: 'QA', isTest: true } as never);
  if (!oil.success) throw new Error(`item failed: ${oil.error}`);
  const oilId = oil.item!.id;

  const chipBatch1 = `${PFX}-CHIP-A`;   // older, cheaper
  const chipBatch2 = `${PFX}-CHIP-B`;   // newer, dearer
  const oilBatch = `${PFX}-OIL-A`;
  buy(sup, CHIP, 600, 50, chipBatch1, '2026-01-01', '2026-12-31');
  buy(sup, CHIP, 500, 60, chipBatch2, '2026-06-01', '2027-12-31');
  buy(sup, oilId, 200, 20, oilBatch, '2026-03-01', '2027-03-01');

  const bom = ManufacturingEngine.createBomVersion({
    finishedItemId: FP, baseQuantity: 1, unitId: 'unit-piece', effectiveDate: TODAY,
    lines: [
      { materialItemId: CHIP, quantityRequired: 1, unitId: 'unit-kg' },
      { materialItemId: oilId, quantityRequired: 0.1, unitId: 'unit-kg', wastePercentage: 10 },
    ],
    isTest: true, ...ADMIN,
  } as never);
  if (!bom.success) throw new Error(`bom failed: ${bom.error}`);
  const bomId = bom.bom!.id;

  const o = ManufacturingEngine.createProductionOrder({
    productId: FP, plannedQuantity: 1000, targetMarket: 'local', destinationWarehouseId: 'wh-local',
    expectedCompletionDate: TODAY, isTest: true, ...ADMIN,
  } as never);
  if (!o.success) throw new Error(`order failed: ${o.error}`);
  const orderId = o.order!.id;

  const iss = ManufacturingEngine.issueMaterialsToOrder({
    orderId, date: TODAY, ...ADMIN,
    lines: [
      { materialItemId: CHIP, quantity: 1000 },
      { materialItemId: oilId, quantity: 140 },
    ],
  } as never);
  if (!iss.success) throw new Error(`issue failed: ${iss.error}`);

  const p = ManufacturingEngine.recordDailyProduction({
    orderId, goodQuantity: 700, defectiveQuantity: 0, scrapQuantity: 0, defectiveAction: 'to_scrap',
    wasteReason: 'اختبار', date: TODAY, isTest: true, ...ADMIN,
  } as never);
  if (!p.success) throw new Error(`production failed: ${p.error}`);

  return { sup, oilId, bomId, orderId, chipBatch1, chipBatch2, oilBatch };
}

/** Dispositions derived from the engine's own reconciliation view. */
function dispositionsOf(orderId: string) {
  return ManufacturingEngine.getMaterialReconciliation(orderId)
    .filter(r => r.remainderQuantity > 0)
    .map(r => ({ materialItemId: r.materialItemId, returnQuantity: r.remainderQuantity }));
}
const close = (orderId: string, params?: Record<string, unknown>) =>
  ManufacturingEngine.closeProductionOrder(orderId, 'usr-admin', 'QA', params as never);

console.log('================================================================');
console.log(`🧪 FIX 2 — PARTIAL PRODUCTION ORDER CLOSURE — ${RID}`);
console.log('================================================================');

// ===========================================================================
console.log('\n── FIX2_PARTIAL_CLOSE ─────────────────────────────────────────');
const s1 = scenario();
{
  const before = snap().productionOrders.find(o => o.id === s1.orderId)!;
  check(before.plannedQuantity === 1000 && before.producedQuantity === 700,
    'scenario: planned 1000 / produced 700',
    `planned=${before.plannedQuantity} produced=${before.producedQuantity}`);

  const plain = close(s1.orderId);
  check(!plain.success && /كأمر مكتمل/.test(plain.error || ''),
    '1000 planned / 700 produced → NORMAL close is BLOCKED', plain.error || 'ACCEPTED');
  const stillOpen = snap().productionOrders.find(o => o.id === s1.orderId)!;
  check(stillOpen.status !== 'completed', 'the order stays OPEN after the refused close',
    `status=${stillOpen.status}`);

  const ok = close(s1.orderId, { mode: 'partial', reason: REASON, dispositions: dispositionsOf(s1.orderId) });
  check(ok.success && ok.mode === 'partial', 'PARTIAL CLOSE with a reason is accepted',
    ok.error || `mode=${ok.mode}`);

  const after = snap().productionOrders.find(o => o.id === s1.orderId)!;
  check(after.status === 'completed', 'the order is closed', `status=${after.status}`);
  check(after.closeMode === 'partial', 'the closure mode is persisted', `closeMode=${after.closeMode}`);
  check(after.closeReason === REASON, 'the reason is persisted and auditable',
    `closeReason="${after.closeReason}"`);
  check(Boolean(after.closedByUserId) && Boolean(after.closedAt) && Boolean(after.actualCompletionDate),
    'who / when is persisted',
    `by=${after.closedByUserId} at=${after.closedAt} completed=${after.actualCompletionDate}`);

  const again = close(s1.orderId, { mode: 'partial', reason: REASON });
  check(!again.success, 'a closed order cannot be closed a second time (no duplicate posting)',
    again.error || 'ACCEPTED');
}

// ===========================================================================
console.log('\n── FIX2_REASON_REQUIRED ──────────────────────────────────────');
{
  const a = scenario();
  const noReason = close(a.orderId, { mode: 'partial', dispositions: dispositionsOf(a.orderId) });
  check(!noReason.success && /سبب/.test(noReason.error || ''),
    'partial close WITHOUT a reason is BLOCKED', noReason.error || 'ACCEPTED');

  const empty = close(a.orderId, { mode: 'partial', reason: '', dispositions: dispositionsOf(a.orderId) });
  check(!empty.success && /سبب/.test(empty.error || ''),
    'partial close with an EMPTY reason is BLOCKED', empty.error || 'ACCEPTED');

  const spaces = close(a.orderId, { mode: 'partial', reason: '    ', dispositions: dispositionsOf(a.orderId) });
  check(!spaces.success && /سبب/.test(spaces.error || ''),
    'partial close with a WHITESPACE-ONLY reason is BLOCKED', spaces.error || 'ACCEPTED');

  const noDisp = close(a.orderId, { mode: 'partial', reason: REASON });
  check(!noDisp.success && /غير مُسوّاة/.test(noDisp.error || ''),
    'partial close while the issued material cannot be reconciled is BLOCKED',
    noDisp.error || 'ACCEPTED');

  const stillOpen = snap().productionOrders.find(o => o.id === a.orderId)!;
  check(stillOpen.status !== 'completed', 'every refused attempt leaves the order OPEN',
    `status=${stillOpen.status}`);
}

// ===========================================================================
console.log('\n── FIX2_MATERIAL_RECONCILIATION ──────────────────────────────');
const s2 = scenario();
{
  const recon = ManufacturingEngine.getMaterialReconciliation(s2.orderId);
  const chip = recon.find(r => r.materialItemId === CHIP)!;
  const oil = recon.find(r => r.materialItemId === s2.oilId)!;
  check(near(chip.issuedQuantity, 1000) && near(chip.consumedQuantity, 700) && near(chip.remainderQuantity, 300),
    'CHIP: issued 1000 · consumed 700 · remainder 300',
    `issued=${chip.issuedQuantity} consumed=${chip.consumedQuantity} remainder=${chip.remainderQuantity}`);
  check(near(oil.issuedQuantity, 140) && near(oil.consumedQuantity, 77) && near(oil.remainderQuantity, 63),
    'OIL: issued 140 · consumed 77 · remainder 63 (its OWN BOM line, incl. 10% waste)',
    `issued=${oil.issuedQuantity} consumed=${oil.consumedQuantity} remainder=${oil.remainderQuantity}`);
  check(!near(oil.remainderQuantity, 140 * 0.3),
    'NO FLAT percentage: a blind 1 − 700/1000 = 30% would return 42 KG of OIL — it does not',
    `remainder=${oil.remainderQuantity} KG (flat 30% would be ${(140 * 0.3).toFixed(2)} KG)`);

  const disp = dispositionsOf(s2.orderId);
  const ok = close(s2.orderId, { mode: 'partial', reason: REASON, dispositions: disp });
  check(ok.success, 'the partial close succeeds once every material is dispositioned',
    ok.error || '');

  const stored = snap().productionOrders.find(o => o.id === s2.orderId)!.materialReconciliation || [];
  check(stored.length === 2, 'one reconciliation row per material', `rows=${stored.length}`);
  check(stored.every(r => near(r.issuedQuantity, r.consumedQuantity + r.returnedQuantity + r.approvedVarianceQuantity)),
    'IDENTITY holds for EVERY material: issued = consumed + returned + approvedVariance',
    stored.map(r => `${r.materialItemId}: ${r.issuedQuantity} = ${r.consumedQuantity} + ${r.returnedQuantity} + ${r.approvedVarianceQuantity}`).join(' | '));
  const storedChip = stored.find(r => r.materialItemId === CHIP)!;
  const storedOil = stored.find(r => r.materialItemId === s2.oilId)!;
  check(near(storedChip.returnedQuantity, 300) && near(storedOil.returnedQuantity, 63),
    'the returned quantities are exactly the BOM-derived remainders',
    `CHIP returned=${storedChip.returnedQuantity}, OIL returned=${storedOil.returnedQuantity}`);
}

// ---- negative: over- / under-disposition, unexplained material ----
{
  const b = scenario();
  const over = close(b.orderId, {
    mode: 'partial', reason: REASON,
    dispositions: [
      { materialItemId: CHIP, returnQuantity: 400 },
      { materialItemId: b.oilId, returnQuantity: 63 },
    ],
  });
  check(!over.success, 'returning MORE than the remainder is BLOCKED', over.error || 'ACCEPTED');

  const c = scenario();
  const under = close(c.orderId, {
    mode: 'partial', reason: REASON,
    dispositions: [
      { materialItemId: CHIP, returnQuantity: 299 },
      { materialItemId: c.oilId, returnQuantity: 63 },
    ],
  });
  check(!under.success && /غير مُسوّاة/.test(under.error || ''),
    'unexplained material left over (299 of 300) is BLOCKED', under.error || 'ACCEPTED');

  const d = scenario();
  const none = close(d.orderId, { mode: 'partial', reason: REASON, dispositions: [] });
  check(!none.success && /غير مُسوّاة/.test(none.error || ''),
    'closing while material remains unexplained is BLOCKED', none.error || 'ACCEPTED');

  const e = scenario();
  const ghost = close(e.orderId, {
    mode: 'partial', reason: REASON,
    dispositions: [
      { materialItemId: CHIP, returnQuantity: 300 },
      { materialItemId: e.oilId, returnQuantity: 63 },
      { materialItemId: 'item-does-not-exist', returnQuantity: 5 },
    ],
  });
  check(!ghost.success, 'a disposition for material that was never issued is BLOCKED',
    ghost.error || 'ACCEPTED');
}

// ---- approved variance path ----
{
  const f = scenario();
  const noReason = close(f.orderId, {
    mode: 'partial', reason: REASON,
    dispositions: [
      { materialItemId: CHIP, returnQuantity: 200, approvedVarianceQuantity: 100 },
      { materialItemId: f.oilId, returnQuantity: 63 },
    ],
  });
  check(!noReason.success && /سبب/.test(noReason.error || ''),
    'an APPROVED VARIANCE without its own reason is BLOCKED', noReason.error || 'ACCEPTED');

  const ok = close(f.orderId, {
    mode: 'partial', reason: REASON,
    dispositions: [
      { materialItemId: CHIP, returnQuantity: 200, approvedVarianceQuantity: 100, approvedVarianceReason: 'هالك معتمد أثناء الخلط' },
      { materialItemId: f.oilId, returnQuantity: 63 },
    ],
  });
  check(ok.success, 'approved variance with an explicit reason is accepted',
    ok.error || '');
  const stored = snap().productionOrders.find(o => o.id === f.orderId)!.materialReconciliation!;
  const storedChip = stored.find(r => r.materialItemId === CHIP)!;
  check(near(storedChip.approvedVarianceQuantity, 100)
    && storedChip.approvedVarianceReason === 'هالك معتمد أثناء الخلط',
    'the approved variance and its reason are persisted',
    `variance=${storedChip.approvedVarianceQuantity} reason="${storedChip.approvedVarianceReason}"`);
  check(near(storedChip.issuedQuantity, storedChip.consumedQuantity + storedChip.returnedQuantity + storedChip.approvedVarianceQuantity),
    'identity still holds with an approved variance in the mix',
    `${storedChip.issuedQuantity} = ${storedChip.consumedQuantity} + ${storedChip.returnedQuantity} + ${storedChip.approvedVarianceQuantity}`);
}

// ===========================================================================
console.log('\n── FIX2_BATCH_TRACEABILITY ────────────────────────────────────');
const s3 = scenario();
{
  const b1Before = snap().batches.find(b => b.batchNumber === s3.chipBatch1)!;
  const b2Before = snap().batches.find(b => b.batchNumber === s3.chipBatch2)!;
  const oilBefore = snap().batches.find(b => b.batchNumber === s3.oilBatch)!;
  const expiry1 = b1Before.expiryDate, expiry2 = b2Before.expiryDate, expiryOil = oilBefore.expiryDate;
  const countBefore = chipBatches().length;
  check(near(b2Before.quantity, 100), 'after the issue the newer CHIP batch holds 100 KG',
    `CHIP-B=${b2Before.quantity}`);

  const ok = close(s3.orderId, { mode: 'partial', reason: REASON, dispositions: dispositionsOf(s3.orderId) });
  check(ok.success, 'partial close succeeds', ok.error || '');

  const b1 = snap().batches.find(b => b.batchNumber === s3.chipBatch1)!;
  const b2 = snap().batches.find(b => b.batchNumber === s3.chipBatch2)!;
  const oil = snap().batches.find(b => b.batchNumber === s3.oilBatch)!;
  check(near(b2.quantity, 400), 'the returned 300 KG went back to the ORIGINAL newer batch (100 → 400)',
    `CHIP-B=${b2.quantity}`);
  check(near(b1.quantity, 0), 'the older batch keeps its own quantity (it was fully consumed)',
    `CHIP-A=${b1.quantity}`);
  check(b1.expiryDate === expiry1 && b2.expiryDate === expiry2 && oil.expiryDate === expiryOil,
    'expiry dates of every original batch are preserved',
    `CHIP-A=${b1.expiryDate}, CHIP-B=${b2.expiryDate}, OIL=${oil.expiryDate}`);
  check(chipBatches().length === countBefore,
    'NO replacement batch was invented to make the totals balance',
    `CHIP batches ${countBefore} → ${chipBatches().length}`);
  check(near(b1.quantity + b2.quantity, 400), 'CHIP stock = 400 KG (100 left + 300 returned)',
    `total=${b1.quantity + b2.quantity}`);
  check(near(oil.quantity, 200 - 140 + 63), 'OIL stock = 200 − 140 + 63 = 123 KG',
    `OIL=${oil.quantity}`);
}

// ===========================================================================
console.log('\n── FIX2_COST (unconsumed material is NOT capitalised) ─────────');
const s4 = scenario();
{
  const rawBefore = glBal('1108'), fgBefore = glBal('1109');
  const reconBefore = ManufacturingEngine.getMaterialReconciliation(s4.orderId);
  const consumedCost = reconBefore.reduce((s, r) => s + r.consumedCost, 0);
  const issuedCost = reconBefore.reduce((s, r) => s + r.issuedCost, 0);

  const ok = close(s4.orderId, { mode: 'partial', reason: REASON, dispositions: dispositionsOf(s4.orderId) });
  check(ok.success, 'partial close succeeds', ok.error || '');

  const bd = ManufacturingEngine.calculateCostBreakdown(s4.orderId);
  check(near(bd.actualMaterialCost, consumedCost),
    'actual material cost = the CONSUMED quantity only',
    `actualMaterialCost=${bd.actualMaterialCost.toFixed(2)} (consumed ${consumedCost.toFixed(2)}, issued ${issuedCost.toFixed(2)})`);
  check(bd.actualMaterialCost < issuedCost,
    'the issued-but-unconsumed share is excluded from production cost',
    `issued=${issuedCost.toFixed(2)} − consumed=${bd.actualMaterialCost.toFixed(2)} = ${(issuedCost - bd.actualMaterialCost).toFixed(2)} returned`);

  const jv = snap().journalEntries.filter(j => j.sourceDocumentType === 'production_order_close' && j.sourceDocumentId === s4.orderId);
  check(jv.length === 1, 'exactly ONE closure journal (no duplicate posting)', `journals=${jv.length}`);
  const fgDebit = jv.reduce((s, j) => s + j.lines.filter(l => l.accountCode === '1109').reduce((x, l) => x + (l.debit || 0), 0), 0);
  check(near(fgDebit, consumedCost), 'FG capitalisation = consumed material + conversion (0 here)',
    `1109 debit=${fgDebit.toFixed(2)}, expected=${consumedCost.toFixed(2)}`);
  check(!near(fgDebit, issuedCost), 'FG is NOT capitalised at the whole ISSUED amount',
    `1109 debit=${fgDebit.toFixed(2)} vs issued cost ${issuedCost.toFixed(2)}`);
  check(jv.every(j => near(j.lines.reduce((s, l) => s + l.debit, 0), j.lines.reduce((s, l) => s + l.credit, 0), 0.01)),
    'SUM(debits) = SUM(credits) for the closure journal',
    jv.map(j => `${j.lines.reduce((s, l) => s + l.debit, 0).toFixed(2)}/${j.lines.reduce((s, l) => s + l.credit, 0).toFixed(2)}`).join(', '));

  const fgBatches = snap().batches.filter(b => b.itemId === FP && b.warehouseId === 'wh-local'
    && String(b.batchNumber || '').startsWith('PRD-'));
  const fgVal = fgBatches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
  check(near(fgVal, consumedCost, 0.01), 'the FG batch ledger equals the capitalised cost',
    `batches=${fgVal.toFixed(2)} vs journal ${fgDebit.toFixed(2)}`);

  const rawDelta = glBal('1108') - rawBefore, fgDelta = glBal('1109') - fgBefore;
  check(near(rawDelta, -consumedCost), 'GL 1108 credited with the consumed cost only',
    `1108 Δ ${rawDelta.toFixed(2)} (expected ${(-consumedCost).toFixed(2)})`);

  // CROSS-MODULE: the raw-inventory GL must equal the raw batch ledger.
  const rawBatchValue = snap().batches
    .filter(b => b.warehouseId === 'wh-raw')
    .reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
  check(near(glBal('1108'), rawBatchValue, 0.01),
    'INVENTORY SUBLEDGER ties to GL 1108 after the partial close',
    `GL 1108=${glBal('1108').toFixed(2)} vs batches=${rawBatchValue.toFixed(2)}`);
  check(near(fgDelta, fgVal, 0.01),
    'INVENTORY SUBLEDGER ties to GL 1109 for finished goods',
    `GL 1109 Δ=${fgDelta.toFixed(2)} vs batches=${fgVal.toFixed(2)}`);
  check(near(invValue(), glBal('1108') + glBal('1109') + glBal('1110') + glBal('1111') + glBal('1112'), 0.01),
    'TOTAL inventory batches = total inventory GL',
    `batches=${invValue().toFixed(2)} GL=${(glBal('1108') + glBal('1109') + glBal('1110') + glBal('1111') + glBal('1112')).toFixed(2)}`);
  check(near(fgDelta, fgDebit, 0.01), 'the FG movement in the GL equals the closure journal',
    `Δ=${fgDelta.toFixed(2)} journal=${fgDebit.toFixed(2)}`);
}

// ===========================================================================
console.log('\n── FULL CLOSE is unchanged ────────────────────────────────────');
{
  const sup = fresh();
  buy(sup, CHIP, 1000, 55, `${PFX}-FULL`);
  const bom = ManufacturingEngine.createBomVersion({
    finishedItemId: FP, baseQuantity: 1, unitId: 'unit-piece', effectiveDate: TODAY,
    lines: [{ materialItemId: CHIP, quantityRequired: 1, unitId: 'unit-kg' }],
    isTest: true, ...ADMIN,
  } as never);
  const o = ManufacturingEngine.createProductionOrder({
    productId: FP, plannedQuantity: 1000, targetMarket: 'local', destinationWarehouseId: 'wh-local',
    expectedCompletionDate: TODAY, isTest: true, ...ADMIN,
  } as never);
  const orderId = o.order!.id;
  const iss = ManufacturingEngine.issueMaterialsToOrder({ orderId, date: TODAY, ...ADMIN } as never);
  if (!iss.success) throw new Error(iss.error!);
  ManufacturingEngine.recordDailyProduction({
    orderId, goodQuantity: 1000, defectiveQuantity: 0, scrapQuantity: 0, defectiveAction: 'to_scrap',
    date: TODAY, isTest: true, ...ADMIN,
  } as never);
  const full = close(orderId);
  check(full.success && full.mode === 'full', 'a fully produced order still closes normally',
    full.error || `mode=${full.mode}`);
  const stored = snap().productionOrders.find(x => x.id === orderId)!;
  check(!stored.closeReason, 'a FULL close needs no reason', `closeReason=${stored.closeReason || '<none>'}`);
  check(near(ManufacturingEngine.calculateCostBreakdown(orderId).actualMaterialCost, 1000 * 55),
    'full close capitalises the whole issued amount (nothing was unconsumed)',
    `actualMaterialCost=${ManufacturingEngine.calculateCostBreakdown(orderId).actualMaterialCost.toFixed(2)}`);
}

// ===========================================================================
console.log('\n── data safety ────────────────────────────────────────────────');
erpDb.restore(JSON.parse(JSON.stringify(PRISTINE_LIVE)));
const identical = JSON.stringify(snap()) === JSON.stringify(PRISTINE_LIVE);
const leftovers = snap().items.filter(i => i.isTest).length
  + snap().batches.filter(b => String(b.batchNumber).includes('TEST-QA')).length
  + snap().productionOrders.filter(o => (o as { isTest?: boolean }).isTest).length
  + snap().journalEntries.filter(j => j.isTest).length;
check(identical, 'the in-memory database is restored byte-identical to the pre-run state');
check(leftovers === 0, 'no TEST-QA record survived', `${leftovers} leftover(s)`);

console.log('\n================================================================');
console.log(`FIX 2 RESULT — ${pass} passed, ${fail} failed`);
console.log('================================================================');
process.exit(fail > 0 ? 1 : 0);
