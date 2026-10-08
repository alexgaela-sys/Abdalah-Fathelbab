// QA — PURCHASE-RETURN PRICE-VARIANCE REGRESSION (permanent).
//
// Run: `bun run qaprvariance`
//
// Defect this pins (QA P41, Batch P): `postPurchaseReturn` credits the supplier at
// the INVOICE price but relieves inventory at the goods' BOOK (FIFO) cost. When the
// two differ the old code "balanced any rounding difference" into the inventory
// credit, silently over-crediting GL 1108 by the whole difference and permanently
// desynchronising GL 1108 from the batch ledger (qa2 Scenario L left a +1,000 EGP
// residual). The difference is a material price variance and belongs in 5103.
//
// This is a deliberately minimal, deterministic reproduction:
//   - two receipts of the SAME item into the same warehouse at DIFFERENT prices,
//   - the CHEAPER batch is the OLDER one, so FIFO relieves it,
//   - the return is raised against the EXPENSIVE invoice and names NO batch,
//   => invoice price 20/unit but book cost 10/unit => a 1,000 EGP price variance
//      for 100 units.
//
// It is self-cleaning: TEST-QA-prefixed records only, no reset, no reseed.
import { erpDb } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { InventoryEngine } from '../src/services/inventory';
import { WorkflowService } from '../src/services/workflows';
import { AccountingEngine } from '../src/services/accounting';

const TODAY = new Date().toISOString().split('T')[0];
const RID = `PRV-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const ADMIN = { userId: 'usr-admin', userName: 'QA' };
const snap = () => erpDb.getSnapshot();
const acc = (code: string) => snap().accounts.find(a => a.code === code)?.currentBalance || 0;
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol;

let pass = 0, fail = 0;
const defects: string[] = [];
function check(label: string, safe: boolean, detail = '') {
  if (safe) { pass++; console.log(`  ✅ ${label}${detail ? ` :: ${detail}` : ''}`); }
  else { fail++; defects.push(`${label} :: ${detail}`); console.log(`  ❌ ${label} :: ${detail}`); }
}
const section = (t: string) => console.log(`\n=== ${t} ===`);

const INVENTORY_ACCOUNTS = ['1108', '1109', '1110', '1111', '1112'];
const glInv = () => INVENTORY_ACCOUNTS.reduce((s, c) => s + acc(c), 0);
const batchVal = (wh: string) => snap().batches
  .filter(b => b.warehouseId === wh)
  .reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);

const BASE = {
  journalEntries: snap().journalEntries.length,
  inventoryTransactions: snap().inventoryTransactions.length,
  accounts: snap().accounts.map(a => ({ id: a.id, b: a.currentBalance })),
  suppliers: snap().suppliers.map(s => ({ id: s.id, b: s.currentBalance })),
  purchaseInvoices: snap().purchaseInvoices.length,
  batches: snap().batches.map(b => b.id),
  items: snap().items.length,
};

console.log('================================================================');
console.log(`🎯 PURCHASE-RETURN PRICE-VARIANCE REGRESSION — ${RID}`);
console.log('================================================================');

const WH = 'wh-raw';
const QTY = 100;
const CHEAP = 10, PRICEY = 20;

let itemId = ''; let supId = ''; let priceyInvoiceId = '';
const batches = new Set<string>();

section('FIXTURE — same item, two prices, cheaper batch is OLDER so FIFO takes it');
{
  const sup = MasterDataService.createSupplier({
    code: `${PFX}-SUP`, name: `مورد ${PFX}`, currency: 'EGP', isTest: true, ...ADMIN,
  });
  if (!sup.supplier) throw new Error(`supplier: ${sup.error}`);
  supId = sup.supplier.id;

  const item = MasterDataService.createItem({
    code: `${PFX}-IT`, nameAr: `${PFX} صنف`, nameEn: PFX, itemType: 'raw_material',
    baseUnitId: 'unit-kg', purchaseUnitId: 'unit-kg', standardCost: 0, actualCost: 0,
    sellingPriceRetail: 0, sellingPriceWholesale: 0, sellingPriceExportUSD: 0,
    vatRate: 0.14, vatCategory: 'standard', trackBatch: true, trackExpiry: false,
    minStockLevel: 0, active: true, isTest: true,
  } as never);
  if (!item.item) throw new Error(`item: ${item.error}`);
  itemId = item.item.id;

  // Old batch @ 10, new batch @ 20. FIFO (productionDate ascending) takes the 10 first.
  const old = '2020-01-01';
  const cheap = WorkflowService.createPurchaseInvoice({
    supplierId: supId, warehouseId: WH, paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `${PFX}-CHEAP`, date: TODAY,
    lines: [{ itemId, quantity: QTY, unitId: 'unit-kg', unitPrice: CHEAP, batchNumber: `${PFX}-CHEAP`,
      productionDate: old, expiryDate: '2030-01-01', vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (!cheap.success) throw new Error(`cheap invoice: ${cheap.error}`);
  batches.add(`${PFX}-CHEAP`);

  const pricey = WorkflowService.createPurchaseInvoice({
    supplierId: supId, warehouseId: WH, paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `${PFX}-PRICEY`, date: TODAY,
    lines: [{ itemId, quantity: QTY, unitId: 'unit-kg', unitPrice: PRICEY, batchNumber: `${PFX}-PRICEY`,
      productionDate: '2024-01-01', expiryDate: '2030-01-01', vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (!pricey.success) throw new Error(`pricey invoice: ${pricey.error}`);
  batches.add(`${PFX}-PRICEY`);
  priceyInvoiceId = pricey.invoice!.id;

  check('fixture stocked 2×100 units at 10 and 20',
    near(batchVal(WH), QTY * CHEAP + QTY * PRICEY, 0.02) && near(InventoryEngine.getItemBalance(itemId, WH), QTY * 2, 0.001),
    `batches=${batchVal(WH).toFixed(2)} qty=${InventoryEngine.getItemBalance(itemId, WH)}`);
}

section('PROBE — return 100 units against the PRICEY invoice (no batch named)');
let probePassed = false;
{
  const gl0 = glInv(), b0 = batchVal(WH), ap0 = snap().suppliers.find(s => s.id === supId)!.currentBalance;
  const ppa0 = acc('5103');

  const ret = WorkflowService.postPurchaseReturn({
    supplierId: supId, purchaseInvoiceId: priceyInvoiceId, warehouseId: WH, date: TODAY,
    reason: `${PFX} اختبار فروق الأسعار`, lines: [{ itemId, quantity: QTY }],
    isTest: true, ...ADMIN,
  } as never);
  check('purchase return posted', ret.success, ret.error || '');

  const dGl = glInv() - gl0;
  const dBatch = batchVal(WH) - b0;
  const ap = snap().suppliers.find(s => s.id === supId)!.currentBalance;
  const dPpa = acc('5103') - ppa0;

  console.log(`     ΔGL inventory ${dGl.toFixed(2)} | Δbatch ledger ${dBatch.toFixed(2)} | ΔAP ${(ap - ap0).toFixed(2)} | Δ5103 ${dPpa.toFixed(2)}`);

  check('P41 GL inventory Δ == batch ledger Δ (the identity this defect broke)',
    near(dGl, dBatch, 0.02), `ΔGL ${dGl.toFixed(2)} vs Δbatch ${dBatch.toFixed(2)} → residual ${(dGl - dBatch).toFixed(2)}`);

  check('inventory relieved at the FIFO BOOK cost of the goods actually returned',
    near(dBatch, -(QTY * CHEAP), 0.02), `Δbatch ${dBatch.toFixed(2)}, expected -${(QTY * CHEAP)} (100 × ${CHEAP})`);

  check('supplier credited at the INVOICE price (the supplier gets what the invoice charged)',
    near(ap0 - ap, QTY * PRICEY, 0.02), `ΔAP ${(ap0 - ap).toFixed(2)}, expected ${QTY * PRICEY}`);

  check('the 1,000 EGP gap lands in 5103 Material Price Variance (NOT in inventory)',
    near(dPpa, -QTY * (PRICEY - CHEAP), 0.02),
    `Δ5103 ${dPpa.toFixed(2)}, expected ${-QTY * (PRICEY - CHEAP)} (a CREDIT to the variance account: 5103 balances debit-positive like the other COGS accounts)`);

  const jv = snap().journalEntries.find(j => j.id === ret.purchaseReturn?.journalEntryId);
  check('the return journal is internally balanced',
    !!jv && near(jv!.totalDebit, jv!.totalCredit, 0.01),
    jv ? `Dr ${jv.totalDebit.toFixed(2)} Cr ${jv.totalCredit.toFixed(2)}` : 'no journal');

  probePassed = near(dGl, dBatch, 0.02);
}

section('CLEANUP — remove ONLY what this run appended');
{
  erpDb.mutate(draft => {
    draft.items = draft.items.filter(i => i.id !== itemId);
    draft.suppliers = draft.suppliers.filter(s => s.id !== supId);
    draft.purchaseInvoices = draft.purchaseInvoices.slice(0, BASE.purchaseInvoices);
    draft.purchaseInvoiceLines = draft.purchaseInvoiceLines.filter(l => !draft.purchaseInvoices.some(p => p.id === l.purchaseInvoiceId));
    draft.journalEntries = draft.journalEntries.slice(0, BASE.journalEntries);
    draft.inventoryTransactions = draft.inventoryTransactions.slice(0, BASE.inventoryTransactions);
    draft.batches = draft.batches.filter(b => !batches.has(b.batchNumber));
    BASE.accounts.forEach(b => { const a = draft.accounts.find(x => x.id === b.id); if (a) a.currentBalance = b.b; });
    BASE.suppliers.forEach(b => { const s = draft.suppliers.find(x => x.id === b.id); if (s) s.currentBalance = b.b; });
  });

  const after = snap();
  check('cleanup restored every pre-existing account balance',
    BASE.accounts.every(b => near(after.accounts.find(a => a.id === b.id)?.currentBalance || 0, b.b, 0.02)));
  check('cleanup restored pre-existing document counts',
    after.journalEntries.length === BASE.journalEntries && after.items.length === BASE.items &&
    after.purchaseInvoices.length === BASE.purchaseInvoices && after.batches.length === BASE.batches.length);
}

console.log('\n==============================');
console.log(`PURCHASE-RETURN VARIANCE (${RID}) — PROBES: ${pass + fail} | SAFE: ${pass} | DEFECTS: ${fail}`);
if (defects.length) { console.log('DEFECTS FOUND:'); defects.forEach(d => console.log('  - ' + d)); }
console.log(`DEFECT PINNED: ${probePassed ? 'the residual no longer reproduces (fixed)' : 'STILL REPRODUCES'}`);
console.log('==============================');
if (fail > 0) process.exit(1);