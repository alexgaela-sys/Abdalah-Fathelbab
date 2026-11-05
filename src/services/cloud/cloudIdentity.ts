// Cloud mode identity: Supabase Auth proves WHO signed in (an email); the ERP's own
// shared users list says what that person may do. This file connects the two.
//
//   * a user record whose email (or authUserId) matches  -> that user
//   * no record, and the sign-in is a database admin      -> the owner is bootstrapped
//     as Super Admin (this is how the very first admin gets an ERP user)
//   * no record, anybody else                             -> refused, nothing is created
//   * record exists but is switched off                   -> refused
//
// Pure functions apart from ensureOwnerUser, so they can be tested without a browser.

import { User } from '../../types/erp';

export interface CloudSignIn {
  email: string;
  authUserId: string;
  /** erp_members.role === 'admin' as reported by the server (never taken from the browser). */
  isDbAdmin: boolean;
}

export type IdentityResult =
  | { ok: true; user: User; needsLink: boolean }
  | { ok: false; reason: 'no_user' | 'disabled' | 'bootstrap'; messageAr: string };

const norm = (s: string | undefined) => (s || '').trim().toLowerCase();

export function findErpUser(users: User[], who: { email: string; authUserId: string }): User | undefined {
  const byId = who.authUserId ? users.find(u => u.authUserId === who.authUserId) : undefined;
  if (byId) return byId;
  const email = norm(who.email);
  return email ? users.find(u => norm(u.email) === email) : undefined;
}

export function resolveCloudIdentity(users: User[], who: CloudSignIn): IdentityResult {
  const found = findErpUser(users, who);
  if (found) {
    if (!found.active) {
      return { ok: false, reason: 'disabled', messageAr: 'هذا الحساب معطّل حاليًا، يرجى مراجعة المسؤول.' };
    }
    return { ok: true, user: found, needsLink: !!who.authUserId && found.authUserId !== who.authUserId };
  }
  if (who.isDbAdmin) {
    return { ok: false, reason: 'bootstrap', messageAr: '' };
  }
  return {
    ok: false,
    reason: 'no_user',
    messageAr: 'حسابك غير مرتبط بمستخدم داخل النظام. اطلب من المدير إضافتك من شاشة المستخدمين.',
  };
}

/** First sign-in of the database admin with no ERP user yet: the owner becomes Super Admin. */
export function buildOwnerUser(who: { email: string; authUserId: string }, id: string): User {
  const email = norm(who.email);
  return {
    id,
    username: email.split('@')[0] || 'owner',
    name: email.split('@')[0] || 'المدير',
    email,
    role: 'Super Admin',
    active: true,
    authUserId: who.authUserId || undefined,
    createdAt: new Date().toISOString(),
  };
}
