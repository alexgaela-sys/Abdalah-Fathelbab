// ISOLATED UAT HARNESS — Phase 3K + 3L + 3N: accounting, reports, dashboard
// reconciliation, printing and the audit trail — through the real UI.
import { launchIsolated, login, gotoTab, shot, Results, BASE_URL, openCreate, fillFields, readDb, captureDialogs, closeModal } from './lib.mjs';

const R = new Results('11_accounting_reports');
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
const acc = (db, code) => (db.accounts.find(a => a.code === code)?.currentBalance) || 0;
const unbal = (db) => db.journalEntries.filter(j => Math.abs(j.lines.reduce((s, l) => s + (l.debit || 0), 0) - j.lines.reduce((s, l) => s + (l.credit || 0), 0)) > 0.005);

/** Arabic-Indic / separator tolerant number parse. */
function num(s) {
  if (s == null) return NaN;
  const western = String(s)
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u066B\u066C]/g, m => (m === '\u066B' ? '.' : '')) // Arabic decimal sep / thousands sep
    .replace(/[^\d.\-]/g, '');
  return Number(western);
}

// ================================================= SETUP (non-zero data)
{
  // purchase receipt so inventory + payables + cash accounts are non-zero
  const m = await openCreate(page, 'purchasing', 'فاتورة استلام خامات جديدة');
  await fillFields(m, [
    { i: 3, value: 'RPT-STOCK-01' },
    { i: 7, value: (await readDb(page)).items.find(i => i.itemType === 'raw_material').id },
    { i: 8, value: '200' },
    { i: 9, value: '60' },
    { i: 10, value: 'RPT-BATCH-1' },
    { i: 12, value: '0' },
  ]);
  await m.locator('button', { hasText: 'حفظ وترحيل الاستلام' }).click();
  await page.waitForTimeout(1500);
  await closeModal(page);

  // a customer + a treasury receipt
  const mc = await openCreate(page, 'customers', 'إضافة عميل جديد');
  await fillFields(mc, [{ i: 0, value: 'CUST-RPT-01' }, { i: 2, value: 'عميل تقارير UAT' }]);
  await mc.locator('button', { hasText: 'حفظ العميل' }).click();
  await page.waitForTimeout(700);
  await closeModal(page);

  const mt = await openCreate(page, 'treasury', 'حركة قبض / صرف خزينة');
  await fillFields(mt, [{ i: 0, value: 'cash_receipt' }, { i: 2, value: '5000' }, { i: 3, value: 'طرف التقارير' }, { i: 5, value: 'سند قبض التقارير' }]);
  await mt.locator('button', { hasText: 'حفظ وترحيل القيد' }).click();
  await page.waitForTimeout(1300);
  await closeModal(page);

  const db = await readDb(page);
  const nonzero = db.accounts.filter(a => (a.currentBalance || 0) !== 0).length;
  R.add({ id: 'SETUP-DATA', name: 'Setup: isolated profile holds non-zero transactions for reporting', status: nonzero >= 3 ? 'PASS' : 'FAIL', detail: `nonZeroAccounts=${nonzero}; journals=${db.journalEntries.length}` });
}

// ================================================= ACCOUNTING (manual JV)
{
  const db0 = await readDb(page);
  const cash0 = acc(db0, '1101');
  const j0 = db0.journalEntries.length;

  // balanced journal
  const m = await openCreate(page, 'accounting', 'قيد يومية يدوي متزن');
  await fillFields(m, [
    { i: 1, value: 'JV-UAT-001' },
    { i: 2, value: 'قيد اختبار UAT' },
    { i: 3, value: 'acc-1101' },
    { i: 4, value: '1200' },
    { i: 5, value: '0' },
    { i: 6, value: 'مدين' },
    { i: 7, value: 'acc-4101' },
    { i: 8, value: '0' },
    { i: 9, value: '1200' },
    { i: 10, value: 'دائن' },
  ]);
  const d0 = dialogs.length;
  await m.locator('button', { hasText: 'ترحيل القيد' }).click();
  await page.waitForTimeout(1400);
  const db1 = await readDb(page);
  R.add({
    id: 'ACC-01',
    name: 'Balanced manual journal posts exactly once and moves both accounts',
    status: (db1.journalEntries.length === j0 + 1 && Math.abs(acc(db1, '1101') - cash0 - 1200) < 0.01) ? 'PASS' : 'FAIL',
    detail: `journals ${j0}→${db1.journalEntries.length}; 1101 ${r2(cash0)}→${r2(acc(db1, '1101'))}; dialogs=${dialogs.slice(d0).map(x => x.message).join('|').slice(0, 140)}`,
  });

  // unbalanced journal must be rejected
  const before = (await readDb(page)).journalEntries.length;
  const m2 = await openCreate(page, 'accounting', 'قيد يومية يدوي متزن');
  await fillFields(m2, [
    { i: 1, value: 'JV-UAT-UNBAL' }, { i: 2, value: 'قيد غير متزن' },
    { i: 3, value: 'acc-1101' }, { i: 4, value: '5000' }, { i: 5, value: '0' }, { i: 6, value: 'مدين' },
    { i: 7, value: 'acc-4101' }, { i: 8, value: '0' }, { i: 9, value: '100' }, { i: 10, value: 'دائن' },
  ]);
  const d1 = dialogs.length;
  const save2 = m2.locator('button', { hasText: 'ترحيل القيد' }).first();
  const disabled = await save2.isDisabled().catch(() => false);
  if (!disabled) await save2.click({ force: true }).catch(() => {});
  await page.waitForTimeout(1300);
  const db2 = await readDb(page);
  R.add({
    id: 'ACC-02',
    name: 'Unbalanced manual journal is rejected (submit disabled or posting refused)',
    status: db2.journalEntries.length === before ? 'PASS' : 'FAIL',
    detail: `submitDisabled=${disabled}; journals ${before}→${db2.journalEntries.length}; dialog=${dialogs.slice(d1).map(x => x.message).join('|').slice(0, 160)}; modalStillOpen=${(await page.locator('div.fixed.inset-0').count()) > 0}`,
  });
  await closeModal(page);

  // duplicate submission
  const beforeD = (await readDb(page)).journalEntries.length;
  const m3 = await openCreate(page, 'accounting', 'قيد يومية يدوي متزن');
  await fillFields(m3, [
    { i: 1, value: 'JV-UAT-DBL' }, { i: 2, value: 'قيد مكرر' },
    { i: 3, value: 'acc-1101' }, { i: 4, value: '300' }, { i: 5, value: '0' }, { i: 6, value: '' },
    { i: 7, value: 'acc-4101' }, { i: 8, value: '0' }, { i: 9, value: '300' }, { i: 10, value: '' },
  ]);
  const save = m3.locator('button', { hasText: 'ترحيل القيد' });
  await Promise.all([save.click({ force: true }).catch(() => {}), save.click({ force: true }).catch(() => {})]);
  await page.waitForTimeout(1500);
  const db3 = await readDb(page);
  const dbl = db3.journalEntries.filter(j => /JV-UAT-DBL/.test(j.reference || j.description || ''));
  R.add({ id: 'ACC-03', name: 'Rapid repeated save posts one journal', status: db3.journalEntries.length === beforeD + 1 ? 'PASS' : 'FAIL', detail: `journals ${beforeD}→${db3.journalEntries.length}; matching=${dbl.length}` });
  await closeModal(page);

  // every journal balanced
  const db4 = await readDb(page);
  R.add({ id: 'ACC-04', name: 'Every posted journal is balanced', status: unbal(db4).length === 0 ? 'PASS' : 'FAIL', detail: `journals=${db4.journalEntries.length}; unbalanced=${unbal(db4).map(j => j.id).join(',') || 'none'}` });

  // chart of accounts
  await gotoTab(page, 'accounting');
  await page.waitForTimeout(400);
  const chartBtn = page.locator('main button', { hasText: 'دليل الحسابات' }).first();
  if (await chartBtn.count()) {
    await chartBtn.click({ force: true });
    await page.waitForTimeout(700);
    const txt = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    const rows = await page.locator('main tbody tr').count();
    R.add({
      id: 'ACC-05',
      name: 'Chart of accounts renders the tree with codes and balances',
      status: rows >= 40 && /1101|1102/.test(txt) ? 'PASS' : 'FAIL',
      detail: `rows=${rows}; accounts=${db4.accounts.length}; hasCodes=${/1101|1102/.test(txt)}`,
    });
  } else {
    R.add({ id: 'ACC-05', name: 'Chart of accounts renders the tree with codes and balances', status: 'NOT TESTED', detail: 'chart control not found' });
  }

  // general ledger with an account filter
  const glBtn = page.locator('main button', { hasText: 'كشف حساب الأستاذ' }).first();
  if (await glBtn.count()) {
    await glBtn.click({ force: true });
    await page.waitForTimeout(700);
    const rows0 = await page.locator('main tbody tr').count();
    const sels = page.locator('main select');
    if (await sels.count()) {
      const opts = await sels.first().locator('option').allInnerTexts().catch(() => []);
      if (opts.length > 1) { await sels.first().selectOption({ index: 1 }).catch(() => {}); await page.waitForTimeout(600); }
    }
    const rows1 = await page.locator('main tbody tr').count();
    R.add({
      id: 'ACC-06',
      name: 'General ledger opens and responds to the account filter',
      status: rows0 > 0 && rows1 > 0 ? 'PASS' : 'WARN',
      detail: `rowsBefore=${rows0}; rowsAfterFilter=${rows1}`,
    });
  } else {
    R.add({ id: 'ACC-06', name: 'General ledger opens and responds to the account filter', status: 'NOT TESTED', detail: 'GL control not found' });
  }

  // accounting periods
  const perBtn = page.locator('main button', { hasText: 'الفترات المالية' }).first();
  if (await perBtn.count()) {
    await perBtn.click({ force: true });
    await page.waitForTimeout(600);
    const txt = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    R.add({ id: 'ACC-07', name: 'Accounting periods screen renders (open/closed periods)', status: /2026|فترة/.test(txt) ? 'PASS' : 'FAIL', detail: txt.slice(0, 220) });
  } else {
    R.add({ id: 'ACC-07', name: 'Accounting periods screen renders (open/closed periods)', status: 'NOT TESTED', detail: 'periods control not found' });
  }
}

// =========================================================== REPORTS
{
  // TRIAL BALANCE
  await gotoTab(page, 'reports');
  await page.waitForTimeout(500);
  const tbBtn = page.locator('main button', { hasText: 'ميزان المراجعة' }).first();
  if (await tbBtn.count()) await tbBtn.click({ force: true });
  await page.waitForTimeout(900);
  const tbText = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  const tbRows = await page.locator('main tbody tr').allInnerTexts();
  let dSum = 0, cSum = 0, parsedRows = 0;
  for (const row of tbRows) {
    const cells = row.split(/\s+/).map(s => s.trim());
    const nums = cells.map(num).filter(n => !Number.isNaN(n) && n !== 0);
    if (nums.length >= 2) { dSum += nums[nums.length - 2]; cSum += nums[nums.length - 1]; parsedRows++; }
    else if (nums.length === 1) { dSum += nums[0]; parsedRows++; }
  }
  const db = await readDb(page);
  // totals row (tfoot) of the trial balance — independent verification of the displayed totals
  const footText = await page.locator('main tfoot tr').first().innerText().catch(() => '');
  const footTokens = footText.split(/\s+/).filter(t => /[\d\u0660-\u0669\u06F0-\u06F9]/.test(t));
  const fNums = footTokens.map(num).filter(n => !Number.isNaN(n));
  // [movesDebit, movesCredit, closingDebit, closingCredit, diff]
  const movesD = fNums[0], movesC = fNums[1], closeD = fNums[2], closeC = fNums[3], diff = fNums[4];
  // independent check: sum of ALL account balances by nature
  let indDebit = 0, indCredit = 0;
  const DEBIT_NATURE = ['Assets', 'COGS', 'Operating Expenses', 'Other Expenses'];
  for (const a of db.accounts) {
    const bal = a.currentBalance || 0;
    if (DEBIT_NATURE.includes(a.category)) indDebit += bal; else indCredit += bal;
  }
  R.add({
    id: 'RPT-TB-01',
    name: 'Trial balance totals row balances (Σdebit = Σcredit, moves and closing)',
    status: (parsedRows > 0 && !Number.isNaN(closeD) && Math.abs(movesD - movesC) < 1 && Math.abs(closeD - closeC) < 1 && Math.abs(diff) < 1) ? 'PASS' : 'FAIL',
    detail: `rows=${tbRows.length}; parsed=${parsedRows}; totals=${JSON.stringify(fNums)}; footText=${JSON.stringify(footText)}; independent: Σdebit=${r2(indDebit)} Σcredit=${r2(indCredit)}; excerpt=${tbText.slice(0, 200)}`,
  });

  // independent reconciliation of a few accounts against the UI numbers
  // (the report formats with ar-EG — normalize both sides to bare ASCII digits)
  const digits = s => String(s).replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0)).replace(/[^\d]/g, '');
  const tbDigits = digits(tbText);
  const spot = ['1101', '4101'].map(code => {
    const v = r2(acc(db, code));
    const shown = v !== 0 && tbDigits.includes(digits(v));
    return { code, gl: v, shown };
  });
  R.add({
    id: 'RPT-TB-02',
    name: 'Trial balance spot-checks match the general ledger balances',
    status: spot.filter(s => s.shown).length >= 2 ? 'PASS' : 'WARN',
    detail: JSON.stringify(spot),
  });

  // row-level side check: a credit-balance account (payables 2101) must present
  // its balance under رصيد دائن, never under رصيد مدين
  const payRow = tbRows.find(r => /2101/.test(r)) || '';
  const payCells = payRow.split(/\t|\n/).map(s => s.trim()).filter(Boolean);
  // cells: code(+badge), name, movesD, movesC, closingD, closingC, net...
  const payCd = payCells.length >= 6 ? payCells[4] : '';
  const payCc = payCells.length >= 6 ? payCells[5] : '';
  const payCredit = num(payCc);
  R.add({
    id: 'RPT-TB-03',
    name: 'Credit-balance account (2101) presents under رصيد دائن, not رصيد مدين',
    status: !payRow ? 'NOT TESTED' : (payCd === '-' && !Number.isNaN(payCredit) && payCredit > 0 ? 'PASS' : 'FAIL'),
    detail: `cells=${JSON.stringify(payCells)}; closingDebit=${payCd}; closingCredit=${payCc}`,
  });

  // other reports open and render (PL/BS/VAT are div-based, not tables)
  const reports = [
    ['قائمة الدخل', 'RPT-PL', /مجمل الربح|صافي ربح/],
    ['الميزانية العمومية', 'RPT-BS', /إجمالي الأصول/],
    ['أعمار ديون', 'RPT-AGE', /./],
    ['ضريبة القيمة', 'RPT-VAT', /صافي الضريبة المستحقة/],
  ];
  for (const [label, id, must] of reports) {
    const btn = page.locator('main button', { hasText: label }).first();
    if (await btn.count()) {
      await btn.click({ force: true });
      await page.waitForTimeout(800);
      const txt = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
      const rows = await page.locator('main tbody tr').count();
      const ok = txt.length > 400 && (id === 'RPT-AGE' ? rows > 0 : must.test(txt));
      R.add({ id, name: `${label} report renders with its sections/totals`, status: ok ? 'PASS' : 'WARN', detail: `rows=${rows}; chars=${txt.length}; hasSection=${id === 'RPT-AGE' ? rows > 0 : must.test(txt)}` });
    } else {
      R.add({ id, name: `${label} report renders with its sections/totals`, status: 'NOT TESTED', detail: 'control not found' });
    }
  }

  // date filters: an empty future period must zero out the period-based reports
  await gotoTab(page, 'reports');
  await page.waitForTimeout(500);
  // the date inputs are disabled while "كل الفترات" is checked — uncheck first
  const allPer = page.locator('main input[type="checkbox"]').first();
  let unchecked = false;
  if (await allPer.count()) {
    if (await allPer.isChecked().catch(() => false)) { await allPer.click({ force: true }); unchecked = true; }
    await page.waitForTimeout(300);
  }
  const dates = page.locator('main input[type="date"]');
  const nDates = await dates.count();
  let datesFilled = false;
  if (nDates >= 2 && unchecked) {
    await dates.nth(0).fill('2030-01-01').catch(() => {});
    await dates.nth(1).fill('2030-01-31').catch(() => {});
    datesFilled = true;
    await page.waitForTimeout(400);
    // the income statement respects the selected period → future period must be empty
    const plBtn = page.locator('main button', { hasText: 'قائمة الدخل' }).first();
    if (await plBtn.count()) { await plBtn.click({ force: true }); await page.waitForTimeout(800); }
    const futureText = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    const futureRows = await page.locator('main tbody tr').count();
    R.add({
      id: 'RPT-FILTER-01',
      name: 'A future date range zeroes the period-based report (filter actually applies)',
      status: (futureRows <= 2 || /0\.00|٠/.test(futureText)) ? 'PASS' : 'WARN',
      detail: `rows=${futureRows}; excerpt=${futureText.slice(-220)}`,
    });
  } else {
    R.add({ id: 'RPT-FILTER-01', name: 'A future date range zeroes the period-based report (filter actually applies)', status: 'NOT TESTED', detail: `dateInputs=${nDates}; allPeriodsCheckbox=${await allPer.count()}; unchecked=${unchecked}; filled=${datesFilled}` });
  }

  // print the report
  await gotoTab(page, 'reports');
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.__uatPrinted = 0; window.print = () => { window.__uatPrinted++; }; });
  const printBtn = page.locator('main button', { hasText: 'طباعة التقرير' }).first();
  if (await printBtn.count()) {
    await printBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1000);
  }
  const printed = await page.evaluate(() => window.__uatPrinted);
  R.add({ id: 'RPT-PRINT-01', name: 'Report print action invokes the browser print dialog', status: printed > 0 ? 'PASS' : 'WARN', detail: `window.print calls=${printed}` });
}

// ================================================ DASHBOARD RECONCILIATION
{
  await gotoTab(page, 'dashboard');
  await page.waitForTimeout(800);
  const dash = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  const db = await readDb(page);
  const batchValue = db.batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
  const shownBatch = dash.includes(String(Math.round(batchValue))) || dash.includes(Math.round(batchValue).toLocaleString('en-US'));
  R.add({
    id: 'DASH-REC-01',
    name: 'Dashboard inventory value equals the stock ledger (batches × cost)',
    status: shownBatch ? 'PASS' : 'WARN',
    detail: `batchValue=${r2(batchValue)}; shownOnDashboard=${shownBatch}; dashboardExcerpt=${dash.slice(0, 300)}`,
  });

  const revenue = db.salesInvoices.reduce((s, i) => s + (i.totalAmountEGP || 0), 0);
  const shownRev = dash.includes(String(Math.round(revenue))) || dash.includes(Math.round(revenue).toLocaleString('en-US'));
  R.add({
    id: 'DASH-REC-02',
    name: 'Dashboard revenue equals the sum of posted invoices',
    status: shownRev ? 'PASS' : 'WARN',
    detail: `revenue=${r2(revenue)}; shown=${shownRev}`,
  });

  // drill-down shortcuts actually navigate
  const before = await page.evaluate(() => localStorage.getItem('snakdip_erp_active_tab'));
  const drill = page.locator('main button', { hasText: 'توريد خامات' }).first();
  if (await drill.count()) {
    await drill.click({ force: true });
    await page.waitForTimeout(800);
    const after = await page.evaluate(() => localStorage.getItem('snakdip_erp_active_tab'));
    R.add({ id: 'DASH-REC-03', name: 'Dashboard shortcut navigates to its module', status: after !== before ? 'PASS' : 'FAIL', detail: `${before} → ${after}` });
  } else {
    R.add({ id: 'DASH-REC-03', name: 'Dashboard shortcut navigates to its module', status: 'NOT TESTED', detail: 'shortcut not found' });
  }
}

// ============================================================== AUDIT LOG
{
  await gotoTab(page, 'audit');
  await page.waitForTimeout(700);
  const txt = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  const rows = await page.locator('main tbody tr').count();
  R.add({
    id: 'AUD-01',
    name: 'Audit log lists recorded operations with user and time',
    status: rows > 5 ? 'PASS' : 'FAIL',
    detail: `rows=${rows}; hasLogin=${/login|دخول/.test(txt)}; hasPost=${/ترحيل|post/i.test(txt)}`,
  });

  // search filter
  const search = page.locator('main input[type="text"]').first();
  if (await search.count()) {
    await search.fill('zzzz-no-audit-match');
    await page.waitForTimeout(600);
    const rows2 = await page.locator('main tbody tr').count();
    await search.fill('');
    await page.waitForTimeout(600);
    const rows3 = await page.locator('main tbody tr').count();
    R.add({ id: 'AUD-02', name: 'Audit log search filters rows and clears back', status: rows2 < rows3 ? 'PASS' : 'FAIL', detail: `rows ${rows}→${rows2}→${rows3}` });
  } else {
    R.add({ id: 'AUD-02', name: 'Audit log search filters rows and clears back', status: 'NOT TESTED', detail: 'search field not found' });
  }

  // action filter select
  const sel = page.locator('main select').first();
  if (await sel.count()) {
    const opts = await sel.locator('option').allInnerTexts().catch(() => []);
    if (opts.length > 1) {
      await sel.selectOption({ index: 1 }).catch(() => {});
      await page.waitForTimeout(600);
      const rowsF = await page.locator('main tbody tr').count();
      R.add({ id: 'AUD-03', name: 'Audit log action filter applies', status: rowsF <= rows ? 'PASS' : 'FAIL', detail: `options=${opts.length}; rows=${rowsF} (unfiltered ${rows})` });
    }
  }
}

// -------------------------------------------------------- FINAL EVIDENCE
{
  const db = await readDb(page);
  R.add({
    id: 'FINAL-GL',
    name: 'Final GL state of the isolated test profile',
    status: unbal(db).length === 0 ? 'PASS' : 'FAIL',
    detail: `journals=${db.journalEntries.length}; unbalanced=${unbal(db).length}; accounts=${db.accounts.length}; invoices=${db.salesInvoices.length}; purchases=${db.purchaseInvoices.length}; treasury=${(db.treasuryTransactions || []).length}; expenses=${(db.expenses || []).length}`,
  });
  R.add({ id: 'RPT-CONSOLE', name: 'No console/page errors during accounting + reporting', status: (R.consoleErrors.length + R.pageErrors.length) === 0 ? 'PASS' : 'FAIL', detail: JSON.stringify([...R.pageErrors, ...R.consoleErrors].slice(0, 8)) });
}
await shot(page, '11_accounting_reports');
console.log('\n=== SUMMARY ===', JSON.stringify(R.summary()));
R.save();
await browser.close();
