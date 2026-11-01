// Read-only client for the existing normalized ERP master data in TEST.
//
// Goes through public.erp_core_master_read (SECURITY DEFINER): core.* tables have
// no direct client grants, and this bridge exposes reads only to allowlisted
// users. No writes, no local store, no fallback.

import { supabaseTestClient } from './supabaseTestClient';
import type { CloudFailureKind, CloudResult } from './masterDataCloudSlice';

export type CoreEntity = 'items' | 'units' | 'customers' | 'suppliers' | 'warehouses';

export const CORE_ENTITIES: Array<{ key: CoreEntity; labelAr: string; schemaTable: string }> = [
  { key: 'warehouses', labelAr: 'المستودعات', schemaTable: 'core.warehouses' },
  { key: 'items', labelAr: 'الأصناف', schemaTable: 'core.items' },
  { key: 'units', labelAr: 'الوحدات', schemaTable: 'core.units' },
  { key: 'customers', labelAr: 'العملاء', schemaTable: 'core.customers' },
  { key: 'suppliers', labelAr: 'الموردون', schemaTable: 'core.suppliers' },
];

export type CoreMasterRecord = {
  entity: CoreEntity;
  id: string;
  code: string;
  nameAr: string;
  active: boolean;
  payload: Record<string, unknown>;
  updatedAt: string | null;
};

const CONFIG_MESSAGE = 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.';

function mapError(message: string): { kind: CloudFailureKind; messageAr: string } {
  if (/not_authenticated/i.test(message)) {
    return { kind: 'not_authenticated', messageAr: 'لا توجد جلسة سحابية صالحة لقراءة بيانات core.' };
  }
  if (/not_authorized|permission denied/i.test(message)) {
    return { kind: 'not_authorized', messageAr: 'هذا الحساب غير مُصرَّح له بقراءة بيانات core.' };
  }
  if (/invalid_entity/i.test(message)) {
    return { kind: 'invalid', messageAr: 'كيان core غير معروف.' };
  }
  return { kind: 'network', messageAr: `تعذّرت قراءة ${message}` };
}

export async function readCoreMaster(
  entity: CoreEntity,
): Promise<CloudResult<CoreMasterRecord[]>> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc('erp_core_master_read', { p_entity: entity });
  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return {
    ok: true,
    data: rows.map(row => ({
      entity,
      id: String(row.id),
      code: String(row.code),
      nameAr: String(row.name_ar),
      active: Boolean(row.active),
      payload: (row.payload as Record<string, unknown>) ?? {},
      updatedAt: (row.updated_at as string | null) ?? null,
    })),
  };
}

export type CoreSnapshot = {
  byEntity: Record<CoreEntity, CoreMasterRecord[]>;
  total: number;
};

/** All-or-nothing read of the normalized master data (no partial rendering). */
export async function loadCoreMasterSnapshot(): Promise<CloudResult<CoreSnapshot>> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const results = await Promise.all(CORE_ENTITIES.map(e => readCoreMaster(e.key)));
  const firstFailure = results.find((r): r is Extract<CloudResult<unknown>, { ok: false }> => !r.ok);
  if (firstFailure) {
    return { ok: false, kind: firstFailure.kind, messageAr: firstFailure.messageAr };
  }

  const byEntity = {} as Record<CoreEntity, CoreMasterRecord[]>;
  CORE_ENTITIES.forEach((entity, index) => {
    const res = results[index];
    byEntity[entity.key] = res.ok ? res.data : [];
  });

  return {
    ok: true,
    data: {
      byEntity,
      total: Object.values(byEntity).reduce((sum, rows) => sum + rows.length, 0),
    },
  };
}
