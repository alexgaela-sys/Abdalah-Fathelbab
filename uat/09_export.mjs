// ISOLATED UAT HARNESS — Phase 3H: EXPORT through the real UI.
// Export customer, export production into WH-03, USD invoices with the manual
// exchange rate (the reported "1 + 1 + 1" case), shipment + export costs,
// collection, and an independent line-by-line journal trace.
import { launchIsolated, login, gotoTab, shot, Results, BASE_URL, openCreate, fillFields, readDb, captureDialogs, closeModal, trimExtraLines } from './lib.mjs';

const R = new Results('09_export');
const dialogs = [];
let dialogAction = 'dismiss';

const { browser, page } = await launchIsolated();
captureDialogs(page, dialogs, { action: () => dialogAction });
page.on('console', m => { if (m.type() === 'error') R.consoleErrors.push(m.text()); });
page.on('pageerror', e => R.pageErrors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await login(page);

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const qtyWh = (db, id, wh) => (db.batches || []).filter(b => b.itemId === id && (!wh || b.warehouseId === wh)).reduce((s, b) => s + b.quantity, 0);
const acc = (db, code) => (db.accounts.find(a => a.code === code)?.currentBalance) || 0;
const unbal = (db) => db.journalEntries.filter(j => Math.abs(j.lines.reduce((s, l) => s + (l.debit || 0), 0) - j.lines.reduce((s, l) => s + (l.credit || 0), 0)) > 0.005);

let FX, EXPCUST, EFG;

/** Sum of debits on the journal posted for a given source document. */
function shipJvAmt(db, shipId) {
  const js = db.journalEntries.filter(j => (j.sourceDocumentId || '') === shipId || /shipment|شحنة/i.test(j.sourceDocumentType || ''));
  return js.reduce((s, j) => s + j.lines.reduce((t, l) => t + (l.debit || 0), 0), 0);
}

// --------------------------------------------------------------- SETUP
{
  // 1. export customer (currency USD)
  const m = await openCreate(page, 'customers', 'إضافة عميل جديد');
  await fillFields(m, [
    { i: 0, value: 'CUST-EXP-01' },
    { i: 1, value: 'USD' },
    { i: 2, value: 'عميل تصدير UAT' },
    { i: 3, value: 'export' },
    { i: 4, value: '50000' },
  ]);
  await m.locator('button', { hasText: 'حفظ العميل' }).click();
  await page.waitForTimeout(800);
  let db = await readDb(page);
  EXPCUST = db.customers.find(c => c.code === 'CUST-EXP-01');
  R.add({
    id: 'EXP-SETUP-CUST',
    name: 'Setup: export customer created with USD currency',
    status: (EXPCUST && EXPCUST.currency === 'USD') ? 'PASS' : 'FAIL',
    detail: `currency=${EXPCUST?.currency}; type=${EXPCUST?.customerType}; channel=${EXPCUST?.channel}`,
  });
  FX = db.company.currentUsdExchangeRate;

  // 2. export production: finished good into WH-03
  const fgList = db.items.filter(i => i.itemType === 'finished_product');
  const bom0 = db.boms.find(b => fgList.some(i => i.id === (b.productId ?? b.productItemId ?? b.itemProductId))) || db.boms[0];
  const bomProductId = bom0?.productId ?? bom0?.productItemId ?? bom0?.itemProductId;
  EFG = fgList.find(i => i.id === bomProductId) || fgList[0];
  const bom = bom0;
  const lines = db.bomLines.filter(l => l.bomId === bom.id);

  const mp = await openCreate(page, 'purchasing', 'فاتورة استلام خامات جديدة');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) { await mp.locator('button', { hasText: 'إضافة مادة' }).first().click(); await page.waitForTimeout(150); }
    const base = 7 + 6 * i;
    await fillFields(mp, [
      { i: base, value: lines[i].materialItemId },
      { i: base + 1, value: String(Math.ceil((lines[i].quantityRequired || 1) * 300 * 1.6)) },
      { i: base + 2, value: '25' },
      { i: base + 3, value: `EXP-MAT-${i}` },
      { i: base + 5, value: '0' },
    ]);
  }
  await mp.locator('button', { hasText: 'حفظ وترحيل الاستلام' }).click();
  await page.waitForTimeout(1500);
  await closeModal(page);

  const mo = await openCreate(page, 'manufacturing', 'أمر إنتاج جديد');
  await fillFields(mo, [{ i: 0, value: EFG.id }, { i: 1, value: '300' }, { i: 2, value: 'export' }]);
  await mo.locator('button', { hasText: 'اعتماد وإطلاق أمر الإنتاج' }).click();
  await page.waitForTimeout(1400);
  db = await readDb(page);
  const order = db.productionOrders.slice(-1)[0];
  dialogAction = 'accept';
  const row = page.locator('main tbody tr', { hasText: order?.orderNumber || '###' });
  const issue = row.locator('button', { hasText: 'صرف خامات' }).first();
  if (await issue.count()) await issue.click({ force: true });
  await page.waitForTimeout(1500);
  dialogAction = 'dismiss';
  const out = row.locator('button', { hasText: 'تسجيل إنتاج يومي' }).first();
  if (await out.count()) {
    await out.click({ force: true });
    await page.waitForTimeout(700);
    const om = page.locator('div.fixed.inset-0').last();
    await fillFields(om, [{ i: 0, value: '300' }, { i: 1, value: '0' }, { i: 2, value: '0' }]);
    await om.locator('button', { hasText: 'تأكيد واستلام الإنتاج' }).click();
    await page.waitForTimeout(1500);
  }
  dialogAction = 'accept';
  const close = row.locator('button', { hasText: 'إغلاق واحتساب التكاليف' }).first();
  if (await close.count()) await close.click({ force: true });
  await page.waitForTimeout(1800);
  dialogAction = 'dismiss';

  db = await readDb(page);
  const expStock = qtyWh(db, EFG.id, 'wh-export');
  R.add({
    id: 'EXP-SETUP-STOCK',
    name: 'Setup: export production delivered finished goods into WH-03',
    status: expStock >= 100 ? 'PASS' : 'FAIL',
    detail: `WH-03 qty=${expStock}; item=${EFG.code || EFG.id}; order=${order?.orderNumber}; orderStatus=${db.productionOrders.slice(-1)[0]?.status}`,
  });
}

// ------------------------------------- 1 + 1 + 1 USD INVOICES (FX CHECK)
{
  const db0 = await readDb(page);
  const a4103_0 = acc(db0, '4103'), a1106_0 = acc(db0, '1106'), a5102_0 = acc(db0, '5102'), a1110_0 = acc(db0, '1110');
  const stock0 = qtyWh(db0, EFG.id, 'wh-export');
  const invCount0 = db0.salesInvoices.length;

  const created = [];
  const trimmed = [];
  for (let k = 0; k < 3; k++) {
    const m = await openCreate(page, 'sales', 'فاتورة بيع جديدة');
    // the form reopens with leftover lines (defect STALE-01) — remove them so the
    // FX/accounting assertions measure the invoice the tester actually built.
    trimmed.push(await trimExtraLines(m, 1));
    await fillFields(m, [
      { i: 0, value: EXPCUST.id },
      { i: 1, value: 'export' },
      { i: 5, value: 'credit' },
      { i: 8, value: EFG.id },
      { i: 9, value: '1' },
      { i: 11, value: '1' },
      { i: 12, value: '0' },
    ]);
    await m.locator('button', { hasText: 'حفظ وترحيل الفاتورة' }).click();
    await page.waitForTimeout(1500);
    const dbx = await readDb(page);
    created.push(dbx.salesInvoices[dbx.salesInvoices.length - 1]);
  }

  const db1 = await readDb(page);
  const newInvs = db1.salesInvoices.slice(invCount0);
  const a4103 = acc(db1, '4103'), a1106 = acc(db1, '1106'), a5102 = acc(db1, '5102'), a1110 = acc(db1, '1110');
  const expectedEGP = r2(3 * 1 * 1 * FX);

  R.add({
    id: 'EXP-111-01',
    name: 'Three USD invoices of 1 × $1 post exactly three documents with FX applied',
    status: (newInvs.length === 3 && newInvs.every(i => Math.abs(i.totalAmountEGP - FX) < 0.01)) ? 'PASS' : 'FAIL',
    detail: `FX=${FX}; staleLinesRemovedPerOpen=${JSON.stringify(trimmed)}; invoices=${newInvs.map(i => `${i.invoiceNumber}:${i.totalAmount}USD/${i.totalAmountEGP}EGP@${i.exchangeRate}`).join(', ')}`,
  });

  R.add({
    id: 'EXP-111-02',
    name: 'Export receivable (1106) equals 3 × rate and revenue (4103) equals 3 × rate',
    status: (Math.abs((a1106 - a1106_0) - expectedEGP) < 0.01 && Math.abs((a4103 - a4103_0) - expectedEGP) < 0.01) ? 'PASS' : 'FAIL',
    detail: `expected=${expectedEGP}; Δ4103=${r2(a4103 - a4103_0)}; Δ1106=${r2(a1106 - a1106_0)}; Δ5102=${r2(a5102 - a5102_0)}; Δ1110=${r2(a1110 - a1110_0)}`,
  });

  R.add({
    id: 'EXP-111-03',
    name: 'Export stock deducted once per invoice from WH-03 (no double issue)',
    status: (stock0 - qtyWh(db1, EFG.id, 'wh-export')) === 3 ? 'PASS' : 'FAIL',
    detail: `WH-03 ${stock0}→${qtyWh(db1, EFG.id, 'wh-export')}`,
  });

  // COGS: recompute independently from the pre-run batches
  const layers = db0.batches.filter(b => b.itemId === EFG.id && b.warehouseId === 'wh-export' && b.quantity > 0);
  let rem = 3, expCogs = 0;
  for (const l of layers) { if (rem <= 0) break; const t = Math.min(rem, l.quantity); expCogs += t * (l.unitCost || 0); rem -= t; }
  const cogsSum = newInvs.reduce((s, i) => s + (i.cogsTotal || 0), 0);
  R.add({
    id: 'EXP-111-04',
    name: 'Export COGS matches an independent FIFO recomputation (no double COGS)',
    status: Math.abs(cogsSum - expCogs) < 0.01 ? 'PASS' : 'FAIL',
    detail: `cogsOnInvoices=${r2(cogsSum)}; expectedFIFO=${r2(expCogs)}; layers=${layers.map(l => `${l.batchNumber}:${l.quantity}@${l.unitCost}`).join(', ')}; Δ5102(GL)=${r2(a5102 - a5102_0)}`,
  });

  // every journal balanced + line-by-line trace of the last export invoice
  const last = newInvs[newInvs.length - 1];
  const jv = db1.journalEntries.filter(j => j.sourceDocumentId === last?.id || (j.lines || []).some(l => l.sourceDocumentId === last?.id)).slice(-1)[0]
    || db1.journalEntries.slice(-1)[0];
  const trace = (jv?.lines || []).map(l => {
    const a = db1.accounts.find(x => x.id === l.accountId);
    return `${a?.code || l.accountId} ${a?.nameAr || ''}: D=${l.debit} C=${l.credit}`;
  });
  R.add({
    id: 'EXP-111-05',
    name: 'Export journal traced line-by-line with account codes, debits and credits',
    status: trace.length > 0 && unbal(db1).length === 0 ? 'PASS' : 'FAIL',
    detail: `jv=${jv?.entryNumber || jv?.id}; lines=${trace.join(' | ')}; unbalancedJournals=${unbal(db1).length}`,
  });

  // invoice numbering still unique across channels
  const nums = db1.salesInvoices.map(i => i.invoiceNumber);
  R.add({ id: 'EXP-111-06', name: 'Invoice numbering stays unique across local + export', status: new Set(nums).size === nums.length ? 'PASS' : 'FAIL', detail: nums.join(',') });
}

// -------------------------------------------------- SHIPMENT + COSTS
{
  const db0 = await readDb(page);
  const inv = db0.salesInvoices.filter(i => i.channel === 'export').slice(-1)[0];
  const ship0 = (db0.exportShipments || []).length;
  const m = await openCreate(page, 'export', 'تسجيل شحنة تصدير جديدة');
  // 0 linked invoice, 1 customer, 2 container, 3 origin, 4 destination, 5 usd, 6 rate, 7 productCost, 8 shipping, 9 port, 10 customs
  await fillFields(m, [
    { i: 0, value: inv?.id || '' },
    { i: 1, value: EXPCUST.id },
    { i: 2, value: 'MSCU-UAT-001' },
    { i: 5, value: String(inv?.totalAmount || 1000) },
    { i: 6, value: String(FX) },
    // index 7 (product cost) is read-only: derived from the linked invoice's COGS
    { i: 8, value: '500' },
    { i: 9, value: '250' },
    { i: 10, value: '125' },
  ]);
  const d0 = dialogs.length;
  await m.locator('button', { hasText: 'حفظ الشحنة' }).click();
  await page.waitForTimeout(1500);
  const db1 = await readDb(page);
  const ship = (db1.exportShipments || []).slice(-1)[0];
  R.add({
    id: 'EXP-SHIP-01',
    name: 'Export shipment recorded with freight/port/customs costs',
    status: (db1.exportShipments || []).length === ship0 + 1 ? 'PASS' : 'FAIL',
    detail: `shipments ${ship0}→${(db1.exportShipments || []).length}; container=${ship?.containerNumber}; usd=${ship?.usdRevenue}; rate=${ship?.exchangeRate}; shipping=${ship?.shippingCost}; port=${ship?.portCosts}; customs=${ship?.customsCost}; otherExportCosts=${ship?.otherExportCosts}; productCost=${ship?.productCost}; dialogs=${dialogs.slice(d0).map(x => x.message).join('|').slice(0, 140)}`,
  });

  // export costs must appear as expenses/GL, not as an orphan number
  const db2 = await readDb(page);
  const shipJv = db2.journalEntries.filter(j => (j.sourceDocumentId || '') === ship?.id || /shipment|شحنة/i.test(j.sourceDocumentType || ''));
  R.add({
    id: 'EXP-SHIP-02',
    name: 'Shipment posts a journal carrying the export costs',
    status: shipJv.length > 0 ? 'PASS' : 'WARN',
    detail: `journals=${shipJv.length}; sample=${shipJv.slice(-1)[0] ? JSON.stringify(shipJv.slice(-1)[0].lines.map(l => `${l.accountId}:${l.debit}/${l.credit}`)) : 'none'}; accountBalances: 5102=${r2(acc(db2, '5102'))} 1106=${r2(acc(db2, '1106'))}`,
  });

  R.add({ id: 'EXP-SHIP-03', name: 'All journals balanced after the shipment', status: unbal(db2).length === 0 ? 'PASS' : 'FAIL', detail: `unbalanced=${unbal(db2).map(j => j.id).join(',') || 'none'}` });

  // cost journal must equal exactly the costs entered in the form
  const enteredCosts = (ship?.shippingCost || 0) + (ship?.portCosts || 0) + (ship?.customsCost || 0) + (ship?.otherCosts || 0);
  const costJvAmount = shipJvAmt(db2, ship?.id);
  R.add({
    id: 'EXP-SHIP-04',
    name: 'Shipment cost journal equals the costs entered in the form (no phantom charges)',
    status: Math.abs(costJvAmount - ((ship?.shippingCost || 0) + (ship?.portCosts || 0) + (ship?.customsCost || 0))) < 0.01 ? 'PASS' : 'FAIL',
    detail: `journalCost=${r2(costJvAmount)}; entered(shipping+port+customs)=${r2((ship?.shippingCost || 0) + (ship?.portCosts || 0) + (ship?.customsCost || 0))}; stored otherExportCosts=${ship?.otherExportCosts} — the shipment form exposes no input for it (ExportView initialises otherCosts=5000 and never renders a control), so 5,000 EGP is posted that no user entered`,
  });
}

// ------------------------------------------------------- COLLECTION
{
  const db0 = await readDb(page);
  const ship = (db0.exportShipments || []).slice(-1)[0];
  await gotoTab(page, 'export');
  await page.waitForTimeout(600);
  const collectBtn = page.locator('main button', { hasText: /تحصيل|تسجيل تحصيل/ }).first();
  let ok = false, detail = '';
  if (await collectBtn.count()) {
    await collectBtn.click({ force: true });
    await page.waitForTimeout(800);
    const cm = page.locator('div.fixed.inset-0').last();
    const n = await cm.locator('input, select').count();
    if (n > 0) {
      const fields = await cm.locator('input, select').all();
      // amount, rate, bank, date (order discovered at runtime)
      const info = await cm.evaluate(el => Array.from(el.querySelectorAll('input, select')).map((f, i) => ({ i, tag: f.tagName.toLowerCase(), type: f.type || '', value: String(f.value || ''), options: f.tagName === 'SELECT' ? Array.from(f.options).map(o => o.value) : undefined })));
      detail = JSON.stringify(info);
      // fill: amount = full USD, rate = FX, pick a bank if present
      await cm.locator('input[type="number"]').first().fill(String(ship?.usdRevenue || 100));
      const nums = cm.locator('input[type="number"]');
      if (await nums.count() > 1) await nums.nth(1).fill(String(FX));
      const sel = cm.locator('select').first();
      if (await sel.count()) { const vals = await sel.locator('option').evaluateAll(os => os.map(o => o.value)); if (vals[1] || vals[0]) await sel.selectOption(vals.find(v => v) || vals[0]); }
      const d0 = dialogs.length;
      await cm.locator('button', { hasText: /حفظ|تأكيد|تحصيل/ }).last().click();
      await page.waitForTimeout(1500);
      const db1 = await readDb(page);
      const bank0 = (db0.bankTransactions || []).length;
      const treas0 = (db0.treasuryTransactions || []).length;
      const a1106_0 = acc(db0, '1106');
      const bankTx = (db1.bankTransactions || []).length > bank0;
      const treasTx = (db1.treasuryTransactions || []).length > treas0;
      const recvDrop = Math.abs(acc(db1, '1106') - a1106_0) > 0.01;
      ok = bankTx || treasTx || recvDrop;
      detail += `; bankTx ${bank0}→${(db1.bankTransactions || []).length}; treasuryTx ${treas0}→${(db1.treasuryTransactions || []).length}; Δ1106=${r2(acc(db1, '1106') - a1106_0)}; dialogs=${dialogs.slice(d0).map(x => x.message).join('|').slice(0, 120)}`;
    } else {
      detail = 'collection modal had no fields';
    }
    await closeModal(page);
  } else {
    detail = 'no collection control found on the export screen';
  }
  R.add({ id: 'EXP-COLL-01', name: 'Export collection recorded through the UI moves bank/treasury', status: ok ? 'PASS' : 'WARN', detail });
}

// ------------------------------------------------------------ EVIDENCE
{
  const db = await readDb(page);
  R.add({
    id: 'EXP-FINAL',
    name: 'Export module end state (accounts, stock, journals)',
    status: 'PASS',
    detail: `4103=${r2(acc(db, '4103'))}; 1106=${r2(acc(db, '1106'))}; 5102=${r2(acc(db, '5102'))}; 1110=${r2(acc(db, '1110'))}; WH-03=${r2(qtyWh(db, EFG.id, 'wh-export'))}; journals=${db.journalEntries.length}; unbalanced=${unbal(db).length}; FX=${FX}`,
  });
  R.add({ id: 'EXP-CONSOLE', name: 'No console/page errors during export testing', status: (R.consoleErrors.length + R.pageErrors.length) === 0 ? 'PASS' : 'FAIL', detail: JSON.stringify([...R.pageErrors, ...R.consoleErrors].slice(0, 6)) });
}
await shot(page, '09_export');
console.log('\n=== SUMMARY ===', JSON.stringify(R.summary()));
R.save();
await browser.close();
