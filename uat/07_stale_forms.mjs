// ISOLATED UAT HARNESS — Phase 3N: stale-form probe.
// Opens and cancels the sales create form several times, then checks whether a
// fresh invoice form still carries the previous line items (a defect that would
// post phantom lines and deduct stock the user never entered).
import { launchIsolated, login, gotoTab, Results, BASE_URL, openCreate, fillFields, readDb, captureDialogs, closeModal } from './lib.mjs';

const R = new Results('07_stale_forms');
const dialogs = [];
const { browser, page } = await launchIsolated();
captureDialogs(page, dialogs, { action: () => 'dismiss' });
page.on('console', m => { if (m.type() === 'error') R.consoleErrors.push(m.text()); });
page.on('pageerror', e => R.pageErrors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await login(page);

// a customer so the form is fully usable
const mc = await openCreate(page, 'customers', 'إضافة عميل جديد');
await fillFields(mc, [{ i: 0, value: 'CUST-STALE' }, { i: 2, value: 'عميل اختبار النماذج' }]);
await mc.locator('button', { hasText: 'حفظ العميل' }).click();
await page.waitForTimeout(600);
await closeModal(page);

const countLines = async (m) => await m.locator('tbody tr, .line-row').count();

const counts = [];
for (let i = 0; i < 4; i++) {
  const m = await openCreate(page, 'sales', 'فاتورة بيع جديدة');
  await page.waitForTimeout(400);
  const n = await m.locator('tbody tr').count();
  const qtySum = await m.locator('input[type="number"]').nth(1).inputValue().catch(() => '?');
  counts.push({ open: i + 1, rows: n, firstQty: qtySum });
  // cancel out
  const cancel = m.locator('button', { hasText: 'إلغاء' }).last();
  await cancel.click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
}

R.add({
  id: 'STALE-01',
  name: 'Sales invoice form starts empty on every open (no leftover line items)',
  status: counts.every(c => c.rows === 1) ? 'PASS' : 'FAIL',
  detail: JSON.stringify(counts),
});

// Same probe for the purchase receipt form
const pcounts = [];
for (let i = 0; i < 3; i++) {
  const m = await openCreate(page, 'purchasing', 'فاتورة استلام خامات جديدة');
  await page.waitForTimeout(400);
  pcounts.push({ open: i + 1, rows: await m.locator('tbody tr').count() });
  await m.locator('button', { hasText: 'إلغاء' }).last().click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
}
R.add({ id: 'STALE-02', name: 'Purchase receipt form starts empty on every open', status: pcounts.every(c => c.rows === 1) ? 'PASS' : 'FAIL', detail: JSON.stringify(pcounts) });

// Manual journal form (multi-line) — same probe
const jcounts = [];
for (let i = 0; i < 3; i++) {
  const m = await openCreate(page, 'accounting', 'قيد يومية يدوي متزن');
  await page.waitForTimeout(400);
  jcounts.push({ open: i + 1, rows: await m.locator('tbody tr').count() });
  await m.locator('button', { hasText: 'إلغاء' }).last().click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
}
R.add({ id: 'STALE-03', name: 'Manual journal form keeps exactly its two default sides on every open', status: jcounts.every(c => c.rows === 2) ? 'PASS' : 'FAIL', detail: JSON.stringify(jcounts) + ' (expected: 2 default sides — debit + credit)' });

R.add({ id: 'STALE-CONSOLE', name: 'No console errors during stale-form probe', status: (R.consoleErrors.length + R.pageErrors.length) === 0 ? 'PASS' : 'FAIL', detail: JSON.stringify([...R.pageErrors, ...R.consoleErrors].slice(0, 5)) });
console.log('\n=== SUMMARY ===', JSON.stringify(R.summary()));
R.save();
await browser.close();
