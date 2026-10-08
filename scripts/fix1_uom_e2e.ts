// ============================================================================
// FIX 1 — DEDICATED REGRESSION TESTS (UOM conversion / BOM / FIFO / costing)
//
//   FIX1_UOM_END_TO_END      10 KG stock + 70 GRAM requirement → issue 0.07 KG
//   FIX1_FIFO                two FIFO batches, 70 GRAM issue → 0.07 KG total,
//                            FIFO order preserved, no batch loses 70 KG
//   FIX1_COSTING_70G_AT_53   0.07 KG × 53 EGP/KG = 3.71 EGP (never 3710)
//   FIX1_INVALID_CONVERSION  a missing conversion BLOCKS the issue
//   FIX1_SAME_UNIT           KG BOM + KG inventory ⇒ no unnecessary conversion
//
// Every scenario executes through the REAL service layer against an in-memory
// scratch database. The exact pre-run state is deep-captured before anything is
// written and restored + asserted byte-identical at the end, so no UAT record is
// touched. All created data is TEST-QA prefixed and `isTest: true`.
import { erpDb, createEmptyDatabase, applyMasterDataMigration, applyUomMigration } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { InventoryEngine } from '../src/services/inventory';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { WorkflowService } from '../src/services/workflows';

const snap = () => erpDb.getSnapshot();
const TODAY = new Date().toISOString().split('T')[0];
const RID = `F1-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
// `isTest` is set explicitly at each call site (never spread twice).
const ADMIN = { userId: 'usr-admin', userName: 'QA' };

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}
const near = (a: number, b: number, tol = 0.005) => Math.abs(a - b) <= tol;

// The state this process started with, captured BEFORE anything is written.
const PRISTINE_LIVE = JSON.parse(JSON.stringify(snap()));
// A pristine seed used to re-run each scenario in isolation.
const PRISTINE = JSON.parse(JSON.stringify(applyUomMigration(applyMasterDataMigration(createEmptyDatabase()))));

const CHIP = 'item-raw-chip';
const FP = PRISTINE.items.find((i: { code: string }) => i.code === 'FP-SNG-01')!.id;

const batchQty = (itemId: string, wh = 'wh-raw') =>
  snap().batches.filter(b => b.itemId === itemId && b.warehouseId === wh).reduce((s, b) => s + b.quantity, 0);
const batchOf = (itemId: string, batchNumber: string) =>
  snap().batches.find(b => b.itemId === itemId && b.batchNumber === batchNumber);
const glBal = (code: string) => snap().accounts.find(a => a.code === code)?.currentBalance || 0;

function fresh(): string {
  erpDb.restore(JSON.parse(JSON.stringify(PRISTINE)));
  return MasterDataService.createSupplier({
    code: `${PFX}-SUP`, name: `مورد ${PFX}`, isTest: true, ...ADMIN,
  } as never)!.supplier!.id;
}

/** A real purchase receipt: the batch carries its own date + cost (FIFO input). */
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

function makeBom(materialItemId: string, qtyPerBase: number, bomUnitId: string, baseQty = 1): string {
  const r = ManufacturingEngine.createBomVersion({
    finishedItemId: FP, baseQuantity: baseQty, unitId: 'unit-piece', effectiveDate: TODAY,
    lines: [{ materialItemId, quantityRequired: qtyPerBase, unitId: bomUnitId }],
    isTest: true, ...ADMIN,
  } as never);
  if (!r.success) throw new Error(`bom failed: ${r.error}`);
  return r.bom!.id;
}

function makeOrder(bomId: string, planned = 1) {
  const o = ManufacturingEngine.createProductionOrder({
    productId: FP, plannedQuantity: planned, targetMarket: 'local', destinationWarehouseId: 'wh-local',
    expectedCompletionDate: TODAY, isTest: true, ...ADMIN,
  } as never);
  if (!o.success) throw new Error(`order failed: ${o.error}`);
  return o.order!.id;
}

function produceAndClose(orderId: string) {
  const p = ManufacturingEngine.recordDailyProduction({
    orderId, goodQuantity: 1, defectiveQuantity: 0, scrapQuantity: 0, defectiveAction: 'to_scrap',
    date: TODAY, isTest: true, ...ADMIN,
  } as never);
  if (!p.success) throw new Error(`production failed: ${p.error}`);
  const c = ManufacturingEngine.closeProductionOrder(orderId, 'usr-admin', 'QA');
  return c;
}

console.log('================================================================');
console.log(`🧪 FIX 1 — UOM / BOM / FIFO / COSTING — ${RID}`);
console.log('================================================================');

// ===========================================================================
console.log('\n── FIX1_UOM_END_TO_END ─────────────────────────────────────────');
{
  const sup = fresh();
  buy(sup, CHIP, 10, 60, `${PFX}-A`);                 // 10 KG in stock
  const bomId = makeBom(CHIP, 70, 'unit-gram');        // BOM line = 70 GRAM

  const req = ManufacturingEngine.calculateBomRequirements(bomId, 1)[0];
  check(near(req.requiredQuantity, 70), 'requirement is 70 GRAM (BOM line unit)',
    `requiredQuantity=${req.requiredQuantity}`);
  check(near(req.availableStock, 10000), '10 KG = 10,000 GRAM is shown in the BOM line unit',
    `availableStock=${req.availableStock} ${req.unitNameAr}`);
  check(req.sufficient === true, 'availability = sufficient', `sufficient=${req.sufficient}`);

  const before = batchQty(CHIP);
  const orderId = makeOrder(bomId, 1);
  const iss = ManufacturingEngine.issueMaterialsToOrder({ orderId, date: TODAY, ...ADMIN } as never);
  const deducted = before - batchQty(CHIP);
  check(iss.success, 'the material issue is allowed', iss.error || '');
  check(near(deducted, 0.07, 1e-9), 'MATERIAL ISSUE = 0.07 KG (NOT 70 KG)',
    `deducted ${deducted} KG from a 10 KG balance (remaining ${batchQty(CHIP)} KG)`);

  const cons = snap().productionConsumptions.filter(c => c.productionOrderId === orderId);
  check(cons.length === 1 && near(cons[0].actualQuantity, 0.07, 1e-9),
    'production consumption stores the physical base-unit quantity 0.07',
    `actualQuantity=${cons[0]?.actualQuantity}, plannedQuantity=${cons[0]?.plannedQuantity}`);
  check(cons[0]?.unitId === 'unit-gram', 'the consumption row remembers the BOM line unit it came from',
    `unitId=${cons[0]?.unitId}`);

  const rawBefore = glBal('1108'), fgBefore = glBal('1109');
  const close = produceAndClose(orderId);
  check(close.success, 'the order closes (full close, planned = produced)', close.error || '');

  const expectedCost = 0.07 * 60;                       // 4.20 EGP
  const bd = ManufacturingEngine.calculateCostBreakdown(orderId);
  check(near(bd.actualMaterialCost, expectedCost),
    'material cost = 0.07 KG × 60 EGP/KG = 4.20 EGP',
    `actualMaterialCost=${bd.actualMaterialCost.toFixed(4)}`);

  const fgVal = snap().batches.filter(b => b.itemId === FP && b.warehouseId === 'wh-local')
    .reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
  check(near(fgVal, expectedCost), 'finished-goods valuation = the consumed material cost',
    `FG batch value=${fgVal.toFixed(4)} (expected ${expectedCost.toFixed(4)})`);

  const rawDelta = glBal('1108') - rawBefore, fgDelta = glBal('1109') - fgBefore;
  check(near(rawDelta, -expectedCost) && near(fgDelta, expectedCost),
    'GL: 1108 credited and 1109 debited with the same real amount',
    `1108 Δ ${rawDelta.toFixed(4)}, 1109 Δ ${fgDelta.toFixed(4)}`);

  const closeJv = snap().journalEntries.filter(j => j.sourceDocumentType === 'production_order_close' && j.sourceDocumentId === orderId);
  check(closeJv.length === 1, 'exactly ONE closure journal is posted (no duplicate posting)',
    `journals=${closeJv.length}`);
  check(closeJv.every(j => near(j.lines.reduce((s, l) => s + l.debit, 0), j.lines.reduce((s, l) => s + l.credit, 0), 0.01)),
    'SUM(debits) = SUM(credits) for the closure journal',
    closeJv.map(j => `${j.lines.reduce((s, l) => s + l.debit, 0).toFixed(2)}/${j.lines.reduce((s, l) => s + l.credit, 0).toFixed(2)}`).join(', '));
}

// ===========================================================================
console.log('\n── FIX1_FIFO ──────────────────────────────────────────────────');
{
  const sup = fresh();
  // Two FIFO layers of the SAME KG item: the older one is cheaper.
  buy(sup, CHIP, 0.05, 50, `${PFX}-OLD`, '2026-01-01', '2026-12-31');
  buy(sup, CHIP, 10, 70, `${PFX}-NEW`, '2026-06-01', '2027-12-31');
  const oldBatch = batchOf(CHIP, `${PFX}-OLD`)!;
  const newBatch = batchOf(CHIP, `${PFX}-NEW`)!;
  const expiryOld = oldBatch.expiryDate, expiryNew = newBatch.expiryDate;
  check(near(batchQty(CHIP), 10.05), 'stock = 0.05 KG (old) + 10 KG (new) = 10.05 KG',
    `balance=${batchQty(CHIP)}`);

  const bomId = makeBom(CHIP, 70, 'unit-gram');
  const orderId = makeOrder(bomId, 1);
  const iss = ManufacturingEngine.issueMaterialsToOrder({ orderId, date: TODAY, ...ADMIN } as never);
  check(iss.success, 'issue of a 70 GRAM requirement succeeds', iss.error || '');

  const oldAfter = batchOf(CHIP, `${PFX}-OLD`)!.quantity;
  const newAfter = batchOf(CHIP, `${PFX}-NEW`)!.quantity;
  const totalDeducted = 10.05 - batchQty(CHIP);
  check(near(totalDeducted, 0.07, 1e-9), 'ONLY 0.07 KG is deducted in total (never 70 KG)',
    `deducted=${totalDeducted} KG`);
  check(near(oldAfter, 0, 1e-9) && near(newAfter, 9.98, 1e-9),
    'FIFO order preserved: the OLDER batch is consumed first (0.05 KG) and the remainder (0.02 KG) comes from the newer one',
    `old=${oldAfter} KG, new=${newAfter} KG`);
  check(batchOf(CHIP, `${PFX}-OLD`) !== undefined,
    'the exhausted batch keeps its identity (it is not deleted or replaced)',
    `old batch still present with ${oldAfter} KG`);
  check(batchOf(CHIP, `${PFX}-OLD`)!.expiryDate === expiryOld
    && batchOf(CHIP, `${PFX}-NEW`)!.expiryDate === expiryNew,
    'expiry dates of both batches are untouched');

  const cons = snap().productionConsumptions.filter(c => c.productionOrderId === orderId)[0];
  const allocs = cons.batchAllocations || [];
  check(allocs.length === 2
    && near(allocs[0].quantity, 0.05, 1e-9) && allocs[0].batchNumber === `${PFX}-OLD`
    && near(allocs[1].quantity, 0.02, 1e-9) && allocs[1].batchNumber === `${PFX}-NEW`,
    'batch traceability: the consumption row records BOTH layers it drew from, in FIFO order',
    allocs.map(a => `${a.batchNumber}:${a.quantity}@${a.unitCost}`).join(' | '));
  check(near(cons.actualQuantity, 0.07, 1e-9), 'the consumption quantity matches the physical deduction',
    `actualQuantity=${cons.actualQuantity}`);
  check(near(iss.totalActualCost || 0, 0.05 * 50 + 0.02 * 70, 0.005),
    'FIFO costing = 0.05×50 + 0.02×70 = 3.90 EGP',
    `totalActualCost=${(iss.totalActualCost || 0).toFixed(4)}`);

  // A SECOND issue must continue in the same FIFO order (newer batch next).
  const orderId2 = makeOrder(bomId, 1);
  const iss2 = ManufacturingEngine.issueMaterialsToOrder({ orderId: orderId2, date: TODAY, ...ADMIN } as never);
  const newAfter2 = batchOf(CHIP, `${PFX}-NEW`)!.quantity;
  check(iss2.success && near(newAfter2, 9.91, 1e-9),
    'the next issue also comes from the newer batch — FIFO order stays intact across issues',
    `new batch ${newAfter} → ${newAfter2} KG (another 0.07 KG)`);
}

// ===========================================================================
console.log('\n── FIX1_COSTING_70G_AT_53 ─────────────────────────────────────');
{
  const sup = fresh();
  buy(sup, CHIP, 10, 53, `${PFX}-C`);                  // 53 EGP / KG
  const bomId = makeBom(CHIP, 70, 'unit-gram');
  const orderId = makeOrder(bomId, 1);
  const iss = ManufacturingEngine.issueMaterialsToOrder({ orderId, date: TODAY, ...ADMIN } as never);
  check(iss.success, 'issue succeeds', iss.error || '');
  const close = produceAndClose(orderId);
  check(close.success, 'order closes', close.error || '');

  const bd = ManufacturingEngine.calculateCostBreakdown(orderId);
  const expected = 3.71;                                // 0.07 KG × 53 EGP/KG
  check(near(bd.actualMaterialCost, expected, 0.005),
    'MATERIAL COST = 0.07 KG × 53 EGP/KG = 3.71 EGP (documented rounding precision)',
    `actualMaterialCost=${bd.actualMaterialCost.toFixed(4)} EGP`);
  check(!near(bd.actualMaterialCost, 3710, 1) && !near(bd.actualMaterialCost, 4200, 1)
    && !near(bd.actualMaterialCost, 70 * 53, 1),
    'the system does NOT produce 3710 / 4200 / 70 × 53 EGP',
    `value=${bd.actualMaterialCost.toFixed(2)} EGP`);

  const fgVal = snap().batches.filter(b => b.itemId === FP && b.warehouseId === 'wh-local')
    .reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
  check(near(fgVal, expected, 0.01), 'finished-goods valuation = 3.71 EGP',
    `FG batch value=${fgVal.toFixed(4)} EGP`);

  const closeJv = snap().journalEntries.filter(j => j.sourceDocumentType === 'production_order_close');
  const fgDebit = closeJv.reduce((s, j) => s + j.lines.filter(l => l.accountCode === '1109').reduce((x, l) => x + (l.debit || 0), 0), 0);
  check(near(fgDebit, expected, 0.01), 'GL 1109 debited 3.71 EGP (FG capitalisation)',
    `1109 Δ ${fgDebit.toFixed(4)} EGP`);
  check(near(bd.totalActualCost, expected, 0.01), 'total actual production cost = 3.71 EGP',
    `totalActualCost=${bd.totalActualCost.toFixed(4)}`);
}

// ===========================================================================
console.log('\n── FIX1_INVALID_CONVERSION ────────────────────────────────────');
{
  const sup = fresh();
  buy(sup, CHIP, 10, 60, `${PFX}-F`);
  const bomId = makeBom(CHIP, 70, 'unit-gram');
  const orderId = makeOrder(bomId, 1);

  // Remove the GRAM↔KG pair: the conversion no longer exists.
  erpDb.mutate(d => {
    d.unitConversions = d.unitConversions.filter(c =>
      !((c.fromUnitId === 'unit-gram' && c.toUnitId === 'unit-kg')
        || (c.fromUnitId === 'unit-kg' && c.toUnitId === 'unit-gram')));
  });
  const reqAfter = ManufacturingEngine.calculateBomRequirements(bomId, 1)[0];
  check(reqAfter.sufficient === false && Boolean(reqAfter.conversionError),
    'TEST F (read path): the requirements screen FAILS SAFE instead of assuming 1 GRAM = 1 KG',
    `available=${reqAfter.availableStock} sufficient=${reqAfter.sufficient} error=${reqAfter.conversionError || '<none>'}`);

  const iss = ManufacturingEngine.issueMaterialsToOrder({ orderId, date: TODAY, ...ADMIN } as never);
  check(!iss.success, 'TEST F: with no configured conversion the ISSUE is BLOCKED',
    iss.success ? 'ACCEPTED' : iss.error);
  check(/تحويل|conversion/i.test(iss.error || ''), 'the error names the missing unit conversion',
    iss.error || '');
  check(near(batchQty(CHIP), 10, 1e-9), 'no stock was touched (never 1 GRAM = 1 KG)',
    `balance=${batchQty(CHIP)} KG`);
  check(snap().productionConsumptions.filter(c => c.productionOrderId === orderId).length === 0,
    'no consumption row was written');
}

// ===========================================================================
console.log('\n── FIX1_SAME_UNIT (no unnecessary conversion) ─────────────────');
{
  const sup = fresh();
  buy(sup, CHIP, 10, 60, `${PFX}-G`);
  const bomId = makeBom(CHIP, 0.07, 'unit-kg');         // BOM already in KG
  const req = ManufacturingEngine.calculateBomRequirements(bomId, 1)[0];
  check(near(req.requiredQuantity, 0.07) && req.unitId === 'unit-kg',
    'a KG requirement against a KG inventory stays 0.07 KG (identical units)',
    `required=${req.requiredQuantity} ${req.unitNameAr}`);
  check(near(req.availableStock, 10),
    'availability is reported in KG without applying any factor (10 KG, not 10,000)',
    `availableStock=${req.availableStock} ${req.unitNameAr}`);
  const orderId = makeOrder(bomId, 1);
  const iss = ManufacturingEngine.issueMaterialsToOrder({ orderId, date: TODAY, ...ADMIN } as never);
  const deducted = 10 - batchQty(CHIP);
  check(iss.success && near(deducted, 0.07, 1e-9),
    'the issue deducts exactly 0.07 KG — no conversion is invented when units match',
    `deducted=${deducted} KG`);
  const cons = snap().productionConsumptions.filter(c => c.productionOrderId === orderId)[0];
  check(cons?.unitId === 'unit-kg', 'the consumption row records the same unit (unit-kg)',
    `unitId=${cons?.unitId}`);
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
console.log(`FIX 1 RESULT — ${pass} passed, ${fail} failed`);
console.log('================================================================');
process.exit(fail > 0 ? 1 : 0);
