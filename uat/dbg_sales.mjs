// debug: why does the sales invoice not post?
import { launchIsolated, login, gotoTab, Results, BASE_URL, openCreate, fillFields, readDb, captureDialogs, closeModal } from './lib.mjs';

const R = new Results('dbg_sales');
const dialogs = [];
const { browser, page } = await launchIsolated();
captureDialogs(page, dialogs, { action: () => 'accept' });
page.on('console', m => console.log('  [console]', m.type(), m.text().slice(0, 200)));
page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 300)));
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await login(page);

// minimal setup: a customer so the form has a valid selection
const mc = await openCreate(page, 'customers', 'إضافة عميل جديد');
await fillFields(mc, [{ i: 0, value: 'CUST-DBG' }, { i: 2, value: 'عميل ديباغ' }, { i: 4, value: '999999' }]);
await mc.locator('button', { hasText: 'حفظ العميل' }).click();
await page.waitForTimeout(700);
await closeModal(page);

const m = await openCreate(page, 'sales', 'فاتورة بيع جديدة');
const info = await m.evaluate((el) => {
  const fields = Array.from(el.querySelectorAll('input, select, textarea')).map((f, i) => ({
    i, tag: f.tagName.toLowerCase(), type: f.type || '', value: String(f.value ?? '').slice(0, 40),
    min: f.min || '', options: f.tagName === 'SELECT' ? Array.from(f.options).map(o => `${o.value}=${o.text}`).slice(0, 6) : undefined,
  }));
  return { text: el.innerText.replace(/\s+/g, ' ').slice(0, 600), fields };
});
console.log('MODAL TEXT:', info.text);
console.log('FIELDS:', JSON.stringify(info.fields, null, 1));

// fill and submit
const custSel = m.locator('select').first();
const vals = await custSel.locator('option').evaluateAll(os => os.map(o => o.value));
console.log('customer options:', JSON.stringify(vals));
if (vals.find(v => v)) await custSel.selectOption(vals.find(v => v));
await fillFields(m, [
  { i: 1, value: 'wholesale' },
  { i: 5, value: 'credit' },
  { i: 9, value: '50' },
  { i: 10, value: '100' },
  { i: 12, value: '0' },
]);
await m.locator('button', { hasText: 'حفظ وترحيل الفاتورة' }).click();
await page.waitForTimeout(1500);
const after = await m.evaluate(el => el.innerText.replace(/\s+/g, ' ').slice(0, 800)).catch(() => 'MODAL CLOSED');
console.log('AFTER SAVE MODAL:', after);
console.log('DIALOGS:', JSON.stringify(dialogs));
const db = await readDb(page);
console.log('invoices now:', db.salesInvoices.length, 'customers:', db.customers.length);
R.save();
await browser.close();
