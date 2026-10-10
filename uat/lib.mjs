// ISOLATED UAT HARNESS — NOT application source code.
// This directory is a test harness only. It never writes to real UAT storage:
// every test run uses a brand-new Playwright browser context (fresh profile,
// empty localStorage / IndexedDB / cookies), which is a different storage
// origin+profile from any real end-user browser.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE_URL = process.env.UAT_BASE_URL || 'http://localhost:3000';
export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.join(ROOT, 'results');
export const SCREENSHOTS_DIR = path.join(ROOT, 'screenshots');
fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

export const TAB_LABELS = {
  dashboard: 'لوحة القيادة',
  items: 'الأصناف والمنتجات',
  sales: 'فواتير المبيعات',
  purchasing: 'فواتير المشتريات',
  inventory: 'المستودعات والمخزون',
  manufacturing: 'الإنتاج',
  quality: 'الجودة',
  costing: 'التكاليف',
  customers: 'العملاء',
  suppliers: 'الموردون',
  representatives: 'المندوبون والعهد',
  export: 'الشحنات والتحصيل',
  treasury: 'الخزينة',
  banks: 'البنوك',
  cheques: 'الشيكات',
  expenses: 'المصروفات',
  accounting: 'المحاسبة',
  reports: 'التقارير',
  users: 'المستخدمون والصلاحيات',
  settings: 'الإعدادات',
  audit: 'سجل العمليات',
};

export class Results {
  constructor(suite) {
    this.suite = suite;
    this.items = [];
    this.consoleErrors = [];
    this.pageErrors = [];
    this.failedRequests = [];
    this.dialogs = [];
  }
  add(item) {
    const rec = { suite: this.suite, ...item, ts: new Date().toISOString() };
    this.items.push(rec);
    const mark = { PASS: '✅', FAIL: '❌', BLOCKED: '⛔', 'NOT TESTED': '⬜', 'NOT APPLICABLE': '➖', WARN: '⚠️' }[rec.status] || '•';
    console.log(`${mark} [${rec.id}] ${rec.name} — ${rec.status}${rec.detail ? ' :: ' + rec.detail : ''}`);
    return rec;
  }
  save() {
    const file = path.join(RESULTS_DIR, `${this.suite}.json`);
    fs.writeFileSync(file, JSON.stringify({
      suite: this.suite,
      generatedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      results: this.items,
      consoleErrors: this.consoleErrors,
      pageErrors: this.pageErrors,
      failedRequests: this.failedRequests,
      dialogs: this.dialogs,
    }, null, 2));
    console.log(`\n→ saved ${this.items.length} results to ${file}`);
  }
  summary() {
    const c = {};
    for (const r of this.items) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }
}

/** Fresh browser + FRESH isolated context = empty storage. */
export async function launchIsolated({ viewport = { width: 1440, height: 900 }, locale = 'ar-EG' } = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport, locale, timezoneId: 'Africa/Cairo' });
  const page = await context.newPage();
  const res = { browser, context, page };
  page.on('console', (msg) => {
    if (msg.type() === 'error') res.consoleErrors?.push(msg.text());
  });
  page.on('pageerror', (err) => res.pageErrors?.push(String(err)));
  page.on('requestfailed', (req) => res.failedRequests?.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText}`));
  res.consoleErrors = [];
  res.pageErrors = [];
  res.failedRequests = [];
  return res;
}

/** Evidence that storage is empty BEFORE any write — the isolation proof. */
export async function storageProbe(page) {
  return await page.evaluate(async () => {
    const out = { origin: location.origin, localStorage: {}, sessionStorage: {}, indexedDB: [], cookies: document.cookie ? [document.cookie] : [] };
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      out.localStorage[k] = (localStorage.getItem(k) || '').length;
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      out.sessionStorage[k] = (sessionStorage.getItem(k) || '').length;
    }
    try {
      const dbs = await indexedDB.databases();
      out.indexedDB = dbs.map(d => d.name);
    } catch (e) { out.indexedDB = ['<unsupported>']; }
    return out;
  });
}

export async function login(page, username = 'admin', password = '12345') {
  await page.waitForSelector('input[type="text"]', { timeout: 15000 });
  await page.locator('input[type="text"]').first().fill(username);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForSelector('header', { timeout: 15000 });
}

export async function gotoTab(page, tabId) {
  const label = TAB_LABELS[tabId];
  if (!label) throw new Error('unknown tab ' + tabId);
  // open sidebar on mobile widths
  const burger = page.locator('button[title="القائمة الرئيسية"]');
  if (await burger.isVisible().catch(() => false)) await burger.click();
  const item = page.locator('button.nav-item', { hasText: label }).first();
  await item.click({ timeout: 10000 });
  await page.waitForTimeout(350);
}

/**
 * Record every native dialog (alert/confirm) so validation messages become
 * evidence. `opts.action()` may return 'accept' for confirmations the test
 * deliberately approves (only ever against the test's own isolated records).
 */
export function captureDialogs(page, sink, opts = {}) {
  page.on('dialog', async (d) => {
    sink.push({ type: d.type(), message: d.message() });
    const act = (opts.action && opts.action()) || 'dismiss';
    try {
      if (act === 'accept') {
        if (d.type() === 'prompt') await d.accept((opts.promptText && opts.promptText()) || 'UAT automated test');
        else await d.accept();
      } else {
        await d.dismiss();
      }
    } catch { /* dialog already handled */ }
  });
}

/** Close any modal that a previous probe may have left open. */
export async function closeModal(page) {
  const open = page.locator('div.fixed.inset-0.z-50');
  if (!(await open.count())) return false;
  const m = open.last();
  const cancel = m.locator('button', { hasText: /إلغاء|إغلاق/ }).first();
  if (await cancel.count()) await cancel.click({ force: true }).catch(() => {});
  else await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(350);
  if (await open.count()) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    if (!(await page.locator('header').count())) await login(page);
  }
  return true;
}

/** Open a module's create surface and return the modal container. */
export async function openCreate(page, tab, buttonText) {
  await closeModal(page);
  await gotoTab(page, tab);
  await page.waitForTimeout(300);
  const btn = page.locator('main button', { hasText: buttonText }).first();
  await btn.click({ timeout: 8000 });
  await page.waitForTimeout(500);
  return page.locator('div.fixed.inset-0').last();
}

/** Fill form controls by their index inside the given container. */
export async function fillFields(container, fields) {
  for (const { i, value, select } of fields) {
    const el = container.locator('input, select, textarea').nth(i);
    const tag = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => 'input');
    if (tag === 'select') {
      if (select) await el.selectOption({ label: select }).catch(() => {});
      else await el.selectOption(String(value)).catch(() => {});
    } else {
      await el.fill(String(value));
    }
  }
}

/** Click a button by visible text inside a container. */
export async function clickIn(container, text) {
  await container.locator('button', { hasText: text }).last().click({ timeout: 8000 });
}

/**
 * The sales form is known to reopen with leftover lines (defect STALE-01),
 * so tests that need a single clean line remove the extras before saving.
 * The removal itself is evidence — it is reported by the caller.
 */
export async function trimExtraLines(modal, expected = 1) {
  const pg = modal.page();
  let removed = 0;
  for (let i = 0; i < 10; i++) {
    const rows = await modal.locator('tbody tr').count();
    if (rows <= expected) break;
    const last = modal.locator('tbody tr').last();
    const x = last.locator('button').last();
    if (!(await x.count())) break;
    await x.click({ force: true }).catch(() => {});
    await pg.waitForTimeout(200);
    removed++;
  }
  return removed;
}

export async function shot(page, name) {
  const file = path.join(SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

export function toArr(v) { return Array.isArray(v) ? v : []; }

/**
 * Read the app database OUT OF THE ISOLATED TEST PROFILE for independent
 * verification of what the UI actually persisted. This never touches real UAT
 * data — it reads the same profile the test browser wrote to.
 */
export async function readDb(page) {
  return await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('abdullah_erp_db_v1') || 'null'); }
    catch { return null; }
  });
}

export const sum = (arr, f) => (arr || []).reduce((s, x) => s + (f ? f(x) : x), 0);
export const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Balanced-journal check: every posted entry must have debit === credit. */
export function unbalanced(db) {
  return (db.journalEntries || [])
    .filter(j => j.status !== 'cancelled')
    .map(j => ({
      id: j.id, num: j.entryNumber || j.journalNumber || j.id,
      debit: r2(sum(j.lines, l => l.debit || 0)),
      credit: r2(sum(j.lines, l => l.credit || 0)),
    }))
    .filter(j => Math.abs(j.debit - j.credit) > 0.005);
}
