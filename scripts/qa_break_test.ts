// ABDULLAH ERP — QA BREAKER SUITE, BATCH 1 (Phases 2, 3, 4, 13, 31)
//
// Run: `bun run qa1`
//
// NON-DESTRUCTIVE by construction:
//  * NEVER calls resetToClean(), NEVER clears storage, NEVER reseeds.
//  * Every master record it creates carries the prefix `TEST-QA-[id]`.
//  * Cleanup deletes ONLY what this run appended (tracked by pre-run array
//    lengths + explicit id sets + TEST-QA prefixes). Pre-existing balances,
//    documents, journals and master data are restored/left untouched.
//
// A ❌ line means a REAL DEFECT was FOUND (the system accepted or produced an
// unsafe state). A ✅ line means the attack was correctly blocked.
import { erpDb } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { InventoryEngine } from '../src/services/inventory';
import { WorkflowService } from '../src/services/workflows';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { AuthorizationService } from '../src/services/authorization';
import { AuthService } from '../src/services/auth';
import { AccountCategory, Item } from '../src/types/erp';
import { ensureTestBom, firstFinishedProductId } from './qa_test_bom';

const TODAY = new Date().toISOString().split('T')[0];
const RID = `QA1-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const snap = () => erpDb.getSnapshot();

// ---------------------------------------------------------------- harness
let pass = 0, fail = 0;
const defects: string[] = [];
function check(label: string, safe: boolean, detail = '') {
  if (safe) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; defects.push(`${label} :: ${detail}`); console.log(`  ❌ ${label} :: ${detail}`); }
}
const section = (t: string) => console.log(`\n=== ${t} ===`);

// Pre-run fingerprints for a surgical cleanup
const base = snap();
const BASE = {
  journalEntries: base.journalEntries.length,
  inventoryTransactions: base.inventoryTransactions.length,
  batches: base.batches.length,
  auditLogs: base.auditLogs.length,
  salesInvoices: base.salesInvoices.length,
  purchaseInvoices: base.purchaseInvoices.length,
  payments: base.payments.length,
  accounts: base.accounts.map(a => ({ id: a.id, balance: a.currentBalance })),
  customers: base.customers.map(c => ({ id: c.id, balance: c.currentBalance })),
  suppliers: base.suppliers.map(s => ({ id: s.id, balance: s.currentBalance })),
  items: base.items.length,
};
const createdItemIds = new Set<string>();
const createdCustomerIds = new Set<string>();
const createdSupplierIds = new Set<string>();
const createdUserIds = new Set<string>();

// ---------------------------------------------------------------- fixtures
const ADMIN = { userId: 'usr-admin', userName: 'QA', isTest: true } as const;

function mkItem(over: Partial<Item> & { nameAr: string }) {
  const code = `${PFX}-${over.nameAr.length}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const r = MasterDataService.createItem({
    code, nameEn: over.nameAr, itemType: 'finished_product', baseUnitId: 'unit-piece',
    purchaseUnitId: 'unit-piece', standardCost: 0, actualCost: 0,
    sellingPriceRetail: 0, sellingPriceWholesale: 0, sellingPriceExportUSD: 0,
    vatRate: 0.14, vatCategory: 'standard', trackBatch: false, trackExpiry: false,
    minStockLevel: 0, active: true, ...over,
  } as never, ADMIN as never);
  if (!r.item) throw new Error(`mkItem failed: ${r.error}`);
  createdItemIds.add(r.item.id);
  return r.item;
}
function mkCustomer(type: 'retail' | 'wholesale' | 'export' = 'retail') {
  const code = `${PFX}-CUST`;
  const r = MasterDataService.createCustomer({
    code, name: `عميل ${code}`, customerType: type, channel: type,
    currency: 'EGP', address: PFX, phone: '0100000000', taxNumber: 'T-QA',
    creditLimit: 0, openingBalance: 0, paymentTerms: '',
    isTest: true, userId: 'usr-admin', userName: 'QA',
  });
  if (!r.customer) throw new Error(`mkCustomer failed: ${r.error}`);
  createdCustomerIds.add(r.customer.id);
  return r.customer;
}
function mkSupplier() {
  const code = `${PFX}-SUP`;
  const r = MasterDataService.createSupplier({
    code, name: `مورد ${code}`, taxNumber: 'T-QA', currency: 'EGP',
    isTest: true, userId: 'usr-admin', userName: 'QA',
  });
  if (!r.supplier) throw new Error(`mkSupplier failed: ${r.error}`);
  createdSupplierIds.add(r.supplier.id);
  return r.supplier;
}
function stock(itemId: string, wh: string, qty: number, unitCost: number) {
  const r = InventoryEngine.recordMovement({
    itemId, warehouseId: wh, movementType: 'purchase_receipt',
    quantityIn: qty, quantityOut: 0, unitCost,
    documentType: `${PFX}-OPENING`, documentNumber: `${PFX}-OPEN`, date: TODAY, isTest: true,
  });
  if (!r.success) throw new Error(`stock failed: ${r.error}`);
  return r;
}
let refSeq = 0;
const purchase = (supplierId: string, lines: any[], extra: any = {}) =>
  WorkflowService.createPurchaseInvoice({
    supplierId, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP',
    exchangeRate: 1, reference: `${PFX}-REF-${++refSeq}`, date: TODAY, lines, ...ADMIN, ...extra,
  } as never);
const sale = (customerId: string, lines: any[], extra: any = {}) =>
  WorkflowService.createSalesInvoice({
    customerId, channel: 'retail', warehouseId: 'wh-local', paymentMethod: 'credit',
    currency: 'EGP', exchangeRate: 1, date: TODAY, lines, ...ADMIN, ...extra,
  } as never);

console.log('================================================================');
console.log(`🧨 QA BREAKER BATCH 1 — run ${RID}`);
console.log('================================================================');

const sup = mkSupplier();
const cust = mkCustomer('retail');
const fp = mkItem({ nameAr: `${PFX} منتج`, sellingPriceRetail: 100, standardCost: 40 });
stock(fp.id, 'wh-local', 500, 40);

// =========================================================================
section('PHASE 2 — MASTER DATA');
// =========================================================================
{
  const dupCode = MasterDataService.createItem({
    code: fp.code, nameAr: 'آخر', itemType: 'finished_product', baseUnitId: 'unit-piece',
    standardCost: 0, actualCost: 0, sellingPriceRetail: 0, sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0, vatRate: 0.14, trackBatch: false, trackExpiry: false,
    minStockLevel: 0, active: true, nameEn: 'other',
  } as never, ADMIN as never);
  check('P2 duplicate item CODE is rejected', !dupCode.success, `accepted: ${JSON.stringify(dupCode.item?.code)}`);

  const dupName = MasterDataService.createItem({
    code: `${PFX}-DUPNAME-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    nameAr: fp.nameAr, nameEn: 'dup', itemType: 'finished_product', baseUnitId: 'unit-piece',
    standardCost: 0, actualCost: 0, sellingPriceRetail: 0, sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0, vatRate: 0.14, trackBatch: false, trackExpiry: false,
    minStockLevel: 0, active: true,
  } as never, ADMIN as never);
  check('P2 duplicate item NAME is rejected', !dupName.success,
    `a second item took the Arabic name "${fp.nameAr}"`);
  if (dupName.item) createdItemIds.add(dupName.item.id);

  const blankName = { ...fp, nameAr: '   ' };
  const upBlank = MasterDataService.updateItem(blankName as Item, ADMIN as never);
  const stillNamed = snap().items.find(i => i.id === fp.id)?.nameAr?.trim();
  check('P2 item name cannot be blanked', !upBlank.success || !!stillNamed,
    `name is now "${stillNamed}" (success=${upBlank.success})`);
  if (!stillNamed) erpDb.mutate(d => { const it = d.items.find(i => i.id === fp.id); if (it) it.nameAr = `${PFX} منتج`; });

  const uomSwap = MasterDataService.updateItem({ ...snap().items.find(i => i.id === fp.id)!, baseUnitId: 'unit-kg' } as Item, ADMIN as never);
  const unitNow = snap().items.find(i => i.id === fp.id)?.baseUnitId;
  check('P2 base UOM cannot be changed after the item has stock/history', !uomSwap.success || unitNow === 'unit-piece',
    `item with 500 PCS on hand is now denominated in ${unitNow}`);
  if (unitNow !== 'unit-piece') erpDb.mutate(d => { const it = d.items.find(i => i.id === fp.id); if (it) it.baseUnitId = 'unit-piece'; });

  // Inactive master data must not transact
  MasterDataService.setCustomerActive(cust.id, false, ADMIN as never);
  const soldToInactive = sale(cust.id, [{ itemId: fp.id, quantity: 1, unitPrice: 100, vatRate: 0.14 }]);
  check('P2 an INACTIVE customer cannot be invoiced', !soldToInactive.success,
    `invoice ${soldToInactive.invoice?.invoiceNumber} was created for a deactivated customer`);
  MasterDataService.setCustomerActive(cust.id, true, ADMIN as never);

  MasterDataService.setSupplierActive(sup.id, false, ADMIN as never);
  const boughtFromInactive = purchase(sup.id, [{
    itemId: fp.id, quantity: 1, unitId: 'unit-piece', unitPrice: 10, batchNumber: `${PFX}-B1`,
    productionDate: TODAY, expiryDate: '2027-01-01', vatRate: 0.14,
  }]);
  check('P2 an INACTIVE supplier cannot be invoiced', !boughtFromInactive.success,
    `purchase invoice ${boughtFromInactive.invoice?.invoiceNumber} was created for a deactivated supplier`);
  MasterDataService.setSupplierActive(sup.id, true, ADMIN as never);

  MasterDataService.setItemActive(fp.id, false, ADMIN as never);
  const soldInactiveItem = sale(cust.id, [{ itemId: fp.id, quantity: 1, unitPrice: 100, vatRate: 0.14 }]);
  check('P2 an INACTIVE item cannot be sold', !soldInactiveItem.success,
    `invoice ${soldInactiveItem.invoice?.invoiceNumber} sold a deactivated item`);
  MasterDataService.setItemActive(fp.id, true, ADMIN as never);

  // Account mapping category safety
  const cashAcc = snap().accounts.find(a => a.code === '1101')!;
  const badMap = MasterDataService.updateAccountMapping('sales_retail_revenue', cashAcc.id, ADMIN as never);
  check('P2 account mapping rejects a category-incompatible account', !badMap.success,
    `sales_retail_revenue now points at ${cashAcc.code} (${cashAcc.category})`);
  if (badMap.success) MasterDataService.updateAccountMapping('sales_retail_revenue', 'acc-4101', ADMIN as never);

  const headerAcc = snap().accounts.find(a => a.isHeader)!;
  check('P2 account mapping rejects header accounts', !MasterDataService.updateAccountMapping('sales_retail_revenue', headerAcc.id, ADMIN as never).success);
  check('P2 account mapping rejects unknown accounts', !MasterDataService.updateAccountMapping('sales_retail_revenue', 'acc-does-not-exist', ADMIN as never).success);
  check('P2 account mapping rejects unknown mapping keys', !MasterDataService.updateAccountMapping('not_a_key', 'acc-1101', ADMIN as never).success);

  const dupCustCode = MasterDataService.createCustomer({
    code: cust.code.toLowerCase(), name: 'اسم مختلف', customerType: 'retail', channel: 'retail',
    isTest: true, userId: 'usr-admin', userName: 'QA',
  });
  check('P2 duplicate customer code (case-insensitive) is rejected', !dupCustCode.success, 'a second customer took the same code');
  if (dupCustCode.customer) createdCustomerIds.add(dupCustCode.customer.id);
}

// =========================================================================
section('PHASE 32 — RBAC / privilege escalation');
// =========================================================================
{
  AuthService.logout();
  const ghost = `${PFX}-GHOST`;
  const victim = MasterDataService.createUser({
    username: `${PFX.toLowerCase()}-victim`, password: 'VictimPass1!', name: 'QA Victim',
    role: 'Viewer', isTest: true, userId: 'usr-admin', userName: 'QA',
  });
  if (victim.user) createdUserIds.add(victim.user.id);
  const ghostPerms = MasterDataService.updateUserPermissions({
    userId: victim.user!.id, permissions: { users: ['edit'], sales: ['create', 'edit', 'delete'] },
    options: { userId: ghost, userName: 'Ghost Actor' },
  });
  check('P32 permissions cannot be granted by an UNKNOWN actor id', !ghostPerms.success,
    `user "${victim.user?.username}" was granted ${JSON.stringify(snap().users.find(u => u.id === victim.user?.id)?.permissions)} by a non-existent user`);
  if (ghostPerms.success) MasterDataService.resetUserPermissions(victim.user!.id, { userId: 'usr-admin' });

  // Self elevation: a non-admin holding users:edit must not be able to promote itself
  AuthService.login('admin', '12345');
  MasterDataService.updateUserPermissions({
    userId: victim.user!.id, permissions: { users: ['edit'] },
    options: { userId: 'usr-admin', userName: 'admin' },
  });
  AuthService.logout();
  AuthService.login(victim.user!.username, 'VictimPass1!');
  const elevate = MasterDataService.updateOwnProfile({
    userId: victim.user!.id, name: 'QA Victim', username: victim.user!.username,
    requestedRole: 'Super Admin',
  });
  const roleNow = snap().users.find(u => u.id === victim.user!.id)?.role;
  check('P32 a users:edit holder CANNOT self-elevate to Super Admin', roleNow !== 'Super Admin',
    `role is now "${roleNow}" (call success=${elevate.success})`);
  AuthService.logout();
}

// =========================================================================
section('PHASE 3 — UOM');
// =========================================================================
{
  const units = snap().units;
  const pcs = units.find(u => u.id === 'unit-piece');
  const kg = units.find(u => u.id === 'unit-kg');
  const roll = units.find(u => u.id === 'unit-roll');
  check('P3 PCS / KG / ROLL are distinct units',
    !!pcs && !!kg && !!roll && new Set([pcs.id, kg.id, roll.id]).size === 3 && pcs.code !== kg.code);

  const chip = snap().items.find(i => i.id === 'item-raw-chip')!;
  const frac = purchase(sup.id, [{
    itemId: chip.id, quantity: 0.375, unitId: 'unit-kg', unitPrice: 100, batchNumber: `${PFX}-KG`,
    productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0.14,
  }]);
  check('P3 fractional KG purchase is accepted', frac.success, frac.error || 'rejected fractional KG');
  if (frac.success) check('P3 fractional KG is stored exactly (0.375 KG)',
    Math.abs(InventoryEngine.getItemBalance(chip.id, 'wh-raw') - 0.375) < 1e-9,
    `balance=${InventoryEngine.getItemBalance(chip.id, 'wh-raw')}`);

  // BUSINESS-RULE QUESTION (not auto-fixed): the canonical kraft BOM line is
// 66.667 PCS per 1000 pieces, so fractional PCS quantities exist by design.
// Whether a PURCHASE/ISSUE may carry a fraction of a piece is a business
// decision — no integrality rule is invented here.
const halfPcs = purchase(sup.id, [{
    itemId: fp.id, quantity: 0.5, unitId: 'unit-piece', unitPrice: 100, batchNumber: `${PFX}-PCS`,
    productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0.14,
  }]);
  console.log(`  ℹ️  BUSINESS DECISION REQUIRED — fractional PCS (0.5) was ${halfPcs.success ? 'accepted' : 'rejected'}; canonical kraft BOM uses 66.667 PCS/1000, so no integrality rule is imposed`);

  const huge = purchase(sup.id, [{
    itemId: chip.id, quantity: 1e12, unitId: 'unit-kg', unitPrice: 0.001, batchNumber: `${PFX}-HUGE`,
    productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0.14,
  }]);
  check('P3 absurd quantities (1e12 KG) are rejected or bounded', !huge.success,
    `1,000,000,000,000 KG booked on invoice ${huge.invoice?.invoiceNumber}`);

  // BOM linearity
  const bom = ensureTestBom(firstFinishedProductId());
  const r1000 = ManufacturingEngine.calculateBomRequirements(bom.id, 1000);
  const r500 = ManufacturingEngine.calculateBomRequirements(bom.id, 500);
  const r1 = ManufacturingEngine.calculateBomRequirements(bom.id, 1);
  const linear = r1000.length > 0 && r500.length === r1000.length && r1.length === r1000.length &&
    r1000.every((l, i) => Math.abs(r500[i].requiredQuantity * 2 - l.requiredQuantity) < 0.01) &&
    r1000.every((l, i) => Math.abs(r1[i].requiredQuantity * 1000 - l.requiredQuantity) < 0.5);
  check('P3 BOM requirements scale linearly (1000 / 500 / 1 PCS)', linear,
    r1000.slice(0, 3).map((l, i) => `${l.materialItemId}: ${l.requiredQuantity} / ${r500[i]?.requiredQuantity} / ${r1[i]?.requiredQuantity}`).join(' | '));
}

// =========================================================================
section('PHASE 4 / 31 — PURCHASE-TO-PAY error handling');
// =========================================================================
{
  const before = snap();
  const invBefore = before.purchaseInvoices.length;
  const jvBefore = before.journalEntries.length;
  // NOTE: snap() hands back live draft references — capture PRIMITIVES, not objects.
  const acc = (code: string) => snap().accounts.find(a => a.code === code)?.currentBalance || 0;
  const apBeforeN = acc('2101'), inv1108Before = acc('1108'), vatBefore = acc('1113');

  const ghostItem = purchase(sup.id, [{
    itemId: 'item-does-not-exist-qa', quantity: 10, unitId: 'unit-kg', unitPrice: 50,
    batchNumber: `${PFX}-GHOST`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0.14,
  }]);
  const after = snap();
  const ap = acc('2101');
  check('P4 a purchase line with an UNKNOWN item is rejected atomically',
    !ghostItem.success && after.purchaseInvoices.length === invBefore && after.journalEntries.length === jvBefore &&
    Math.abs(ap - apBeforeN) < 0.01 && Math.abs(acc('1108') - inv1108Before) < 0.01,
    `success=${ghostItem.success} invoices+${after.purchaseInvoices.length - invBefore} journals+${after.journalEntries.length - jvBefore} APΔ=${(ap - apBeforeN).toFixed(2)} inv1108Δ=${(acc('1108') - inv1108Before).toFixed(2)} vatΔ=${(acc('1113') - vatBefore).toFixed(2)} — no stock was received`);

  const negOnly = purchase(sup.id, [{
    itemId: fp.id, quantity: -5, unitId: 'unit-piece', unitPrice: 10, batchNumber: `${PFX}-N1`,
    productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0.14,
  }]);
  check('P4 a single negative-quantity line is rejected', !negOnly.success, `invoice ${negOnly.invoice?.invoiceNumber} created`);

  const stockBefore = InventoryEngine.getItemBalance(fp.id, 'wh-raw');
  const mixed = purchase(sup.id, [
    { itemId: fp.id, quantity: -5, unitId: 'unit-piece', unitPrice: 100, batchNumber: `${PFX}-M1`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 },
    { itemId: fp.id, quantity: 6, unitId: 'unit-piece', unitPrice: 100, batchNumber: `${PFX}-M2`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 },
  ]);
  const stockAfter = InventoryEngine.getItemBalance(fp.id, 'wh-raw');
  check('P4 a NET-POSITIVE invoice mixing negative and positive quantities is rejected',
    !mixed.success,
    `invoice ${mixed.invoice?.invoiceNumber} booked: negative line ignored, stock ${stockBefore}→${stockAfter}, AP debited while only ${stockAfter - stockBefore} units arrived`);

  const vat150 = purchase(sup.id, [{
    itemId: fp.id, quantity: 1, unitId: 'unit-piece', unitPrice: 100, batchNumber: `${PFX}-V150`,
    productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 1.5,
  }]);
  check('P4 an out-of-range VAT rate (150%) is rejected', !vat150.success,
    `invoice ${vat150.invoice?.invoiceNumber} booked input VAT at 150%`);

  const badDates = purchase(sup.id, [{
    itemId: fp.id, quantity: 1, unitId: 'unit-piece', unitPrice: 100, batchNumber: `${PFX}-DATES`,
    productionDate: '2027-06-01', expiryDate: '2020-01-01', vatRate: 0.14,
  }]);
  check('P4 an expiry date BEFORE the production date is rejected', !badDates.success,
    `invoice ${badDates.invoice?.invoiceNumber} created an already-expired batch`);

  const dupLines = [{
    itemId: fp.id, quantity: 1, unitId: 'unit-piece', unitPrice: 100,
    batchNumber: `${PFX}-DUP`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0.14,
  }];
  const s1 = InventoryEngine.getItemBalance(fp.id, 'wh-raw');
  const dupRef = `${PFX}-DUPREF`;
  const d1 = purchase(sup.id, dupLines, { reference: dupRef });
  const d2 = purchase(sup.id, dupLines, { reference: dupRef });
  const s2 = InventoryEngine.getItemBalance(fp.id, 'wh-raw');
  check('P4 a duplicate submission (double-click) is prevented or flagged',
    !(d1.success && d2.success && Math.abs(s2 - s1 - 2) < 1e-9),
    `two identical invoices ${d1.invoice?.invoiceNumber}/${d2.invoice?.invoiceNumber} both received stock (${s1}→${s2})`);
  check('P4 the SAME supplier document number cannot be booked twice',
    !(d1.success && d2.success), `both ${d1.invoice?.invoiceNumber} and ${d2.invoice?.invoiceNumber} were posted for reference ${dupRef}`);

  const scrapWh = purchase(sup.id, [{
    itemId: fp.id, quantity: 1, unitId: 'unit-piece', unitPrice: 10, batchNumber: `${PFX}-SCRAPWH`,
    productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0.14,
  }], { warehouseId: 'wh-scrap' });
  check('P4 receiving stock into the SCRAP warehouse is blocked or flagged', !scrapWh.success,
    `goods were received into WH-05 (scrap) via invoice ${scrapWh.invoice?.invoiceNumber}`);
}

// =========================================================================
section('PHASE 13 / 31 — SALES error handling');
// =========================================================================
{
  const mixedSale = sale(cust.id, [
    { itemId: fp.id, quantity: -3, unitPrice: 100, vatRate: 0 },
    { itemId: fp.id, quantity: 5, unitPrice: 100, vatRate: 0 },
  ]);
  check('P13 a NET-POSITIVE invoice mixing negative and positive quantities is rejected', !mixedSale.success,
    `invoice ${mixedSale.invoice?.invoiceNumber} booked negative revenue/quantity`);

  const disc150 = sale(cust.id, [{ itemId: fp.id, quantity: 2, unitPrice: 100, discount: 150, vatRate: 0.14 }]);
  check('P13 a discount above 100% is rejected', !disc150.success,
    `invoice ${disc150.invoice?.invoiceNumber} booked a >100% discount`);

  const zeroPrice = sale(cust.id, [{ itemId: fp.id, quantity: 2, unitPrice: 0, vatRate: 0 }]);
  check('P13 a zero-price sale that consumes stock is rejected', !zeroPrice.success,
    `invoice ${zeroPrice.invoice?.invoiceNumber} issued stock with no revenue journal`);

  const negFree = sale(cust.id, [{ itemId: fp.id, quantity: 5, freeQuantity: -2, unitPrice: 100, vatRate: 0 }]);
  check('P13 a NEGATIVE free/bonus quantity is rejected', !negFree.success,
    `invoice ${negFree.invoice?.invoiceNumber} accepted freeQuantity = -2`);

  const overFree = sale(cust.id, [{ itemId: fp.id, quantity: 1000, freeQuantity: 1000, unitPrice: 100, vatRate: 0 }]);
  check('P13 free goods beyond available stock are rejected', !overFree.success,
    `invoice ${overFree.invoice?.invoiceNumber} issued 2000 units of free goods`);
}

// =========================================================================
section('CLEANUP — remove ONLY records this run appended');
// =========================================================================
{
  const removed: string[] = [];
  erpDb.mutate(draft => {
    // Master data created by this run
    draft.items = draft.items.filter(i => !createdItemIds.has(i.id));
    draft.customers = draft.customers.filter(c => !createdCustomerIds.has(c.id));
    draft.suppliers = draft.suppliers.filter(s => !createdSupplierIds.has(s.id));
    draft.users = draft.users.filter(u => !createdUserIds.has(u.id));

    // Everything appended after the pre-run fingerprints
    const addedJv = draft.journalEntries.slice(BASE.journalEntries);
    const addedJvIds = new Set(addedJv.map(j => j.id));
    const srcIds = new Set(addedJv.map(j => j.sourceDocumentId).filter(Boolean) as string[]);
    addedJv.forEach(() => removed.push('journalEntry'));
    draft.journalEntries = draft.journalEntries.slice(0, BASE.journalEntries);

    const addedPi = draft.purchaseInvoices.slice(BASE.purchaseInvoices);
    const piIds = new Set([...addedPi.map(p => p.id), ...srcIds].filter(Boolean));
    addedPi.forEach(() => removed.push('purchaseInvoice'));
    draft.purchaseInvoices = draft.purchaseInvoices.slice(0, BASE.purchaseInvoices);
    draft.purchaseInvoiceLines = draft.purchaseInvoiceLines.filter(l => !piIds.has(l.purchaseInvoiceId));

    const addedSi = draft.salesInvoices.slice(BASE.salesInvoices);
    const siIds = new Set(addedSi.map(i => i.id));
    addedSi.forEach(() => removed.push('salesInvoice'));
    draft.salesInvoices = draft.salesInvoices.slice(0, BASE.salesInvoices);
    draft.salesInvoiceLines = draft.salesInvoiceLines.filter(l => !siIds.has(l.invoiceId));

    draft.payments = draft.payments.slice(0, BASE.payments);

    const addedTx = draft.inventoryTransactions.slice(BASE.inventoryTransactions);
    const txDocNums = new Set(addedTx.map(t => `${t.documentNumber || ''}`));
    addedTx.forEach(() => removed.push('inventoryTransaction'));
    draft.inventoryTransactions = draft.inventoryTransactions.slice(0, BASE.inventoryTransactions);

    // Batches touched by this run: only those whose TEST-QA batch numbers remain
    draft.batches = draft.batches.filter(b => {
      const touched = b.batchNumber.includes(PFX) || b.itemId === fp.id;
      if (!touched) return true;
      const remaining = draft.inventoryTransactions.filter(t => t.itemId === b.itemId && t.warehouseId === b.warehouseId)
        .length;
      // keep only batches that still carry a balance backed by no TEST-QA document
      const ourDocs = [...txDocNums].some(d => d.includes(PFX));
      return !(ourDocs && !remaining && b.quantity <= 0);
    });

    draft.auditLogs = draft.auditLogs.slice(0, BASE.auditLogs);
  });

  // Restore balances touched by this run
  erpDb.mutate(draft => {
    BASE.accounts.forEach(b => { const a = draft.accounts.find(x => x.id === b.id); if (a) a.currentBalance = b.balance; });
    BASE.customers.forEach(b => { const c = draft.customers.find(x => x.id === b.id); if (c) c.currentBalance = b.balance; });
    BASE.suppliers.forEach(b => { const s = draft.suppliers.find(x => x.id === b.id); if (s) s.currentBalance = b.balance; });
  });

  const after = snap();
  console.log(`  removed: ${removed.length} document(s); items -${BASE.items - after.items.length}`);
  check('cleanup left no TEST-QA master record behind',
    !after.items.some(i => i.code.includes(PFX)) &&
    !after.customers.some(c => c.code.includes(PFX)) &&
    !after.suppliers.some(s => s.code.includes(PFX)) &&
    !after.users.some(u => u.username.includes(PFX.toLowerCase())));
  check('cleanup restored every account balance',
    BASE.accounts.every(b => Math.abs((after.accounts.find(a => a.id === b.id)?.currentBalance || 0) - b.balance) < 0.01));
  check('cleanup restored pre-existing journal/invoice counts',
    after.journalEntries.length === BASE.journalEntries &&
    after.salesInvoices.length === BASE.salesInvoices &&
    after.purchaseInvoices.length === BASE.purchaseInvoices);
}

console.log('\n==============================');
console.log(`QA BATCH 1 (${RID}) — PROBES: ${pass + fail} | SAFE: ${pass} | DEFECTS FOUND: ${fail}`);
if (defects.length) {
  console.log('DEFECTS FOUND:');
  defects.forEach(d => console.log('  - ' + d));
}
console.log('==============================');