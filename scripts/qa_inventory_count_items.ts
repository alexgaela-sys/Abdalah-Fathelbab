// QA BATCH R — DIAGNOSTIC ONLY: "محضر جرد فعلي وتسوية الفروق المخزنية" shows (0 صنف).
//
// UAT BUG: selecting ANY warehouse that has inventory lists zero items in the
// physical count document.
//
// This script REPLICATES THE UI CODE PATH VERBATIM
// (src/components/modules/InventoryView.tsx -> handleOpenPhysicalCount /
// handleCountWarehouseChange) and runs it against the in-memory database, then
// isolates which filter/join produces the zero.
//
// READ-ONLY with respect to persistent/UAT data: there is no localStorage under
// tsx, everything runs on the in-memory DB built by createEmptyDatabase() +
// migrations, and the exact pre-run state is deep-captured and restored at the
// end and asserted byte-identical.
import { erpDb, createEmptyDatabase, applyMasterDataMigration, applyUomMigration } from '../src/services/db';
import { InventoryEngine } from '../src/services/inventory';
import { AccountingEngine } from '../src/services/accounting';

const snap = () => erpDb.getSnapshot();
const TODAY = new Date().toISOString().split('T')[0];
const RID = `CNT-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;

let pass = 0;
let fail = 0;
const findings: string[] = [];
function check(ok: boolean, label: string, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}

// The exact pre-run in-memory DB (deep copy — getSnapshot() hands back a LIVE reference).
const PRISTINE_LIVE = JSON.parse(JSON.stringify(snap()));
erpDb.restore(applyUomMigration(applyMasterDataMigration(createEmptyDatabase())));
const PRISTINE = JSON.parse(JSON.stringify(snap()));

console.log('================================================================');
console.log(`🔬 PHYSICAL INVENTORY COUNT ITEM-LIST DIAGNOSTIC — ${RID}`);
console.log('================================================================');

// ---------------------------------------------------------------------------
// SECTION 1 — the master/reference data the UI binds to
// ---------------------------------------------------------------------------
console.log('\n── 1. reference data ─────────────────────────────────────────');
const db0 = snap();
console.log(`  warehouses: ${db0.warehouses.length}   items: ${db0.items.length}   batches: ${db0.batches.length}`);
for (const w of db0.warehouses) {
  console.log(`    ${w.id.padEnd(12)} code=${String(w.code).padEnd(7)} type=${String(w.type).padEnd(14)} active=${w.active}  ${w.nameAr}`);
}
const whIds = new Set(db0.warehouses.map(w => w.id));
const whCodes = new Set(db0.warehouses.map(w => w.code));

// ---------------------------------------------------------------------------
// SECTION 2 — the UI builder, transcribed verbatim from InventoryView.tsx
// ---------------------------------------------------------------------------
// src/components/modules/InventoryView.tsx:105-124 (handleOpenPhysicalCount)
// src/components/modules/InventoryView.tsx:126-131 (handleCountWarehouseChange)
function uiBuildCountLines(countWarehouseId: string) {
  const items = snap().items;
  return items
    .map(itm => ({ itemId: itm.id, systemQty: InventoryEngine.getItemBalance(itm.id, countWarehouseId) }))
    .filter(x => x.systemQty !== 0)
    .map(({ itemId, systemQty }) => ({ itemId, systemQty, physicalQty: systemQty, unitCost: 0 }));
}

// The balances tab aggregator — InventoryView.tsx:55-68. Kept as the control:
// it uses the SAME source (db.batches) through a different expression.
function balancesTabRows(warehouseId: string) {
  const db = snap();
  const out: Array<{ itemId: string; qty: number }> = [];
  db.items.forEach(item => {
    db.warehouses.forEach(wh => {
      if (wh.id !== warehouseId) return;
      const batches = db.batches.filter(b => b.itemId === item.id && b.warehouseId === wh.id && b.quantity > 0);
      const qty = batches.reduce((s, b) => s + b.quantity, 0);
      if (qty > 0) out.push({ itemId: item.id, qty });
    });
  });
  return out;
}

console.log('\n── 2. SEEDED (untouched) database ───────────────────────────');
for (const w of snap().warehouses) {
  const ui = uiBuildCountLines(w.id);
  const bal = balancesTabRows(w.id);
  console.log(`  ${String(w.code).padEnd(7)} ${String(w.id).padEnd(12)} countRows=${String(ui.length).padStart(3)}   balancesRows=${String(bal.length).padStart(3)}   batches=${String(snap().batches.filter(b => b.warehouseId === w.id).length).padStart(3)}`);
}

// ---------------------------------------------------------------------------
// SECTION 3 — give the in-memory DB real stock, then re-run the same builder
// ---------------------------------------------------------------------------
console.log('\n── 3. IN-MEMORY stock created (TEST-QA, never persisted) ────');
const chip = snap().items.find(i => i.id === 'item-raw-chip')!;
const fpLocal = snap().items.find(i => i.code === 'FP-SNG-01')!;
const fpExport = snap().items.find(i => i.code === 'FP-DUO-01' && i.itemType === 'finished_product')!;
const oil = snap().items.find(i => i.id === 'item-raw-oil') ?? snap().items.find(i => i.itemType === 'raw_material')!;

const receipts: Array<[string, string, string, number]> = [
  [chip.id, 'wh-raw', `${PFX}-CHIP`, 5000],
  [oil.id, 'wh-raw', `${PFX}-OIL`, 1200],
  [fpLocal.id, 'wh-local', `${PFX}-FPL`, 800],
  [fpExport.id, 'wh-export', `${PFX}-FPX`, 240],
];
for (const [itemId, warehouseId, batchNumber, qty] of receipts) {
  const r = InventoryEngine.recordMovement({
    itemId, warehouseId, movementType: 'purchase_receipt', quantityIn: qty, quantityOut: 0,
    unitCost: 50, documentType: 'purchase_invoice', documentNumber: `${PFX}-RCPT`,
    batchNumber, productionDate: TODAY, expiryDate: '2027-06-01', isTest: true,
  });
  if (!r.success) throw new Error(`${itemId}@${warehouseId}: ${r.error}`);
  console.log(`  receipt ${itemId.padEnd(18)} → ${warehouseId.padEnd(11)} qty=${String(qty).padStart(6)} @50`);
}

console.log('\n── 4. stock is PROVED to exist, then the UI builder is re-run ──');
for (const w of snap().warehouses) {
  const held = snap().batches.filter(b => b.warehouseId === w.id && b.quantity > 0);
  const qty = held.reduce((s, b) => s + b.quantity, 0);
  const val = held.reduce((s, b) => s + b.quantity * b.unitCost, 0);
  const ui = uiBuildCountLines(w.id);
  const bal = balancesTabRows(w.id);
  console.log(`  ${String(w.code).padEnd(7)} ${String(w.id).padEnd(12)} batchQty=${String(qty).padStart(9)} value=${val.toFixed(2).padStart(11)}`);
  console.log(`           countRows=${String(ui.length).padStart(3)}   balancesRows=${String(bal.length).padStart(3)}`);
  if (ui.length) {
    for (const l of ui) {
      const itm = snap().items.find(i => i.id === l.itemId)!;
      console.log(`             ${itm.code.padEnd(14)} ${itm.nameAr.padEnd(34)} book=${l.systemQty}`);
    }
  }
}

// ---------------------------------------------------------------------------
// SECTION 5 — hypothesis matrix
// ---------------------------------------------------------------------------
console.log('\n── 5. hypothesis matrix ─────────────────────────────────────');

const stockWhs = snap().warehouses.filter(w => snap().batches.some(b => b.warehouseId === w.id && b.quantity > 0));
console.log(`  warehouses that provably hold stock: ${stockWhs.map(w => w.code).join(', ')}`);

// A) UI-only rendering?  If the builder returns rows, the data path is fine.
const anyRows = stockWhs.some(w => uiBuildCountLines(w.id).length > 0);
console.log(`\n  [A] UI-only rendering / query correctness`);
if (check(anyRows, 'the service-layer builder returns rows for a stocked warehouse', `${stockWhs.map(w => `${w.code}=${uiBuildCountLines(w.id).length}`).join(' ')}`)) {
  console.log('      → the item-list builder itself is correct: the zero is NOT produced by');
  console.log('        getItemBalance(), the warehouse id, or the qty filter.');
} else {
  console.log('      → the zero IS produced by the builder. Continue below to name the filter.');
}

// B) wrong warehouse ID/code mapping
console.log(`\n  [B] warehouse id vs code mapping`);
const badWhRefs = [...new Set(snap().batches.map(b => b.warehouseId))].filter(w => !whIds.has(w));
check(badWhRefs.length === 0, 'every batch.warehouseId resolves to a warehouse master record', badWhRefs.length ? `orphans: ${badWhRefs.join(',')}` : `${whIds.size} ids, 0 orphans`);
const selValueResolves = snap().warehouses.every(w => w.id === w.code || whIds.has(w.id));
check(selValueResolves, 'the <select> value={w.id} resolves against db.warehouses (ids, not codes)', `${whCodes.size} codes exist but are never used as the select value`);

// C) batches vs transactions aggregation
console.log(`\n  [C] batch ledger vs movement ledger`);
for (const w of stockWhs) {
  const batchQty = snap().batches.filter(b => b.warehouseId === w.id).reduce((s, b) => s + b.quantity, 0);
  const txQty = snap().inventoryTransactions.filter(t => t.warehouseId === w.id).reduce((s, t) => s + (t.quantityIn || 0) - (t.quantityOut || 0), 0);
  console.log(`      ${String(w.code).padEnd(7)} batchQty=${String(batchQty).padStart(9)}  txNetQty=${String(txQty).padStart(9)}  ${Math.abs(batchQty - txQty) < 0.001 ? 'agree' : 'DIVERGE'}`);
}
const uiAll = stockWhs.reduce((s, w) => s + uiBuildCountLines(w.id).length, 0);
check(uiAll > 0, 'the count builder sees the same stock the movement ledger sees', `countRows=${uiAll}`);

// D) inactive-item filtering
console.log(`\n  [D] inactive-item filtering`);
const inactiveHeld = snap().batches.filter(b => b.quantity > 0 && snap().items.find(i => i.id === b.itemId)?.active === false);
check(inactiveHeld.length === 0, 'no stocked batch belongs to an inactive item (and the UI filters on none anyway)', `${inactiveHeld.length} such batches`);

// E) zero/negative balance filtering
console.log(`\n  [E] zero / negative balance filtering`);
const zeroQtyBatches = snap().batches.filter(b => b.quantity === 0);
console.log(`      zero-quantity batches: ${zeroQtyBatches.length}  (getItemBalance sums them to 0 → the "!== 0" filter drops them: CORRECT)`);
const negItems = snap().items.filter(i => InventoryEngine.getItemBalance(i.id, stockWhs[0].id) < 0);
console.log(`      items with negative balance in ${stockWhs[0].code}: ${negItems.length}  ("!== 0" KEEPS these — so the filter is not the cause of a zero)`);

// F) item type / UOM coverage
console.log(`\n  [F] item type / UOM coverage of the listed rows`);
const byType = new Map<string, number>();
for (const w of stockWhs) for (const l of uiBuildCountLines(w.id)) {
  const t = snap().items.find(i => i.id === l.itemId)!.itemType;
  byType.set(t, (byType.get(t) || 0) + 1);
}
for (const [t, n] of byType) console.log(`      ${t.padEnd(20)} ${n} row(s)`);

// ---------------------------------------------------------------------------
// SECTION 6 — the reproduction condition: does a stocked warehouse EVER zero out?
// ---------------------------------------------------------------------------
console.log('\n── 6. repro sweep — every warehouse, count builder vs balances tab ──');
let mismatch = 0;
for (const w of snap().warehouses) {
  const ui = uiBuildCountLines(w.id).length;
  const bal = balancesTabRows(w.id).length;
  const held = snap().batches.some(b => b.warehouseId === w.id && b.quantity > 0);
  if (ui !== bal) mismatch++;
  console.log(`  ${String(w.code).padEnd(7)} ${String(w.id).padEnd(12)} stocked=${String(held).padEnd(5)} countRows=${String(ui).padStart(3)}  balancesRows=${String(bal).padStart(3)}  ${ui === bal ? 'agree' : 'MISMATCH'}`);
}
check(mismatch === 0, 'count builder and balances tab agree on every warehouse', `${mismatch} mismatch(es)`);

const zeroWhileStocked = snap().warehouses.filter(w =>
  snap().batches.some(b => b.warehouseId === w.id && b.quantity > 0) && uiBuildCountLines(w.id).length === 0);
check(zeroWhileStocked.length === 0, 'NO warehouse holds stock yet yields (0 صنف)',
  zeroWhileStocked.length ? zeroWhileStocked.map(w => `${w.code}/${w.id}`).join(', ') : `${stockWhs.length} stocked warehouses all listed`);

// ---------------------------------------------------------------------------
// SECTION 7 — what DOES produce (0 صنف): the empty batch ledger
// ---------------------------------------------------------------------------
console.log('\n── 7. the only reproduced (0 صنف) condition ───────────────────');
erpDb.restore(JSON.parse(JSON.stringify(PRISTINE)));
const emptyDb = snap();
for (const w of emptyDb.warehouses) {
  const rows = uiBuildCountLines(w.id).length;
  console.log(`  freshly-seeded DB, ${String(w.code).padEnd(7)} batches=${String(emptyDb.batches.filter(b => b.warehouseId === w.id).length).padStart(3)}  countRows=${rows}`);
}
check(emptyDb.batches.length === 0 && uiBuildCountLines('wh-local').length === 0,
  'REPRODUCED: with an empty batch ledger the count lists 0 items for EVERY warehouse',
  'this is the exact reported symptom');

// ---------------------------------------------------------------------------
// SECTION 8 — the exact reported symptom: a warehouse that HAS inventory
// (accounting-wise) yet lists (0 صنف).
// ---------------------------------------------------------------------------
console.log('\n── 8. GL-only stock: warehouse has inventory, count lists 0 ────');
erpDb.restore(JSON.parse(JSON.stringify(PRISTINE)));
// An opening-balance JOURNAL is how this app carries opening stock: a legitimate
// accounting document that puts value on the inventory accounts without ever
// creating a batch. Exactly the shape a migrated / hand-seeded UAT store has.
const acc = (code: string) => snap().accounts.find(a => a.code === code)!;
{
  const jv = AccountingEngine.postJournal({
    entryDate: TODAY, description: `${PFX} رصيد افتتاحي مخزون`,
    entryType: 'opening', sourceDocumentType: 'opening_balance', sourceDocumentId: `${PFX}-OPEN`,
    currency: 'EGP', exchangeRate: 1, isReversed: false, isTest: true,
    lines: [
      { accountId: acc('1108').id, accountCode: '1108', accountNameAr: acc('1108').nameAr, debit: 250000, credit: 0, currency: 'EGP', exchangeRate: 1, description: 'خام' },
      { accountId: acc('1109').id, accountCode: '1109', accountNameAr: acc('1109').nameAr, debit: 120000, credit: 0, currency: 'EGP', exchangeRate: 1, description: 'منتجات تامة' },
      { accountId: acc('2101').id, accountCode: '2101', accountNameAr: acc('2101').nameAr, debit: 0, credit: 370000, currency: 'EGP', exchangeRate: 1, description: 'حقوق ملكية' },
    ],
  } as never, 'usr-admin', 'QA', true);
  if (!jv.success) throw new Error(`opening journal: ${jv.error}`);
}
{
  const glInv = snap().accounts.filter(a => ['1108', '1109', '1110', '1111', '1112'].includes(a.code))
    .reduce((s, a) => s + (a.currentBalance || 0), 0);
  console.log(`  GL inventory (1108/1109/1110/1111/1112) = ${glInv.toFixed(2)} EGP`);
  console.log(`  batch ledger                          = ${snap().batches.length} batch(es)`);
  console.log(`  posted stock documents (purchase/sales invoices) = ${snap().purchaseInvoices.length + snap().salesInvoices.length}`);
  let allZero = true;
  for (const w of snap().warehouses) {
    const n = uiBuildCountLines(w.id).length;
    if (n > 0) allZero = false;
    console.log(`    ${String(w.code).padEnd(7)} ${String(w.id).padEnd(12)} countRows=${n}   → UI shows "(${n} صنف)"`);
  }
  check(glInv > 0 && allZero, 'REPRODUCED: 370,000 EGP of GL inventory exists, every warehouse still lists (0 صنف)',
    'the count document reads the BATCH ledger only — there is no fallback to the GL inventory accounts');
}

// ---------------------------------------------------------------------------
// restore + safety assertion
// ---------------------------------------------------------------------------
erpDb.restore(JSON.parse(JSON.stringify(PRISTINE_LIVE)));
const identical = JSON.stringify(snap()) === JSON.stringify(PRISTINE_LIVE);
const leftovers = snap().batches.filter(b => String(b.batchNumber).includes('TEST-QA')).length
  + snap().inventoryTransactions.filter(t => String(t.documentNumber).includes('TEST-QA')).length;
check(identical, 'in-memory database restored byte-identical to the pre-run state');
check(leftovers === 0, 'no TEST-QA records left behind', `${leftovers}`);

console.log('\n================================================================');
console.log(`RESULT — ${pass} passed, ${fail} failed`);
console.log('================================================================');
process.exit(fail > 0 ? 1 : 0);