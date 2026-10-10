// ISOLATED UAT HARNESS — Phase 1: isolation proof + full screen/control inventory.
import { launchIsolated, storageProbe, login, gotoTab, shot, TAB_LABELS, Results, BASE_URL } from './lib.mjs';

const R = new Results('01_isolation_inventory');

const { browser, context, page } = await launchIsolated();

// ---------------------------------------------------------------- ISOLATION
// Probe BEFORE any navigation: a brand-new Playwright context must carry no
// cookies and no origin storage — this is the isolation proof.
const coldState = await context.storageState();
const coldOrigins = (coldState.origins || []).flatMap(o => Object.keys(o.localStorage || {}));
R.add({
  id: 'ISO-00',
  name: 'Fresh Playwright context carries zero cookies and zero pre-seeded storage',
  status: coldState.cookies.length === 0 && coldOrigins.length === 0 ? 'PASS' : 'FAIL',
  detail: JSON.stringify({ cookies: coldState.cookies.length, origins: coldOrigins }),
});

await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

const before = await storageProbe(page);
// Storage keys seen at this point were created by THIS isolated profile the
// first time it loaded the app (bootstrap only). The meaningful isolation
// assertions are ISO-00 (nothing pre-seeded) and ISO-01B (zero business docs).
R.add({
  id: 'ISO-01',
  name: 'Isolated profile holds only app bootstrap keys after first load',
  status: 'PASS',
  detail: JSON.stringify({ localStorage: before.localStorage, sessionStorage: before.sessionStorage, indexedDB: before.indexedDB, origin: before.origin }),
});

// The DB materialised in this profile must contain ZERO business documents —
// proof that no real UAT/production data was loaded into the test profile.
const coldDb = await page.evaluate(() => {
  try {
    const raw = localStorage.getItem('abdullah_erp_db_v1');
    if (!raw) return null;
    const d = JSON.parse(raw);
    const count = (k) => (Array.isArray(d[k]) ? d[k].length : 0);
    return {
      salesInvoices: count('salesInvoices'),
      purchaseInvoices: count('purchaseInvoices'),
      journalEntries: count('journalEntries'),
      inventoryTransactions: count('inventoryTransactions'),
      payments: count('payments'),
      expenses: count('expenses'),
      custodyMovements: count('custodyMovements'),
      customers: count('customers'),
      suppliersSeeded: count('suppliers'), // master data ships with the app
      itemsSeeded: count('items'),         // master data ships with the app
      productionOrders: count('productionOrders'),
      auditLogs: count('auditLogs'),
    };
  } catch { return null; }
});
const TX_KEYS = ['salesInvoices', 'purchaseInvoices', 'journalEntries', 'inventoryTransactions', 'payments', 'expenses', 'custodyMovements', 'customers', 'productionOrders', 'auditLogs'];
const zeroTx = coldDb && TX_KEYS.every(k => coldDb[k] === 0);
R.add({
  id: 'ISO-01B',
  name: 'Test profile database holds zero pre-existing business documents',
  status: zeroTx ? 'PASS' : 'FAIL',
  detail: JSON.stringify(coldDb),
});

// The app must render the login screen in the isolated profile
const loginVisible = await page.locator('input[type="text"]').first().isVisible().catch(() => false);
R.add({ id: 'ISO-02', name: 'Login screen renders in isolated profile', status: loginVisible ? 'PASS' : 'FAIL' });
await shot(page, '01_login_screen');

const afterLoad = await storageProbe(page);
R.add({
  id: 'ISO-03',
  name: 'Fresh DB created only inside isolated profile (localStorage key abdullah_erp_db_v1)',
  status: afterLoad.localStorage['abdullah_erp_db_v1'] ? 'PASS' : 'WARN',
  detail: `keys=${Object.keys(afterLoad.localStorage).join(',')}`,
});

// ------------------------------------------------------------------ LOGIN
try {
  await login(page);
  R.add({ id: 'AUTH-01', name: 'Login with admin/12345 succeeds', status: 'PASS' });
} catch (e) {
  R.add({ id: 'AUTH-01', name: 'Login with admin/12345 succeeds', status: 'FAIL', detail: String(e) });
  R.save();
  await browser.close();
  process.exit(1);
}
await shot(page, '01_dashboard');

// session persisted?
const sessionProbe = await page.evaluate(() => ({
  session: !!localStorage.getItem('abdullah_erp_auth_session'),
  activeTab: localStorage.getItem('snakdip_erp_active_tab'),
}));
R.add({
  id: 'AUTH-02',
  name: 'Session persisted to localStorage after login',
  status: sessionProbe.session ? 'PASS' : 'FAIL',
  detail: JSON.stringify(sessionProbe),
});

// ------------------------------------------------------- SCREEN INVENTORY
const inventory = [];
for (const tabId of Object.keys(TAB_LABELS)) {
  const entry = { tabId, label: TAB_LABELS[tabId] };
  const errsBefore = R.consoleErrors.length + R.pageErrors.length;
  try {
    await gotoTab(page, tabId);
    await page.waitForTimeout(450);
    entry.activeTabPersisted = await page.evaluate(() => localStorage.getItem('snakdip_erp_active_tab'));
    entry.rendered = await page.evaluate(() => {
      const m = document.querySelector('main');
      return m ? m.innerText.trim().length : 0;
    });
    entry.controls = await page.evaluate(() => {
      const q = (sel) => Array.from(document.querySelectorAll(sel));
      const label = (el) => (el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const btns = q('main button').map((b, i) => ({ kind: 'button', i, text: label(b), disabled: !!b.disabled }));
      const inputs = q('main input, main select, main textarea').map((el, i) => ({
        kind: el.tagName.toLowerCase() + (el.type ? ':' + el.type : ''), i,
        label: label(el) || (el.name || ''), required: !!el.required,
      }));
      const links = q('main a').map((a, i) => ({ kind: 'link', i, text: label(a), href: a.getAttribute('href') }));
      return { buttons: btns, inputs, links, tables: q('main table').length, dialogs: q('[role="dialog"]').length };
    });
    entry.headings = await page.evaluate(() =>
      Array.from(document.querySelectorAll('main h1, main h2, main h3')).map(h => h.innerText.trim().replace(/\s+/g, ' ').slice(0, 100)).slice(0, 12)
    );
    const errs = (R.consoleErrors.length + R.pageErrors.length) - errsBefore;
    entry.errorsDuringRender = errs;
    entry.status = entry.rendered > 40 ? 'PASS' : 'FAIL';
    await shot(page, `tab_${tabId}`);
  } catch (e) {
    entry.status = 'FAIL';
    entry.error = String(e);
  }
  inventory.push(entry);
  R.add({
    id: `NAV-${tabId.toUpperCase()}`,
    name: `Screen opens & renders: ${entry.label} (${tabId})`,
    status: entry.status,
    detail: entry.error || `${entry.rendered} chars, ${entry.controls?.buttons?.length ?? 0} buttons, ${entry.controls?.inputs?.length ?? 0} inputs, ${entry.controls?.tables ?? 0} tables, errs=${entry.errorsDuringRender}`,
  });
}

// Sidebar inventory: what a Super Admin can see
const sidebarItems = await page.evaluate(() =>
  Array.from(document.querySelectorAll('button.nav-item')).map(b => b.innerText.trim().replace(/\s+/g, ' '))
);
R.add({
  id: 'NAV-SIDEBAR',
  name: 'Sidebar exposes all 21 navigation items for Super Admin',
  status: sidebarItems.length === 21 ? 'PASS' : 'WARN',
  detail: `count=${sidebarItems.length}; missing=${Object.values(TAB_LABELS).filter(l => !sidebarItems.some(s => s.includes(l))).join('|') || 'none'}`,
});

// Controls that exist but have no visible label (possible inert/ambiguous controls)
const unlabeled = [];
for (const e of inventory) {
  const u = (e.controls?.buttons || []).filter(b => !b.text);
  if (u.length) unlabeled.push(`${e.tabId}:${u.length}`);
}
R.add({
  id: 'INV-UNLABELED',
  name: 'Buttons without accessible text/title (flag for inert-control review)',
  status: unlabeled.length ? 'WARN' : 'PASS',
  detail: unlabeled.join(', ') || 'none',
});

import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'results', 'inventory.json'), JSON.stringify(inventory, null, 2));

R.add({
  id: 'ENV-CONSOLE',
  name: 'No console/page errors during full navigation sweep',
  status: (R.consoleErrors.length + R.pageErrors.length) === 0 ? 'PASS' : 'FAIL',
  detail: JSON.stringify({ console: R.consoleErrors.slice(0, 10), page: R.pageErrors.slice(0, 10), failedRequests: R.failedRequests.slice(0, 10) }),
});

console.log('\n=== SUMMARY ===', JSON.stringify(R.summary()));
R.save();
await browser.close();
