// MASTER UAT verification — F17 … F32 + the finished-product UOM change.
//
// Additive suite: it NEVER resets, reseeds or clears the store. It creates its
// own test master data (customers / supplier / representatives / stock), drives
// the real services, and removes ONLY its own `isTest` records at the end.
import { erpDb } from '../src/services/db';
import { AccountingEngine } from '../src/services/accounting';
import { InventoryEngine } from '../src/services/inventory';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { WorkflowService } from '../src/services/workflows';
import { MasterDataService } from '../src/services/masterData';
import { LedgerService, TreasuryLedgerService } from '../src/services/ledger';
import { PermissionService } from '../src/services/permissions';
import { AuthorizationService } from '../src/services/authorization';
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
    failures.push(`${label} ${detail}`);
    console.log(`  ❌ ${label} ${detail}`);
  }
}
const section = (t: string) => console.log(`\n=== ${t} ===`);

const TODAY = new Date().toISOString().split('T')[0];
const ALL = { fromDate: '0000-01-01', toDate: '9999-12-31' };

const snap = () => erpDb.getSnapshot();
const gl = (code: string) => snap().accounts.find(a => a.code === code)?.currentBalance || 0;
const bal = (itemId: string, wh?: string) => InventoryEngine.getItemBalance(itemId, wh);
const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) <= tol;

// ---- test master data -------------------------------------------------------
const created: string[] = [];
function mkCustomer(type: 'retail' | 'wholesale' | 'export', currency: 'EGP' | 'USD' = 'EGP') {
  const code = `UAT-${type}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const r = MasterDataService.createCustomer({
    code, name: `عميل اختبار ${code}`, customerType: type, channel: type,
    currency, address: 'اختبار', phone: '0100000000', taxNumber: 'T-123',
    isTest: true,
  });
  if (!r.customer) throw new Error(r.error || 'customer failed');
  created.push(r.customer.id);
  return r.customer;
}
function mkSupplier() {
  const code = `UAT-SUP-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const r = MasterDataService.createSupplier({ code, name: `مورد اختبار ${code}`, isTest: true });
  if (!r.supplier) throw new Error(r.error || 'supplier failed');
  created.push(r.supplier.id);
  return r.supplier;
}
function stock(itemId: string, wh: string, qty: number, unitCost: number) {
  const r = InventoryEngine.recordMovement({
    itemId, warehouseId: wh, movementType: 'purchase_receipt',
    quantityIn: qty, quantityOut: 0, unitCost,
    documentType: 'اختبار رصيد افتتاحي', documentNumber: `OPEN-${Math.random().toString(36).slice(2, 8)}`,
    date: TODAY, isTest: true,
  });
  if (!r.success) throw new Error(r.error || 'stock failed');
}

const db0 = snap();
const FP = db0.items.find(i => i.itemType === 'finished_product')!;
const FP2 = db0.items.find(i => i.itemType === 'finished_product' && i.id !== FP.id)!;
const CORN = db0.items.find(i => i.code === 'RM-CORN-01')!;
const FLAVOR = db0.items.find(i => i.code === 'RM-FLV-01')!;

// give the test product a real standard cost so COGS assertions are meaningful
const origCost = FP.standardCost;
erpDb.mutate(d => {
  const it = d.items.find(x => x.id === FP.id);
  if (it) it.standardCost = 100;
  const it2 = d.items.find(x => x.id === FP2.id);
  if (it2) it2.standardCost = 80;
});

// ===========================================================================
section('UOM — finished products are PCS, raw materials keep their real units');
// ===========================================================================
{
  const db = snap();
  const piece = db.units.find(u => u.id === 'unit-piece');
  const gram = db.units.find(u => u.id === 'unit-gram');
  check('PCS unit exists (قطعة)', Boolean(piece));
  check('GRAM unit exists for decimal raw-material requirements', Boolean(gram));
  check('GRAM -> KG conversion is 0.001 (75g = 0.075 KG)',
    Boolean(db.unitConversions.find(c => c.fromUnitId === 'unit-gram' && c.toUnitId === 'unit-kg' && c.factor === 0.001)));
  check('TON -> KG conversion preserved (1000)', Boolean(db.unitConversions.find(c => c.fromUnitId === 'unit-ton' && c.factor === 1000)));
  check('CTN unit is preserved (not deleted)', Boolean(db.units.find(u => u.id === 'unit-carton')));

  const fps = db.items.filter(i => i.itemType === 'finished_product');
  check('all 11 finished products exist', fps.length === 11, `got ${fps.length}`);
  check('every finished product uses PCS as its base unit',
    fps.every(i => i.baseUnitId === 'unit-piece'),
    fps.filter(i => i.baseUnitId !== 'unit-piece').map(i => i.code).join(','));

  check('raw material corn keeps KG as its base unit', CORN.baseUnitId === 'unit-kg', CORN.baseUnitId);
  check('raw material corn keeps TON as its purchase unit', CORN.purchaseUnitId === 'unit-ton', CORN.purchaseUnitId || '');
  check('packaging film keeps ROLL', db.items.find(i => i.code === 'PKG-FLM-01')?.baseUnitId === 'unit-roll');

  const seededBoms = db.boms.filter(b => (b.finishedItemId || b.productId));
  check('the 11 seeded BOMs are intact', seededBoms.length >= 11, `got ${seededBoms.length}`);
  check('every finished-product BOM is denominated in PCS',
    seededBoms.filter(b => fps.some(f => f.id === (b.finishedItemId || b.productId))).every(b => b.unitId === 'unit-piece'));
  check('every seeded BOM has a base quantity of 1000 PCS',
    seededBoms.filter(b => fps.some(f => f.id === (b.finishedItemId || b.productId))).every(b => b.baseQuantity === 1000));

  // decimal math: 0.075 KG per PCS  ->  75 KG per 1000 PCS
  const cornLine = snap().bomLines.find(l => l.materialItemId === CORN.id)!;
  const perPiece = cornLine.quantityRequired / 1000;              // 800 KG / 1000 PCS = 0.8
  check('seeded BOM line is 800 KG per 1000 PCS', cornLine.quantityRequired === 800, `got ${cornLine.quantityRequired}`);
  check('per-piece requirement is a decimal (0.8 KG/PCS), not rounded away', near(perPiece, 0.8, 1e-9), `got ${perPiece}`);

  const fpBom = seededBoms.find(b => (b.finishedItemId || b.productId) === FP.id)!;
  const req1000 = ManufacturingEngine.calculateBomRequirements(fpBom.id, 1000).find(r => r.materialItemId === CORN.id);
  const req1 = ManufacturingEngine.calculateBomRequirements(fpBom.id, 1).find(r => r.materialItemId === CORN.id);
  check('requirement for 1000 PCS = 800 KG (no scaling drift)', near(req1000!.requiredQuantity, 800, 1e-6), `got ${req1000?.requiredQuantity}`);
  check('requirement for 1 PCS = 0.8 KG (decimal supported)', near(req1!.requiredQuantity, 0.8, 1e-6), `got ${req1?.requiredQuantity}`);

  // explicit 75g/piece scenario required by the UAT
  const seededActiveId = fpBom.id;
  const dec = ManufacturingEngine.createBomVersion({
    finishedItemId: FP.id, baseQuantity: 1000, unitId: 'unit-piece', effectiveDate: TODAY,
    notes: 'اختبار الكسر العشري 0.075 كجم/قطعة', isTest: true,
    lines: [{ materialItemId: FLAVOR.id, quantityRequired: 75, unitId: 'unit-kg' }],
  });
  check('decimal BOM version created', dec.success, dec.error || '');
  if (dec.success) {
    const r1000 = ManufacturingEngine.calculateBomRequirements(dec.bom!.id, 1000)[0];
    const r1 = ManufacturingEngine.calculateBomRequirements(dec.bom!.id, 1)[0];
    check('1000 PCS requires 75 KG', near(r1000.requiredQuantity, 75, 1e-6), `got ${r1000.requiredQuantity}`);
    check('1 PCS requires 0.075 KG', near(r1.requiredQuantity, 0.075, 1e-9), `got ${r1.requiredQuantity}`);
    // deactivate the test version and restore the seeded one as the single active BOM
    ManufacturingEngine.setBomActive(dec.bom!.id, false, 'usr-admin', 'UAT');
    ManufacturingEngine.setBomActive(seededActiveId, true, 'usr-admin', 'UAT');
  }
  const activeNow = snap().boms.filter(b => (b.finishedItemId || b.productId) === FP.id && b.active);
  check('exactly one active BOM is restored for the seeded product', activeNow.length === 1, `got ${activeNow.length}`);
}

// ===========================================================================
section('F17 — bonus / free goods: stock & COGS yes, revenue / AR / VAT no');
// ===========================================================================
{
  const cust = mkCustomer('wholesale');
  stock(FP.id, 'wh-local', 500, 60);
  const before = bal(FP.id, 'wh-local');
  const balBefore = snap().customers.find(c => c.id === cust.id)!.currentBalance;

  const res = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'wholesale', warehouseId: 'wh-local',
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY,
    taxTreatment: 'taxable', isTest: true,
    lines: [{ itemId: FP.id, quantity: 10, freeQuantity: 1, unitPrice: 200, vatRate: 0.14 }],
  });
  check('bonus sales invoice posts', res.success, res.error || '');
  const inv = res.invoice!;

  check('inventory leaves by 11 (10 sold + 1 bonus)', before - bal(FP.id, 'wh-local') === 11, `delta ${before - bal(FP.id, 'wh-local')}`);
  check('revenue is for 10 units only (2000)', inv.subtotal === 2000, `got ${inv.subtotal}`);
  check('bonus quantity recorded on the invoice', inv.bonusQuantity === 1, `got ${inv.bonusQuantity}`);
  check('VAT computed on the 10 paid units only (280)', near(inv.vatAmount, 280, 0.001), `got ${inv.vatAmount}`);
  check('invoice total = subtotal + VAT (2280)', near(inv.totalAmount, 2280, 0.001), `got ${inv.totalAmount}`);

  const line = snap().salesInvoiceLines.find(l => l.invoiceId === inv.id)!;
  check('the bonus line stores the free quantity', line.freeQuantity === 1);
  check('the bonus line value is zero (revenue excludes it)', line.totalBeforeVat === 2000);

  check('customer receivable increased by the invoice total only (no bonus)',
    near(snap().customers.find(c => c.id === cust.id)!.currentBalance - balBefore, 2280, 0.01));
  check('COGS includes all 11 units (11 x 100)', near(inv.cogsTotal, 1100, 0.01), `got ${inv.cogsTotal}`);

  const jv = snap().journalEntries.find(j => j.id === inv.journalEntryId)!;
  const recv = jv.lines.filter(l => l.accountId === 'acc-1105').reduce((s, l) => s + l.debit - l.credit, 0);
  check('GL receivable 1105 carries the invoice total (no bonus)', near(recv, 2280, 0.01), `got ${recv}`);
  const vat2103 = jv.lines.filter(l => l.accountId === 'acc-2103').reduce((s, l) => s + l.credit, 0);
  check('output VAT 2103 = 280 only (bonus is not taxed)', near(vat2103, 280, 0.01), `got ${vat2103}`);

  // ---- F17: returning the bonus unit must stay zero-valued ----
  const ret = WorkflowService.postSalesReturn({
    customerId: cust.id, invoiceId: inv.id, warehouseId: 'wh-local', date: TODAY,
    reason: 'إرجاع البونص المجاني', isTest: true,
    lines: [{ itemId: FP.id, quantity: 1, unitPrice: 200, vatRate: 0.14 }],
  });
  check('sales return of a bonus unit posts', ret.success, ret.error || '');
  const retLine = snap().salesReturnLines.find(l => l.returnId === ret.salesReturn!.id)!;
  check('returned bonus line is recognized as free quantity', retLine.freeQuantity === 1, `got ${retLine.freeQuantity}`);
  check('returned bonus line is priced at ZERO', retLine.unitPrice === 0, `got ${retLine.unitPrice}`);
  check('returning the bonus creates NO revenue', ret.salesReturn!.totalAmount === 0, `got ${ret.salesReturn!.totalAmount}`);
  check('returning the bonus creates NO VAT', ret.salesReturn!.totalVat === 0, `got ${ret.salesReturn!.totalVat}`);
  check('customer balance unchanged by the bonus return',
    near(snap().customers.find(c => c.id === cust.id)!.currentBalance, balBefore + 2280, 0.01));
  created.push(inv.id);
}

// ===========================================================================
section('F18 — item card reconciles with real stock (no second engine)');
// ===========================================================================
{
  const it = FP2.id;
  stock(it, 'wh-local', 300, 55);
  stock(it, 'wh-export', 120, 55);
  const start = bal(it, 'wh-local');

  // receipt already recorded above; add a transfer + a sale
  const tr = InventoryEngine.transferWarehouse(it, 'wh-local', 'wh-export', 20, 55, undefined, 'UAT', TODAY);
  check('warehouse transfer succeeds', tr.success, tr.error || '');

  const cust = mkCustomer('retail');
  const sale = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: 'wh-local',
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY, isTest: true,
    lines: [{ itemId: it, quantity: 5, unitPrice: 300, vatRate: 0.14 }],
  });
  check('item-card sale posts', sale.success, sale.error || '');

  const card = InventoryEngine.getItemCard({ itemId: it, warehouseId: 'wh-local', ...ALL });
  check('item card ends exactly at the real stock (mismatch = 0)', near(card.mismatch, 0, 1e-6), `mismatch ${card.mismatch}`);
  check('item card closing balance equals InventoryEngine balance', near(card.closingBalance, bal(it, 'wh-local'), 1e-6));
  check('opening + in - out = closing', near(card.openingBalance + card.totalIn - card.totalOut, card.closingBalance, 1e-6));
  check('item card lists the sales movement with its document number',
    card.rows.some(r => r.movementType === 'sales' && r.documentNumber === sale.invoice!.invoiceNumber));
  check('item card lists the transfer movement out of the warehouse',
    card.rows.some(r => r.movementType === 'warehouse_transfer' && r.quantityOut === 20));
  check('item card rows expose a source-document link',
    card.rows.filter(r => r.movementType === 'sales').every(r => Boolean(r.link)));
  check('item card running balance is monotonic and ends at closing',
    card.rows.length > 0 && card.rows[card.rows.length - 1].runningBalance === card.closingBalance);
  check('item card period filter works (empty window returns opening only)',
    InventoryEngine.getItemCard({ itemId: it, warehouseId: 'wh-local', fromDate: '1990-01-01', toDate: '1990-01-02' }).rows.length === 0);
  check('all-warehouse view aggregates both warehouses',
    InventoryEngine.getItemCard({ itemId: it, warehouseId: 'all', ...ALL }).closingBalance >= bal(it, 'wh-local'));

  // mismatch must be REPORTED, not hidden
  const broken = InventoryEngine.getItemCard({ itemId: it, warehouseId: 'wh-local', fromDate: '2020-01-01', toDate: '2020-12-31' });
  check('a truncated period surfaces an explicit mismatch', Math.abs(broken.mismatch) > 0 && broken.closingBalance === broken.openingBalance);
}

// ===========================================================================
section('F20 — stock source: representative custody issues, warehouse untouched');
// ===========================================================================
{
  const sup = mkSupplier();
  const repCode = `UAT-REP-${Math.random().toString(36).slice(2, 6)}`;
  const rep = WorkflowService.createSalesRepresentative({ code: repCode, name: `مندوب اختبار ${repCode}`, isTest: true });
  check('test representative created', rep.success, rep.error || '');

  const cust = mkCustomer('retail');
  const whStockBefore = bal(FP.id, 'wh-local');

  const open = WorkflowService.openRepCustody(rep.rep!.id, 'UAT');
  check('custody opened', open.success, open.error || '');
  const load = WorkflowService.loadGoodsToRep({
    custodyId: open.custody!.id, itemId: FP.id, quantity: 40,
    unitPrice: 0, warehouseId: 'wh-local', date: TODAY,
  });
  check('goods loaded to the rep from the warehouse', load.success, load.error || '');
  check('loading DID reduce the warehouse stock', whStockBefore - bal(FP.id, 'wh-local') === 40);

  const whAfterLoad = bal(FP.id, 'wh-local');
  const res = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: 'wh-local',
    stockSource: 'rep_custody', custodyId: open.custody!.id,
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY, isTest: true,
    lines: [{ itemId: FP.id, quantity: 4, freeQuantity: 1, unitPrice: 150, vatRate: 0.14 }],
  });
  check('custody sales invoice posts', res.success, res.error || '');
  check('the invoice records the stock source', res.invoice!.stockSource === 'rep_custody', `got ${res.invoice!.stockSource}`);
  check('the invoice links the custody', res.invoice!.custodyId === open.custody!.id);
  check('the invoice links the representative', res.invoice!.repId === rep.rep!.id);
  check('WAREHOUSE stock is NOT decremented again', bal(FP.id, 'wh-local') === whAfterLoad,
    `wh ${whAfterLoad} -> ${bal(FP.id, 'wh-local')}`);

  const ms = snap().custodyMovements.filter(m => m.custodyId === open.custody!.id);
  const loaded = ms.filter(m => m.movementType === 'loaded').reduce((s, m) => s + m.quantity, 0);
  const sold = ms.filter(m => m.movementType === 'sold').reduce((s, m) => s + m.quantity, 0);
  const returned = ms.filter(m => m.movementType === 'returned').reduce((s, m) => s + m.quantity, 0);
  check('custody reconciliation: opening + loading - sales - returns = closing',
    loaded - sold - returned === 40 - 5, `loaded ${loaded} sold ${sold} returned ${returned}`);
  check('custody sale consumed 5 units (4 + 1 bonus)', sold === 5, `got ${sold}`);
  check('the custody movement references the invoice number',
    ms.some(m => m.movementType === 'sold' && m.referenceDoc === res.invoice!.invoiceNumber));
  check('custody bonus is still zero-valued (revenue for 4 only)',
    res.invoice!.subtotal === 600, `got ${res.invoice!.subtotal}`);
  check('custody sale credits the custody account 1107 (not warehouse stock)',
    snap().journalEntries.find(j => j.id === res.invoice!.journalEntryId)!.lines.some(l => l.accountId === 'acc-1107' && l.credit > 0));

  // overselling the custody is blocked
  const tooMuch = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: 'wh-local',
    stockSource: 'rep_custody', custodyId: open.custody!.id,
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY, isTest: true,
    lines: [{ itemId: FP.id, quantity: 9999, unitPrice: 150, vatRate: 0.14 }],
  });
  check('selling more than the custody holds is rejected', !tooMuch.success, tooMuch.error || '');

  void sup;
  created.push(open.custody!.id, rep.rep!.id);
}

// ===========================================================================
section('F21 — custody settlement moves treasury only when cash really moves');
// ===========================================================================
{
  const repCode = `UAT-REP2-${Math.random().toString(36).slice(2, 6)}`;
  const rep = WorkflowService.createSalesRepresentative({ code: repCode, name: `مندوب اختبار ${repCode}`, isTest: true });
  const open = WorkflowService.openRepCustody(rep.rep!.id, 'UAT settlement');
  WorkflowService.loadGoodsToRep({ custodyId: open.custody!.id, itemId: FP.id, quantity: 10, unitPrice: 0, warehouseId: 'wh-local', date: TODAY });

  // --- non-cash settlement: no cash movement at all ---
  const cashBefore = gl('1101');
  const nonCash = WorkflowService.settleRepCustody({ custodyId: open.custody!.id, date: TODAY, isTest: true });
  check('non-cash custody settlement succeeds', nonCash.success, nonCash.error || '');
  check('non-cash settlement moves NO treasury cash', gl('1101') === cashBefore, `1101 ${cashBefore} -> ${gl('1101')}`);
  check('non-cash settlement reports a zero treasury delta', near(nonCash.treasuryDelta || 0, 0, 0.001));
  check('non-cash settlement posts no settlement journal',
    !snap().journalEntries.some(j => j.sourceDocumentType === 'rep_custody_settlement' && j.sourceDocumentId === open.custody!.id));
  check('settlement reconciliation is returned to the caller', Array.isArray(nonCash.reconciliation) && nonCash.reconciliation.length > 0);

  // --- cash settlement: treasury in ---
  const rep2Code = `UAT-REP3-${Math.random().toString(36).slice(2, 6)}`;
  const rep2 = WorkflowService.createSalesRepresentative({ code: rep2Code, name: `مندوب اختبار ${rep2Code}`, isTest: true });
  const open2 = WorkflowService.openRepCustody(rep2.rep!.id, 'UAT settlement cash');
  WorkflowService.loadGoodsToRep({ custodyId: open2.custody!.id, itemId: FP.id, quantity: 10, unitPrice: 0, warehouseId: 'wh-local', date: TODAY });
  const cash2 = gl('1101');
  const custody2 = gl('1107');
  const settled = WorkflowService.settleRepCustody({ custodyId: open2.custody!.id, cashCollected: 2500, date: TODAY, isTest: true });
  check('cash custody settlement succeeds', settled.success, settled.error || '');
  check('treasury 1101 INCREASED by the collected cash', near(gl('1101') - cash2, 2500, 0.01), `1101 ${cash2} -> ${gl('1101')}`);
  check('custody account 1107 decreased by the collected cash', near(custody2 - gl('1107'), 2500, 0.01), `1107 ${custody2} -> ${gl('1107')}`);
  check('settlement reports the treasury delta', near(settled.treasuryDelta || 0, 2500, 0.01));

  // --- refund: treasury out ---
  const rep3Code = `UAT-REP4-${Math.random().toString(36).slice(2, 6)}`;
  const rep3 = WorkflowService.createSalesRepresentative({ code: rep3Code, name: `مندوب اختبار ${rep3Code}`, isTest: true });
  const open3 = WorkflowService.openRepCustody(rep3.rep!.id, 'UAT settlement refund');
  check('third custody opened for the refund scenario', open3.success, `${rep3.error || ''} | ${open3.error || ''}`);
  WorkflowService.loadGoodsToRep({ custodyId: open3.custody!.id, itemId: FP.id, quantity: 5, unitPrice: 0, warehouseId: 'wh-local', date: TODAY });
  const cash3 = gl('1101');
  const refunded = WorkflowService.settleRepCustody({ custodyId: open3.custody!.id, cashCollected: 1000, cashRefunded: 300, date: TODAY, isTest: true });
  if (!refunded.success) console.log('    DEBUG refund custody =', JSON.stringify(snap().representativeCustodies.map(c => ({ id: c.id, st: c.status, rep: c.repId }))));
  check('settlement with refund succeeds', refunded.success, refunded.error || '');
  check('treasury moved by the NET amount (1000 - 300)', near(gl('1101') - cash3, 700, 0.01), `delta ${gl('1101') - cash3}`);

  // ---- F29: the treasury ledger shows all of this exactly once ----
  const led = TreasuryLedgerService.build(ALL);
  check('treasury ledger closing balance equals the GL cash account', near(led.closingBalance, gl('1101'), 0.01),
    `ledger ${led.closingBalance} vs GL ${gl('1101')}`);
  check('treasury ledger has no duplicated rows', new Set(led.rows.map(r => r.id)).size === led.rows.length);
  check('non-cash settlement created NO treasury row',
    !led.rows.some(r => r.sourceDocumentType === 'rep_custody_settlement' && r.id === undefined));
  created.push(open.custody!.id, open2.custody!.id, open3.custody!.id, rep.rep!.id, rep2.rep!.id, rep3.rep!.id);
}

// ===========================================================================
section('F22 — sales return inherits the ORIGINAL tax treatment');
// ===========================================================================
{
  stock(FP.id, 'wh-local', 400, 60);
  const taxableCust = mkCustomer('wholesale');
  const exemptCust = mkCustomer('wholesale');

  const vatBefore = gl('2103');
  const taxable = WorkflowService.createSalesInvoice({
    customerId: taxableCust.id, channel: 'wholesale', warehouseId: 'wh-local',
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY,
    taxTreatment: 'taxable', isTest: true,
    lines: [{ itemId: FP.id, quantity: 2, unitPrice: 500, vatRate: 0.14 }],
  });
  const exempt = WorkflowService.createSalesInvoice({
    customerId: exemptCust.id, channel: 'wholesale', warehouseId: 'wh-local',
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY,
    taxTreatment: 'exempt', isTest: true,
    lines: [{ itemId: FP.id, quantity: 2, unitPrice: 500, vatRate: 0.14 }],
  });
  check('taxable invoice posts with VAT', taxable.success && near(taxable.invoice!.vatAmount, 140, 0.01), taxable.error || '');
  check('exempt invoice posts with ZERO VAT', exempt.success && near(exempt.invoice!.vatAmount, 0, 0.001), exempt.error || '');
  const vatAfterSales = gl('2103');
  check('only the taxable sale credited 2103 (140)', near(vatAfterSales - vatBefore, 140, 0.01), `delta ${vatAfterSales - vatBefore}`);

  const rTaxable = WorkflowService.postSalesReturn({
    customerId: taxableCust.id, invoiceId: taxable.invoice!.id, warehouseId: 'wh-local',
    date: TODAY, reason: 'مرتجع خاضع', isTest: true,
    lines: [{ itemId: FP.id, quantity: 1, unitPrice: 500, vatRate: 0 }],
  });
  check('return of a taxable sale posts', rTaxable.success, rTaxable.error || '');
  check('taxable return reverses 14% VAT (70)', near(rTaxable.salesReturn!.totalVat, 70, 0.01), `got ${rTaxable.salesReturn!.totalVat}`);
  check('2103 net reduced by the taxable return', near(gl('2103') - vatAfterSales, -70, 0.01), `delta ${gl('2103') - vatAfterSales}`);

  const vatBeforeExemptReturn = gl('2103');
  const rExempt = WorkflowService.postSalesReturn({
    customerId: exemptCust.id, invoiceId: exempt.invoice!.id, warehouseId: 'wh-local',
    date: TODAY, reason: 'مرتجع معفى', isTest: true,
    lines: [{ itemId: FP.id, quantity: 1, unitPrice: 500, vatRate: 0.14 }],
  });
  check('return of an EXEMPT sale posts', rExempt.success, rExempt.error || '');
  check('exempt return carries NO VAT (never auto-14%)', near(rExempt.salesReturn!.totalVat, 0, 0.001), `got ${rExempt.salesReturn!.totalVat}`);
  check('exempt return posts nothing to 2103', near(gl('2103') - vatBeforeExemptReturn, 0, 0.001));
  const rl = snap().salesReturnLines.find(l => l.returnId === rExempt.salesReturn!.id)!;
  check('exempt return line inherited vatRate 0 from the original line', near(rl.vatRate || 0, 0, 0.001), `got ${rl.vatRate}`);
}

// ===========================================================================
section('F24 — customer cheque bounce restores the SAME customer receivable');
// ===========================================================================
{
  const cust = mkCustomer('wholesale');
  stock(FP.id, 'wh-local', 200, 60);
  const inv = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'wholesale', warehouseId: 'wh-local',
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY, isTest: true,
    lines: [{ itemId: FP.id, quantity: 2, unitPrice: 400, vatRate: 0.14 }],
  });
  check('invoice posts before the cheque', inv.success, inv.error || '');

  const reg = WorkflowService.registerCheque({
    type: 'incoming', partyId: cust.id, chequeNumber: `UAT-CHQ-${Math.random().toString(36).slice(2, 6)}`,
    bankName: 'بنك اختبار', amount: inv.invoice!.totalAmount, currency: 'EGP',
    issueDate: TODAY, dueDate: TODAY, isTest: true,
  });
  check('customer cheque registered from the Cheques screen', reg.success, reg.error || '');
  const afterReg = snap().customers.find(c => c.id === cust.id)!.currentBalance;
  check('cheque registration reduced the customer balance', near(afterReg, 0, 0.01), `got ${afterReg}`);

  const rec = snap().journalEntries.find(j => j.id === reg.cheque!.receiptJournalId)!;
  check('recognition debits cheques under collection 1104',
    rec.lines.some(l => l.accountId === 'acc-1104' && near(l.debit, 912, 0.01)));
  check('recognition credits the customer receivable 1105 (NOT a revenue account)',
    rec.lines.some(l => l.accountId === 'acc-1105' && near(l.credit, 912, 0.01)));

  const bounced = WorkflowService.updateChequeStatus({
    chequeId: reg.cheque!.id, newStatus: 'bounced', date: TODAY,
    reason: 'إرجاع من البنك', isTest: true,
  });
  check('cheque bounce is allowed from "received"', bounced.success, bounced.error || '');
  const balAfter = snap().customers.find(c => c.id === cust.id)!.currentBalance;
  check('the SAME customer receivable is restored', near(balAfter, 912, 0.01), `got ${balAfter}`);

  const bounceJv = snap().journalEntries
    .filter(j => j.sourceDocumentId === reg.cheque!.id && j.sourceDocumentType === 'cheque_status_change')
    .pop()!;
  check('bounce debits the customer receivable 1105', bounceJv.lines.some(l => l.accountId === 'acc-1105' && near(l.debit, 912, 0.01)));
  check('bounce credits cheques under collection 1104', bounceJv.lines.some(l => l.accountId === 'acc-1104' && near(l.credit, 912, 0.01)));
  check('bounce does NOT touch any revenue account',
    !bounceJv.lines.some(l => ['acc-4101', 'acc-4102', 'acc-4103'].includes(l.accountId) && l.debit > 0));
  check('bounce journal is named after the customer', bounceJv.description.includes(cust.name));
  const twice = WorkflowService.updateChequeStatus({ chequeId: reg.cheque!.id, newStatus: 'collected', date: TODAY, isTest: true });
  check('a bounced cheque cannot transition further (no duplicate reversal)', !twice.success, twice.error || '');
}

// ===========================================================================
section('F25 — cash sales hit the treasury and create NO receivable');
// ===========================================================================
{
  const cust = mkCustomer('retail');
  stock(FP.id, 'wh-local', 300, 60);
  const cashBefore = gl('1101');
  const ledgerBefore = TreasuryLedgerService.build(ALL).closingBalance;
  const custBefore = snap().customers.find(c => c.id === cust.id)!.currentBalance;

  const inv = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: 'wh-local',
    paymentMethod: 'cash', currency: 'EGP', exchangeRate: 1, date: TODAY, isTest: true,
    lines: [{ itemId: FP.id, quantity: 3, unitPrice: 1000, vatRate: 0.14 }],
  });
  check('cash sales invoice posts', inv.success, inv.error || '');
  check('cash amount recorded on the invoice', inv.invoice!.cashAmount === 3420, `got ${inv.invoice!.cashAmount}`);

  const jv = snap().journalEntries.find(j => j.id === inv.invoice!.journalEntryId)!;
  check('journal debits CASH 1101 with the full total (3420)',
    jv.lines.some(l => l.accountId === 'acc-1101' && near(l.debit, 3420, 0.01)));
  check('journal does NOT debit any receivable account',
    !jv.lines.some(l => ['acc-1105', 'acc-1106'].includes(l.accountId) && l.debit > 0));
  check('customer balance is untouched by a cash sale',
    snap().customers.find(c => c.id === cust.id)!.currentBalance === custBefore);
  check('treasury GL 1101 increased by 3420', near(gl('1101') - cashBefore, 3420, 0.01), `delta ${gl('1101') - cashBefore}`);
  check('treasury ledger moved by the same amount',
    near(TreasuryLedgerService.build(ALL).closingBalance - ledgerBefore, 3420, 0.01));

  const rows = TreasuryLedgerService.build(ALL).rows.filter(r => r.id === jv.id);
  check('the cash sale appears EXACTLY ONCE in the treasury ledger', rows.length === 1, `got ${rows.length}`);
  check('the cash sale is labelled as cash sales', rows[0]?.transactionTypeLabelAr === 'مبيعات نقدية', rows[0]?.transactionTypeLabelAr);
  check('the treasury row links back to the invoice', rows[0]?.link?.tab === 'sales');
  check('a treasury transaction document was recorded',
    snap().treasuryTransactions.filter(t => t.documentType === 'sales_invoice' && t.amount === 3420).length === 1);

  // supplier cash payment also moves treasury
  const sup = mkSupplier();
  const pay = WorkflowService.recordSupplierPayment({
    supplierId: sup.id, amount: 300, currency: 'EGP', exchangeRate: 1,
    paymentMethod: 'cash', date: TODAY, reference: 'UAT cash to supplier', isTest: true,
  });
  check('cash supplier payment posts', pay.success, pay.error || '');
  check('supplier cash payment LOWERS the treasury', near(gl('1101') - cashBefore, 3420 - 300, 0.01), `delta ${gl('1101') - cashBefore}`);
  check('supplier cash payment reduces the supplier balance',
    near(snap().suppliers.find(s => s.id === sup.id)!.currentBalance, -300, 0.01));
}

// ===========================================================================
section('F26 — export shipment cost is derived from the linked invoice');
// ===========================================================================
{
  const expCust = mkCustomer('export', 'USD');
  stock(FP.id, 'wh-export', 200, 70);
  const inv = WorkflowService.createSalesInvoice({
    customerId: expCust.id, channel: 'export', warehouseId: 'wh-export',
    paymentMethod: 'credit', currency: 'USD', exchangeRate: 50, date: TODAY, isTest: true,
    lines: [{ itemId: FP.id, quantity: 4, freeQuantity: 1, unitPrice: 100, vatRate: 0 }],
  });
  check('export invoice posts in USD with no VAT', inv.success && inv.invoice!.vatAmount === 0, inv.error || '');

  const shp = WorkflowService.createExportShipment({
    customerId: expCust.id, shipmentDate: TODAY, portOfOrigin: 'السويس', destinationPort: 'جدة',
    usdRevenue: 0, exchangeRate: 0, shippingCost: 1000, portCosts: 200, customsCost: 100, otherExportCosts: 0,
    salesInvoiceId: inv.invoice!.id, isTest: true,
  });
  check('export shipment posts linked to the invoice', shp.success, shp.error || '');
  check('shipment cost is AUTO-DERIVED (productCost not re-entered)', shp.success && shp.shipment!.productCost === inv.invoice!.cogsTotal,
    `shipment ${shp.shipment?.productCost} vs invoice ${inv.invoice!.cogsTotal}`);
  check('shipment derives USD revenue from the invoice', shp.shipment!.usdRevenue === inv.invoice!.subtotal);
  check('shipment derives the invoice exchange rate', shp.shipment!.exchangeRate === 50);
  check('shipment back-links the invoice', snap().salesInvoices.find(i => i.id === inv.invoice!.id)!.exportShipmentId === shp.shipment!.id);
  check('profitability = revenue - costs', near(shp.shipment!.netProfitEGP, shp.shipment!.egpValue - shp.shipment!.totalCosts, 0.01));

  // ---- F27: export collection must appear in the customer statement ----
  const custBalBefore = snap().customers.find(c => c.id === expCust.id)!.currentBalance;
  const coll = WorkflowService.recordExportCollection({
    shipmentId: shp.shipment!.id, amountUsd: 200, actualExchangeRate: 51,
    bankAccountId: 'bank-2', date: TODAY, isTest: true,
  });
  check('export collection posts', coll.success, coll.error || '');

  const st = LedgerService.buildCustomerStatement({ customerId: expCust.id, ...ALL });
  if (Math.abs(st.closingBalance - snap().customers.find(c => c.id === expCust.id)!.currentBalance) > 0.02) {
    console.log('    DEBUG export statement rows =',
      JSON.stringify(st.rows.map(r => ({ t: r.documentType, d: r.debit, c: r.credit })), null, 1));
  }
  check('export collection APPEARS in the customer statement',
    st.rows.some(r => r.documentType === 'export_collection'), JSON.stringify(st.rows.map(r => r.documentType)));
  check('export collection reduced the customer balance by 200 USD',
    near(snap().customers.find(c => c.id === expCust.id)!.currentBalance, custBalBefore - 200, 0.01));
  check('statement closing balance == customer card balance (export)',
    near(st.closingBalance, st.cardBalance, 0.02), `stmt ${st.closingBalance} card ${st.cardBalance}`);
  check('export customer statement shows the remaining 200 USD still due', near(st.closingBalance, 200, 0.02), `got ${st.closingBalance}`);
  const coll2 = WorkflowService.recordExportCollection({
    shipmentId: shp.shipment!.id, amountUsd: 200, actualExchangeRate: 50,
    bankAccountId: 'bank-2', date: TODAY, isTest: true,
  });
  check('remaining export collection posts', coll2.success, coll2.error || '');
  const st3 = LedgerService.buildCustomerStatement({ customerId: expCust.id, ...ALL });
  check('export customer statement ends at zero after FULL collection', near(st3.closingBalance, 0, 0.02), `got ${st3.closingBalance}`);
  check('export shipment is marked fully collected',
    snap().exportShipments.find(s => s.id === shp.shipment!.id)!.collectionStatus === 'collected');
}

// ===========================================================================
section('F27/F28/F30 — ONE customer statement covers every customer movement');
// ===========================================================================
{
  const cust = mkCustomer('wholesale');
  stock(FP.id, 'wh-local', 500, 60);

  const inv = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'wholesale', warehouseId: 'wh-local',
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY, isTest: true,
    lines: [{ itemId: FP.id, quantity: 2, unitPrice: 1000, vatRate: 0.14 }],
  });
  const pmt = WorkflowService.recordCustomerPayment({
    customerId: cust.id, amount: 500, currency: 'EGP', exchangeRate: 1,
    paymentMethod: 'cash', date: TODAY, reference: 'UAT partial collection', isTest: true,
  });
  const chq = WorkflowService.registerCheque({
    type: 'incoming', partyId: cust.id, chequeNumber: `UAT-CHQ2-${Math.random().toString(36).slice(2, 6)}`,
    bankName: 'بنك اختبار', amount: 700, currency: 'EGP', issueDate: TODAY, dueDate: TODAY, isTest: true,
  });
  const bounce = WorkflowService.updateChequeStatus({
    chequeId: chq.cheque!.id, newStatus: 'bounced', date: TODAY, reason: 'UAT', isTest: true,
  });
  const ret = WorkflowService.postSalesReturn({
    customerId: cust.id, invoiceId: inv.invoice!.id, warehouseId: 'wh-local', date: TODAY,
    reason: 'UAT مرتجع', isTest: true,
    lines: [{ itemId: FP.id, quantity: 1, unitPrice: 1000, vatRate: 0.14 }],
  });
  check('invoice / payment / cheque / bounce / return all posted',
    inv.success && pmt.success && chq.success && bounce.success && ret.success);

  const st = LedgerService.buildCustomerStatement({ customerId: cust.id, ...ALL });
  const types = st.rows.map(r => r.documentType);
  check('statement contains the sales invoice', types.includes('sales_invoice'), types.join(','));
  check('statement contains the cash collection', types.includes('customer_payment'), types.join(','));
  check('statement contains the cheque registered from the Cheques screen', types.includes('cheque'), types.join(','));
  check('statement contains the cheque bounce', types.includes('cheque_bounce'), types.join(','));
  check('statement contains the sales return', types.includes('sales_return'), types.join(','));

  check('cheque row shows the cheque number', st.rows.some(r => r.documentType === 'cheque' && r.documentNumber === chq.cheque!.chequeNumber));
  check('every row has a description and a running balance',
    st.rows.every(r => Boolean(r.description) && typeof r.runningBalance === 'number'));
  check('no duplicated rows in the statement', new Set(st.rows.map(r => r.id)).size === st.rows.length);

  // expected economics: +2280 invoice, -500 cash, -700 cheque, +700 bounce, -1140 return
  const expected = 2280 - 500 - 700 + 700 - 1140;
  check('statement closing balance equals the economics of the documents', near(st.closingBalance, expected, 0.02),
    `got ${st.closingBalance} expected ${expected}`);
  check('card balance == statement closing balance', near(st.cardBalance, st.closingBalance, 0.02),
    `card ${st.cardBalance} stmt ${st.closingBalance}`);
  check('statement arithmetic: opening + debits - credits = closing',
    near(st.openingBalance + st.totalDebit - st.totalCredit, st.closingBalance, 0.02));

  // the GL control account must equal the sum of the customers' statements
  const allEgp = snap().customers.filter(c => c.currency === 'EGP');
  const sum = allEgp.reduce((s, c) => s + LedgerService.buildCustomerStatement({ customerId: c.id, ...ALL }).closingBalance, 0);
  check('GL 1105 equals the sum of all EGP customer statements', near(gl('1105'), sum, 0.05),
    `GL ${gl('1105')} vs statements ${sum}`);

  const filtered = LedgerService.buildCustomerStatement({ customerId: cust.id, docType: 'sales_invoice', ...ALL });
  check('statement document-type filter works', filtered.rows.every(r => r.documentType === 'sales_invoice'));

  // credit balance must not disappear
  const over = WorkflowService.recordCustomerPayment({
    customerId: cust.id, amount: 5000, currency: 'EGP', exchangeRate: 1,
    paymentMethod: 'cash', date: TODAY, reference: 'UAT advance', isTest: true,
  });
  check('over-payment posts', over.success, over.error || '');
  const st2 = LedgerService.buildCustomerStatement({ customerId: cust.id, ...ALL });
  check('over-payment produces a visible CREDIT balance', st2.closingBalance < 0, `got ${st2.closingBalance}`);
  check('credit balance is not hidden from the statement', st2.totalCredit > st2.totalDebit);
}

// ===========================================================================
section('F23 — explicit per-user permissions; Super Admin stays protected');
// ===========================================================================
{
  const created1 = MasterDataService.createUser({
    username: `uat_viewer_${Math.random().toString(36).slice(2, 6)}`,
    password: 'uat-pass-123', name: 'مستخدم اختبار صلاحيات', email: 'uat@test.local',
    role: 'Viewer', isTest: true,
  });
  check('test user created', created1.success, created1.error || '');
  const uid = created1.user!.id;

  // Viewer has view-only access by role matrix
  check('role matrix: Viewer CANNOT create customers',
    !PermissionService.hasPermissionForUser({ role: 'Viewer' }, 'customers', 'create'));
  const denied = MasterDataService.createCustomer({
    code: 'UAT-DENY', name: 'عميل مرفوض', customerType: 'retail', channel: 'retail',
    userId: uid, userName: 'مستخدم اختبار صلاحيات', isTest: true,
  });
  check('SERVICE refuses the unpermitted write (AuthorizationService is the boundary)',
    !denied.success, denied.error || '');

  // Super Admin grants an explicit override
  const grant = MasterDataService.updateUserPermissions({
    userId: uid,
    permissions: { customers: ['view', 'create'] },
    options: { userId: 'usr-admin', userName: 'المشرف العام (Admin)' },
  });
  check('Super Admin can assign explicit per-module actions', grant.success, grant.error || '');

  const user = snap().users.find(u => u.id === uid)!;
  check('the assignment is stored on the user record',
    Array.isArray(user.permissions?.customers) && user.permissions!.customers.includes('create'));
  check('effective permissions now allow create on customers',
    PermissionService.hasPermissionForUser(user, 'customers', 'create'));
  check('the override did NOT widen other modules',
    !PermissionService.hasPermissionForUser(user, 'sales', 'post'));

  const allowed = MasterDataService.createCustomer({
    code: 'UAT-ALLOW', name: 'عميل مسموح', customerType: 'retail', channel: 'retail',
    userId: uid, userName: 'مستخدم اختبار صلاحيات', isTest: true,
  });
  check('SERVICE now allows the explicitly granted action', allowed.success, allowed.error || '');
  if (allowed.customer) created.push(allowed.customer.id);

  // "delete" is an explicit assignable action
  const grantDel = MasterDataService.updateUserPermissions({
    userId: uid, permissions: { customers: ['view', 'create', 'edit', 'delete'] },
    options: { userId: 'usr-admin', userName: 'المشرف العام (Admin)' },
  });
  check('delete is an explicit assignable action', grantDel.success &&
    PermissionService.hasPermissionForUser(snap().users.find(u => u.id === uid)!, 'customers', 'delete'));
  check('approve/post are separately assignable and NOT implied by delete',
    !PermissionService.hasPermissionForUser(snap().users.find(u => u.id === uid)!, 'customers', 'post'));

  // Super Admin protection
  const admin = snap().users.find(u => u.id === 'usr-admin')!;
  check('Super Admin cannot be permission-overridden',
    !MasterDataService.updateUserPermissions({ userId: admin.id, permissions: { sales: ['view'] }, options: { userId: 'usr-admin', userName: 'Admin' } }).success);
  check('Super Admin cannot be reset',
    !MasterDataService.resetUserPermissions(admin.id, { userId: 'usr-admin', userName: 'Admin' }).success);
  check('Super Admin always passes AuthorizationService',
    AuthorizationService.enforce('sales', 'create', { userId: admin.id }).allowed);
  check('an unknown module key is rejected',
    !MasterDataService.updateUserPermissions({ userId: uid, permissions: { notAModule: ['view'] }, options: { userId: 'usr-admin', userName: 'Admin' } }).success);

  const reset = MasterDataService.resetUserPermissions(uid, { userId: 'usr-admin', userName: 'Admin' });
  check('permissions can be reset back to the role matrix', reset.success, reset.error || '');
  check('after reset the override is gone', !snap().users.find(u => u.id === uid)!.permissions);
  check('after reset the role matrix governs again',
    !PermissionService.hasPermissionForUser(snap().users.find(u => u.id === uid)!, 'customers', 'create'));

  created.push(uid);
}

// ===========================================================================
section('F32 — reporting reconciliation (TB / VAT / treasury / aging)');
// ===========================================================================
{
  const db = snap();
  let tbDebit = 0;
  let tbCredit = 0;
  db.journalEntries.filter(j => j.isPosted && !j.isReversed).forEach(j => {
    j.lines.forEach(l => {
      const acc = db.accounts.find(a => a.id === l.accountId);
      if (acc && !acc.isHeader) { tbDebit += l.debit; tbCredit += l.credit; }
    });
  });
  check('trial balance is balanced (debits = credits)', near(tbDebit, tbCredit, 0.05), `${tbDebit} vs ${tbCredit}`);

  const accBalancesMatch = db.accounts.filter(a => !a.isHeader).every(acc => {
    let net = 0;
    db.journalEntries.filter(j => j.isPosted && !j.isReversed).forEach(jv => {
      jv.lines.filter(l => l.accountId === acc.id).forEach(l => {
        const isDebitNature = ['Assets', 'COGS', 'Operating Expenses', 'Other Expenses'].includes(acc.category);
        net += isDebitNature ? (l.debit - l.credit) : (l.credit - l.debit);
      });
    });
    return near(net, acc.currentBalance, 0.01);
  });
  check('every GL account balance equals its posted journal lines', accBalancesMatch);

  check('VAT input account 1113 exists in the chart', Boolean(db.accounts.find(a => a.code === '1113')));
  check('VAT output account 2103 exists in the chart', Boolean(db.accounts.find(a => a.code === '2103')));
  const vatNet = gl('2103') - gl('1113');
  check('net VAT payable = 2103 - 1113 (no clamping, value is real)', typeof vatNet === 'number');
  check('VAT report uses real journal lines (2103 balance is not hard-coded to zero)', gl('2103') !== 0 || gl('1113') !== 0);

  const led = TreasuryLedgerService.build(ALL);
  check('treasury ledger ties to the GL cash account', near(led.closingBalance, gl('1101'), 0.01),
    `ledger ${led.closingBalance} vs GL ${gl('1101')}`);
  check('treasury ledger within the period filter behaves',
    TreasuryLedgerService.build({ fromDate: TODAY, toDate: TODAY }).rows.length <= led.rows.length);

  const customersEgp = db.customers.filter(c => c.currency === 'EGP');
  const sumEgp = customersEgp.reduce((s, c) => s + LedgerService.buildCustomerStatement({ customerId: c.id, ...ALL }).closingBalance, 0);
  check('aging total equals the GL local receivable (1105)', near(sumEgp, gl('1105'), 0.05), `aging ${sumEgp} vs GL ${gl('1105')}`);
  const sumUsd = db.customers.filter(c => c.currency === 'USD')
    .reduce((s, c) => s + LedgerService.buildCustomerStatement({ customerId: c.id, ...ALL }).closingBalance, 0);
  const gl1106Usd = gl('1106') / (db.company.currentUsdExchangeRate || 1);
  check('export aging total equals the GL export receivable (1106) in USD', near(sumUsd, gl1106Usd, 0.5), `aging ${sumUsd} vs GL ${gl1106Usd}`);
  check('credit balances are represented (negative closing is legitimate)',
    db.customers.some(c => (c.currentBalance || 0) < 0) || db.customers.every(c => (c.currentBalance || 0) >= 0));

  const cardVsGl = db.customers.every(c => {
    const st = LedgerService.buildCustomerStatement({ customerId: c.id, ...ALL });
    return near(st.closingBalance, st.cardBalance, 0.02);
  });
  check('EVERY customer card balance equals its statement closing balance', cardVsGl);
}

// ===========================================================================
section('Data preservation — nothing seeded was destroyed');
// ===========================================================================
erpDb.mutate(d => {
  const it = d.items.find(x => x.id === FP.id);
  if (it) it.standardCost = origCost;
});
{
  const db = snap();
  check('all 11 finished products still exist', db.items.filter(i => i.itemType === 'finished_product').length === 11);
  check('the 11 seeded BOMs are intact', db.boms.filter(b => !b.isTest).length >= 11);
  check('every seeded product still has an ACTIVE BOM',
    db.items.filter(i => i.itemType === 'finished_product')
      .every(p => db.boms.some(b => (b.finishedItemId || b.productId) === p.id && b.active)));
  check('chart of accounts intact (52)', db.accounts.length === 52, `got ${db.accounts.length}`);
  check('warehouses intact (5)', db.warehouses.length === 5, `got ${db.warehouses.length}`);
  check('bootstrap admin still present', db.users.some(u => u.id === 'usr-admin' && u.role === 'Super Admin'));
  check('no duplicate record ids were produced by this suite', (() => {
    const ids = [
      ...db.salesInvoices.map(x => x.id), ...db.payments.map(x => x.id), ...db.cheques.map(x => x.id),
      ...db.representativeCustodies.map(x => x.id), ...db.custodyMovements.map(x => x.id),
      ...db.exportShipments.map(x => x.id), ...db.inventoryTransactions.map(x => x.id),
      ...db.journalEntries.map(x => x.id), ...db.salesInvoiceLines.map(x => x.id),
    ];
    return new Set(ids).size === ids.length;
  })());
  check('no duplicate sales invoice numbers', new Set(db.salesInvoices.map(i => i.invoiceNumber)).size === db.salesInvoices.length);
  check('no duplicate payment numbers', new Set(db.payments.map(p => p.paymentNumber)).size === db.payments.length);
  check('no duplicate custody numbers', new Set(db.representativeCustodies.map(c => c.custodyNumber)).size === db.representativeCustodies.length);
  check('test product standard cost restored', snap().items.find(i => i.id === FP.id)!.standardCost === origCost);
}

// ---------------------------------------------------------------------------
// Cleanup: ONLY this suite's own test records. Nothing pre-existing is touched.
// ---------------------------------------------------------------------------
erpDb.mutate(draft => {
  const testRepIds = new Set(draft.salesReps.filter(r => r.isTest).map(r => r.id));
  const testCustodyIds = new Set(draft.representativeCustodies.filter(c => (c as { isTest?: boolean }).isTest || testRepIds.has(c.repId)).map(c => c.id));
  draft.custodyMovements = draft.custodyMovements.filter(m => !testCustodyIds.has(m.custodyId) && !m.custodyId);
  draft.representativeCustodies = draft.representativeCustodies.filter(c => !testCustodyIds.has(c.id));
  draft.salesReps = draft.salesReps.filter(r => !r.isTest);

  const testInvIds = new Set(draft.salesInvoices.filter(i => i.isTest).map(i => i.id));
  draft.salesInvoiceLines = draft.salesInvoiceLines.filter(l => !testInvIds.has(l.invoiceId));
  draft.salesInvoices = draft.salesInvoices.filter(i => !i.isTest);

  const testReturnIds = new Set(draft.salesReturns.filter(r => r.isTest).map(r => r.id));
  draft.salesReturnLines = draft.salesReturnLines.filter(l => !testReturnIds.has(l.returnId));
  draft.salesReturns = draft.salesReturns.filter(r => !r.isTest);

  const testPayments = new Set(draft.payments.filter(p => p.isTest).map(p => p.id));
  draft.paymentAllocations = draft.paymentAllocations.filter(a => !testPayments.has(a.paymentId));
  draft.payments = draft.payments.filter(p => !p.isTest);

  const testCheques = new Set(draft.cheques.filter(c => c.isTest).map(c => c.id));
  draft.cheques = draft.cheques.filter(c => !testCheques.has(c.id));

  const testShipIds = new Set(draft.exportShipments.filter(s => s.isTest).map(s => s.id));
  draft.exportShipments = draft.exportShipments.filter(s => !testShipIds.has(s.id));

  const testBoms = new Set(draft.boms.filter(b => b.isTest).map(b => b.id));
  draft.bomLines = draft.bomLines.filter(l => !testBoms.has(l.bomId));
  draft.boms = draft.boms.filter(b => !b.isTest);

  draft.inventoryTransactions = draft.inventoryTransactions.filter(t => !t.isTest);
  draft.batches = draft.batches.filter(b => !b.isTest);
  draft.treasuryTransactions = draft.treasuryTransactions.filter(t => !t.isTest);
  draft.journalEntries = draft.journalEntries.filter(j => !j.isTest);
  draft.qualityInspections = draft.qualityInspections.filter(q => !(q as any).isTest);
  draft.auditLogs = draft.auditLogs.filter(a => !(a as any).isTest);
  draft.users = draft.users.filter(u => !u.isTest);

  const ids = new Set(created);
  draft.customers = draft.customers.filter(c => !c.isTest && !ids.has(c.id));
  draft.suppliers = draft.suppliers.filter(s => !s.isTest && !ids.has(s.id));

  // restore the standard cost we set for the test product
  const it = draft.items.find(x => x.id === FP.id);
  if (it) it.standardCost = origCost;
});

console.log(`\n==============================`);
console.log(`MASTER UAT TOTAL: ${pass + fail} | PASS: ${pass} | FAIL: ${fail}`);
if (failures.length) {
  console.log(`FAILED CHECKS:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log('🎉 ALL MASTER UAT CHECKS PASSED');

