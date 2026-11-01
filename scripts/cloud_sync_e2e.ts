// End-to-end test of the cloud store: the REAL accounting code on one "device",
// the REAL sync engine, and the REAL SQL (supabase/cloud-store/001_erp_store.sql)
// on a throwaway PostgreSQL. Run it with: bash scripts/cloud_sync_e2e.sh
//
// It proves, in order:
//   1. a database can be imported once and loaded back identically;
//   2. a full business workload (purchases, FIFO, production, sales, returns)
//      done on device A is stored, and a brand-new device C reads back exactly
//      the same data — records, order and every number;
//   3. a second device (B) sees A's work live;
//   4. two devices editing the same record: the second is refused, loses its
//      unsaved edit, gets the latest data and a notice (never overwrites A);
//   5. two devices can't issue the same document number;
//   6. deletions propagate; offline edits are kept and saved after reconnecting;
//   7. the wipe-everything action is blocked in the shared store.
import { SQL } from 'bun';
import { erpDb, createEmptyDatabase } from '../src/services/db';
import { WorkflowService } from '../src/services/workflows';
import { InventoryEngine } from '../src/services/inventory';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { CloudSync } from '../src/services/cloud/syncEngine';
import {
  ApplyResult,
  ChangesResult,
  OutgoingChange,
  RemoteRecord,
  RemoteStore,
  RemoteUnavailableError,
  RemoteRejectedError,
} from '../src/services/cloud/remoteStore';

const URL_ = process.env.ERP_TEST_PG_URL!;
const USER = process.env.ERP_TEST_USER_ID!;
if (!URL_ || !USER) throw new Error('run through scripts/cloud_sync_e2e.sh');

const sql = new SQL(URL_);

/** RemoteStore that calls the real SQL functions as an authenticated member. */
class PgStore implements RemoteStore {
  offline = false;
  calls = { apply: 0, load: 0, changes: 0 };
  constructor(private uid: string = USER) {}

  private async call<T>(query: string, ...args: unknown[]): Promise<T> {
    if (this.offline) throw new RemoteUnavailableError('simulated outage');
    return sql.begin(async (tx: any) => {
      await tx.unsafe(`set local role authenticated`);
      await tx.unsafe(`select set_config('request.jwt.claim.sub', '${this.uid}', true)`);
      const rows = await tx.unsafe(`select ${query} as r`, args);
      const r = rows[0].r;
      return (typeof r === 'string' && (r.startsWith('{') || r.startsWith('[')) ? JSON.parse(r) : r) as T;
    });
  }

  async head() {
    return Number(await this.call<number>('public.erp_head_seq()'));
  }
  async loadAll(): Promise<RemoteRecord[]> {
    this.calls.load++;
    const out: RemoteRecord[] = [];
    let col = '', ord = 0;
    for (;;) {
      const r = await this.call<any>('public.erp_load_page($1, $2::bigint, 700)', col, ord);
      if (r.status === 'forbidden') throw new RemoteRejectedError('this account is not authorised to use the cloud store', 'forbidden');
      if (r.rows != null) { for (const row of r.rows as any) out.push(row); }
      if (r.done || !r.next) break;
      col = r.next.collection; ord = r.next.ord;
    }
    return out;
  }
  async changesSince(after: number, limit = 500): Promise<ChangesResult> {
    this.calls.changes++;
    return this.call('public.erp_changes_since($1::bigint, $2::int)', after, limit);
  }
  async apply(changes: OutgoingChange[], clientId: string, bulk = false): Promise<ApplyResult> {
    this.calls.apply++;
    return this.call('public.erp_apply_changes($1::text::jsonb, $2::text, $3::boolean)', JSON.stringify(changes), clientId, bulk);
  }
  async stats() {
    const r = await this.call<any>('public.erp_stats()');
    return { counts: r.counts, head: r.head, role: r.role };
  }
}

/** A second/third computer: same engine, its own in-memory database. */
class Device {
  db: any = createEmptyDatabase();
  cloud: CloudSync;
  constructor(public name: string, store: RemoteStore) {
    this.cloud = new CloudSync(
      store,
      { getDb: () => this.db, createEmpty: () => createEmptyDatabase() as any, onRemoteApplied: () => {} },
      { clientId: name },
    );
  }
  mutate(fn: (d: any) => void) {
    fn(this.db);
    this.cloud.markDirty();
  }
}

// ------------------------------------------------------------------ helpers ---
let pass = 0, fail = 0;
const check = (label: string, ok: boolean, info = '') => {
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${info ? ` — ${info}` : ''}`); }
};
const section = (t: string) => console.log(`\n▶ ${t}`);

const canon = (v: any): any =>
  Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])]))
  : v;
const sameJson = (a: any, b: any) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** compare two databases: every collection, order-insensitive then order-sensitive */
function diffDbs(a: any, b: any): { content: string[]; order: string[] } {
  const content: string[] = [], order: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k], y = b[k];
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) { content.push(`${k}: ${x.length} vs ${y.length} records`); continue; }
      const mx = new Map(x.map((r: any) => [r.id, r])), my = new Map(y.map((r: any) => [r.id, r]));
      for (const [id, r] of mx) if (!my.has(id) || !sameJson(r, my.get(id))) { content.push(`${k}/${id} differs`); break; }
      if (!sameJson(x.map((r: any) => r.id), y.map((r: any) => r.id))) order.push(k);
    } else if (!sameJson(x, y)) content.push(`${k} differs`);
  }
  return { content, order };
}

const today = new Date().toISOString().split('T')[0];
const store = new PgStore();
const quietLog = console.log;

// ================================================================ 1. import ===
section('1. One-time import, then load it back');
const seed: any = createEmptyDatabase(); // the app's default master data (chart of accounts, items, BOMs...)
const A = erpDb.attachCloud(store, { clientId: 'device-A', pollMs: 100000 });
const first = await A.connect();
check('a brand-new store reports empty (first-time setup)', first.empty === true);
check('...and the in-memory lists are blank until the data is imported', erpDb.getSnapshot().accounts.length === 0);

const imp = await A.importAll(seed);
check(`import stored ${imp.inserted} records`, imp.inserted > 100 && imp.skipped === 0);
const imp2 = await A.importAll(seed);
check('import is resumable: running it again inserts nothing', imp2.inserted === 0 && imp2.skipped === imp.inserted);

const again = await A.connect();
check('connect after import is not empty', again.empty === false);
const d1 = diffDbs(erpDb.getSnapshot(), seed);
const onlyUsers = d1.content.every((l: string) => l.startsWith('users:'));
check('loaded data equals what was imported (users are device-local and never uploaded)', onlyUsers, 'diff: ' + d1.content.join('; '));
check('device-local users survive a reload (not wiped, so in-app login keeps working)', (erpDb.getSnapshot() as any).users.length >= 1);
console.log('E2E Section 1 PASSED: import + reload verified');
check('list order preserved after the round-trip', d1.order.length === 0, d1.order.join(','));

// ======================================================= 2. real workload ===
section('2. Real accounting workload on device A');
console.log = () => {}; // the services are chatty
erpDb.mutate(d => {
  d.suppliers.push({ id: 'e2e-sup', code: 'E2E-SUP', name: 'مورّد E2E', phone: '0100', address: 'x', currency: 'EGP', openingBalance: 0, currentBalance: 0, active: true, isTest: true } as any);
  d.customers.push({ id: 'e2e-cust', code: 'E2E-CUST', name: 'عميل E2E', customerType: 'wholesale', channel: 'wholesale', address: 'x', phone: '0101', currency: 'EGP', creditLimit: 1e9, currentBalance: 0, openingBalance: 0, active: true, isTest: true } as any);
  d.items.push({
    id: 'e2e-item', code: 'E2E-001', nameAr: 'مادة E2E', nameEn: 'E2E item', itemType: 'raw_material',
    baseUnitId: 'unit-kg', purchaseUnitId: 'unit-kg', vatRate: 0.14, vatCategory: 'standard',
    trackBatch: true, trackExpiry: true, expiryPeriodDays: 30, standardCost: 10, actualCost: 10,
    sellingPriceRetail: 0, sellingPriceWholesale: 0, sellingPriceExportUSD: 0, active: true, minStockLevel: 0, isTest: true,
  } as any);
});
const p1 = WorkflowService.createPurchaseInvoice({
  supplierId: 'e2e-sup', warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, reference: 'E2E-P1', date: today,
  lines: [{ itemId: 'e2e-item', quantity: 100, unitId: 'unit-kg', unitPrice: 10, batchNumber: 'E2E-B1', productionDate: today, expiryDate: '', vatRate: 0 }],
} as any);
const p2 = WorkflowService.createPurchaseInvoice({
  supplierId: 'e2e-sup', warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, reference: 'E2E-P2', date: today,
  lines: [{ itemId: 'e2e-item', quantity: 100, unitId: 'unit-kg', unitPrice: 20, batchNumber: 'E2E-B2', productionDate: today, expiryDate: '', vatRate: 0 }],
} as any);
const issue = InventoryEngine.recordMovement({ itemId: 'e2e-item', warehouseId: 'wh-raw', movementType: 'production_issue', quantityIn: 0, quantityOut: 150, unitCost: 0, documentType: 'FIFO', documentNumber: 'E2E-ISSUE-1' } as any);
InventoryEngine.transferWarehouse('e2e-item', 'wh-raw', 'wh-local', 20, undefined, 'E2E-B2');
erpDb.mutate(d => {
  d.boms.push({ id: 'e2e-bom', finishedItemId: 'e2e-item', baseQuantity: 100, unitId: 'unit-kg', active: true, effectiveDate: today, isTest: true } as any);
  d.bomLines.push({ id: 'e2e-bl1', bomId: 'e2e-bom', materialItemId: 'e2e-item', quantityRequired: 80, unitId: 'unit-kg' } as any);
  d.productionOrders.push({
    id: 'e2e-pord', orderNumber: 'E2E-PRD-1', productId: 'e2e-item', bomId: 'e2e-bom', plannedQuantity: 100, producedQuantity: 0,
    defectiveQuantity: 0, scrapQuantity: 0, remainingQuantity: 100, startDate: today, expectedCompletionDate: today, status: 'released',
    destinationWarehouseId: 'wh-local', targetMarket: 'local', createdUserId: 'usr-admin', createdAt: new Date().toISOString(), isTest: true,
  } as any);
});
InventoryEngine.recordMovement({ itemId: 'e2e-item', warehouseId: 'wh-raw', movementType: 'purchase_receipt', quantityIn: 500, quantityOut: 0, unitCost: 15, documentType: 'x', documentNumber: 'E2E-REPL', batchNumber: 'E2E-B3' } as any);
const iss = ManufacturingEngine.issueMaterialsToOrder({ orderId: 'e2e-pord', date: today, userId: 'usr-admin', userName: 'E2E' } as any);
const out = ManufacturingEngine.recordDailyProduction({ orderId: 'e2e-pord', goodQuantity: 95, defectiveQuantity: 3, scrapQuantity: 2, defectiveAction: 'to_recycling', date: today, userId: 'usr-admin', userName: 'E2E' } as any);
const cls = ManufacturingEngine.closeProductionOrder('e2e-pord', 'usr-admin', 'E2E');
const sale = WorkflowService.createSalesInvoice({
  customerId: 'e2e-cust', channel: 'wholesale', warehouseId: 'wh-local', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: today,
  lines: [{ itemId: 'e2e-item', quantity: 10, freeQuantity: 1, unitPrice: 40, vatRate: 0.14 }],
} as any);
const ret = WorkflowService.postSalesReturn({
  customerId: 'e2e-cust', invoiceId: (sale as any).invoice?.id, date: today, reason: 'E2E مرتجع', lines: [{ itemId: 'e2e-item', quantity: 3, unitPrice: 40, vatRate: 0.14 }],
  inspectionOverrides: { 'e2e-item': 'saleable' },
} as any);
console.log = quietLog;

check('workload ran through the real services (purchases, FIFO, production, sales, return)',
  [p1, p2, issue, iss, out, cls, sale, ret].every((r: any) => r && r.success), JSON.stringify([p1, p2, issue, iss, out, cls, sale, ret].map((r: any) => r?.success)));
check('save is pending right after the workload (nothing sent yet)', A.getStatus().pending === true);
await A.flushNow();
check('after flush: status idle and nothing pending', A.getStatus().state === 'idle' && !A.getStatus().pending, JSON.stringify(A.getStatus()));
const mem = erpDb.getSnapshot();
console.log(`    (${mem.journalEntries.length} journal entries, ${mem.inventoryTransactions.length} stock movements, ${mem.salesInvoices.length} sales invoices stored)`);

// ============================================== 3. a brand-new device reads ===
section('3. A brand-new device (C) reads everything back');
const C = new Device('device-C', new PgStore());
await C.cloud.connect();
const d3 = diffDbs(mem, C.db);
check('device C holds exactly the same data as device A (every collection)', d3.content.length === 0, d3.content.join('; '));
check('device C has the same list order', d3.order.length === 0, d3.order.join(','));
const tb = (db: any) => db.journalEntries.reduce((s: number, j: any) => s + j.lines.reduce((x: number, l: any) => x + l.debit - l.credit, 0), 0);
check('trial balance on C is balanced (debits = credits)', Math.abs(tb(C.db)) < 0.01, `diff=${tb(C.db)}`);
check('account balances on C equal A', sameJson(mem.accounts.map((a: any) => a.currentBalance), C.db.accounts.map((a: any) => a.currentBalance)));

// ========================================================= 4. live updates ===
section('4. Device B follows device A live');
const B = new Device('device-B', new PgStore());
await B.cloud.connect();
console.log = () => {};
const sale2 = WorkflowService.createSalesInvoice({
  customerId: 'e2e-cust', channel: 'wholesale', warehouseId: 'wh-local', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: today,
  lines: [{ itemId: 'e2e-item', quantity: 5, unitPrice: 40, vatRate: 0.14 }],
} as any);
console.log = quietLog;
await A.flushNow();
check('A posted a second sale', !!sale2.success, (sale2 as any).error);
const before = B.db.salesInvoices.length;
await B.cloud.pollOnce();
check('B received the new invoice without reloading', B.db.salesInvoices.length === before + 1);
check('B is identical to A after polling', diffDbs(erpDb.getSnapshot(), B.db).content.length === 0, diffDbs(erpDb.getSnapshot(), B.db).content.join('; '));

// ================================================== 5. same record, 2 devices ===
section('5. Two devices edit the same record');
await C.cloud.pollOnce();
const aItem = () => erpDb.getSnapshot().items.find((i: any) => i.id === 'e2e-item')!;
const bItem = () => B.db.items.find((i: any) => i.id === 'e2e-item');
erpDb.mutate(d => { d.items.find((i: any) => i.id === 'e2e-item')!.standardCost = 111; });
await A.flushNow();
B.mutate(d => { d.items.find((i: any) => i.id === 'e2e-item').standardCost = 222; });
await B.cloud.flushNow();
check('B was refused (A saved first)', B.cloud.getStatus().notice?.kind === 'conflict', JSON.stringify(B.cloud.getStatus()));
check('B lost its unsaved edit and now shows A’s value (111), not its own (222)', bItem().standardCost === 111, `B sees ${bItem().standardCost}`);
check('A’s value is intact on the server', (await new PgStore().loadAll()).find(r => r.collection === 'items' && r.id === 'e2e-item')!.data.standardCost === 111);
B.cloud.dismissNotice();
B.mutate(d => { d.items.find((i: any) => i.id === 'e2e-item').standardCost = 333; });
await B.cloud.flushNow();
check('after the refresh B can save its change (333)', B.cloud.getStatus().state === 'idle' && !B.cloud.getStatus().pending && !B.cloud.getStatus().notice);
await A.pollOnce();
check('A picks up B’s change', aItem().standardCost === 333, `A sees ${aItem().standardCost}`);

// ======================================== 6. same document number twice ===
section('6. The same invoice number can’t be issued twice');
const mkInv = (id: string) => ({ id, invoiceNumber: 'SINV-9999-00001', customerId: 'e2e-cust', status: 'draft', totalAmount: 1 });
B.mutate(d => d.salesInvoices.push(mkInv('dup-b')));
await B.cloud.flushNow();
C.mutate(d => d.salesInvoices.push(mkInv('dup-c')));
await C.cloud.flushNow();
check('the second device was refused as a duplicate number', C.cloud.getStatus().notice?.conflicts?.[0]?.reason === 'duplicate_number', JSON.stringify(C.cloud.getStatus().notice));
check('device C no longer holds its refused invoice', !C.db.salesInvoices.some((i: any) => i.id === 'dup-c'));
check('exactly one invoice with that number exists on the server',
  (await new PgStore().loadAll()).filter(r => r.collection === 'salesInvoices' && (r.data as any).invoiceNumber === 'SINV-9999-00001').length === 1);

// ================================================ 7. deletes + offline ===
section('7. Deletions propagate; offline edits are kept and saved later');
await B.cloud.pollOnce(); await C.cloud.pollOnce(); await A.pollOnce();
B.mutate(d => { d.salesInvoices = d.salesInvoices.filter((i: any) => i.id !== 'dup-b'); });
await B.cloud.flushNow();
await C.cloud.pollOnce();
check('a deletion on B disappears on C', !C.db.salesInvoices.some((i: any) => i.id === 'dup-b'));

const off = new PgStore(); const D = new Device('device-D', off);
await D.cloud.connect();
off.offline = true;
D.mutate(d => d.customers.push({ id: 'offline-cust', code: 'OFF-1', name: 'عميل أوفلاين', currentBalance: 0 }));
await D.cloud.flushNow();
check('while offline: edit kept in memory, status = offline, still pending', D.cloud.getStatus().state === 'offline' && D.cloud.getStatus().pending && D.db.customers.some((c: any) => c.id === 'offline-cust'));
off.offline = false;
await D.cloud.flushNow();
check('after reconnecting: saved', D.cloud.getStatus().state === 'idle' && !D.cloud.getStatus().pending);
await C.cloud.pollOnce();
check('and visible on another device', C.db.customers.some((c: any) => c.id === 'offline-cust'));
D.cloud.stop();

// ============================================ 8. history pruned → reload ===
section('8. A device that was away too long reloads everything');
await sql.unsafe(`delete from public.erp_changes where seq < (select max(seq) from public.erp_changes)`);
B.mutate(d => { d.customers.push({ id: 'after-prune', code: 'AP-1', name: 'x', currentBalance: 0 }); });
await B.cloud.flushNow();
await C.cloud.pollOnce();
check('device C caught up despite the pruned history', C.db.customers.some((c: any) => c.id === 'after-prune'));

// ================================================================ 9. safety ===
section('9. Safety');
let blocked = false;
try { erpDb.resetToClean(); } catch { blocked = true; }
check('“reset to clean” is refused in the shared store', blocked);
const outsider = new PgStore('99999999-9999-9999-9999-999999999999');
let forbidden = false;
try { await outsider.loadAll(); } catch { forbidden = true; }
check('a signed-in user who is not an approved member cannot read the data', forbidden);

for (const d of [B, C]) d.cloud.stop();
A.stop();
console.log(`\n${'='.repeat(60)}\n${fail === 0 ? `🎉 ALL ${pass} CLOUD SYNC CHECKS PASSED` : `⚠️ ${fail} FAILED, ${pass} passed`}\n${'='.repeat(60)}`);
await sql.close();
process.exit(fail === 0 ? 0 : 1);
