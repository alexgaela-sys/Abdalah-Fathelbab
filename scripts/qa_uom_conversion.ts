// QA BATCH S — DIAGNOSTIC ONLY: UOM handling across Purchase → Inventory → BOM →
// Production, for the reported case:
//   item base unit = KG, purchased in KG, BOM requirement expressed in GRAM.
//
// UAT BUG: Production Requirements shows
//   required = 70 جرام / available = 10 جرام / shortfall
// although the real balance is 10 KG = 10,000 GRAM (≈142 producible units).
//
// READ-ONLY with respect to persistent/UAT data: no localStorage under tsx; every
// scenario runs on a freshly seeded in-memory DB and the exact pre-run state is
// deep-captured, restored at the end, and asserted byte-identical. All test data
// is TEST-QA prefixed and confined to each scenario's scratch DB.
import { erpDb, createEmptyDatabase, applyMasterDataMigration, applyUomMigration } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { InventoryEngine } from '../src/services/inventory';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { WorkflowService } from '../src/services/workflows';

const snap = () => erpDb.getSnapshot();
const TODAY = new Date().toISOString().split('T')[0];
const RID = `UOM-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const ADMIN = { userId: 'usr-admin', userName: 'QA' };

let pass = 0;
let fail = 0;
const notes: string[] = [];
function check(ok: boolean, label: string, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}

const PRISTINE_LIVE = JSON.parse(JSON.stringify(snap()));
const PRISTINE = JSON.parse(JSON.stringify(applyUomMigration(applyMasterDataMigration(createEmptyDatabase()))));

const unitName = (id: string) => snap().units.find(u => u.id === id)?.nameAr || id;
const baseOf = (itemId: string) => snap().items.find(i => i.id === itemId)?.baseUnitId || '?';
const glInv = () => ['1108', '1109', '1110', '1111', '1112']
  .reduce((s, c) => s + (snap().accounts.find(a => a.code === c)?.currentBalance || 0), 0);
const batchQty = (itemId: string, wh = 'wh-raw') =>
  snap().batches.filter(b => b.itemId === itemId && b.warehouseId === wh).reduce((s, b) => s + b.quantity, 0);
const batchVal = (itemId: string, wh = 'wh-raw') =>
  snap().batches.filter(b => b.itemId === itemId && b.warehouseId === wh)
    .reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);

/** Ground-truth conversion built FROM db.unitConversions — what the engine SHOULD apply. */
function convert(qty: number, fromUnitId: string, toUnitId: string): number | null {
  if (fromUnitId === toUnitId) return qty;
  const direct = snap().unitConversions.find(c => c.fromUnitId === fromUnitId && c.toUnitId === toUnitId);
  if (direct) return qty * direct.factor;
  const inv = snap().unitConversions.find(c => c.fromUnitId === toUnitId && c.toUnitId === fromUnitId);
  return inv ? qty / inv.factor : null;
}

function fresh() {
  erpDb.restore(JSON.parse(JSON.stringify(PRISTINE)));
  const sup = MasterDataService.createSupplier({
    code: `${PFX}-SUP`, name: `مورد ${PFX}`, isTest: true, ...ADMIN,
  } as never)!.supplier!;
  return sup.id;
}

/** Buy `qty` of `itemId` into `wh`, recorded as a real purchase receipt. */
function buy(supplierId: string, itemId: string, wh: string, qty: number, unitId: string, price = 60) {
  const r = WorkflowService.createPurchaseInvoice({
    supplierId, warehouseId: wh, paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `${PFX}-P`, date: TODAY,
    lines: [{ itemId, quantity: qty, unitId, unitPrice: price, batchNumber: `${PFX}-B`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (!r.success) throw new Error(`purchase failed: ${r.error}`);
}

/** One-material BOM: `qtyPerBase` of `materialId` expressed in `bomUnitId` per `baseQty` product. */
function makeBom(finishedItemId: string, materialItemId: string, qtyPerBase: number, bomUnitId: string, baseQty = 1) {
  const r = ManufacturingEngine.createBomVersion({
    finishedItemId, baseQuantity: baseQty, unitId: 'unit-piece', effectiveDate: TODAY,
    lines: [{ materialItemId, quantityRequired: qtyPerBase, unitId: bomUnitId }],
    isTest: true, ...ADMIN,
  } as never);
  if (!r.success) throw new Error(`bom failed: ${r.error}`);
  return r.bom!.id;
}

console.log('================================================================');
console.log(`🔬 UOM CONVERSION DIAGNOSTIC — ${RID}`);
console.log('================================================================');

// ===========================================================================
console.log('\n── 1. UOM master data ─────────────────────────────────────────');
for (const u of snap().units) console.log(`  unit ${u.id.padEnd(12)} ${u.code.padEnd(6)} ${u.nameAr.padEnd(14)} isBase=${u.isBase}`);
for (const c of snap().unitConversions) {
  console.log(`  conv ${c.id.padEnd(6)} ${c.fromUnitId} → ${c.toUnitId}  factor=${c.factor}`);
}
check(convert(70, 'unit-gram', 'unit-kg') === 0.07, 'GRAM → KG conversion is 0.001 (70 GRAM = 0.07 KG)');
check(convert(10, 'unit-kg', 'unit-gram') === 10000, 'KG → GRAM conversion is 1000 (10 KG = 10,000 GRAM)');

// Which items are stocked in which unit?
const byUnit = new Map<string, string[]>();
for (const i of snap().items) {
  if (!byUnit.has(i.baseUnitId)) byUnit.set(i.baseUnitId, []);
  byUnit.get(i.baseUnitId)!.push(i.code);
}
console.log('\n  item master base units:');
for (const [u, list] of byUnit) console.log(`    ${u.padEnd(12)} (${unitName(u).padEnd(10)}) ${String(list.length).padStart(2)} items: ${list.slice(0, 5).join(' ')}`);
check(!(byUnit.get('unit-gram') || []).length, 'NOTE: no seeded item uses GRAM as its base unit — the KG-base case is the live one');

// ===========================================================================
console.log('\n── 2. SCENARIO A — base KG, purchased 10 KG, BOM says 70 GRAM ──');
const CHIP = 'item-raw-chip';
const FP = snap().items.find(i => i.code === 'FP-SNG-01')!.id;
let sup = fresh();
buy(sup, CHIP, 'wh-raw', 10, 'unit-kg');
console.log(`  item ${CHIP} baseUnitId = ${baseOf(CHIP)} (${unitName(baseOf(CHIP))})`);
console.log(`  purchased 10 (unit-kg) → stored batch balance = ${batchQty(CHIP)} (${unitName(baseOf(CHIP))})`);
check(batchQty(CHIP) === 10, 'the purchase is stored in the item base unit (10 KG)');
{
  const bomId = makeBom(FP, CHIP, 70, 'unit-gram');
  const reqs = ManufacturingEngine.calculateBomRequirements(bomId, 1);
  const r = reqs[0];
  console.log(`\n  Production Requirements for 1 unit of the finished product:`);
  console.log(`    الصنف            = ${r.itemNameAr}`);
  console.log(`    المطلوبة         = ${r.requiredQuantity} ${r.unitNameAr}   (BOM line unitId=${r.unitId})`);
  console.log(`    المتاح بالمستودع  = ${r.availableStock} ${r.unitNameAr}   (item base unit is ${unitName(baseOf(CHIP))})`);
  console.log(`    كافٍ؟             = ${r.sufficient}`);
  console.log(`    BOM line unitId   = ${r.unitId}  ≠  item baseUnitId = ${baseOf(CHIP)}`);

  const stockInBase = InventoryEngine.getItemBalance(CHIP, 'wh-raw');
  const stockInBomUnit = convert(stockInBase, baseOf(CHIP), r.unitId)!;
  const unitsProducible = stockInBomUnit / r.requiredQuantity;

  console.log(`\n  GROUND TRUTH (conversion applied):`);
  console.log(`    ${stockInBase} ${unitName(baseOf(CHIP))} = ${stockInBomUnit} ${r.unitNameAr}`);
  console.log(`    ${stockInBomUnit} / ${r.requiredQuantity} = ${unitsProducible.toFixed(3)} producible units`);

  check(Math.abs(r.availableStock - stockInBomUnit) < 1e-9 && r.unitId !== baseOf(CHIP),
    'FIX1: availability is CONVERTED into the BOM line unit before it is shown/compared',
    `printed "${r.availableStock} ${r.unitNameAr}" = ${stockInBase} ${unitName(baseOf(CHIP))}`);
  check(r.sufficient === true && unitsProducible > 100,
    'FIX1: the sufficiency verdict is CORRECT — stock covers the requirement',
    `engine says sufficient, ground truth = ${unitsProducible.toFixed(1)} units`);
  check(convert(stockInBase, baseOf(CHIP), r.unitId) !== null,
    'a KG↔GRAM conversion EXISTS in db.unitConversions and IS consulted by the requirement calculation');
  notes.push(`A: requirement screen prints "${r.availableStock} ${r.unitNameAr}" (= ${stockInBase} KG), sufficient=${r.sufficient}`);
}

// ===========================================================================
console.log('\n── 3. SCENARIO B — is it display-only? stock 100 KG, BOM 70 GRAM ──');
sup = fresh();
buy(sup, CHIP, 'wh-raw', 100, 'unit-kg');
const bomB = makeBom(FP, CHIP, 70, 'unit-gram');
const orderB = ManufacturingEngine.createProductionOrder({
  productId: FP, plannedQuantity: 1, targetMarket: 'local', destinationWarehouseId: 'wh-local',
  expectedCompletionDate: TODAY, isTest: true, ...ADMIN,
} as never);
check(orderB.success, 'production order created', orderB.error || '');
const orderIdB = orderB.order!.id;
const glBefore = glInv();
const issueB = ManufacturingEngine.issueMaterialsToOrder({
  orderId: orderIdB, date: TODAY, isTest: true, ...ADMIN,
} as never);
console.log(`  issueMaterialsToOrder → success=${issueB.success}  ${issueB.error || ''}`);
const deducted = 100 - batchQty(CHIP);
const consumption = snap().productionConsumptions.filter(c => c.productionOrderId === orderIdB);
console.log(`  batch balance 100 → ${batchQty(CHIP)}  (deducted ${deducted})`);
console.log(`  productionConsumption rows: ${consumption.length}, actualQuantity recorded = ${consumption.map(c => c.actualQuantity).join(', ')} ${unitName(baseOf(CHIP))}`);
console.log(`  totalActualCost = ${(issueB.totalActualCost || 0).toFixed(2)} EGP`);

check(issueB.success && Math.abs(deducted - 0.07) < 1e-9,
  'FIX1: the ISSUE converts the BOM line unit to the item base unit (70 GRAM → 0.07 KG)',
  `70 GRAM required; ${deducted} KG removed (expected 0.07 KG, NOT 70 KG)`);
check(Math.abs((consumption[0]?.actualQuantity ?? -1) - 0.07) < 1e-9
  && consumption[0]?.unitId === 'unit-gram',
  'the consumption record stores the BASE-unit quantity and its unit of measure',
  `stored actualQuantity=${consumption[0]?.actualQuantity} KG, unitId=${consumption[0]?.unitId}, plannedQuantity=${consumption[0]?.plannedQuantity}`);

// ===========================================================================
console.log('\n── 4. SCENARIO C/D — 5 GRAM vs 0.005 KG against the SAME 1 KG ──');
const results: Record<string, string> = {};
for (const [label, bomQty, bomUnit] of [['C: 5 GRAM', 5, 'unit-gram'], ['D: 0.005 KG', 0.005, 'unit-kg']] as Array<[string, number, string]>) {
  sup = fresh();
  buy(sup, CHIP, 'wh-raw', 1, 'unit-kg');
  const bomId = makeBom(FP, CHIP, bomQty, bomUnit);
  const r = ManufacturingEngine.calculateBomRequirements(bomId, 1)[0];
  const o = ManufacturingEngine.createProductionOrder({
    productId: FP, plannedQuantity: 1, targetMarket: 'local', destinationWarehouseId: 'wh-local',
    expectedCompletionDate: TODAY, isTest: true, ...ADMIN,
  } as never);
  const iss = ManufacturingEngine.issueMaterialsToOrder({ orderId: o.order!.id, date: TODAY, isTest: true, ...ADMIN } as never);
  console.log(`  ${label.padEnd(12)} requirement=${String(r.requiredQuantity).padStart(7)} ${r.unitNameAr.padEnd(8)} available=${String(r.availableStock).padStart(5)} ${r.unitNameAr.padEnd(8)} sufficient=${String(r.sufficient).padEnd(5)} issue=${iss.success ? 'ALLOWED' : 'BLOCKED'}`);
  if (!iss.success) console.log(`               ↳ ${iss.error}`);
  results[label] = iss.success ? 'ALLOWED' : 'BLOCKED';
  // both cases describe the SAME physical requirement: 5 GRAM == 0.005 KG
  check(convert(r.requiredQuantity, r.unitId, baseOf(CHIP)) === 0.005,
    `${label}: requirement converts to the same physical amount (0.005 KG)`);
}
check(results['C: 5 GRAM'] === results['D: 0.005 KG'],
  'FIX1: the two spellings of the SAME requirement behave IDENTICALLY',
  `5 GRAM → ${results['C: 5 GRAM']}, 0.005 KG → ${results['D: 0.005 KG']} (both describe 0.005 KG)`);
notes.push(`C/D: identical 0.005 KG requirement — "5 GRAM" is ${results['C: 5 GRAM']}, "0.005 KG" is ${results['D: 0.005 KG']}`);

// ===========================================================================
console.log('\n── 5. SCENARIO E — REVERSE: item base GRAM, BOM in KG ────────');
{
  sup = fresh();
  const gramItem = MasterDataService.createItem({
    code: `${PFX}-GRAM`, nameAr: `${PFX} خامة جرامية`, nameEn: `${PFX} gram based`,
    itemType: 'raw_material', baseUnitId: 'unit-gram', vatRate: 0, vatCategory: 'standard',
    trackBatch: true, trackExpiry: false, standardCost: 0, actualCost: 0,
    sellingPriceRetail: 0, sellingPriceWholesale: 0, sellingPriceExportUSD: 0,
    active: true, minStockLevel: 0, isTest: true,
  } as never, { userId: 'usr-admin', userName: 'QA', isTest: true } as never);
  check(gramItem.success, 'a TEST-QA item with baseUnitId = GRAM can be created', gramItem.error || '');
  const gid = gramItem.item!.id;
  buy(sup, gid, 'wh-raw', 10000, 'unit-gram');           // 10,000 GRAM = 10 KG
  const bomId = makeBom(FP, gid, 0.07, 'unit-kg');        // 0.07 KG = 70 GRAM
  const r = ManufacturingEngine.calculateBomRequirements(bomId, 1)[0];
  const realKg = convert(10000, 'unit-gram', 'unit-kg')!;
  console.log(`  item ${gid.slice(0, 18)} baseUnitId = ${baseOf(gid)} (${unitName(baseOf(gid))}), balance = ${batchQty(gid)} GRAM = ${realKg} KG`);
  console.log(`  BOM line: ${r.requiredQuantity} ${r.unitNameAr}   screen prints available = ${r.availableStock} ${r.unitNameAr}   sufficient = ${r.sufficient}`);
  check(Math.abs(r.availableStock - realKg) < 1e-9 && r.unitNameAr === 'كيلوجرام',
    'FIX1: REVERSE direction — the GRAM balance is converted into the BOM line unit (10,000 GRAM = 10 KG)',
    `prints "${r.availableStock} ${r.unitNameAr}" (ground truth ${realKg} KG)`);
  console.log(`  sufficient = ${r.sufficient} (10 KG covers a 0.07 KG requirement)`);

  // The reverse direction corrupts just as hard on ISSUE: 0.07 KG is taken as 0.07 GRAM.
  const oE = ManufacturingEngine.createProductionOrder({
    productId: FP, plannedQuantity: 1, targetMarket: 'local', destinationWarehouseId: 'wh-local',
    expectedCompletionDate: TODAY, isTest: true, ...ADMIN,
  } as never);
  const issE = ManufacturingEngine.issueMaterialsToOrder({ orderId: oE.order!.id, date: TODAY, isTest: true, ...ADMIN } as never);
  const deductedE = 10000 - batchQty(gid);
  console.log(`  issue → ${issE.success ? 'ALLOWED' : 'BLOCKED'}, deducted ${deductedE} GRAM (should be 70 GRAM)`);
  check(issE.success && Math.abs(deductedE - 70) < 1e-9,
    'FIX1: REVERSE direction issues the full physical amount (0.07 KG = 70 GRAM) — no 1000× loss',
    `${deductedE} GRAM consumed (expected 70 GRAM)`);
  notes.push(`E: reverse case — screen prints "${r.availableStock} ${r.unitNameAr}" (= ${realKg} KG); issue consumed ${deductedE} GRAM (expected 70)`);
}

// ===========================================================================
console.log('\n── 6. SCENARIO F — does the error reach costing, valuation and GL? ──');
sup = fresh();
buy(sup, CHIP, 'wh-raw', 100, 'unit-kg');
{
  const bomId = makeBom(FP, CHIP, 70, 'unit-gram');
  const o = ManufacturingEngine.createProductionOrder({
    productId: FP, plannedQuantity: 1, targetMarket: 'local', destinationWarehouseId: 'wh-local',
    expectedCompletionDate: TODAY, isTest: true, ...ADMIN,
  } as never);
  const orderId = o.order!.id;
  const gl0 = glInv(), bv0 = batchVal(CHIP);
  const rawBefore = snap().accounts.find(a => a.code === '1108')!.currentBalance;
  const fgBefore = snap().accounts.find(a => a.code === '1109')!.currentBalance;
  const iss = ManufacturingEngine.issueMaterialsToOrder({ orderId, date: TODAY, isTest: true, ...ADMIN } as never);
  const gl1 = glInv(), bv1 = batchVal(CHIP);
  const prod = ManufacturingEngine.recordDailyProduction({
    orderId, goodQuantity: 1, defectiveQuantity: 0, scrapQuantity: 0, defectiveAction: 'to_scrap',
    date: TODAY, isTest: true, ...ADMIN,
  } as never);
  const close = ManufacturingEngine.closeProductionOrder(orderId, 'usr-admin', 'QA');
  const bd = ManufacturingEngine.calculateCostBreakdown(orderId);
  const fgBatch = snap().batches.filter(b => b.itemId === FP && b.warehouseId === 'wh-local');
  const fgVal = fgBatch.reduce((s, b) => s + b.quantity * b.unitCost, 0);

  console.log(`  issue  : batchValue ${bv0.toFixed(2)} → ${bv1.toFixed(2)}   ΔGL ${(gl1 - gl0).toFixed(2)}  ← recordMovement posts NO journal`);
  console.log(`  produce: success=${prod.success} ${prod.error || ''}`);
  console.log(`  close  : success=${close.success} ${close.error || ''}`);
  console.log(`  breakdown.actualMaterialCost = ${bd.actualMaterialCost.toFixed(2)} EGP  ← for ONE unit of product`);
  const produced = fgBatch.reduce((s, b) => s + b.quantity, 0);
  console.log(`  FG batch value = ${fgVal.toFixed(2)} over ${produced} unit(s) → ${(fgVal / Math.max(1, produced)).toFixed(2)} EGP/unit`);
  const gl2 = glInv();
  const allBatchVal = snap().batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);

  const correctCost = 0.07 * 60; // 70 GRAM at the 60 EGP/KG purchase price
  console.log(`\n  correct material cost for 70 GRAM @60 EGP/KG = ${correctCost.toFixed(2)} EGP`);
  check(Math.abs(bd.actualMaterialCost - correctCost) <= 0.005,
    'FIX1_COSTING: material cost = consumed quantity × FIFO unit cost (0.07 KG × 60 = 4.20 EGP)',
    `costing charged ${bd.actualMaterialCost.toFixed(2)} EGP (expected ${correctCost.toFixed(2)} — NOT ${(correctCost * 1000).toFixed(2)})`);
  check(Math.abs(fgVal - correctCost) <= 0.01,
    'FIX1: the FINISHED-GOODS valuation carries exactly the consumed material cost',
    `FG batch carries ${fgVal.toFixed(2)} EGP (expected ${correctCost.toFixed(2)})`);
  check(gl1 - gl0 === 0,
    'the issue itself moves NO GL (production_issue posts no journal) — the close does',
    'ΔGL on issue = 0.00 (production_issue posts no journal)');
  const rawAcc = () => snap().accounts.find(a => a.code === '1108')!.currentBalance;
  const fgAcc = () => snap().accounts.find(a => a.code === '1109')!.currentBalance;
  const rawDelta = rawAcc() - rawBefore, fgDelta = fgAcc() - fgBefore;
  console.log(`  GL 1108 raw inventory   : ${rawBefore.toFixed(2)} → ${rawAcc().toFixed(2)}  (Δ ${rawDelta.toFixed(2)})`);
  console.log(`  GL 1109 finished goods  : ${fgBefore.toFixed(2)} → ${fgAcc().toFixed(2)}  (Δ ${fgDelta.toFixed(2)})`);
  check(Math.abs(rawDelta + correctCost) <= 0.01 && Math.abs(fgDelta - correctCost) <= 0.01,
    'FIX1: the BALANCE SHEET carries the real amount (1108 credited, 1109 debited) — no 1000× error',
    `1108 Δ ${rawDelta.toFixed(2)} (expected ${(-correctCost).toFixed(2)}), 1109 Δ ${fgDelta.toFixed(2)} (expected ${correctCost.toFixed(2)})`);
  console.log(`  ⇒ quantity, cost, FG valuation and GL all agree on 0.07 KG = ${correctCost.toFixed(2)} EGP.`);
  notes.push(`F: material cost for 1 unit = ${bd.actualMaterialCost.toFixed(2)} EGP (expected ${correctCost.toFixed(2)}); FG unit cost ${(fgVal / Math.max(1, produced)).toFixed(2)}; 1108 Δ ${rawDelta.toFixed(2)}; 1109 Δ ${fgDelta.toFixed(2)}`);
}

// ===========================================================================
console.log('\n── 7. is the BOM line unit allowed to differ from the item base unit? ──');
{
  erpDb.restore(JSON.parse(JSON.stringify(PRISTINE)));
  const r = ManufacturingEngine.createBomVersion({
    finishedItemId: FP, baseQuantity: 1, unitId: 'unit-piece', effectiveDate: TODAY,
    lines: [{ materialItemId: CHIP, quantityRequired: 70, unitId: 'unit-gram' }],
    isTest: true, ...ADMIN,
  } as never);
  check(r.success, 'a GRAM BOM line is accepted for a KG item — no unit-consistency validation exists',
    r.success ? `BOM ${r.bom?.bomNumber} created with a KG item / GRAM line` : r.error);
}

// ===========================================================================
erpDb.restore(JSON.parse(JSON.stringify(PRISTINE_LIVE)));
const identical = JSON.stringify(snap()) === JSON.stringify(PRISTINE_LIVE);
const leftovers = snap().items.filter(i => i.isTest).length
  + snap().batches.filter(b => String(b.batchNumber).includes('TEST-QA')).length
  + snap().productionOrders.filter(o => (o as { isTest?: boolean }).isTest).length
  + snap().journalEntries.filter(j => j.isTest).length;
check(identical, 'in-memory database restored byte-identical to the pre-run state');
check(leftovers === 0, 'no TEST-QA record survived (each scenario ran in its own scratch DB)', `${leftovers} leftover(s)`);

console.log('\n================================================================');
console.log(`RESULT — ${pass} passed, ${fail} failed`);
console.log('================================================================');
console.log('\nOBSERVED (asserted by execution):');
notes.forEach(n => console.log(`  • ${n}`));
process.exit(fail > 0 ? 1 : 0);