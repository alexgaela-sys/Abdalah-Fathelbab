// Cloud audit trail (TEST only) — the client half of public.list_audit_log.
//
// The table audit.app_audit_log is NOT exposed to the client directly: the read
// goes through a SECURITY DEFINER RPC gated on core.user_can('audit','view').
// Read-only by construction — no client can append or edit an audit row (the
// internal writer public.erp_write_audit is revoked from authenticated).

import { readCloudRpc, type CloudRow } from './cloudOpsRead';
import type { CloudResult } from './masterDataCloudSlice';

export type AuditRow = {
  auditId: string;
  occurredAt: string;
  userId: string;
  userName: string;
  module: string;
  action: string;
  recordId: string;
  recordTable: string;
  description: string;
  previousValue: unknown;
  newValue: unknown;
};

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export type AuditFilters = {
  module?: string | null;
  action?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
  offset?: number;
};

export async function listAuditLog(filters: AuditFilters = {}): Promise<CloudResult<AuditRow[]>> {
  const res = await readCloudRpc('list_audit_log', {
    p_module: filters.module ?? null,
    p_action: filters.action ?? null,
    p_from: filters.from ?? null,
    p_to: filters.to ?? null,
    p_limit: filters.limit ?? 200,
    p_offset: filters.offset ?? 0,
  });
  if (!res.ok) return res;

  return {
    ok: true,
    data: res.data.map((r: CloudRow) => ({
      auditId: str(r.audit_id),
      occurredAt: str(r.occurred_at),
      userId: str(r.user_id),
      userName: str(r.user_name),
      module: str(r.module),
      action: str(r.action),
      recordId: str(r.record_id),
      recordTable: str(r.record_table),
      description: str(r.description),
      previousValue: r.previous_value ?? null,
      newValue: r.new_value ?? null,
    })),
  };
}

/** Module keys written by the cloud RPCs, with their Arabic labels. */
export const AUDIT_MODULES: Array<{ key: string; labelAr: string }> = [
  { key: '', labelAr: 'كل الوحدات' },
  { key: 'sales', labelAr: 'المبيعات' },
  { key: 'inventory', labelAr: 'المخزون' },
  { key: 'production', labelAr: 'الإنتاج' },
  { key: 'quality', labelAr: 'الجودة' },
  { key: 'costing', labelAr: 'التكاليف' },
  { key: 'users', labelAr: 'المستخدمون' },
  { key: 'المحاسبة العامة', labelAr: 'المحاسبة (قيود مرحّلة)' },
];

export const AUDIT_ACTIONS: Array<{ key: string; labelAr: string }> = [
  { key: '', labelAr: 'كل العمليات' },
  { key: 'create', labelAr: 'إضافة' },
  { key: 'edit', labelAr: 'تعديل' },
  { key: 'post', labelAr: 'ترحيل' },
  { key: 'approve', labelAr: 'اعتماد' },
  { key: 'cancel', labelAr: 'إلغاء' },
  { key: 'reverse', labelAr: 'عكس' },
  { key: 'login', labelAr: 'دخول' },
];
