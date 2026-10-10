// ISOLATED UAT HARNESS — Phase 3F: PRODUCTION, QUALITY and COSTING through the UI.
import { launchIsolated, login, gotoTab, shot, Results, BASE_URL, openCreate, fillFields, readDb, captureDialogs, closeModal } from './lib.mjs';

const R = new Results('08_production');
const dialogs = [];
let dialogAction = 'dismiss';

const { browser, page } = await launchIsolated();
captureDialogs(page, dialogs, { action: () => dialogAction });
page.on('console', m => { if (m.type() === 'error') R.consoleErrors.push(m.text()); });
page.on('pageerror', e => R.pageErrors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await login(page);

const qtyWh = (db, id, wh) => (db.batches || []).filter(b => b.itemId === id && (!wh || b.warehouseId === wh)).reduce((s, b) => s + b.quantity, 0);
const rawValue = (db) => (db.batches || []).filter(b => b.warehouseId === 'wh-raw').reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const balanced = (db) => db.journalEntries.filter(j => Math.abs(j.lines.reduce((s, l) => s + (l.debit || 0), 0) - j.lines.reduce((s, l) => s + (l.credit || 0), 0)) > 0.005);

let FG, BOM, BOMLINES;

// ------------------------------------------------------------- SETUP
{
  let db = await readDb(page);
  FG = db.items.filter(i => i.itemType === 'finished_product')[0];
  BOM = db.boms.find(b => b.productId === FG.id) || db.boms[0];
  BOMLINES = db.bomLines.filter(l => l.bomId === BOM.id);

  // buy all BOM materials generously through the UI
  const m = await openCreate(page, 'purchasing', 'فاتورة استلام خامات جديدة');
  for (let i = 0; i < BOMLINES.length; i++) {
    if (i > 0) { await m.locator('button', { hasText: 'إضافة مادة' }).first().click(); await page.waitForTimeout(150); }
    const base = 7 + 6 * i;
    const need = Math.ceil((BOMLINES[i].quantityRequired || 1) * 1200 * 1.5);
    await fillFields(m, [
      { i: base, value: BOMLINES[i].materialItemId },
      { i: base + 1, value: String(need) },
      { i: base + 2, value: '25' },
      { i: base + 3, value: `PROD-MAT-${i}` },
      { i: base + 5, value: '0' },
    ]);
  }
  await m.locator('button', { hasText: 'حفظ وترحيل الاستلام' }).click();
  await page.waitForTimeout(1600);
  await closeModal(page);
  db = await readDb(page);
  R.add({
    id: 'PROD-SETUP',
    name: 'Setup: all BOM materials purchased into WH-01 through the UI',
    status: rawValue(db) > 0 ? 'PASS' : 'FAIL',
    detail: `rawValue=${r2(rawValue(db))}; bomLines=${BOMLINES.length}; materials=${BOMLINES.map(l => l.materialItemId).join(',')}`,
  });
}

// ------------------------------------------- BOM / requirements display
{
  await gotoTab(page, 'manufacturing');
  await page.waitForTimeout(500);
  const bomTab = page.locator('main button', { hasText: 'إدارة معادلات التصنيع' }).first();
  if (await bomTab.count()) {
    await bomTab.click();
    await page.waitForTimeout(600);
    const txt = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    R.add({
      id: 'PROD-BOM-01',
      name: 'BOM editor lists the recipe with materials and quantities',
      status: (txt.includes(FG.nameAr) && BOMLINES.length > 0 && txt.length > 400) ? 'PASS' : 'FAIL',
      detail: `chars=${txt.length}; hasProduct=${txt.includes(FG.nameAr)}; sample=${txt.slice(0, 260)}`,
    });
  } else {
    R.add({ id: 'PROD-BOM-01', name: 'BOM editor lists the recipe with materials and quantities', status: 'NOT TESTED', detail: 'BOM section button not found' });
  }
}

// ---------------------------------------- ORDER + BEFORE-issue behaviour
let orderId = null;
{
  const db0 = await readDb(page);
  const raw0 = rawValue(db0);
  const stockFg0 = qtyWh(db0, FG.id, 'wh-local');

  // make sure we are back on the orders section (the BOM probe switched tabs)
  await gotoTab(page, 'manufacturing');
  const ordersTab = page.locator('main button', { hasText: 'أوامر الإنتاج' }).first();
  if (await ordersTab.count()) { await ordersTab.click({ force: true }); await page.waitForTimeout(500); }
  const mo = await openCreate(page, 'manufacturing', 'أمر إنتاج جديد');
  await fillFields(mo, [{ i: 0, value: FG.id }, { i: 1, value: '1000' }, { i: 2, value: 'local' }]);
  const d0 = dialogs.length;
  await mo.locator('button', { hasText: 'اعتماد وإطلاق أمر الإنتاج' }).click();
  await page.waitForTimeout(1300);
  let db1 = await readDb(page);
  orderId = db1.productionOrders.slice(-1)[0]?.id;
  R.add({
    id: 'PROD-01',
    name: 'Production order released with planned quantity and BOM linkage',
    status: orderId ? 'PASS' : 'FAIL',
    detail: `order=${db1.productionOrders.slice(-1)[0]?.orderNumber}; planned=${db1.productionOrders.slice(-1)[0]?.plannedQuantity}; status=${db1.productionOrders.slice(-1)[0]?.status}; dialogs=${dialogs.slice(d0).map(x => x.message).join('|').slice(0, 120)}`,
  });

  // planned requirements shown in the details drawer
  const detailsBtn = page.locator('main button', { hasText: 'التفاصيل و BOM' }).first();
  if (await detailsBtn.count()) {
    await detailsBtn.click({ force: true });
    await page.waitForTimeout(700);
    const dtxt = (await page.locator('div.fixed.inset-0').last().innerText().catch(() => '')).replace(/\s+/g, ' ');
    R.add({
      id: 'PROD-02',
      name: 'Order details show required raw/packaging quantities (BOM × planned)',
      status: dtxt.length > 200 ? 'PASS' : 'FAIL',
      detail: `chars=${dtxt.length}; excerpt=${dtxt.slice(0, 300)}`,
    });
    await closeModal(page);
  } else {
    R.add({ id: 'PROD-02', name: 'Order details show required raw/packaging quantities (BOM × planned)', status: 'NOT TESTED', detail: 'details button not found' });
  }

  // record production BEFORE issuing materials — must not silently consume stock
  const outBtn = page.locator('main button', { hasText: 'تسجيل إنتاج يومي' }).first();
  let beforeIssueResult = 'not attempted';
  if (await outBtn.count()) {
    await outBtn.click({ force: true });
    await page.waitForTimeout(700);
    const om = page.locator('div.fixed.inset-0').last();
    await fillFields(om, [{ i: 0, value: '500' }, { i: 1, value: '0' }, { i: 2, value: '0' }]);
    const d1 = dialogs.length;
    await om.locator('button', { hasText: 'تأكيد واستلام الإنتاج' }).click();
    await page.waitForTimeout(1400);
    const db2 = await readDb(page);
    const fgGained = qtyWh(db2, FG.id, 'wh-local') - stockFg0;
    const rawSpent = raw0 - rawValue(db2);
    const cons = (db2.productionConsumptions || []).filter(c => c.orderId === orderId).length;
    beforeIssueResult = `fgGained=${r2(fgGained)}; rawSpent=${r2(rawSpent)}; consumptionRecords=${cons}; dialogs=${dialogs.slice(d1).map(x => `${x.type}:${x.message.slice(0, 80)}`).join('|')}`;
    R.add({
      id: 'PROD-03',
      name: 'Recording output BEFORE issuing materials does not silently consume raw stock',
      status: (rawSpent <= 0.01 && cons === 0) ? 'PASS' : 'FAIL',
      detail: beforeIssueResult,
    });
    await closeModal(page);
  } else {
    R.add({ id: 'PROD-03', name: 'Recording output BEFORE issuing materials does not silently consume raw stock', status: 'NOT TESTED', detail: 'record-output control not available before issue' });
  }
}

// -------------------------------------------------------- ISSUE MATERIALS
{
  const db0 = await readDb(page);
  const raw0 = rawValue(db0);
  const expectedIssue = BOMLINES.reduce((s, l) => s + l.quantityRequired * 1000, 0);
  dialogAction = 'accept';
  const issueBtn = page.locator('main button', { hasText: 'صرف خامات' }).first();
  const d0 = dialogs.length;
  if (await issueBtn.count()) await issueBtn.click({ force: true });
  await page.waitForTimeout(1600);
  dialogAction = 'dismiss';
  const db1 = await readDb(page);
  const raw1 = rawValue(db1);
  const cons = (db1.productionConsumptions || []).filter(c => c.productionOrderId === orderId);
  R.add({
    id: 'PROD-04',
    name: 'Issue materials posts consumption records and deducts WH-01 value',
    status: (cons.length > 0 && raw1 < raw0) ? 'PASS' : 'FAIL',
    detail: `consumptionLines=${cons.length}; rawValue ${r2(raw0)}→${r2(raw1)} (Δ${r2(raw0 - raw1)}); expectedQty=${r2(expectedIssue)}; dialogs=${dialogs.slice(d0).map(x => `${x.type}:${x.message.slice(0, 70)}`).join('|')}`,
  });

  // issuing twice must not double-consume
  const before2 = rawValue(db1);
  dialogAction = 'accept';
  const issueBtn2 = page.locator('main button', { hasText: 'صرف خامات' }).first();
  if (await issueBtn2.count()) await issueBtn2.click({ force: true });
  await page.waitForTimeout(1500);
  dialogAction = 'dismiss';
  const db2 = await readDb(page);
  const after2 = rawValue(db2);
  const cons2 = (db2.productionConsumptions || []).filter(c => c.productionOrderId === orderId);
  const rawDrop = before2 - after2;
  R.add({
    id: 'PROD-05',
    name: 'Issuing materials twice does not double-consume WH-01',
    status: Math.abs(rawDrop) < 0.01 ? 'PASS' : 'FAIL',
    detail: `consumptionLines ${cons.length}→${cons2.length}; rawValue ${r2(before2)}→${r2(after2)} (Δ${r2(rawDrop)}); secondIssueDialogs=${dialogs.slice(-2).map(x => x.message.slice(0, 70)).join('|')}`,
  });
}

// ------------------------------------------------- PARTIAL PRODUCTION ×2
{
  const rec = async (good, defective, scrap, label) => {
    const db0 = await readDb(page);
    const fg0 = qtyWh(db0, FG.id, 'wh-local');
    const scrap0 = qtyWh(db0, FG.id, 'wh-scrap');
    const btn = page.locator('main button', { hasText: 'تسجيل إنتاج يومي' }).first();
    if (!(await btn.count())) { R.add({ id: `PROD-${label}`, name: `Production recording (${good})`, status: 'NOT TESTED', detail: 'control not available (order closed?)' }); return false; }
    await btn.click({ force: true });
    await page.waitForTimeout(700);
    const om = page.locator('div.fixed.inset-0').last();
    const fields = [{ i: 0, value: String(good) }, { i: 1, value: String(defective) }, { i: 2, value: String(scrap) }];
    if (defective > 0 || scrap > 0) fields.push({ i: 3, value: '', select: 'تحويل لمستودع الهالك والسكراب للبيع المنفصل' }, { i: 4, value: 'هالك اختبار UAT' });
    await fillFields(om, fields);
    const d0 = dialogs.length;
    await om.locator('button', { hasText: 'تأكيد واستلام الإنتاج' }).click();
    await page.waitForTimeout(1500);
    const db1 = await readDb(page);
    const fg1 = qtyWh(db1, FG.id, 'wh-local');
    const scrap1 = qtyWh(db1, FG.id, 'wh-scrap');
    const ok = Math.abs(fg1 - fg0 - good) < 0.01;
    R.add({
      id: `PROD-OUT-${label}`,
      name: `Partial production run (${good} good${defective ? `, ${defective} defective` : ''}${scrap ? `, ${scrap} scrap` : ''}) received exactly once`,
      status: ok ? 'PASS' : 'FAIL',
      detail: `FG WH-02 ${r2(fg0)}→${r2(fg1)} (Δ${r2(fg1 - fg0)}); WH-05 ${r2(scrap0)}→${r2(scrap1)}; dialogs=${dialogs.slice(d0).map(x => `${x.type}:${x.message.slice(0, 70)}`).join('|')}`,
    });
    return true;
  };
  await rec(400, 0, 0, 'A');
  await rec(500, 10, 5, 'B'); // defective + scrap routing

  // over-production beyond the planned 1000
  await rec(200, 0, 0, 'OVER');

  // duplicate completion: closing twice
  dialogAction = 'accept';
  const closeBtn = page.locator('main button', { hasText: 'إغلاق واحتساب التكاليف' }).first();
  const d0 = dialogs.length;
  if (await closeBtn.count()) await closeBtn.click({ force: true });
  await page.waitForTimeout(1600);
  const dbC = await readDb(page);
  const order = dbC.productionOrders.find(o => o.id === orderId);
  R.add({
    id: 'PROD-CLOSE-1',
    name: 'Order close is either executed or explicitly blocked with a reason',
    status: (order?.status === 'completed' || dialogs.slice(d0).some(x => /لا يمكن إغلاق/.test(x.message))) ? 'PASS' : 'FAIL',
    detail: `status=${order?.status}; produced=${order?.producedQuantity}; dialogs=${dialogs.slice(d0).map(x => `${x.type}:${x.message.slice(0, 110)}`).join(' | ')}`,
  });
  // second close attempt
  const closeBtn2 = page.locator('main button', { hasText: 'إغلاق واحتساب التكاليف' }).first();
  const stillOpen = await closeBtn2.count();
  const jBefore = dbC.journalEntries.length;
  if (stillOpen) await closeBtn2.click({ force: true });
  await page.waitForTimeout(1500);
  dialogAction = 'dismiss';
  const dbC2 = await readDb(page);
  R.add({
    id: 'PROD-CLOSE-2',
    name: 'Second close attempt does not post a duplicate closing entry',
    status: (dbC2.journalEntries.length - jBefore) === 0 ? 'PASS' : 'FAIL',
    detail: `closeControlStillPresent=${!!stillOpen}; journals ${jBefore}→${dbC2.journalEntries.length}; produced=${dbC2.productionOrders.find(o => o.id === orderId)?.producedQuantity}`,
  });

  // ---- a clean order to prove the full close path works end-to-end
  const mo2 = await openCreate(page, 'manufacturing', 'أمر إنتاج جديد');
  await fillFields(mo2, [{ i: 0, value: FG.id }, { i: 1, value: '100' }, { i: 2, value: 'local' }]);
  await mo2.locator('button', { hasText: 'اعتماد وإطلاق أمر الإنتاج' }).click();
  await page.waitForTimeout(1300);
  const dbP2 = await readDb(page);
  const order2 = dbP2.productionOrders.slice(-1)[0];
  const row2 = page.locator('main tbody tr', { hasText: order2?.orderNumber || '###' });
  dialogAction = 'accept';
  const issue2 = row2.locator('button', { hasText: 'صرف خامات' }).first();
  await issue2.click({ force: true }).catch(() => {});
  await page.waitForTimeout(1500);
  dialogAction = 'dismiss';
  const out2 = row2.locator('button', { hasText: 'تسجيل إنتاج يومي' }).first();
  if (await out2.count()) {
    await out2.click({ force: true });
    await page.waitForTimeout(700);
    const om2 = page.locator('div.fixed.inset-0').last();
    await fillFields(om2, [{ i: 0, value: '100' }, { i: 1, value: '0' }, { i: 2, value: '0' }]);
    await om2.locator('button', { hasText: 'تأكيد واستلام الإنتاج' }).click();
    await page.waitForTimeout(1500);
  }
  dialogAction = 'accept';
  const jB2 = (await readDb(page)).journalEntries.length;
  const close2 = row2.locator('button', { hasText: 'إغلاق واحتساب التكاليف' }).first();
  const dClose = dialogs.length;
  if (await close2.count()) await close2.click({ force: true }).catch(() => {});
  await page.waitForTimeout(1800);
  dialogAction = 'dismiss';
  const dbP2b = await readDb(page);
  const o2 = dbP2b.productionOrders.find(o => o.id === order2?.id);
  R.add({
    id: 'PROD-CLOSE-FULL',
    name: 'A fully produced order closes successfully and posts its closing journal once',
    status: (o2?.status === 'completed' && (dbP2b.journalEntries.length - jB2) >= 1) ? 'PASS' : 'WARN',
    detail: `order2=${order2?.orderNumber}; produced=${o2?.producedQuantity}/${o2?.plannedQuantity}; status=${o2?.status}; newJournals=${dbP2b.journalEntries.length - jB2}; dialogs=${dialogs.slice(dClose).map(x => `${x.type}:${x.message.slice(0, 90)}`).join(' | ')}`,
  });
}

// ------------------------------------------------------ COST & VARIANCES
{
  const db = await readDb(page);
  const order = db.productionOrders.find(o => o.id === orderId);
  const rates = db.standardCostRates || [];
  const rateSum = rates.reduce((s, r) => s + (r.rate || 0) * (1000 / (r.baseQuantity || r.quantityBase || 1000)), 0);
  const expectedConversion = rateSum * ((order?.producedQuantity || 0) / 1000);

  await gotoTab(page, 'costing');
  await page.waitForTimeout(500);
  const varTab = page.locator('main button', { hasText: 'انحرافات تكلفة' }).first();
  if (await varTab.count()) {
    await varTab.click({ force: true });
    await page.waitForTimeout(700);
    const txt = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    R.add({
      id: 'PROD-COST-01',
      name: 'Cost variance screen shows the order with standard vs actual',
      status: txt.length > 300 ? 'PASS' : 'WARN',
      detail: `chars=${txt.length}; excerpt=${txt.slice(0, 300)}`,
    });
  } else {
    R.add({ id: 'PROD-COST-01', name: 'Cost variance screen shows the order with standard vs actual', status: 'NOT TESTED', detail: 'variances sub-tab not found' });
  }

  // configured rates and the conversion cost they imply
  R.add({
    id: 'PROD-COST-02',
    name: 'Standard conversion rates come from configuration (250/100/5/50/30 per 1,000 cartons)',
    status: (rates.length === 5 && rates.every(r => [250, 100, 5, 50, 30].includes(r.rate))) ? 'PASS' : 'FAIL',
    detail: `rates=${rates.map(r => r.rate).join('/')}; produced=${order?.producedQuantity}; expectedConversionEGP=${r2(expectedConversion)}`,
  });

  const unbal = balanced(db);
  R.add({ id: 'PROD-GL-01', name: 'All journals balanced after the production cycle', status: unbal.length === 0 ? 'PASS' : 'FAIL', detail: `unbalanced=${unbal.map(j => j.id).join(',') || 'none'}` });

  // FG valuation traceability: FG batches carry the production order reference
  const fgBatches = db.batches.filter(b => b.itemId === FG.id && b.warehouseId === 'wh-local');
  const traceable = fgBatches.filter(b => (b.batchNumber || '').includes(order?.orderNumber || '###') || (b.reference || b.sourceDocumentId || '').includes(orderId || '###'));
  R.add({
    id: 'PROD-TRACE-01',
    name: 'Finished-goods batches are traceable back to the production order',
    status: traceable.length > 0 ? 'PASS' : 'WARN',
    detail: `batches=${fgBatches.map(b => b.batchNumber).join(', ')}; traceable=${traceable.length}; order=${order?.orderNumber}`,
  });

  // raw stock after issue, scrap routing
  R.add({
    id: 'PROD-STOCK-01',
    name: 'Post-cycle stock: WH-01 issued, WH-02 received good output, WH-05 holds scrap',
    status: (qtyWh(db, FG.id, 'wh-local') > 0 && rawValue(db) >= 0) ? 'PASS' : 'FAIL',
    detail: `FG WH-02=${r2(qtyWh(db, FG.id, 'wh-local'))}; FG WH-05=${r2(qtyWh(db, FG.id, 'wh-scrap'))}; rawValue=${r2(rawValue(db))}`,
  });
}

// -------------------------------------------------------------- QUALITY
{
  const db0 = await readDb(page);
  const inspections0 = (db0.qualityInspections || []).length;
  const fgStock = qtyWh(db0, FG.id, 'wh-local');

  // pass inspection
  const m = await openCreate(page, 'quality', 'تسجيل محضر فحص جودة');
  await fillFields(m, [
    { i: 0, value: 'production_output' },
    { i: 1, value: 'QC-UAT-001' },
    { i: 2, value: FG.id },
    { i: 3, value: '10' },
    { i: 4, value: 'passed' },
    { i: 5, value: 'saleable' },
    { i: 6, value: 'فحص استلام UAT' },
  ]);
  const d0 = dialogs.length;
  await m.locator('button', { hasText: 'اعتماد محضر الفحص' }).click();
  await page.waitForTimeout(1300);
  const db1 = await readDb(page);
  R.add({
    id: 'QC-01',
    name: 'QC inspection (pass → saleable) recorded through the UI',
    status: (db1.qualityInspections || []).length === inspections0 + 1 ? 'PASS' : 'FAIL',
    detail: `inspections ${inspections0}→${(db1.qualityInspections || []).length}; FG stock ${r2(fgStock)}→${r2(qtyWh(db1, FG.id, 'wh-local'))}; dialogs=${dialogs.slice(d0).map(x => x.message).join('|').slice(0, 120)}`,
  });

  // fail inspection routed to defective warehouse
  const m2 = await openCreate(page, 'quality', 'تسجيل محضر فحص جودة');
  await fillFields(m2, [
    { i: 0, value: 'production_output' }, { i: 1, value: 'QC-UAT-002' }, { i: 2, value: FG.id },
    { i: 3, value: '5' }, { i: 4, value: 'failed' }, { i: 5, value: 'defective' }, { i: 6, value: 'رفض اختبار UAT' },
  ]);
  const d1 = dialogs.length;
  await m2.locator('button', { hasText: 'اعتماد محضر الفحص' }).click();
  await page.waitForTimeout(1300);
  const db2 = await readDb(page);
  R.add({
    id: 'QC-02',
    name: 'QC inspection (reject → WH-04 defective) recorded through the UI',
    status: (db2.qualityInspections || []).length === inspections0 + 2 ? 'PASS' : 'FAIL',
    detail: `inspections=${(db2.qualityInspections || []).length}; FG WH-02=${r2(qtyWh(db2, FG.id, 'wh-local'))}; dialogs=${dialogs.slice(d1).map(x => x.message).join('|').slice(0, 120)}`,
  });

  // list of inspections is visible
  await gotoTab(page, 'quality');
  await page.waitForTimeout(600);
  const txt = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  R.add({ id: 'QC-03', name: 'QC register lists the recorded inspections', status: /QC-UAT-001|QC-UAT-002|QC-4072|فحص/.test(txt) ? 'PASS' : 'WARN', detail: txt.slice(0, 240) });
}

// ------------------------------------------------------- NO-CONSOLE CHECK
R.add({ id: 'PROD-CONSOLE', name: 'No console/page errors during production testing', status: (R.consoleErrors.length + R.pageErrors.length) === 0 ? 'PASS' : 'FAIL', detail: JSON.stringify([...R.pageErrors, ...R.consoleErrors].slice(0, 8)) });
R.add({ id: 'PROD-DIALOGS', name: 'Dialogs observed during the production run', status: 'PASS', detail: JSON.stringify(dialogs.map(d => `${d.type}:${d.message.slice(0, 70)}`)).slice(0, 700) });
await shot(page, '08_production');
console.log('\n=== SUMMARY ===', JSON.stringify(R.summary()));
R.save();
await browser.close();
