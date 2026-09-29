// Regression tests for the four production-readiness findings (audit 2026-09-29).
// Run: bun run regression  — read-only for the repo; executes against in-memory erpDb.
import { erpDb } from '../src/services/db';
import { AuthService } from '../src/services/auth';
import { AccountingEngine } from '../src/services/accounting';
import { WorkflowService } from '../src/services/workflows';
import { AuthorizationService } from '../src/services/authorization';
import { AccountCategory } from '../src/types/erp';

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(`${name} :: ${detail}`); console.log(`  ❌ ${name} :: ${detail}`); }
}

const today = new Date().toISOString().split('T')[0];

// ============================================================================
// 1. CRITICAL — Default-password bypass removed
// ============================================================================
console.log('\n=== R1. AUTH: no universal 12345 password ===');
{
  // A custom-password user must NOT authenticate with 12345
  erpDb.mutate(d => {
    if (!d.users.some(u => u.id === 'usr-reg-custom')) {
      d.users.push({
        id: 'usr-reg-custom', username: 'reg_custom_user', password: 'Str0ng-Pass!',
        name: 'Custom Password User', email: 'c@u.t', role: 'Viewer', active: true,
        createdAt: new Date().toISOString(), isTest: true,
      });
    }
  });

  const bypass = AuthService.login('reg_custom_user', '12345');
  check('custom-password user REJECTED with 12345', !bypass.success,
    bypass.success ? 'BYPASS STILL PRESENT' : 'correctly rejected');

  const withOwn = AuthService.login('reg_custom_user', 'Str0ng-Pass!');
  check('custom-password user ACCEPTED with own password', withOwn.success, withOwn.messageAr || '');
  AuthService.logout();

  // Bootstrap admin still works with 12345
  const adminLogin = AuthService.login('admin', '12345');
  check('seeded admin still authenticates with 12345', adminLogin.success);
  AuthService.logout();

  // Password change remains functional for a custom user
  const chg = AuthService.changePassword('usr-reg-custom', 'N3wPassword!', 'regression');
  const withNew = AuthService.login('reg_custom_user', 'N3wPassword!');
  const withOld = AuthService.login('reg_custom_user', 'Str0ng-Pass!');
  check('password change works and old password rejected', chg.success && withNew.success && !withOld.success,
    `chg=${chg.success} new=${withNew.success} oldStillWorks=${withOld.success}`);
  AuthService.logout();

  // Login audit logging preserved
  AuthService.login('admin', '12345');
  AuthService.logout();
  const lastAudit = erpDb.getSnapshot().auditLogs.filter(a => a.action === 'login').pop();
  check('login audit log still recorded', !!lastAudit && lastAudit.userId === 'usr-admin',
    lastAudit ? `last=${lastAudit.userName}` : 'none found');
}

// ============================================================================
// 2. HIGH — Seeded BOMs for all 11 finished products
// ============================================================================
console.log('\n=== R2. BOM: clean DB has active BOMs for all 11 products ===');
{
  // resetToClean gives a deterministic clean database
  erpDb.resetToClean();
  const db = erpDb.getSnapshot();
  const fps = db.items.filter(i => i.itemType === 'finished_product');

  check('clean DB seeds 11 finished products', fps.length === 11, `found ${fps.length}`);

  const missingBom = fps.filter(fp =>
    !db.boms.some(b => b.finishedItemId === fp.id && b.active && db.bomLines.some(l => l.bomId === b.id))
  );
  check('every seeded product has an ACTIVE BOM with lines', missingBom.length === 0,
    missingBom.length ? `missing: ${missingBom.map(p => p.code).join(',')}` : 'all 11 covered');

  // BOM lines must reference real existing material items (no invented placeholders)
  const itemIds = new Set(db.items.map(i => i.id));
  const orphanLines = db.bomLines.filter(l => !itemIds.has(l.materialItemId));
  check('all BOM lines reference existing catalog items', orphanLines.length === 0,
    `${orphanLines.length} orphan lines`);

  // Version + active metadata preserved
  const noVersion = db.boms.filter(b => !b.version || !b.active);
  check('seeded BOMs carry version + active flags', noVersion.length === 0, `${noVersion.length} bad`);
}

// ============================================================================
// 3. HIGH — Action-level RBAC + role-switch restriction
// ============================================================================
console.log('\n=== R3. RBAC: engine-level enforcement ===');
{
  erpDb.resetToClean();
  // Simulate a logged-in Viewer session (script context: no browser session,
  // so we test through explicit userId with a known weak-role user)
  erpDb.mutate(d => {
    if (!d.users.some(u => u.id === 'usr-reg-viewer')) {
      d.users.push({
        id: 'usr-reg-viewer', username: 'reg_viewer', password: 'ViewerPass1!',
        name: 'Regression Viewer', email: 'v@r.t', role: 'Viewer', active: true,
        createdAt: new Date().toISOString(), isTest: true,
      });
    }
    if (!d.users.some(u => u.id === 'usr-reg-rep')) {
      d.users.push({
        id: 'usr-reg-rep', username: 'reg_rep', password: 'RepPass1!',
        name: 'Regression Sales Rep', email: 'r@r.t', role: 'Sales Representative', active: true,
        createdAt: new Date().toISOString(), isTest: true,
      });
    }
    if (!d.users.some(u => u.id === 'usr-reg-acct')) {
      d.users.push({
        id: 'usr-reg-acct', username: 'reg_accountant', password: 'AcctPass1!',
        name: 'Regression Accountant (no post)', email: 'a@r.t', role: 'Accountant', active: true,
        createdAt: new Date().toISOString(), isTest: true,
      });
    }
  });

  const balLines = [
    { id: '', journalEntryId: '', accountId: 'acc-1101', accountCode: '1101', accountNameAr: 'x', debit: 100, credit: 0, currency: 'EGP' as const, originalAmount: 100, exchangeRate: 1 },
    { id: '', journalEntryId: '', accountId: 'acc-4101', accountCode: '4101', accountNameAr: 'y', debit: 0, credit: 100, currency: 'EGP' as const, originalAmount: 100, exchangeRate: 1 },
  ];

  // 3a. Viewer cannot post journals (script context: explicit non-admin userId)
  const viewerPost = AccountingEngine.postJournal(
    { date: today, reference: 'REG', description: 'reg', sourceDocumentType: 'manual_journal', lines: balLines },
    'usr-reg-viewer', 'Regression Viewer'
  );
  check('Viewer CANNOT post journals', !viewerPost.success, viewerPost.error || 'ACCEPTED');

  // 3b. Accountant (no post action) cannot post journals either
  const acctPost = AccountingEngine.postJournal(
    { date: today, reference: 'REG', description: 'reg', sourceDocumentType: 'manual_journal', lines: balLines },
    'usr-reg-acct', 'Regression Accountant'
  );
  check('Accountant (view-only matrix) CANNOT post journals', !acctPost.success, acctPost.error || 'ACCEPTED');

  // 3c. Sales rep cannot create purchase invoices (finance/purchasing wall)
  const repPurchase = WorkflowService.createPurchaseInvoice({
    supplierId: 'sup-1', warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: 'REG', date: today,
    lines: [{ itemId: 'item-raw-corn', quantity: 1, unitId: 'unit-kg', unitPrice: 10, batchNumber: 'REG-B', productionDate: today, expiryDate: '2027-12-31', vatRate: 0 }],
    userId: 'usr-reg-rep', userName: 'Regression Sales Rep',
  });
  check('Sales Representative CANNOT create purchase invoices', !repPurchase.success, repPurchase.error || 'ACCEPTED');

  // 3d. Super Admin still can post (admin bootstrap user)
  const adminPost = AccountingEngine.postJournal(
    { date: today, reference: 'REG-ADMIN', description: 'reg', sourceDocumentType: 'manual_journal', lines: balLines },
    'usr-admin', 'رئيس الحسابات'
  );
  check('Super Admin CAN post journals', adminPost.success, adminPost.error || 'REJECTED');

  // 3e. Role self-elevation blocked at the service level
  //     (simulate a non-admin session by temporarily setting a session via login)
  AuthService.login('reg_rep', 'RepPass1!');
  const elevate1 = AuthService.updateSessionRole('Super Admin');
  check('non-admin session CANNOT self-elevate to Super Admin', !elevate1.success, elevate1.error || 'ELEVATED');
  const sessionAfter = AuthService.getCurrentSession();
  check('session role unchanged after denied elevation', sessionAfter?.user.role === 'Sales Representative',
    `role=${sessionAfter?.user.role}`);
  AuthService.logout();

  // 3f. Invalid target role rejected even for Super Admin
  AuthService.login('admin', '12345');
  const elevate2 = AuthService.updateSessionRole('Not-A-Real-Role' as never);
  check('Super Admin cannot switch to an invalid role', !elevate2.success, elevate2.error || 'ACCEPTED');
  const elevate3 = AuthService.updateSessionRole('Viewer');
  check('Super Admin CAN switch to a valid role', elevate3.success, elevate3.error || 'REJECTED');
  AuthService.logout();
  AuthService.updateSessionRole; // keep referenced
}

// ============================================================================
// 4. MEDIUM — COGS debit-nature in GL computations
// ============================================================================
console.log('\n=== R4. COGS treated as debit-nature everywhere ===');
{
  erpDb.resetToClean();
  const cogsAcc = erpDb.getSnapshot().accounts.find(a => a.category === 'COGS' && !a.isHeader);
  if (!cogsAcc) {
    check('COGS postable account exists', false, 'none found');
  } else {
    // Post 2,000 EGP debit to COGS
    const res = AccountingEngine.postJournal({
      date: today, reference: 'REG-COGS', description: 'COGS regression', sourceDocumentType: 'manual_journal',
      lines: [
        { id: '', journalEntryId: '', accountId: cogsAcc.id, accountCode: cogsAcc.code, accountNameAr: cogsAcc.nameAr, debit: 2000, credit: 0, currency: 'EGP', originalAmount: 2000, exchangeRate: 1 },
        { id: '', journalEntryId: '', accountId: 'acc-1101', accountCode: '1101', accountNameAr: 'x', debit: 0, credit: 2000, currency: 'EGP', originalAmount: 2000, exchangeRate: 1 },
      ],
    }, 'usr-admin', 'رئيس الحسابات');
    check('COGS debit journal posts', res.success, res.error || '');

    const accAfter = erpDb.getSnapshot().accounts.find(a => a.id === cogsAcc.id)!;
    check('COGS account balance = +2000 (debit-nature)', Math.abs(accAfter.currentBalance - 2000) < 0.01,
      `balance=${accAfter.currentBalance}`);

    // Mirror the GL view computation (now using the shared helper)
    const { isDebitNatureCategory } = await import('../src/types/erp');
    const isDebitNormal = isDebitNatureCategory(accAfter.category);
    const running = isDebitNormal
      ? accAfter.currentBalance
      : -accAfter.currentBalance;
    check('GL running balance for COGS shows +2000 debit', Math.abs(running - 2000) < 0.01, `shows ${running}`);

    // Reverse the journal → balance returns to zero (reversal uses same helper)
    if (res.entry) {
      const rev = AccountingEngine.reverseJournal(res.entry.id, 'regression cleanup', 'usr-admin', 'رئيس الحسابات');
      const accFinal = erpDb.getSnapshot().accounts.find(a => a.id === cogsAcc.id)!;
      check('COGS reversal restores zero balance', rev.success && Math.abs(accFinal.currentBalance) < 0.01,
        `rev=${rev.success} balance=${accFinal.currentBalance}`);
    }
  }
}

// ============================================================================
// Cleanup: restore clean baseline so other suites start pristine
// ============================================================================
erpDb.resetToClean();

console.log('\n==============================');
console.log(`REGRESSION TOTAL: ${pass + fail} | PASS: ${pass} | FAIL: ${fail}`);
if (failures.length) {
  console.log('FAILURES:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('🎉 ALL REGRESSION CHECKS PASSED');
