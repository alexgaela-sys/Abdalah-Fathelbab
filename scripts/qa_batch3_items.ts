// QA BATCH 3 — isolated, self-cleaning verification of the newest service fixes:
//   ITEM 6   sales-return VAT: a LINKED return inherits the original line's
//            unit price AND VAT rate (the caller's price/rate is never used)
//   ITEM 10  defective output lands in WH-04 as QUANTITY at ZERO value (no
//            invented 50%); real raw-material recovery is booked at its
//            documented cost only (Dr 1108 | Cr 5104), never invented
//   ITEM 11  scrap transfer carries NO automatic 10% valuation and no
//            PROD-WASTE journal capitalizes 1111/1112
//   ITEM 12  internal scrap-sale document: FIFO out of wh-scrap, revenue to
//            4104, VAT exempt (no 2103), above-balance rejected, cancel is a
//            full reversal (stock + GL restored)
//   ITEM 13  expiry threshold settings: validation + threshold-driven
//            getExpiringBatches
// Every flow is measured for the P41 identity (ΔGL inventory == Δbatches);
// all records are TEST-QA prefixed / tracked and cleaned up afterwards.
import { erpDb } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { InventoryEngine } from '../src/services/inventory';
import { WorkflowService } from '../src/services/workflows';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { SettingsService } from '../src/services/settings';
import { ensureTestBom } from './qa_test_bom';

const TODAY = new Date().toISOString().split('T')[0];
const RID = `B3-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const snap = () => erpDb.getSnapshot();
const ADMIN = { userId: 'usr-admin', userName: 'QA' };

const INVENTORY_ACCOUNTS = ['1108', '1109', '1110', '1111', '1112', '1107'];
const glInv = () => INVENTORY_ACCOUNTS.reduce((s, c) => s + (snap().accounts.find(a => a.code === c)?.currentBalance || 0), 0);
const batchVal = () => snap().batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
const accId = (code: string) => snap().accounts.find(a => a.code === code)?.id;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? ` :: ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` :: ${detail}` : ''}`); }
}
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }
function header(t: string) { console.log(`\n── ${t} ──`); }
const r2 = (n: number) => Math.round(n * 100) / 100;
const inDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; };

// ---------------------------------------------------------------- baseline
const BASE = {
  journalEntries: snap().journalEntries.length,
  inventoryTransactions: snap().inventoryTransactions.length,
  auditLogs: snap().auditLogs.length,
  accounts: snap().accounts.map(a => ({ id: a.id, b: a.currentBalance })),
  batchIds: snap().batches.map(b => b.id),
  settings: snap().settings?.expiryWarningDays ?? 10,
};
const g0 = glInv();
const b0 = batchVal();

const created = {
  customers: new Set<string>(),
  suppliers: new Set<string>(),
  salesInvoices: new Set<string>(),
  purchaseInvoices: new Set<string>(),
  salesReturns: new Set<string>(),
  productionOrders: new Set<string>(),
  scrapSales: new Set<string>(),
};

// ---------------------------------------------------------------- fixtures
header('FIXTURES');
const sup = MasterDataService.createSupplier({ code: `${PFX}-SUP`, name: `مورد ${PFX}`, isTest: true, ...ADMIN })!.supplier!;
created.suppliers.add(sup.id);
const cust = MasterDataService.createCustomer({ code: `${PFX}-CUST`, name: `عميل ${PFX}`, customerType: 'retail', channel: 'retail', isTest: true, ...ADMIN })!.customer!;
created.customers.add(cust.id);
const fp = snap().items.find(i => i.code === 'FP-SNG-01')!;
const chip = snap().items.find(i => i.id === 'item-raw-chip')!;
check('fixtures ready (supplier + retail customer + FP-SNG-01 + chip)', Boolean(sup && cust && fp && chip));

// =================================================================
// ITEM 6 — SALES RETURN VAT (linked return inherits price + rate)
// =================================================================
header('ITEM 6 — sales return VAT');
{
  const pinv = WorkflowService.createPurchaseInvoice({
    supplierId: sup.id, warehouseId: 'wh-local', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `${PFX}-P1`, date: TODAY,
    lines: [{ itemId: fp.id, quantity: 60, unitId: 'unit-piece', unitPrice: 40, batchNumber: `${PFX}-B1`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (pinv.success && pinv.invoice) created.purchaseInvoices.add(pinv.invoice.id);
  check('setup: stock received into WH-02', pinv.success, pinv.error || '60 pcs @ 40');

  const sinv = WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: 'wh-local', paymentMethod: 'credit',
    currency: 'EGP', exchangeRate: 1, date: TODAY,
    lines: [{ itemId: fp.id, quantity: 10, unitPrice: 100, vatRate: 0.14 }],
    isTest: true, ...ADMIN,
  } as never);
  if (sinv.success && sinv.invoice) created.salesInvoices.add(sinv.invoice.id);
  check('setup: 14% VAT sale posted', sinv.success, sinv.error || '');
  const inv = sinv.invoice!;
  check('invoice books 14% output VAT', Math.abs((inv.vatAmount || 0) - 140) < 0.01, `vat=${inv.vatAmount}`);
  check('invoice total = 1000 + 140', Math.abs((inv.totalAmount || 0) - 1140) < 0.01, `total=${inv.totalAmount}`);

  const net2103 = () => snap().journalEntries.reduce((s, j) => s + j.lines.filter(l => l.accountId === accId('2103')).reduce((x, l) => x + (l.credit || 0) - (l.debit || 0), 0), 0);
  const jv2103Before = net2103();

  // Deliberately WRONG caller price/rate: the linked return must ignore both.
  const ret = WorkflowService.postSalesReturn({
    customerId: cust.id, invoiceId: inv.id, warehouseId: 'wh-local', date: TODAY, reason: `${PFX} ret`,
    lines: [{ itemId: fp.id, quantity: 4, unitPrice: 1, vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (ret.success && ret.salesReturn) created.salesReturns.add(ret.salesReturn.id);
  check('linked return posts', ret.success, ret.error || '');
  const sr = ret.salesReturn!;
  check('ITEM 6: return inherits ORIGINAL price (4 × 100 = 400)', Math.abs(r2(sr.totalAmount) - 456) < 0.01 && Math.abs(sr.totalVat - 56) < 0.01,
    `total=${sr.totalAmount} vat=${sr.totalVat} (caller price 1 & rate 0 were ignored)`);

  const retJv = snap().journalEntries.find(j => j.sourceDocumentType === 'sales_return' && j.reference === sr.returnNumber);
  check('ITEM 6: return journal exists & balances', Boolean(retJv) && Math.abs(retJv!.lines.reduce((s, l) => s + (l.debit || 0), 0) - retJv!.lines.reduce((s, l) => s + (l.credit || 0), 0)) < 0.01);
  const vatDebit = retJv ? retJv.lines.filter(l => l.accountId === accId('2103')).reduce((s, l) => s + (l.debit || 0), 0) : -1;
  check('ITEM 6: output VAT 2103 reversed by exactly 56.00', Math.abs(vatDebit - 56) < 0.01, `debit=${r2(vatDebit)}`);
  const jv2103After = net2103();
  check('ITEM 6: net output VAT dropped by exactly 56', Math.abs((jv2103After - jv2103Before) + 56) < 0.01, `Δ=${r2(jv2103After - jv2103Before)}`);

  const gb = glInv(), bb = batchVal();
  info(`ITEM 6 cumulative: GL=${r2(gb - g0)} batches=${r2(bb - b0)} residual=${r2((gb - g0) - (bb - b0))}`);
}

// =================================================================
// ITEM 10 / 11 — PRODUCTION: REAL VALUES ONLY (no 50% / no 10%)
// =================================================================
header('ITEM 10/11 — production waste & recovery at real values only');
{
  const gB = glInv(), bB = batchVal();
  const jvsAtStart = snap().journalEntries.length;
  const bom = ensureTestBom(fp.id);
  const reqs = ManufacturingEngine.calculateBomRequirements(bom.id, 100);
  snap().bomLines.filter(l => l.bomId === bom.id).forEach((l, i) => {
    const p = WorkflowService.createPurchaseInvoice({
      supplierId: sup.id, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
      reference: `${PFX}-M${i}`, date: TODAY,
      lines: [{ itemId: l.materialItemId, quantity: Math.ceil(l.quantityRequired * 1.2 * 1000) / 1000, unitId: l.unitId, unitPrice: 50, batchNumber: `${PFX}-M${i}`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
      isTest: true, ...ADMIN,
    } as never);
    if (p.success && p.invoice) created.purchaseInvoices.add(p.invoice.id);
  });
  info(`BOM materials purchased for planned 100 pcs (${reqs.length} requirement lines)`);

  const o = ManufacturingEngine.createProductionOrder({
    productId: fp.id, plannedQuantity: 100, targetMarket: 'local', destinationWarehouseId: 'wh-local',
    expectedCompletionDate: TODAY, isTest: true, ...ADMIN,
  } as never);
  check('production order created', o.success, o.error || '');
  const orderId = o.order!.id;
  created.productionOrders.add(orderId);
  const orderNumber = o.order!.orderNumber;

  const iss = ManufacturingEngine.issueMaterialsToOrder({
    orderId, lines: reqs.map(r => ({ materialItemId: r.materialItemId, quantity: r.requiredQuantity })),
    date: TODAY, ...ADMIN,
  } as never);
  check('materials issued against the BOM', iss.success, iss.error || '');

  const p = ManufacturingEngine.recordDailyProduction({
    orderId, goodQuantity: 60, defectiveQuantity: 25, scrapQuantity: 15, defectiveAction: 'to_scrap',
    wasteReason: `${PFX} هالك خط`, date: TODAY, isTest: true, ...ADMIN,
  } as never);
  check('daily production posted (60 good / 25 defective / 15 scrap)', p.success, p.error || '');

  const wasteTxs = snap().inventoryTransactions.filter(t => t.documentNumber === orderNumber);
  const scrapTx = wasteTxs.find(t => t.documentType === 'هالك إنتاج');
  const defTx = wasteTxs.find(t => t.documentType === 'توالف إنتاج');
  check('ITEM 11: scrap transfer booked as QUANTITY', Boolean(scrapTx) && scrapTx!.quantityIn === 15, `qty=${scrapTx?.quantityIn}`);
  check('ITEM 11: scrap transfer carries NO automatic 10% valuation', Boolean(scrapTx) && scrapTx!.unitCost === 0 && scrapTx!.totalCost === 0, `unitCost=${scrapTx?.unitCost}`);
  check('ITEM 10: defective transfer booked as QUANTITY', Boolean(defTx) && defTx!.quantityIn === 25, `qty=${defTx?.quantityIn}`);
  check('ITEM 10: defective transfer carries NO invented 50% value', Boolean(defTx) && defTx!.unitCost === 0 && defTx!.totalCost === 0, `unitCost=${defTx?.unitCost}`);

  const capitalizedWaste = snap().journalEntries.slice(jvsAtStart).flatMap(j => j.lines)
    .filter(l => (l.accountId === accId('1111') || l.accountId === accId('1112')) && (l.debit || 0) > 0);
  check('ITEM 11: NO PROD-WASTE journal capitalizes 1111/1112 (10%/50% removed)', capitalizedWaste.length === 0,
    `${capitalizedWaste.length} capitalizing line(s)`);

  // Real recovery of actual raw material at its DOCUMENTED cost.
  const documentedCost = Number(chip.actualCost || chip.standardCost || 0);
  const rec = ManufacturingEngine.recordRawMaterialRecovery({
    orderId, lines: [{ materialItemId: chip.id, quantity: 2 }],
    reason: `${PFX} استرداد فعلية`, date: TODAY, ...ADMIN,
  } as never);
  check('ITEM 10: real raw-material recovery posts', rec.success, rec.error || '');
  const recTx = snap().inventoryTransactions.find(t => t.documentType === 'استرداد خامات من إنتاج معيب' && t.documentNumber === orderNumber && t.itemId === chip.id);
  check('ITEM 10: recovery valued at DOCUMENTED cost only', Boolean(recTx) && Math.abs(recTx!.unitCost - documentedCost) < 0.0001,
    `unitCost=${recTx?.unitCost} documented=${documentedCost}`);
  const recJv = snap().journalEntries.find(j => j.sourceDocumentType === 'production_material_recovery');
  if (documentedCost > 0) {
    const recAmt = recJv ? recJv.lines.filter(l => l.accountId === accId('1108')).reduce((s, l) => s + (l.debit || 0), 0) : -1;
    check('ITEM 10: recovery journal Dr 1108 = 2 × documented cost', Math.abs(recAmt - 2 * documentedCost) < 0.01, `debit=${r2(recAmt)}`);
  } else {
    info('documented chip cost = 0 → zero-cost recovery with no journal (legal, nothing invented)');
  }

  const cl = ManufacturingEngine.closeProductionOrder(orderId, 'usr-admin', 'QA');
  check('order closed after full output (60+25+15 = 100 = planned)', cl.success, cl.error || `mode=${cl.mode}`);

  const gA = glInv(), bA = batchVal();
  const resid = (gA - gB) - (bA - bB);
  check('P41: production lifecycle ΔGL == Δbatches', Math.abs(resid) <= 0.05, `ΔGL=${r2(gA - gB)} Δbatch=${r2(bA - bB)} residual=${r2(resid)}`);

  const capitalizedAfterClose = snap().journalEntries.slice(jvsAtStart).flatMap(j => j.lines)
    .filter(l => (l.accountId === accId('1111') || l.accountId === accId('1112')) && (l.debit || 0) > 0);
  check('ITEM 11: still NO 1111/1112 capitalization after closure', capitalizedAfterClose.length === 0, `${capitalizedAfterClose.length} line(s)`);
}

// =================================================================
// ITEM 12 — INTERNAL SCRAP-SALE DOCUMENT
// =================================================================
header('ITEM 12 — scrap-sale document');
{
  // Real scrap stock: top up WH-01 chip, then transfer into WH-05 at FIFO cost.
  const top = WorkflowService.createPurchaseInvoice({
    supplierId: sup.id, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `${PFX}-TOP`, date: TODAY,
    lines: [{ itemId: chip.id, quantity: 200, unitId: 'unit-kg', unitPrice: 50, batchNumber: `${PFX}-TOP`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (top.success && top.invoice) created.purchaseInvoices.add(top.invoice.id);
  check('setup: chip top-up received', top.success, top.error || '');

  const t = InventoryEngine.transferWarehouse(chip.id, 'wh-raw', 'wh-scrap', 50, undefined, `${PFX}-TOP`, `${PFX} to scrap`);
  check('setup: 50 kg seeded into wh-scrap', t.success, t.error || '');
  const bal = InventoryEngine.getItemBalance(chip.id, 'wh-scrap');

  const gS = glInv(), bS = batchVal();
  const ss = WorkflowService.createScrapSale({
    itemId: chip.id, quantity: 20, unitPrice: 5, buyerName: `${PFX} مشتري سكراب`,
    paymentMethod: 'cash', date: TODAY, notes: `${PFX}`, isTest: true, ...ADMIN,
  } as never);
  check('scrap sale posts', ss.success, ss.error || '');
  const doc = ss.scrapSale!;
  if (doc) created.scrapSales.add(doc.id);

  check('ITEM 12: doc number SCRAP-SALE-*', doc?.docNumber?.startsWith('SCRAP-SALE-') || false, doc?.docNumber);
  check('ITEM 12: totalValue = qty × price', Math.abs(doc.totalValue - 100) < 0.01, `total=${doc.totalValue}`);
  check('ITEM 12: stock left wh-scrap by exactly 20', Math.abs(InventoryEngine.getItemBalance(chip.id, 'wh-scrap') - (bal - 20)) < 0.0001);

  const g1 = glInv(), b1 = batchVal();
  check('P41: scrap sale ΔGL == Δbatches', Math.abs((g1 - gS) - (b1 - bS)) < 0.01, `ΔGL=${r2(g1 - gS)} Δbatch=${r2(b1 - bS)}`);

  const revJv = snap().journalEntries.find(j => j.id === doc.journalEntryId);
  check('ITEM 12: revenue journal posted', Boolean(revJv));
  const credit4104 = revJv ? revJv.lines.filter(l => l.accountId === accId('4104')).reduce((s, l) => s + (l.credit || 0), 0) : -1;
  check('ITEM 12: revenue credited to 4104', Math.abs(credit4104 - 100) < 0.01, `credit=${r2(credit4104)}`);
  const cashDebit = revJv ? revJv.lines.filter(l => l.accountId === accId('1101')).reduce((s, l) => s + (l.debit || 0), 0) : -1;
  check('ITEM 12: cash debit = 100 (cash payment)', Math.abs(cashDebit - 100) < 0.01, `debit=${r2(cashDebit)}`);
  check('ITEM 12: VAT exempt — revenue journal touches NO 2103 line',
    Boolean(revJv) && !revJv!.lines.some(l => l.accountId === accId('2103')));

  const costJv = snap().journalEntries.find(j => j.id === doc.costJournalEntryId);
  check('ITEM 12: cost entry exists when bookValue > 0', doc.bookValue > 0 ? Boolean(costJv) : true, `bookValue=${doc.bookValue}`);
  if (costJv && doc.bookValue > 0) {
    const credit1112 = costJv.lines.filter(l => l.accountId === accId('1112')).reduce((s, l) => s + (l.credit || 0), 0);
    check('ITEM 12: cost entry credits 1112 at BOOK value', Math.abs(credit1112 - doc.bookValue) < 0.01, `credit=${r2(credit1112)} book=${doc.bookValue}`);
  }

  const over = WorkflowService.createScrapSale({
    itemId: chip.id, quantity: 9999, unitPrice: 5, buyerName: 'X', paymentMethod: 'cash', date: TODAY,
    isTest: true, ...ADMIN,
  } as never);
  check('ITEM 12: above-balance sale rejected', !over.success && /لا يمكن بيع السكراب فوق الرصيد/.test(over.error || ''), over.error || 'accepted(!)');
  const noPrice = WorkflowService.createScrapSale({
    itemId: chip.id, quantity: 1, unitPrice: 0, buyerName: 'X', paymentMethod: 'cash', date: TODAY,
    isTest: true, ...ADMIN,
  } as never);
  check('ITEM 12: zero price rejected', !noPrice.success, noPrice.error || 'accepted(!)');
  const noBuyer = WorkflowService.createScrapSale({
    itemId: chip.id, quantity: 1, unitPrice: 5, buyerName: '  ', paymentMethod: 'cash', date: TODAY,
    isTest: true, ...ADMIN,
  } as never);
  check('ITEM 12: missing buyer rejected', !noBuyer.success, noBuyer.error || 'accepted(!)');

  // Cancel = full reversal, never a delete.
  const cc = WorkflowService.cancelScrapSale({ scrapSaleId: doc.id, reason: `${PFX} إلغاء`, isTest: true, ...ADMIN } as never);
  check('cancel posts', cc.success, cc.error || '');
  const doc2 = snap().scrapSales.find(s => s.id === doc.id)!;
  check('ITEM 12: status = cancelled (document kept)', doc2.status === 'cancelled');
  check('ITEM 12: reversal journals recorded', (doc2.reversalJournalEntryIds || []).length >= 1,
    `${(doc2.reversalJournalEntryIds || []).length} reversal(s)`);
  check('ITEM 12: scrap stock restored after cancel', Math.abs(InventoryEngine.getItemBalance(chip.id, 'wh-scrap') - bal) < 0.0001);
  const g2 = glInv(), b2 = batchVal();
  check('P41: after cancel GL & batches fully restored & tied',
    Math.abs(g2 - gS) < 0.01 && Math.abs((g2 - gS) - (b2 - bS)) < 0.01,
    `ΔGL=${r2(g2 - gS)} Δbatch=${r2(b2 - bS)}`);
}

// =================================================================
// ITEM 13 — EXPIRY THRESHOLD SETTINGS
// =================================================================
header('ITEM 13 — expiry threshold settings');
{
  check('reading the threshold yields a positive integer', Number.isInteger(SettingsService.getExpiryWarningDays()) && SettingsService.getExpiryWarningDays() > 0,
    `value=${SettingsService.getExpiryWarningDays()}`);
  check('rejects 0', !SettingsService.setExpiryWarningDays({ days: 0, ...ADMIN }).success);
  check('rejects negative', !SettingsService.setExpiryWarningDays({ days: -3, ...ADMIN }).success);
  check('rejects fractional', !SettingsService.setExpiryWarningDays({ days: 2.5, ...ADMIN }).success);
  check('rejects > 3650', !SettingsService.setExpiryWarningDays({ days: 4000, ...ADMIN }).success);

  const set3 = SettingsService.setExpiryWarningDays({ days: 3, isTest: true, ...ADMIN });
  check('accepts 3 days', set3.success && SettingsService.getExpiryWarningDays() === 3, `value=${SettingsService.getExpiryWarningDays()}`);

  erpDb.mutate(d => {
    d.batches.push(
      { id: `${PFX}-EXP2`, batchNumber: `${PFX}-EXP2`, itemId: fp.id, warehouseId: 'wh-local', productionDate: TODAY, expiryDate: inDays(2), quantity: 5, unitCost: 1, isTest: true } as never,
      { id: `${PFX}-EXP20`, batchNumber: `${PFX}-EXP20`, itemId: fp.id, warehouseId: 'wh-local', productionDate: TODAY, expiryDate: inDays(20), quantity: 7, unitCost: 1, isTest: true } as never,
    );
  });
  const rows3 = InventoryEngine.getExpiringBatches(3);
  check('threshold 3 → 2-day batch listed', rows3.some(r => r.id === `${PFX}-EXP2`));
  check('threshold 3 → 20-day batch NOT listed', !rows3.some(r => r.id === `${PFX}-EXP20`));
  const rowsDefault = InventoryEngine.getExpiringBatches(SettingsService.getExpiryWarningDays());
  check('threshold-driven listing works from the settings value', rowsDefault.some(r => r.id === `${PFX}-EXP2`));

  const restore = SettingsService.setExpiryWarningDays({ days: BASE.settings, isTest: true, ...ADMIN });
  check('original threshold restored', restore.success && SettingsService.getExpiryWarningDays() === BASE.settings, `value=${SettingsService.getExpiryWarningDays()}`);

  erpDb.mutate(d => { d.batches = d.batches.filter(b => b.id !== `${PFX}-EXP2` && b.id !== `${PFX}-EXP20`); });
}

// ---------------------------------------------------------------- global P41
header('GLOBAL P41 IDENTITY (this run: ΔGL inventory vs Δbatches)');
const gEnd = glInv();
const bEnd = batchVal();
const globalResid = (gEnd - g0) - (bEnd - b0);
check('P41 GLOBAL: GL inventory movement == batch ledger movement', Math.abs(globalResid) <= 0.05,
  `ΔGL=${r2(gEnd - g0)} Δbatch=${r2(bEnd - b0)} residual=${r2(globalResid)}`);

// ---------------------------------------------------------------- cleanup
erpDb.mutate(draft => {
  draft.salesInvoices = draft.salesInvoices.filter(x => !created.salesInvoices.has(x.id));
  draft.salesInvoiceLines = draft.salesInvoiceLines.filter(l => created.salesInvoices.has(l.invoiceId));
  draft.purchaseInvoices = draft.purchaseInvoices.filter(x => !created.purchaseInvoices.has(x.id));
  draft.purchaseInvoiceLines = draft.purchaseInvoiceLines.filter(l => created.purchaseInvoices.has(l.purchaseInvoiceId));
  draft.salesReturns = draft.salesReturns.filter(x => !created.salesReturns.has(x.id));
  draft.salesReturnLines = draft.salesReturnLines.filter(l => created.salesReturns.has(l.returnId));
  draft.productionOrders = draft.productionOrders.filter(x => !created.productionOrders.has(x.id));
  draft.productionConsumptions = draft.productionConsumptions.filter(c => !created.productionOrders.has(c.productionOrderId));
  draft.productionWastes = draft.productionWastes.filter(w => !created.productionOrders.has(w.productionOrderId));
  draft.scrapSales = draft.scrapSales.filter(x => !created.scrapSales.has(x.id));
  draft.boms = draft.boms.filter(b => !(b as { isTest?: boolean }).isTest);
  draft.bomLines = draft.bomLines.filter(l => draft.boms.some(b => b.id === l.bomId));
  draft.journalEntries = draft.journalEntries.slice(0, BASE.journalEntries);
  draft.inventoryTransactions = draft.inventoryTransactions.slice(0, BASE.inventoryTransactions);
  draft.auditLogs = draft.auditLogs.slice(0, BASE.auditLogs);
  const keep = new Set(BASE.batchIds);
  draft.batches = draft.batches.filter(b => keep.has(b.id));
  draft.customers = draft.customers.filter(c => !created.customers.has(c.id));
  draft.suppliers = draft.suppliers.filter(s => !created.suppliers.has(s.id));
  BASE.accounts.forEach(b => { const a = draft.accounts.find(x => x.id === b.id); if (a) a.currentBalance = b.b; });
  draft.settings = { ...(draft.settings || { expiryWarningDays: BASE.settings }), expiryWarningDays: BASE.settings };
});

const after = snap();
const balancesOk = BASE.accounts.every(b => Math.abs((after.accounts.find(a => a.id === b.id)?.currentBalance || 0) - b.b) < 0.01);
const glOk = Math.abs(glInv() - g0) < 0.01;
const batchOk = Math.abs(batchVal() - b0) < 0.01;
console.log(`\n  cleanup: journals ${after.journalEntries.length}/${BASE.journalEntries} · invTx ${after.inventoryTransactions.length}/${BASE.inventoryTransactions} · audit ${after.auditLogs.length}/${BASE.auditLogs} · balances restored=${balancesOk} · GL=${glOk} · batches=${batchOk}`);

console.log('\n================================================================');
console.log(`RESULT — ${pass} passed, ${fail} failed`);
console.log('================================================================');
process.exit(fail ? 1 : 0);
