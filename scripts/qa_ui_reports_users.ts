// scripts/qa_ui_reports_users.ts — TEST only.
//
// Exercises the EXACT modules the new cloud screens call:
//   src/services/cloudReports.ts  (P&L / trial balance / inventory movement)
//   src/services/cloudUsers.ts    (profiles, role, permissions, active, settings)
//
// What it proves end-to-end against TEST:
//   1. reports are server aggregates and internally consistent
//      (gross = revenue − cogs, net = gross − opex + other, trial balance
//       debit = credit, movement closing = stock_on_hand),
//   2. the directory reads through list_app_profiles (not the closed table),
//   3. role / permission mutations are audited writes with the fixture restored,
//   4. the guard rails refuse: self-change, unknown role, unknown module,
//   5. an anonymous client gets permission denied (fail closed).
//
// It never touches localStorage, never runs DDL and restores every fixture it
// changes. Run: bun x tsx scripts/qa_ui_reports_users.ts

import { createClient } from '@supabase/supabase-js';
import {
  signInSupabaseTest,
  signOutSupabaseTest,
  supabaseTestEndpoint,
  supabaseTestUserEmail,
  supabaseTestUserPassword,
} from '../src/services/supabaseTestClient';
import {
  loadInventoryMovement,
  loadProfitAndLoss,
  loadTrialBalance,
} from '../src/services/cloudReports';
import {
  cloudCan,
  listCloudProfiles,
  loadCloudSettings,
  readCloudRole,
  setCloudProfileActive,
  setCloudProfilePermissions,
  setCloudProfileRole,
} from '../src/services/cloudUsers';
import { readCloudRpc } from '../src/services/cloudOpsRead';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ` — ${detail}` : ''}`);
};

const near = (a: number, b: number, eps = 0.005): boolean => Math.abs(a - b) <= eps;

const main = async (): Promise<number> => {
  const email = supabaseTestUserEmail();
  const password = supabaseTestUserPassword();
  if (!email || !password) {
    record('config: TEST credentials present', false, 'SUPABASE_TEST_USER_EMAIL/PASSWORD missing');
    return 2;
  }

  const signIn = await signInSupabaseTest(email, password);
  if (!signIn.ok) {
    record('auth: sign in', false, signIn.message);
    return 1;
  }
  record('auth: sign in', true, signIn.email ?? email);

  // ---------------- 1. reports ----------------
  const from = '2026-01-01';
  const to = '2026-12-31';

  const plRes = await loadProfitAndLoss(from, to);
  if (!plRes.ok) {
    record('reports: loadProfitAndLoss', false, plRes.messageAr);
    return 1;
  }
  const sub = (key: string) =>
    plRes.data.find(l => l.lineType === 'subtotal' && l.section === key)?.amount ?? Number.NaN;
  const revenue = sub('revenue_total');
  const cogs = sub('cogs_total');
  const opex = sub('opex_total');
  const gross = sub('gross_profit');
  const net = sub('net_profit');
  record(
    'reports: P&L returns sections + subtotals',
    Number.isFinite(revenue) && Number.isFinite(cogs) && Number.isFinite(net),
    `revenue=${revenue} cogs=${cogs} gross=${gross} opex=${opex} net=${net}`,
  );
  record('reports: gross = revenue - cogs (server math)', near(gross, revenue - cogs), `${gross} vs ${revenue - cogs}`);
  record('reports: net = gross - opex', near(net, gross - opex), `${net} vs ${gross - opex}`);

  const tbRes = await loadTrialBalance(from, to);
  if (!tbRes.ok) {
    record('reports: loadTrialBalance', false, tbRes.messageAr);
    return 1;
  }
  const tbDebit = tbRes.data.reduce((s, r) => s + r.debit, 0);
  const tbCredit = tbRes.data.reduce((s, r) => s + r.credit, 0);
  record('reports: trial balance debits = credits', near(tbDebit, tbCredit), `${tbDebit} vs ${tbCredit}`);

  const tbRevenue = tbRes.data
    .filter(r => r.category === 'Revenue')
    .reduce((s, r) => s + (r.credit - r.debit), 0);
  const otherIncome = tbRes.data
    .filter(r => r.category === 'Other Income')
    .reduce((s, r) => s + (r.credit - r.debit), 0);
  record(
    'reports: P&L revenue_total = trial balance revenue + other income',
    near(revenue, tbRevenue + otherIncome),
    `pl=${revenue} tb=${tbRevenue}+${otherIncome}`,
  );

  const mvRes = await loadInventoryMovement(from, to);
  if (!mvRes.ok) {
    record('reports: loadInventoryMovement', false, mvRes.messageAr);
    return 1;
  }
  const sohRes = await readCloudRpc('stock_on_hand', { p_warehouse_id: null });
  if (!sohRes.ok) {
    record('reports: stock_on_hand', false, sohRes.messageAr);
    return 1;
  }
  const sohByWarehouse = new Map<string, number>();
  for (const row of sohRes.data) {
    const wh = String(row.warehouse_id);
    sohByWarehouse.set(wh, (sohByWarehouse.get(wh) ?? 0) + Number(row.quantity ?? 0));
  }
  let movementOk = true;
  const movementDetail: string[] = [];
  for (const [wh, qty] of sohByWarehouse) {
    const closing = mvRes.data
      .filter(m => m.warehouseId === wh)
      .reduce((s, m) => s + m.closingQty, 0);
    const same = near(closing, qty, 0.0005);
    movementOk = movementOk && same;
    movementDetail.push(`${wh}: closing=${closing} soh=${qty}`);
  }
  record(
    'reports: inventory movement closing = stock_on_hand per warehouse',
    movementOk && sohByWarehouse.size > 0,
    movementDetail.join(' · '),
  );

  // ---------------- 2. users & permissions ----------------
  const roleRes = await readCloudRole();
  record('users: current_erp_role resolves', roleRes.ok, roleRes.ok ? String(roleRes.data) : roleRes.messageAr);
  if (!roleRes.ok) return 1;

  const canEditUsers = await cloudCan('users', 'edit');
  record(
    'users: erp_user_can(users, edit)',
    canEditUsers.ok && canEditUsers.data === true,
    canEditUsers.ok ? String(canEditUsers.data) : canEditUsers.messageAr,
  );
  const canViewReports = await cloudCan('reports', 'view');
  record(
    'users: erp_user_can(reports, view)',
    canViewReports.ok && canViewReports.data === true,
    canViewReports.ok ? String(canViewReports.data) : canViewReports.messageAr,
  );

  const listRes = await listCloudProfiles();
  if (!listRes.ok) {
    record('users: list_app_profiles', false, listRes.messageAr);
    return 1;
  }
  const self = listRes.data.find(p => p.email.toLowerCase() === email.toLowerCase());
  record(
    'users: directory lists profiles incl. the signed-in one',
    listRes.data.length >= 2 && Boolean(self),
    `profiles=${listRes.data.length} self=${self?.id ?? 'missing'}`,
  );
  if (!self) return 1;

  // --- guard rails (must refuse, must not write) ---
  const selfRole = await setCloudProfileRole(self.id, 'Viewer');
  record(
    'guard: changing own role is refused',
    !selfRole.ok && /بنفسك/.test(selfRole.messageAr),
    selfRole.ok ? 'UNEXPECTED SUCCESS' : selfRole.messageAr,
  );

  const badRole = await setCloudProfileRole('qa-e2e-profile-01', 'Supreme Leader');
  record(
    'guard: unknown role is refused',
    !badRole.ok && /غير معروف/.test(badRole.messageAr),
    badRole.ok ? 'UNEXPECTED SUCCESS' : badRole.messageAr,
  );

  // --- real mutation with full restore on a dedicated TEST profile ---
  // The fixture is a Super Admin, and the server refuses overrides for that role
  // (user_can already grants everything), so the permission cases run while the
  // fixture is temporarily an Accountant and the role is restored at the end.
  const fixture = listRes.data.find(p => p.id === 'qa-e2e-profile-01');
  if (!fixture) {
    record('users: fixture profile qa-e2e-profile-01', false, 'missing');
    return 1;
  }

  const toAccountant = await setCloudProfileRole(fixture.id, 'Accountant');
  const afterRole = await listCloudProfiles();
  const roleApplied =
    toAccountant.ok &&
    afterRole.ok &&
    afterRole.data.find(p => p.id === fixture.id)?.role === 'Accountant';
  record(
    'users: role change is applied and persisted',
    roleApplied,
    toAccountant.ok ? toAccountant.data.messageAr : toAccountant.messageAr,
  );

  const badPerm = await setCloudProfilePermissions(fixture.id, { 'not-a-module': ['view'] });
  record(
    'guard: unknown module is refused',
    !badPerm.ok && /غير صالحة/.test(badPerm.messageAr),
    badPerm.ok ? 'UNEXPECTED SUCCESS' : badPerm.messageAr,
  );

  const badAction = await setCloudProfilePermissions(fixture.id, { sales: ['view', 'self-destruct'] });
  const afterBadAction = await listCloudProfiles();
  const cleanedActions = afterBadAction.ok
    ? afterBadAction.data.find(p => p.id === fixture.id)?.permissions?.sales ?? []
    : [];
  record(
    'guard: unknown action is dropped, not stored',
    badAction.ok && cleanedActions.includes('view') && !cleanedActions.includes('self-destruct'),
    badAction.ok ? JSON.stringify(cleanedActions) : badAction.messageAr,
  );

  const setPerm = await setCloudProfilePermissions(fixture.id, { sales: ['view', 'edit'] });
  const afterPerm = await listCloudProfiles();
  const permRow = afterPerm.ok ? afterPerm.data.find(p => p.id === fixture.id) : undefined;
  record(
    'users: permission override is applied',
    setPerm.ok && permRow?.permissions?.sales?.includes('edit') === true,
    setPerm.ok ? JSON.stringify(permRow?.permissions ?? {}) : setPerm.messageAr,
  );

  // `users` is a module the Viewer row does not contain: a whitelist built from
  // the wrong row would reject this legitimate override.
  const crossModule = await setCloudProfilePermissions(fixture.id, { users: ['view'] });
  const afterCross = await listCloudProfiles();
  const crossRow = afterCross.ok ? afterCross.data.find(p => p.id === fixture.id) : undefined;
  record(
    'users: override on a module outside the Viewer row is accepted',
    crossModule.ok && crossRow?.permissions?.users?.includes('view') === true,
    crossModule.ok ? JSON.stringify(crossRow?.permissions ?? {}) : crossModule.messageAr,
  );

  const resetPerm = await setCloudProfilePermissions(fixture.id, {});
  const afterReset = await listCloudProfiles();
  const cleared = afterReset.ok ? afterReset.data.find(p => p.id === fixture.id) : undefined;
  record(
    'users: permission override removed (back to role matrix)',
    resetPerm.ok && Object.keys(cleared?.permissions ?? {}).length === 0,
    resetPerm.ok ? JSON.stringify(cleared?.permissions ?? {}) : resetPerm.messageAr,
  );

  const restoredRole = await setCloudProfileRole(fixture.id, fixture.role);
  const afterRestore = await listCloudProfiles();
  record(
    'users: role change restored to the fixture value',
    restoredRole.ok && afterRestore.ok && afterRestore.data.find(p => p.id === fixture.id)?.role === fixture.role,
    restoredRole.ok ? restoredRole.data.messageAr : restoredRole.messageAr,
  );

  // active toggle: flip and restore in one step, proving the RPC and its guard
  const deactivate = await setCloudProfileActive(fixture.id, false);
  if (deactivate.ok) await setCloudProfileActive(fixture.id, fixture.active);
  const afterActive = await listCloudProfiles();
  record(
    'users: active toggle works and is restored',
    afterActive.ok && afterActive.data.find(p => p.id === fixture.id)?.active === fixture.active,
    deactivate.ok ? deactivate.data.messageAr : deactivate.messageAr,
  );

  // ---------------- 3. settings ----------------
  const settingsRes = await loadCloudSettings();
  record(
    'settings: company + app_settings readable',
    settingsRes.ok &&
      String(settingsRes.data.company.name_ar ?? '').length > 0 &&
      Number(settingsRes.data.settings.expiry_warning_days ?? 0) > 0,
    settingsRes.ok
      ? `${String(settingsRes.data.company.name_ar ?? '')} · expiry=${String(settingsRes.data.settings.expiry_warning_days ?? '')}`
      : settingsRes.messageAr,
  );

  // ---------------- 4. anonymous fail-closed ----------------
  const { url, anonKey } = supabaseTestEndpoint();
  const anon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const anonList = await anon.rpc('list_app_profiles');
  record(
    'guard: anonymous cannot list profiles',
    Boolean(anonList.error),
    anonList.error?.message ?? 'UNEXPECTED SUCCESS',
  );

  const anonPl = await anon.rpc('profit_and_loss', { p_from: null, p_to: null });
  record(
    'guard: anonymous cannot read reports',
    Boolean(anonPl.error),
    anonPl.error?.message ?? 'UNEXPECTED SUCCESS',
  );

  const anonSettings = await anon.rpc('get_cloud_settings');
  record(
    'guard: anonymous cannot read settings',
    Boolean(anonSettings.error),
    anonSettings.error?.message ?? 'UNEXPECTED SUCCESS',
  );

  await signOutSupabaseTest();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('FAILED:');
    failed.forEach(f => console.log(`  - ${f.name} (${f.detail})`));
    return 1;
  }
  return 0;
};

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error('FATAL', err);
    process.exit(1);
  });
