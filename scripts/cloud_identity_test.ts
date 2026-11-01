// Cloud identity: who is the signed-in person inside the ERP?  bun scripts/cloud_identity_test.ts
import { resolveCloudIdentity, buildOwnerUser, findErpUser } from '../src/services/cloud/cloudIdentity';
import { AuthService } from '../src/services/auth';
import { AuthorizationService } from '../src/services/authorization';
import { PermissionService } from '../src/services/permissions';
import { erpDb } from '../src/services/db';
import type { User } from '../src/types/erp';

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failed++;
};
const user = (o: Partial<User>): User => ({
  id: 'u-' + Math.random().toString(36).slice(2, 7), username: 'x', name: 'X', email: '', role: 'Viewer', active: true, ...o,
});

const sara = user({ id: 'u-sara', email: 'Sara@Example.com', role: 'Accountant', name: 'Sara' });
const omar = user({ id: 'u-omar', email: 'omar@example.com', role: 'Warehouse Employee', active: false });
const list = [sara, omar];

console.log('\n▶ matching the sign-in to an ERP user');
check('matches by email regardless of case', findErpUser(list, { email: 'sara@example.com', authUserId: 'a1' })?.id === 'u-sara');
check('matches by authUserId even if the email changed',
  findErpUser([user({ id: 'u-k', email: 'old@x.com', authUserId: 'AUTH-K' })], { email: 'new@x.com', authUserId: 'AUTH-K' })?.id === 'u-k');
check('no match for a stranger', findErpUser(list, { email: 'nobody@x.com', authUserId: 'zz' }) === undefined);
check('an empty email never matches an empty-email record', findErpUser([user({ email: '' })], { email: '', authUserId: '' }) === undefined);

console.log('\n▶ who may get in');
let r = resolveCloudIdentity(list, { email: 'sara@example.com', authUserId: 'a1', isDbAdmin: false });
check('a known active user gets in with HER role (not Super Admin)', r.ok && r.user.role === 'Accountant');
check('...and is asked to be linked to the sign-in account', r.ok && r.needsLink === true);
r = resolveCloudIdentity(list, { email: 'omar@example.com', authUserId: 'a2', isDbAdmin: false });
check('a switched-off user is refused', !r.ok && r.reason === 'disabled');
r = resolveCloudIdentity(list, { email: 'stranger@example.com', authUserId: 'a3', isDbAdmin: false });
check('an unknown, non-admin sign-in is refused and nothing is created', !r.ok && r.reason === 'no_user');
r = resolveCloudIdentity(list, { email: 'owner@example.com', authUserId: 'a4', isDbAdmin: true });
check('an unknown DATABASE ADMIN is bootstrapped as the owner', !r.ok && r.reason === 'bootstrap');
const owner = buildOwnerUser({ email: ' Owner@Example.com ', authUserId: 'a4' }, 'usr-1');
check('the owner becomes Super Admin, active, linked, with no password',
  owner.role === 'Super Admin' && owner.active && owner.authUserId === 'a4' && owner.email === 'owner@example.com' && owner.password === undefined);
r = resolveCloudIdentity([...list, owner], { email: 'owner@example.com', authUserId: 'a4', isDbAdmin: true });
check('the next sign-in finds the owner (no second bootstrap)', r.ok && r.user.id === 'usr-1' && r.needsLink === false);

console.log('\n▶ the ERP session follows the user record, never a shared account');
erpDb.mutate(d => { d.users = [sara as any, omar as any]; });
const s = AuthService.startCloudSession(sara);
check('session user is Sara, role Accountant', s.user.id === 'u-sara' && s.user.role === 'Accountant');
check('the ERP sees her as the current session', AuthService.getCurrentSession()?.user.id === 'u-sara');
const deniedUsers = AuthorizationService.enforce('users', 'create');
check('an Accountant is NOT allowed to manage users', deniedUsers.allowed === false);
check('the default admin / 12345 login path creates nothing for her',
  AuthService.getCurrentSession()?.user.id !== 'usr-admin');
AuthService.refreshCloudSession({ ...sara, role: 'Chief Accountant' });
check('a role change made by the admin reaches the open session', AuthService.getCurrentSession()?.user.role === 'Chief Accountant');
AuthService.logout();
check('logout clears the ERP session', AuthService.getCurrentSession() === null);

console.log('\n' + '='.repeat(56));
console.log(failed === 0 ? '🎉 ALL CLOUD IDENTITY CHECKS PASSED' : `❌ ${failed} CHECK(S) FAILED`);
console.log('='.repeat(56));
process.exit(failed === 0 ? 0 : 1);
