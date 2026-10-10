// ISOLATED UAT HARNESS — Phase 3C: MASTER DATA through the real UI.
// Customers, suppliers, items, representatives, users/permissions, settings,
// and the standard conversion cost rates — creation, validation, duplicates,
// search/filter, edit and persistence checks (verified against the isolated DB).
import { launchIsolated, login, gotoTab, shot, Results, BASE_URL, openCreate, fillFields, readDb, captureDialogs } from './lib.mjs';

const R = new Results('04_master_data');
const dialogs = [];
let dialogAction = 'dismiss';

const { browser, page } = await launchIsolated();
captureDialogs(page, dialogs, { action: () => dialogAction });
page.on('console', (m) => { if (m.type() === 'error') R.consoleErrors.push(m.text()); });
page.on('pageerror', (e) => R.pageErrors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await login(page);

const modalText = async (m) => (await m.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
const countCustomers = async () => (await readDb(page)).customers.length;

// ------------------------------------------------------------ CUSTOMERS
{
  const before = await countCustomers();

  // C01 valid create
  const m = await openCreate(page, 'customers', 'إضافة عميل جديد');
  await fillFields(m, [
    { i: 0, value: 'CUST-UAT-01' },
    { i: 2, value: 'عميل اختبار UAT' },
    { i: 4, value: '50000' },
  ]);
  await m.locator('button', { hasText: 'حفظ العميل' }).click();
  await page.waitForTimeout(700);
  const after = await countCustomers();
  const db = await readDb(page);
  const created = db.customers.find(c => c.code === 'CUST-UAT-01');
  const uiHas = (await page.locator('main').innerText()).includes('عميل اختبار UAT');
  R.add({
    id: 'MD-CUST-01',
    name: 'Customer created through the UI persists and appears in the list',
    status: (created && uiHas && after === before + 1) ? 'PASS' : 'FAIL',
    detail: `count ${before}→${after}; persisted=${!!created}; visibleInList=${uiHas}`,
  });

  // C02 blank required name (label carries *)
  const m2 = await openCreate(page, 'customers', 'إضافة عميل جديد');
  await fillFields(m2, [{ i: 0, value: 'CUST-UAT-02' }]);
  const d0 = dialogs.length;
  await m2.locator('button', { hasText: 'حفظ العميل' }).click();
  await page.waitForTimeout(700);
  const after2 = await countCustomers();
  const modalStill = await m2.isVisible().catch(() => false);
  const msg = dialogs.slice(d0).map(d => d.message).join(' | ');
  const inline = await m2.innerText().catch(() => '');
  const blocked = after2 === before + 1 && (modalStill || /اسم العميل|مطلوب|أدخل|يجب/.test(msg + inline));
  R.add({
    id: 'MD-CUST-02',
    name: 'Blank customer name is rejected (required field)',
    status: blocked ? 'PASS' : 'FAIL',
    detail: `createdAnyway=${after2 > before + 1}; modalStillOpen=${modalStill}; dialog=${msg.slice(0, 120)}`,
  });
  if (blocked) { await m2.locator('button', { hasText: 'إلغاء' }).click().catch(() => {}); await page.waitForTimeout(300); }

  // C03 duplicate customer code
  const before3 = await countCustomers();
  const m3 = await openCreate(page, 'customers', 'إضافة عميل جديد');
  await fillFields(m3, [{ i: 0, value: 'CUST-UAT-01' }, { i: 2, value: 'عميل مكرر UAT' }]);
  const d1 = dialogs.length;
  await m3.locator('button', { hasText: 'حفظ العميل' }).click();
  await page.waitForTimeout(700);
  const after3 = await countCustomers();
  const msg3 = dialogs.slice(d1).map(d => d.message).join(' | ');
  const dupBlocked = after3 === before3;
  R.add({
    id: 'MD-CUST-03',
    name: 'Duplicate customer code is rejected',
    status: dupBlocked ? 'PASS' : 'FAIL',
    detail: `count ${before3}→${after3}; dialog=${msg3.slice(0, 150)}`,
  });
  if (!dupBlocked) { await m3.locator('button', { hasText: 'إلغاء' }).click().catch(() => {}); await page.waitForTimeout(300); }

  // C04 negative credit limit
  const before4 = await countCustomers();
  const m4 = await openCreate(page, 'customers', 'إضافة عميل جديد');
  await fillFields(m4, [{ i: 0, value: 'CUST-UAT-04' }, { i: 2, value: 'عميل رصيد سالب' }, { i: 4, value: '-5000' }]);
  const d2 = dialogs.length;
  await m4.locator('button', { hasText: 'حفظ العميل' }).click();
  await page.waitForTimeout(700);
  const after4 = await countCustomers();
  const msg4 = dialogs.slice(d2).map(d => d.message).join(' | ');
  const db4 = await readDb(page);
  const neg = db4.customers.find(c => c.code === 'CUST-UAT-04');
  R.add({
    id: 'MD-CUST-04',
    name: 'Negative credit limit is rejected',
    status: after4 === before4 ? 'PASS' : 'FAIL',
    detail: `count ${before4}→${after4}; storedCreditLimit=${neg?.creditLimit}; dialog=${msg4.slice(0, 120)}`,
  });
  // Always close the create modal. With MD-CUST-04 fixed, C04 PASSES with the
  // modal still open (the service rejected the save), and the next probes use
  // gotoTab — which has no closeModal step and would be blocked by the backdrop.
  await m4.locator('button', { hasText: 'إلغاء' }).click().catch(() => {});

  // C05 search + empty state
  await gotoTab(page, 'customers');
  const search = page.locator('main input[type="text"]').first();
  await search.fill('CUST-UAT-01');
  await page.waitForTimeout(500);
  const hit = await page.locator('main').innerText();
  await search.fill('zzzz-no-match-xyz');
  await page.waitForTimeout(500);
  const miss = await page.locator('main').innerText();
  R.add({
    id: 'MD-CUST-05',
    name: 'Customer search filters rows and shows an empty state for no match',
    status: (hit.includes('عميل اختبار UAT') && !miss.includes('عميل اختبار UAT')) ? 'PASS' : 'FAIL',
    detail: `match=${hit.includes('عميل اختبار UAT')}; noMatchHidden=${!miss.includes('عميل اختبار UAT')}`,
  });
  await search.fill('');

  // C06 edit the created customer
  await gotoTab(page, 'customers');
  await page.waitForTimeout(300);
  const row = page.locator('main tbody tr', { hasText: 'CUST-UAT-01' }).first();
  const rowButtons = await row.locator('button').allInnerTexts().catch(() => []);
  const editBtn = row.locator('button', { hasText: /تعديل/ }).first();
  let editOk = false;
  if (await editBtn.count()) {
    await editBtn.click();
    await page.waitForTimeout(500);
    const em = page.locator('div.fixed.inset-0').last();
    await fillFields(em, [{ i: 2, value: 'عميل اختبار UAT معدل' }]);
    await em.locator('button', { hasText: /حفظ/ }).last().click();
    await page.waitForTimeout(700);
    const dbE = await readDb(page);
    const c = dbE.customers.find(x => x.code === 'CUST-UAT-01');
    editOk = c && c.name === 'عميل اختبار UAT معدل';
  }
  R.add({ id: 'MD-CUST-06', name: 'Customer edit persists', status: editOk ? 'PASS' : 'FAIL', detail: `rowButtons=${rowButtons.join('/')}` });

  // C07 delete/void support
  const hasDelete = rowButtons.some(t => /حذف|إلغاء|تعطيل|delete/i.test(t));
  R.add({
    id: 'MD-CUST-07',
    name: 'Customer delete/void control',
    status: hasDelete ? 'NOT TESTED' : 'NOT APPLICABLE',
    detail: hasDelete ? 'delete-like control exists — destructive action deliberately not run against shared master data' : `GAP: no delete/void action on customer rows (row actions: ${rowButtons.join('/') || 'none'})`,
  });
}

// ------------------------------------------------------------ SUPPLIERS
{
  const b = await readDb(page);
  const before = b.suppliers.length;
  const m = await openCreate(page, 'suppliers', 'إضافة مورد جديد');
  await fillFields(m, [{ i: 0, value: 'SUP-UAT-01' }, { i: 2, value: 'مورد اختبار UAT' }]);
  await m.locator('button', { hasText: 'حفظ المورد' }).click();
  await page.waitForTimeout(700);
  let db = await readDb(page);
  const ok = db.suppliers.length === before + 1 && db.suppliers.some(s => s.code === 'SUP-UAT-01');
  R.add({ id: 'MD-SUP-01', name: 'Supplier created through the UI persists', status: ok ? 'PASS' : 'FAIL', detail: `count ${before}→${db.suppliers.length}` });

  const before2 = db.suppliers.length;
  const m2 = await openCreate(page, 'suppliers', 'إضافة مورد جديد');
  await fillFields(m2, [{ i: 0, value: 'SUP-UAT-01' }, { i: 2, value: 'مورد مكرر' }]);
  const d0 = dialogs.length;
  await m2.locator('button', { hasText: 'حفظ المورد' }).click();
  await page.waitForTimeout(700);
  db = await readDb(page);
  R.add({
    id: 'MD-SUP-02',
    name: 'Duplicate supplier code is rejected',
    status: db.suppliers.length === before2 ? 'PASS' : 'FAIL',
    detail: `count ${before2}→${db.suppliers.length}; dialog=${dialogs.slice(d0).map(d => d.message).join(' | ').slice(0, 120)}`,
  });
  if (db.suppliers.length !== before2) await m2.locator('button', { hasText: 'إلغاء' }).click().catch(() => {});
}

// ---------------------------------------------------------------- ITEMS
{
  let db = await readDb(page);
  const before = db.items.length;
  const m = await openCreate(page, 'items', 'إضافة صنف / منتج جديد');
  await fillFields(m, [
    { i: 0, value: 'FP-UAT-01' },
    { i: 3, value: 'منتج اختبار UAT' },
    { i: 8, value: '12.5' },
    { i: 10, value: '35' },
  ]);
  await m.locator('button', { hasText: 'حفظ الصنف الجديد' }).click();
  await page.waitForTimeout(800);
  db = await readDb(page);
  const item = db.items.find(i => i.code === 'FP-UAT-01');
  const visible = (await page.locator('main').innerText()).includes('منتج اختبار UAT');
  R.add({
    id: 'MD-ITEM-01',
    name: 'Item created through the UI persists and is listed',
    status: (item && visible && db.items.length === before + 1) ? 'PASS' : 'FAIL',
    detail: `count ${before}→${db.items.length}; visible=${visible}; standardCost=${item?.standardCost}; retail=${item?.sellingPrice}`,
  });

  // duplicate code
  const before2 = db.items.length;
  const m2 = await openCreate(page, 'items', 'إضافة صنف / منتج جديد');
  await fillFields(m2, [{ i: 0, value: 'FP-UAT-01' }, { i: 3, value: 'منتج مكرر' }]);
  const d0 = dialogs.length;
  await m2.locator('button', { hasText: 'حفظ الصنف الجديد' }).click();
  await page.waitForTimeout(700);
  db = await readDb(page);
  R.add({
    id: 'MD-ITEM-02',
    name: 'Duplicate item code is rejected',
    status: db.items.length === before2 ? 'PASS' : 'FAIL',
    detail: `count ${before2}→${db.items.length}; dialog=${dialogs.slice(d0).map(d => d.message).join(' | ').slice(0, 140)}`,
  });
  if (db.items.length !== before2) await m2.locator('button', { hasText: 'إلغاء' }).click().catch(() => {});

  // blank Arabic name (required *)
  const before3 = db.items.length;
  const m3 = await openCreate(page, 'items', 'إضافة صنف / منتج جديد');
  await fillFields(m3, [{ i: 0, value: 'FP-UAT-02' }]);
  await m3.locator('button', { hasText: 'حفظ الصنف الجديد' }).click();
  await page.waitForTimeout(700);
  db = await readDb(page);
  R.add({ id: 'MD-ITEM-03', name: 'Blank Arabic item name is rejected', status: db.items.length === before3 ? 'PASS' : 'FAIL', detail: `count ${before3}→${db.items.length}` });
  if (db.items.length !== before3) await m3.locator('button', { hasText: 'إلغاء' }).click().catch(() => {});

  // type filter
  await gotoTab(page, 'items');
  const typeSel = page.locator('main select').first();
  await typeSel.selectOption({ label: 'المواد الخام فقط' }).catch(() => {});
  await page.waitForTimeout(500);
  const rawRows = await page.locator('main tbody tr').count();
  await typeSel.selectOption({ index: 0 }).catch(() => {});
  await page.waitForTimeout(400);
  const allRows = await page.locator('main tbody tr').count();
  R.add({ id: 'MD-ITEM-04', name: 'Item type filter narrows the list', status: (rawRows > 0 && allRows > rawRows) ? 'PASS' : 'WARN', detail: `rawRows=${rawRows}; allRows=${allRows}` });

  // disable (deactivate) the test item we own — cancel first, then confirm
  await gotoTab(page, 'items');
  const search = page.locator('main input[type="text"]').first();
  await search.fill('FP-UAT-01');
  await page.waitForTimeout(500);
  const row = page.locator('main tbody tr', { hasText: 'FP-UAT-01' }).first();
  // The toggle is an icon-only button whose label lives in `title`, not in its
  // text content, so hasText could never match (MD-ITEM-05/06 reported FAIL/NOT
  // TESTED for the harness, not the app). Locate it by its title attribute.
  const disableBtn = row.locator('button[title="تعطيل الصنف"]').first();
  const hasDisable = (await disableBtn.count()) > 0;
  let cancelKeptActive = false, confirmDeactivated = false, dialogSeen = '';
  if (hasDisable) {
    // cancel path
    const d1 = dialogs.length;
    await disableBtn.click();
    await page.waitForTimeout(500);
    dialogSeen = dialogs.slice(d1).map(d => `${d.type}:${d.message}`).join(' | ');
    const stillActive = (await readDb(page)).items.find(i => i.code === 'FP-UAT-01')?.active;
    cancelKeptActive = stillActive !== false;
    // confirm path (our own test record)
    if (dialogSeen) {
      const d2 = dialogs.length;
      await row.locator('button[title="تعطيل الصنف"]').first().click();
      await page.waitForTimeout(500);
      // re-open and accept if a confirm() was auto-dismissed: captureDialogs dismisses,
      // so emulate the accept path explicitly
      const dismissed = dialogs.slice(d2).length;
      confirmDeactivated = dismissed > 0; // dialog offered — acceptance path verified below
    }
  }
  R.add({
    id: 'MD-ITEM-05',
    name: 'Deactivate item asks for confirmation (no silent destructive action)',
    status: hasDisable ? (dialogSeen || confirmDeactivated ? 'PASS' : 'WARN') : 'FAIL',
    detail: `dialog=${dialogSeen.slice(0, 160)}; cancelKeptActive=${cancelKeptActive}`,
  });

  // explicit confirm path with an accepting dialog handler
  let afterConfirm = null;
  if (dialogSeen) {
    dialogAction = 'accept';
    await row.locator('button[title="تعطيل الصنف"]').first().click().catch(() => {});
    await page.waitForTimeout(600);
    afterConfirm = (await readDb(page)).items.find(i => i.code === 'FP-UAT-01')?.active;
    dialogAction = 'dismiss';
  }
  R.add({
    id: 'MD-ITEM-06',
    name: 'Confirming deactivate flips the item to inactive',
    status: afterConfirm === false ? 'PASS' : (afterConfirm === true ? 'FAIL' : 'NOT TESTED'),
    detail: `active=${afterConfirm}`,
  });
  // restore our test item to active so later suites can use it
  if (afterConfirm === false) {
    dialogAction = 'accept';
    await row.locator('button[title="إعادة تنشيط الصنف"]').first().click().catch(() => {});
    await page.waitForTimeout(500);
    dialogAction = 'dismiss';
  }
}

// ----------------------------------------------------- REPRESENTATIVES
{
  let db = await readDb(page);
  const before = db.salesReps.length;
  const m = await openCreate(page, 'representatives', 'مندوب جديد');
  await fillFields(m, [{ i: 0, value: 'REP-UAT-01' }, { i: 2, value: 'مندوب اختبار UAT' }]);
  await m.locator('button', { hasText: 'تسجيل المندوب' }).click();
  await page.waitForTimeout(700);
  db = await readDb(page);
  const rep = db.salesReps.find(r => r.code === 'REP-UAT-01');
  R.add({
    id: 'MD-REP-01',
    name: 'Representative created through the UI persists',
    status: (rep && db.salesReps.length === before + 1) ? 'PASS' : 'FAIL',
    detail: `count ${before}→${db.salesReps.length}`,
  });

  // open a custody for that rep
  const beforeC = (await readDb(page)).representativeCustodies.length;
  const m2 = await openCreate(page, 'representatives', 'فتح عهدة مندوب جديدة');
  const repSelect = m2.locator('select').first();
  const opts = await repSelect.locator('option').allInnerTexts().catch(() => []);
  await repSelect.selectOption({ label: opts.find(o => o.includes('مندوب اختبار UAT')) || opts[0] }).catch(() => {});
  await m2.locator('button', { hasText: 'فتح العهدة' }).click();
  await page.waitForTimeout(700);
  db = await readDb(page);
  const custodyCreated = db.representativeCustodies.length === beforeC + 1;
  R.add({
    id: 'MD-REP-02',
    name: 'Custody opened for the new representative',
    status: custodyCreated ? 'PASS' : 'FAIL',
    detail: `custodies ${beforeC}→${db.representativeCustodies.length}; options=${opts.join('/')}`,
  });
}

// ------------------------------------------------------- USERS & RBAC
{
  let db = await readDb(page);
  const before = db.users.length;
  const m = await openCreate(page, 'users', 'إضافة مستخدم جديد');
  await fillFields(m, [
    { i: 0, value: 'موظف اختبار UAT' },
    { i: 1, value: 'uat_user' },
    { i: 2, value: 'uatpass123' },
    { i: 3, value: 'uat@snakdip.test' },
  ]);
  const roleSel = m.locator('select').last();
  await roleSel.selectOption({ label: 'Warehouse Manager' }).catch(() => {});
  const d0 = dialogs.length;
  await m.locator('button', { hasText: 'إنشاء المستخدم' }).click();
  await page.waitForTimeout(700);
  db = await readDb(page);
  const u = db.users.find(x => x.username === 'uat_user');
  R.add({
    id: 'MD-USER-01',
    name: 'User created through the UI persists with the chosen role',
    status: (u && db.users.length === before + 1) ? 'PASS' : 'FAIL',
    detail: `count ${before}→${db.users.length}; role=${u?.role}; dialog=${dialogs.slice(d0).map(d => d.message).join(' | ').slice(0, 120)}`,
  });

  // duplicate username
  const before2 = db.users.length;
  const m2 = await openCreate(page, 'users', 'إضافة مستخدم جديد');
  await fillFields(m2, [{ i: 0, value: 'نسخة' }, { i: 1, value: 'uat_user' }, { i: 2, value: 'anotherpass1' }]);
  const d1 = dialogs.length;
  await m2.locator('button', { hasText: 'إنشاء المستخدم' }).click();
  await page.waitForTimeout(700);
  db = await readDb(page);
  R.add({
    id: 'MD-USER-02',
    name: 'Duplicate username is rejected',
    status: db.users.length === before2 ? 'PASS' : 'FAIL',
    detail: `count ${before2}→${db.users.length}; dialog=${dialogs.slice(d1).map(d => d.message).join(' | ').slice(0, 140)}`,
  });
  if (db.users.length !== before2) await m2.locator('button', { hasText: 'إلغاء' }).click().catch(() => {});

  // short password
  const before3 = db.users.length;
  const m3 = await openCreate(page, 'users', 'إضافة مستخدم جديد');
  await fillFields(m3, [{ i: 0, value: 'قصير' }, { i: 1, value: 'uat_short' }, { i: 2, value: '123' }]);
  const d2 = dialogs.length;
  await m3.locator('button', { hasText: 'إنشاء المستخدم' }).click();
  await page.waitForTimeout(700);
  db = await readDb(page);
  R.add({
    id: 'MD-USER-03',
    name: 'Password shorter than 6 characters is rejected',
    status: db.users.length === before3 ? 'PASS' : 'FAIL',
    detail: `count ${before3}→${db.users.length}; dialog=${dialogs.slice(d2).map(d => d.message).join(' | ').slice(0, 140)}`,
  });
  if (db.users.length !== before3) await m3.locator('button', { hasText: 'إلغاء' }).click().catch(() => {});
}

// ---------------------------------------------------- PERMISSIONS MATRIX
{
  await gotoTab(page, 'users');
  await page.waitForTimeout(400);
  const sel = page.locator('main select').first();
  const opts = await sel.locator('option').allInnerTexts().catch(() => []);
  const target = opts.find(o => o.includes('موظف اختبار UAT'));
  let permSaved = false;
  if (target) {
    await sel.selectOption({ label: target });
    await page.waitForTimeout(500);
    const checkboxes = page.locator('main input[type="checkbox"]');
    const n = await checkboxes.count();
    if (n > 0) {
      await checkboxes.first().click({ force: true });
      await page.waitForTimeout(300);
      const saveBtn = page.locator('main button', { hasText: /^حفظ$/ }).first();
      if (await saveBtn.count()) { await saveBtn.click({ force: true }); await page.waitForTimeout(600); }
      const db = await readDb(page);
      const uu = db.users.find(x => x.username === 'uat_user');
      permSaved = !!(uu && uu.permissions && Object.keys(uu.permissions).length > 0);
      R.add({
        id: 'MD-USER-04',
        name: 'Permission matrix save persists per-user permissions',
        status: permSaved ? 'PASS' : 'WARN',
        detail: `checkboxes=${n}; user.permissions=${JSON.stringify(uu?.permissions || {}).slice(0, 200)}`,
      });
    } else {
      R.add({ id: 'MD-USER-04', name: 'Permission matrix save persists per-user permissions', status: 'NOT TESTED', detail: 'no checkboxes rendered after selecting the user' });
    }
  } else {
    R.add({ id: 'MD-USER-04', name: 'Permission matrix save persists per-user permissions', status: 'NOT TESTED', detail: `user not selectable; options=${opts.join('/')}` });
  }
}

// -------------------------------------------- SETTINGS & STANDARD RATES
{
  await gotoTab(page, 'settings');
  const tabs = ['بيانات الشركة والعملات', 'المستودعات الخمسة المعتمدة', 'ربط وتوجيه الحسابات (Account Mappings)', 'إدارة بيانات الاختبار والنسخ الاحتياطي'];
  const found = [];
  for (const t of tabs) {
    const b = page.locator('main button', { hasText: t }).first();
    if (await b.count()) {
      await b.click();
      await page.waitForTimeout(500);
      const txt = await page.locator('main').innerText();
      found.push(`${t}:${txt.length}`);
      if (t.startsWith('بيانات الشركة')) {
        R.add({ id: 'MD-SET-02', name: 'Company data tab shows base/export currency and exchange rate', status: /EGP/.test(txt) && /48\.5/.test(txt) ? 'PASS' : 'WARN', detail: txt.replace(/\s+/g, ' ').slice(0, 220) });
      }
      if (t.startsWith('المستودعات')) {
        const wh = ['WH-01', 'WH-02', 'WH-03', 'WH-04', 'WH-05'].filter(w => txt.includes(w));
        R.add({ id: 'MD-SET-03', name: 'All five warehouses are configured and displayed', status: wh.length === 5 ? 'PASS' : 'FAIL', detail: `found=${wh.join(',')}` });
      }
      if (t.startsWith('ربط')) {
        R.add({ id: 'MD-SET-04', name: 'Account mappings tab renders mapping keys → accounts', status: txt.length > 300 ? 'PASS' : 'WARN', detail: `${txt.length} chars` });
      }
    }
  }
  R.add({ id: 'MD-SET-01', name: 'Settings sub-tabs reachable', status: found.length === 4 ? 'PASS' : 'WARN', detail: found.join(' | ') });

  // standard conversion cost rates (read-only verification)
  await gotoTab(page, 'costing');
  await page.waitForTimeout(500);
  const costText = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  const expectations = [
    ['250', 'labor'], ['100', 'electricity'], ['5', 'gas'], ['50', 'maintenance'], ['30', 'supervision'],
  ];
  const missing = expectations.filter(([v]) => !new RegExp(`\\b${v}\\b`).test(costText)).map(e => e[1]);
  R.add({
    id: 'MD-COST-01',
    name: 'Standard conversion rates shown: labor 250, electricity 100, gas 5, maintenance 50, supervision 30 (per 1000 cartons)',
    status: missing.length === 0 ? 'PASS' : 'FAIL',
    detail: `missing=${missing.join(',') || 'none'}; excerpt=${costText.slice(0, 400)}`,
  });

  const db = await readDb(page);
  const rates = (db.standardCostRates || []).map(r => `${r.rateType || r.type}:${r.rate ?? r.value}/qty${r.baseQuantity ?? r.quantity ?? '?'}`);
  R.add({
    id: 'MD-COST-02',
    name: 'Standard rates are stored as editable configuration (not hardcoded)',
    status: (db.standardCostRates || []).length > 0 ? 'PASS' : 'FAIL',
    detail: `count=${(db.standardCostRates || []).length}; ${rates.join('; ')}`,
  });
}

// ------------------------------------------------- USERS CAN SIGN IN
{
  await page.locator('button[title="تسجيل الخروج"]').first().click();
  await page.waitForTimeout(600);
  let ok = false, detail = '';
  try {
    await login(page, 'uat_user', 'uatpass123');
    ok = true;
    const tabs = await page.locator('button.nav-item').count();
    detail = `sidebarTabs=${tabs}`;
    R.add({ id: 'MD-USER-05', name: 'Newly created user can sign in', status: ok ? 'PASS' : 'FAIL', detail });
    R.add({ id: 'MD-USER-06', name: 'New user sees only its role modules', status: tabs === 6 ? 'PASS' : 'FAIL', detail: `${tabs} tabs (expected 6 for Warehouse Manager)` });
  } catch (e) {
    R.add({ id: 'MD-USER-05', name: 'Newly created user can sign in', status: 'FAIL', detail: String(e).slice(0, 200) });
  }
  await shot(page, '04_new_user');
}

R.add({
  id: 'MD-CONSOLE',
  name: 'No console/page errors during master-data testing',
  status: (R.consoleErrors.length + R.pageErrors.length) === 0 ? 'PASS' : 'FAIL',
  detail: JSON.stringify([...R.pageErrors, ...R.consoleErrors].slice(0, 8)),
});
R.add({ id: 'MD-DIALOGS', name: 'Native dialogs observed (validation/confirm messages)', status: 'PASS', detail: JSON.stringify(dialogs.map(d => `${d.type}:${d.message.slice(0, 80)}`)).slice(0, 600) });

console.log('\n=== SUMMARY ===', JSON.stringify(R.summary()));
R.save();
await browser.close();
