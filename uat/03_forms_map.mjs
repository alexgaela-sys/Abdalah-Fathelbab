// ISOLATED UAT HARNESS — Phase 1F/2: open every primary "create" surface in the
// real UI and map its form controls WITHOUT submitting anything (read-only).
// Each module is reloaded after the probe so no modal state leaks.
import { launchIsolated, login, gotoTab, shot, Results, BASE_URL } from './lib.mjs';

const R = new Results('03_forms_map');

const TARGETS = [
  ['items', 'إضافة صنف / منتج جديد'],
  ['sales', 'فاتورة بيع جديدة'],
  ['purchasing', 'فاتورة استلام خامات جديدة'],
  ['inventory', 'تحويل مخزني داخلي'],
  ['inventory', 'جرد فعلي وتسوية'],
  ['manufacturing', 'أمر إنتاج جديد'],
  ['quality', 'تسجيل محضر فحص جودة'],
  ['costing', 'تحديث معدل تكلفة معياري جديد'],
  ['customers', 'إضافة عميل جديد'],
  ['suppliers', 'إضافة مورد جديد'],
  ['representatives', 'مندوب جديد'],
  ['representatives', 'فتح عهدة مندوب جديدة'],
  ['export', 'تسجيل شحنة تصدير جديدة'],
  ['treasury', 'حركة قبض / صرف خزينة'],
  ['banks', 'إجراء حركة مصرفية'],
  ['cheques', 'تسجيل شيك جديد'],
  ['expenses', 'تسجيل إذن صرف مصروف'],
  ['accounting', 'قيد يومية يدوي متزن'],
  ['users', 'إضافة مستخدم جديد'],
  ['settings', 'إضافة منتج تام جديد'],
];

const { browser, page } = await launchIsolated();
page.on('console', (m) => { if (m.type() === 'error') R.consoleErrors.push(m.text()); });
page.on('pageerror', (e) => R.pageErrors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await login(page);

const map = [];

for (const [tab, buttonText] of TARGETS) {
  const rec = { tab, buttonText, opened: false };
  try {
    await gotoTab(page, tab);
    await page.waitForTimeout(400);
    const btn = page.locator('main button', { hasText: buttonText }).first();
    const visible = await btn.isVisible().catch(() => false);
    rec.buttonVisible = visible;
    if (!visible) {
      R.add({ id: `FORM-${tab}-${buttonText.slice(0, 10)}`, name: `[${tab}] "${buttonText}" available`, status: 'FAIL', detail: 'control not visible on the module screen' });
      map.push(rec);
      continue;
    }
    await btn.click({ timeout: 5000 });
    await page.waitForTimeout(600);
    const modal = page.locator('div.fixed.inset-0').last();
    rec.opened = await modal.count() > 0 && await modal.isVisible().catch(() => false);
    if (rec.opened) {
      rec.form = await modal.evaluate((m) => {
        const title = (m.querySelector('h2,h3,h4')?.innerText || '').trim().replace(/\s+/g, ' ');
        const labelTexts = Array.from(m.querySelectorAll('label, .field-label, .text-xs.font-black, .font-black.text-xs'))
          .map(l => l.innerText.trim().replace(/\s+/g, ' ')).filter(t => t && t.length < 60);
        const fields = Array.from(m.querySelectorAll('input, select, textarea')).map((el, i) => ({
          i,
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          placeholder: el.placeholder || '',
          required: !!el.required,
          min: el.min ?? undefined,
          max: el.max ?? undefined,
          value: String(el.value ?? '').slice(0, 40),
          options: el.tagName === 'SELECT' ? Array.from(el.options).map(o => o.text.trim()).slice(0, 15) : undefined,
        }));
        const buttons = Array.from(m.querySelectorAll('button'))
          .map(b => b.innerText.trim().replace(/\s+/g, ' ')).filter(Boolean);
        const invalidNow = m.querySelectorAll(':invalid').length;
        return { title, labelTexts, fields, buttons, invalidNow };
      });
      rec.form.labelsOnly = undefined;
      await shot(page, `form_${tab}_${buttonText.replace(/[^a-zA-Z0-9\u0600-\u06FF]+/g, '_').slice(0, 40)}`);
      R.add({
        id: `FORM-${tab}-${buttonText.slice(0, 8)}`,
        name: `[${tab}] create surface "${buttonText}" opens`,
        status: 'PASS',
        detail: `title="${rec.form.title}" fields=${rec.form.fields.length} buttons=${rec.form.buttons.join('/')}`,
      });
    } else {
      R.add({ id: `FORM-${tab}-${buttonText.slice(0, 8)}`, name: `[${tab}] create surface "${buttonText}" opens a modal/form`, status: 'FAIL', detail: 'clicked but no modal container appeared' });
    }
  } catch (e) {
    rec.error = String(e).slice(0, 200);
    R.add({ id: `FORM-${tab}-${buttonText.slice(0, 8)}`, name: `[${tab}] create surface "${buttonText}"`, status: 'FAIL', detail: rec.error });
  }
  map.push(rec);
  // clean state — nothing was submitted, but a reload guarantees no modal leaks
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  if (!(await page.locator('header').count())) await login(page);
}

import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'results', 'forms_map.json'), JSON.stringify(map, null, 2));

R.add({ id: 'FORMS-CONSOLE', name: 'No console errors while opening all create surfaces', status: (R.consoleErrors.length + R.pageErrors.length) === 0 ? 'PASS' : 'FAIL', detail: JSON.stringify([...R.pageErrors, ...R.consoleErrors].slice(0, 6)) });
console.log('\n=== SUMMARY ===', JSON.stringify(R.summary()));
R.save();
await browser.close();
