// Cloud master-data layer (items / units / customers / suppliers) — TEST only.
//
// Async by design, and deliberately independent from the local store:
//   * never imports erpDb, never reads/writes localStorage, never touches
//     abdullah_erp_db_v1,
//   * no silent fallback: a failed load returns an error and the caller must show
//     it instead of falling back to local rows,
//   * writes are CAS-only through public.erp_master_cas (server enforces the
//     version predicate, the allowlist and the entity whitelist).

import { supabaseTestClient } from './supabaseTestClient';

export type MasterEntity = 'items' | 'units' | 'customers' | 'suppliers';

export const MASTER_ENTITIES: Array<{ key: MasterEntity; labelAr: string }> = [
  { key: 'items', labelAr: 'الأصناف' },
  { key: 'units', labelAr: 'الوحدات' },
  { key: 'customers', labelAr: 'العملاء' },
  { key: 'suppliers', labelAr: 'الموردون' },
];

export type CloudMasterRecord = {
  entity: MasterEntity;
  id: string;
  code: string;
  nameAr: string;
  active: boolean;
  payload: Record<string, unknown>;
  version: number;
  updatedAt: string | null;
};

export type CloudFailureKind =
  | 'config'
  | 'not_authenticated'
  | 'not_authorized'
  | 'conflict'
  | 'invalid'
  | 'network'
  | 'unknown';

export type CloudResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: CloudFailureKind; messageAr: string; currentVersion?: number | null };

const CONFIG_MESSAGE = 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.';

const STATUS_MESSAGES: Record<string, { kind: CloudFailureKind; messageAr: string }> = {
  not_authenticated: { kind: 'not_authenticated', messageAr: 'لا توجد جلسة سحابية صالحة — سجّل الدخول بحساب الاختبار.' },
  not_authorized: { kind: 'not_authorized', messageAr: 'هذا الحساب غير مُدرج في قائمة كتاب السحابة.' },
  conflict: { kind: 'conflict', messageAr: 'تعارض نسخ: تغيّر السجل بعد آخر قراءة — أعد التحميل ثم أعد المحاولة.' },
  invalid_entity: { kind: 'invalid', messageAr: 'كيان غير مسموح.' },
  invalid_id: { kind: 'invalid', messageAr: 'معرّف السجل غير صالح.' },
  invalid_code: { kind: 'invalid', messageAr: 'الكود غير صالح.' },
  invalid_name: { kind: 'invalid', messageAr: 'الاسم غير صالح.' },
  payload_too_large: { kind: 'invalid', messageAr: 'حجم بيانات السجل يتجاوز الحد.' },
  invalid_expected_version: { kind: 'invalid', messageAr: 'رقم النسخة المتوقعة غير صالح.' },
};

function mapRow(row: Record<string, unknown>): CloudMasterRecord {
  return {
    entity: row.entity as MasterEntity,
    id: String(row.id),
    code: String(row.code),
    nameAr: String(row.name_ar),
    active: Boolean(row.active),
    payload: (row.payload as Record<string, unknown>) ?? {},
    version: Number(row.version),
    updatedAt: (row.updated_at as string | null) ?? null,
  };
}

export async function listCloudMaster(entity: MasterEntity): Promise<CloudResult<CloudMasterRecord[]>> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client
    .from('erp_master_records')
    .select('entity, id, code, name_ar, active, payload, version, updated_at')
    .eq('entity', entity)
    .order('code', { ascending: true });

  if (error) {
    return { ok: false, kind: 'network', messageAr: `تعذّرت قراءة ${entity}: ${error.message}` };
  }
  return { ok: true, data: ((data ?? []) as Array<Record<string, unknown>>).map(mapRow) };
}

export type CloudWorkspaceSnapshot = {
  byEntity: Record<MasterEntity, CloudMasterRecord[]>;
  total: number;
  loadedAt: string;
};

/** Loads every master entity; any failure fails the whole load (no partial UI). */
export async function loadCloudMasterWorkspace(): Promise<CloudResult<CloudWorkspaceSnapshot>> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const results = await Promise.all(MASTER_ENTITIES.map(e => listCloudMaster(e.key)));

  const failures = results.filter((r): r is Extract<CloudResult<unknown>, { ok: false }> => !r.ok);
  if (failures.length > 0) {
    const first = failures[0];
    return {
      ok: false,
      kind: first.kind,
      messageAr:
        failures.length === 1
          ? first.messageAr
          : `${first.messageAr} (و${failures.length - 1} كيان آخر فشل تحميله)`,
    };
  }

  const byEntity = {} as Record<MasterEntity, CloudMasterRecord[]>;
  MASTER_ENTITIES.forEach((entity, index) => {
    const res = results[index];
    byEntity[entity.key] = res.ok ? res.data : [];
  });

  return {
    ok: true,
    data: {
      byEntity,
      total: Object.values(byEntity).reduce((sum, rows) => sum + rows.length, 0),
      loadedAt: new Date().toISOString(),
    },
  };
}

export type MasterDraft = {
  entity: MasterEntity;
  id: string;
  code: string;
  nameAr: string;
  active: boolean;
  payload?: Record<string, unknown>;
};

export async function saveCloudMaster(
  draft: MasterDraft,
  expectedVersion: number,
): Promise<CloudResult<{ status: string; version: number | null }>> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc('erp_master_cas', {
    p_entity: draft.entity,
    p_id: draft.id,
    p_code: draft.code.trim(),
    p_name_ar: draft.nameAr.trim(),
    p_active: draft.active,
    p_payload: draft.payload ?? {},
    p_expected_version: expectedVersion,
  });

  if (error) {
    return { ok: false, kind: 'network', messageAr: `تعذّر حفظ السجل السحابي: ${error.message}` };
  }

  const row = Array.isArray(data) ? data[0] : data;
  const status = String(row?.status ?? 'unknown');
  const version = row?.version === null || row?.version === undefined ? null : Number(row.version);

  if (status === 'created' || status === 'updated') {
    return { ok: true, data: { status, version } };
  }

  const mapped = STATUS_MESSAGES[status] ?? {
    kind: 'unknown' as CloudFailureKind,
    messageAr: `نتيجة غير متوقعة من الخادم: ${status}`,
  };
  return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr, currentVersion: version };
}

/** Synthetic master record for cloud smoke tests — never derived from local data. */
export function makeSyntheticMaster(entity: MasterEntity, seed = Date.now()): CloudMasterRecord {
  const prefix = entity.slice(0, 3).toUpperCase();
  return {
    entity,
    id: `${entity}-poc-${seed}`,
    code: `${prefix}${String(seed).slice(-6)}`,
    nameAr: `سجل اختبار سحابي — ${entity}`,
    active: true,
    payload: { source: 'poc', seed, note: 'synthetic cloud row' },
    version: 0,
    updatedAt: null,
  };
}
