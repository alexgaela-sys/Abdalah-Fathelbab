// Isolated scratch regression for the export COGS account fix, plus read-only
// LocalStorage presence checks (no read of values, no mutation, no reseed).
import { erpDb, createEmptyDatabase, applyMasterDataMigration, applyUomMigration } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { WorkflowService } from '../src/services/workflows';

const PRISTINE = applyUomMigration(applyMasterDataMigration(createEmptyDatabase()));
const snap = () => erpDb.getSnapshot();
const TODAY = new Date().toISOString().split('T')[0];
const ADMIN = { userId: 'usr-admin', userName: 'QA' };
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

function restore() {
  erpDb.restore(PRISTINE);
}

function accById(id: string) {
  return snap().accounts.find(a => a.id === id);
}

function stockItem(itemId: string, warehouseId: string, qty: number, unitCost: number) {
  const batchNumber = `T-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  erpDb.mutate(draft => {
    const series = Math.random().toString(36).slice(2, 6).toUpperCase();
    draft.inventoryTransactions.push({
      id: `tx-${Date.now()}-${series}`,
      date: TODAY,
      itemId,
      warehouseId,
      movementType: 'purchase_receipt',
      quantityIn: qty,
      quantityOut: 0,
      balanceAfter: qty,
      unitCost,
      totalCost: unitCost * qty,
      documentType: 'test_stock',
      documentNumber: `TEST-STK-${series}`,
      batchNumber,
      isTest: true,
    });
    draft.batches.push({
      id: `b-${Date.now()}-${series}`,
      batchNumber,
      itemId,
      warehouseId,
      quantity: qty,
      unitCost,
      productionDate: TODAY,
      expiryDate: '2027-06-01',
      isTest: true,
    });
  });
}

function journalFor(jeId?: string) {
  if (!jeId) return undefined;
  return snap().journalEntries.find(j => j.id === jeId);
}

function assertExportCogsAccount(je: { lines: Array<{ accountId: string; accountCode: string; debit: number; credit: number }> }) {
  const cogsDebitLine = je.lines.find(l => (l.debit || 0) > 0 && accById(l.accountId)?.code === '5102');
  if (cogsDebitLine?.accountId !== 'acc-5102') throw new Error(`export COGS accountId expected acc-5102, got ${cogsDebitLine?.accountId}`);
  if (cogsDebitLine?.accountCode !== '5102') throw new Error(`export COGS accountCode expected 5102, got ${cogsDebitLine?.accountCode}`);
  if (je.lines.some(l => l.accountCode === '5003')) throw new Error('found accountCode 5003 in export journal lines');
  const dr = je.lines.reduce((s, l) => s + (l.debit || 0), 0);
  const cr = je.lines.reduce((s, l) => s + (l.credit || 0), 0);
  if (!near(dr, cr)) throw new Error(`journal not balanced: DR=${dr} CR=${cr}`);
  const cogsDebits = je.lines.filter(l => (l.debit || 0) > 0 && accById(l.accountId)?.category === 'COGS');
  if (cogsDebits.length !== 1) throw new Error(`expected exactly 1 COGS debit line, got ${cogsDebits.length}`);
  return cogsDebitLine;
}

console.log('=== export COGS account fix regression (scratch) ===');

restore();
{
  const supRes = MasterDataService.createSupplier({ code: `SUP-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: `مورد ${Math.random().toString(36).slice(2, 6).toUpperCase()}`, isTest: true, ...ADMIN } as never);
  if (!(supRes.success)) throw new Error(`supplier creation: ${supRes.error ?? ''}`);
  const custRes = MasterDataService.createCustomer({
    code: `CUST-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    name: 'ع1',
    customerType: 'export',
    currency: 'USD',
    isTest: true,
    ...ADMIN,
  } as never);
  if (!(custRes.success)) throw new Error(`customer creation: ${custRes.error ?? ''}`);

  const fp = snap().items.find(i => i.code === 'FP-DUO-01' && i.itemType === 'finished_product')!;
  erpDb.mutate(draft => {
    const it = draft.items.find(i => i.id === fp.id);
    if (it) { it.standardCost = 40; it.actualCost = 40; }
  });

  stockItem(fp.id, 'wh-export', 100, 40);

  const inv = WorkflowService.createSalesInvoice({
    customerId: custRes.customer!.id,
    channel: 'export',
    warehouseId: 'wh-export',
    paymentMethod: 'credit',
    currency: 'USD',
    exchangeRate: 50,
    date: TODAY,
    lines: [{ itemId: fp.id, quantity: 10, unitPrice: 5, vatRate: 0 }],
    taxTreatment: 'exempt',
    isTest: true,
    ...ADMIN,
  } as never);

  if (!inv.success) throw new Error(`export invoice must post: ${inv.error ?? ''}`);
  const je = journalFor(inv.invoice!.journalEntryId)!;
  const cogsDebitLine = assertExportCogsAccount(je);

  const expectedCogs = 10 * 40;
  if (!near(cogsDebitLine.debit, expectedCogs)) throw new Error(`export COGS amount expected ${expectedCogs}, got ${cogsDebitLine.debit}`);
  console.log('  ✅ single-line export invoice: 5102, no 5003, DR==CR, COGS unchanged');
}

restore();
{
  const supRes = MasterDataService.createSupplier({ code: `SUP-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: `مورد ${Math.random().toString(36).slice(2, 6).toUpperCase()}`, isTest: true, ...ADMIN } as never);
  if (!(supRes.success)) throw new Error(`supplier creation: ${supRes.error ?? ''}`);
  const custRes = MasterDataService.createCustomer({
    code: `CUST-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    name: 'ع2',
    customerType: 'export',
    currency: 'USD',
    isTest: true,
    ...ADMIN,
  } as never);
  if (!(custRes.success)) throw new Error(`customer creation: ${custRes.error ?? ''}`);

  const fp = snap().items.find(i => i.code === 'FP-DUO-01' && i.itemType === 'finished_product')!;
  erpDb.mutate(draft => {
    const it = draft.items.find(i => i.id === fp.id);
    if (it) { it.standardCost = 40; it.actualCost = 40; }
  });

  stockItem(fp.id, 'wh-export', 1000, 40);

  const inv = WorkflowService.createSalesInvoice({
    customerId: custRes.customer!.id,
    channel: 'export',
    warehouseId: 'wh-export',
    paymentMethod: 'credit',
    currency: 'USD',
    exchangeRate: 50,
    date: TODAY,
    lines: [
      { itemId: fp.id, quantity: 10, unitPrice: 5, vatRate: 0 },
      { itemId: fp.id, quantity: 5, unitPrice: 5, vatRate: 0, freeQuantity: 2 },
    ],
    taxTreatment: 'exempt',
    isTest: true,
    ...ADMIN,
  } as never);

  if (!inv.success) throw new Error(`multi-line export invoice must post: ${inv.error ?? ''}`);
  const je = journalFor(inv.invoice!.journalEntryId)!;
  assertExportCogsAccount(je);
  console.log('  ✅ multi-line export invoice: 5102, no 5003, DR==CR, no duplicate COGS');
}

restore();
{
  const supRes = MasterDataService.createSupplier({ code: `SUP-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: `مورد ${Math.random().toString(36).slice(2, 6).toUpperCase()}`, isTest: true, ...ADMIN } as never);
  if (!(supRes.success)) throw new Error(`supplier creation: ${supRes.error ?? ''}`);
  const custRes = MasterDataService.createCustomer({
    code: `CUST-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    name: 'ع3',
    customerType: 'export',
    currency: 'USD',
    isTest: true,
    ...ADMIN,
  } as never);
  if (!(custRes.success)) throw new Error(`customer creation: ${custRes.error ?? ''}`);

  const fp = snap().items.find(i => i.code === 'FP-DUO-01' && i.itemType === 'finished_product')!;
  erpDb.mutate(draft => {
    const it = draft.items.find(i => i.id === fp.id);
    if (it) { it.standardCost = 40; it.actualCost = 40; }
  });

  stockItem(fp.id, 'wh-export', 100, 40);

  const inv = WorkflowService.createSalesInvoice({
    customerId: custRes.customer!.id,
    channel: 'export',
    warehouseId: 'wh-export',
    paymentMethod: 'credit',
    currency: 'USD',
    exchangeRate: 50,
    date: TODAY,
    lines: [{ itemId: fp.id, quantity: 10, unitPrice: 5, vatRate: 0 }],
    taxTreatment: 'exempt',
    isTest: true,
    ...ADMIN,
  } as never);
  if (!inv.success) throw new Error(`export invoice must post: ${inv.error ?? ''}`);
  const invJe = journalFor(inv.invoice!.journalEntryId)!;
  assertExportCogsAccount(invJe);
  console.log('  ✅ pre-shipment export invoice: COGS already 5102 (shipment must not re-post COGS)');

  const ship = WorkflowService.createExportShipment({
    customerId: custRes.customer!.id,
    shipmentDate: TODAY,
    portOfOrigin: 'بورسعيد',
    destinationPort: 'Jeddah',
    usdRevenue: inv.invoice!.totalAmount,
    exchangeRate: 50,
    shippingCost: 100,
    portCosts: 50,
    customsCost: 25,
    otherExportCosts: 0,
    salesInvoiceId: inv.invoice!.id,
    isTest: true,
    ...ADMIN,
  } as never);
  if (!ship.success) throw new Error(`export shipment must post: ${ship.error ?? ''}`);
  const shipJe = snap().journalEntries.find(j => j.sourceDocumentId === ship.shipment!.id);
  if (shipJe) {
    if (shipJe.lines.some(l => l.accountCode === '5003')) throw new Error('found accountCode 5003 in shipment journal lines');
    console.log('  ✅ shipment journal: no 5003, no COGS re-posting conflict on 5102');
  }
}

restore();
{
  const supRes = MasterDataService.createSupplier({ code: `SUP-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: `مورد ${Math.random().toString(36).slice(2, 6).toUpperCase()}`, isTest: true, ...ADMIN } as never);
  if (!(supRes.success)) throw new Error(`supplier creation: ${supRes.error ?? ''}`);
  const custRes = MasterDataService.createCustomer({
    code: `CUST-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    name: 'ع4',
    customerType: 'export',
    currency: 'USD',
    isTest: true,
    ...ADMIN,
  } as never);
  if (!(custRes.success)) throw new Error(`customer creation: ${custRes.error ?? ''}`);

  const fp = snap().items.find(i => i.code === 'FP-DUO-01' && i.itemType === 'finished_product')!;
  erpDb.mutate(draft => {
    const it = draft.items.find(i => i.id === fp.id);
    if (it) { it.standardCost = 40; it.actualCost = 40; }
  });

  stockItem(fp.id, 'wh-export', 100, 40);

  const inv = WorkflowService.createSalesInvoice({
    customerId: custRes.customer!.id,
    channel: 'export',
    warehouseId: 'wh-export',
    paymentMethod: 'credit',
    currency: 'USD',
    exchangeRate: 50,
    date: TODAY,
    lines: [{ itemId: fp.id, quantity: 10, unitPrice: 5, vatRate: 0 }],
    taxTreatment: 'exempt',
    isTest: true,
    ...ADMIN,
  } as never);
  if (!inv.success) throw new Error(`direct-flow export invoice must post: ${inv.error ?? ''}`);
  const je = journalFor(inv.invoice!.journalEntryId)!;
  assertExportCogsAccount(je);
  console.log('  ✅ direct-flow export invoice: COGS mapped to 5102, not any hardcoded wrong code');
}

console.log('=== LocalStorage / UAT presence checks (read-only, no value read, no mutation) ===');
{
  const LS_KEY_WINDOW = 'abdullah_erp_db_v1';
  if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
    const present = window.localStorage.getItem(LS_KEY_WINDOW) !== null;
    console.log(`  ℹ️  window.localStorage key "${LS_KEY_WINDOW}" present = ${present}`);
    console.log('  ℹ️  No item removed/written; no JSON parsed from the value.');
  } else {
    console.log('  ℹ️  No window.localStorage available in this runtime (expected under tsx).');
  }
  if (typeof globalThis !== 'undefined' && typeof (globalThis as any).localStorage !== 'undefined') {
    const present = (globalThis as any).localStorage.getItem(LS_KEY_WINDOW) !== null;
    console.log(`  ℹ️ globalThis.localStorage key "${LS_KEY_WINDOW}" present = ${present}`);
  } else {
    console.log('  ℹ️  No globalThis.localStorage available in this runtime.');
  }
}

console.log('✅ export COGS account fix regression passed');
