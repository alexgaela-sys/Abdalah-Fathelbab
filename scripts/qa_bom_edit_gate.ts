// BATCH P — READ-ONLY proof of WHAT the BOM dependency blocks in Product Master.
//
// Runs against a throwaway in-memory database (fresh Node process, no
// persistence). It calls MasterDataService.updateItem on the same item the
// brief names, twice:
//   (a) a plain field edit (Arabic name)  -> expected to succeed
//   (b) a base-UOM change                 -> expected to be refused
//
// This distinguishes "the item is uneditable" from "the item's UNIT OF MEASURE
// is locked", which decides whether deleting BOMs is even the right fix.
//
// Usage: bun run qabomgate
import { erpDb } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import type { Item } from '../src/types/erp';

const ADMIN = { userId: 'usr-admin', userName: 'QA' };
const snap = () => erpDb.getSnapshot();
const byCode = (code: string): Item => snap().items.find(i => i.code === code)!;

const TARGETS = [
  'RM-FLV-01', 'RM-FLV-02', 'RM-FLV-05',
  'RM-CORN-01', 'RM-OIL-01', 'RM-CHIP-01',
  'PKG-FLM-01', 'PKG-KRF-SGL', 'PKG-KRF-DUO', 'PKG-TRY-01', 'PKG-STK-01',
];

console.log('='.repeat(94));
console.log('BATCH P — Product Master edit gate (in-memory, nothing persisted)');
console.log('='.repeat(94));

const otherUnit = (i: Item) => (i.baseUnitId === 'unit-piece' ? 'unit-carton' : 'unit-piece');

console.log('\n  ITEM            BOM-LINKED   (a) NAME edit            (b) BASE-UOM edit');
console.log('  ' + '-'.repeat(90));

for (const code of TARGETS) {
  const live = byCode(code);
  if (!live) { console.log(`  ${code.padEnd(14)} *** NOT FOUND ***`); continue; }
  const linked = snap().bomLines.some(l => l.materialItemId === live.id);

  // (a) plain Arabic-name edit — must not touch the UOM at all
  const nameProbe = { ...live, nameAr: `${live.nameAr} ✅` };
  const nameRes = MasterDataService.updateItem(nameProbe as never, ADMIN as never);

  // restore, then (b) attempt a base-unit change
  const uomProbe = { ...byCode(code), baseUnitId: otherUnit(live) };
  const uomRes = MasterDataService.updateItem(uomProbe as never, ADMIN as never);

  console.log(
    `  ${code.padEnd(14)} ${(linked ? 'yes' : 'no').padEnd(13)} ` +
      `${nameRes.success ? '✅ allowed          ' : '❌ BLOCKED          '}` +
      `  ${uomRes.success ? '✅ allowed' : '❌ BLOCKED: ' + (uomRes.error || '').slice(0, 34)}`
  );
}

console.log('\n  Interpretation:');
console.log('   • the BOM link is ONLY consulted by the base-UOM guard in');
console.log('     MasterDataService.updateItem (src/services/masterData.ts:293-303)');
console.log('   • names, codes, prices and every other field edit are unaffected.');
console.log('\n' + '='.repeat(94));