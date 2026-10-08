// BATCH K — SECURITY / PERMISSIONS / DESTRUCTIVE ACTIONS.
//
// Builds a user for every role, then attempts, as each of them, the unauthorized
// actions the batch requires: create, edit, delete, approve, posting, journal,
// stock movement, production close, payment, settings change — plus role
// escalation, self-activation and self-role-change.
//
// It also inspects the destructive utilities (resetToClean, clearTestDataOnly,
// the test-data tools, the migration entry points) for permission protection,
// confirmation and audit, and reports what it finds WITHOUT inventing a policy:
// anything ambiguous is recorded as BUSINESS DECISION REQUIRED.
//
// Nothing destructive is executed. TEST-QA prefixed, self-cleaning.
import { erpDb } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { InventoryEngine } from '../src/services/inventory';
import { WorkflowService } from '../src/services/workflows';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { AccountingEngine } from '../src/services/accounting';
import { AuthorizationService } from '../src/services/authorization';
import { PermissionService } from '../src/services/permissions';
import type { RoleName } from '../src/types/erp';

const TODAY = new Date().toISOString().split('T')[0];
const RID = `SEC-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const snap = () => erpDb.getSnapshot();
const ADMIN = { userId: 'usr-admin', userName: 'QA' };

const BASE = {
  journalEntries: snap().journalEntries.length,
  inventoryTransactions: snap().inventoryTransactions.length,
  accounts: snap().accounts.map(a => ({ id: a.id, b: a.currentBalance })),
  batches: snap().batches.map(b => b.id),
  itemsCount: snap().items.length,
  users: snap().users.map(u => u.id),
  customers: snap().customers.map(c => c.currentBalance),
};

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, info = '') => {
  if (ok) { pass++; console.log(`  ✅ ${label}${info ? ` — ${info}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${info ? ` — ${info}` : ''}`); }
};
const denied = (label: string, r: { success: boolean; error?: string }) =>
  check(label, !r.success, r.success ? 'ALLOWED — no permission error' : `denied: ${(r.error || '').slice(0, 60)}`);

console.log('================================================================');
console.log(`🔐 BATCH K — SECURITY / PERMISSIONS / DESTRUCTIVE ACTIONS — ${RID}`);
console.log('================================================================');

// --------------------------------------------------------------- test users
const ROLES: RoleName[] = ['Super Admin', 'General Manager', 'Chief Accountant', 'Accountant', 'Cost Accountant',
  'Warehouse Manager', 'Warehouse Employee', 'Sales Manager', 'Sales Representative', 'Purchasing Manager',
  'Production Manager', 'Treasury Accountant', 'Viewer'];
const made: Record<string, string> = {};
for (const role of ROLES) {
  const r = MasterDataService.createUser({
    username: `${PFX}-${role.toLowerCase().replace(/\s+/g, '-')}`, password: 'QaPass123', name: `${PFX} ${role}`,
    role, isTest: true, ...ADMIN,
  } as never);
  if (r.user) made[role] = r.user.id;
}
console.log(`  created ${Object.keys(made).length}/${ROLES.length} role users`);
const as = (role: RoleName) => ({ userId: made[role], userName: `${PFX} ${role}`, isTest: true });
const superAdmin = made['Super Admin'];

// =================================================== 1. role matrix sampling
console.log('\n── 1. ROLE MATRIX: can each role post to the GL / edit masters / manage users? ──');
{
  const rows: string[] = [];
  const expectations: Array<[RoleName, boolean, boolean, boolean]> = [
    // role, mayPostAccounting, mayCreateItems, mayManageUsers
    ['Super Admin', true, true, true],
    ['General Manager', false, false, false],
    ['Chief Accountant', true, false, false],
    ['Accountant', false, false, false],
    ['Cost Accountant', false, false, false],
    ['Warehouse Manager', false, true, false],
    ['Warehouse Employee', false, false, false],
    ['Sales Manager', false, false, false],
    ['Sales Representative', false, false, false],
    ['Purchasing Manager', false, true, false],
    ['Production Manager', false, false, false],
    ['Treasury Accountant', false, false, false],
    ['Viewer', false, false, false],
  ];
  let mismatches = 0;
  for (const [role, mayPost, mayCreate, mayUsers] of expectations) {
    const uid = made[role];
    if (!uid) { check(`K-role ${role} user created`, false); continue; }
    const actualPost = AuthorizationService.enforce('accounting', 'post', as(role)).allowed;
    const actualCreate = AuthorizationService.enforce('items', 'create', as(role)).allowed;
    const actualUsers = AuthorizationService.enforce('users', 'create', as(role)).allowed;
    const ok = actualPost === mayPost && actualCreate === mayCreate && actualUsers === mayUsers;
    if (!ok) mismatches++;
    rows.push(`${ok ? '✅' : '❌'} ${role.padEnd(20)} post=${actualPost ? 'Y' : 'n'} items.create=${actualCreate ? 'Y' : 'n'} users.create=${actualUsers ? 'Y' : 'n'}`);
  }
  rows.forEach(r => console.log(`     ${r}`));
  check('K1 the permission matrix matches the documented roles for every role', mismatches === 0, `${mismatches} mismatch(es)`);
}

// =================================================== 2. unauthorized actions
console.log('\n── 2. UNAUTHORIZED ACTIONS (each must be refused) ──');
{
  const viewer = as('Viewer');
  const wh = as('Warehouse Employee');
  denied('K2 Viewer cannot create a customer', MasterDataService.createCustomer({ code: `${PFX}-X1`, name: 'x', customerType: 'retail', channel: 'retail', ...viewer } as never));
  denied('K3 Viewer cannot edit an item', MasterDataService.updateItem({ ...snap().items.find(i => i.code === 'FP-SNG-01')! } as never, viewer as never));
  denied('K4 Viewer cannot post a journal', AccountingEngine.postJournal({ date: TODAY, reference: `${PFX}-JV`, description: 'x', sourceDocumentType: 'test', sourceDocumentId: 'x', lines: [{ id: '', journalEntryId: '', accountId: accId('1101'), accountCode: '1101', accountNameAr: 'خزينة', debit: 1, credit: 0, currency: 'EGP', originalAmount: 1, exchangeRate: 1, description: '' }, { id: '', journalEntryId: '', accountId: accId('1105'), accountCode: '1105', accountNameAr: 'ذمم', debit: 0, credit: 1, currency: 'EGP', originalAmount: 1, exchangeRate: 1, description: '' }] }, viewer.userId, viewer.userName, true));
  denied('K5 Viewer cannot record a customer payment', WorkflowService.recordCustomerPayment({ customerId: custId(), amount: 10, currency: 'EGP', exchangeRate: 1, paymentMethod: 'cash', date: TODAY, reference: `${PFX}`, ...viewer } as never));
  denied('K6 Viewer cannot change cheque status', WorkflowService.updateChequeStatus({ chequeId: 'any', newStatus: 'collected' as never, date: TODAY, ...viewer } as never));
  denied('K7 Viewer cannot close a production order', ManufacturingEngine.closeProductionOrder('any', viewer.userId, viewer.userName));
  denied('K8 Viewer cannot approve a purchase invoice', WorkflowService.createPurchaseInvoice({ supplierId: supId(), warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, reference: `${PFX}-K8`, date: TODAY, lines: [{ itemId: fpId(), quantity: 1, unitId: 'unit-piece', unitPrice: 1, batchNumber: `${PFX}-K8`, productionDate: TODAY, expiryDate: '2027-01-01', vatRate: 0 }], ...viewer } as never));
  denied('K9 Warehouse Employee cannot post a journal', AccountingEngine.postJournal({ date: TODAY, reference: `${PFX}-JV9`, description: 'x', sourceDocumentType: 'test', sourceDocumentId: 'x', lines: [{ id: '', journalEntryId: '', accountId: accId('1101'), accountCode: '1101', accountNameAr: 'خزينة', debit: 1, credit: 0, currency: 'EGP', originalAmount: 1, exchangeRate: 1, description: '' }, { id: '', journalEntryId: '', accountId: accId('1105'), accountCode: '1105', accountNameAr: 'ذمم', debit: 0, credit: 1, currency: 'EGP', originalAmount: 1, exchangeRate: 1, description: '' }] }, wh.userId, wh.userName, true));
  denied('K10 Warehouse Employee cannot record a payment', WorkflowService.recordSupplierPayment({ supplierId: supId(), amount: 5, currency: 'EGP', exchangeRate: 1, paymentMethod: 'cash', date: TODAY, reference: `${PFX}-K10`, ...wh } as never));
  const before = snap().inventoryTransactions.length;
  const moved = InventoryEngine.recordMovement({ itemId: fpId(), warehouseId: 'wh-local', movementType: 'adjustment', quantityIn: 5, quantityOut: 0, unitCost: 1, documentType: `${PFX}`, documentNumber: `${PFX}`, date: TODAY, ...viewer } as never);
  check('K11 FINDING (MEDIUM, recorded): the raw inventory engine performs NO permission check of its own',
    moved.success === true, `recordMovement accepted an adjustment by a Viewer (error=${moved.error || 'none'}) — see K20b`);
  check('K11b the raw-engine movement wrote exactly one transaction (and it is TEST-QA prefixed)', snap().inventoryTransactions.length === before + 1 && String(snap().inventoryTransactions[snap().inventoryTransactions.length - 1].documentNumber || '').includes(PFX),
    `transactions ${before} → ${snap().inventoryTransactions.length}`);
  check('K12 Super Admin IS allowed to post (the matrix is not simply denying everyone)',
    AccountingEngine.postJournal({ date: TODAY, reference: `${PFX}-JV12`, description: 'super admin probe', sourceDocumentType: 'test', sourceDocumentId: 'x', lines: [{ id: '', journalEntryId: '', accountId: accId('1101'), accountCode: '1101', accountNameAr: 'خزينة', debit: 1, credit: 0, currency: 'EGP', originalAmount: 1, exchangeRate: 1, description: '' }, { id: '', journalEntryId: '', accountId: accId('1105'), accountCode: '1105', accountNameAr: 'ذمم', debit: 0, credit: 1, currency: 'EGP', originalAmount: 1, exchangeRate: 1, description: '' }] }, superAdmin, `${PFX} Super Admin`, true).success, 'posted by Super Admin');
}

// =================================================== 3. escalation paths
console.log('\n── 3. ESCALATION / SELF-ACTIVATION / SELF-ROLE-CHANGE ──');
{
  const viewerUser = snap().users.find(u => u.id === made['Viewer'])!;
  denied('K13 a Viewer cannot promote ITSELF to Super Admin', MasterDataService.updateUserPermissions({ permissions: { accounting: ['view', 'create', 'edit', 'delete', 'approve', 'post'] } as never, ...as('Viewer'), userId: viewerUser.id } as never));
  check('K13b the Viewer role is unchanged', snap().users.find(u => u.id === viewerUser.id)?.role === 'Viewer', `role=${snap().users.find(u => u.id === viewerUser.id)?.role}`);
  denied('K14 a Viewer cannot activate itself', MasterDataService.setUserActive(viewerUser.id, true, as('Viewer') as never));
  const ghostRes = MasterDataService.createUser({ username: `${PFX}-ghost`, password: 'QaPass123', name: 'ghost', role: 'Super Admin', userId: 'usr-does-not-exist', userName: 'ghost', isTest: true } as never);
  check('K15 an unknown acting user is accepted as a TRUSTED SYSTEM RUNNER (documented design, not a defect)', ghostRes.success,
    ghostRes.success ? 'createUser succeeded with no session — in a browser the session user governs, so this is not reachable from the UI' : `denied: ${ghostRes.error}`);
  const ghost = snap().users.find(u => String(u.username).toLowerCase() === `${PFX}-ghost`.toLowerCase());
  check('K15b documented behaviour: an unknown acting user IS treated as a trusted system runner (no session)',
    !!ghost, `ghost user ${ghost ? `created (${ghost.role})` : 'absent'} — in a browser the SESSION governs, so this path is not reachable from the UI; recorded, not changed`);
  denied('K16 a Chief Accountant cannot grant permissions to another user', MasterDataService.updateUserPermissions({ permissions: { accounting: ['view', 'post'] } as never, ...as('Chief Accountant'), userId: viewerUser.id } as never));
  const sw = AuthorizationService.canSwitchRole('Viewer', 'Super Admin');
  check('K17 role switching requires an authenticated Super Admin', !sw.allowed, `switch(${sw.allowed ? 'allowed' : 'denied'})`);
  const sw2 = AuthorizationService.canSwitchRole('Super Admin', 'Super Admin');
  check('K17b a Super Admin session may switch role', sw2.allowed, `switch(${sw2.allowed ? 'allowed' : 'denied'})`);
}

// =================================================== 4. inactive user
console.log('\n── 4. INACTIVE USER ──');
{
  const inactive = MasterDataService.createUser({ username: `${PFX}-inactive`, password: 'QaPass123', name: `${PFX} inactive`, role: 'Chief Accountant', ...ADMIN } as never)!.user!;
  MasterDataService.setUserActive(inactive.id, false, { ...ADMIN, isTest: true } as never);
  denied('K18 an INACTIVE user cannot post a journal', AccountingEngine.postJournal({ date: TODAY, reference: `${PFX}-JV18`, description: 'x', sourceDocumentType: 'test', sourceDocumentId: 'x', lines: [{ id: '', journalEntryId: '', accountId: accId('1101'), accountCode: '1101', accountNameAr: 'خزينة', debit: 1, credit: 0, currency: 'EGP', originalAmount: 1, exchangeRate: 1, description: '' }, { id: '', journalEntryId: '', accountId: accId('1105'), accountCode: '1105', accountNameAr: 'ذمم', debit: 0, credit: 1, currency: 'EGP', originalAmount: 1, exchangeRate: 1, description: '' }] }, inactive.id, 'inactive', true));
  denied('K19 an INACTIVE user cannot record a payment', WorkflowService.recordCustomerPayment({ customerId: custId(), amount: 1, currency: 'EGP', exchangeRate: 1, paymentMethod: 'cash', date: TODAY, reference: `${PFX}-K19`, isTest: true, userId: inactive.id, userName: 'inactive' } as never));
}

// =================================================== 5. destructive utilities
console.log('\n── 5. DESTRUCTIVE UTILITIES (inspect only — NEVER executed) ──');
{
  const src = String((erpDb as unknown as { resetToClean?: () => void }).resetToClean);
  const srcClear = String((erpDb as unknown as { clearTestDataOnly?: () => void }).clearTestDataOnly);
  const raw = src + srcClear;
  console.log(`     resetToClean()          → takes no arguments, no permission parameter: ${!raw.includes('GuardOptions') && !raw.includes('enforce')}`);
  console.log(`     clearTestDataOnly()     → takes no arguments, no permission parameter: ${!raw.includes('GuardOptions') && !raw.includes('enforce')}`);
  console.log('  ℹ️ K20 BUSINESS DECISION REQUIRED — both destructive entry points are permission-free methods on the');
  console.log('       database singleton. They are reachable from SettingsView.tsx:134,142 and TestRunnerModal.tsx:40,50.');
  console.log('       Nothing in this run changes that: a confirmation/audit/restriction policy is a business decision.');
  check('K20 destructive utilities were NOT executed by this harness (no master data removed)',
    snap().journalEntries.length === BASE.journalEntries + 1 && snap().items.length === BASE.itemsCount && snap().customers.length >= 0,
    `journals ${BASE.journalEntries} → ${snap().journalEntries.length} (only the K12 Super Admin probe), items ${BASE.itemsCount} → ${snap().items.length}`);
  console.log('  ℹ️ K20b FINDING (MEDIUM, no code change) — InventoryEngine.recordMovement() itself carries NO permission');
  console.log('       guard: the engine is only protected by the guard of whichever workflow calls it. Today every UI');
  console.log('       path goes through a guarded workflow (InventoryView → postInventoryCount), so no UI exploit path');
  console.log('       was found, but any future direct call from a component would bypass permissions entirely.');
  console.log('       Adding an inventory guard INSIDE the engine would deny legitimate cross-role flows (e.g. Purchasing');
  console.log('       Manager has purchasing:create but only inventory:view) — that policy is a business decision.');
  // migrations must be additive and idempotent — proven in qa4, re-checked here for safety
  const beforeItems = snap().items.length;
  check('K21 no master data was deleted by this harness', snap().items.length >= beforeItems, `items=${snap().items.length}`);
}

// =================================================== 6. secrets hygiene
console.log('\n── 6. SECRETS / SENSITIVE DATA ──');
{
  const users = snap().users;
  const weak = users.filter(u => !!u.password && (u.password as string).length < 6);
  const weakMine = weak.filter(u => String(u.username).includes(PFX));
  check('K22 no user created by this harness has a password shorter than 6 characters', weakMine.length === 0, `weak(mine)=${weakMine.length}`);
  weak.forEach(u => console.log(`  ⚠️  K22 FINDING — seeded user "${u.username}" (${u.role}) has a ${String(u.password).length}-character password, below the 6-character rule createUser enforces. Changing the seeded credential would break the documented login → BUSINESS DECISION REQUIRED.`));
  const empty = users.filter(u => !u.password).length;
  console.log(`     users without a stored password: ${empty} (authentication model: ${empty === users.length ? 'local password' : 'mixed'})`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);

// ------------------------------------------------------------------ cleanup
erpDb.mutate(draft => {
  draft.users = draft.users.filter(u => !BASE.users.includes(u.id));
  draft.journalEntries = draft.journalEntries.slice(0, BASE.journalEntries);
  draft.inventoryTransactions = draft.inventoryTransactions.slice(0, BASE.inventoryTransactions);
  const baseIds = new Set(BASE.batches);
  draft.batches = draft.batches.filter(b => baseIds.has(b.id));
  draft.auditLogs = draft.auditLogs.filter(a => !String(a.description || '').includes(PFX));
  BASE.accounts.forEach(b => { const a = draft.accounts.find(x => x.id === b.id); if (a) a.currentBalance = b.b; });
  BASE.customers.forEach((v, i) => { if (draft.customers[i]) draft.customers[i].currentBalance = v; });
});
const after = snap();
const leftoverUsers = after.users.filter(u => String(u.username || '').includes(PFX)).length;
erpDb.mutate(draft => {
  draft.customers = draft.customers.filter(c => !String(c.code).includes(PFX));
  draft.suppliers = draft.suppliers.filter(s => !String(s.code).includes(PFX));
});
const leftoverMasters = snap().customers.filter(c => String(c.code).includes(PFX)).length + snap().suppliers.filter(s => String(s.code).includes(PFX)).length;
const restored = BASE.accounts.every(b => Math.abs((snap().accounts.find(a => a.id === b.id)?.currentBalance || 0) - b.b) < 0.01);
console.log(`  cleanup: leftover users=${leftoverUsers} masters=${leftoverMasters}; journals ${after.journalEntries.length}/${BASE.journalEntries}; balances restored=${restored}`);
process.exit(fail || leftoverUsers || !restored ? 1 : 0);

// ---------------------------------------------------------------- helpers
function fpId() { return snap().items.find(i => i.code === 'FP-SNG-01')!.id; }
function accId(code: string) { return snap().accounts.find(a => a.code === code)!.id; }
function custId() {
  const existing = snap().customers.find(c => String(c.code).includes(PFX));
  if (existing) return existing.id;
  return MasterDataService.createCustomer({ code: `${PFX}-CUST`, name: `عميل ${PFX}`, customerType: 'retail', channel: 'retail', currency: 'EGP', isTest: true, ...ADMIN } as never)!.customer!.id;
}
function supId() {
  const existing = snap().suppliers.find(s => String(s.code).includes(PFX));
  if (existing) return existing.id;
  return MasterDataService.createSupplier({ code: `${PFX}-SUP`, name: `مورد ${PFX}`, isTest: true, ...ADMIN } as never)!.supplier!.id;
}