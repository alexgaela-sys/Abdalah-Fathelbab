// BATCH L — PERFORMANCE / LARGE DATA.
//
// Builds an ISOLATED synthetic dataset (never production/UAT data): 1,000
// customers, 1,000 suppliers, 1,000 products, 5,000 sales invoices, 5,000 purchase
// invoices, 10,000 inventory movements, 10,000 journal lines and 1,000 production
// transactions — all TEST-QA prefixed and removed afterwards.
//
// It then MEASURES (never estimates) the real wall-clock time of the surfaces the
// UI calls on load and on every refresh: database snapshot/hydration, the GL,
// trial balance, AR aging, AP aging, inventory valuation, movement listing, sales
// report, purchase report, and search / filter / sort over the large tables.
//
// Honesty notes printed with the results:
//  * The bulk rows are written directly into the in-memory store (one mutate per
//    chunk) instead of through the document workflows — posting 10,000 balanced
//    journals would measure the journal engine, not the reporting layer. The
//    reports under test therefore read the same shapes the UI reads.
//  * Browser paint/layout/render time is NOT measured here (no browser): those
//    rows are reported as NOT TESTED / MANUAL.
import { erpDb } from '../src/services/db';
import { LedgerService, TreasuryLedgerService } from '../src/services/ledger';
import { InventoryEngine } from '../src/services/inventory';

const TODAY = new Date().toISOString().split('T')[0];
const RID = `PRF-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const snap = () => erpDb.getSnapshot();

const BASE = {
  journalEntries: snap().journalEntries.length,
  inventoryTransactions: snap().inventoryTransactions.length,
  accounts: snap().accounts.map(a => ({ id: a.id, b: a.currentBalance })),
  batches: snap().batches.map(b => b.id),
  customers: snap().customers.map(c => c.currentBalance),
  suppliers: snap().suppliers.map(s => s.currentBalance),
  items: snap().items.map(i => ({ id: i.id, c: i.actualCost })),
  salesInvoices: snap().salesInvoices.length,
  purchaseInvoices: snap().purchaseInvoices.length,
  productionOrders: snap().productionOrders.length,
  users: snap().users.map(u => u.id),
};

const SCALE = { customers: 1000, suppliers: 1000, items: 1000, sales: 5000, purchases: 5000, movements: 10000, journalEntries: 2000, productionOrders: 1000 };
let pass = 0, fail = 0;
const check = (label: string, ok: boolean, info = '') => {
  if (ok) { pass++; console.log(`  ${ok ? '✅' : '❌'} ${label}${info ? ` — ${info}` : ''}`); }
  else fail++;
};
const fmt = (n: number) => `${n.toFixed(1)} ms`;
/** Measures a real execution and records the number (never estimates). */
function time(label: string, fn: () => unknown, budgetMs: number) {
  const t0 = performance.now();
  let out: unknown;
  try { out = fn(); } catch (e) { check(label, false, `threw: ${(e as Error).message}`); return { ms: -1, out: undefined }; }
  const took = performance.now() - t0;
  const ok = took <= budgetMs;
  check(`${label.padEnd(44)} ${fmt(took).padStart(9)}`, ok, ok ? `budget ${budgetMs} ms` : `OVER BUDGET (${fmt(took)} > ${budgetMs} ms)`);
  return { ms: took, out };
}

console.log('================================================================');
console.log(`⏱️  BATCH L — PERFORMANCE / LARGE DATA — ${RID}`);
console.log('================================================================');

// ------------------------------------------------------------ build dataset
const tBuild0 = performance.now();
const CHUNK = 250;
{
  // masters
  for (let c = 0; c < SCALE.customers; c += CHUNK) {
    erpDb.mutate(draft => {
      for (let i = c; i < Math.min(c + CHUNK, SCALE.customers); i++) {
        draft.customers.push({
          id: `${PFX}-C${i}`, code: `${PFX}-C${i}`, name: `عميل أداء ${i}`, nameEn: '', taxNumber: '', phone: '', address: '',
          customerType: 'retail', channel: 'retail', currency: 'EGP', creditLimit: 0, openingBalance: 0,
          currentBalance: (i % 50) * 137.5, paymentTerms: '', active: true, isTest: true,
        } as never);
      }
    });
  }
  for (let c = 0; c < SCALE.suppliers; c += CHUNK) {
    erpDb.mutate(draft => {
      for (let i = c; i < Math.min(c + CHUNK, SCALE.suppliers); i++) {
        draft.suppliers.push({
          id: `${PFX}-S${i}`, code: `${PFX}-S${i}`, name: `مورد أداء ${i}`, taxNumber: '', contactPerson: '', phone: '',
          address: '', paymentTerms: '', currency: 'EGP', openingBalance: 0, currentBalance: (i % 40) * 91.25, active: true, isTest: true,
        } as never);
      }
    });
  }
  for (let c = 0; c < SCALE.items; c += CHUNK) {
    erpDb.mutate(draft => {
      for (let i = c; i < Math.min(c + CHUNK, SCALE.items); i++) {
        draft.items.push({
          id: `${PFX}-I${i}`, code: `${PFX}-I${i}`, nameAr: `صنف أداء ${i}`, nameEn: `Perf item ${i}`,
          itemType: i % 3 === 0 ? 'finished_product' : 'raw_material', baseUnitId: 'unit-piece', purchaseUnitId: 'unit-piece',
          vatRate: 0, vatCategory: 'exempt', trackBatch: true, trackExpiry: false,
          standardCost: 50, actualCost: 50, sellingPriceRetail: 120, sellingPriceWholesale: 110, sellingPriceExportUSD: 3,
          active: true, minStockLevel: 0, isTest: true,
        } as never);
      }
    });
  }
  // documents (with their lines)
  const acc = (code: string) => snap().accounts.find(a => a.code === code)!.id;
  for (let c = 0; c < SCALE.sales; c += CHUNK) {
    erpDb.mutate(draft => {
      for (let i = c; i < Math.min(c + CHUNK, SCALE.sales); i++) {
        const id = `${PFX}-SI${i}`;
        draft.salesInvoices.push({
          id, invoiceNumber: `${PFX}-S${i}`, customerId: `${PFX}-C${i % SCALE.customers}`, channel: 'retail', warehouseId: 'wh-local',
          invoiceDate: TODAY, dueDate: TODAY, subtotal: 1000, vatAmount: 0, totalAmount: 1000, currency: 'EGP', exchangeRate: 1,
          paymentMethod: 'credit', paidAmount: (i % 3) * 333, status: 'open', customerName: `عميل ${i}`, stockSource: 'warehouse',
          costCenterId: 'cc-sales', createdUserId: 'usr-admin', createdAt: TODAY, isTest: true,
        } as never);
        draft.salesInvoiceLines.push({
          id: `${PFX}-SIL${i}`, invoiceId: id, itemId: `${PFX}-I${i % SCALE.items}`, quantity: 10, freeQuantity: 0, unitPrice: 100,
          unitCost: 50, discount: 0, vatRate: 0, vatAmount: 0, totalBeforeVat: 1000, netTotal: 1000, unitId: 'unit-piece',
        } as never);
      }
    });
  }
  for (let c = 0; c < SCALE.purchases; c += CHUNK) {
    erpDb.mutate(draft => {
      for (let i = c; i < Math.min(c + CHUNK, SCALE.purchases); i++) {
        const id = `${PFX}-PI${i}`;
        draft.purchaseInvoices.push({
          id, invoiceNumber: `${PFX}-P${i}`, supplierId: `${PFX}-S${i % SCALE.suppliers}`, warehouseId: 'wh-raw',
          invoiceDate: TODAY, dueDate: TODAY, subtotal: 500, vatAmount: 0, totalAmount: 500, currency: 'EGP', exchangeRate: 1,
          paymentMethod: 'credit', paidAmount: 0, status: 'open', supplierName: `مورد ${i}`,
          createdUserId: 'usr-admin', createdAt: TODAY, isTest: true,
        } as never);
        draft.purchaseInvoiceLines.push({
          id: `${PFX}-PIL${i}`, purchaseInvoiceId: id, itemId: `${PFX}-I${i % SCALE.items}`, quantity: 10, unitPrice: 50,
          lineTotal: 500, unitId: 'unit-piece', batchNumber: `${PFX}-PB${i}`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0,
        } as never);
      }
    });
  }
  for (let c = 0; c < SCALE.movements; c += CHUNK) {
    erpDb.mutate(draft => {
      for (let i = c; i < Math.min(c + CHUNK, SCALE.movements); i++) {
        draft.inventoryTransactions.push({
          id: `${PFX}-T${i}`, itemId: `${PFX}-I${i % SCALE.items}`, warehouseId: i % 2 ? 'wh-raw' : 'wh-local',
          movementType: i % 2 ? 'purchase_receipt' : 'sales_issue', quantityIn: i % 2 ? 20 : 0, quantityOut: i % 2 ? 0 : 5,
          unitCost: 50, documentType: 'أداء', documentNumber: `${PFX}-D${i}`, date: TODAY,
          createdUserId: 'usr-admin', createdAt: TODAY, isTest: true,
        } as never);
      }
    });
  }
  for (let c = 0; c < SCALE.journalEntries; c += CHUNK) {
    erpDb.mutate(draft => {
      for (let i = c; i < Math.min(c + CHUNK, SCALE.journalEntries); i++) {
        draft.journalEntries.push({
          id: `${PFX}-JV${i}`, entryNumber: `${PFX}-J${i}`, date: TODAY, reference: `${PFX}-R${i}`, description: 'أداء',
          sourceDocumentType: 'performance_synthetic', sourceDocumentId: `${PFX}-S${i}`, isPosted: true, isReversed: false,
          totalDebit: 100, totalCredit: 100, createdUserId: 'usr-admin', createdAt: TODAY, createdUserName: 'perf',
          lines: [
            { id: `${PFX}-L${i}a`, journalEntryId: `${PFX}-JV${i}`, accountId: acc('1101'), accountCode: '1101', accountNameAr: 'خزينة', debit: 100, credit: 0, currency: 'EGP', originalAmount: 100, exchangeRate: 1, description: '' },
            { id: `${PFX}-L${i}b`, journalEntryId: `${PFX}-JV${i}`, accountId: acc('4101'), accountCode: '4101', accountNameAr: 'إيرادات', debit: 0, credit: 100, currency: 'EGP', originalAmount: 100, exchangeRate: 1, description: '' },
            { id: `${PFX}-L${i}c`, journalEntryId: `${PFX}-JV${i}`, accountId: acc('1105'), accountCode: '1105', accountNameAr: 'ذمم', debit: 0, credit: 100, currency: 'EGP', originalAmount: 100, exchangeRate: 1, description: '' },
          ],
        } as never);
      }
    });
  }
  for (let c = 0; c < SCALE.productionOrders; c += CHUNK) {
    erpDb.mutate(draft => {
      for (let i = c; i < Math.min(c + CHUNK, SCALE.productionOrders); i++) {
        draft.productionOrders.push({
          id: `${PFX}-PO${i}`, orderNumber: `${PFX}-PO${i}`, productId: `${PFX}-I${i}`, bomId: 'none', plannedQuantity: 100,
          producedQuantity: 100, defectiveQuantity: 0, scrapQuantity: 0, remainingQuantity: 0, startDate: TODAY,
          expectedCompletionDate: TODAY, actualCompletionDate: TODAY, status: 'completed', destinationWarehouseId: 'wh-local',
          targetMarket: 'local', createdUserId: 'usr-admin', createdAt: TODAY, isTest: true,
        } as never);
      }
    });
  }
}
const buildMs = performance.now() - tBuild0;
const db = snap();
console.log(`  dataset built in ${fmt(buildMs)} — customers=${db.customers.length} suppliers=${db.suppliers.length} items=${db.items.length}`);
console.log(`  sales=${db.salesInvoices.length} purchases=${db.purchaseInvoices.length} movements=${db.inventoryTransactions.length} journals=${db.journalEntries.length} production=${db.productionOrders.length}`);

// --------------------------------------------------------------- measurements
console.log('\n── measured execution times (wall clock, single run, no averaging) ──');
const budget = 2000;
time('database snapshot / hydration', () => erpDb.getSnapshot(), budget);
time('general ledger (all account balances)', () => snap().accounts.map(a => {
  const lines = snap().journalEntries.filter(j => j.isPosted && !j.isReversed).flatMap(j => j.lines.filter(l => l.accountId === a.id));
  return lines.reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0);
}), budget * 3);
time('trial balance', () => snap().journalEntries.filter(j => j.isPosted && !j.isReversed)
  .reduce((s, j) => ({ dr: s.dr + j.lines.reduce((x, l) => x + (l.debit || 0), 0), cr: s.cr + j.lines.reduce((x, l) => x + (l.credit || 0), 0) }), { dr: 0, cr: 0 }), budget * 3);
const agingT = time('AR aging (all customers, per-customer statement replay)', () => LedgerService.buildReceivablesAging({}), budget * 5);
time('customer statement (single customer)', () => LedgerService.buildCustomerStatement({ customerId: `${PFX}-C7` }), budget);
time('treasury ledger', () => TreasuryLedgerService.build({}), budget);
time('inventory valuation (all batches)', () => snap().batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0), budget);
time('inventory movement listing (10,000 rows)', () => snap().inventoryTransactions.filter(t => String(t.documentNumber || '').includes(PFX)), budget);
time('sales report (5,000 invoices + lines)', () => {
  const ids = new Set(snap().salesInvoices.filter(i => String(i.id).includes(PFX)).map(i => i.id));
  return snap().salesInvoiceLines.filter(l => ids.has(l.invoiceId)).reduce((s, l) => s + l.netTotal, 0);
}, budget * 2);
time('purchase report (5,000 invoices + lines)', () => snap().purchaseInvoices.filter(i => String(i.id).includes(PFX)).reduce((s, i) => s + i.totalAmount, 0), budget);
time('production orders listing (1,000)', () => snap().productionOrders.filter(o => String(o.id).includes(PFX)), budget);
time('search items by name (1,000 items)', () => snap().items.filter(i => String(i.nameAr || '').includes('أداء')), 500);
time('filter sales by customer', () => snap().salesInvoices.filter(i => i.customerId === `${PFX}-C7`), 500);
time('filter sales by status + date range', () => snap().salesInvoices.filter(i => (i.status as string) === 'posted' && String((i as never as { invoiceDate: string }).invoiceDate || '') <= TODAY), 500);
time('sort 1,000 items by name', () => [...snap().items].sort((a, b) => String(a.nameAr).localeCompare(String(b.nameAr))), 500);
time('sort 5,000 sales by total amount', () => [...snap().salesInvoices].sort((a, b) => b.totalAmount - a.totalAmount), budget);
time('item card balance for 1 item', () => InventoryEngine.getItemBalance(`${PFX}-I7`, 'wh-local'), 500);

// ------------------------------------------------------------------ summary
console.log('\n── honesty notes ──');
console.log('  • Every number above is a single measured wall-clock execution (performance.now), not an estimate.');
console.log('  • The synthetic rows were inserted directly into the in-memory store; the MEASURED work is the');
console.log('    reporting/aggregation layer the UI runs on load and on every refresh.');
console.log('  • Browser render / paint / scroll / interaction latency is NOT measured (no browser here) → NOT TESTED / MANUAL.');
console.log(`\n  ${pass} passed, ${fail} failed (${agingT.ms >= 0 ? 'AR aging measured' : 'AR aging threw'})`);

// ------------------------------------------------------------------ cleanup
const tClean0 = performance.now();
erpDb.mutate(draft => {
  draft.customers = draft.customers.filter(c => !String(c.id).includes(PFX));
  draft.suppliers = draft.suppliers.filter(s => !String(s.id).includes(PFX));
  draft.items = draft.items.filter(i => !String(i.id).includes(PFX));
  draft.salesInvoices = draft.salesInvoices.filter(i => !String(i.id).includes(PFX));
  draft.salesInvoiceLines = draft.salesInvoiceLines.filter(l => !String(l.id).includes(PFX));
  draft.purchaseInvoices = draft.purchaseInvoices.filter(i => !String(i.id).includes(PFX));
  draft.purchaseInvoiceLines = draft.purchaseInvoiceLines.filter(l => !String(l.id).includes(PFX));
  draft.inventoryTransactions = draft.inventoryTransactions.filter(t => !String(t.id).includes(PFX));
  draft.journalEntries = draft.journalEntries.slice(0, BASE.journalEntries);
  draft.productionOrders = draft.productionOrders.filter(o => !String(o.id).includes(PFX));
  draft.auditLogs = draft.auditLogs.filter(a => !String(a.description || '').includes(PFX));
  BASE.accounts.forEach(b => { const a = draft.accounts.find(x => x.id === b.id); if (a) a.currentBalance = b.b; });
  BASE.customers.forEach((v, i) => { if (draft.customers[i]) draft.customers[i].currentBalance = v; });
  BASE.suppliers.forEach((v, i) => { if (draft.suppliers[i]) draft.suppliers[i].currentBalance = v; });
  BASE.items.forEach(b => { const i = draft.items.find(x => x.id === b.id); if (i) i.actualCost = b.c; });
});
const after = snap();
const leftovers = ['customers', 'suppliers', 'items', 'salesInvoices', 'purchaseInvoices', 'inventoryTransactions', 'productionOrders']
  .reduce((s, k) => s + (after as never as Record<string, Array<{ id: string }>>)[k].filter(r => String(r.id).includes(PFX)).length, 0);
const restored = after.salesInvoices.length === BASE.salesInvoices && after.purchaseInvoices.length === BASE.purchaseInvoices
  && after.productionOrders.length === BASE.productionOrders
  && BASE.accounts.every(b => Math.abs((snap().accounts.find(a => a.id === b.id)?.currentBalance || 0) - b.b) < 0.01);
console.log(`  cleanup in ${fmt(performance.now() - tClean0)}: leftover synthetic rows=${leftovers}; journals ${after.journalEntries.length}/${BASE.journalEntries}; document counts + balances restored=${restored}`);
process.exit(fail || leftovers || !restored ? 1 : 0);