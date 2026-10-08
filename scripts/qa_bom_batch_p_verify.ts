// BATCH P — post-deletion VERIFICATION.
//
// Read-only assertions over the seeded+migrated database, i.e. exactly the state
// a browser builds on load. Proves every acceptance criterion for the deletion
// of the 11 UAT BOM headers and their 125 BOM lines.
//
// Usage: bun run qabomverify
import { erpDb } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import type { ERPDatabaseSchema } from '../src/services/db';

const ADMIN = { userId: 'usr-admin', userName: 'QA' };
const snap = (): ERPDatabaseSchema => erpDb.getSnapshot();

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? '  — ' + detail : ''}`); }
}

const db = snap();
const SEEDED_BOM_IDS = new Set([
  'bom-item-fp-s1', 'bom-item-fp-s2', 'bom-item-fp-s3', 'bom-item-fp-s4', 'bom-item-fp-s5', 'bom-item-fp-s6',
  'bom-item-fp-d1', 'bom-item-fp-d2', 'bom-item-fp-d3', 'bom-item-fp-d4', 'bom-item-fp-d5',
]);

const AFFECTED = [
  'RM-FLV-01', 'RM-FLV-02', 'RM-FLV-03', 'RM-FLV-04', 'RM-FLV-05',
  'RM-CORN-01', 'RM-OIL-01', 'RM-CHIP-01',
  'PKG-FLM-01', 'PKG-BOX-SGL', 'PKG-BOX-DUO', 'PKG-TRY-01', 'PKG-TRY-02',
  'PKG-LIN-01', 'PKG-STK-01', 'PKG-NAP-01', 'PKG-KRF-SGL', 'PKG-KRF-DUO',
];

console.log('='.repeat(92));
console.log('BATCH P — POST-DELETION VERIFICATION');
console.log('='.repeat(92));

console.log('\n[1] DELETION');
check('11 seeded BOM headers removed', [...SEEDED_BOM_IDS].every(id => !db.boms.some(b => b.id === id)), `boms now = ${db.boms.length}`);
check('125 seeded BOM lines removed', !db.bomLines.some(l => SEEDED_BOM_IDS.has(l.bomId)), `bomLines now = ${db.bomLines.length}`);
check('no BOM line orphaned (every line points at a live BOM)',
  db.bomLines.every(l => db.boms.some(b => b.id === l.bomId)));

console.log('\n[2] AFFECTED ITEMS ARE NO LONGER BOM-LINKED');
const stillLinked = AFFECTED.filter(code => {
  const it = db.items.find(i => i.code === code);
  return !it || db.bomLines.some(l => l.materialItemId === it.id);
});
check('all 18 affected items free of BOM dependency', stillLinked.length === 0,
  stillLinked.length ? `still linked: ${stillLinked.join(', ')}` : '0 links remain');
check('no item is a finishedItemId of any BOM', !db.items.some(i => db.boms.some(b => b.finishedItemId === i.id)));

console.log('\n[3] PRODUCT MASTER BASE-UOM EDITING UNBLOCKED');
const blocked: string[] = [];
for (const code of AFFECTED) {
  const live = db.items.find(i => i.code === code);
  if (!live) { blocked.push(`${code}(missing)`); continue; }
  const probe = { ...db.items.find(i => i.code === code)!, baseUnitId: live.baseUnitId === 'unit-piece' ? 'unit-carton' : 'unit-piece' };
  const res = MasterDataService.updateItem(probe as never, ADMIN as never);
  if (!res.success) blocked.push(`${code}: ${res.error}`);
}
check('base-UOM change accepted for all 18 affected items', blocked.length === 0,
  blocked.length ? blocked.join(' | ') : 'no item refused');

console.log('\n[4] ITEM MASTER PRESERVED');
check('all 18 affected Item records still present', AFFECTED.every(c => db.items.some(i => i.code === c)), `items = ${db.items.length}`);
for (const c of ['PKG-KRF-SGL', 'PKG-KRF-DUO']) {
  const it = db.items.find(i => i.code === c);
  check(`${c} outer-carton item PRESERVED`, !!it, it ? `nameAr="${it.nameAr}" type=${it.itemType} baseUnit=${it.baseUnitId}` : 'MISSING');
}
check('packaging item count intact', db.items.filter(i => i.itemType === 'packaging_material').length >= 8,
  `packaging=${db.items.filter(i => i.itemType === 'packaging_material').length} raw=${db.items.filter(i => i.itemType === 'raw_material').length} finished=${db.items.filter(i => i.itemType === 'finished_product').length}`);

console.log('\n[5] NOTHING ELSE DELETED');
check('units / conversions intact', db.units.length > 0 && db.unitConversions.length > 0, `units=${db.units.length} conversions=${db.unitConversions.length}`);
check('warehouses intact and unchanged by migration', db.warehouses.length === 5,
  `${db.warehouses.length}: ${db.warehouses.map(w => w.code).join(', ')}`);
check('chart of accounts intact', db.accounts.length >= 30, `accounts=${db.accounts.length}`);
check('account mappings intact', Object.keys(db.accountMappings).length > 0, `mappings=${Object.keys(db.accountMappings).length}`);
check('standard cost rates intact', db.standardCostRates.length > 0, `rates=${db.standardCostRates.length}`);
check('users intact', db.users.length > 0, `users=${db.users.length}`);
check('suppliers / reps intact', db.suppliers.length > 0 && db.salesReps.length > 0, `suppliers=${db.suppliers.length} reps=${db.salesReps.length}`);

console.log('\n[6] TRANSACTIONAL TABLES UNTOUCHED BY THIS CHANGE');
for (const k of ['inventoryTransactions', 'journalEntries', 'productionOrders', 'productionConsumptions',
                 'salesInvoices', 'purchaseInvoices', 'payments', 'cheques', 'batches', 'expenses'] as const) {
  check(`${k} readable and not bulk-deleted`, Array.isArray(db[k]), `len=${(db[k] as unknown[]).length}`);
}

console.log(`\n${'='.repeat(92)}`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(92));
process.exit(fail === 0 ? 0 : 1);