// First real cloud slice: warehouses master data (TEST project only).
//
// This module is deliberately independent of the local ERP store:
//   * it never imports erpDb, never reads/writes localStorage, never touches
//     abdullah_erp_db_v1, and never flips resolveDataMode(),
//   * every failure is returned explicitly — there is no silent fallback to the
//     local store,
//   * writes go through public.erp_warehouse_cas, which enforces auth, the
//     writer allowlist and the version predicate atomically on the server.
//
// It is not wired into the ERP screens yet: the local screens keep reading the
// local snapshot unchanged. The slice is exercised by the ?poc=1 panel and by
// scripts/slice_warehouses_test.mjs until the wiring step is approved.

import { supabaseTestClient, supabaseTestConfigured } from './supabaseTestClient';

export type CloudWarehouse = {
  id: string;
  code: string;
  nameAr: string;
  type: string;
  location: string;
  managerName: string | null;
  managerUserId: string | null;
  disabledReason: string | null;
  active: boolean;
  version: number;
  updatedAt: string | null;
};

export type SliceFailureKind =
  | 'config'
  | 'not_authenticated'
  | 'not_authorized'
  | 'conflict'
  | 'invalid'
  | 'network'
  | 'unknown';

export type SliceResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: SliceFailureKind; messageAr: string; currentVersion?: number | null };

const STATUS_MESSAGES: Record<string, { kind: SliceFailureKind; messageAr: string }> = {
  not_authenticated: { kind: 'not_authenticated', messageAr: 'لا توجد جلسة سحابية صالحة — سجّل الدخول بحساب الاختبار.' },
  not_authorized: { kind: 'not_authorized', messageAr: 'هذا الحساب غير مُدرج في قائمة كتاب الشريحة السحابية.' },
  conflict: { kind: 'conflict', messageAr: 'تعارض نسخ: تغيّر المستودع بعد آخر قراءة — أعد التحميل ثم أعد المحاولة.' },
  invalid_id: { kind: 'invalid', messageAr: 'معرّف المستودع غير صالح.' },
  invalid_code: { kind: 'invalid', messageAr: 'كود المستودع غير صالح.' },
  invalid_name: { kind: 'invalid', messageAr: 'اسم المستودع غير صالح.' },
  invalid_type: { kind: 'invalid', messageAr: 'نوع المستودع غير صالح.' },
  invalid_expected_version: { kind: 'invalid', messageAr: 'رقم النسخة المتوقعة غير صالح.' },
};

export function cloudSliceConfigured(): boolean {
  return supabaseTestConfigured();
}

export async function listCloudWarehouses(): Promise<SliceResult<CloudWarehouse[]>> {
  const client = supabaseTestClient();
  if (!client) {
    return { ok: false, kind: 'config', messageAr: 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.' };
  }

  const { data, error } = await client
    .from('erp_warehouses')
    .select('id, code, name_ar, type, location, manager_name, manager_user_id, disabled_reason, active, version, updated_at')
    .order('code', { ascending: true });

  if (error) {
    return { ok: false, kind: 'network', messageAr: `تعذّرت قراءة المستودعات: ${error.message}` };
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return {
    ok: true,
    data: rows.map(r => ({
      id: String(r.id),
      code: String(r.code),
      nameAr: String(r.name_ar),
      type: String(r.type),
      location: String(r.location ?? ''),
      managerName: (r.manager_name as string | null) ?? null,
      managerUserId: (r.manager_user_id as string | null) ?? null,
      disabledReason: (r.disabled_reason as string | null) ?? null,
      active: Boolean(r.active),
      version: Number(r.version),
      updatedAt: (r.updated_at as string | null) ?? null,
    })),
  };
}

export type WarehouseDraft = {
  id: string;
  code: string;
  nameAr: string;
  type: string;
  location: string;
  managerName?: string | null;
  managerUserId?: string | null;
  disabledReason?: string | null;
  active: boolean;
};

export async function saveCloudWarehouse(
  draft: WarehouseDraft,
  expectedVersion: number,
): Promise<SliceResult<{ status: string; version: number | null }>> {
  const client = supabaseTestClient();
  if (!client) {
    return { ok: false, kind: 'config', messageAr: 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.' };
  }

  const { data, error } = await client.rpc('erp_warehouse_cas', {
    p_id: draft.id,
    p_code: draft.code.trim(),
    p_name_ar: draft.nameAr.trim(),
    p_type: draft.type,
    p_location: draft.location ?? '',
    p_manager_name: draft.managerName ?? null,
    p_manager_user_id: draft.managerUserId ?? null,
    p_disabled_reason: draft.disabledReason ?? null,
    p_active: draft.active,
    p_expected_version: expectedVersion,
  });

  if (error) {
    return { ok: false, kind: 'network', messageAr: `تعذّر تنفيذ حفظ المستودع: ${error.message}` };
  }

  const row = Array.isArray(data) ? data[0] : data;
  const status = String(row?.status ?? 'unknown');
  const version = row?.version === null || row?.version === undefined ? null : Number(row.version);

  if (status === 'created' || status === 'updated') {
    return { ok: true, data: { status, version } };
  }

  const mapped = STATUS_MESSAGES[status] ?? {
    kind: 'unknown' as SliceFailureKind,
    messageAr: `نتيجة غير متوقعة من الخادم: ${status}`,
  };
  return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr, currentVersion: version };
}

/** Synthetic warehouse for slice testing — never derived from local ERP data. */
export function makeSyntheticWarehouse(seed = Date.now()): WarehouseDraft {
  return {
    id: `poc-wh-${seed}`,
    code: `POC${String(seed).slice(-6)}`,
    nameAr: 'مستودع اختبار سحابي',
    type: 'local_finished',
    location: 'TEST',
    managerName: null,
    managerUserId: null,
    disabledReason: null,
    active: true,
  };
}
