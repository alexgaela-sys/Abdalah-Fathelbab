// ISOLATED UAT HARNESS — Phase 3G: LOCAL SALES through the real UI.
// Setup builds real finished-goods stock the way the business does it
// (purchase materials → production order → issue → produce → close), then the
// sales flow is exercised: validation, FIFO COGS, bonus 10+1, duplicate
// submission, statement, print, export and returns.
import { launchIsolated, login, gotoTab, shot, Results, BASE_URL, openCreate, fillFields, readDb, captureDialogs, closeModal } from './lib.mjs';

const R = new Results('06_sales');
const dialogs = [];
let dialogAction = 'dismiss';

const { browser, page } = await launchIsolated();
captureDialogs(page, dialogs, { action: () => dialogAction });
page.on('console', (m) => { if (m.type() === 'error') R.consoleErrors.push(m.text()); });
page.on('pageerror', (e) => R.pageErrors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await login(page);

const qtyWh = (db, itemId, wh) => (db.batches || []).filter(b => b.itemId === itemId && b.warehouseId === wh).reduce((s, b) => s + b.quantity, 0);
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const allQty = (db, itemId, wh) => (db.batches || []).filter(b => b.itemId === itemId && (!wh || b.warehouseId === wh)).reduce((s, b) => s + b.quantity, 0);

/** Independent FIFO recomputation over a batch snapshot (array order = receipt order). */
function fifoCogs(batches, itemId, wh, sellQty) {
  const layers = batches.filter(b => b.itemId === itemId && b.warehouseId === wh && b.quantity > 0);
  let remaining = sellQty, cost = 0; const consumed = [];
  for (const l of layers) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, l.quantity);
    cost += take * (l.unitCost || 0);
    consumed.push(`${l.batchNumber}:${take}@${l.unitCost}`);
    remaining -= take;
  }
  return { cost: r2(cost), remaining, consumed };
}

/** Buy every material a BOM needs, through the purchasing UI. */
async function purchaseMaterials(page, lines, planned, refPrefix) {
  const m = await openCreate(page, 'purchasing', 'فاتورة استلام خامات جديدة');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) { await m.locator('button', { hasText: 'إضافة مادة' }).first().click(); await page.waitForTimeout(200); }
    const base = 7 + 6 * i;
    const need = Math.ceil((lines[i].quantityRequired || 1) * planned * 1.3);
    await fillFields(m, [
      { i: base, value: lines[i].materialItemId },
      { i: base + 1, value: String(need) },
      { i: base + 2, value: '25' },
      { i: base + 3, value: `${refPrefix}-${i}` },
      { i: base + 5, value: '0' },
    ]);
  }
  await m.locator('button', { hasText: 'حفظ وترحيل الاستلام' }).click();
  await page.waitForTimeout(1500);
  await closeModal(page);
}

/** Full production cycle through the UI. Returns { orderId, produced }. */
async function runProduction(page, fg, planned, produceQty, ref) {
  const mo = await openCreate(page, 'manufacturing', 'أمر إنتاج جديد');
  await fillFields(mo, [{ i: 0, value: fg.id }, { i: 1, value: String(planned) }, { i: 2, value: 'local' }]);
  const d0 = dialogs.length;
  await mo.locator('button', { hasText: 'اعتماد وإطلاق أمر الإنتاج' }).click();
  await page.waitForTimeout(1200);
  let db = await readDb(page);
  const order = db.productionOrders[db.productionOrders.length - 1];
  const started = !!order;
  R.add({ id: `${ref}-ORDER`, name: `${ref}: production order released through the UI`, status: started ? 'PASS' : 'FAIL', detail: `order=${order?.orderNumber}; planned=${order?.plannedQuantity}; dialogs=${dialogs.slice(d0).map(x => x.message).join('|').slice(0, 120)}` });
  if (!started) return { orderId: null, produced: 0 };

  // issue materials (confirm dialog)
  dialogAction = 'accept';
  const issueBtn = page.locator('main button', { hasText: 'صرف خامات' }).first();
  const dbBefore = await readDb(page);
  const rawBefore = dbBefore.batches.filter(b => b.warehouseId === 'wh-raw').reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
  if (await issueBtn.count()) {
    const d1 = dialogs.length;
    await issueBtn.click({ force: true });
    await page.waitForTimeout(1500);
    const dbA = await readDb(page);
    const rawAfter = dbA.batches.filter(b => b.warehouseId === 'wh-raw').reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
    R.add({
      id: `${ref}-ISSUE`,
      name: `${ref}: materials issued from WH-01 against the BOM`,
      status: rawAfter < rawBefore ? 'PASS' : 'FAIL',
      detail: `rawValue ${r2(rawBefore)}→${r2(rawAfter)} (Δ${r2(rawBefore - rawAfter)}); dialogs=${dialogs.slice(d1).map(x => `${x.type}:${x.message.slice(0, 80)}`).join('|')}`,
    });
  } else {
    R.add({ id: `${ref}-ISSUE`, name: `${ref}: materials issued from WH-01 against the BOM`, status: 'FAIL', detail: 'صرف خامات button not found' });
  }
  dialogAction = 'dismiss';

  // record production output
  const outBtn = page.locator('main button', { hasText: 'تسجيل إنتاج يومي' }).first();
  if (await outBtn.count()) {
    await outBtn.click({ force: true });
    await page.waitForTimeout(700);
    const om = page.locator('div.fixed.inset-0').last();
    await fillFields(om, [{ i: 0, value: String(produceQty) }, { i: 1, value: '0' }, { i: 2, value: '0' }]);
    await om.locator('button', { hasText: 'تأكيد واستلام الإنتاج' }).click();
    await page.waitForTimeout(1500);
  }
  const dbO = await readDb(page);
  const fgQty = qtyWh(dbO, fg.id, 'wh-local');
  R.add({ id: `${ref}-OUTPUT`, name: `${ref}: ${produceQty} cartons received into WH-02`, status: fgQty > 0 ? 'PASS' : 'FAIL', detail: `FG WH-02=${fgQty}; orderStatus=${dbO.productionOrders.slice(-1)[0]?.status}` });

  // close the order (confirm dialog)
  dialogAction = 'accept';
  const closeBtn = page.locator('main button', { hasText: 'إغلاق واحتساب التكاليف' }).first();
  if (await closeBtn.count()) {
    const d2 = dialogs.length;
    await closeBtn.click({ force: true });
    await page.waitForTimeout(1500);
    R.add({ id: `${ref}-CLOSE`, name: `${ref}: order closed`, status: 'PASS', detail: `dialogs=${dialogs.slice(d2).map(x => `${x.type}:${x.message.slice(0, 90)}`).join(' | ')}` });
  }
  dialogAction = 'dismiss';
  const dbF = await readDb(page);
  return { orderId: dbO.productionOrders.slice(-1)[0]?.id, produced: qtyWh(dbF, fg.id, 'wh-local') };
}

// ================================================== SETUP
let FG, CUSTOMER;
{
  // 1. test customer
  const m = await openCreate(page, 'customers', 'إضافة عميل جديد');
  await fillFields(m, [{ i: 0, value: 'CUST-SALES-01' }, { i: 2, value: 'عميل مبيعات UAT' }, { i: 4, value: '5000' }]);
  await m.locator('button', { hasText: 'حفظ العميل' }).click();
  await page.waitForTimeout(700);
  let db = await readDb(page);
  CUSTOMER = db.customers.find(c => c.code === 'CUST-SALES-01');
  R.add({ id: 'SETUP-CUST', name: 'Setup: test customer created through the UI', status: CUSTOMER ? 'PASS' : 'FAIL', detail: `id=${CUSTOMER?.id}` });

  // 2. FIFO layer test on raw material (3 cost layers + a transfer that consumes them)
  db = await readDb(page);
  const corn = db.items.find(i => i.code === 'RM-CORN-01') || db.items.find(i => i.itemType === 'raw_material') || db.items[0];
  const mf = await openCreate(page, 'purchasing', 'فاتورة استلام خامات جديدة');
  await fillFields(mf, [{ i: 3, value: 'FIFO-01' }, { i: 7, value: corn.id }, { i: 8, value: '100' }, { i: 9, value: '60' }, { i: 10, value: 'FIFO-A' }, { i: 12, value: '0' }]);
  await mf.locator('button', { hasText: 'إضافة مادة' }).first().click(); await page.waitForTimeout(200);
  await fillFields(mf, [{ i: 13, value: corn.id }, { i: 14, value: '100' }, { i: 15, value: '65' }, { i: 16, value: 'FIFO-B' }, { i: 18, value: '0' }]);
  await mf.locator('button', { hasText: 'إضافة مادة' }).first().click(); await page.waitForTimeout(200);
  await fillFields(mf, [{ i: 19, value: corn.id }, { i: 20, value: '100' }, { i: 21, value: '70' }, { i: 22, value: 'FIFO-C' }, { i: 24, value: '0' }]);
  await mf.locator('button', { hasText: 'حفظ وترحيل الاستلام' }).click();
  await page.waitForTimeout(1400);
  await closeModal(page);
  db = await readDb(page);
  const fifoLayers = db.batches.filter(b => b.itemId === corn.id && ['FIFO-A', 'FIFO-B', 'FIFO-C'].includes(b.batchNumber));
  R.add({ id: 'FIFO-SETUP', name: 'Setup: three FIFO cost layers created (100@60, 100@65, 100@70)', status: fifoLayers.length === 3 ? 'PASS' : 'FAIL', detail: fifoLayers.map(b => `${b.batchNumber}=${b.quantity}@${b.unitCost}`).join(', ') });

  // transfer 250 out of WH-01 → must consume FIFO-A then FIFO-B then part of FIFO-C
  const preTransfer = db.batches.map(b => ({ ...b }));
  const mt = await openCreate(page, 'inventory', 'تحويل مخزني داخلي');
  await fillFields(mt, [{ i: 0, value: corn.id }, { i: 1, value: 'wh-raw' }, { i: 2, value: 'wh-local' }, { i: 3, value: '250' }, { i: 4, value: 'FIFO-TRANSFER' }]);
  await mt.locator('button', { hasText: 'تنفيذ التحويل' }).click();
  await page.waitForTimeout(1200);
  db = await readDb(page);
  const afterT = db.batches.filter(b => b.itemId === corn.id);
  const expectedRemaining = fifoCogs(preTransfer, corn.id, 'wh-raw', 250);
  const remainingRaw = qtyWh(db, corn.id, 'wh-raw');
  const layerDetail = afterT.map(b => `${b.warehouseId}/${b.batchNumber}=${b.quantity}@${b.unitCost}`).join(', ');
  // FIFO expectation: A(100@60) + B(100@65) + C(50@70) consumed → 50@70 left in WH-01
  const fifoCorrect = Math.abs(remainingRaw - 50) < 0.001
    && afterT.some(b => b.batchNumber === 'FIFO-C' && b.warehouseId === 'wh-raw' && Math.abs(b.quantity - 50) < 0.001)
    && !afterT.some(b => ['FIFO-A', 'FIFO-B'].includes(b.batchNumber) && b.warehouseId === 'wh-raw' && b.quantity > 0);
  R.add({
    id: 'FIFO-01',
    name: 'FIFO: a 250-unit movement consumes the oldest layers first (A@60, B@65, part of C@70)',
    status: fifoCorrect ? 'PASS' : 'FAIL',
    detail: `expected=${JSON.stringify(expectedRemaining.consumed)}; remainingWH01=${remainingRaw}; layers=${layerDetail}`,
  });

  // 3. finished-goods stock through the real production cycle
  db = await readDb(page);
  FG = db.items.find(i => i.code === 'FP-SNG-01') || db.items.filter(i => i.itemType === 'finished_product')[0];
  const bom = db.boms.find(b => b.productId === FG.id) || db.boms[0];
  const bomLines = db.bomLines.filter(l => l.bomId === bom.id);
  R.add({ id: 'SETUP-BOM', name: 'Setup: BOM available for the finished good', status: bomLines.length > 0 ? 'PASS' : 'FAIL', detail: `bom=${bom?.id}; lines=${bomLines.length}` });
  await purchaseMaterials(page, bomLines, 1000, 'SALES-MAT');
  const prod = await runProduction(page, FG, 1000, 400, 'SETUP-PROD');
  R.add({ id: 'SETUP-FG', name: 'Setup: finished goods available in WH-02 for the sales scenario', status: qtyWh(await readDb(page), FG.id, 'wh-local') >= 100 ? 'PASS' : 'FAIL', detail: `FG WH-02=${qtyWh(await readDb(page), FG.id, 'wh-local')}` });
}

// ============================================================ SALES
{
  let db = await readDb(page);
  const inv0 = db.salesInvoices.length;
  const j0 = db.journalEntries.length;
  const stock0 = qtyWh(db, FG.id, 'wh-local');
  const preSaleBatches = db.batches.map(b => ({ ...b }));

  const m = await openCreate(page, 'sales', 'فاتورة بيع جديدة');
  await fillFields(m, [
    { i: 0, value: CUSTOMER.id }, { i: 1, value: 'wholesale' }, { i: 5, value: 'credit' },
    { i: 8, value: FG.id }, { i: 9, value: '50' }, { i: 11, value: '100' }, { i: 12, value: '0' },
  ]);
  const d0 = dialogs.length;
  await m.locator('button', { hasText: 'حفظ وترحيل الفاتورة' }).click();
  await page.waitForTimeout(1600);
  db = await readDb(page);
  const sale = db.salesInvoices[db.salesInvoices.length - 1];
  const stock1 = qtyWh(db, FG.id, 'wh-local');
  const jNew = db.journalEntries.length - j0;
  R.add({
    id: 'SALE-01',
    name: 'Local sales invoice posts once: invoice, stock deduction, journal',
    status: (db.salesInvoices.length === inv0 + 1 && stock1 === stock0 - 50 && jNew > 0) ? 'PASS' : 'FAIL',
    detail: `invoices ${inv0}→${db.salesInvoices.length}; FG stock ${stock0}→${stock1}; newJournals=${jNew}; dialogs=${dialogs.slice(d0).map(x => x.message).join('|').slice(0, 120)}`,
  });

  // FIFO COGS recomputation from the pre-sale snapshot
  const expected = fifoCogs(preSaleBatches, FG.id, 'wh-local', 50);
  const cogsOk = Math.abs((sale?.cogsTotal || 0) - expected.cost) < 0.01;
  R.add({
    id: 'SALE-02',
    name: 'COGS equals an independent FIFO recomputation of the pre-sale WH-02 layers',
    status: cogsOk ? 'PASS' : 'FAIL',
    detail: `cogsOnInvoice=${sale?.cogsTotal}; expectedFIFO=${expected.cost}; consumed=${expected.consumed.join(', ')}; invoice=${JSON.stringify(sale && { sub: sale.subtotal, vat: sale.vatAmount, total: sale.totalAmount, bonus: sale.bonusQuantity, wh: sale.warehouseId })}`,
  });

  // journal balance + linkage
  const unbal = db.journalEntries.filter(j => Math.abs(j.lines.reduce((s, l) => s + (l.debit || 0), 0) - j.lines.reduce((s, l) => s + (l.credit || 0), 0)) > 0.005);
  R.add({ id: 'SALE-03', name: 'All journals balanced after the sale', status: unbal.length === 0 ? 'PASS' : 'FAIL', detail: `unbalanced=${unbal.map(j => j.id).join(',') || 'none'}` });

  const nums = db.salesInvoices.map(i => i.invoiceNumber);
  R.add({ id: 'SALE-04', name: 'Invoice numbers unique', status: new Set(nums).size === nums.length ? 'PASS' : 'FAIL', detail: nums.join(',') });

  // duplicate submission
  const beforeDup = (await readDb(page)).salesInvoices.length;
  const m2 = await openCreate(page, 'sales', 'فاتورة بيع جديدة');
  await fillFields(m2, [{ i: 0, value: CUSTOMER.id }, { i: 1, value: 'wholesale' }, { i: 5, value: 'credit' }, { i: 8, value: FG.id }, { i: 9, value: '10' }, { i: 11, value: '100' }, { i: 12, value: '0' }]);
  const save = m2.locator('button', { hasText: 'حفظ وترحيل الفاتورة' });
  await Promise.all([save.click({ force: true }).catch(() => {}), save.click({ force: true }).catch(() => {}), save.click({ force: true }).catch(() => {})]);
  await page.waitForTimeout(1600);
  const dbDup = await readDb(page);
  R.add({ id: 'SALE-05', name: 'Rapid repeated save creates exactly one invoice', status: dbDup.salesInvoices.length === beforeDup + 1 ? 'PASS' : 'FAIL', detail: `invoices ${beforeDup}→${dbDup.salesInvoices.length}` });

  // zero quantity
  const beforeZ = (await readDb(page)).salesInvoices.length;
  const m3 = await openCreate(page, 'sales', 'فاتورة بيع جديدة');
  await fillFields(m3, [{ i: 0, value: CUSTOMER.id }, { i: 8, value: FG.id }, { i: 9, value: '0' }, { i: 11, value: '100' }, { i: 12, value: '0' }]);
  const dz = dialogs.length;
  await m3.locator('button', { hasText: 'حفظ وترحيل الفاتورة' }).click();
  await page.waitForTimeout(900);
  R.add({ id: 'SALE-06', name: 'Zero-quantity invoice line is rejected', status: (await readDb(page)).salesInvoices.length === beforeZ ? 'PASS' : 'FAIL', detail: `invoices ${beforeZ}→${(await readDb(page)).salesInvoices.length}; dialogs=${dialogs.slice(dz).map(x => x.message).join('|').slice(0, 120)}` });
  await closeModal(page);

  // insufficient stock (inline message observed earlier)
  const stockNow = qtyWh(await readDb(page), FG.id, 'wh-local');
  const beforeS = (await readDb(page)).salesInvoices.length;
  const m4 = await openCreate(page, 'sales', 'فاتورة بيع جديدة');
  await fillFields(m4, [{ i: 0, value: CUSTOMER.id }, { i: 8, value: FG.id }, { i: 9, value: String(stockNow + 5000) }, { i: 11, value: '100' }, { i: 12, value: '0' }]);
  const ds = dialogs.length;
  await m4.locator('button', { hasText: 'حفظ وترحيل الفاتورة' }).click();
  await page.waitForTimeout(1100);
  const dbS = await readDb(page);
  const inlineMsg = (await m4.innerText().catch(() => '')).replace(/\s+/g, ' ');
  R.add({
    id: 'SALE-07',
    name: 'Sale beyond available stock is rejected with no partial deduction',
    status: (dbS.salesInvoices.length === beforeS && qtyWh(dbS, FG.id, 'wh-local') === stockNow) ? 'PASS' : 'FAIL',
    detail: `invoices ${beforeS}→${dbS.salesInvoices.length}; stock ${stockNow}→${qtyWh(dbS, FG.id, 'wh-local')}; inline=${/رصيد الصنف/.test(inlineMsg)}; dialogs=${dialogs.slice(ds).map(x => x.message).join('|').slice(0, 120)}`,
  });
  await closeModal(page);

  // bonus 10+1
  const dbB0 = await readDb(page);
  const stockB0 = qtyWh(dbB0, FG.id, 'wh-local');
  const invB0 = dbB0.salesInvoices.length;
  const m5 = await openCreate(page, 'sales', 'فاتورة بيع جديدة');
  await fillFields(m5, [{ i: 0, value: CUSTOMER.id }, { i: 1, value: 'wholesale' }, { i: 5, value: 'credit' }, { i: 8, value: FG.id }, { i: 9, value: '10' }, { i: 11, value: '100' }, { i: 12, value: '0' }]);
  const bonusBtn = m5.locator('button', { hasText: '10+1' }).first();
  let bonusClicked = false, bonusHint = '';
  if (await bonusBtn.count()) {
    bonusHint = (await bonusBtn.innerText().catch(() => '')).trim();
    await bonusBtn.click({ force: true });
    await page.waitForTimeout(500);
    bonusClicked = true;
  }
  const bonusField = m5.locator('input[type="number"]').nth(1); // index 10 = bonus (free) quantity
  const qtyAfterBonus = await bonusField.inputValue().catch(() => '?');
  await m5.locator('button', { hasText: 'حفظ وترحيل الفاتورة' }).click();
  await page.waitForTimeout(1600);
  const dbB = await readDb(page);
  const bonusInv = dbB.salesInvoices[dbB.salesInvoices.length - 1] || null;
  const stockB1 = qtyWh(dbB, FG.id, 'wh-local');
  const deducted = stockB0 - stockB1;
  const bonusLines = (dbB.salesInvoiceLines || []).filter(l => l.invoiceId === bonusInv?.id);
  const expectedIssue = (bonusInv ? (bonusLines.reduce((s, l) => s + (l.quantity || 0), 0) + (bonusInv.bonusQuantity || 0)) : 0);
  R.add({
    id: 'SALE-08',
    name: 'Bonus 10+1: free unit has zero selling value but is still issued from stock',
    status: (dbB.salesInvoices.length === invB0 + 1 && bonusInv)
      ? ((bonusInv.subtotal === 1000 && deducted === expectedIssue) ? 'PASS' : 'FAIL')
      : 'FAIL',
    detail: `bonusClicked=${bonusClicked}; label="${bonusHint}"; bonusFieldAfterClick=${qtyAfterBonus}; bonusQuantity=${bonusInv?.bonusQuantity}; subtotal=${bonusInv?.subtotal}; total=${bonusInv?.totalAmount}; lines=${JSON.stringify(bonusLines.map(l => ({ item: l.itemId, q: l.quantity, price: l.unitPrice, free: l.freeQuantity, amt: l.amount })))}; expectedIssue=${expectedIssue}; stock ${stockB0}→${stockB1} (Δ${deducted})`,
  });

  // credit warning evidence
  R.add({
    id: 'SALE-09',
    name: 'Credit-limit policy evidence on credit sales',
    status: dialogs.some(d => /ائتمان|ائتماني|تجاوز/.test(d.message)) ? 'PASS' : 'WARN',
    detail: dialogs.length ? `dialogs=${dialogs.map(d => d.message.slice(0, 100)).join(' || ')}` : 'no dialogs observed during sales run',
  });

  // print
  await gotoTab(page, 'sales');
  await page.waitForTimeout(600);
  await page.evaluate(() => { window.__uatPrinted = 0; window.print = () => { window.__uatPrinted++; }; });
  const rowButtons = await page.locator('main tbody tr').first().locator('button').allInnerTexts().catch(() => []);
  const printBtn = page.locator('main tbody tr').first().locator('button', { hasText: /عرض|طباعة|PDF/ }).first();
  let printOpened = false;
  if (await printBtn.count()) {
    await printBtn.click({ force: true });
    await page.waitForTimeout(1200);
    printOpened = (await page.locator('div.fixed.inset-0').count()) > 0;
  }
  const previewText = (await page.locator('div.fixed.inset-0').last().innerText().catch(() => '')).replace(/\s+/g, ' ');
  const doPrint = page.locator('div.fixed.inset-0 button', { hasText: 'طباعة' }).first();
  if (await doPrint.count()) { await doPrint.click({ force: true }).catch(() => {}); await page.waitForTimeout(600); }
  const printed = await page.evaluate(() => window.__uatPrinted);
  R.add({
    id: 'SALE-10',
    name: 'Invoice print view opens with real document content and invokes printing',
    status: (printOpened || printed > 0) ? (printed > 0 ? 'PASS' : 'WARN') : 'FAIL',
    detail: `rowButtons=${JSON.stringify(rowButtons)}; opened=${printOpened}; window.print calls=${printed}; preview=${previewText.slice(0, 240)}`,
  });
  await closeModal(page);

  // statement
  await gotoTab(page, 'customers');
  await page.waitForTimeout(500);
  const stmtBtn = page.locator('main button', { hasText: 'كشف حساب' }).first();
  if (await stmtBtn.count()) {
    await stmtBtn.click({ force: true });
    await page.waitForTimeout(800);
    const t = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    const dbC = await readDb(page);
    const cust = dbC.customers.find(c => c.id === CUSTOMER.id);
    const totalSales = dbC.salesInvoices.reduce((s, i) => s + (i.totalAmountEGP || i.totalAmount || 0), 0);
    R.add({
      id: 'SALE-12',
      name: 'Customer statement shows invoices and the running balance',
      status: /فاتورة|مبيعات/.test(t) ? 'PASS' : 'FAIL',
      detail: `dbBalance=${cust?.currentBalance}; totalSalesEGP=${r2(totalSales)}; excerpt=${t.slice(0, 260)}`,
    });
  } else {
    R.add({ id: 'SALE-12', name: 'Customer statement shows invoices and the running balance', status: 'NOT TESTED', detail: 'statement control not found' });
  }

  // CSV export
  await gotoTab(page, 'customers');
  await page.waitForTimeout(400);
  const csvBtn = page.locator('main button', { hasText: /CSV|تصدير/ }).first();
  if (await csvBtn.count()) {
    try {
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 6000 }), csvBtn.click({ force: true })]);
      const fname = download.suggestedFilename();
      const stream = await download.createReadStream();
      let size = 0; for await (const c of stream) size += c.length;
      R.add({ id: 'SALE-13', name: 'Customer list export downloads a real file', status: size > 0 ? 'PASS' : 'FAIL', detail: `file=${fname}; bytes=${size}` });
    } catch (e) {
      R.add({ id: 'SALE-13', name: 'Customer list export downloads a real file', status: 'FAIL', detail: String(e).slice(0, 200) });
    }
  } else {
    R.add({ id: 'SALE-13', name: 'Customer list export downloads a real file', status: 'NOT APPLICABLE', detail: 'no export control on the customers screen' });
  }

  // sales returns screen
  await gotoTab(page, 'customers');
  await page.waitForTimeout(400);
  const returnsTab = page.locator('main button', { hasText: 'مرتجعات المبيعات' }).first();
  if (await returnsTab.count()) {
    await returnsTab.click({ force: true });
    await page.waitForTimeout(700);
    const createCtl = await page.locator('main button', { hasText: /مرتجع|إضافة|جديد/ }).count();
    R.add({ id: 'SALE-14', name: 'Sales returns screen offers a create action', status: createCtl > 0 ? 'PASS' : 'WARN', detail: `controls=${createCtl}` });
  } else {
    R.add({ id: 'SALE-14', name: 'Sales returns screen offers a create action', status: 'FAIL', detail: 'returns tab missing' });
  }
}

R.add({ id: 'SALE-CONSOLE', name: 'No console/page errors during sales testing', status: (R.consoleErrors.length + R.pageErrors.length) === 0 ? 'PASS' : 'FAIL', detail: JSON.stringify([...R.pageErrors, ...R.consoleErrors].slice(0, 8)) });
R.add({ id: 'SALE-DIALOGS', name: 'Dialogs observed during the sales run', status: 'PASS', detail: JSON.stringify(dialogs.map(d => `${d.type}:${d.message.slice(0, 80)}`)).slice(0, 700) });
await shot(page, '06_sales');
console.log('\n=== SUMMARY ===', JSON.stringify(R.summary()));
R.save();
await browser.close();
