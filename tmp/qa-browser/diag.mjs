// Focused diagnostic for the three screens that never sign in.
// Prints console + pageerror messages + body text length; takes one screenshot each.
import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const ROOT = '/home/daytona/codebase';
const require_ = createRequire('/home/daytona/codebase/tmp/qa-browser/package.json');
let chromium;
({ chromium } = require_('playwright-core'));

const base = 'http://localhost:3000';
const shots = path.join(ROOT, 'qa', 'browser', 'diag');
mkdirSync(shots, { recursive: true });

async function run() {
  const exe = process.env.QA_CHROMIUM_PATH || process.env.CHROME_PATH || null;
  const home = process.env.HOME || '/home/daytona';
  const basePath = path.join(home, '.cache', 'ms-playwright');
  if (!exe && require('fs').existsSync(basePath)) {
    for (const d of require('fs').readdirSync(basePath).filter(x => x.startsWith('chromium-'))) {
      for (const r of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const p = path.join(basePath, d, r);
        if (require('fs').existsSync(p)) { exe = p; break; }
      }
    }
  }
  if (!exe) throw new Error('no chromium');
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'ar-EG' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  for (const screen of ['quality', 'costing', 'audit']) {
    errors.length = 0;
    try {
      await page.goto(`${base}/?cloud=1&screen=${screen}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      const body = await page.evaluate(() => { try { return document.body.innerText } catch { return '' } }).catch(() => '<unavailable>');
      const emails = await page.evaluate(() => [...document.querySelectorAll('input[type="email"]')].map(e => e.value)).catch(() => []);
      const pwInputs = await page.evaluate(() => document.querySelectorAll('input[type="password"]').length).catch(() => 0);
      const session = await page.evaluate(() => document.body.innerText.includes('الجلسة:')).catch(() => false);
      await page.screenshot({ path: path.join(shots, `${screen}.png`), fullPage: false }).catch(() => {});
      console.log(`\n== ${screen} ==`);
      console.log(` bodyLen=${body.length} sessionBar=${session} emailInputs=${emails.length} pwInputs=${pwInputs}`);
      if (errors.length) errors.forEach(e => console.log(`   ${e}`));
      console.log(` head: ${String(body).slice(0, 280).replace(/\n/g, ' | ')}`);
    } catch (e) {
      await page.screenshot({ path: path.join(shots, `${screen}.png`), fullPage: false }).catch(() => {});
      console.log(`\n== ${screen} == ERROR: ${e.message}`);
    }
  }
  await browser.close();
}
run().catch(e => { console.error(e.message); process.exit(1); });
