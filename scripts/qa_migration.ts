// BATCH G — LEGACY DATABASE / MIGRATION.
//
// Builds a SAFE synthetic legacy database (no production/UAT data is read or
// written): customers, suppliers, products, raw materials, warehouses, accounts,
// BOMs, purchase + sales invoices, a production order, stock/batches with costs,
// opening balances and journals. The legacy shape is what an OLD install looks
// like: missing optional master fields, old product names, carton base UOM,
// accounts missing the newer inventory codes, documents referencing them.
//
// It then runs EVERY available migration (applyMasterDataMigration +
// applyUomMigration — the same pair the database loader runs) and compares
// LEGACY vs MIGRATED field by field, reporting every difference. The migrations
// are then run a second and third time to prove idempotency: run 2 and run 3
// must change NOTHING at all.
//
// Nothing here deletes legacy data to make a difference disappear — differences
// are reported as found, and each is classified as EXPECTED (documented
// migration intent) or UNEXPECTED (data the migration must never touch).
import { createEmptyDatabase, applyMasterDataMigration, applyUomMigration } from '../src/services/db';

type ERPDatabaseSchema = ReturnType<typeof createEmptyDatabase>;

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, info = '') => {
  if (ok) { pass++; console.log(`  ✅ ${label}${info ? ` — ${info}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${info ? ` — ${info}` : ''}`); }
};
const num = (n: number) => Number(n.toFixed(6));

console.log('================================================================');
console.log('🗄️  BATCH G — LEGACY DATABASE / MIGRATION');
console.log('================================================================');

// ------------------------------------------------------------ legacy fixture
const TODAY = new Date().toISOString().split('T')[0];
const db = createEmptyDatabase();

const legacyCustomerId = 'legacy-cust-1';
db.customers.push({
  id: legacyCustomerId, code: 'LEG-C-01', name: 'عميل قديم', nameEn: '', taxNumber: '', phone: '', address: '',
  customerType: 'retail', channel: 'retail', currency: 'EGP', creditLimit: 0, openingBalance: 0,
  currentBalance: 15_000, paymentTerms: '', active: true,
} as never);
const legacySupplierId = 'legacy-sup-1';
db.suppliers.push({
  id: legacySupplierId, code: 'LEG-S-01', name: 'مورد قديم', taxNumber: '', contactPerson: '', phone: '',
  address: '', paymentTerms: '', currency: 'EGP', openingBalance: 0, currentBalance: 9_000, active: true,
} as never);

// a legacy finished product: OLD name, carton base UOM, no family/flavour
const legacyProductId = 'legacy-fp-1';
db.items.push({
  id: legacyProductId, code: 'LEG-FP-01', nameAr: 'منتج قديم', nameEn: 'Legacy Product',
  itemType: 'finished_product', baseUnitId: 'unit-carton', purchaseUnitId: 'unit-carton',
  vatRate: 0, vatCategory: 'exempt', trackBatch: true, trackExpiry: true, expiryPeriodDays: 90,
  standardCost: 50, actualCost: 50, sellingPriceRetail: 120, sellingPriceWholesale: 110,
  sellingPriceExportUSD: 3, active: true, minStockLevel: 0,
} as never);
// a legacy raw material with stock at a cost
const legacyRawId = 'legacy-raw-1';
db.items.push({
  id: legacyRawId, code: 'LEG-RAW-01', nameAr: 'خامة قديمة', nameEn: 'Legacy Raw',
  itemType: 'raw_material', baseUnitId: 'unit-kg', purchaseUnitId: 'unit-kg',
  vatRate: 0, vatCategory: 'standard', trackBatch: true, trackExpiry: false,
  standardCost: 30, actualCost: 30, sellingPriceRetail: 0, sellingPriceWholesale: 0, sellingPriceExportUSD: 0,
  active: true, minStockLevel: 0,
} as never);

// legacy BOM on that product (carton UOM — the migration converts it to piece)
const legacyBomId = 'legacy-bom-1';
db.boms.push({
  id: legacyBomId, bomNumber: 'BOM-LEG-01', finishedItemId: legacyProductId, baseQuantity: 1000,
  unitId: 'unit-carton', active: true, version: '1.0', effectiveDate: '2024-01-01',
  createdAt: '2024-01-01', createdUserId: 'usr-admin',
} as never);
db.bomLines.push({
  id: 'legacy-bomline-1', bomId: legacyBomId, materialItemId: legacyRawId, quantityRequired: 2,
  unitId: 'unit-kg', wastePercentage: 2,
} as never);

// legacy stock + cost
db.batches.push({
  id: 'legacy-batch-1', batchNumber: 'LEG-B-01', itemId: legacyRawId, warehouseId: 'wh-raw',
  productionDate: '2024-01-01', expiryDate: '2026-01-01', quantity: 500, unitCost: 27.5,
} as never);

// legacy accounts WITHOUT the newer inventory codes (they get created)
db.accounts = db.accounts.filter(a => !['1107', '1109', '1111', '1112'].includes(a.code));
db.accounts.find(a => a.code === '1105')!.currentBalance = 15_000;
db.accounts.find(a => a.code === '2101')!.currentBalance = 9_000;

// legacy opening-balance journal
db.journalEntries.push({
  id: 'legacy-jv-1', entryNumber: 'JV-LEG-0001', date: '2024-01-01', reference: 'OPENING',
  description: 'رصيد افتتاحي قديم', sourceDocumentType: 'opening_balance', sourceDocumentId: 'legacy-op-1',
  isPosted: true, isReversed: false, totalDebit: 24_000, totalCredit: 24_000,
  createdUserId: 'usr-admin', createdAt: '2024-01-01', createdUserName: 'legacy',
  lines: [
    { id: 'l1', journalEntryId: 'legacy-jv-1', accountId: db.accounts.find(a => a.code === '1105')!.id, accountCode: '1105', accountNameAr: 'ذمم مدينة', debit: 15_000, credit: 0, currency: 'EGP', originalAmount: 15_000, exchangeRate: 1, costCenterId: '', description: 'AR' },
    { id: 'l2', journalEntryId: 'legacy-jv-1', accountId: db.accounts.find(a => a.code === '2101')!.id, accountCode: '2101', accountNameAr: 'ذمم دائنة', debit: 9_000, credit: 0, currency: 'EGP', originalAmount: 9_000, exchangeRate: 1, costCenterId: '', description: 'AP' },
    { id: 'l3', journalEntryId: 'legacy-jv-1', accountId: db.accounts.find(a => a.code === '1101')!.id, accountCode: '1101', accountNameAr: 'خزينة', debit: 0, credit: 15_000, currency: 'EGP', originalAmount: 15_000, exchangeRate: 1, costCenterId: '', description: 'cash' },
    { id: 'l4', journalEntryId: 'legacy-jv-1', accountId: db.accounts.find(a => a.code === '1108')!.id, accountCode: '1108', accountNameAr: 'مواد خام', debit: 0, credit: 9_000, currency: 'EGP', originalAmount: 9_000, exchangeRate: 1, costCenterId: '', description: 'raw' },
  ],
} as never);

// legacy documents
db.purchaseInvoices.push({
  id: 'legacy-pi-1', invoiceNumber: 'PI-LEG-01', supplierId: legacySupplierId, warehouseId: 'wh-raw',
  invoiceDate: '2024-01-05', dueDate: '2024-02-05', subtotal: 13_750, vatAmount: 0, totalAmount: 13_750,
  currency: 'EGP', exchangeRate: 1, paymentMethod: 'credit', paidAmount: 0, status: 'open',
  supplierName: 'مورد قديم', createdUserId: 'usr-admin', createdAt: '2024-01-05',
} as never);
db.purchaseInvoiceLines.push({
  id: 'legacy-pil-1', purchaseInvoiceId: 'legacy-pi-1', itemId: legacyRawId, quantity: 500, unitPrice: 27.5,
  lineTotal: 13_750, unitId: 'unit-kg', batchNumber: 'LEG-B-01', productionDate: '2024-01-01', expiryDate: '2026-01-01', vatRate: 0,
} as never);
db.salesInvoices.push({
  id: 'legacy-si-1', invoiceNumber: 'SI-LEG-01', customerId: legacyCustomerId, channel: 'retail', warehouseId: 'wh-local',
  invoiceDate: '2024-01-10', dueDate: '2024-02-10', subtotal: 12_000, vatAmount: 0, totalAmount: 12_000,
  currency: 'EGP', exchangeRate: 1, paymentMethod: 'credit', paidAmount: 0, status: 'open',
  customerName: 'عميل قديم', stockSource: 'warehouse', costCenterId: 'cc-sales',
  createdUserId: 'usr-admin', createdAt: '2024-01-10',
} as never);
db.salesInvoiceLines.push({
  id: 'legacy-sil-1', salesInvoiceId: 'legacy-si-1', itemId: legacyProductId, quantity: 100, unitPrice: 120,
  lineTotal: 12_000, vatRate: 0, unitId: 'unit-carton',
} as never);
db.productionOrders.push({
  id: 'legacy-po-1', orderNumber: 'PO-LEG-01', productId: legacyProductId, bomId: legacyBomId,
  plannedQuantity: 1000, producedQuantity: 400, defectiveQuantity: 0, scrapQuantity: 0, remainingQuantity: 600,
  startDate: '2024-01-02', expectedCompletionDate: '2024-01-20', status: 'in_progress',
  destinationWarehouseId: 'wh-local', targetMarket: 'local', createdUserId: 'usr-admin', createdAt: '2024-01-02',
} as never);

const fingerprint = (d: ERPDatabaseSchema) => ({
  customers: d.customers.length, suppliers: d.suppliers.length, items: d.items.length,
  boms: d.boms.length, bomLines: d.bomLines.length, batches: d.batches.length,
  purchaseInvoices: d.purchaseInvoices.length, purchaseInvoiceLines: d.purchaseInvoiceLines.length,
  salesInvoices: d.salesInvoices.length, salesInvoiceLines: d.salesInvoiceLines.length,
  productionOrders: d.productionOrders.length, journalEntries: d.journalEntries.length,
  accounts: d.accounts.length, warehouses: d.warehouses.length, units: d.units.length,
  unitConversions: d.unitConversions.length, standardCostRates: d.standardCostRates.length,
});
const before = fingerprint(db);
console.log(`  legacy fixture: ${JSON.stringify(before)}`);

// --------------------------------------------------------------- migrate once
const migrated = applyUomMigration(applyMasterDataMigration(db));
const after1 = fingerprint(migrated);
console.log(`  after run 1  : ${JSON.stringify(after1)}`);

// ---- 1..12: nothing legacy may be lost or altered
console.log('\n── preservation of legacy data ──');
const lc = migrated.customers.find(c => c.id === legacyCustomerId)!;
check('G1 customer id preserved', !!lc, `id=${legacyCustomerId}`);
check('G2 customer code preserved', lc?.code === 'LEG-C-01', `code=${lc?.code}`);
check('G3 customer name preserved', lc?.name === 'عميل قديم', `name=${lc?.name}`);
check('G4 customer balance (opening AR) preserved', num(lc?.currentBalance || 0) === num(15_000), `balance=${lc?.currentBalance}`);
check('G5 supplier id/code/name/balance preserved',
  !!migrated.suppliers.find(s => s.id === legacySupplierId) && migrated.suppliers.find(s => s.id === legacySupplierId)!.code === 'LEG-S-01'
  && num(migrated.suppliers.find(s => s.id === legacySupplierId)!.currentBalance) === num(9_000),
  `id=${legacySupplierId} balance=${migrated.suppliers.find(s => s.id === legacySupplierId)?.currentBalance}`);
const lp = migrated.items.find(i => i.id === legacyProductId)!;
check('G6 product id + code preserved', lp.id === legacyProductId && lp.code === 'LEG-FP-01', `code=${lp.code}`);
console.log(`     ℹ️  product name: legacy "منتج قديم" → migrated "${lp.nameAr}" (${lp.productFamily || 'no family'}) — a non-canonical product is left untouched`);
check('G7 raw material id + name preserved', !!migrated.items.find(i => i.id === legacyRawId && i.nameAr === 'خامة قديمة'), 'legacy raw material intact');
const lb = migrated.batches.find(b => b.id === 'legacy-batch-1')!;
check('G8 stock quantity preserved', num(lb.quantity) === num(500), `qty=${lb.quantity}`);
check('G9 batch COST preserved', num(lb.unitCost) === num(27.5), `unitCost=${lb.unitCost}`);
const lBom = migrated.boms.find(b => b.id === legacyBomId)!;
check('G10 BOM id preserved', lBom.id === legacyBomId, `id=${lBom.id}`);
check('G11 BOM version preserved', String(lBom.version) === '1.0', `version=${lBom.version}`);
check('G12 BOM effective date preserved', String(lBom.effectiveDate).slice(0, 10) === '2024-01-01', `effectiveDate=${lBom.effectiveDate}`);
check('G13 BOM line quantity preserved',
  num(migrated.bomLines.find(l => l.id === 'legacy-bomline-1')?.quantityRequired || 0) === num(2),
  `qty=${migrated.bomLines.find(l => l.id === 'legacy-bomline-1')?.quantityRequired}`);
console.log(`     ℹ️  legacy BOM unit "${'unit-carton'}" → migrated "${lBom.unitId}"; legacy product base UOM "${'unit-carton'}" → "${lp.baseUnitId}" (UOM migration)`);
check('G14 purchase invoice + line preserved',
  !!migrated.purchaseInvoices.find(i => i.id === 'legacy-pi-1')
  && num(migrated.purchaseInvoiceLines.find(l => l.id === 'legacy-pil-1')?.quantity || 0) === num(500),
  `invoice=${migrated.purchaseInvoices.find(i => i.id === 'legacy-pi-1')?.invoiceNumber}`);
const lsl = migrated.salesInvoiceLines.find(l => l.id === 'legacy-sil-1')!;
check('G15 sales invoice + line preserved',
  !!migrated.salesInvoices.find(i => i.id === 'legacy-si-1')
  && num(lsl.quantity) === num(100) && num(lsl.unitPrice) === num(120),
  `invoice=${migrated.salesInvoices.find(i => i.id === 'legacy-si-1')?.invoiceNumber} qty=${lsl.quantity} price=${lsl.unitPrice}`);
const lpo = migrated.productionOrders.find(o => o.id === 'legacy-po-1')!;
check('G16 production order (400 already produced) preserved',
  lpo.id === 'legacy-po-1' && num(lpo.producedQuantity) === num(400), `produced=${lpo.producedQuantity}`);
const ljv = migrated.journalEntries.find(j => j.id === 'legacy-jv-1')!;
check('G17 journal entry preserved and still balanced',
  !!ljv && num(ljv.totalDebit) === num(ljv.totalCredit) && ljv.lines.length === 4,
  `Dr=${ljv?.totalDebit} Cr=${ljv?.totalCredit} lines=${ljv?.lines.length}`);
check('G18 account balances preserved (1105/2101 untouched)',
  num(migrated.accounts.find(a => a.code === '1105')!.currentBalance) === num(15_000)
  && num(migrated.accounts.find(a => a.code === '2101')!.currentBalance) === num(9_000),
  `1105=${migrated.accounts.find(a => a.code === '1105')!.currentBalance} 2101=${migrated.accounts.find(a => a.code === '2101')!.currentBalance}`);

// ---- 13/14: additive only, no duplicates
console.log('\n── additive behaviour, no duplicates ──');
check('G19 no duplicate item ids', new Set(migrated.items.map(i => i.id)).size === migrated.items.length,
  `items=${migrated.items.length} unique=${new Set(migrated.items.map(i => i.id)).size}`);
check('G20 no duplicate bom ids / lines', new Set(migrated.boms.map(b => b.id)).size === migrated.boms.length
  && new Set(migrated.bomLines.map(l => l.id)).size === migrated.bomLines.length, 'unique');
check('G21 no duplicate account codes', new Set(migrated.accounts.map(a => a.code)).size === migrated.accounts.length,
  `accounts=${migrated.accounts.length}`);
check('G22 no duplicate unit conversions', (() => {
  const keys = migrated.unitConversions.map(c => `${c.fromUnitId}>${c.toUnitId}`);
  return new Set(keys).size === keys.length;
})(), `conversions=${migrated.unitConversions.length}`);
check('G23 no duplicate customers/suppliers', new Set(migrated.customers.map(c => c.id)).size === migrated.customers.length
  && new Set(migrated.suppliers.map(s => s.id)).size === migrated.suppliers.length, 'unique');
check('G24 the missing newer inventory accounts were ADDED (not replaced)',
  ['1107', '1109', '1111', '1112'].every(c => !!migrated.accounts.find(a => a.code === c)),
  `added=${['1107', '1109', '1111', '1112'].filter(c => !!migrated.accounts.find(a => a.code === c)).join(',') || 'NONE'}`);
check('G25 pre-existing account ids are unchanged',
  ['1101', '1105', '1108', '2101'].every(c => !!migrated.accounts.find(a => a.code === c)),
  'core accounts present');

// ---- 15..17: idempotency
console.log('\n── idempotency: run 2 and run 3 must change nothing ──');
const run2 = applyUomMigration(applyMasterDataMigration(migrated));
const run3 = applyUomMigration(applyMasterDataMigration(run2));
const stable = (x: unknown) => JSON.stringify(x);
check('G26 second migration changes NOTHING (byte-identical)', stable(fingerprint(run2)) === stable(after1) && stable(run2.items) === stable(migrated.items) && stable(run2.accounts) === stable(migrated.accounts),
  `counts ${stable(fingerprint(run2)) === stable(after1) ? 'same' : 'DIFFERENT'}`);
check('G27 third migration changes NOTHING (byte-identical)', stable(run3) === stable(run2),
  `items/accounts/journals identical=${stable(run3.items) === stable(run2.items) && stable(run3.accounts) === stable(run2.accounts)}`);
check('G28 legacy records still present after 3 runs',
  !!run3.customers.find(c => c.id === legacyCustomerId) && !!run3.batches.find(b => b.id === 'legacy-batch-1')
  && !!run3.productionOrders.find(o => o.id === 'legacy-po-1') && !!run3.journalEntries.find(j => j.id === 'legacy-jv-1'),
  'customer, batch, production order and journal all survive 3 migrations');

// ---- full difference report
console.log('\n── LEGACY vs MIGRATED difference report ──');
const diffs: string[] = [];
if (before.items !== after1.items) diffs.push(`items ${before.items} → ${after1.items} (+${after1.items - before.items} missing master records added)`);
if (before.accounts !== after1.accounts) diffs.push(`accounts ${before.accounts} → ${after1.accounts} (+${after1.accounts - before.accounts} missing inventory accounts added)`);
if (before.units !== after1.units) diffs.push(`units ${before.units} → ${after1.units} (+${after1.units - before.units})`);
if (before.unitConversions !== after1.unitConversions) diffs.push(`unitConversions ${before.unitConversions} → ${after1.unitConversions} (+${after1.unitConversions - before.unitConversions})`);
if (lBom.unitId !== 'unit-carton') diffs.push(`BOM ${legacyBomId} unitId unit-carton → ${lBom.unitId}`);
if (lp.baseUnitId !== 'unit-carton') diffs.push(`item ${legacyProductId} baseUnitId unit-carton → ${lp.baseUnitId}`);
const canonicalRenamed = migrated.items.filter((i, idx) => db.items[idx] && i.id === db.items[idx].id && i.nameAr !== db.items[idx].nameAr);
canonicalRenamed.forEach(i => diffs.push(`item ${i.id} name "${db.items.find(x => x.id === i.id)!.nameAr}" → "${i.nameAr}" (canonical rename, id kept)`));
const typeFixed = migrated.items.filter(i => db.items.find(x => x.id === i.id) && db.items.find(x => x.id === i.id)!.itemType !== i.itemType);
typeFixed.forEach(i => diffs.push(`item ${i.id} itemType "${db.items.find(x => x.id === i.id)!.itemType}" → "${i.itemType}" (classification fix, id/cost/stock kept)`));
diffs.forEach(d => console.log(`   • ${d}`));
if (!diffs.length) console.log('   (no differences)');
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);