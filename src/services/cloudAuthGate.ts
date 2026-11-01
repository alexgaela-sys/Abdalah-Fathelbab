// Cloud authentication gate — Supabase Auth is the ONLY identity provider when
// this gate is enabled. It is deliberately opt-in:
//
//   VITE_ENABLE_SUPABASE_AUTH=true   -> cloud mode (Supabase Auth only)
//   anything else                    -> local mode (unchanged local login)
//
// Security properties enforced here:
//   * anon key only, session kept in memory by supabaseTestClient (no
//     persistSession, nothing written to localStorage),
//   * the ERP role is read from public.current_erp_role(), a SECURITY DEFINER
//     function scoped to auth.uid() — core.app_profiles is NOT readable from
//     the client (permission denied), so no table grants were widened,
//   * FAIL CLOSED: a missing config, a failed role read or a role this build
//     does not know refuses the sign-in instead of falling back to a local
//     password store or to a guessed role,
//   * no credential, token or secret is ever logged or stored here.

import type { RoleName, User } from '../types/erp';
import { supabaseTestClient, supabaseTestConfigured } from './supabaseTestClient';

export type CloudGateMode = 'local' | 'cloud';

export type CloudGateState =
  | { kind: 'restoring' }
  | { kind: 'signed-in'; user: User; authUserId: string; isTestProfile: boolean }
  | { kind: 'signed-out'; failure: CloudAuthFailure | null };

export type CloudAuthFailure = {
  messageAr: string;
  reason: string;
};

/** Roles this build knows (mirror of src/services/permissions.ts MATRIX keys). */
const KNOWN_ROLES: readonly RoleName[] = [
  'Super Admin', 'General Manager', 'Chief Accountant', 'Accountant',
  'Cost Accountant', 'Warehouse Manager', 'Warehouse Employee', 'Sales Manager',
  'Sales Representative', 'Purchasing Manager', 'Production Manager',
  'Treasury Accountant', 'Viewer',
];

const env = (): Record<string, string | undefined> =>
  import.meta.env as unknown as Record<string, string | undefined>;

const failure = (messageAr: string, reason: string): CloudGateState => ({
  kind: 'signed-out',
  failure: { messageAr, reason },
});

export function cloudGateMode(): CloudGateMode {
  const enabled = (env().VITE_ENABLE_SUPABASE_AUTH || '').trim() === 'true';
  return enabled && supabaseTestConfigured() ? 'cloud' : 'local';
}

/**
 * Builds the signed-in state from the CURRENT Supabase session.
 * Returns a signed-out state (with an explicit reason) when anything required
 * is missing — the caller must never be handed a user with an unknown role.
 */
async function stateFromSession(): Promise<CloudGateState> {
  const client = supabaseTestClient();
  if (!client) {
    return failure('لم تُضبط إعدادات Supabase TEST — لا يوجد دخول سحابي.', 'config');
  }

  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError || !sessionData.session) {
    return { kind: 'signed-out', failure: null };
  }

  const session = sessionData.session;
  const authUserId = session.user.id;

  // Role source: self-scoped SECURITY DEFINER RPC (verified callable by
  // `authenticated`; the app_profiles table itself stays denied to the client).
  const { data: role, error: roleError } = await client.rpc('current_erp_role');
  if (roleError || typeof role !== 'string' || role.length === 0) {
    return failure(
      'تعذّر قراءة دورك من الخادم — لم يُفتح النظام (إغلاق تلقائي).',
      'role-unavailable',
    );
  }
  if (!KNOWN_ROLES.includes(role as RoleName)) {
    return failure(
      `دور غير معروف في هذا الإصدار (${role}) — لم يُفتح النظام.`,
      'role-unknown',
    );
  }

  const email = session.user.email ?? '';
  const user: User = {
    id: authUserId,
    username: email.split('@')[0] || authUserId,
    name: email || authUserId,
    email,
    role: role as RoleName,
    active: true,
    createdAt: session.user.created_at ?? new Date().toISOString(),
    lastLogin: new Date().toISOString(),
  };

  return { kind: 'signed-in', user, authUserId, isTestProfile: false };
}

/** Restores the session on page load. Local mode keeps the local login flow. */
export async function restoreCloudGate(): Promise<CloudGateState> {
  if (cloudGateMode() !== 'cloud') {
    return { kind: 'signed-out', failure: null };
  }
  return stateFromSession();
}

export async function signOutCloudGate(): Promise<CloudGateState> {
  const client = supabaseTestClient();
  if (client) await client.auth.signOut();
  return { kind: 'signed-out', failure: null };
}

/**
 * Notifies the app ONLY when the Supabase session disappears (expiry, revoke,
 * sign-out in another tab) so the in-memory user is dropped. Sign-in events are
 * deliberately not forwarded: the caller already handles the signed-in state.
 */
export function watchCloudGate(
  listener: (state: CloudGateState) => void,
): () => void {
  const client = supabaseTestClient();
  if (!client) return () => {};

  const { data } = client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') listener({ kind: 'signed-out', failure: null });
  });
  return () => data.subscription.unsubscribe();
}

/**
 * Cloud sign-in. `username` is the Supabase email in cloud mode; there is no
 * local password fallback by design.
 */
export async function submitCloudGate(
  username: string,
  password: string,
): Promise<CloudGateState> {
  if (cloudGateMode() !== 'cloud') {
    return failure('البوابة السحابية غير مفعلة في هذه النسخة المحلية', 'not-enabled');
  }
  const client = supabaseTestClient();
  if (!client) {
    return failure('لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY.', 'config');
  }

  const email = username.trim();
  if (!email || !password) {
    return failure('أدخل البريد وكلمة المرور.', 'missing-credentials');
  }

  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    // Server message only — never echo the password or any token.
    return failure(`تعذّر تسجيل الدخول: ${error.message}`, 'bad-credentials');
  }

  const state = await stateFromSession();
  if (state.kind !== 'signed-in') {
    // Fail closed: do not keep a session that has no resolvable ERP role.
    await client.auth.signOut();
  }
  return state;
}
