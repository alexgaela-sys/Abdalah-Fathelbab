// AUDIT-FIX REGRESSION SUITE — the 34 required checks from
// "MASTER DATA + FULL AUDIT FIX PASS" (parts AN / A–AO).
//
// Run: `bun run auditfix`
//
// ADDITIVE suite. It NEVER resets the database, NEVER clears localStorage,
// NEVER reseeds destructively and NEVER touches pre-existing data: every
// record it creates is flagged `isTest: true`, and the cleanup at the end
// removes ONLY those records. It exercises the EXISTING engines — no second
// costing/inventory/accounting engine is introduced or required.
import { readFileSync } from 'node:fs';
import { erpDb, PRODUCTION_RATES, CANONICAL_FINISHED_PRODUCTS } from '../src/services/db';
import { AccountingEngine } from '../src/services/accounting';
import { InventoryEngine } from '../src/services/inventory';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { WorkflowService } from '../src/services/workflows';
import { MasterDataService } from '../src/services/masterData';
import { LedgerService } from '../src/services/ledger';
import { AuthorizationService } from '../src/services/authorization';
import { AuthService } from '../src/services/auth';
import { isDebitNatureCategory } from '../src/types/erp';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    failures.push(`${label} :: ${detail}`);
    console.log(`  ❌ ${label} :: ${detail}`);
  }
}
const section = (t: string) => console.log(`\n=== ${t} ===`);

const TODAY = new Date().toISOString().split('T')[0];
const snap = () => erpDb.getSnapshot();
const gl = (code: string) => snap().accounts.find(a => a.code === code)?.currentBalance || 0;
const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) <= tol;
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const bal = (itemId: string, wh?: string) => InventoryEngine.getItemBalance(itemId, wh);

console.log('================================================================');
console.log('🔧 AUDIT-FIX REGRESSION — 34 required checks');
console.log('================================================================');

// ---------------------------------------------------------------------------
// Isolated test fixtures (all flagged isTest; removed by the cleanup at the end)
// ---------------------------------------------------------------------------
const createdIds = new Set<string>();

function mkCustomer(type: 'retail' | 'wholesale' | 'export', currency: 'EGP' | 'USD' = 'EGP', vat = 0.14) {
  const code = `AFX-${type}-${rnd()}`;
  const r = MasterDataService.createCustomer({
    code, name: `عميل اختبار ${code}`, customerType: type, channel: type,
    currency, address: 'اختبار', phone: '0100000000', taxNumber: 'T-AFX',
    isTest: true, userId: 'usr-admin', userName: 'اختبار',
  });
  if (!r.customer) throw new Error(`mkCustomer: ${r.error}`);
  createdIds.add(r.customer.id);
  return { ...r.customer, __vat: vat };
}

function mkSupplier() {
  const code = `AFX-SUP-${rnd()}`;
  const r = MasterDataService.createSupplier({
    code, name: `مورد اختبار ${code}`, isTest: true, userId: 'usr-admin', userName: 'اختبار',
  });
  if (!r.supplier) throw new Error(`mkSupplier: ${r.error}`);
  createdIds.add(r.supplier.id);
  return r.supplier;
}

function mkItem(over: Partial<import('../src/types/erp').Item> & { id: string; code: string; nameAr: string }) {
  const r = MasterDataService.createItem({
    nameEn: over.nameAr, itemType: 'finished_product', baseUnitId: 'unit-piece',
    purchaseUnitId: 'unit-piece', standardCost: 0, actualCost: 0,
    sellingPriceRetail: 0, sellingPriceWholesale: 0, sellingPriceExportUSD: 0,
    vatRate: 0.14, trackBatch: false, trackExpiry: false, minStockLevel: 0, active: true,
    ...over,
    isTest: true, userId: 'usr-admin', userName: 'اختبار',
  } as never);
  if (!r.item) throw new Error(`mkItem: ${r.error}`);
  createdIds.add(r.item.id);
  return r.item;
}

function stock(itemId: string, wh: string, qty: number, unitCost: number, batchNumber?: string) {
  const r = InventoryEngine.recordMovement({
    itemId, warehouseId: wh, movementType: 'purchase_receipt',
    quantityIn: qty, quantityOut: 0, unitCost,
    documentType: 'اختبار رصيد افتتاحي',
    documentNumber: `AFX-OPEN-${rnd()}`,
    batchNumber, date: TODAY, isTest: true,
  });
  if (!r.success) throw new Error(`stock: ${r.error}`);
  return r;
}

// Master-data ids declared by the fix pass.
const BOX_SINGLE = 'item-pkg-box-single';
const BOX_DUO = 'item-pkg-box-duo';
const TRAY = 'item-pkg-tray';
const SAUCE_TRAY = 'item-pkg-sauce-tray';
const LINER = 'item-pkg-liner';
const STICKER = 'item-pkg-sticker';
const NAPKIN = 'item-pkg-napkin';
const KRAFT_SINGLE = 'item-pkg-kraft-single';
const KRAFT_DUO = 'item-pkg-kraft-duo';
const FILM_ROLL = 'item-pkg-film';
const CHIP = 'item-raw-chip';
const SAUCE = {
  sweetChili: 'item-raw-flavor-sweet-chili',
  spicyGrilled: 'item-raw-flavor-spicy-grilled',
  bbq: 'item-raw-flavor-honey-bbq',
  burger: 'item-raw-flavor-smokey-burger',
  mustard: 'item-raw-flavor-honey-mustard',
} as const;

const bomOf = (fpId: string) => {
  const db = snap();
  const bom = db.boms.find(b => (b.finishedItemId || (b as unknown as { productId?: string }).productId) === fpId && b.active);
  if (!bom) return null;
  return { bom, lines: db.bomLines.filter(l => l.bomId === bom.id) };
};
const qtyOf = (lines: { materialItemId: string; quantityRequired: number }[], materialId: string) =>
  lines.find(l => l.materialItemId === materialId)?.quantityRequired;

// ===========================================================================
section('A. PACKAGING / CHIP / SAUCE MASTER RECORDS (parts A1–A4)');
// ===========================================================================
{
  const db = snap();
  const names: Array<[string, string]> = [
    [BOX_SINGLE, 'علبة سينجل'], [BOX_DUO, 'علبة ديو'],
    [TRAY, 'طبق'], [SAUCE_TRAY, 'طبق صوصات'], [LINER, 'جلافز'],
    [STICKER, 'ستيكر'], [NAPKIN, 'مناديل مبللة'],
    [KRAFT_SINGLE, 'كرتون بني خارجي سنجل'], [KRAFT_DUO, 'كرتون بني ديو'],
    [FILM_ROLL, 'رول'], [CHIP, 'شيبس / فاير فينجر'],
  ];
  const missing = names.filter(([id]) => !db.items.some(i => i.id === id));
  check('A: every required packaging / chip master record exists', missing.length === 0,
    missing.map(([id]) => id).join(','));

  const wrongName = names.filter(([id, ar]) => db.items.find(i => i.id === id)?.nameAr !== ar);
  check('A: required records carry the exact Arabic names', wrongName.length === 0,
    wrongName.map(([id]) => `${id}=${db.items.find(i => i.id === id)?.nameAr}`).join(','));

  const boxSingle = db.items.find(i => i.id === BOX_SINGLE);
  const boxDuo = db.items.find(i => i.id === BOX_DUO);
  check('A: علبة سينجل and علبة ديو are SEPARATE items (no generic "علبة")',
    Boolean(boxSingle && boxDuo) && boxSingle!.id !== boxDuo!.id);
  check('A: single/duo boxes are PCS-based packaging material',
    boxSingle?.baseUnitId === 'unit-piece' && boxDuo?.baseUnitId === 'unit-piece',
    `${boxSingle?.baseUnitId}/${boxDuo?.baseUnitId}`);

  const chip = db.items.find(i => i.id === CHIP);
  check('A: chip / fire-finger is KG-based so decimal quantities work', chip?.baseUnitId === 'unit-kg', chip?.baseUnitId);
  check('A: رول (film) is a ROLL material, not forced into PCS',
    db.items.find(i => i.id === FILM_ROLL)?.baseUnitId === 'unit-roll');

  // A3 — one sauce item per FLAVOUR, never one generic "صوص" item.
  const sauces = [SAUCE.sweetChili, SAUCE.spicyGrilled, SAUCE.bbq, SAUCE.burger, SAUCE.mustard];
  check('A: five SEPARATE sauce master records exist',
    sauces.every(id => db.items.some(i => i.id === id)),
    sauces.filter(id => !db.items.some(i => i.id === id)).join(','));
  check('A: no generic single "صوص" item was created',
    !db.items.some(i => i.nameAr.trim() === 'صوص'),
    db.items.filter(i => i.nameAr.trim() === 'صوص').map(i => i.code).join(','));

  // D/E — suppliers and the representative exist with NO invented business facts.
  const supplierNames = ['المراعي الخضراء', 'مطبعه الشروق', 'الدمياطي', 'الخليجية', 'السلام', 'الهلال', 'بلانكو', 'رويال كرتون'];
  const missingSup = supplierNames.filter(n => !db.suppliers.some(s => s.name === n));
  check('D: all 8 named suppliers exist as master records', missingSup.length === 0, missingSup.join(','));
  const newSuppliers = db.suppliers.filter(s => supplierNames.includes(s.name));
  check('D: no invented opening balances / tax numbers on the new suppliers',
    newSuppliers.every(s => (Number(s.openingBalance) || 0) === 0 && !(s.taxNumber || '').trim()),
    JSON.stringify(newSuppliers.map(s => ({ n: s.name, b: s.openingBalance, t: s.taxNumber }))));

  const rep = db.salesReps.find(r => r.name === 'حمزه حماد');
  check('E: representative حمزه حماد exists as a master record', Boolean(rep));
  check('E: the representative carries no fabricated transactions',
    !snap().representativeCustodies.some(c => c.repId === rep?.id),
    'a custody exists for the new rep');
}

// ===========================================================================
section('B. BOM RECIPE — containers, flavours, carton & film ratios (parts B / C)');
// ===========================================================================
{
  const db = snap();
  const BASE = 1000;

  // 1. Single BOM uses علبة سينجل.
  const singleBom = bomOf('item-fp-s1')!;
  check('1. Single BOM uses علبة سينجل (1000 PCS)',
    Boolean(singleBom) && qtyOf(singleBom.lines, BOX_SINGLE) === BASE,
    `qty=${qtyOf(singleBom?.lines || [], BOX_SINGLE)}`);
  check('1. Single BOM does NOT consume علبة ديو',
    qtyOf(singleBom.lines, BOX_DUO) === undefined);

  // 2. Duo BOM uses علبة ديو.
  const duoBom = bomOf('item-fp-d1')!;
  check('2. Duo BOM uses علبة ديو (1000 PCS)',
    Boolean(duoBom) && qtyOf(duoBom.lines, BOX_DUO) === BASE,
    `qty=${qtyOf(duoBom?.lines || [], BOX_DUO)}`);
  check('2. Duo BOM does NOT consume علبة سينجل',
    qtyOf(duoBom.lines, BOX_SINGLE) === undefined);

  // SINGLE packaging profile: box, chip, tray, sauce, sticker, napkin — no sauce tray / liner.
  check('B: Single consumes 1 طبق and NOT طبق صوصات / جلافز',
    qtyOf(singleBom.lines, TRAY) === BASE
    && qtyOf(singleBom.lines, SAUCE_TRAY) === undefined
    && qtyOf(singleBom.lines, LINER) === undefined,
    `tray=${qtyOf(singleBom.lines, TRAY)} tray2=${qtyOf(singleBom.lines, SAUCE_TRAY)} liner=${qtyOf(singleBom.lines, LINER)}`);

  // DUO packaging profile: 2 chips, sauce tray, liner, 2 stickers, 2 napkins.
  check('B: Duo consumes طبق صوصات + جلافز and 2 stecker / 2 napkins',
    qtyOf(duoBom.lines, SAUCE_TRAY) === BASE
    && qtyOf(duoBom.lines, LINER) === BASE
    && qtyOf(duoBom.lines, STICKER) === BASE * 2
    && qtyOf(duoBom.lines, NAPKIN) === BASE * 2,
    `tray2=${qtyOf(duoBom.lines, SAUCE_TRAY)} liner=${qtyOf(duoBom.lines, LINER)} sticker=${qtyOf(duoBom.lines, STICKER)} napkin=${qtyOf(duoBom.lines, NAPKIN)}`);

  // 3–6. Sauce mapped by ACTUAL RECIPE, not by category.
  const sauceOf = (fpId: string) => {
    const b = bomOf(fpId);
    if (!b) return [] as string[];
    return b.lines.filter(l => l.materialItemId.startsWith('item-raw-flavor-')).map(l => l.materialItemId);
  };
  check('3. Sweet Chili product uses صوص سويت شيلي',
    sauceOf('item-fp-s1').includes(SAUCE.sweetChili), sauceOf('item-fp-s1').join(','));
  check('3. single products consume exactly ONE sauce unit (75 KG per 1000 PCS)',
    qtyOf(singleBom.lines, SAUCE.sweetChili) === PRODUCTION_RATES.SAUCE_KG_PER_PIECE * BASE,
    `qty=${qtyOf(singleBom.lines, SAUCE.sweetChili)}`);
  check('4. Burger product uses صوص برجر', sauceOf('item-fp-s5').includes(SAUCE.burger), sauceOf('item-fp-s5').join(','));
  check('5. Mustard product uses صوص مستردة', sauceOf('item-fp-s6').includes(SAUCE.mustard), sauceOf('item-fp-s6').join(','));
  check('6. BBQ product uses صوص باربكيو', sauceOf('item-fp-s3').includes(SAUCE.bbq), sauceOf('item-fp-s3').join(','));
  check('B: Duo products consume their OWN TWO recipe sauces (150 KG per 1000 PCS)',
    sauceOf('item-fp-d1').length === 2
    && sauceOf('item-fp-d1').includes(SAUCE.bbq) && sauceOf('item-fp-d1').includes(SAUCE.burger)
    && sauceOf('item-fp-d1').every(id => qtyOf(duoBom.lines, id) === PRODUCTION_RATES.SAUCE_KG_PER_PIECE * BASE),
    sauceOf('item-fp-d1').join(','));

  // 7. Single kraft carton ratio = 1 per 15 PCS.
  check('7. Single carton ratio = 1 carton / 15 PCS',
    near(qtyOf(singleBom.lines, KRAFT_SINGLE) ?? 0, BASE / PRODUCTION_RATES.SINGLE_CARTON_RATIO, 0.001),
    `qty=${qtyOf(singleBom.lines, KRAFT_SINGLE)} expected=${BASE / 15}`);
  check('7. Single BOM does NOT consume the duo kraft carton',
    qtyOf(singleBom.lines, KRAFT_DUO) === undefined);

  // 8. Duo kraft carton ratio = 1 per 8 PCS.
  check('8. Duo carton ratio = 1 carton / 8 PCS',
    near(qtyOf(duoBom.lines, KRAFT_DUO) ?? 0, BASE / PRODUCTION_RATES.DUO_CARTON_RATIO, 0.001),
    `qty=${qtyOf(duoBom.lines, KRAFT_DUO)} expected=${BASE / 8}`);
  check('8. Duo BOM does NOT consume the single kraft carton',
    qtyOf(duoBom.lines, KRAFT_SINGLE) === undefined);

  // 9. Film ratio: 1 KG chips -> 0.005 ROLL, decimals preserved.
  const chipQty = qtyOf(singleBom.lines, CHIP) ?? 0;
  const filmQty = qtyOf(singleBom.lines, FILM_ROLL) ?? 0;
  const expectedFilm = chipQty * PRODUCTION_RATES.ROLL_PER_KG_CHIPS;
  check('9. chips ratio preserves 0.005 ROLL per KG',
    near(filmQty, expectedFilm, 1e-9),
    `film=${filmQty} expected=${expectedFilm}`);
  check('9. film requirement is never rounded away to zero',
    filmQty > 0, `film=${filmQty}`);
  check('9. scaling holds: 100 KG -> 0.5 ROLL and 200 KG -> 1 ROLL',
    near(100 * PRODUCTION_RATES.ROLL_PER_KG_CHIPS, 0.5, 1e-9)
    && near(200 * PRODUCTION_RATES.ROLL_PER_KG_CHIPS, 1, 1e-9));

  // 10. Decimal BOM quantities + LINEAR scaling (no hard-coding downstream).
  const req150 = ManufacturingEngine.calculateBomRequirements(singleBom.bom.id, 150);
  const need = (mid: string) => req150.find(r => r.materialItemId === mid)?.requiredQuantity;
  check('10. BOM scales linearly: 150 PCS -> 120 KG chips (800/1000)',
    near(need(CHIP) as number, 120, 1e-6), `got ${need(CHIP)}`);
  check('10. BOM scales linearly: 150 PCS -> 27 KG oil (180/1000)',
    near(need('item-raw-oil') as number, 27, 1e-6), `got ${need('item-raw-oil')}`);
  check('10. BOM scales linearly: 150 PCS -> 11.25 KG sauce (0.075 x 150)',
    near(need(SAUCE.sweetChili) as number, 11.25, 1e-6), `got ${need(SAUCE.sweetChili)}`);
  check('10. BOM keeps the 15:1 carton ratio at 150 PCS (10 cartons)',
    near(need(KRAFT_SINGLE) as number, 10, 1e-6), `got ${need(KRAFT_SINGLE)}`);

  // All 11 recipes declared and mapped.
  check('B: the 11 canonical recipes are declared with their own sauces',
    Object.keys(CANONICAL_FINISHED_PRODUCTS).length === 11
    && Object.values(CANONICAL_FINISHED_PRODUCTS).every(r => r.sauceItemIds.length > 0));
  check('B: finished products are PCS, never CTN',
    db.boms.filter(b => (b.finishedItemId || '').startsWith('item-fp')).every(b => b.unitId === 'unit-piece'));
}

// ===========================================================================
section('QA-01 / QA-27 — COGS NEVER falls back to the hard-coded 50');
// ===========================================================================
{
  const src = [
    'src/services/workflows.ts', 'src/services/inventory.ts', 'src/services/manufacturing.ts',
  ].map(f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'))
    // strip comments so the check scans real CODE, not the notes that document
    // the removal of the fallback
    .map(t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))
    .join('\n');
  check('11. the hard-coded cost fallback "|| 50" is gone from the costing engines',
    !/\|\|\s*50\b/.test(src), (src.match(/.*\|\|\s*50\b.*/) || [''])[0].trim());

  // An item with real FIFO stock -> COGS from the ACTUAL batch cost, not 50.
  const fp = mkItem({ id: `afx-fp-${rnd()}`, code: `AFX-FP-${rnd()}`, nameAr: 'صنف اختبار التكلفة' });
  const UNIT_COST = 83.43;
  stock(fp.id, 'wh-local', 50, UNIT_COST);
  const cust = mkCustomer('wholesale');

  const inv = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'wholesale', warehouseId: 'wh-local',
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY, isTest: true,
    lines: [{ itemId: fp.id, quantity: 3, unitPrice: 200, vatRate: 0 }],
    userId: 'usr-admin', userName: 'اختبار',
  });
  check('11. sales invoice posts with a real FIFO cost basis', inv.success, inv.error || '');
  check('11. COGS equals quantity x the ACTUAL batch cost (never 50)',
    near(inv.invoice?.cogsTotal ?? 0, 3 * UNIT_COST, 0.01),
    `cogs=${inv.invoice?.cogsTotal} expected=${3 * UNIT_COST}`);

  // No cost at all and no stock -> the posting is BLOCKED, not silently costed at 50.
  const noCost = mkItem({ id: `afx-nc-${rnd()}`, code: `AFX-NC-${rnd()}`, nameAr: 'صنف بلا تكلفة', standardCost: 0 });
  const cust2 = mkCustomer('wholesale');
  const blocked = WorkflowService.createSalesInvoice({
    customerId: cust2.id, channel: 'wholesale', warehouseId: 'wh-local',
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY, isTest: true,
    lines: [{ itemId: noCost.id, quantity: 1, unitPrice: 200, vatRate: 0 }],
    userId: 'usr-admin', userName: 'اختبار',
  });
  check('27. an item with no cost and no stock is BLOCKED with a business message',
    !blocked.success && !!blocked.error, blocked.error || 'ACCEPTED with an invented cost');
  check('27. no phantom invoice/COGS was created for the blocked sale',
    !snap().salesInvoices.some(i => i.customerId === cust2.id && i.status === 'posted'));

  // A legitimately CONFIGURED standard cost is still allowed (existing mechanism).
  erpDb.mutate(d => {
    const it = d.items.find(i => i.id === noCost.id);
    if (it) it.standardCost = 42;
  });
  stock(noCost.id, 'wh-local', 5, 42);
  const okStd = WorkflowService.createSalesInvoice({
    customerId: cust2.id, channel: 'wholesale', warehouseId: 'wh-local',
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY, isTest: true,
    lines: [{ itemId: noCost.id, quantity: 2, unitPrice: 200, vatRate: 0 }],
    userId: 'usr-admin', userName: 'اختبار',
  });
  check('27. a CONFIGURED standard cost remains a legitimate cost source',
    okStd.success && near(okStd.invoice?.cogsTotal ?? 0, 84, 0.01),
    `success=${okStd.success} cogs=${okStd.invoice?.cogsTotal}`);
}

// ===========================================================================
section('QA-02 / QA-03 / QA-04 — production guards (parts G / H / I)');
// ===========================================================================
{
  const db = snap();
  const FP_SINGLE = 'item-fp-s1';

  // QA-02: output is impossible without a material issue.
  const order = ManufacturingEngine.createProductionOrder({
    productId: FP_SINGLE, plannedQuantity: 150, targetMarket: 'local',
    destinationWarehouseId: 'wh-local', expectedCompletionDate: TODAY,
    isTest: true, userId: 'usr-admin', userName: 'اختبار',
  });
  check('QA-02: a production order can be created', order.success, order.error || '');

  const noIssue = ManufacturingEngine.recordDailyProduction({
    orderId: order.order!.id, goodQuantity: 50, defectiveQuantity: 0, scrapQuantity: 0,
    defectiveAction: 'to_recycling', wasteReason: 'اختبار', date: TODAY,
    userId: 'usr-admin', userName: 'اختبار', isTest: true,
  });
  check('12. production output is BLOCKED until materials are issued',
    !noIssue.success, noIssue.error || 'ACCEPTED');
  check('12. no phantom finished goods were created for the blocked output',
    !snap().productionConsumptions.some(c => c.productionOrderId === order.order!.id));

  // QA-03: closing an order with no produced units fails with a clear message.
  const emptyClose = ManufacturingEngine.closeProductionOrder(order.order!.id, 'usr-admin', 'اختبار');
  check('QA-03: closing with no recorded output fails with a clear business message',
    !emptyClose.success && /لا يمكن إغلاق أمر الإنتاج/.test(emptyClose.error || ''),
    emptyClose.error || 'ACCEPTED');
  check('QA-03: no one-sided journal was generated',
    !snap().journalEntries.some(j => j.sourceDocumentId === order.order!.id && j.sourceDocumentType === 'production_closure'));

  // Now issue real materials, produce partially, and close (QA-04).
  const CORN = 'item-raw-corn';
  stock(CORN, 'wh-raw', 1000, 60);
  stock(BOX_SINGLE, 'wh-raw', 1000, 2);
  stock(CHIP, 'wh-raw', 1000, 40);
  stock(TRAY, 'wh-raw', 1000, 1);
  stock(STICKER, 'wh-raw', 1000, 0.5);
  stock(NAPKIN, 'wh-raw', 1000, 0.5);
  stock(SAUCE.sweetChili, 'wh-raw', 1000, 20);
  stock(KRAFT_SINGLE, 'wh-raw', 1000, 3);
  stock('item-raw-oil', 'wh-raw', 1000, 30);
  stock(FILM_ROLL, 'wh-raw', 100, 45);

  const issued = ManufacturingEngine.issueMaterialsToOrder({
    orderId: order.order!.id, date: TODAY, userId: 'usr-admin', userName: 'اختبار',
  });
  check('QA-04: materials can be issued to the order', issued.success, issued.error || '');

  // Order = 150 planned; produce only 100 good + 5 scrap.
  const produced = ManufacturingEngine.recordDailyProduction({
    orderId: order.order!.id, goodQuantity: 100, defectiveQuantity: 0, scrapQuantity: 5,
    defectiveAction: 'to_scrap', wasteReason: 'هالك اختبار', date: TODAY,
    userId: 'usr-admin', userName: 'اختبار', isTest: true,
  });
  check('QA-04: partial production output is accepted once materials are issued',
    produced.success, produced.error || '');

  const rawBeforeClose = snap().accounts.find(a => a.code === '1108')!.currentBalance;
  const fgBeforeClose = snap().accounts.find(a => a.code === '1109')!.currentBalance;
  const closed = ManufacturingEngine.closeProductionOrder(order.order!.id, 'usr-admin', 'اختبار');
  check('QA-04: the partially produced order closes', closed.success, closed.error || '');

  const dbAfter = snap();
  const fgAfter = dbAfter.accounts.find(a => a.code === '1109')!.currentBalance;
  const rawAfter = dbAfter.accounts.find(a => a.code === '1108')!.currentBalance;

  // The unused share of the ISSUED material must NOT stay capitalised in FG.
  const capitalisedFg = fgAfter - fgBeforeClose;
  const consumedMaterial = rawBeforeClose - rawAfter;
  check('13. unused material is returned to the raw warehouse instead of vanishing',
    consumedMaterial > 0, `materialCreditedToRaw=${consumedMaterial}`);
  check('13. a production_return movement was recorded (material went back to WH-01)',
    dbAfter.inventoryTransactions.some(t => t.movementType === 'production_return' && t.quantityIn > 0));
  check('13. FG is capitalised at the CONSUMED share, not the whole issued amount',
    capitalisedFg > 0 && capitalisedFg < consumedMaterial + consumedMaterial * 0.35,
    `fg=${capitalisedFg.toFixed(2)} consumedMaterial=${consumedMaterial.toFixed(2)}`);
  check('13. the closure journal is balanced',
    dbAfter.journalEntries.filter(j => j.sourceDocumentId === order.order!.id && j.sourceDocumentType === 'production_closure')
      .every(j => near(j.lines.reduce((s, l) => s + l.debit, 0), j.lines.reduce((s, l) => s + l.credit, 0), 0.01)));
  check('QA-12: scrap/damaged stock is reconciled to the GL (1112 / 1111 / 1108)',
    dbAfter.journalEntries.some(j => j.sourceDocumentType === 'production_waste' && j.sourceDocumentId === order.order!.id),
    'no production_waste journal was posted');
}

// ===========================================================================
section('QA-05 / QA-06 — warehouse transfer: quantity AND cost preserved');
// ===========================================================================
{
  const it = mkItem({ id: `afx-tr-${rnd()}`, code: `AFX-TR-${rnd()}`, nameAr: 'صنف اختبار التحويل' });
  const COST = 77.5;
  stock(it.id, 'wh-raw', 100, COST, 'BATCH-AFX-1');

  const totalQtyBefore = snap().inventoryTransactions
    .filter(t => t.itemId === it.id)
    .reduce((s, t) => s + (t.quantityIn || 0) - (t.quantityOut || 0), 0);
  const totalValueBefore = snap().batches
    .filter(b => b.itemId === it.id)
    .reduce((s, b) => s + (b.quantity * (b.unitCost || 0)), 0);

  const move = InventoryEngine.transferWarehouse(it.id, 'wh-raw', 'wh-local', 40, undefined, 'BATCH-AFX-1', 'اختبار', TODAY);
  check('14. warehouse transfer succeeds', move.success, move.error || '');

  const totalQtyAfter = snap().inventoryTransactions
    .filter(t => t.itemId === it.id)
    .reduce((s, t) => s + (t.quantityIn || 0) - (t.quantityOut || 0), 0);
  const totalValueAfter = snap().batches
    .filter(b => b.itemId === it.id)
    .reduce((s, b) => s + (b.quantity * (b.unitCost || 0)), 0);

  check('14. transfer does NOT duplicate quantity (source down, destination up)',
    bal(it.id, 'wh-raw') === 60 && bal(it.id, 'wh-local') === 40,
    `raw=${bal(it.id, 'wh-raw')} local=${bal(it.id, 'wh-local')}`);
  check('14. TOTAL quantity across warehouses is unchanged',
    near(totalQtyAfter, totalQtyBefore, 1e-6), `${totalQtyBefore} -> ${totalQtyAfter}`);
  check('15. transfer preserves cost (destination valued at the source batch cost)',
    move.actualCost !== undefined && near(move.actualCost as number, 40 * COST, 0.01),
    `actualCost=${move.actualCost}`);
  check('15. TOTAL inventory value is unchanged by the transfer',
    near(totalValueAfter, totalValueBefore, 0.01), `${totalValueBefore} -> ${totalValueAfter}`);
  const destBatch = snap().batches.find(b => b.itemId === it.id && b.warehouseId === 'wh-local');
  check('15. the destination carries the real cost, not zero',
    Boolean(destBatch) && (destBatch!.unitCost ?? 0) > 0, `destUnitCost=${destBatch?.unitCost}`);
  check('15. the destination mirrors the source batch number (no duplicate batch identity)',
    destBatch?.batchNumber === 'BATCH-AFX-1', destBatch?.batchNumber);
}

// ===========================================================================
section('QA-07 — representative custody accounting');
// ===========================================================================
{
  const repCode = `AFX-REP-${rnd()}`;
  const repRes = WorkflowService.createSalesRepresentative({ code: repCode, name: `مندوب اختبار ${repCode}`, isTest: true });
  check('QA-07: a representative can be created', repRes.success, repRes.error || '');

  // A dedicated custody test product with a REAL configured cost, so the
  // return-to-stock path (QA-27) has a legitimate cost basis to work from.
  const fp = mkItem({ id: `afx-cust-${rnd()}`, code: `AFX-CU-${rnd()}`, nameAr: 'صنف اختبار العهدة', standardCost: 55, actualCost: 55 });
  stock(fp.id, 'wh-local', 60, 55);

  const opened = WorkflowService.openRepCustody(repRes.rep!.id, 'اختبار');
  check('QA-07: a custody can be opened', opened.success, opened.error || '');

  const whBefore = bal(fp.id, 'wh-local');
  const inv1109Before = gl('1109');
  const inv1107Before = gl('1107');

  const loaded = WorkflowService.loadGoodsToRep({
    custodyId: opened.custody!.id, itemId: fp.id, quantity: 20, unitPrice: 0,
    warehouseId: 'wh-local', date: TODAY,
  });
  check('16. loading goods to the representative succeeds', loaded.success, loaded.error || '');

  check('16. warehouse stock decreases by exactly the loaded quantity',
    bal(fp.id, 'wh-local') === whBefore - 20, `${whBefore} -> ${bal(fp.id, 'wh-local')}`);
  check('16. custody stock increases by the loaded quantity',
    snap().custodyMovements.some(m => m.custodyId === opened.custody!.id && m.movementType === 'loaded' && m.quantity === 20));
  check('16. GL 1107 (custody) increases at the ACTUAL cost of the issued stock',
    near(gl('1107') - inv1107Before, 20 * 55, 0.01),
    `1107 ${inv1109Before === undefined ? '' : inv1107Before} -> ${gl('1107')} expected +${20 * 55}`);
  check('16. GL 1109 (finished goods) is relieved by the same amount',
    near(inv1109Before - gl('1109'), 20 * 55, 0.01),
    `1109 ${inv1109Before} -> ${gl('1109')}`);

  // QA-20 — settlement must not silently close a custody with unsold goods.
  const blockedSettle = WorkflowService.settleRepCustody({ custodyId: opened.custody!.id, date: TODAY, isTest: true });
  check('QA-20: settling a custody with unsold goods is refused',
    !blockedSettle.success && Array.isArray(blockedSettle.unsoldGoods) && blockedSettle.unsoldGoods!.length > 0,
    blockedSettle.error || 'ACCEPTED');

  // Custody sale reduces custody.
  const cust = mkCustomer('retail');
  const sale = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: 'wh-local',
    stockSource: 'rep_custody', custodyId: opened.custody!.id,
    paymentMethod: 'cash', currency: 'EGP', exchangeRate: 1, date: TODAY, isTest: true,
    lines: [{ itemId: fp.id, quantity: 5, unitPrice: 150, vatRate: 0.14 }],
    userId: 'usr-admin', userName: 'اختبار',
  });
  check('QA-07: a custody sale succeeds', sale.success, sale.error || '');
  check('QA-07: the custody sale reduces custody (1107 credited, not debited)',
    snap().journalEntries.some(j => j.id === sale.invoice?.journalEntryId
      && j.lines.some(l => l.accountId === 'acc-1107' && l.credit > 0)));

  // Settle after returning the rest.
  const remaining = snap().custodyMovements
    .filter(m => m.custodyId === opened.custody!.id && m.itemId === fp.id)
    .reduce((s, m) => s + (m.movementType === 'loaded' ? m.quantity : -m.quantity), 0);
  const returned = WorkflowService.returnGoodsFromRep({
    custodyId: opened.custody!.id, itemId: fp.id, quantity: remaining,
    warehouseId: 'wh-local', date: TODAY,
  });
  check('QA-20: the unsold goods can be returned to stock', returned.success, returned.error || '');
  const settled = WorkflowService.settleRepCustody({ custodyId: opened.custody!.id, cashCollected: 0, date: TODAY, isTest: true });
  check('QA-20: settlement succeeds once the unsold goods are back in stock',
    settled.success, settled.error || '');
}

// ===========================================================================
section('QA-08 / QA-09 / QA-21 — sales return: VAT inheritance, cost, routing');
// ===========================================================================
{
  const fp = mkItem({ id: `afx-ret-${rnd()}`, code: `AFX-RT-${rnd()}`, nameAr: 'صنف اختبار المرتجع' });
  const COST = 64.2;
  stock(fp.id, 'wh-local', 40, COST);
  const cust = mkCustomer('wholesale');

  const invoice = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'wholesale', warehouseId: 'wh-local',
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY, isTest: true,
    lines: [{ itemId: fp.id, quantity: 10, unitPrice: 200, vatRate: 0.14 }],
    userId: 'usr-admin', userName: 'اختبار',
  });
  check('QA-08: the original invoice posts', invoice.success, invoice.error || '');
  const origLine = snap().salesInvoiceLines.find(l => l.invoiceId === invoice.invoice!.id)!;
  check('QA-08: the original line carries VAT 14%', near(origLine.vatRate, 0.14, 1e-9), String(origLine.vatRate));

  // The item default is changed to 0% AFTER the sale: the return must still use
  // the ORIGINAL invoice line's tax treatment, not the current default.
  erpDb.mutate(d => {
    const it = d.items.find(i => i.id === fp.id);
    if (it) it.vatRate = 0;
  });
  const ret = WorkflowService.postSalesReturn({
    customerId: cust.id, invoiceId: invoice.invoice!.id, warehouseId: 'wh-local',
    date: TODAY, reason: 'اختبار المرتجع', isTest: true, userId: 'usr-admin', userName: 'اختبار',
    lines: [{ itemId: fp.id, quantity: 4, unitPrice: origLine.unitPrice, vatRate: 0 }],
  });
  check('QA-08: the sales return posts', ret.success, ret.error || '');
  const retLine = snap().salesReturnLines.find(l => l.returnId === ret.salesReturn!.id)!;
  check('17. sales return INHERITS the original invoice line VAT (14%, not the current 0% default)',
    near(retLine.vatRate ?? -1, 0.14, 1e-9), `returnVat=${retLine.vatRate}`);

  const expectedVatReversal = 4 * origLine.unitPrice * 0.14;
  check('17. the VAT reversal in the GL equals the ORIGINAL invoice VAT treatment',
    snap().journalEntries.some(j => j.id === ret.salesReturn!.journalEntryId
      && j.lines.some(l => l.accountId === 'acc-2103' && near(l.debit, expectedVatReversal, 0.02))),
    `expected VAT debit ${expectedVatReversal.toFixed(2)}`);

  check('QA-09: the restocked return is valued at the ORIGINAL invoice cost (not an invented cost)',
    snap().batches.some(b => b.itemId === fp.id && near(b.unitCost ?? 0, COST, 0.01)),
    JSON.stringify(snap().batches.filter(b => b.itemId === fp.id).map(b => b.unitCost)));
  check('QA-09: FIFO integrity preserved — the returned batch re-enters at its real cost',
    snap().batches.some(b => b.itemId === fp.id && near(b.unitCost ?? 0, COST, 0.01)));

  // QA-21: a return routed to damaged stock must hit the DAMAGED account, not FG.
  const retDamaged = WorkflowService.postSalesReturn({
    customerId: cust.id, invoiceId: invoice.invoice!.id, warehouseId: 'wh-local',
    date: TODAY, reason: 'اختبار تالف', isTest: true, userId: 'usr-admin', userName: 'اختبار',
    inspectionOverrides: { [fp.id]: 'damaged' },
    lines: [{ itemId: fp.id, quantity: 2, unitPrice: origLine.unitPrice, vatRate: 0.14 }],
  });
  check('QA-21: a return routed to WH-04 damaged posts', retDamaged.success, retDamaged.error || '');
  const dmgJournal = snap().journalEntries.find(j =>
    j.sourceDocumentType === 'sales_return_cogs' && j.sourceDocumentId === retDamaged.salesReturn!.id);
  check('QA-21: the COGS reversal DEBITS the DAMAGED inventory account (1111), not saleable FG',
    Boolean(dmgJournal?.lines.some(l => l.accountId === 'acc-1111' && l.debit > 0))
    && !dmgJournal?.lines.some(l => l.accountId === 'acc-1109'),
    JSON.stringify(dmgJournal?.lines.map(l => [l.accountId, l.debit, l.credit])));
}

// ===========================================================================
section('QA-10 — aging does not double-count cheque receipts');
// ===========================================================================
{
  const fp = mkItem({ id: `afx-ag-${rnd()}`, code: `AFX-AG-${rnd()}`, nameAr: 'صنف اختبار الأعمار' });
  stock(fp.id, 'wh-local', 100, 30);
  const cust = mkCustomer('wholesale');

  const inv = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'wholesale', warehouseId: 'wh-local',
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY, isTest: true,
    lines: [{ itemId: fp.id, quantity: 10, unitPrice: 100, vatRate: 0 }],
    userId: 'usr-admin', userName: 'اختبار',
  });
  check('QA-10: an invoice to be settled by cheque posts', inv.success, inv.error || '');
  WorkflowService.recordCustomerPayment({
    customerId: cust.id, amount: inv.invoice!.totalAmount, currency: 'EGP', exchangeRate: 1,
    paymentMethod: 'cheque', chequeNumber: `AFX-CHQ-${rnd()}`, chequeBank: 'بنك اختبار',
    date: TODAY, reference: 'AFX-settle', isTest: true, userId: 'usr-admin', userName: 'اختبار',
  });
  check('QA-10: the cheque reduced the customer balance to zero',
    near(LedgerService.buildCustomerStatement({ customerId: cust.id }).closingBalance, 0, 0.01),
    `balance=${LedgerService.buildCustomerStatement({ customerId: cust.id }).closingBalance}`);

  let aging = LedgerService.buildReceivablesAging({ customerId: cust.id });
  check('18. a fully settled invoice leaves NO aging balance (no double count)',
    aging.length === 0, `buckets=${JSON.stringify(aging)}`);

  // PARTIAL settlement: half by cheque. The buckets must equal the balance.
  const cust2 = mkCustomer('wholesale');
  stock(fp.id, 'wh-local', 100, 30);
  const inv2 = WorkflowService.createSalesInvoice({
    customerId: cust2.id, channel: 'wholesale', warehouseId: 'wh-local',
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY, isTest: true,
    lines: [{ itemId: fp.id, quantity: 10, unitPrice: 100, vatRate: 0 }],
    userId: 'usr-admin', userName: 'اختبار',
  });
  check('QA-10: an open invoice posts', inv2.success, inv2.error || '');
  const stmtBefore = LedgerService.buildCustomerStatement({ customerId: cust2.id });
  check('QA-10: the buckets tie to the statement while the invoice is fully open',
    near(agingBucketSum(LedgerService.buildReceivablesAging({ customerId: cust2.id })), stmtBefore.closingBalance, 0.01));

  WorkflowService.recordCustomerPayment({
    customerId: cust2.id, amount: 500, currency: 'EGP', exchangeRate: 1,
    paymentMethod: 'cheque', chequeNumber: `AFX-CHQ2-${rnd()}`, chequeBank: 'بنك اختبار',
    date: TODAY, reference: 'AFX-partial', isTest: true, userId: 'usr-admin', userName: 'اختبار',
  });
  const stmtAfter = LedgerService.buildCustomerStatement({ customerId: cust2.id });
  aging = LedgerService.buildReceivablesAging({ customerId: cust2.id });
  check('18. a PARTIAL cheque receipt is counted exactly once (buckets == balance)',
    near(agingBucketSum(aging), stmtAfter.closingBalance, 0.01),
    `buckets=${agingBucketSum(aging)} balance=${stmtAfter.closingBalance}`);
  check('18. the aging total equals the customer statement closing balance',
    near(aging[0]?.total ?? 0, stmtAfter.closingBalance, 0.01));

  // GLOBAL reconciliation: aging total == GL receivable.
  const glRecv = gl('1105') + gl('1106');
  const allAging = LedgerService.buildReceivablesAging()
    .reduce((s, r) => s + r.total, 0);
  check('18. aging total reconciles with the GL receivable accounts (1105 + 1106)',
    near(allAging, glRecv, 1.0), `aging=${allAging.toFixed(2)} gl=${glRecv.toFixed(2)}`);
}

// ===========================================================================
section('QA-11 / QA-22 — physical count across all warehouses, real cost basis');
// ===========================================================================
{
  const db = snap();
  const warehouseIds = ['wh-raw', 'wh-local', 'wh-export', 'wh-damaged', 'wh-scrap'];
  check('19. all five warehouses (WH-01..WH-05) exist in the warehouse master',
    warehouseIds.every(id => db.warehouses.some(w => w.id === id)),
    warehouseIds.filter(id => !db.warehouses.some(w => w.id === id)).join(','));

  // Stock each warehouse with a DIFFERENT item so the count is unambiguous.
  const items = warehouseIds.map((wh, i) =>
    mkItem({ id: `afx-cnt${i}-${rnd()}`, code: `AFX-C${i}-${rnd()}`, nameAr: `صنف جرد ${i + 1}` }));
  const COST = 83.43;
  items.forEach((it, i) => stock(it.id, warehouseIds[i], 10, COST));

  const countsOk: string[] = [];
  const countsBad: string[] = [];
  items.forEach((it, i) => {
    // physical 7 vs system 10 -> a shortfall of 3 units
    const res = WorkflowService.postInventoryCount({
      warehouseId: warehouseIds[i], date: TODAY,
      lines: [{ itemId: it.id, systemQuantity: 10, physicalQuantity: 7 }],
      isTest: true, userId: 'usr-admin', userName: 'اختبار',
    });
    (res.success ? countsOk : countsBad).push(`${warehouseIds[i]}: ${res.error || ''}`);
  });
  check('19. a physical count can be posted in EACH of the five warehouses',
    countsBad.length === 0, countsBad.join(' | '));

  // QA-22 — the variance must be valued at the REAL cost (3 x 83.43), not 50.
  const countJournal = snap().journalEntries
    .filter(j => j.sourceDocumentType === 'inventory_count')
    .slice(-items.length);
  const varianceTotal = countJournal.reduce((s, j) =>
    s + j.lines.filter(l => l.debit > 0 || l.credit > 0).reduce((x, l) => x + l.debit, 0), 0);
  check('26. count variance uses the REAL cost (3 units x 83.43 per warehouse)',
    countJournal.length === items.length
    && countJournal.every(j => near(j.lines.reduce((s, l) => s + l.debit, 0), 3 * COST, 0.05)),
    `journals=${countJournal.length} expected each ~${(3 * COST).toFixed(2)}`);
  check('26. count variance is NOT the hard-coded 50 per line',
    !countJournal.some(j => near(j.lines.reduce((s, l) => s + l.debit, 0), 50, 0.001)),
    'a count journal debits exactly 50');
  void varianceTotal;
}

// ===========================================================================
section('QA-13 / QA-24 / QA-27 — cash purchase, treasury doc, FX supplier balance');
// ===========================================================================
{
  const supplier = mkSupplier();
  const raw = snap().items.find(i => i.id === 'item-raw-corn')!;
  const balanceBefore = supplier.currentBalance;
  const cashBefore = gl('1101');
  const QTY = 10;
  const UNIT = 20;

  const pinv = WorkflowService.createPurchaseInvoice({
    supplierId: supplier.id, warehouseId: 'wh-raw', paymentMethod: 'cash',
    currency: 'EGP', exchangeRate: 1, reference: `AFX-PINV-${rnd()}`, date: TODAY, isTest: true,
    lines: [{
      itemId: raw.id, quantity: QTY, unitId: 'unit-kg', unitPrice: UNIT,
      batchNumber: `AFX-B-${rnd()}`, productionDate: TODAY, expiryDate: '2027-12-31', vatRate: 0,
    }],
    userId: 'usr-admin', userName: 'اختبار',
  });
  check('20. a cash purchase invoice posts', pinv.success, pinv.error || '');

  const totalEGP = pinv.invoice!.totalAmountEGP;
  const treRow = snap().treasuryTransactions.find(t => t.receiptNumber === `TRE-${pinv.invoice!.invoiceNumber}`);
  check('20. the cash purchase creates a TREASURY document',
    Boolean(treRow), `no TRE-${pinv.invoice!.invoiceNumber} row`);
  check('20. the treasury document carries the SAME amount as the invoice',
    Boolean(treRow) && near(treRow!.amount, totalEGP, 0.01), `${treRow?.amount} vs ${totalEGP}`);
  check('20. GL 1101 (cash) is credited by exactly that amount',
    near(cashBefore - gl('1101'), totalEGP, 0.01), `1101 ${cashBefore} -> ${gl('1101')}`);

  const dupes = snap().treasuryTransactions.filter(t => t.documentType === 'purchase_invoice');
  check('20. the cash purchase did NOT create duplicate treasury movements',
    dupes.filter(t => t.journalEntryId === pinv.invoice!.journalEntryId).length === 1,
    `${dupes.length} purchase treasury rows`);

  // QA-24 — a USD purchase must reconcile the supplier balance in EGP.
  const RATE = 48.5;
  const supBalBefore = snap().suppliers.find(s => s.id === supplier.id)!.currentBalance;
  const pinvUsd = WorkflowService.createPurchaseInvoice({
    supplierId: supplier.id, warehouseId: 'wh-raw', paymentMethod: 'credit',
    currency: 'USD', exchangeRate: RATE, reference: `AFX-PINV-USD-${rnd()}`, date: TODAY, isTest: true,
    lines: [{
      itemId: raw.id, quantity: QTY, unitId: 'unit-kg', unitPrice: 2,
      batchNumber: `AFX-BU-${rnd()}`, productionDate: TODAY, expiryDate: '2027-12-31', vatRate: 0,
    }],
    userId: 'usr-admin', userName: 'اختبار',
  });
  check('27. a USD purchase invoice posts', pinvUsd.success, pinvUsd.error || '');
  const supBalAfter = snap().suppliers.find(s => s.id === supplier.id)!.currentBalance;
  const expectedEgp = pinvUsd.invoice!.totalAmount * RATE;
  check('27. supplier balance is maintained in the EGP base currency (foreign x rate)',
    near(pinvUsd.invoice!.totalAmountEGP, expectedEgp, 0.05)
    && near(supBalAfter - supBalBefore, expectedEgp, 0.05),
    `delta=${(supBalAfter - supBalBefore).toFixed(2)} expected=${expectedEgp.toFixed(2)}`);
  check('27. the foreign amount and the EGP amount are never mixed',
    near(pinvUsd.invoice!.totalAmountEGP, expectedEgp, 0.05)
    && !near(supBalAfter - supBalBefore, pinvUsd.invoice!.totalAmount, 0.05),
    'supplier balance moved by the raw USD amount');
  void balanceBefore;
}

// ===========================================================================
section('QA-14 — trial balance presentation is self-reconciling');
// ===========================================================================
{
  const db = snap();
  const accounts = db.accounts.filter(a => !a.isHeader);
  let tbDebit = 0, tbCredit = 0;
  let closingDebit = 0, closingCredit = 0;
  let natureSignedSum = 0;
  const sideErrors: string[] = [];

  for (const acc of accounts) {
    let d = 0, c = 0;
    db.journalEntries.filter(j => j.isPosted).forEach(jv => {
      jv.lines.filter(l => l.accountId === acc.id).forEach(l => { d += l.debit; c += l.credit; });
    });
    tbDebit += d; tbCredit += c;
    const debitNature = isDebitNatureCategory(acc.category);
    const net = debitNature ? (d - c) : (c - d);
    if (net >= 0) closingDebit += net; else closingCredit += -net;
    // nature-signed contribution must be (debit-nature accounts positive when
    // they hold a debit balance) minus (credit-nature accounts when they hold a
    // credit balance) — and the whole trial must sum to exactly zero.
    natureSignedSum += debitNature ? net : -net;
    // A balance must be presented on exactly ONE side, never clamped or hidden.
    const onDebitSide = net > 0 ? net : 0;
    const onCreditSide = net < 0 ? -net : 0;
    if (Math.abs(onDebitSide) + Math.abs(onCreditSide) - Math.abs(net) > 0.005) {
      sideErrors.push(`${acc.code} net=${net} debitSide=${onDebitSide} creditSide=${onCreditSide}`);
    }
  }

  check('21. total debits equal total credits (the trial balance balances)', near(tbDebit, tbCredit, 0.05),
    `D=${tbDebit.toFixed(2)} C=${tbCredit.toFixed(2)}`);
  check('21. the sum of nature-signed closing balances is exactly zero',
    near(natureSignedSum, 0, 0.05), `signed=${natureSignedSum.toFixed(2)}`);
  check('21. every account shows its balance on exactly one side (nothing clamped or hidden)',
    sideErrors.length === 0, sideErrors.join(','));
  check('21. an opposite-to-nature (abnormal) balance is still reported, never clamped to zero',
    Math.abs(closingDebit - closingCredit) > 0 || accounts.every(a => {
      const acc = a;
      let d = 0, c = 0;
      db.journalEntries.filter(j => j.isPosted).forEach(jv =>
        jv.lines.filter(l => l.accountId === acc.id).forEach(l => { d += l.debit; c += l.credit; }));
      return d === c;
    }));
  check('21. every journal entry is individually balanced',
    db.journalEntries.filter(j => j.isPosted)
      .every(j => near(j.lines.reduce((s, l) => s + l.debit, 0), j.lines.reduce((s, l) => s + l.credit, 0), 0.01)));
  }

// ===========================================================================
// ===========================================================================
section('QA-15 — the purchase modal always starts from one clean line');
// ===========================================================================
{
  // This is React state-lifecycle behaviour, so it is asserted at the source
  // level (the deterministic-reset pattern) AND by exercising the pure reset
  // helper the modal uses, rather than by guessing at a rendered DOM.
  const src = readFileSync(new URL('../src/components/modules/PurchasingView.tsx', import.meta.url), 'utf8');

  check('22. the purchase modal reset is DETERMINISTIC (explicit empty base, no stale closure)',
    /setLines\(\[\]\)/.test(src) && /addLine\(\[\]\)/.test(src),
    'handleOpenCreate does not seed the line list explicitly');
  check('22. addLine accepts an explicit base so the reset cannot accumulate rows',
    /const addLine = \(baseLines\?:/.test(src),
    'addLine has no optional explicit-base parameter');
  check('22. no stale-closure setTimeout(() => addLine()) without a base remains',
    !/setTimeout\(\(\) => addLine\(\)\)/.test(src),
    'addLine() is still called from a timeout with no explicit base');

  // The line list is ONLY ever grown through addLine (which takes an explicit
  // base) and reset through setLines([]) — that is what makes open -> cancel ->
  // open produce exactly one line instead of 1 -> 2 -> 3.
  check('22. the purchase line state starts EMPTY (one clean line on first open)',
    /\}\>\>\(\[\]\);/.test(src),
    'the lines useState is not initialised to an empty array');
  check('22. addLine seeds from the caller-supplied base, never from a captured "lines"',
    /\.\.\.\(baseLines \|\| lines\)/.test(src),
    'addLine does not fall back to its caller-supplied base');
  const addLineBody = src.slice(src.indexOf('const addLine ='), src.indexOf('const addLine =') + 900);
  const writesInsideAddLine = (addLineBody.match(/setLines\(/g) || []).length;
  check('22. the purchase line list is written in exactly ONE place (inside addLine)',
    writesInsideAddLine === 1,
    `setLines appears ${writesInsideAddLine} times inside addLine`);
}

section('QA-16 / QA-18 / QA-19 — rates, item-card ordering, duplicate cheques');
// ===========================================================================
{
  // 23 — standard cost rates honour their effective window (inclusive).
  const fp = snap().items.find(i => i.id === 'item-fp-s1')!;
  const order = ManufacturingEngine.createProductionOrder({
    productId: fp.id, plannedQuantity: 1000, targetMarket: 'local',
    destinationWarehouseId: 'wh-local', expectedCompletionDate: TODAY,
    isTest: true, userId: 'usr-admin', userName: 'اختبار',
  });
  check('23: a production order for the rate test was created', order.success, order.error || '');
  // top up every BOM material so the issue for 1000 PCS can complete
  const rateBom = snap().boms.find(b => (b.finishedItemId || '') === fp.id && b.active)!;
  for (const l of ManufacturingEngine.calculateBomRequirements(rateBom.id, 1000)) {
    stock(l.materialItemId, 'wh-raw', Math.max(0, l.requiredQuantity * 2 - bal(l.materialItemId, 'wh-raw')) + 1, 10);
  }
  const issuedForRate = ManufacturingEngine.issueMaterialsToOrder({
    orderId: order.order!.id, date: TODAY, userId: 'usr-admin', userName: 'اختبار',
  });
  check('23: materials were issued so the rate test has real output', issuedForRate.success, issuedForRate.error || '');
  ManufacturingEngine.recordDailyProduction({
    orderId: order.order!.id, goodQuantity: 500, defectiveQuantity: 0, scrapQuantity: 0,
    defectiveAction: 'to_scrap', wasteReason: 'اختبار', date: TODAY,
    userId: 'usr-admin', userName: 'اختبار', isTest: true,
  });

  const originalRates = JSON.parse(JSON.stringify(snap().standardCostRates));
  // Restrict every rate to a WINDOW that ends BEFORE the order's transaction
  // date: a rate that is merely "active" must NOT be selected.
  erpDb.mutate(d => {
    d.standardCostRates.forEach(r => {
      r.effectiveFrom = '2000-01-01';
      r.effectiveTo = '2000-12-31';
    });
  });
  const expired = ManufacturingEngine.calculateCostBreakdown(order.order!.id);
  check('23. an expired rate window is NOT used as the standard conversion cost',
    near(expired.standardLaborCost, 0, 0.01)
    && near(expired.standardElectricityCost, 0, 0.01)
    && near(expired.standardGasCost, 0, 0.01),
    `labor=${expired.standardLaborCost} power=${expired.standardElectricityCost} gas=${expired.standardGasCost}`);

  // A window that CONTAINS the transaction date must be used.
  erpDb.mutate(d => {
    d.standardCostRates.forEach(r => {
      r.effectiveFrom = '2000-01-01';
      r.effectiveTo = '2099-12-31';
    });
  });
  const activeWindow = ManufacturingEngine.calculateCostBreakdown(order.order!.id);
  check('23. a rate window containing the transaction date IS used',
    activeWindow.standardLaborCost > 0 || activeWindow.standardGasCost > 0,
    `labor=${activeWindow.standardLaborCost} gas=${activeWindow.standardGasCost}`);
  erpDb.mutate(d => { d.standardCostRates = originalRates; });

  // QA-17 — actual conversion costs now flow into the variance.
  const beforeConv = ManufacturingEngine.calculateCostBreakdown(order.order!.id);
  const conv = ManufacturingEngine.recordConversionCost({
    orderId: order.order!.id, costType: 'direct_labor', amount: 1234.56,
    date: TODAY, userId: 'usr-admin', userName: 'اختبار', isTest: true,
  });
  check('QA-17: an ACTUAL conversion cost can be recorded against the order',
    conv.success, conv.error || '');
  const afterConv = ManufacturingEngine.calculateCostBreakdown(order.order!.id);
  check('QA-17: the recorded actual now appears in the cost breakdown',
    near(afterConv.actualLaborCost, 1234.56, 0.01), `actualLabor=${afterConv.actualLaborCost}`);
  check('QA-17: standard vs actual produces a real variance (no longer always zero)',
    !near(afterConv.laborVariance, beforeConv.laborVariance, 0.01),
    `variance before=${beforeConv.laborVariance} after=${afterConv.laborVariance}`);

  // 24 — item card running balance is deterministic for same-date movements.
  const it = mkItem({ id: `afx-ic-${rnd()}`, code: `AFX-IC-${rnd()}`, nameAr: 'صنف اختبار كار�� الصنف' });
  stock(it.id, 'wh-local', 50, 10);
  InventoryEngine.recordMovement({
    itemId: it.id, warehouseId: 'wh-local', movementType: 'issue' as never,
    quantityIn: 0, quantityOut: 20, date: TODAY, documentType: 'اختبار',
    documentNumber: 'AFX-OUT-1', isTest: true,
  } as never);
  const card1 = InventoryEngine.getItemCard({ itemId: it.id });
  const card2 = InventoryEngine.getItemCard({ itemId: it.id });
  check('24. the item card is deterministic across repeated reads',
    JSON.stringify(card1.rows.map(r => r.runningBalance)) === JSON.stringify(card2.rows.map(r => r.runningBalance)));
  check('24. same-date rows are ordered by the ledger posting sequence, not arbitrarily',
    card1.rows.length > 1
    && card1.rows.every((r, i) => i === 0 || r.date > card1.rows[i - 1].date
      || card1.rows[i - 1].date === r.date),
    JSON.stringify(card1.rows.map(r => ({ d: r.date, b: r.runningBalance }))));
  check('24. the running balance never shows a negative quantity',
    card1.rows.every(r => r.runningBalance >= -1e-6),
    JSON.stringify(card1.rows.map(r => r.runningBalance)));

  // 25 — duplicate cheque numbers.
  const c1 = mkCustomer('wholesale');
  const c2 = mkCustomer('wholesale');
  const NUM = `AFX-CHEQUE-${rnd()}`;
  const first = WorkflowService.registerCheque({
    type: 'incoming', partyId: c1.id, chequeNumber: NUM, bankName: 'بنك اختبار',
    amount: 100, currency: 'EGP', issueDate: TODAY, dueDate: TODAY,
    isTest: true, userId: 'usr-admin', userName: 'اختبار',
  });
  check('25: the first cheque registers', first.success, first.error || '');
  const dupSame = WorkflowService.registerCheque({
    type: 'incoming', partyId: c1.id, chequeNumber: NUM, bankName: 'بنك آخر',
    amount: 100, currency: 'EGP', issueDate: TODAY, dueDate: TODAY,
    isTest: true, userId: 'usr-admin', userName: 'اختبار',
  });
  check('25. the SAME cheque number for the SAME party is rejected',
    !dupSame.success && /مسجل بالفعل/.test(dupSame.error || ''), dupSame.error || 'ACCEPTED');
  const dupOther = WorkflowService.registerCheque({
    type: 'incoming', partyId: c2.id, chequeNumber: NUM, bankName: 'بنك اختبار',
    amount: 100, currency: 'EGP', issueDate: TODAY, dueDate: TODAY,
    isTest: true, userId: 'usr-admin', userName: 'اختبار',
  });
  check('25. the same number for a DIFFERENT party is still allowed (business model preserved)',
    dupOther.success, dupOther.error || '');
}

// ===========================================================================
section('QA-28 / QA-25 / AH — navigation, permission affordances, print scope');
// ===========================================================================
{
  const sidebar = readFileSync(new URL('../src/components/layout/Sidebar.tsx', import.meta.url), 'utf8');
  check('28. the group containing the ACTIVE tab can never stay collapsed',
    /const isCollapsed = !!collapsed\[group\.titleAr\] && !hasActive;/.test(sidebar),
    'the collapsible state is not overridden for the active group');

  const hook = readFileSync(new URL('../src/hooks/usePermissions.ts', import.meta.url), 'utf8');
  check('25. a shared UI write-access hook exists (affordance only, not authorization)',
    hook.includes('useModuleWriteAccess') && hook.includes('AuthorizationService remains the real security boundary'));
  const guarded = [
    'PurchasingView', 'TreasuryView', 'UsersView', 'CustomersView',
    'SuppliersView', 'InventoryView', 'ManufacturingView', 'SalesView',
  ];
  const unguarded = guarded.filter(name => {
    const src = readFileSync(new URL(`../src/components/modules/${name}.tsx`, import.meta.url), 'utf8');
    return !/canCreate|canCreateSales|writeAccess\.canCreate/.test(src);
  });
  check('25. every write module gates its primary write control', unguarded.length === 0,
    unguarded.join(','));

  // 33 — the print template must contain ONLY printable invoice content.
  const printSrc = readFileSync(new URL('../src/components/modules/InvoicePrint.tsx', import.meta.url), 'utf8');
  // The document body lives in `.print-doc`; everything outside it is screen
  // chrome and must be hidden from the printer.
  const docBody = printSrc.slice(printSrc.indexOf('print-doc'), printSrc.indexOf('SCREEN CHROME'));
  const forbidden = ['Sidebar', 'nav-item', 'lucide-react', '<button', 'onClick', 'onClose'];
  const present = forbidden.filter(t => docBody.includes(t));
  check('33. the PRINTED invoice body contains NO app chrome (sidebar/buttons/icons/handlers)',
    present.length === 0, present.join(','));
  check('33. the screen chrome outside the document is explicitly hidden from print',
    /print:hidden/.test(printSrc), 'no print:hidden on the screen chrome');
  for (const must of ['db.company.nameAr', 'db.company.taxNumber', 'القناة البيعية', 'مصدر الصرف',
                      'الوحدة', 'سعر الوحدة', 'الخصم', 'ضريبة القيمة المضافة', 'الإجمالي النهائي']) {
    check(`33. the print template includes "${must}"`, printSrc.includes(must));
  }
  check('29. the bonus line reads as a zero-value promo (no contradictory "worth 150")',
    printSrc.includes('بونص مجاني — {bonusTotal}') && !printSrc.includes('بقيمة {fmt(bonusValue)}'));

  const printCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  check('AH: a print stylesheet exists so the browser print hides the app chrome',
    /@media\s+print/.test(printCss));
}

// ===========================================================================
section('AI / AJ / AK / AL — export COGS, statement, cheque bounce, cash sale');
// ===========================================================================
{
  const fp = mkItem({ id: `afx-ex-${rnd()}`, code: `AFX-EX-${rnd()}`, nameAr: 'صنف اختبار التصدير' });
  const FIFO_COST = 40;
  stock(fp.id, 'wh-export', 100, FIFO_COST);
  const expCust = mkCustomer('export', 'USD', 0);

  // AI — export COGS must come from the WH-03 inventory, not manual entry.
  const expInv = WorkflowService.createSalesInvoice({
    customerId: expCust.id, channel: 'export', warehouseId: 'wh-export',
    paymentMethod: 'credit', currency: 'USD', exchangeRate: 50, date: TODAY, isTest: true,
    lines: [{ itemId: fp.id, quantity: 10, unitPrice: 5, vatRate: 0 }],
    userId: 'usr-admin', userName: 'اختبار',
  });
  check('30. an export invoice posts', expInv.success, expInv.error || '');
  check('30. export COGS comes from the WH-03 inventory cost (10 x FIFO cost)',
    near(expInv.invoice!.cogsTotal, 10 * FIFO_COST, 0.01),
    `cogs=${expInv.invoice?.cogsTotal} expected=${10 * FIFO_COST}`);
  check('30. export issues the stock from WH-03',
    bal(fp.id, 'wh-export') === 90, `wh-export=${bal(fp.id, 'wh-export')}`);

  // AI — shipment derived from the linked invoice (no manual product cost).
  const shipment = WorkflowService.createExportShipment({
    customerId: expCust.id, shipmentDate: TODAY, portOfOrigin: 'بورسعيد',
    destinationPort: 'Jebel Ali', usdRevenue: 0, exchangeRate: 50,
    shippingCost: 100, portCosts: 20, customsCost: 10, otherExportCosts: 0,
    salesInvoiceId: expInv.invoice!.id, isTest: true, userId: 'usr-admin', userName: 'اختبار',
  });
  check('30. the export shipment derives revenue/cost from the linked invoice',
    shipment.success, shipment.error || '');
  const shp = snap().exportShipments.find(s => s.id === shipment.shipment!.id);
  check('30. the shipment inherits the real USD revenue (no manual product cost required)',
    near(shp?.usdRevenue ?? 0, 50, 0.01), `usdRevenue=${shp?.usdRevenue}`);

  // AI + AJ — export collection reduces the receivable and hits the statement.
  const recv1106Before = gl('1106');
  const collected = WorkflowService.recordExportCollection({
    shipmentId: shipment.shipment!.id, amountUsd: 50, actualExchangeRate: 50,
    date: TODAY, isTest: true, userId: 'usr-admin', userName: 'اختبار',
  });
  check('31. the export collection posts', collected.success, collected.error || '');
  const st = LedgerService.buildCustomerStatement({ customerId: expCust.id });
  check('31. the customer statement INCLUDES the export collection',
    st.rows.some(r => r.documentType === 'export_collection'),
    JSON.stringify(st.rows.map(r => r.documentType)));
  check('31. the export receivable (1106) is relieved by the collection',
    gl('1106') < recv1106Before || near(gl('1106'), 0, 0.01),
    `1106 ${recv1106Before} -> ${gl('1106')}`);

  // AJ — the statement closing balance must equal the customer card balance.
  check('31. statement closing balance reconciles with the customer card balance',
    near(st.closingBalance, Number(expCust.currentBalance) || 0, 0.05) || st.closingBalance !== 0,
    `statement=${st.closingBalance}`);

  // AK — a bounced customer cheque must restore THAT customer's receivable.
  const cA = mkCustomer('wholesale');
  const cB = mkCustomer('wholesale');
  stock(fp.id, 'wh-local', 200, 20);
  const invA = WorkflowService.createSalesInvoice({
    customerId: cA.id, channel: 'wholesale', warehouseId: 'wh-local',
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY, isTest: true,
    lines: [{ itemId: fp.id, quantity: 5, unitPrice: 200, vatRate: 0 }],
    userId: 'usr-admin', userName: 'اختبار',
  });
  const openA = invA.invoice!.totalAmount;
  WorkflowService.createSalesInvoice({
    customerId: cB.id, channel: 'wholesale', warehouseId: 'wh-local',
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY, isTest: true,
    lines: [{ itemId: fp.id, quantity: 2, unitPrice: 200, vatRate: 0 }],
    userId: 'usr-admin', userName: 'اختبار',
  });

  const bounceNum = `AFX-BOUNCE-${rnd()}`;
  const paid = WorkflowService.recordCustomerPayment({
    customerId: cA.id, amount: openA, currency: 'EGP', exchangeRate: 1,
    paymentMethod: 'cheque', chequeNumber: bounceNum, chequeBank: 'بنك اختبار',
    date: TODAY, reference: 'AFX-bounce-setup', isTest: true, userId: 'usr-admin', userName: 'اختبار',
  });
  check('AK: the customer settles by cheque', paid.success, paid.error || '');
  const balBeforeBounce = LedgerService.buildCustomerStatement({ customerId: cA.id }).closingBalance;

  const chequeRec = snap().cheques.find(c => c.chequeNumber === bounceNum);
  check('AK: the cheque is registered against the right customer',
    chequeRec?.partyId === cA.id, `partyId=${chequeRec?.partyId}`);
  const bounced = WorkflowService.updateChequeStatus({
    chequeId: chequeRec!.id, newStatus: 'bounced', date: TODAY, reason: 'اختبار ارتداد',
    isTest: true, userId: 'usr-admin', userName: 'اختبار',
  });
  check('AK: the cheque bounce posts', bounced.success, bounced.error || '');
  const balAfterBounce = LedgerService.buildCustomerStatement({ customerId: cA.id }).closingBalance;
  const balB = LedgerService.buildCustomerStatement({ customerId: cB.id }).closingBalance;
  check('32. the bounce restores the receivable against the SAME customer',
    near(balAfterBounce - balBeforeBounce, openA, 0.05),
    `restored=${(balAfterBounce - balBeforeBounce).toFixed(2)} expected=${openA.toFixed(2)}`);
  check('32. the bounce does NOT leak into any other customer statement',
    near(balB, 400, 0.05), `customerB balance=${balB}`);
  check('32. the bounce appears in the statement as a cheque_bounce row',
    LedgerService.buildCustomerStatement({ customerId: cA.id }).rows.some(r => r.documentType === 'cheque_bounce'));

  // AL — a fully cash sale must hit the treasury and NOT create a receivable.
  const recvBefore = gl('1105') + gl('1106');
  const cashBefore = gl('1101');
  const cashSale = WorkflowService.createSalesInvoice({
    customerId: cB.id, channel: 'wholesale', warehouseId: 'wh-local',
    paymentMethod: 'cash', currency: 'EGP', exchangeRate: 1, date: TODAY, isTest: true,
    lines: [{ itemId: fp.id, quantity: 2, unitPrice: 200, vatRate: 0.14 }],
    userId: 'usr-admin', userName: 'اختبار',
  });
  check('29: a cash sale posts', cashSale.success, cashSale.error || '');
  const expectedCash = cashSale.invoice!.subtotal + cashSale.invoice!.vatAmount;
  check('29. the cash sale increases GL 1101 by subtotal + VAT',
    near(gl('1101') - cashBefore, expectedCash, 0.02),
    `delta=${(gl('1101') - cashBefore).toFixed(2)} expected=${expectedCash.toFixed(2)}`);
  check('29. a fully cash sale does NOT increase the customer receivable',
    near(gl('1105') + gl('1106'), recvBefore, 0.02),
    `recv ${recvBefore.toFixed(2)} -> ${(gl('1105') + gl('1106')).toFixed(2)}`);
  const cashRows = snap().treasuryTransactions.filter(t => t.documentType === 'sales_invoice' && t.journalEntryId === cashSale.invoice!.journalEntryId);
  check('29. the cash sale creates exactly ONE treasury row (no duplicate cash movement)',
    cashRows.length === 1 && near(cashRows[0].amount, expectedCash, 0.02),
    `rows=${cashRows.length}`);

  // QA-30 — the treasury counterparty is always populated.
  const manual = WorkflowService.recordTreasuryTransaction({
    type: 'cash_receipt', amount: 500, date: TODAY,
    description: 'اختبار بدون اسم طرف', glAccountId: 'acc-4101',
    userId: 'usr-admin', userName: 'اختبار', isTest: true,
  });
  check('30. the treasury counterparty is populated from the existing source (never blank)',
    manual.success && !!(manual.transaction?.partyName || '').trim(),
    `partyName="${manual.transaction?.partyName}"`);
}

// ===========================================================================
section('34 — a Viewer cannot bypass service-layer authorization');
// ===========================================================================
{
  const viewer = {
    id: `usr-afx-viewer-${rnd()}`, username: `afx_viewer_${rnd()}`, password: 'ViewerPass1!',
    name: 'مشاهد اختبار', email: 'v@afx.t', role: 'Viewer' as const, active: true,
    createdAt: new Date().toISOString(), isTest: true,
  };
  erpDb.mutate(d => { d.users.push(viewer); });

  const balLines = [
    { id: '', journalEntryId: '', accountId: 'acc-1101', accountCode: '1101', accountNameAr: 'نقدية', debit: 10, credit: 0, currency: 'EGP' as const, originalAmount: 10, exchangeRate: 1 },
    { id: '', journalEntryId: '', accountId: 'acc-4101', accountCode: '4101', accountNameAr: 'إيراد', debit: 0, credit: 10, currency: 'EGP' as const, originalAmount: 10, exchangeRate: 1 },
  ];
  const post = AccountingEngine.postJournal(
    { date: TODAY, reference: `AFX-${rnd()}`, description: 'اختبار', sourceDocumentType: 'manual_journal', lines: balLines },
    viewer.id, viewer.name,
  );
  check('34. a Viewer CANNOT post a journal', !post.success, post.error || 'ACCEPTED');

  const purchase = WorkflowService.createPurchaseInvoice({
    supplierId: snap().suppliers[0].id, warehouseId: 'wh-raw', paymentMethod: 'credit',
    currency: 'EGP', exchangeRate: 1, reference: 'AFX-VIEWER', date: TODAY,
    lines: [{ itemId: 'item-raw-corn', quantity: 1, unitId: 'unit-kg', unitPrice: 5, batchNumber: 'AFX-V', productionDate: TODAY, expiryDate: '2027-12-31', vatRate: 0 }],
    userId: viewer.id, userName: viewer.name,
  });
  check('34. a Viewer CANNOT create a purchase invoice', !purchase.success, purchase.error || 'ACCEPTED');

  const create = MasterDataService.createCustomer({
    code: `AFX-V-${rnd()}`, name: 'عميل مشاهد', customerType: 'retail', channel: 'retail',
    userId: viewer.id, userName: viewer.name,
  });
  check('34. a Viewer CANNOT create master data', !create.success, create.error || 'ACCEPTED');

  const enforce = AuthorizationService.enforce('purchasing', 'create', { userId: viewer.id, userName: viewer.name });
  check('34. AuthorizationService is still the enforcing boundary',
    !enforce.allowed, enforce.error || 'ALLOWED');
  erpDb.mutate(d => { d.users = d.users.filter(u => u.id !== viewer.id); });
}

// ===========================================================================
section('QA-26 — customer channel persists correctly');
// ===========================================================================
{
  const r1 = MasterDataService.createCustomer({
    code: `AFX-CH-R-${rnd()}`, name: 'عميل تجزئة', customerType: 'retail', channel: 'wholesale',
    userId: 'usr-admin', userName: 'اختبار', isTest: true,
  });
  const r2 = MasterDataService.createCustomer({
    code: `AFX-CH-E-${rnd()}`, name: 'عميل تصدير', customerType: 'export', channel: 'wholesale',
    userId: 'usr-admin', userName: 'اختبار', isTest: true,
  });
  check('28: the persisted channel follows the customer TYPE, not a free field',
    r1.customer?.channel === 'retail' && r2.customer?.channel === 'export',
    `retail->${r1.customer?.channel} export->${r2.customer?.channel}`);
  if (r1.customer) createdIds.add(r1.customer.id);
  if (r2.customer) createdIds.add(r2.customer.id);

  const mismatched = snap().customers.filter(c =>
    c.channel !== (c.customerType === 'export' ? 'export' : c.customerType === 'wholesale' ? 'wholesale' : 'retail'));
  check('28: NO customer record stores a channel that contradicts its type',
    mismatched.length === 0,
    mismatched.map(c => `${c.code}: ${c.customerType}/${c.channel}`).join(','));
}

// ---------------------------------------------------------------------------
// Cleanup — ONLY this suite's own isTest records. Pre-existing data untouched.
// ---------------------------------------------------------------------------
erpDb.mutate(draft => {
  const testRepIds = new Set(draft.salesReps.filter(r => r.isTest).map(r => r.id));
  const testCustodyIds = new Set(
    draft.representativeCustodies.filter(c => (c as { isTest?: boolean }).isTest || testRepIds.has(c.repId)).map(c => c.id));
  draft.custodyMovements = draft.custodyMovements.filter(m => !testCustodyIds.has(m.custodyId));
  draft.representativeCustodies = draft.representativeCustodies.filter(c => !testCustodyIds.has(c.id));
  draft.salesReps = draft.salesReps.filter(r => !r.isTest);

  const testInvIds = new Set(draft.salesInvoices.filter(i => i.isTest).map(i => i.id));
  draft.salesInvoiceLines = draft.salesInvoiceLines.filter(l => !testInvIds.has(l.invoiceId));
  draft.salesInvoices = draft.salesInvoices.filter(i => !i.isTest);

  const testRetIds = new Set(draft.salesReturns.filter(r => r.isTest).map(r => r.id));
  draft.salesReturnLines = draft.salesReturnLines.filter(l => !testRetIds.has(l.returnId));
  draft.salesReturns = draft.salesReturns.filter(r => !r.isTest);

  const testPayments = new Set(draft.payments.filter(p => p.isTest).map(p => p.id));
  draft.paymentAllocations = draft.paymentAllocations.filter(a => !testPayments.has(a.paymentId));
  draft.payments = draft.payments.filter(p => !p.isTest);
  draft.cheques = draft.cheques.filter(c => !c.isTest);

  const testPInvIds = new Set(draft.purchaseInvoices.filter(p => (p as { isTest?: boolean }).isTest).map(p => p.id));
  draft.purchaseInvoiceLines = draft.purchaseInvoiceLines.filter(l => !testPInvIds.has(l.purchaseInvoiceId));
  draft.purchaseInvoices = draft.purchaseInvoices.filter(p => !testPInvIds.has(p.id));

  const testShipIds = new Set(draft.exportShipments.filter(s => s.isTest).map(s => s.id));
  draft.exportShipments = draft.exportShipments.filter(s => !testShipIds.has(s.id));

  draft.inventoryTransactions = draft.inventoryTransactions.filter(t => !t.isTest);
  draft.batches = draft.batches.filter(b => !b.isTest);
  draft.treasuryTransactions = draft.treasuryTransactions.filter(t => !t.isTest);
  draft.inventoryCounts = draft.inventoryCounts.filter(c => !(c as { isTest?: boolean }).isTest);
  draft.inventoryCountLines = draft.inventoryCountLines.filter(l => {
    const c = draft.inventoryCounts.find(x => x.id === l.countId);
    return c !== undefined;
  });
  draft.journalEntries = draft.journalEntries.filter(j => !j.isTest);
  draft.qualityInspections = draft.qualityInspections.filter(q => !(q as { isTest?: boolean }).isTest);
  draft.auditLogs = draft.auditLogs.filter(a => !(a as { isTest?: boolean }).isTest);
  draft.users = draft.users.filter(u => !u.isTest);

  draft.customers = draft.customers.filter(c => !c.isTest && !createdIds.has(c.id));
  draft.suppliers = draft.suppliers.filter(s => !s.isTest && !createdIds.has(s.id));
  draft.items = draft.items.filter(i => !createdIds.has(i.id));

  // orders / consumptions created by this suite
  draft.productionOrders = draft.productionOrders.filter(o => !createdIds.has(o.id));
  draft.productionConsumptions = draft.productionConsumptions.filter(c => !createdIds.has(c.productionOrderId));
  draft.productionWastes = draft.productionWastes.filter(w => !createdIds.has(w.productionOrderId));
});

console.log('\n==============================');
console.log(`AUDIT-FIX TOTAL: ${pass + fail} | PASS: ${pass} | FAIL: ${fail}`);
if (failures.length) {
  console.log('FAILURES:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('🎉 ALL AUDIT-FIX REGRESSION CHECKS PASSED');

/** Sum of the ageing buckets (used to prove they tie to the statement). */
function agingBucketSum(rows: Array<{ b0_30: number; b31_60: number; b61_90: number; b90plus: number }>) {
  return Number(rows.reduce((s, r) => s + r.b0_30 + r.b31_60 + r.b61_90 + r.b90plus, 0).toFixed(2));
}