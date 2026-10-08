// ============================================================================
// FIX 6 — DEDICATED REGRESSION TESTS (production conversion cost actuals)
//
//   FIX6_ZERO_ACTUALS           no actual expense ⇒ every actual = 0 and
//                               variance = 0 − standard (never standard itself)
//   FIX6_LABOR_ONLY             labor 1000 ⇒ only labor moves
//   FIX6_LABOR_ELECTRICITY      labor 1000 + electricity 500 ⇒ only those two
//   FIX6_CATEGORY_ISOLATION     recording category X changes ONLY X
//   FIX6_NEGATIVE_ACTUAL_PROTECTION
//                               no actual ever goes negative without a
//                               same-category credit, and every conversion
//                               journal satisfies SUM(debits) = SUM(credits)
//
// Standards used by the tests (rate × produced/baseQuantity, base = 1000 and
// produced = 1000 ⇒ the standard equals the rate): labor 175, electricity 70,
// gas 3.5, maintenance 35, supervision 21.
//
// Every scenario runs through the REAL service layer against an in-memory
// scratch database; the exact pre-run state is captured first and restored +
// asserted byte-identical at the end. No UAT record is touched.
import { erpDb, createEmptyDatabase, applyMasterDataMigration, applyUomMigration } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { WorkflowService } from '../src/services/workflows';
import type { ProductionCostBreakdown } from '../src/services/manufacturing';

const snap = () => erpDb.getSnapshot();
const TODAY = new Date().toISOString().split('T')[0];
const RID = `F6-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const ADMIN = { userId: 'usr-admin', userName: 'QA' };

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

/** Current GL balance of an account by its chart code. */
const glCode = (code: string) => snap().accounts.find(a => a.code === code)?.currentBalance || 0;
/** Current GL balance of an account resolved through the configured mappings. */
const glOfMapping = (key: string): number => {
  const accId = (snap().accountMappings as Record<string, string>)[key];
  return accId ? (snap().accounts.find(a => a.id === accId)?.currentBalance || 0) : NaN;
};

/** The five conversion-cost categories and their benchmark standards. */
const CATS = ['direct_labor', 'electricity', 'gas', 'maintenance', 'supervision'] as const;
type Cat = (typeof CATS)[number];
const STD: Record<Cat, number> = { direct_labor: 175, electricity: 70, gas: 3.5, maintenance: 35, supervision: 21 };
const ACT_KEY: Record<Cat, keyof ProductionCostBreakdown> = {
  direct_labor: 'actualLaborCost',
  electricity: 'actualElectricityCost',
  gas: 'actualGasCost',
  maintenance: 'actualMaintenanceCost',
  supervision: 'actualSupervisionCost',
};
const STD_KEY: Record<Cat, keyof ProductionCostBreakdown> = {
  direct_labor: 'standardLaborCost',
  electricity: 'standardElectricityCost',
  gas: 'standardGasCost',
  maintenance: 'standardMaintenanceCost',
  supervision: 'standardSupervisionCost',
};
const VAR_KEY: Record<Cat, keyof ProductionCostBreakdown> = {
  direct_labor: 'laborVariance',
  electricity: 'electricityVariance',
  gas: 'gasVariance',
  maintenance: 'maintenanceVariance',
  supervision: 'supervisionVariance',
};
const MAP_KEY: Record<Cat, string> = {
  direct_labor: 'variance_direct_labor',
  electricity: 'variance_electricity',
  gas: 'variance_gas',
  maintenance: 'variance_maintenance',
  supervision: 'variance_overhead',
};

const actuals = (bd: ProductionCostBreakdown): Record<Cat, number> =>
  Object.fromEntries(CATS.map(c => [c, bd[ACT_KEY[c]] as number])) as Record<Cat, number>;
const standards = (bd: ProductionCostBreakdown): Record<Cat, number> =>
  Object.fromEntries(CATS.map(c => [c, bd[STD_KEY[c]] as number])) as Record<Cat, number>;
const variances = (bd: ProductionCostBreakdown): Record<Cat, number> =>
  Object.fromEntries(CATS.map(c => [c, bd[VAR_KEY[c]] as number])) as Record<Cat, number>;

function fresh(): string {
  erpDb.restore(JSON.parse(JSON.stringify(PRISTINE)));
  // The five benchmark standards, exactly as the acceptance test specifies.
  erpDb.mutate(d => {
    d.standardCostRates = CATS.map((c, i) => ({
      id: `${PFX}-rate-${i}`, costType: c, rate: STD[c], baseQuantity: 1000, currency: 'EGP',
      effectiveFrom: '2000-01-01', effectiveTo: '2099-12-31', status: 'active',
    } as never));
  });
  const sup = MasterDataService.createSupplier({
    code: `${PFX}-SUP`, name: `مورد ${PFX}`, isTest: true, ...ADMIN,
  } as never)!.supplier!;

  const r = WorkflowService.createPurchaseInvoice({
    supplierId: sup.id, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `${PFX}-P`, date: TODAY,
    lines: [{ itemId: CHIP, quantity: 1200, unitId: 'unit-kg', unitPrice: 40, batchNumber: `${PFX}-B`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (!r.success) throw new Error(`purchase failed: ${r.error}`);

  const bom = ManufacturingEngine.createBomVersion({
    finishedItemId: FP, baseQuantity: 1, unitId: 'unit-piece', effectiveDate: TODAY,
    lines: [{ materialItemId: CHIP, quantityRequired: 1, unitId: 'unit-kg' }],
    isTest: true, ...ADMIN,
  } as never);
  if (!bom.success) throw new Error(`bom failed: ${bom.error}`);

  const o = ManufacturingEngine.createProductionOrder({
    productId: FP, plannedQuantity: 1000, targetMarket: 'local', destinationWarehouseId: 'wh-local',
    expectedCompletionDate: TODAY, isTest: true, ...ADMIN,
  } as never);
  if (!o.success) throw new Error(`order failed: ${o.error}`);
  const orderId = o.order!.id;

  const iss = ManufacturingEngine.issueMaterialsToOrder({ orderId, date: TODAY, ...ADMIN } as never);
  if (!iss.success) throw new Error(`issue failed: ${iss.error}`);
  const p = ManufacturingEngine.recordDailyProduction({
    orderId, goodQuantity: 1000, defectiveQuantity: 0, scrapQuantity: 0, defectiveAction: 'to_scrap',
    date: TODAY, isTest: true, ...ADMIN,
  } as never);
  if (!p.success) throw new Error(`production failed: ${p.error}`);
  return orderId;
}

function record(orderId: string, costType: Cat, amount: number) {
  const r = ManufacturingEngine.recordConversionCost({
    orderId, costType, amount, date: TODAY, isTest: true, ...ADMIN,
  } as never) as { success: boolean; error?: string; accountId?: string; journalEntryId?: string };
  if (!r.success) throw new Error(`record ${costType} failed: ${r.error}`);
  return r;
}

const fmt = (v: Record<Cat, number>) => CATS.map(c => `${c}=${v[c]}`).join(' ');

console.log('================================================================');
console.log(`🧪 FIX 6 — PRODUCTION CONVERSION COST ACTUALS — ${RID}`);
console.log('================================================================');

// ===========================================================================
console.log('\n── FIX6_ZERO_ACTUALS ──────────────────────────────────────────');
{
  const orderId = fresh();
  const bd = ManufacturingEngine.calculateCostBreakdown(orderId);
  const a = actuals(bd), s = standards(bd), v = variances(bd);

  check(CATS.every(c => near(a[c], 0)),
    'with NO recorded expense every actual conversion cost is 0 (never substituted by standard)',
    fmt(a));
  check(near(s.direct_labor, 175) && near(s.electricity, 70) && near(s.gas, 3.5)
    && near(s.maintenance, 35) && near(s.supervision, 21),
    'the standards are the configured benchmarks (175 / 70 / 3.5 / 35 / 21)',
    fmt(s));
  check(near(v.direct_labor, -175) && near(v.electricity, -70) && near(v.gas, -3.5)
    && near(v.maintenance, -35) && near(v.supervision, -21),
    'variance = actual − standard = −175 / −70 / −3.5 / −35 / −21',
    fmt(v));
  check(CATS.every(c => near(v[c], a[c] - s[c])),
    'variance = actual − standard is verified independently for every category',
    CATS.map(c => `${c}: ${v[c]} = ${a[c]} − ${s[c]}`).join(' | '));
  check(!CATS.some(c => a[c] !== 0),
    'NO actual silently becomes the standard cost',
    `actuals are ${fmt(a)}`);
}

// ===========================================================================
console.log('\n── FIX6_LABOR_ONLY ────────────────────────────────────────────');
{
  const orderId = fresh();
  const before = actuals(ManufacturingEngine.calculateCostBreakdown(orderId));
  record(orderId, 'direct_labor', 1000);
  const bd = ManufacturingEngine.calculateCostBreakdown(orderId);
  const a = actuals(bd);
  check(near(a.direct_labor, 1000), 'actualLabor = 1000', `actualLabor=${a.direct_labor}`);
  check(near(a.electricity, 0) && near(a.gas, 0) && near(a.maintenance, 0) && near(a.supervision, 0),
    'actualElectricity / Gas / Maintenance / Supervision stay 0',
    fmt(a));
  check(CATS.filter(c => c !== 'direct_labor').every(c => near(a[c], before[c])),
    'recording LABOR changed NOTHING in the other four categories',
    CATS.filter(c => c !== 'direct_labor').map(c => `${c}: ${before[c]}→${a[c]}`).join(', '));
  check(near(a.direct_labor, 1000) && near(bd[VAR_KEY.direct_labor], 1000 - 175),
    'variance for labor = 1000 − 175 = 825',
    `laborVariance=${bd[VAR_KEY.direct_labor]}`);
  check(CATS.every(c => a[c] >= 0), 'no actual is negative', fmt(a));
}

// ===========================================================================
console.log('\n── FIX6_LABOR_ELECTRICITY ─────────────────────────────────────');
{
  const orderId = fresh();
  record(orderId, 'direct_labor', 1000);
  record(orderId, 'electricity', 500);
  const a = actuals(ManufacturingEngine.calculateCostBreakdown(orderId));
  check(near(a.direct_labor, 1000) && near(a.electricity, 500),
    'actualLabor = 1000 and actualElectricity = 500',
    `labor=${a.direct_labor} electricity=${a.electricity}`);
  check(near(a.gas, 0) && near(a.maintenance, 0) && near(a.supervision, 0),
    'gas / maintenance / supervision stay 0',
    `gas=${a.gas} maintenance=${a.maintenance} supervision=${a.supervision}`);
  check(CATS.every(c => a[c] >= 0), 'no unrelated category became negative',
    fmt(a));
}

// ===========================================================================
console.log('\n── FIX6_CATEGORY_ISOLATION ────────────────────────────────────');
{
  const orderId = fresh();
  const amounts: Record<Cat, number> = { direct_labor: 111, electricity: 222, gas: 333, maintenance: 444, supervision: 555 };
  let expected: Record<Cat, number> = { direct_labor: 0, electricity: 0, gas: 0, maintenance: 0, supervision: 0 };
  let allIsolated = true;
  let onlyTargetChanged = true;

  for (const c of CATS) {
    const snapshot = actuals(ManufacturingEngine.calculateCostBreakdown(orderId));
    record(orderId, c, amounts[c]);
    const after = actuals(ManufacturingEngine.calculateCostBreakdown(orderId));
    expected = { ...expected, [c]: expected[c] + amounts[c] };
    for (const other of CATS) {
      if (other === c) continue;
      if (!near(after[other], snapshot[other])) onlyTargetChanged = false;
    }
    if (!near(after[c], expected[c])) allIsolated = false;
    console.log(`     recorded ${c.padEnd(14)} ${String(amounts[c]).padStart(4)} → ${fmt(after)}`);
  }
  check(onlyTargetChanged,
    'recording a category NEVER changed any other category (all five, in sequence)');
  check(allIsolated,
    'each category accumulated exactly its own recorded amounts',
    fmt(expected));
  const final = actuals(ManufacturingEngine.calculateCostBreakdown(orderId));
  check(near(final.direct_labor, 111) && near(final.electricity, 222) && near(final.gas, 333)
    && near(final.maintenance, 444) && near(final.supervision, 555),
    'final actuals = 111 / 222 / 333 / 444 / 555 — no cross-contamination',
    fmt(final));
  check(CATS.every(c => final[c] >= 0), 'no category is negative', fmt(final));

  // Journal-level isolation: every conversion entry debits its OWN account.
  const jvs = snap().journalEntries.filter(j => j.sourceDocumentType === 'production_conversion_cost');
  const accountIds = jvs.map(j => j.lines.find(l => (l.debit || 0) > 0)?.accountId);
  check(new Set(accountIds).size === CATS.length,
    'each category posted to its OWN expense account (5 distinct accounts)',
    `${new Set(accountIds).size} distinct debit accounts for ${jvs.length} entries`);
  const mappedIds = CATS.map(c => (snap().accountMappings as Record<string, string>)[MAP_KEY[c]]);
  check(mappedIds.every(Boolean) && new Set(mappedIds).size === CATS.length,
    'the five cost types are mapped to five DISTINCT GL accounts',
    mappedIds.join(', '));
}

// ===========================================================================
console.log('\n── FIX6_NEGATIVE_ACTUAL_PROTECTION ────────────────────────────');
{
  const orderId = fresh();
  record(orderId, 'direct_labor', 1000);
  let a = actuals(ManufacturingEngine.calculateCostBreakdown(orderId));
  check(CATS.every(c => a[c] >= 0),
    'after recording labor, NO actual (including the untouched ones) is negative',
    fmt(a));
  check(!near(a.electricity, -1000) && !near(a.gas, -1000) && !near(a.maintenance, -1000) && !near(a.supervision, -1000),
    'the credit leg of the conversion journal does NOT bleed into the other categories',
    fmt(a));

  record(orderId, 'electricity', 500);
  a = actuals(ManufacturingEngine.calculateCostBreakdown(orderId));
  check(CATS.every(c => a[c] >= 0), 'after recording electricity, still no negative actual',
    fmt(a));

  // Every conversion journal must balance, and each one is a clean 2-leg entry.
  const jvs = snap().journalEntries.filter(j => j.sourceDocumentType === 'production_conversion_cost');
  const unbalanced = jvs.filter(j =>
    Math.abs(j.lines.reduce((s, l) => s + (l.debit || 0), 0) - j.lines.reduce((s, l) => s + (l.credit || 0), 0)) > 0.01);
  check(jvs.length === 2, 'two conversion journals were posted (labor + electricity)',
    `entries=${jvs.length}`);
  check(unbalanced.length === 0,
    'EVERY conversion journal satisfies SUM(debits) = SUM(credits)',
    jvs.map(j => `${j.entryNumber}: ${j.lines.reduce((s, l) => s + (l.debit || 0), 0).toFixed(2)}/${j.lines.reduce((s, l) => s + (l.credit || 0), 0).toFixed(2)}`).join(' | '));
  check(jvs.every(j => j.lines.every(l => (l.debit || 0) >= 0 && (l.credit || 0) >= 0)),
    'no negative debit/credit legs (no plug or reversal-by-sign)');
  check(jvs.every(j => j.lines.filter(l => (l.debit || 0) > 0).length === 1),
    'each conversion journal has exactly ONE debit leg (the category account)',
    `${jvs.length} entries`);

  // The GL balance of the category accounts mirrors the recorded actuals.
  const glOf = (mappingKey: string) => {
    const accId = (snap().accountMappings as Record<string, string>)[mappingKey];
    return snap().accounts.find(x => x.id === accId)?.currentBalance || 0;
  };
  check(near(glOf('variance_direct_labor'), 1000) && near(glOf('variance_electricity'), 500)
    && near(glOf('variance_gas'), 0) && near(glOf('variance_maintenance'), 0) && near(glOf('variance_overhead'), 0),
    'the GL balances of the five category accounts equal the actuals (1000 / 500 / 0 / 0 / 0)',
    `5105=${glOf('variance_direct_labor')} 5106=${glOf('variance_electricity')} 5107=${glOf('variance_gas')} 5108=${glOf('variance_maintenance')} 5109=${glOf('variance_overhead')}`);
}

// ===========================================================================
console.log('\n── FIX6_CLOSURE_ABSORPTION (journal integrity through to the GL) ──');
{
  const orderId = fresh();
  record(orderId, 'direct_labor', 1000);
  const acc6101Before = glCode('6101');
  const ok = ManufacturingEngine.closeProductionOrder(orderId, 'usr-admin', 'QA');
  check(ok.success, 'the order closes with a recorded conversion cost', ok.error || '');

  const jv = snap().journalEntries.filter(j => j.sourceDocumentType === 'production_order_close' && j.sourceDocumentId === orderId);
  check(jv.length === 1, 'exactly one closure journal', `journals=${jv.length}`);
  check(jv.every(j => near(j.lines.reduce((s, l) => s + (l.debit || 0), 0), j.lines.reduce((s, l) => s + (l.credit || 0), 0), 0.01)),
    'SUM(debits) = SUM(credits) for the closure journal',
    jv.map(j => `${j.lines.reduce((s, l) => s + (l.debit || 0), 0).toFixed(2)}/${j.lines.reduce((s, l) => s + (l.credit || 0), 0).toFixed(2)}`).join(', '));

  check(near(glOfMapping('variance_direct_labor'), 0),
    'the labour category account is CLEARED into finished goods (expense → asset, nothing left behind)',
    `5105=${glOfMapping('variance_direct_labor')}`);
  check(near(glCode('6101'), acc6101Before) && glCode('6101') >= 0,
    'an UNRELATED expense account is neither credited nor pushed negative',
    `6101 ${acc6101Before} → ${glCode('6101')}`);
  check(near(glOfMapping('conversion_cost_payable') || glCode('2104'), 1000),
    'the conversion cost sits as an ACCRUED LIABILITY of 1000',
    `2104=${glCode('2104')}`);

  const fgDebit = jv.reduce((s, j) => s + j.lines.filter(l => l.accountCode === '1109').reduce((x, l) => x + (l.debit || 0), 0), 0);
  const bd = ManufacturingEngine.calculateCostBreakdown(orderId);
  check(near(fgDebit, bd.actualMaterialCost + 1000),
    'FG is capitalised at consumed material + the 1000 of conversion cost',
    `1109=${fgDebit.toFixed(2)} = material ${bd.actualMaterialCost.toFixed(2)} + conversion 1000`);

  const convJv = snap().journalEntries.filter(j => j.sourceDocumentType === 'production_conversion_cost');
  check(convJv.every(j => near(j.lines.reduce((s, l) => s + (l.debit || 0), 0), j.lines.reduce((s, l) => s + (l.credit || 0), 0), 0.01)),
    'every conversion journal still balances',
    convJv.map(j => `${j.lines.reduce((s, l) => s + (l.debit || 0), 0).toFixed(2)}/${j.lines.reduce((s, l) => s + (l.credit || 0), 0).toFixed(2)}`).join(', '));
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
console.log(`FIX 6 RESULT — ${pass} passed, ${fail} failed`);
console.log('================================================================');
process.exit(fail > 0 ? 1 : 0);
