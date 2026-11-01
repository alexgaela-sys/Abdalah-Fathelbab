#!/usr/bin/env node
/**
 * REAL-BROWSER QA for the SnakDip ERP Cloud TEST surface.
 *
 *   node scripts/qa_supabase_browser.mjs <command> [--require-cloud]
 *
 * Commands (each run is a fresh Chromium + a fresh in-memory Supabase session,
 * because the app deliberately keeps the session in memory only):
 *
 *   preview   preview server reachable
 *   baseline  local ERP renders + localStorage fingerprint BEFORE cloud QA
 *   login     cloud screen sign-in with the approved TEST account
 *   sales     create + post a sales invoice from the UI, then verify in the DB:
 *             posted invoice, linked + balanced sales journal, COGS journal,
 *             FIFO batch issue, trial balance; then idempotent replay and
 *             double-submit protection
 *   transfer  warehouse-to-wholesale transfer from the UI + DB verification
 *   reject    oversell, closed accounting period, unauthorized user
 *   screens   every cloud screen: what it renders, which RPCs it really calls,
 *             core.* vs public.erp_master_records, and localStorage unchanged
 *   report    merge every results-<cmd>.json into qa/browser/REPORT.md
 *   cloud     all of the above except report (use `report` afterwards)
 *
 * Rules honoured by this script:
 *   * TEST project only (verified from VITE_SUPABASE_URL), never Production,
 *   * never prints a secret (passwords/URLs are read from env and used only),
 *   * never deletes a posted journal or inventory movement,
 *   * never disables an accounting guard — rejections are asserted, not removed.
 *
 * Requires a Chromium build (playwright-core is resolved from
 * tmp/qa-browser/node_modules; run `npm i --prefix tmp/qa-browser playwright-core`).
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.QA_PREVIEW_URL || 'http://localhost:3000').replace(/\/$/, '');
const SHOTS = path.join(ROOT, 'qa', 'browser');
const DB_URL_FILE = path.join(ROOT, 'supabase', 'backups', '.test_db_url');
const TEST_PROJECT_REF = 'xrqksgjtqzddzqcwfnaj';

const EMAIL = process.env.QA_CLOUD_TEST_EMAIL || process.env.SUPABASE_TEST_USER_EMAIL || '';
const PASSWORD =
  process.env.QA_CLOUD_TEST_PASSWORD || process.env.SUPABASE_TEST_USER_PASSWORD || '';


mkdirSync(SHOTS, { recursive: true });

/** The command currently executing — stamped onto every result row. */
const CURRENT = { cmd: 'init' };

const results = [];
const record = (name, status, detail = '') => {
  results.push({ name, status, detail, cmd: CURRENT.cmd, at: new Date().toISOString() });
  console.log(`${String(status).padEnd(7)} | ${name}${detail ? ` — ${detail}` : ''}`);
};

let SEQ = false;

function writeResults(cmd) {
  writeFileSync(
    path.join(SHOTS, `results-${cmd}.json`),
    JSON.stringify(results.filter(r => r.cmd === cmd), null, 2),
  );
}

function finish(cmd, code) {
  const mine = results.filter(r => r.cmd === cmd);
  const pass = mine.filter(r => r.status === 'PASS').length;
  const fail = mine.filter(r => r.status === 'FAIL').length;
  const blocked = mine.filter(r => r.status === 'BLOCKED').length;
  console.log(`\nSUMMARY cmd=${cmd} pass=${pass} fail=${fail} blocked=${blocked} total=${mine.length}`);
  writeResults(cmd);
  if (SEQ) return;
  process.exit(code ?? (fail > 0 ? 1 : 0));
}

/* ------------------------------------------------------------------ config */

function checkConfig() {
  const url = (process.env.VITE_SUPABASE_URL || '').trim();
  const anon = (process.env.VITE_SUPABASE_ANON_KEY || '').trim();
  if (!url || !anon) {
    record('config: TEST project keys present', 'FAIL', 'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing');
    return false;
  }
  let ref = 'unparsable';
  try {
    ref = new URL(url).hostname.split('.')[0];
  } catch {
    /* keep unparsable */
  }
  const ok = ref === TEST_PROJECT_REF;
  record('config: target is TEST project', ok ? 'PASS' : 'FAIL', `project_ref=${ref}`);
  if (!ok) return false;
  if (!EMAIL || !PASSWORD) {
    record('config: TEST account credentials present', 'FAIL', 'QA_CLOUD_TEST_EMAIL / QA_CLOUD_TEST_PASSWORD missing');
    return false;
  }
  record('config: TEST account credentials present', 'PASS', 'approved TEST account env keys present');
  return true;
}

/* ---------------------------------------------------------------- database */

function db(sql) {
  const uri = readFileSync(DB_URL_FILE, 'utf8').trim();
  const out = execFileSync('psql', [uri, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n').filter(l => l.length > 0);
}
const db1 = sql => db(sql)[0] ?? '';

/* ---------------------------------------------------------------- browser */

function findChrome() {
  const explicit = [process.env.QA_CHROMIUM_PATH, process.env.CHROME_PATH].filter(Boolean);
  const home = process.env.HOME || '/home/daytona';
  const base = path.join(home, '.cache', 'ms-playwright');
  const found = [];
  if (existsSync(base)) {
    for (const dir of readdirSync(base).filter(d => d.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const p = path.join(base, dir, rel);
        if (existsSync(p)) found.push(p);
      }
    }
  }
  return [...explicit, ...found].find(p => existsSync(p)) || null;
}

async function launch() {
  const require_ = createRequire(path.join(ROOT, 'tmp', 'qa-browser', 'package.json'));
  let chromium;
  try {
    ({ chromium } = require_('playwright-core'));
  } catch (e) {
    record('browser: playwright-core available', 'FAIL', `run npm i --prefix tmp/qa-browser playwright-core (${e.code || e.message})`);
    return null;
  }
  const exe = findChrome();
  if (!exe) {
    record('browser: chromium available', 'FAIL', 'no chromium build found under ~/.cache/ms-playwright');
    return null;
  }
  record('browser: chromium available', 'PASS', path.basename(path.dirname(exe)));
  return chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
}

async function newPage(ctx) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', e => console.log(`   [pageerror] ${String(e.message).split('\n')[0]}`));
  return page;
}

const netLog = [];
function watchNetwork(page) {
  page.on('request', r => {
    const u = r.url();
    const i = u.indexOf('/rest/v1/');
    if (i === -1) return;
    const tail = u.slice(i + '/rest/v1/'.length).split('?')[0];
    netLog.push(`${r.method()} ${tail}`);
  });
}

const uniq = a => [...new Set(a)];
const rpcsCalled = () => uniq(netLog.filter(x => x.startsWith('POST rpc/')).map(x => x.slice(5)));
const tablesRead = () => uniq(netLog.filter(x => x.startsWith('GET ')).map(x => x.slice(4)));

async function shot(page, name) {
  try {
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
  } catch (e) {
    console.log(`   [screenshot failed] ${name}: ${e.message}`);
  }
}

/** Signs in on a ?cloud=1 screen when the gate shows the form; no-op otherwise. */async function ensureSignedIn(page) {
  await page
    .waitForFunction(
      () =>
        document.body.innerText.includes('الجلسة:') ||
        !!document.querySelector('input[type="password"]'),
      null,
      { timeout: 25000 },
    )
    .catch(() => {});
  const hasForm = await page.locator('input[type="password"]').count();
  if (!hasForm) {
    await page.getByText('الجلسة:').first().waitFor({ timeout: 25000 });
    return 'already';
  }
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  let bar = 'timeout';
  try { await page.locator('button[type="submit"]').first().click({ force: true, timeout: 15000 }); }
  catch { try { await page.locator('input[type="password"]').press('Enter'); } catch { } }
  try { await page.getByText('الجلسة:').first().waitFor({ timeout: 25000 }); bar = 'signed-in'; }
  catch { try { bar = (await page.getByText('الجلسة:').first().isVisible()).then(v => v ? 'signed-in' : 'no-bar'); } catch { bar = 'no-bar'; } }
  return bar;
}


async function openCloud(page, screen) {
  netLog.length = 0;
  await page.goto(`${BASE}/?cloud=1&screen=${screen}`, { waitUntil: 'domcontentloaded' });
}

/** Picks an <option> whose visible label contains `needle`. */
async function selectContaining(locator, needle) {
  const options = await locator.locator('option').all();
  for (const o of options) {
    const text = ((await o.textContent()) || '').trim();
    if (text.includes(needle)) {
      const value = await o.getAttribute('value');
      await locator.selectOption(value);
      return text;
    }
  }
  throw new Error(`option containing "${needle}" not found`);
}

const labelSelect = (page, label) => page.locator('label').filter({ hasText: label }).locator('select').first();
const labelInput = (page, label) => page.locator('label').filter({ hasText: label }).locator('input').first();

async function waitSalesForm(page) {
  await page
    .locator('h3', { hasText: 'فاتورة بيع سحابية' })
    .first()
    .waitFor({ timeout: 25000 });
  await page.waitForFunction(
    () => !!document.querySelector('form') && document.body.innerText.includes('ترحيل الفاتورة على الخادم'),
    null,
    { timeout: 25000 },
  );
}

async function fillSalesLine(page, { itemNeedle, qty }) {
  await selectContaining(labelSelect(page, 'الصنف #1'), itemNeedle);
  await labelInput(page, 'الكمية').fill(String(qty));
}

const uiSuccess = page => page.getByText(/تم الترحيل — الفاتورة/).first();
const uiFailure = page => page.getByText(/لم تُرحَّل الفاتورة/).first();

async function uiResult(page) {
  // A previous result box may still be on screen: the form clears it only once
  // the new submission starts, so wait for the clear before racing the answer.
  await uiSuccess(page).waitFor({ state: 'detached', timeout: 12000 }).catch(() => {});
  await uiFailure(page).waitFor({ state: 'detached', timeout: 12000 }).catch(() => {});
  try {
    await Promise.race([
      uiSuccess(page).waitFor({ timeout: 45000 }),
      uiFailure(page).waitFor({ timeout: 45000 }),
    ]);
  } catch {
    return { ok: false, text: 'لم يظهر أي نتيجة ترحيل خلال 45 ثانية' };
  }
  if (await uiSuccess(page).count()) {
    const text = (await uiSuccess(page).innerText()).trim();
    const n = /تم الترحيل — الفاتورة\s+(\S+)/.exec(text);
    const cogs = /COGS\s+(\S+)\s+·\s+قيد التكلفة\s+(\S+)/.exec(text);
    return {
      ok: true,
      invoiceNumber: n ? n[1] : '',
      cogs: cogs ? cogs[1] : '',
      cogsJournal: cogs ? cogs[2] : '',
      text,
    };
  }
  const box = await uiFailure(page).locator('xpath=ancestor::div[1]').innerText().catch(() => '');
  return { ok: false, text: box.trim() || (await uiFailure(page).innerText()) };
}

/* ---------------------------------------------------------------- commands */

async function cmdPreview() {
  try {
    const res = await fetch(`${BASE}/`);
    record('preview: server responds', res.status === 200 ? 'PASS' : 'FAIL', `GET / -> ${res.status}`);
    const mod = await fetch(`${BASE}/src/main.tsx`);
    record('preview: app module served', mod.status === 200 ? 'PASS' : 'FAIL', `GET /src/main.tsx -> ${mod.status}`);
  } catch (e) {
    record('preview: server responds', 'FAIL', e.message);
  }
  finish('preview');
}

async function cmdBaseline() {
  if (!checkConfig()) return finish('baseline');
  const browser = await launch();
  if (!browser) return finish('baseline');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'ar-EG' });
  const page = await newPage(ctx);
  watchNetwork(page);

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const ok = await page
    .waitForFunction(() => document.body.innerText.trim().length > 200, null, { timeout: 25000 })
    .then(() => true)
    .catch(() => false);
  record('local: ERP at / renders', ok ? 'PASS' : 'FAIL', ok ? 'local-first shell mounted' : 'no content');
  await shot(page, 'baseline-local-app');

  const snap = await page.evaluate(() => {
    const raw = localStorage.getItem('abdullah_erp_db_v1');
    let hash = 0;
    if (raw) for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
    return {
      keys: Object.keys(localStorage).sort(),
      length: raw ? raw.length : 0,
      hash: raw ? hash.toString(16) : null,
      hasInvoice: raw ? raw.includes('salesInvoices') || raw.includes('SINV') : false,
    };
  });
  writeFileSync(path.join(SHOTS, 'localstorage-baseline.json'), JSON.stringify(snap, null, 2));
  record(
    'local: localStorage fingerprint captured',
    snap.hash ? 'PASS' : 'FAIL',
    `keys=${snap.keys.length} bytes=${snap.length} hash=${snap.hash}`,
  );

  await browser.close();
  finish('baseline');
}

async function cmdLogin() {
  if (!checkConfig()) return finish('login');
  const browser = await launch();
  if (!browser) return finish('login');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'ar-EG' });
  const page = await newPage(ctx);
  watchNetwork(page);

  await openCloud(page, 'sales');
  const how = await ensureSignedIn(page) ?? 'timeout';
  record('login: cloud gate sign-in', how === 'signed-in' ? 'PASS' : 'FAIL', how);
  const bar = (await page.getByText('الجلسة:').first().innerText()).trim();
  record('login: session shows approved TEST account', bar.includes(EMAIL) ? 'PASS' : 'FAIL', bar.replace(/\s+/g, ' '));
  await shot(page, 'login-session');

  const role = await page.evaluate(() =>
    (document.body.innerText.match(/الدور\s+([^\n]+)/) || ['', ''])[1].trim(),
  );
  record('login: ERP role resolved', role === 'Super Admin' ? 'PASS' : 'FAIL', `role=${role || '(empty)'}`);

  await browser.close();
  finish('login');
}

async function cmdSales() {
  if (!checkConfig()) return finish('sales');
  const browser = await launch();
  if (!browser) return finish('sales');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'ar-EG' });
  const page = await newPage(ctx);
  watchNetwork(page);

  const before = Number(db1('select count(*) from sales.invoices'));
  const wh01 = 'qa-e2e-wh-01';
  const snapStock = () =>
    db(
      `select batch_number||'|'||quantity||'|'||unit_cost||'|'||coalesce(production_date::text, '')
         from inventory.batches
        where item_id='qa-item-01' and warehouse_id='${wh01}' and active
        order by production_date asc nulls first, batch_number asc`,
    );
  const  parseStock = rows =>
    rows.map(l => {
      const p = l.split('|');
      return { batchNumber: p[0], quantity: Number(p[1]), unitCost: Number(p[2]), productionDate: p[3] };
    });
  /** The plan the FIFO rule implies for `need` units, oldest production date first. */
  const fifoPlan = (layers, need) => {
    let left = need;
    const out = [];
    for (const l of layers) {
      if (left <= 0) break;
      const take = Math.min(l.quantity, left);
      if (take > 0) out.push({ batchNumber: l.batchNumber, take, unitCost: l.unitCost });
      left -= take;
    }
    return { out, shortfall: left };
  };
  const stockBefore = parseStock(snapStock());
  const available = stockBefore.reduce((s, l) => s + l.quantity, 0);
  // Keep the scenario repeatable: never drain the fixture completely.
  const QTY = Math.min(8, available - 4);
  if (QTY < 1) {
    record('sales: fixture stock available', 'BLOCKED', `qa-item-01 / qa-e2e-wh-01 available=${available}`);
    await browser.close();
    return finish('sales');
  }
  let stockBeforeMap;
  try { stockBeforeMap = Object.fromEntries(stockBefore.map(l => [l.batchNumber, l.quantity])); } catch { stockBeforeMap = {}; }
  const tbBefore = db1(
    'select round(sum(debit),2)||\'|\'||round(sum(credit),2) from fin.journal_lines',
  );
  let stockBeforeArr;
  try { stockBeforeArr = stockBefore.map(l => l.batchNumber + ':' + l.quantity); } catch { stockBeforeArr = []; }
  let stockBeforeRaw;
  try { stockBeforeRaw = stockBefore.map(l => l.batchNumber + '|' + l.quantity + '|' + l.unitCost + '|' + l.productionDate); } catch { stockBeforeRaw = []; }

  await openCloud(page, 'sales');
  await ensureSignedIn(page);
  await waitSalesForm(page);
  record('sales: write form offered to Super Admin', 'PASS', 'post_sales_invoice_integrated form rendered');
  await shot(page, 'sales-form');

  // -------- 1. create + post -------------------------------------------------
  await selectContaining(labelSelect(page, 'مصدر الصرف'), 'QA-WHS-01');
  await selectContaining(labelSelect(page, 'العميل'), 'QA-CUST-001');
  await selectContaining(labelSelect(page, 'القناة'), 'تجزئة');
  await selectContaining(labelSelect(page, 'طريقة السداد'), 'نقدي');
  await fillSalesLine(page, { itemNeedle: 'QA-ITEM-01', qty: QTY });

  // capture the idempotency key of the first submission for the replay test
  let firstBody = null;
  let replayNext = false;
  await page.route('**/rest/v1/rpc/post_sales_invoice_integrated', async route => {
    const body = route.request().postDataJSON();
    if (!firstBody) {
      firstBody = body;
      return route.continue();
    }
    if (!replayNext) return route.continue();
    replayNext = false;
    const payload = JSON.stringify({ ...body, p_idempotency_key: firstBody.p_idempotency_key });
    const headers = { ...route.request().headers(), 'content-length': String(Buffer.byteLength(payload)) };
    return route.continue({ postData: payload, headers });
  });

  await page.click('button:has-text("ترحيل الفاتورة على الخادم")');
  const res1 = await uiResult(page);
  await shot(page, 'sales-posted');
  if (!res1.ok || !res1.invoiceNumber) {
    record('sales: UI posts an invoice', 'FAIL', res1.text.replace(/\s+/g, ' ').slice(0, 300));
    await browser.close();
    return finish('sales');
  }
  record('sales: UI posts an invoice', 'PASS', `${res1.invoiceNumber} · COGS ${res1.cogs} · ${res1.cogsJournal}`);
  const invNo = res1.invoiceNumber;

  // -------- 2. database verification ---------------------------------------
  const inv = db1(
    `select id||'|'||status||'|'||coalesce(nullif(journal_entry_id,''),'NULL')||'|'||cogs_total||'|'||total_amount||'|'||warehouse_id
       from sales.invoices where invoice_number = '${invNo}'`,
  );
  const [invId, invStatus, invJe, invCogs, invTotal, invWh] = inv.split('|');
  record('db: invoice row is posted', invStatus === 'posted' ? 'PASS' : 'FAIL', `status=${invStatus}`);
  record('db: invoice has a linked journal entry', invJe !== 'NULL' ? 'PASS' : 'FAIL', `journal_entry_id=${invJe}`);
  record('db: invoice warehouse is the picked one', invWh === wh01 ? 'PASS' : 'FAIL', `warehouse=${invWh}`);
  record('db: COGS recorded on the invoice', Number(invCogs) > 0 ? 'PASS' : 'FAIL', `cogs_total=${invCogs}`);

  const jes = db(
    `select entry_number||'|'||is_posted||'|'||round(total_debit,2)||'|'||round(total_credit,2)
       from fin.journal_entries where reference = '${invNo}' order by entry_number`,
  );
  record('db: sales + COGS journals exist for the invoice', jes.length === 2 ? 'PASS' : 'FAIL', `count=${jes.length}`);
  const balanced = jes.every(l => {
    const [, posted, dr, cr] = l.split('|');
    return posted === 'true' && Number(dr) === Number(cr);
  });
  record('db: both journals posted and debit = credit', balanced ? 'PASS' : 'FAIL', jes.join(' ; '));

  const accts = db(
    `select distinct l.account_code from fin.journal_lines l
       join fin.journal_entries e on e.id = l.journal_entry_id
      where e.reference = '${invNo}' order by 1`,
  );
  // Cash sale -> the cash mapping; credit sale -> the receivable mapping.
  const needAccounts = ['4101', '2103', '5101', '1109'];
  const missing = needAccounts.filter(a => !accts.some(c => c.startsWith(a)));
  const settlement = accts.some(c => c.startsWith('1101')) ? '1101' : accts.some(c => c.startsWith('1105')) ? '1105' : null;
  record(
    'db: journal hits revenue / VAT / settlement / COGS / inventory',
    missing.length === 0 && settlement ? 'PASS' : 'FAIL',
    `accounts=[${accts.join(', ')}]${missing.length ? ` missing=${missing.join(',')}` : ''}${settlement ? '' : ' no settlement account'}`,
  );

  const tx = db(
    `select batch_number||'|'||quantity_out||'|'||unit_cost||'|'||total_cost from inventory.transactions
      where document_number = '${invNo}' and movement_type = 'sales' order by batch_number`,
  );
  const issued = tx.reduce((s, l) => s + Number(l.split('|')[1]), 0);
  record('db: FIFO stock issue rows created', tx.length > 0 ? 'PASS' : 'FAIL', `rows=${tx.length} issued=${issued}`);
  record('db: issued quantity matches the invoice line', issued === QTY ? 'PASS' : 'FAIL', `issued=${issued} expected=${QTY}`);

  // FIFO proof: the batch balances must move exactly as the FIFO plan says and
  // the invoice COGS must equal the plan's cost (layer cost, not a guess).
  const plan = fifoPlan(stockBefore, QTY);
  const stockAfter = parseStock(snapStock());
  const afterByBatch = Object.fromEntries(stockAfter.map(l => [l.batchNumber, l.quantity]));
  const beforeByBatch = Object.fromEntries(stockBefore.map(l => [l.batchNumber, l.quantity]));
  const deltasOk = plan.out.every(
    p => (stockBeforeMap[p.batchNumber] ?? 0) - (afterByBatch[p.batchNumber] ?? 0) === p.take,
  );
  const untouchedOk = stockAfter.every(l => {
    const planned = plan.out.find(p => p.batchNumber === l.batchNumber);
    return planned ? true : stockBeforeMap[l.batchNumber] === l.quantity;
  });
  const planCost = plan.out.reduce((s, p) => s + p.take * p.unitCost, 0);
  record(
    'db: FIFO plan matched the batch movement exactly',
    plan.shortfall === 0 && deltasOk && untouchedOk ? 'PASS' : 'FAIL',
    `plan=${plan.out.map(p => `${p.batchNumber}×${p.take}@${p.unitCost}`).join(' + ')} cost=${planCost}`,
  );
  record(
    'db: invoice COGS equals the FIFO layer cost',
    Math.abs(Number(invCogs) - planCost) < 0.005 ? 'PASS' : 'FAIL',
    `cogs=${invCogs} fifoCost=${planCost}`,
  );
  const lineUnitCost = Number(
    db1(`select round(unit_cost, 6) from sales.invoice_lines where invoice_id = '${invId}' limit 1`),
  );
  const expectedUnitCost = issued > 0 ? Number(invCogs) / issued : 0;
  record(
    'db: invoice line unit cost is the FIFO weighted cost',
    Math.abs(lineUnitCost - expectedUnitCost) < 0.005 ? 'PASS' : 'FAIL',
    `line unit_cost=${lineUnitCost} expected=${expectedUnitCost.toFixed(6)}`,
  );
  const firstLayer = plan.out[0]?.batchNumber ?? '';
  record(
    'db: movement row points at the first consumed FIFO layer',
    tx.length > 0 && tx[0].split('|')[0] === firstLayer ? 'PASS' : 'FAIL',
    `row batch=${tx[0]?.split('|')[0] ?? '-'} first layer=${firstLayer}`,
  );
  record(
    'db: one movement row per invoice line (documented aggregation)',
    tx.length === 1 ? 'PASS' : 'FAIL',
    `rows=${tx.length} fifo layers=${plan.out.length} — SQL documents "one movement row per line, primary batch = first consumed layer, unit cost = weighted actual cost"`,
  );

  const batchesAfter = snapStock();
  const afterMap = Object.fromEntries(batchesAfter.map(l => l.split('|').slice(0, 2)));
  const reduced = stockBefore.some(l => Number(afterMap[l.batchNumber]) !== l.quantity);
  record(
    'db: batch balances reduced',
    reduced ? 'PASS' : 'FAIL',
    `before=[${stockBefore.map(l => `${l.batchNumber}:${l.quantity}`).join(', ')}] after=[${batchesAfter.map(l => l.split('|').slice(0, 2).join(':')).join(', ')}]`,
  );

  // Global FIFO invariant: while an older layer still holds stock, a newer
  // layer for the same item + warehouse must be empty.
  const violations = Number(
    db1(
      `with s as (
         select item_id, warehouse_id, batch_number, quantity,
                coalesce(production_date, 'epoch'::date) pd,
                sum(quantity) over (partition by item_id, warehouse_id
                                    order by coalesce(production_date, 'epoch'::date), batch_number
                                    rows between unbounded preceding and 1 preceding) as older_qty
           from inventory.batches where active
       )
       select count(*) from s where coalesce(older_qty, 0) > 0 and quantity > 0`,
    ),
  );
  record('db: no newer batch stocked while an older layer still holds stock', violations === 0 ? 'PASS' : 'FAIL', `violations=${violations}`);

  const tbAfter = db1('select round(sum(debit),2)||\'|\'||round(sum(credit),2) from fin.journal_lines');
  const [tdr, tcr] = tbAfter.split('|');
  record('db: trial balance still balanced', Number(tdr) === Number(tcr) ? 'PASS' : 'FAIL', `debit=${tdr} credit=${tcr}`);
  const [bdr, bcr] = tbBefore.split('|');
  record(
    'db: ledger grew by the invoice and stayed balanced',
    Number(tdr) - Number(bdr) === Number(tcr) - Number(bcr) ? 'PASS' : 'FAIL',
    `Δdebit=${(Number(tdr) - Number(bdr)).toFixed(2)} Δcredit=${(Number(tcr) - Number(bcr)).toFixed(2)}`,
  );

  const after1 = Number(db1('select count(*) from sales.invoices'));
  record('db: exactly one new invoice created', after1 === before + 1 ? 'PASS' : 'FAIL', `${before} -> ${after1}`);

  // -------- 3. idempotent replay of the SAME submission ---------------------
  replayNext = true;
  await labelInput(page, 'الكمية').fill('5');
  await page.click('button:has-text("ترحيل الفاتورة على الخادم")');
  const res2 = await uiResult(page);
  await shot(page, 'sales-idempotent-replay');
  const after2 = Number(db1('select count(*) from sales.invoices'));
  if (res2.ok) {
    record(
      'ui: replaying the same idempotency key returns the same invoice',
      res2.invoiceNumber === invNo ? 'PASS' : 'FAIL',
      `first=${invNo} replay=${res2.invoiceNumber}`,
    );
    record('db: replay created no second invoice', after2 === after1 ? 'PASS' : 'FAIL', `${after1} -> ${after2}`);
  } else {
    record('ui: replaying the same idempotency key returns the same invoice', 'FAIL', res2.text.replace(/\s+/g, ' ').slice(0, 240));
    record('db: replay created no second invoice', after2 === after1 ? 'PASS' : 'FAIL', `${after1} -> ${after2}`);
  }

  // -------- 4. real double click cannot post twice --------------------------
  await page.unroute('**/rest/v1/rpc/post_sales_invoice_integrated');
  await fillSalesLine(page, { itemNeedle: 'QA-ITEM-01', qty: 3 });
  const btn = page.locator('button:has-text("ترحيل الفاتورة على الخادم")');
  const box = await btn.boundingBox();
  // two physical clicks at the same point, no actionability wait in between —
  // exactly what a hurried operator does on a trackpad.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const res3 = await uiResult(page);
  const after3 = Number(db1('select count(*) from sales.invoices'));
  record(
    'ui: double click posts exactly one invoice',
    res3.ok && after3 === after2 + 1 ? 'PASS' : 'FAIL',
    `invoices ${after2} -> ${after3} · ${res3.ok ? res3.invoiceNumber : res3.text.slice(0, 120)}`,
  );

  // -------- 5. what the screen really called --------------------------------
  record(
    'net: sales screen writes through post_sales_invoice_integrated',
    rpcsCalled().includes('rpc/post_sales_invoice_integrated') ? 'PASS' : 'FAIL',
    `rpcs=[${rpcsCalled().join(', ')}]`,
  );
  const masterRead = tablesRead().filter(t => t.startsWith('erp_master_records'));
  record(
    'net: sales screen reads core.* through the approved bridge',
    netLog.some(x => x.includes('rpc/erp_core_master_read')) ? 'PASS' : 'FAIL',
    `core bridge calls=${netLog.filter(x => x.includes('rpc/erp_core_master_read')).length}` +
      (masterRead.length ? ` · DIRECT erp_master_records=${masterRead.length}` : ''),
  );
  record(
    'net: sales screen never touches public.erp_master_records',
    masterRead.length === 0 ? 'PASS' : 'FAIL',
    masterRead.join(', ') || 'no direct table read',
  );

  await browser.close();
  finish('sales');
}

async function cmdTransfer() {
  if (!checkConfig()) return finish('transfer');
  const browser = await launch();
  if (!browser) return finish('transfer');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'ar-EG' });
  const page = await newPage(ctx);
  watchNetwork(page);

  const stockBefore = db1(
    `select sum(quantity) from inventory.batches where item_id='qa-item-02' and warehouse_id='qa-e2e-wh-01' and active`,
  );
  const txCountBefore = Number(db1('select count(*) from inventory.transactions'));

  await openCloud(page, 'inventory');
  await ensureSignedIn(page);
  await page.waitForFunction(
    () => document.body.innerText.includes('تحويل مخزني داخلي'),
    null,
    { timeout: 25000 },
  );
  // The card only renders the form after can_write_inventory() + the pickers,
  // so wait for one of its three terminal states instead of assuming readiness.
  await Promise.race([
    page.getByText('تنفيذ التحويل على الخادم').first().waitFor({ timeout: 30000 }),
    page.getByText(/لا يملك صلاحية تحريك المخزون/).first().waitFor({ timeout: 30000 }),
    page.getByText(/تعذّر إتاحة التحويل السحابي/).first().waitFor({ timeout: 30000 }),
  ]).catch(() => {});
  const denied = await page.getByText(/لا يملك صلاحية تحريك المخزون/).count();
  const cardError = await page.getByText(/تعذّر إتاحة التحويل السحابي/).count();
  const formReady = await page.getByText('تنفيذ التحويل على الخادم').count();
  record(
    'transfer: form offered to Super Admin',
    formReady > 0 && !denied && !cardError ? 'PASS' : 'FAIL',
    formReady > 0 ? 'form rendered' : denied ? 'role gate denied' : cardError ? 'card error' : 'card never settled',
  );
  if (!formReady) {
    await shot(page, 'transfer-denied');
    await browser.close();
    return finish('transfer');
  }
  await shot(page, 'transfer-form');

  await selectContaining(labelSelect(page, 'الصنف'), 'QA-ITEM-02');
  await labelInput(page, 'الكمية').fill('4');
  await selectContaining(labelSelect(page, 'من مستودع'), 'QA-WHS-01');
  await selectContaining(labelSelect(page, 'إلى مستودع'), 'QA-WHS-02');
  await page.click('button:has-text("تنفيذ التحويل على الخادم")');

  let text = '';
  try {
    await Promise.race([
      page.getByText(/تم التحويل على الخادم/).first().waitFor({ timeout: 45000 }),
      page.getByText(/تعذّر التحويل|مرفوض|غير متاح/).first().waitFor({ timeout: 45000 }),
    ]);
  } catch {
    /* fall through */
  }
  const okEl = await page.getByText(/تم التحويل على الخادم/).count();
  text = okEl
    ? (await page.getByText(/تم التحويل على الخادم/).first().innerText()).trim()
    : (await page.locator('form p').filter({ hasText: /مرفوض|تعذّر|غير متاح/ }).first().innerText().catch(() => 'لا نتيجة'));
  await shot(page, 'transfer-result');
  record('ui: transfer posted from the screen', okEl ? 'PASS' : 'FAIL', text.replace(/\s+/g, ' '));

  const doc = (/رقم المستند\s+(\S+)/.exec(text) || [])[1] || '';

  const stockAfter = db1(
    `select sum(quantity) from inventory.batches where item_id='qa-item-02' and warehouse_id='qa-e2e-wh-01' and active`,
  );
  const targetAfter = db1(
    `select sum(quantity) from inventory.batches where item_id='qa-item-02' and warehouse_id='qa-e2e-wh-02' and active`,
  );
  record(
    'db: source balance decreased by 4',
    Number(stockBefore) - Number(stockAfter) === 4 ? 'PASS' : 'FAIL',
    `${stockBefore} -> ${stockAfter}`,
  );
  record('db: target balance holds the received qty', Number(targetAfter) >= 4 ? 'PASS' : 'FAIL', `QA-WHS-02=${targetAfter}`);

  const moves = db(
    `select warehouse_id||'|'||quantity_in||'|'||quantity_out from inventory.transactions
      where document_number = '${doc}' order by warehouse_id`,
  );
  record('db: transfer wrote an out row and an in row', moves.length === 2 ? 'PASS' : 'FAIL', moves.join(' ; '));
  const totalOut = moves.reduce((s, l) => s + Number(l.split('|')[2]), 0);
  const totalIn = moves.reduce((s, l) => s + Number(l.split('|')[1]), 0);
  record('db: transfer rows are balanced', totalOut === 4 && totalIn === 4 ? 'PASS' : 'FAIL', `out=${totalOut} in=${totalIn}`);

  const txCountAfter = Number(db1('select count(*) from inventory.transactions'));
  record('db: exactly two new movement rows', txCountAfter === txCountBefore + 2 ? 'PASS' : 'FAIL', `${txCountBefore} -> ${txCountAfter}`);

  const idem = doc ? db1(`select count(*) from fin.inventory_transfer_log where document_number = '${doc}'`) : '0';
  record('db: transfer recorded an idempotency key', Number(idem) > 0 ? 'PASS' : 'FAIL', `rows=${idem}`);

  const tb = db1('select round(sum(debit),2)||\'|\'||round(sum(credit),2) from fin.journal_lines');
  const [dr, cr] = tb.split('|');
  record('db: trial balance untouched/balanced after transfer', Number(dr) === Number(cr) ? 'PASS' : 'FAIL', `debit=${dr} credit=${cr}`);

  record(
    'net: transfer writes through post_inventory_transfer',
    rpcsCalled().includes('rpc/post_inventory_transfer') ? 'PASS' : 'FAIL',
    `rpcs=[${rpcsCalled().join(', ')}]`,
  );

  await browser.close();
  finish('transfer');
}

async function cmdReject() {
  if (!checkConfig()) return finish('reject');
  const browser = await launch();
  if (!browser) return finish('reject');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'ar-EG' });
  const page = await newPage(ctx);
  watchNetwork(page);

  const before = Number(db1('select count(*) from sales.invoices'));

  // ---------- A. insufficient quantity -------------------------------------
  await openCloud(page, 'sales');
  await ensureSignedIn(page);
  await waitSalesForm(page);
  await selectContaining(labelSelect(page, 'مصدر الصرف'), 'QA-WHS-01');
  await selectContaining(labelSelect(page, 'العميل'), 'QA-CUST-001');
  await selectContaining(labelSelect(page, 'طريقة السداد'), 'نقدي');
  await fillSalesLine(page, { itemNeedle: 'QA-ITEM-02', qty: 99999 });
  await page.click('button:has-text("ترحيل الفاتورة على الخادم")');
  const oversell = await uiResult(page);
  await shot(page, 'reject-oversell');
  const afterOversell = Number(db1('select count(*) from sales.invoices'));
  record(
    'reject: quantity beyond available stock refused',
    !oversell.ok ? 'PASS' : 'FAIL',
    oversell.ok ? `unexpectedly posted ${oversell.invoiceNumber}` : oversell.text.replace(/\s+/g, ' ').slice(0, 260),
  );
  record('reject: oversell wrote no invoice', afterOversell === before ? 'PASS' : 'FAIL', `${before} -> ${afterOversell}`);

  // ---------- B. closed accounting period ----------------------------------
  await fillSalesLine(page, { itemNeedle: 'QA-ITEM-01', qty: 2 });
  await labelInput(page, 'التاريخ').fill('2026-09-15');
  await page.click('button:has-text("ترحيل الفاتورة على الخادم")');
  const closed = await uiResult(page);
  await shot(page, 'reject-closed-period');
  const afterClosed = Number(db1('select count(*) from sales.invoices'));
  const closedLeak = Number(db1(`select count(*) from sales.invoices where date = '2026-09-15'`));
  record(
    'reject: closed accounting period refused',
    !closed.ok && /2026-09|فترة|period|closed|مغلق/i.test(closed.text) ? 'PASS' : 'FAIL',
    closed.ok ? `unexpectedly posted ${closed.invoiceNumber}` : closed.text.replace(/\s+/g, ' ').slice(0, 260),
  );
  record('reject: closed-period posting wrote nothing', afterClosed === before && closedLeak === 0 ? 'PASS' : 'FAIL', `invoices=${afterClosed} septRows=${closedLeak}`);

  const periodOk = db1(`select count(*) from core.accounting_periods where code = 'QA-2026-09-CLOSED' and is_closed`);
  record('guard: QA-2026-09-CLOSED is still closed', periodOk === '1' ? 'PASS' : 'FAIL', `is_closed rows=${periodOk}`);

  // ---------- C. unauthorized user -----------------------------------------
  // No second auth account and no guard is touched: the TEST profile's role is
  // temporarily read as Viewer for this one browser session and restored in a
  // `finally`, then verified below.
  const WRITE_ROLE = 'Super Admin';
  const PROFILE_AUTH_ID = db1(
    `select supabase_auth_id from core.app_profiles where lower(email) = lower('${EMAIL}') limit 1`,
  );
  if (!PROFILE_AUTH_ID) {
    record('fixture: TEST profile found for the approved account', 'FAIL', 'no core.app_profiles row for the QA account');
    await browser.close();
    return finish('reject');
  }
  const setProfileRole = r =>
    db(`update core.app_profiles set role = '${r}', updated_at = now()
         where supabase_auth_id = '${PROFILE_AUTH_ID}'`);
  let ctx2 = null;
  try {
    setProfileRole('Viewer');
    const demoted = db1(`select role from core.app_profiles where supabase_auth_id = '${PROFILE_AUTH_ID}'`);
    record(
      'fixture: TEST profile read as Viewer for this session',
      demoted === 'Viewer' ? 'PASS' : 'FAIL',
      `role=${demoted}`,
    );

    ctx2 = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'ar-EG' });
    const page2 = await newPage(ctx2);
    watchNetwork(page2);
    await openCloud(page2, 'sales');
    await page2
      .waitForFunction(
        () =>
          document.body.innerText.includes('الجلسة:') ||
          !!document.querySelector('input[type="password"]'),
        null,
        { timeout: 25000 },
      )
      .catch(() => {});
    await page2.fill('input[type="email"]', EMAIL);
    await page2.fill('input[type="password"]', PASSWORD);
    await page2.click('button[type="submit"]');
    const signed = await page2
      .getByText('الجلسة:')
      .first()
      .waitFor({ timeout: 25000 })
      .then(() => true)
      .catch(() => false);
    record('reject: TEST account signs in for the Viewer session', signed ? 'PASS' : 'FAIL', signed ? 'session acquired' : 'sign-in failed');
    await page2.waitForTimeout(2500);
    const role2 = await page2.evaluate(() =>
      (document.body.innerText.match(/الدور\s+([^\n]+)/) || ['', ''])[1].trim(),
    );
    record('reject: role resolves to Viewer', role2 === 'Viewer' ? 'PASS' : 'FAIL', `role=${role2 || '(empty)'}`);
    await Promise.race([
      page2.getByText('ترحيل الفاتورة على الخادم').first().waitFor({ timeout: 30000 }),
      page2.getByText(/لا يملك صلاحية ترحيل فواتير البيع/).first().waitFor({ timeout: 30000 }),
    ]).catch(() => {});
    const formShown = await page2.getByText('ترحيل الفاتورة على الخادم').count();
    record('reject: sales write form NOT offered to Viewer', formShown === 0 ? 'PASS' : 'FAIL', `submit buttons=${formShown}`);
    const deniedText = await page2.getByText(/لا يملك صلاحية ترحيل فواتير البيع/).count();
    record('reject: Viewer sees the explicit authorization message', deniedText > 0 ? 'PASS' : 'FAIL', `message=${deniedText}`);
    await shot(page2, 'reject-unauthorized-viewer');

    // Server gate, still from inside the browser page: every field is empty on
    // purpose so even a passing gate could only reach the pre-flight rejection.
    const gate = await page2.evaluate(
      async ({ url, anon, email, password }) => {
        const authRes = await fetch(`${url}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: anon },
          body: JSON.stringify({ email, password }),
        });
        const authBody = await authRes.json();
        if (!authBody.access_token) return { stage: 'token', detail: String(authBody.msg || authBody.error_description || authRes.status) };
        const rpcRes = await fetch(`${url}/rest/v1/rpc/post_sales_invoice_integrated`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            apikey: anon,
            authorization: `Bearer ${authBody.access_token}`,
          },
          body: JSON.stringify({
            p_customer_id: '', p_channel: 'retail', p_warehouse_id: '',
            p_payment_method: 'cash', p_currency: 'EGP', p_exchange_rate: 1,
            p_date: '2026-10-27', p_lines: [], p_created_by: 'qa-viewer-gate',
            p_idempotency_key: 'qa-viewer-gate-probe',
          }),
        });
        return { stage: 'rpc', status: rpcRes.status, detail: (await rpcRes.text()).slice(0, 400) };
      },
      { url: process.env.VITE_SUPABASE_URL, anon: process.env.VITE_SUPABASE_ANON_KEY, email: EMAIL, password: PASSWORD },
    );
    const refused =
      gate.stage === 'rpc' &&
      /unauthorized|ERP role|not_authorized|permission|42501|may not post/i.test(gate.detail);
    record(
      'reject: SERVER refuses the integrated sales posting for Viewer',
      refused ? 'PASS' : 'FAIL',
      `${gate.stage} ${gate.status ?? ''} ${String(gate.detail).replace(/\s+/g, ' ').slice(0, 220)}`,
    );

    const viewerInvoices = Number(db1('select count(*) from sales.invoices'));
    record('reject: Viewer session left the ledger untouched', viewerInvoices === before ? 'PASS' : 'FAIL', `invoices=${before} -> ${viewerInvoices}`);
  } catch (e) {
    record('reject: unauthorized-user scenario completed', 'FAIL', String(e.message).split('\n')[0]);
  } finally {
    if (ctx2) await ctx2.close().catch(() => {});
    setProfileRole(WRITE_ROLE);
  }
  const restored = db1(`select role from core.app_profiles where supabase_auth_id = '${PROFILE_AUTH_ID}'`);
  record(
    'guard: TEST profile role restored to Super Admin',
    restored === WRITE_ROLE ? 'PASS' : 'FAIL',
    `role=${restored}`,
  );

  await browser.close();
  finish('reject');
}

async function cmdScreens() {
  if (!checkConfig()) return finish('screens');
  const browser = await launch();
  if (!browser) return finish('screens');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, locale: 'ar-EG' });
  const page = await newPage(ctx);
  watchNetwork(page);

  const readStore = () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('abdullah_erp_db_v1');
      let hash = 0;
      if (raw) for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
      return {
        keys: Object.keys(localStorage).sort(),
        length: raw ? raw.length : 0,
        hash: raw ? hash.toString(16) : null,
      };
    });

  // Same browser context for the whole comparison: open the LOCAL app first so
  // localStorage actually has content, fingerprint it, then sweep the cloud
  // screens and fingerprint again. Cloud routes must not change a single byte.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.trim().length > 200, null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const storeBefore = await readStore();
  record(
    'screens: local localStorage fingerprint captured in this context',
    storeBefore.hash ? 'PASS' : 'FAIL',
    `keys=${storeBefore.keys.length} bytes=${storeBefore.length} hash=${storeBefore.hash}`,
  );

  const main = readFileSync(path.join(ROOT, 'src', 'main.tsx'), 'utf8');
  const navBlock = main.slice(main.indexOf('const CLOUD_NAV'), main.indexOf('function CloudNav'));
  const screens = [...navBlock.matchAll(/key:\s*'([^']+)'/g)].map(m => m[1]);
  record('screens: navigation list read from main.tsx', screens.length >= 15 ? 'PASS' : 'FAIL', `${screens.length} screens`);

  const rows = [];
  for (const screen of screens) {
    const t0 = Date.now();
    netLog.length = 0;
    let err = '';
    let ok = true;
    try {
      await page.goto(`${BASE}/?cloud=1&screen=${screen}`, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      err = 'goto:' + String(e.message).split('\n')[0]; ok = false;
    }
    if (ok) {
      try {
        await ensureSignedIn(page);
      } catch (e) {
        err = (err ? err + ' | ' : '') + 'gate:' + String(e.message).split('\n')[0];
      }
    }
    if (ok) {
      try {
        await page.waitForFunction(() => document.body.innerText.trim().length > 300, null, { timeout: 15000 });
      } catch (e) {
        err = (err ? err + ' | ' : '') + 'rendered:' + String(e.message).split('\n')[0];
      }
    }
    const body = (await page.evaluate(() => document.body.innerText).catch(() => '')) || '';
    const hasError =
      /تعذّر تحميل|تعذّر إتاحة|لم تُضبط VITE_SUPABASE|أعِد التحميل|لا توجد جلسة سحابية|خطأ|Rendering|Error|SyntaxError|Cannot read|Page|window\./.test(body);
    const ui = await page
      .evaluate(() => ({
        forms: document.querySelectorAll('form').length,
        submits: [...document.querySelectorAll('button[type="submit"]')]
          .map(b => (b.innerText || '').trim().replace(/\s+/g, ' '))
          .filter(x => /submit|ترحيل|تنفيذ|إضافة|إنشاء|إصدار|حفظ|تحرير|إرسال/i.test(x)),
      }))
      .catch(() => ({ forms: 0, submits: [] }));
    const rpcs = rpcsCalled();
    const tables = tablesRead();
    const writes = rpcs.filter(r =>
      /rpc\/(post_|erp_master_cas|erp_warehouse_cas|set_|create_|expire_|cancel_|approve_)/.test(r),
    );
    const masterDirect = tables.filter(t => t.startsWith('erp_master_records'));
    const coreBridge = rpcs.includes('rpc/erp_core_master_read');

    let classification;
    if (err || hasError) classification = 'غير مكتملة';
    else if (ui.submits.length > 0) classification = 'واجهة متصلة فعليًا (قراءة+كتابة)';
    else if (rpcs.length) classification = 'RPC فقط (قراءة)';
    else classification = 'غير مكتملة (بلا نداء)';

    rows.push({
      screen,
      ms: Date.now() - t0,
      classification,
      error: err || (hasError ? 'error banner on screen' : ''),
      writeUi: ui.submits,
      observedWrites: writes,
      reads: rpcs.filter(r => !writes.includes(r)),
      tables,
      coreBridge,
      masterDirect,
      textLen: body.length,
    });
    if (!err && !hasError) await shot(page, `screen-${screen}`);
    console.log(
      `  ${screen.padEnd(18)} ${classification.padEnd(32)} rpc=${rpcs.length} forms=${ui.forms} submits=${ui.submits.length} ${err ? 'ERR:' + err : ''}`,
    );
  }

  writeFileSync(path.join(SHOTS, 'screen-classification.json'), JSON.stringify(rows, null, 2));

  const broken = rows.filter(r => r.error);
  record(
    'screens: every cloud screen loads for the approved account',
    broken.length === 0 ? 'PASS' : 'FAIL',
    broken.length ? broken.map(r => `${r.screen}(${r.error})`).join(', ') : `${rows.length}/${rows.length} rendered`,
  );

  const direct = rows.filter(r => r.masterDirect.length);
  record(
    'screens: no cloud screen reads public.erp_master_records directly',
    direct.length === 0 ? 'PASS' : 'FAIL',
    direct.length ? direct.map(r => `${r.screen}:${r.masterDirect.join(',')}`).join(' | ') : 'none',
  );

  // Screens whose pickers must come from core.* through the allowlisted bridge.
  const MASTER_SCREENS = ['items', 'customers', 'suppliers', 'warehouses', 'sales', 'inventory'];
  const noCore = rows.filter(r => MASTER_SCREENS.includes(r.screen) && !r.coreBridge && !r.error);
  record(
    'screens: master pickers go through erp_core_master_read',
    noCore.length === 0 ? 'PASS' : 'FAIL',
    noCore.length
      ? `no bridge on: ${noCore.map(r => r.screen).join(', ')}`
      : `${MASTER_SCREENS.join(', ')} all use the core bridge`,
  );

  const writeScreens = rows
    .filter(r => r.writeUi.length)
    .map(r => `${r.screen} → ${r.writeUi.join(' / ')}`);
  record(
    'screens: screens exposing a write form',
    writeScreens.length >= 3 ? 'PASS' : 'FAIL',
    writeScreens.join(' | ') || 'none',
  );  await browser.close();
  finish('screens');
}

async function cmdReport() {
  const files = readdirSync(SHOTS).filter(f => /^results-.*\.json$/.test(f));
  const all = [];
  for (const f of files.sort()) {
    const cmd = /results-(.+)\.json/.exec(f)[1];
    for (const r of JSON.parse(readFileSync(path.join(SHOTS, f), 'utf8'))) all.push({ ...r, cmd });
  }
  const lines = [
    '# SnakDip ERP Cloud TEST — browser QA report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '| # | Area | Check | Result | Evidence |',
    '|---|------|-------|--------|----------|',
  ];
  all.forEach((r, i) => {
    const ev = String(r.detail || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 220);
    lines.push(`| ${i + 1} | ${r.cmd} | ${r.name} | ${r.status} | ${ev} |`);
  });
  const pass = all.filter(r => r.status === 'PASS').length;
  const fail = all.filter(r => r.status === 'FAIL').length;
  const blocked = all.filter(r => r.status === 'BLOCKED').length;
  lines.push('', `**Totals:** PASS ${pass} · FAIL ${fail} · BLOCKED ${blocked} · total ${all.length}`, '');
  const cls = path.join(SHOTS, 'screen-classification.json');
  if (existsSync(cls)) {
    lines.push('## Screen classification', '', '| Screen | Classification | Write form (submit label) | Read RPCs observed |', '|---|---|---|---|');
    for (const r of JSON.parse(readFileSync(cls, 'utf8'))) {
      lines.push(`| ${r.screen} | ${r.classification} | ${(r.writeUi || []).join(' / ') || '—'} | ${(r.reads || []).map(x => x.replace('rpc/', '')).join(', ') || '—'} |`);
    }
    lines.push('');
  }
  writeFileSync(path.join(SHOTS, 'REPORT.md'), lines.join('\n'));
  console.log(lines.join('\n'));
  console.log(`\nWrote qa/browser/REPORT.md (PASS ${pass} · FAIL ${fail} · BLOCKED ${blocked})`);
  process.exit(fail > 0 ? 1 : 0);
}

/* ---------------------------------------------------------------- dispatch */

const CMD = process.argv[2] || 'cloud';
const COMMANDS = {
  preview: cmdPreview,
  baseline: cmdBaseline,
  login: cmdLogin,
  sales: cmdSales,
  transfer: cmdTransfer,
  reject: cmdReject,
  screens: cmdScreens,
  report: cmdReport,
};

const SEQUENCE = ['preview', 'baseline', 'login', 'sales', 'transfer', 'reject', 'screens'];

async function run(cmd) {
  CURRENT.cmd = cmd;
  console.log(`\n=== ${cmd} ===`);
  try {
    await COMMANDS[cmd]();
  } catch (e) {
    record(`${cmd}: command completed`, 'FAIL', String(e.message).split('\n')[0]);
    writeResults(cmd);
  }
}

if (CMD === 'cloud') {
  SEQ = true;
  for (const c of SEQUENCE) await run(c);
  CURRENT.cmd = 'cloud';
  console.log('\nRun `node scripts/qa_supabase_browser.mjs report` to build the merged report.');
  process.exit(0);
}

const fn = COMMANDS[CMD];
if (!fn) {
  console.error(`Unknown command "${CMD}". Use one of: ${Object.keys(COMMANDS).join(', ')}, cloud`);
  process.exit(2);
}
CURRENT.cmd = CMD;
await fn();
