// BATCH P — READ-ONLY BOM INVENTORY.
//
// Creates nothing, deletes nothing, mutates nothing. It builds the SEEDED
// database exactly the way the browser does (createEmptyDatabase + both
// migrations) and reports:
//   1. every BOM: id, product, version, status, effective date, line count
//   2. which items are BOM-linked (the dependency Product Master trips on)
//   3. the outer-carton (kraft) definitions the brief says to preserve
//   4. which linked items the updateItem guard would actually block
//
// Usage: bun run qabominv
import { createEmptyDatabase, applyMasterDataMigration, applyUomMigration, INITIAL_PRODUCTION_BOMS } from '../src/services/db';
import type { ERPDatabaseSchema } from '../src/services/db';
import type { BomHeader } from '../src/types/erp';

const db: ERPDatabaseSchema = applyUomMigration(applyMasterDataMigration(createEmptyDatabase()));
const itemById = new Map(db.items.map(i => [i.id, i]));
const num = (id: string) => itemById.get(id);
const codeOf = (id: string) => {
  const i = itemById.get(id);
  return i ? `${i.code} (${i.nameAr})` : `${id} ***MISSING***`;
};
const KRAFT = ['item-pkg-kraft-single', 'item-pkg-kraft-duo'];
const byNumber = (a: BomHeader, z: BomHeader) => String(a.bomNumber ?? '').localeCompare(String(z.bomNumber ?? ''));
const fpId = (b: BomHeader) => b.finishedItemId || (b as unknown as { productId?: string }).productId || '';
const sorted = [...db.boms].sort(byNumber);

console.log('='.repeat(96));
console.log('BATCH P — BOM INVENTORY (read-only, seeded baseline)');
console.log('='.repeat(96));

console.log(`\nitems=${db.items.length}  boms=${db.boms.length}  bomLines=${db.bomLines.length}`);
console.log(`seededBomHeaders=${INITIAL_PRODUCTION_BOMS.boms.length}  seededBomLines=${INITIAL_PRODUCTION_BOMS.bomLines.length}`);

console.log('\n--- 1. BOM HEADERS ---');
for (const b of sorted) {
  const lines = db.bomLines.filter(l => l.bomId === b.id);
  const product = num(fpId(b));
  console.log(
    [
      b.id.padEnd(22),
      String(b.bomNumber ?? '-').padEnd(26),
      (product ? `${product.code} ${product.nameAr}` : fpId(b)).slice(0, 34).padEnd(34),
      String(b.version).padEnd(4),
      String(b.active).padEnd(8),
      (b.effectiveDate || '-').padEnd(11),
      String(b.baseQuantity).padEnd(7),
      b.unitId.padEnd(12),
      String(lines.length).padEnd(5),
    ].join('')
  );
}

console.log('\n--- 2. BOM LINES (per BOM) ---');
for (const b of sorted) {
  const lines = db.bomLines.filter(l => l.bomId === b.id);
  console.log(`\n  ${b.bomNumber ?? b.id}  [${lines.length} lines]`);
  for (const l of lines) {
    console.log(
      `    ${KRAFT.includes(l.materialItemId) ? '★KRAFT' : '      '}  ${codeOf(l.materialItemId).padEnd(46)} qty=${String(l.quantityRequired).padStart(12)} ${l.unitId}`
    );
  }
}

console.log('\n--- 3. BOM-LINKED ITEMS (the Product Master dependency) ---');
const linked = new Map<string, number>();
for (const l of db.bomLines) linked.set(l.materialItemId, (linked.get(l.materialItemId) || 0) + 1);
for (const id of [...linked.keys()].sort()) {
  const it = num(id);
  console.log(
    `  MATERIAL  ${codeOf(id).padEnd(46)} lines=${String(linked.get(id)).padStart(3)}  baseUnit=${it?.baseUnitId}  ${KRAFT.includes(id) ? '★KRAFT (preserve)' : ''}`
  );
}
for (const id of [...new Set(db.boms.map(fpId).filter(Boolean))].sort()) {
  const it = num(id);
  console.log(`  FINISHED  ${codeOf(id).padEnd(46)} finishedItemId on ${db.boms.filter(b => fpId(b) === id).length} BOM(s)  baseUnit=${it?.baseUnitId}`);
}

console.log('\n--- 4. Product Master guard: which linked items are BLOCKED from a UOM change ---');
console.log('  (guard fires only when changing baseUnitId, and only if stock/movement/BOM history exists)');
for (const id of [...linked.keys()].sort()) {
  const hasStock = db.batches.some(b => b.itemId === id && b.quantity > 0);
  const hasMov = db.inventoryTransactions.some(t => t.itemId === id);
  console.log(`  ${codeOf(id).padEnd(46)} hasStock=${String(hasStock).padEnd(5)} hasMovement=${String(hasMov).padEnd(5)} => UOM change ${hasStock || hasMov || linked.has(id) ? 'BLOCKED' : 'allowed'}`);
}

console.log('\n--- 5. OUTER CARTON (KRAFT) DEFINITIONS — the preserve-set ---');
for (const id of KRAFT) {
  const it = num(id);
  const uses = db.bomLines.filter(l => l.materialItemId === id);
  console.log(`  ${codeOf(id)}`);
  console.log(`    item exists: ${!!it}  itemType=${it?.itemType}  baseUnit=${it?.baseUnitId}`);
  console.log(`    referenced by ${uses.length} BOM line(s):`);
  for (const l of uses) {
    const b = db.boms.find(x => x.id === l.bomId);
    console.log(`      ${String(b?.bomNumber ?? l.bomId).padEnd(26)} qty=${String(l.quantityRequired).padStart(10)} ${l.unitId}  (line id ${l.id})`);
  }
}

console.log('\n--- 6. RM-FLV-* status ---');
for (const it of db.items.filter(i => i.code.startsWith('RM-FLV'))) {
  const lines = db.bomLines.filter(l => l.materialItemId === it.id);
  console.log(
    `  ${it.code.padEnd(12)} ${it.nameAr.padEnd(28)} itemType=${String(it.itemType).padEnd(16)} baseUnit=${String(it.baseUnitId).padEnd(12)} bomLines=${lines.length} => ${lines.length ? 'BOM-LINKED' : 'free'}`
  );
}

console.log('\n' + '='.repeat(96));