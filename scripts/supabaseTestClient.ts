// Dedicated Supabase TEST client for smoke/integration tests.
// This is intentionally a Node/TS side module and does not expose any
// service_role/admin credentials.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export const SUPABASE_TEST_USER_EMAIL = 'elhandsiagroup10@gmail.com';

function envValue(name: string): string {
  const nodeEnv =
    typeof process !== 'undefined' && process && process.env
      ? (process.env as Record<string, string | undefined>)
      : undefined;
  if (nodeEnv && Object.prototype.hasOwnProperty.call(nodeEnv, name)) {
    return (nodeEnv[name] || '').trim();
  }
  const metaEnv =
    typeof import.meta !== 'undefined' &&
    typeof (import.meta as unknown as Record<string, unknown>).env === 'object'
      ? (import.meta as unknown as { env?: Record<string, unknown> }).env
      : undefined;
  if (metaEnv && Object.prototype.hasOwnProperty.call(metaEnv, name)) {
    const v = metaEnv[name];
    return typeof v === 'string' ? v.trim() : '';
  }
  return '';
}

export function supabaseTestConfigured(): boolean {
  return envValue('VITE_SUPABASE_URL').length > 0 && envValue('VITE_SUPABASE_ANON_KEY').length > 0;
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
  if (!c) return { ok: false, message: 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة الاختبار.' };
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, message: `فشل تسجيل الدخول: ${error.message}` };
  if (!data.user) return { ok: false, message: 'فشل الحصول على مستخدم' };
  const token = typeof data.session?.access_token === 'string' ? data.session.access_token : '';
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
