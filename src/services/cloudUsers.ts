// Cloud user & permission management (TEST only) — the client half of
// migration 166.
//
//   public.list_app_profiles        -> directory (core.app_profiles stays closed),
//   public.set_profile_role         -> change a profile role,
//   public.set_profile_permissions  -> per-module override for one user,
//   public.set_profile_active       -> enable / disable an account,
//   public.erp_user_can             -> the screen-permission answer,
//   public.current_erp_role         -> the caller's own role.
//
// Security rules live on the server (auth.uid + core.user_can('users',...),
// no self-change, last active Super Admin protected, audit row per change).
// This module only transports and translates the answer: it never guesses a
// permission, never retries a refused write and never touches localStorage.

import { supabaseTestClient } from './supabaseTestClient';
import type { CloudFailureKind, CloudResult } from './masterDataCloudSlice';

const CONFIG_MESSAGE = 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.';

/** Role names that exist in core.role_matrix() (single source: the SQL matrix). */
export const CLOUD_ROLES = [
  'Super Admin',
  'General Manager',
  'Chief Accountant',
  'Accountant',
  'Cost Accountant',
  'Warehouse Manager',
  'Warehouse Employee',
  'Sales Manager',
  'Sales Representative',
  'Purchasing Manager',
  'Production Manager',
  'Treasury Accountant',
  'Viewer',
] as const;

export type CloudProfile = {
  id: string;
  username: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  isTest: boolean;
  permissions: Record<string, string[]>;
  lastLogin: string | null;
  updatedAt: string | null;
};

function mapError(message: string): { kind: CloudFailureKind; messageAr: string } {
  if (/not_authenticated|JWT/i.test(message)) {
    return { kind: 'not_authenticated', messageAr: 'لا توجد جلسة سحابية صالحة — سجّل الدخول أولًا.' };
  }
  if (/permission denied|not_authorized|42501|forbidden/i.test(message)) {
    return { kind: 'not_authorized', messageAr: 'هذا الحساب غير مُصرَّح له بإدارة المستخدمين.' };
  }
  if (/does not exist|could not find the function/i.test(message)) {
    return { kind: 'unknown', messageAr: `دالة إدارة المستخدمين غير موجودة في TEST: ${message}` };
  }
  return { kind: 'network', messageAr: `تعذّرت العملية السحابية: ${message}` };
}

const STATUS_MESSAGES: Record<string, string> = {
  not_found: 'المستخدم غير موجود في core.app_profiles.',
  self_change_forbidden: 'لا يمكنك تغيير دورك أو صلاحياتك أو تعطيل حسابك بنفسك.',
  invalid_role: 'الدور المطلوب غير معروف في مصفوفة الأدوار.',
  last_super_admin: 'لا يمكن خفض أو تعطيل آخر حساب Super Admin نشط.',
  super_admin_immutable: 'صلاحيات Super Admin لا تُعدَّل: كل الصلاحيات ممنوحة له دائمًا.',
  invalid_permissions: 'صيغة الصلاحيات غير صالحة (وحدة أو إجراء غير معروف).',
  invalid_active: 'قيمة التفعيل غير صالحة.',
};

const UI_STATUS: Record<string, string> = {
  updated: 'تم التحديث',
  created: 'تم الإنشاء',
};

export async function listCloudProfiles(): Promise<CloudResult<CloudProfile[]>> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc('list_app_profiles');
  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return {
    ok: true,
    data: rows.map(r => ({
      id: String(r.id),
      username: r.username === null || r.username === undefined ? '' : String(r.username),
      name: r.name === null || r.name === undefined ? '' : String(r.name),
      email: r.email === null || r.email === undefined ? '' : String(r.email),
      role: String(r.role ?? ''),
      active: Boolean(r.active),
      isTest: Boolean(r.is_test),
      permissions: (r.permissions as Record<string, string[]> | null) ?? {},
      lastLogin: (r.last_login as string | null) ?? null,
      updatedAt: (r.updated_at as string | null) ?? null,
    })),
  };
}

/** The caller's own ERP role (null = signed in but no profile row). */
export async function readCloudRole(): Promise<CloudResult<string | null>> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc('current_erp_role');
  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }
  return { ok: true, data: typeof data === 'string' && data.length > 0 ? data : null };
}

/** Screen permission for the signed-in user, resolved on the server. */
export async function cloudCan(module: string, action: string): Promise<CloudResult<boolean>> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc('erp_user_can', { p_module: module, p_action: action });
  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }
  return { ok: true, data: Boolean(data) };
}

type MutationResult = CloudResult<{ status: string; messageAr: string }>;

async function callProfileMutation(
  rpc: 'set_profile_role' | 'set_profile_permissions' | 'set_profile_active',
  params: Record<string, unknown>,
): Promise<MutationResult> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc(rpc, params);
  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  const status = String(row?.status ?? 'unknown');

  if (status === 'updated') {
    return { ok: true, data: { status, messageAr: UI_STATUS.updated } };
  }

  const messageAr = STATUS_MESSAGES[status] ?? `نتيجة غير متوقعة من الخادم: ${status}`;
  return { ok: false, kind: status === 'not_found' ? 'invalid' : 'not_authorized', messageAr };
}

export function setCloudProfileRole(profileId: string, role: string): Promise<MutationResult> {
  return callProfileMutation('set_profile_role', { p_profile_id: profileId, p_role: role });
}

export function setCloudProfilePermissions(
  profileId: string,
  permissions: Record<string, string[]>,
): Promise<MutationResult> {
  return callProfileMutation('set_profile_permissions', {
    p_profile_id: profileId,
    p_permissions: permissions,
  });
}

export function setCloudProfileActive(profileId: string, active: boolean): Promise<MutationResult> {
  return callProfileMutation('set_profile_active', { p_profile_id: profileId, p_active: active });
}

// ---------------------------------------------------------------------
// Company / system settings snapshot (settings screen)
// ---------------------------------------------------------------------
export type CloudSettings = {
  company: Record<string, unknown>;
  settings: Record<string, unknown>;
};

export async function loadCloudSettings(): Promise<CloudResult<CloudSettings>> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc('get_cloud_settings');
  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }
  const obj = (data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    data: {
      company: (obj.company as Record<string, unknown> | null) ?? {},
      settings: (obj.settings as Record<string, unknown> | null) ?? {},
    },
  };
}
