import { erpDb } from '../src/services/db';
import { installStandardBoms, STANDARD_FORMULAS } from '../src/services/standardFormulas';
const actor = { userId: 'u-admin', userName: 'admin', isTest: true };
const r = installStandardBoms(actor);
console.log(r);
const db = erpDb.getSnapshot();
let bad = 0;
for (const id of Object.keys(STANDARD_FORMULAS)) {
  const b = db.boms.filter(x => x.finishedItemId === id && x.active);
  const lines = b[0] ? db.bomLines.filter(l => l.bomId === b[0].id) : [];
  const missing = lines.filter(l => !db.items.find(i => i.id === l.materialItemId));
  if (b.length !== 1 || missing.length) { bad++; console.log('BAD', id, b.length, missing); }
}
const d1 = db.bomLines.filter(l => l.bomId === db.boms.find(b => b.finishedItemId === 'item-fp-d1' && b.active)!.id);
console.log(d1.map(l => `${l.materialItemId}=${l.quantityRequired}`).join('\n'));
console.log('second run', installStandardBoms(actor), bad === 0 && r.created === 11 ? 'PASS' : 'FAIL');
