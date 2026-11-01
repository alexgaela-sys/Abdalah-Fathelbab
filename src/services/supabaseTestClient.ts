// Shared Supabase TEST client for the gradual cloud-migration slices.
//
// Rules enforced here:
//   * TEST project only, configured from VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY,
//   * anon key only — no service_role or admin secret is ever bundled,
//   * the session lives in memory (no persistSession) and is never written to
//     localStorage,
//   * no silent fallback: callers get an explicit "not configured" answer.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export const SUPABASE_TEST_USER_EMAIL = 'elhandsiagroup10@gmail.com';

/**
 * Values Vite injects at build/dev time from the workspace env (see
 * vite.config.ts). Only the two PUBLIC browser values are defined: the project
 * URL and the anon/publishable key. `typeof` guards keep this module importable
 * from plain Node (scripts/tests), where the defines do not exist.
 */
function buildTimePublic(name: 'url' | 'key'): string {
  if (name === 'url') {
    return typeof __ERP_SUPABASE_URL__ === 'string' ? __ERP_SUPABASE_URL__.trim() : '';
  }
  return typeof __ERP_SUPABASE_ANON_KEY__ === 'string' ? __ERP_SUPABASE_ANON_KEY__.trim() : '';
}

/**
 * Smallest safe runtime env helper for the TEST client.
 *
 * Resolution order for the two public values:
 *   1. the value Vite injected from the workspace env (buildTimePublic),
 *   2. `process.env` (Node/tsx scripts),
 *   3. `import.meta.env` (VITE_* in a plain Vite browser build).
 * A placeholder-length anon key (< 20 chars) is never used; the public
 * SUPABASE_ANON_KEY name is tried instead. No secret is printed or logged.
 */
function envValue(name: string): string {
  const built = buildTimePublic(name === 'VITE_SUPABASE_URL' ? 'url' : 'key');
  if (built) return built;

  const nodeEnv =
    typeof process !== 'undefined' &&
    typeof process.env === 'object' &&
    process.env !== null
      ? (process.env as unknown as Record<string, string | undefined>)
      : undefined;
  if (nodeEnv) {
    const direct = (nodeEnv[name] || '').trim();
    if (direct && !(name === 'VITE_SUPABASE_ANON_KEY' && direct.length < 20)) return direct;
    if (name === 'VITE_SUPABASE_ANON_KEY') {
      const alt = (nodeEnv.SUPABASE_ANON_KEY || '').trim();
      if (alt) return alt;
    }
    if (name === 'VITE_SUPABASE_URL') {
      const altUrl = (nodeEnv.SUPABASE_URL || '').trim();
      if (altUrl) return altUrl;
    }
  }
  const metaEnv =
    typeof import.meta !== 'undefined' &&
    typeof (import.meta as unknown as Record<string, unknown>).env === 'object'
      ? (import.meta as unknown as { env?: Record<string, unknown> }).env
      : undefined;
  if (metaEnv && Object.prototype.hasOwnProperty.call(metaEnv, name)) {
    const v = metaEnv[name];
    if (typeof v === 'string' && !(name === 'VITE_SUPABASE_ANON_KEY' && v.trim().length < 20)) {
      return v.trim();
    }
  }
  return '';
}

/**
 * TEST user email. The workspace may store the QA identity under more than one
 * name (the harnesses used different slots over time), so the known names are
 * tried in order before the compile-time constant. Values are never printed.
 */
export function supabaseTestUserEmail(): string {
  for (const name of ['SUPABASE_TEST_USER_EMAIL', 'QA_CLOUD_TEST_EMAIL', 'QA_E2E_EMAIL']) {
    const value = envValue(name);
    if (value.length > 0) return value;
  }
  return SUPABASE_TEST_USER_EMAIL;
}

/** Returns the TEST user password from env, or empty when not set. */
export function supabaseTestUserPassword(): string {
  for (const name of ['SUPABASE_TEST_USER_PASSWORD', 'QA_CLOUD_TEST_PASSWORD', 'QA_E2E_PASSWORD']) {
    const value = envValue(name);
    if (value.length > 0) return value;
  }
  return '';
}

export function supabaseTestConfigured(): boolean {
  return envValue('VITE_SUPABASE_URL').length > 0 &&
    envValue('VITE_SUPABASE_ANON_KEY').length > 0;
}

/**
 * Resolved TEST endpoint for callers that must build a raw REST request
 * (the sales posting path sets explicit headers/Prefer). Same resolution order
 * as the client itself, so browser and Node agree. Never logged.
 */
export function supabaseTestEndpoint(): { url: string; anonKey: string } {
  return { url: envValue('VITE_SUPABASE_URL'), anonKey: envValue('VITE_SUPABASE_ANON_KEY') };
}

/** Returns the shared client, or null when the TEST project is not configured. */
export function supabaseTestClient(): SupabaseClient | null {
  if (!supabaseTestConfigured()) return null;
  if (!client) {
    client = createClient(envValue('VITE_SUPABASE_URL'), envValue('VITE_SUPABASE_ANON_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return client;
}

export async function signInSupabaseTest(
  email: string,
  password: string,
): Promise<{ ok: true; email: string | null; accessToken: string } | { ok: false; message: string }> {
  const c = supabaseTestClient();
  if (!c) return { ok: false, message: 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.' };
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, message: `فشل تسجيل الدخول: ${error.message}` };
  if (!data.user) return { ok: false, message: 'فشل الحصول على مستخدم' };
  const token =
    typeof data.session?.access_token === 'string'
      ? data.session.access_token
      : data.session && typeof data.session.access_token === 'string'
        ? data.session.access_token
        : '';
  if (!token) return { ok: false, message: 'فشل الحصول على رمز الوصول' };
  return { ok: true, email: data.user.email ?? null, accessToken: token };
}

export async function signOutSupabaseTest(): Promise<void> {
  if (client) await client.auth.signOut();
}

export async function currentSupabaseTestUser(): Promise<string | null> {
  if (!client) return null;
  const { data } = await client.auth.getUser();
  return data.user?.email ?? null;
}

/**
 * Project ref taken from the configured URL host. This is public metadata, not a
 * secret, and it lets the trial screen show WHICH TEST project is targeted.
 */
export function supabaseTestProjectRef(): string {
  const url = envValue('VITE_SUPABASE_URL');
  if (!url) return '';
  try {
    return new URL(url).host.split('.')[0] || '';
  } catch {
    return '';
  }
}

export type SupabaseTestHealth =
  | { kind: 'ok'; projectRef: string }
  | { kind: 'not-configured'; projectRef: string }
  | { kind: 'invalid-key'; projectRef: string; status: number }
  | { kind: 'unreachable'; projectRef: string; message: string };

/**
 * Reachability + credential shape check BEFORE the user types a password.
 *
 * Calls the project's Auth health endpoint with the published anon key the app
 * bundles; Supabase answers 401 "Invalid API key" when the configured key does
 * not belong to that project (a rotated or placeholder value), which is the one
 * failure that looks like "wrong password" in the UI but is really config.
 * No secret is returned or logged — only an explicit state.
 */
export async function checkSupabaseTestHealth(): Promise<SupabaseTestHealth> {
  const projectRef = supabaseTestProjectRef();
  if (!supabaseTestConfigured()) return { kind: 'not-configured', projectRef };
  const { url, anonKey } = supabaseTestEndpoint();
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/health`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    if (res.ok) return { kind: 'ok', projectRef };
    if (res.status === 401 || res.status === 403) {
      return { kind: 'invalid-key', projectRef, status: res.status };
    }
    return { kind: 'unreachable', projectRef, message: `HTTP ${res.status}` };
  } catch (e) {
    return {
      kind: 'unreachable',
      projectRef,
      message: e instanceof Error ? e.message : 'network',
    };
  }
}
