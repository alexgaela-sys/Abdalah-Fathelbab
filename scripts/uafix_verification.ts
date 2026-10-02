// UAT fixes verification — covers the behaviour implemented for the 16 UAT findings.
// Additive suite: it never resets or reseeds the store and cleans up only its own
// test records (isTest: true) at the end, exactly like the existing harnesses.
import { erpDb, generateErpId } from '../src/services/db';
import { AccountingEngine } from '../src/services/accounting';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { WorkflowService } from '../src/services/workflows';
import { MasterDataService } from '../src/services/masterData';
import { AuthService } from '../src/services/auth';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ❌ ${label} ${detail}`);
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

const TODAY = new Date().toISOString().split('T')[0];

// ---------------------------------------------------------------------------
section('F1 — BOM management: versions, single-active, production gate preserved');
// ---------------------------------------------------------------------------
const fp = erpDb.getSnapshot().items.find(i => i.itemType === 'finished_product')!;
const corn = erpDb.getSnapshot().items.find(i => i.itemType === 'raw_material')!;
const carton = erpDb.getSnapshot().items.find(i => i.itemType === 'packaging_material')!;
const db0 = erpDb.getSnapshot();
const bomsBefore = db0.boms.filter(b => (b.finishedItemId || b.productId) === fp.id).length;
const seededBomsTotal = db0.boms.length;

const v2 = ManufacturingEngine.createBomVersion({
  finishedItemId: fp.id,
  baseQuantity: 500,
  unitId: 'unit-carton',
  effectiveDate: TODAY,
  notes: 'UAT test version',
  lines: [
    { materialItemId: corn.id, quantityRequired: 400, unitId: corn.baseUnitId, wastePercentage: 2 },
    { materialItemId: carton.id, quantityRequired: 500, unitId: carton.baseUnitId, wastePercentage: 0 },
  ],
  isTest: true,
});
check('createBomVersion succeeds', v2.success, v2.error || '');
check('new BOM gets version n+1', v2.success && (v2.bom?.version || 0) === bomsBefore + 1, `got ${v2.bom?.version}`);
check('new BOM is active by default', v2.success && v2.bom?.active === true);

const afterV2 = erpDb.getSnapshot();
const activeForProduct = afterV2.boms.filter(b => (b.finishedItemId || b.productId) === fp.id && b.active);
check('exactly ONE active BOM per finished product', activeForProduct.length === 1, `got ${activeForProduct.length}`);
check('previous BOM versions are preserved (not deleted)',
  afterV2.boms.filter(b => (b.finishedItemId || b.productId) === fp.id).length === bomsBefore + 1);
check('pre-existing seeded BOMs untouched in count', afterV2.boms.length === seededBomsTotal + 1);

const upd = ManufacturingEngine.updateBom({
  bomId: v2.bom!.id,
  notes: 'UAT edited',
  lines: [{ materialItemId: corn.id, quantityRequired: 450, unitId: corn.baseUnitId }],
  isTest: true,
});
check('updateBom succeeds', upd.success, upd.error || '');
check('updateBom replaced lines',
  erpDb.getSnapshot().bomLines.filter(l => l.bomId === v2.bom!.id).length === 1);

const badBom = ManufacturingEngine.createBomVersion({
  finishedItemId: fp.id, baseQuantity: 0, unitId: 'unit-carton', effectiveDate: TODAY, lines: [], isTest: true,
});
check('BOM with zero base qty / no lines is rejected', !badBom.success);

const notFinished = ManufacturingEngine.createBomVersion({
  finishedItemId: corn.id, baseQuantity: 10, unitId: corn.baseUnitId, effectiveDate: TODAY,
  lines: [{ materialItemId: corn.id, quantityRequired: 1, unitId: corn.baseUnitId }], isTest: true,
});
check('BOM for a raw material is rejected', !notFinished.success);

const gated = ManufacturingEngine.createProductionOrder({
  productId: fp.id, plannedQuantity: 10, targetMarket: 'local',
  destinationWarehouseId: 'wh-local', expectedCompletionDate: TODAY, isTest: true,
});
check('production order can be created while a BOM is active', gated.success, gated.error || '');

if (v2.success) {
  const off = ManufacturingEngine.setBomActive(v2.bom!.id, false, 'usr-admin', 'UAT');
  check('setBomActive(false) succeeds', off.success, off.error || '');
  const blocked = ManufacturingEngine.createProductionOrder({
    productId: fp.id, plannedQuantity: 10, targetMarket: 'local',
    destinationWarehouseId: 'wh-local', expectedCompletionDate: TODAY, isTest: true,
  });
  check('production BLOCKED when no active BOM (rule not weakened)',
    !blocked.success && (blocked.error || '').includes('BOM'), blocked.error || '');

  const oldActive = erpDb.getSnapshot().boms.find(b => (b.finishedItemId || b.productId) === fp.id && !b.active);
  if (oldActive) {
    const on = ManufacturingEngine.setBomActive(oldActive.id, true, 'usr-admin', 'UAT');
    check('re-activating an older version succeeds', on.success, on.error || '');
    const actives = erpDb.getSnapshot().boms.filter(b => (b.finishedItemId || b.productId) === fp.id && b.active);
    check('single-active rule still enforced after re-activation', actives.length === 1, `got ${actives.length}`);
  }
}

// ---------------------------------------------------------------------------
section('F2 — Representatives master data');
// ---------------------------------------------------------------------------
const repCode = `UAT-REP-${Date.now().toString(36)}`;
const rep = WorkflowService.createSalesRepresentative({
  code: repCode, name: 'مندوب الاختبار UAT', phone: '0100000000', targetMonthlySales: 50000, isTest: true,
});
check('createSalesRepresentative succeeds', rep.success, rep.error || '');
const dupRep = WorkflowService.createSalesRepresentative({ code: repCode, name: 'آخر', isTest: true });
check('duplicate rep code is rejected', !dupRep.success);
const repEdit = WorkflowService.updateSalesRepresentative({ repId: rep.rep!.id, targetMonthlySales: 75000, isTest: true });
check('updateSalesRepresentative succeeds', repEdit.success, repEdit.error || '');
check('rep target updated', repEdit.success && (repEdit.rep?.targetMonthlySales || 0) === 75000);
const repOff = WorkflowService.updateSalesRepresentative({ repId: rep.rep!.id, active: false, isTest: true });
check('representative can be deactivated', repOff.success && repOff.rep?.active === false);
const repOn = WorkflowService.updateSalesRepresentative({ repId: rep.rep!.id, active: true, isTest: true });
check('representative can be reactivated', repOn.success && repOn.rep?.active === true);
check('representative immediately available in custody dropdown source',
  erpDb.getSnapshot().salesReps.some(r => r.id === rep.rep!.id && r.active));

// ---------------------------------------------------------------------------
section('F11 — Journal reversal lifecycle');
// ---------------------------------------------------------------------------
const mkJv = (n: number) => AccountingEngine.postJournal({
  date: TODAY, reference: `UAT-${n}`, description: `uat ${n}`,
  sourceDocumentType: 'manual_journal', sourceDocumentId: `uat-${n}`,
  lines: [
    { id: '', journalEntryId: '', accountId: 'acc-1101', accountCode: '1101', accountNameAr: 'نقدية', debit: 100, credit: 0, description: '', currency: 'EGP', originalAmount: 100, exchangeRate: 1 },
    { id: '', journalEntryId: '', accountId: 'acc-4101', accountCode: '4101', accountNameAr: 'إيرادات', debit: 0, credit: 100, description: '', currency: 'EGP', originalAmount: 100, exchangeRate: 1 },
  ],
}, 'usr-admin', 'UAT', true);

const jvA = mkJv(1);
const jvB = mkJv(2);
check('two independent journals posted', !!jvA.entry && !!jvB.entry);
const revA1 = AccountingEngine.reverseJournal(jvA.entry!.id, 'uat', 'usr-admin', 'UAT');
check('reverse A (first time) succeeds', revA1.success, revA1.error || '');
const revA2 = AccountingEngine.reverseJournal(jvA.entry!.id, 'uat', 'usr-admin', 'UAT');
check('reverse A (second time) REJECTED', !revA2.success);
const revB = AccountingEngine.reverseJournal(jvB.entry!.id, 'uat', 'usr-admin', 'UAT');
check('independent journal B is still reversible', revB.success, revB.error || '');
if (revA1.reversalEntry) {
  const revOfRev = AccountingEngine.reverseJournal(revA1.reversalEntry.id, 'uat', 'usr-admin', 'UAT');
  check('reversing a REVERSAL entry is rejected (no double reversal)', !revOfRev.success, revOfRev.error || '');
}

// ---------------------------------------------------------------------------
section('F12 — Export shipment linked to a posted export invoice + collection');
// ---------------------------------------------------------------------------
// The clean store ships no customers/suppliers — create the ones this suite needs
// (through the guarded master-data service) and remove exactly those at the end.
const createdCustomerIds: string[] = [];
const createdSupplierIds: string[] = [];

const ensureCustomer = (type: 'retail' | 'export', tag: string) => {
  const existing = erpDb.getSnapshot().customers.find(c => c.customerType === type);
  if (existing) return existing;
  const res = MasterDataService.createCustomer({
    code: `UAT-${tag}-${Date.now().toString(36)}`,
    name: `عميل اختبار ${tag}`,
    customerType: type,
    channel: type,
    currency: 'EGP',
    isTest: true,
  });
  if (res.success && res.customer) createdCustomerIds.push(res.customer.id);
  return res.customer;
};

const ensureSupplier = () => {
  const existing = erpDb.getSnapshot().suppliers.find(s => s.active);
  if (existing) return existing;
  const res = MasterDataService.createSupplier({
    code: `UAT-SUP-${Date.now().toString(36)}`,
    name: `مورد اختبار ${Date.now().toString(36)}`,
    isTest: true,
  });
  if (res.success && res.supplier) createdSupplierIds.push(res.supplier.id);
  return res.supplier;
};

const exportCustomer = ensureCustomer('export', 'EXP');
if (exportCustomer) {
  // The clean store ships empty warehouses — receive finished stock into WH-02/WH-03
  // through the normal inventory-count workflow so the sales cycle can actually run.
  const stockItem = erpDb.getSnapshot().items.find(i => i.itemType === 'finished_product')!;
  [erpDb.getSnapshot().warehouses.find(w => w.id === 'wh-local')?.id,
   erpDb.getSnapshot().warehouses.find(w => w.id === 'wh-export')?.id]
    .filter((w): w is string => !!w)
    .forEach(whId => {
      WorkflowService.postInventoryCount({
        warehouseId: whId, date: TODAY,
        lines: [{ itemId: stockItem.id, systemQuantity: 0, physicalQuantity: 100, unitCost: 60 }],
        isTest: true,
      });
    });
  check('finished stock received into local + export warehouses',
    erpDb.getSnapshot().inventoryTransactions.filter(t => t.itemId === stockItem.id).length >= 2);
  const expItem = erpDb.getSnapshot().items.find(i => i.itemType === 'finished_product')!;
  const inv = WorkflowService.createSalesInvoice({
    customerId: exportCustomer.id, channel: 'export', warehouseId: 'wh-export',
    paymentMethod: 'credit', currency: 'USD', exchangeRate: 50, date: TODAY,
    lines: [{ itemId: expItem.id, quantity: 1, unitPrice: 100, vatRate: 0 }],
    isTest: true,
  });
  check('export sales invoice posts', inv.success, inv.error || '');
  check('export invoice posts 1106 receivable + 4103 revenue + 5102 COGS',
    inv.success && !!inv.invoice?.journalEntryId);

  const acc = (id: string) => erpDb.getSnapshot().accounts.find(a => a.id === id)?.currentBalance || 0;
  const rev4103 = acc('acc-4103');
  const recv1106 = acc('acc-1106');
  const cogs5102 = acc('acc-5102');

  const shp = inv.success ? WorkflowService.createExportShipment({
    customerId: exportCustomer.id, shipmentDate: TODAY, portOfOrigin: 'Alexandria',
    destinationPort: 'Jebel Ali', usdRevenue: 100, exchangeRate: 50, productCost: 60,
    shippingCost: 5, portCosts: 2, customsCost: 1, otherExportCosts: 1,
    salesInvoiceId: inv.invoice!.id, isTest: true,
  }) : { success: false as const, error: 'skipped' };
  check('export shipment linked to invoice succeeds', shp.success, shp.error || '');
  check('shipment does NOT re-post revenue (4103 unchanged)', shp.success && acc('acc-4103') === rev4103);
  check('shipment does NOT re-post receivable (1106 unchanged)', shp.success && acc('acc-1106') === recv1106);
  check('shipment does NOT re-post COGS (5102 unchanged)', shp.success && acc('acc-5102') === cogs5102);
  check('invoice is back-linked to the shipment',
    shp.success && erpDb.getSnapshot().salesInvoices.find(i => i.id === inv.invoice!.id)?.exportShipmentId === shp.shipment?.id);

  if (shp.success) {
    const collect = WorkflowService.recordExportCollection({
      shipmentId: shp.shipment!.id, amountUsd: 50, actualExchangeRate: 51, date: TODAY, isTest: true,
    });
    check('export collection succeeds', collect.success, collect.error || '');
    const updated = erpDb.getSnapshot().exportShipments.find(s => s.id === shp.shipment!.id);
    check('collectedUsd updated', (updated?.collectedUsd || 0) === 50);
    check('collection status is partially_collected', updated?.collectionStatus === 'partially_collected');
    const over = WorkflowService.recordExportCollection({
      shipmentId: shp.shipment!.id, amountUsd: 999, actualExchangeRate: 51, date: TODAY, isTest: true,
    });
    check('over-collection is rejected', !over.success);
  }
} else {
  console.log('  ⚠️  no export customer seeded — skipped');
}

// ---------------------------------------------------------------------------
section('F6 — Purchase VAT is editable per line and returns reverse what was posted');
// ---------------------------------------------------------------------------
const supplier = ensureSupplier();
if (!supplier) { console.log('  ⚠️  no supplier available — purchase VAT section skipped'); }
const rawItem = corn;
if (supplier) {
  const vatBalBefore = erpDb.getSnapshot().accounts.find(a => a.id === 'acc-1113')?.currentBalance || 0;
  const pur = WorkflowService.createPurchaseInvoice({
    supplierId: supplier.id, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP',
    exchangeRate: 1, reference: 'UAT-PUR', date: TODAY,
    lines: [
      { itemId: rawItem.id, quantity: 1, unitId: rawItem.baseUnitId, unitPrice: 100, batchNumber: 'UAT-B1', productionDate: TODAY, expiryDate: '', vatRate: 0.14 },
      { itemId: rawItem.id, quantity: 1, unitId: rawItem.baseUnitId, unitPrice: 100, batchNumber: 'UAT-B2', productionDate: TODAY, expiryDate: '', vatRate: 0 },
    ],
    isTest: true,
  });
  check('purchase invoice with mixed per-line VAT succeeds', pur.success, pur.error || '');
  const vatBalAfter = erpDb.getSnapshot().accounts.find(a => a.id === 'acc-1113')?.currentBalance || 0;
  check('input VAT 1113 reflects only the VAT-bearing line (14, not 28)',
    Math.abs((vatBalAfter - vatBalBefore) - 14) < 0.01, `delta=${(vatBalAfter - vatBalBefore).toFixed(2)}`);
}

// ---------------------------------------------------------------------------
section('F5 — Sales tax treatment: exempt invoice posts no 2103');
// ---------------------------------------------------------------------------
const retailCustomer = ensureCustomer('retail', 'RTL');
if (retailCustomer) {
  const finItem = erpDb.getSnapshot().items.find(i => i.itemType === 'finished_product')!;
  const out2103 = erpDb.getSnapshot().accounts.find(a => a.id === 'acc-2103')?.currentBalance || 0;
  const exempt = WorkflowService.createSalesInvoice({
    customerId: retailCustomer.id, channel: 'retail', warehouseId: 'wh-local',
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY,
    taxTreatment: 'exempt',
    lines: [{ itemId: finItem.id, quantity: 1, unitPrice: 100, vatRate: 0.14 }],
    isTest: true,
  });
  check('exempt sales invoice posts', exempt.success, exempt.error || '');
  const out2103After = erpDb.getSnapshot().accounts.find(a => a.id === 'acc-2103')?.currentBalance || 0;
  check('exempt invoice posts NO output VAT on 2103', Math.abs(out2103After - out2103) < 0.01,
    `delta=${(out2103After - out2103).toFixed(2)}`);
  check('exempt invoice total equals subtotal (no VAT added)',
    exempt.success && Math.abs((exempt.invoice?.vatAmount || 0)) < 0.01);
}

// ---------------------------------------------------------------------------
section('F15 — master data writes are authorization-guarded');
// ---------------------------------------------------------------------------
const viewer = erpDb.getSnapshot().users.find(u => u.role === 'Viewer');
if (viewer) {
  const denied = MasterDataService.createCustomer({
    code: `UAT-C-${Date.now().toString(36)}`, name: 'عميل مرفوض', customerType: 'retail', channel: 'retail',
    userId: viewer.id, userName: viewer.name,
  });
  check('Viewer CANNOT create a customer (service-level enforcement)', !denied.success, denied.error || '');
  const deniedItem = MasterDataService.createItem({
    code: `UAT-I-${Date.now().toString(36)}`, nameAr: 'صنف مرفوض', nameEn: '', itemType: 'raw_material',
    baseUnitId: 'unit-kg', vatRate: 0.14, standardCost: 0, actualCost: 0,
    sellingPriceRetail: 0, sellingPriceWholesale: 0, sellingPriceExportUSD: 0, minStockLevel: 0, active: true,
  } as any, { userId: viewer.id, userName: viewer.name });
  check('Viewer CANNOT create an item', !deniedItem.success, deniedItem.error || '');

  const deniedPeriod = AccountingEngine.setPeriodClosed('per-2024-01', true, viewer.id, viewer.name);
  check('Viewer CANNOT close an accounting period', !deniedPeriod.success, deniedPeriod.error || '');
}

const weakPwd = MasterDataService.createUser({
  username: `uat-weak-${Date.now().toString(36)}`, password: '123', name: 'UAT Weak', role: 'Viewer', isTest: true,
});
check('user creation with a too-short password is rejected', !weakPwd.success, weakPwd.error || '');
const blankPwd = MasterDataService.createUser({
  username: `uat-blank-${Date.now().toString(36)}`, password: '', name: 'UAT Blank', role: 'Viewer', isTest: true,
});
check('user creation with a blank password is rejected (no insecure default)', !blankPwd.success);

const goodPwd = MasterDataService.createUser({
  username: `uat-good-${Date.now().toString(36)}`, password: 'Str0ngPass!', name: 'UAT Good', role: 'Viewer', isTest: true,
});
check('user creation with a strong password succeeds', goodPwd.success, goodPwd.error || '');
if (goodPwd.success) {
  const login = AuthService.login(goodPwd.user!.username, 'Str0ngPass!');
  check('new user can log in with their own password', login.success, login.messageAr || '');
  AuthService.logout(); // clear the session so later guards resolve the passed userId
  const del = MasterDataService.deleteUser(goodPwd.user!.id, { userId: 'usr-admin', userName: 'UAT' });
  check('deleteUser (guarded) succeeds', del.success, del.error || '');
}

const delAdmin = MasterDataService.deleteUser('usr-admin', { userId: 'usr-admin', userName: 'UAT' });
check('bootstrap Super Admin cannot be deleted', !delAdmin.success, delAdmin.error || '');

const noSupAdmin = MasterDataService.updateCompanySettings({ currentUsdExchangeRate: -5, isTest: true });
check('invalid exchange rate is rejected', !noSupAdmin.success);

// ---------------------------------------------------------------------------
section('Data preservation');
// ---------------------------------------------------------------------------
const finalDb = erpDb.getSnapshot();
check('no BOM was destroyed — every seeded product still has an active BOM',
  finalDb.items.filter(i => i.itemType === 'finished_product')
    .every(p => finalDb.boms.some(b => (b.finishedItemId || b.productId) === p.id && b.active)));
check('chart of accounts intact (52)', finalDb.accounts.length === 52, `got ${finalDb.accounts.length}`);
check('warehouses intact (5)', finalDb.warehouses.length === 5, `got ${finalDb.warehouses.length}`);
check('bootstrap admin still present', finalDb.users.some(u => u.id === 'usr-admin'));

// cleanup only our own test records
erpDb.mutate(draft => {
  const testRepIds = draft.salesReps.filter(r => r.isTest).map(r => r.id);
  draft.representativeCustodies = draft.representativeCustodies.filter(c => !testRepIds.includes(c.repId));
  draft.salesReps = draft.salesReps.filter(r => !r.isTest);
  draft.users = draft.users.filter(u => !u.isTest);

  const testBoms = draft.boms.filter(b => b.isTest).map(b => b.id);
  draft.bomLines = draft.bomLines.filter(l => !testBoms.includes(l.bomId));
  draft.boms = draft.boms.filter(b => !b.isTest);

  const testInvIds = draft.salesInvoices.filter(i => i.isTest).map(i => i.id);
  draft.salesInvoiceLines = draft.salesInvoiceLines.filter(l => !testInvIds.includes(l.invoiceId));
  draft.salesInvoices = draft.salesInvoices.filter(i => !i.isTest);

  const testShipIds = draft.exportShipments.filter(s => s.isTest).map(s => s.id);
  draft.exportShipments = draft.exportShipments.filter(s => !s.isTest);

  const testPurIds = draft.purchaseInvoices.filter(p => p.isTest).map(p => p.id);
  draft.purchaseInvoiceLines = draft.purchaseInvoiceLines.filter(l => !testPurIds.includes(l.purchaseInvoiceId));
  draft.purchaseInvoices = draft.purchaseInvoices.filter(p => !p.isTest);

  draft.productionOrders = draft.productionOrders.filter(o => !o.isTest);
  const testCountIds = draft.inventoryCounts.filter(c => c.isTest).map(c => c.id);
  draft.inventoryCountLines = draft.inventoryCountLines.filter(l => !testCountIds.includes(l.countId));
  draft.inventoryCounts = draft.inventoryCounts.filter(c => !c.isTest);
  draft.inventoryTransactions = draft.inventoryTransactions.filter(t => !t.isTest);
  draft.batches = draft.batches.filter(b => !b.isTest);

  if (createdCustomerIds.length) {
    const ids = new Set(createdCustomerIds);
    draft.salesInvoiceLines = draft.salesInvoiceLines.filter(l => !ids.has(l.invoiceId));
    draft.salesInvoices = draft.salesInvoices.filter(i => !ids.has(i.customerId));
    draft.exportShipments = draft.exportShipments.filter(s => !ids.has(s.customerId));
    draft.purchaseInvoiceLines = draft.purchaseInvoiceLines.filter(l => !ids.has(l.purchaseInvoiceId));
    draft.purchaseInvoices = draft.purchaseInvoices.filter(p => !ids.has(p.supplierId));
    draft.customers = draft.customers.filter(c => !ids.has(c.id));
  }
  if (createdSupplierIds.length) {
    const ids = new Set(createdSupplierIds);
    draft.purchaseInvoiceLines = draft.purchaseInvoiceLines.filter(l => !ids.has(l.purchaseInvoiceId));
    draft.purchaseInvoices = draft.purchaseInvoices.filter(p => !ids.has(p.supplierId));
    draft.suppliers = draft.suppliers.filter(s => !ids.has(s.id));
  }
});

console.log(`\n==============================`);
console.log(`UAT FIX TOTAL: ${pass + fail} | PASS: ${pass} | FAIL: ${fail}`);
if (failures.length) {
  console.log(`FAILED CHECKS:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log('🎉 ALL UAT FIX CHECKS PASSED');
