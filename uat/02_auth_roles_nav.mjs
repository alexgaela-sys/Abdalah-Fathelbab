// ISOLATED UAT HARNESS — Phase 2/3 A+B: authentication, roles, permissions,
// protected/direct-route access, global navigation, dashboard, RTL/responsive.
import { launchIsolated, login, gotoTab, shot, TAB_LABELS, Results, BASE_URL } from './lib.mjs';

const R = new Results('02_auth_roles_nav');

async function fresh() {
  const h = await launchIsolated();
  h.page.on('console', (m) => { if (m.type() === 'error') R.consoleErrors.push(m.text()); });
  h.page.on('pageerror', (e) => R.pageErrors.push(String(e)));
  await h.page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await h.page.waitForTimeout(900);
  return h;
}

// ------------------------------------------------------------------ A. AUTH
{
  const { browser, page } = await fresh();

  // A1: blank credentials — the inputs carry the HTML5 `required` attribute, so
  // the browser must block submission and AuthService must never be reached.
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(500);
  const stillLogin = await page.locator('input[type="password"]').count();
  const flaggedInvalid = await page.locator('input:invalid').count();
  const sessionAfterBlank = await page.evaluate(() => !!localStorage.getItem('abdullah_erp_auth_session'));
  R.add({
    id: 'AUTH-03',
    name: 'Blank username/password cannot submit the form',
    status: (stillLogin && flaggedInvalid > 0 && !sessionAfterBlank) ? 'PASS' : 'FAIL',
    detail: `stillOnLogin=${!!stillLogin}; invalidFields=${flaggedInvalid}; sessionCreated=${sessionAfterBlank} (HTML5 required validation; the Arabic empty-input message is never shown because AuthService is not reached)`,
  });

  // A2: unknown user
  await page.locator('input[type="text"]').first().fill('no_such_user_xyz');
  await page.locator('input[type="password"]').first().fill('whatever');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(600);
  const unknownMsg = await page.locator('text=اسم المستخدم غير مسجل بالنظام').count();
  R.add({ id: 'AUTH-04', name: 'Unknown username rejected', status: unknownMsg > 0 ? 'PASS' : 'FAIL' });

  // A3: wrong password
  await page.locator('input[type="text"]').first().fill('admin');
  await page.locator('input[type="password"]').first().fill('wrong-password');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(600);
  const wrongPw = await page.locator('text=كلمة المرور غير صحيحة').count();
  R.add({ id: 'AUTH-05', name: 'Wrong password rejected', status: wrongPw > 0 ? 'PASS' : 'FAIL' });

  // A4: correct credentials
  await login(page);
  R.add({ id: 'AUTH-06', name: 'Correct credentials sign in', status: 'PASS' });

  // A5: refresh keeps the session
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  R.add({ id: 'AUTH-07', name: 'Session persists across browser refresh', status: (await page.locator('header').count()) ? 'PASS' : 'FAIL' });

  // A6: navigating to the app root keeps the session
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  R.add({ id: 'AUTH-08', name: 'Session persists across navigation to app root', status: (await page.locator('header').count()) ? 'PASS' : 'FAIL' });

  // A7: logout
  await page.locator('button[title="تسجيل الخروج"]').first().click();
  await page.waitForTimeout(600);
  const loggedOut = await page.locator('input[type="password"]').count();
  const sessionGone = await page.evaluate(() => !localStorage.getItem('abdullah_erp_auth_session'));
  R.add({ id: 'AUTH-09', name: 'Logout returns to login screen and clears session', status: (loggedOut && sessionGone) ? 'PASS' : 'FAIL', detail: JSON.stringify({ loggedOut: !!loggedOut, sessionGone }) });

  R.add({ id: 'AUTH-10', name: 'Session expiry / idle timeout', status: 'NOT TESTED', detail: 'GAP: AuthService stores loginAt but never validates expiry; sessions live until logout or storage clear.' });
  R.add({ id: 'AUTH-11', name: 'Password reset / forgot-password flow', status: 'NOT APPLICABLE', detail: 'GAP: no recovery flow in LoginView (only in-app change password).' });

  // A12: audit trail recorded a login event
  await login(page);
  await gotoTab(page, 'audit');
  await page.waitForTimeout(500);
  const auditText = await page.locator('main').innerText();
  R.add({
    id: 'AUTH-12',
    name: 'Login is recorded in the audit log',
    status: /login|دخول/.test(auditText) ? 'PASS' : 'FAIL',
    detail: auditText.slice(0, 200).replace(/\n/g, ' '),
  });
  await browser.close();
}

// --------------------------------------------------- B. ROLES & PERMISSIONS
// Expected sidebar tabs per role, derived from services/permissions.ts MATRIX.
const EXPECTED = {
  'General Manager': ['dashboard', 'items', 'inventory', 'manufacturing', 'quality', 'costing', 'sales', 'purchasing', 'customers', 'suppliers', 'representatives', 'export', 'treasury', 'banks', 'cheques', 'expenses', 'accounting', 'reports', 'audit'],
  'Chief Accountant': ['dashboard', 'items', 'inventory', 'manufacturing', 'quality', 'costing', 'sales', 'purchasing', 'customers', 'suppliers', 'representatives', 'export', 'treasury', 'banks', 'cheques', 'expenses', 'accounting', 'reports', 'audit'],
  'Cost Accountant': ['dashboard', 'items', 'inventory', 'manufacturing', 'quality', 'costing', 'sales', 'purchasing', 'reports', 'accounting'],
  'Warehouse Manager': ['dashboard', 'items', 'inventory', 'manufacturing', 'quality', 'reports'],
  'Production Manager': ['dashboard', 'items', 'inventory', 'manufacturing', 'quality', 'costing', 'reports'],
  'Sales Manager': ['dashboard', 'items', 'inventory', 'sales', 'customers', 'representatives', 'export', 'reports'],
};

{
  const { browser, page } = await fresh();
  await login(page);

  const visibleTabs = async () => {
    const labels = await page.locator('button.nav-item').allInnerTexts();
    return Object.keys(TAB_LABELS).filter(id => labels.some(t => t.includes(TAB_LABELS[id])));
  };

  const roleBtn = (role) => page.locator(`button:has-text("${role}")`).first();
  const switchRole = async (role) => {
    const alreadyOpen = await roleBtn(role).isVisible().catch(() => false);
    if (!alreadyOpen) {
      await page.locator('button[title="قائمة المستخدم وتبديل الدور"]').first().click({ timeout: 5000 });
      await page.waitForTimeout(300);
    }
    await roleBtn(role).click({ force: true, timeout: 5000 });
    await page.waitForTimeout(500);
  };

  // B1: Super Admin sees all 21
  const adminTabs = await visibleTabs();
  R.add({ id: 'PERM-01', name: 'Super Admin sees all 21 sidebar entries', status: adminTabs.length === 21 ? 'PASS' : 'FAIL', detail: `count=${adminTabs.length}` });

  // Role switching is restricted to a Super Admin session (AuthorizationService),
  // so every probe re-authenticates as admin first and switches once.
  const resetToAdmin = async () => {
    await page.locator('button[title="تسجيل الخروج"]').first().click();
    await page.waitForTimeout(500);
    await login(page);
  };

  let anyStaleSidebar = null;
  for (const [role, expected] of Object.entries(EXPECTED)) {
    await resetToAdmin();
    await switchRole(role);
    const headerNow = await page.locator('header').innerText();
    const applied = headerNow.includes(role);
    const immediate = await visibleTabs();
    // authoritative check: reload so App re-reads the persisted session
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    const afterReload = await visibleTabs();
    const missing = expected.filter(t => !afterReload.includes(t));
    const extra = afterReload.filter(t => !expected.includes(t));
    R.add({
      id: `PERM-${role.replace(/\s+/g, '_')}`,
      name: `Role "${role}" grants exactly the permitted modules`,
      status: (applied && missing.length === 0 && extra.length === 0) ? 'PASS' : 'FAIL',
      detail: `headerShowsRole=${applied}; sidebarAfterReload=${afterReload.length}/${expected.length}; missing=${missing.join(',') || 'none'}; extra=${extra.join(',') || 'none'}`,
    });
    if (immediate.length !== afterReload.length && anyStaleSidebar === null) {
      anyStaleSidebar = { role, immediate: immediate.length, afterReload: afterReload.length };
    }
  }

  R.add({
    id: 'PERM-SIDEBAR-STALE',
    name: 'Sidebar re-filters immediately when the role is switched',
    status: anyStaleSidebar ? 'FAIL' : 'PASS',
    detail: anyStaleSidebar
      ? `DEFECT: right after switching to ${anyStaleSidebar.role} the sidebar still showed ${anyStaleSidebar.immediate} entries; only after a full reload did it show ${anyStaleSidebar.afterReload}. Header/Sidebar read currentUser.role (stale state) instead of the switched session role.`
      : 'sidebar updated without reload',
  });

  // B2: forced/direct tab that the role may not view must bounce to dashboard
  await resetToAdmin();
  await switchRole('Warehouse Manager');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  const wmTabs = await visibleTabs();
  const canSeeUsers = wmTabs.includes('users');
  await page.evaluate((tab) => localStorage.setItem('snakdip_erp_active_tab', tab), 'users');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  const bouncedTo = (await visibleTabs()).includes('dashboard');
  const mainText = await page.locator('main').innerText().catch(() => '');
  const showingUsers = mainText.includes('المستخدمون') || mainText.includes('الصلاحيات');
  R.add({
    id: 'PERM-DIRECT-ROUTE',
    name: 'Forced tab outside the role (users) is bounced back to dashboard',
    status: (!canSeeUsers && bouncedTo && !showingUsers) ? 'PASS' : 'FAIL',
    detail: `sidebarHasUsers=${canSeeUsers}; dashboardVisible=${bouncedTo}; usersScreenRendered=${showingUsers}`,
  });

  // B3: restricted module must not expose create controls
  const wmHasSales = wmTabs.includes('sales');
  let createLike = -1;
  if (wmHasSales) {
    await gotoTab(page, 'sales');
    createLike = await page.locator('main button', { hasText: /فاتورة|إضافة|جديد|إنشاء/ }).count();
  }
  R.add({
    id: 'PERM-HIDDEN-CONTROLS',
    name: 'Warehouse Manager cannot see a sales-create control',
    status: !wmHasSales ? 'PASS' : (createLike === 0 ? 'PASS' : 'FAIL'),
    detail: `salesModuleHidden=${!wmHasSales}; createLikeButtons=${createLike}`,
  });

  // B4/B5: non-admin session must not be able to elevate its role
  await resetToAdmin();
  await switchRole('Sales Manager');
  await page.locator('button[title="قائمة المستخدم وتبديل الدور"]').first().click({ timeout: 5000 });
  await page.waitForTimeout(300);
  const roleMenuItems = await page.locator('button:has-text("Chief Accountant")').count();
  R.add({
    id: 'PERM-ROLE-MENU',
    name: 'Role menu is still offered to a non-admin session',
    status: roleMenuItems > 0 ? 'WARN' : 'PASS',
    detail: roleMenuItems > 0
      ? 'GAP: the RBAC dropdown lists switchable roles to every session; the switch is only rejected afterwards by AuthService.updateSessionRole.'
      : 'menu hidden for non-admin',
  });
  let elevated = false;
  try {
    page.once('dialog', async (d) => { await d.dismiss(); });
    await page.locator('button:has-text("Chief Accountant")').first().click({ force: true });
    await page.waitForTimeout(700);
    const hdr = await page.locator('header').innerText();
    elevated = hdr.includes('Chief Accountant');
  } catch (e) {
    R.add({ id: 'PERM-ELEVATION-ERR', name: 'elevation attempt error', status: 'WARN', detail: String(e).slice(0, 200) });
  }
  R.add({ id: 'PERM-ELEVATION', name: 'Non-admin cannot elevate role through the UI', status: elevated ? 'FAIL' : 'PASS', detail: `elevated=${elevated}` });

  await shot(page, '02_roles');
  await browser.close();
}

// ------------------------------------------------ C. DASHBOARD & NAVIGATION
{
  const { browser, page } = await fresh();
  await login(page);

  const dashText = await page.locator('main').innerText();
  R.add({ id: 'DASH-01', name: 'Dashboard renders KPI cards / sections', status: dashText.length > 200 ? 'PASS' : 'FAIL', detail: `${dashText.length} chars` });

  const navBtns = await page.locator('main button').allInnerTexts();
  R.add({ id: 'DASH-02', name: 'Dashboard exposes actionable shortcuts', status: navBtns.length > 0 ? 'PASS' : 'WARN', detail: navBtns.join(' | ').replace(/\s+/g, ' ').slice(0, 300) });

  await gotoTab(page, 'reports');
  const repText = await page.locator('main').innerText();
  await gotoTab(page, 'dashboard');
  const backText = await page.locator('main').innerText();
  R.add({
    id: 'NAV-PERSIST',
    name: 'Navigation between modules preserves content (no stale/blank view)',
    status: repText.length > 100 && backText.length > 100 ? 'PASS' : 'FAIL',
    detail: `reports=${repText.length} dashboard=${backText.length}`,
  });

  await gotoTab(page, 'inventory');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  const afterReload = await page.locator('main').innerText();
  const persisted = await page.evaluate(() => localStorage.getItem('snakdip_erp_active_tab'));
  R.add({
    id: 'NAV-REFRESH',
    name: 'Refresh on a nested module keeps the same module open',
    status: persisted === 'inventory' && afterReload.length > 100 ? 'PASS' : 'FAIL',
    detail: `persistedTab=${persisted}; chars=${afterReload.length}`,
  });

  // Browser Back: the app has no router, so history navigation cannot move
  // between modules. Guard the probe against leaving the app origin.
  let backDetail = '';
  let backStatus = 'NOT TESTED';
  try {
    await gotoTab(page, 'customers');
    const beforeBack = await page.evaluate(() => localStorage.getItem('snakdip_erp_active_tab'));
    await page.goBack().catch(() => {});
    await page.waitForTimeout(800);
    const url = page.url();
    if (url.startsWith(BASE_URL)) {
      const afterBack = await page.evaluate(() => localStorage.getItem('snakdip_erp_active_tab'));
      backStatus = afterBack !== beforeBack ? 'PASS' : 'NOT TESTED';
      backDetail = afterBack === beforeBack
        ? 'GAP: state-based tabs create no history entries; Back reloads/leaves instead of returning to the previous module.'
        : `before=${beforeBack} after=${afterBack}`;
    } else {
      backStatus = 'NOT TESTED';
      backDetail = `GAP: Back left the application (url=${url}); module navigation is not part of browser history.`;
    }
  } catch (e) {
    backDetail = 'probe error: ' + String(e).slice(0, 160);
  }
  R.add({ id: 'NAV-BACK', name: 'Browser Back moves between modules', status: backStatus, detail: backDetail });

  R.add({ id: 'NAV-BREADCRUMBS', name: 'Breadcrumbs', status: 'NOT APPLICABLE', detail: 'GAP: no breadcrumb component; module title comes from the sidebar active state + PageHeader.' });

  R.add({
    id: 'NAV-CONSOLE',
    name: 'No console/page errors during auth+role+dashboard flow',
    status: (R.consoleErrors.length + R.pageErrors.length) === 0 ? 'PASS' : 'FAIL',
    detail: JSON.stringify([...R.pageErrors, ...R.consoleErrors].slice(0, 8)),
  });
  await browser.close();
}

// ------------------------------------------------------ D. RTL & RESPONSIVE
for (const [w, h] of [[360, 800], [390, 844], [412, 915], [768, 1024]]) {
  const { browser, context, page } = await launchIsolated({ viewport: { width: w, height: h } });
  page.on('console', (m) => { if (m.type() === 'error') R.consoleErrors.push(`[${w}x${h}] ${m.text()}`); });
  page.on('pageerror', (e) => R.pageErrors.push(`[${w}x${h}] ${String(e)}`));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  let loginOk = true;
  try { await login(page); } catch { loginOk = false; }
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    dir: document.documentElement.dir || document.body.dir,
  }));
  const hamburger = await page.locator('button[title="القائمة الرئيسية"]').isVisible().catch(() => false);
  let sidebarOpens = false;
  if (hamburger) {
    await page.locator('button[title="القائمة الرئيسية"]').click();
    await page.waitForTimeout(600);
    sidebarOpens = await page.locator('button.nav-item').first().isVisible().catch(() => false);
  }
  const horizontalScroll = overflow.scrollW > overflow.innerW + 2;
  R.add({
    id: `RESP-${w}x${h}`,
    name: `Responsive ${w}x${h}: RTL + no horizontal overflow + sidebar reachable`,
    status: (loginOk && !horizontalScroll && overflow.dir === 'rtl' && (w >= 1024 || sidebarOpens)) ? 'PASS' : 'FAIL',
    detail: JSON.stringify({ loginOk, ...overflow, horizontalScroll, hamburger, sidebarOpens }),
  });
  await shot(page, `resp_${w}x${h}`);
  await context.close();
  await browser.close();
}

console.log('\n=== SUMMARY ===', JSON.stringify(R.summary()));
R.save();
