// Standard cost rates (TEST only) — master data for the costing module.
//
// Rows are additive and auditable: creating a rate appends an 'active' row, and
// expiring one sets status='expired' + effective_to. No journal, no stock and
// no valuation is produced here (a standard cost becomes accounting only when a
// production order is completed, which is still blocked).

import { readCloudRpc, type CloudRow } from './cloudOpsRead';
import { supabaseTestClient } from './supabaseTestClient';
import type { CloudFailureKind, CloudResult } from './masterDataCloudSlice';

const CONFIG_MESSAGE = 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.';

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export type CloudCostType = 'direct_labor' | 'electricity' | 'gas' | 'maintenance' | 'supervision' | 'overhead';

export const COST_TYPES: Array<{ key: CloudCostType; labelAr: string }> = [
  { key: 'direct_labor', labelAr: 'عمالة مباشرة' },
  { key: 'electricity', labelAr: 'كهرباء' },
  { key: 'gas', labelAr: 'غاز' },
  { key: 'maintenance', labelAr: 'صيانة' },
  { key: 'supervision', labelAr: 'إشراف' },
  { key: 'overhead', labelAr: 'تكاليف غير مباشرة' },
];

export type CloudCostRate = {
  rateId: string;
  costType: string;
  costTypeNameAr: string;
  productFamily: string;
  productId: string;
  itemCode: string;
  itemNameAr: string;
  baseQuantity: number;
  rate: number;
  effectiveFrom: string;
  effectiveTo: string;
  status: string;
};

function mapError(message: string): { kind: CloudFailureKind; messageAr: string } {
  if (/not_authenticated|JWT/i.test(message)) {
    return { kind: 'not_authenticated', messageAr: 'لا توجد جلسة سحابية صالحة — سجّل الدخول أولًا.' };
  }
  if (/permission denied|not_authorized|42501|forbidden/i.test(message)) {
    return { kind: 'not_authorized', messageAr: 'هذا الحساب غير مُصرَّح له بإدارة التكاليف المعيارية.' };
  }
  return { kind: 'network', messageAr: `تعذّرت العملية السحابية: ${message}` };
}

const STATUS_MESSAGES: Record<string, string> = {
  invalid_cost_type: 'نوع التكلفة غير معروف.',
  invalid_rate: 'المعدل يجب أن يكون رقمًا غير سالب.',
  invalid_base_quantity: 'الكمية الأساسية يجب أن تكون أكبر من صفر.',
  invalid_item: 'الصنف المرتبط غير موجود.',
  not_found: 'المعدل غير موجود.',
  already_expired: 'هذا المعدل منتهي السريان بالفعل.',
};

export async function listCloudCostRates(status: string | null): Promise<CloudResult<CloudCostRate[]>> {
  const res = await readCloudRpc('list_standard_cost_rates', {
    p_status: status,
    p_limit: 200,
    p_offset: 0,
  });
  if (!res.ok) return res;
  return {
    ok: true,
    data: res.data.map((r: CloudRow) => ({
      rateId: str(r.rate_id),
      costType: str(r.cost_type),
      costTypeNameAr: str(r.cost_type_name_ar),
      productFamily: str(r.product_family),
      productId: str(r.product_id),
      itemCode: str(r.item_code),
      itemNameAr: str(r.item_name_ar),
      baseQuantity: num(r.base_quantity),
      rate: num(r.rate),
      effectiveFrom: str(r.effective_from),
      effectiveTo: str(r.effective_to),
      status: str(r.status),
    })),
  };
}

export type CostRateDraft = {
  costType: CloudCostType;
  costTypeNameAr: string;
  productFamily: string;
  productId: string | null;
  baseQuantity: number;
  rate: number;
  effectiveFrom: string;
};

type MutationResult = CloudResult<{ status: string; messageAr: string; id?: string }>;

export async function createCloudCostRate(draft: CostRateDraft): Promise<MutationResult> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc('create_standard_cost_rate', {
    p_cost_type: draft.costType,
    p_cost_type_name_ar: draft.costTypeNameAr,
    p_product_family: draft.productFamily,
    p_product_id: draft.productId,
    p_base_quantity: draft.baseQuantity,
    p_rate: draft.rate,
    p_effective_from: draft.effectiveFrom || null,
    p_idempotency_key: `ui-cost-${crypto.randomUUID()}`,
  });

  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }

  const row = (data ?? {}) as Record<string, unknown>;
  const status = str(row.status) || 'unknown';
  if (status === 'created' || status === 'existing') {
    return {
      ok: true,
      data: {
        status,
        messageAr: status === 'existing' ? 'المعدل مسجَّل مسبقًا' : 'أُضيف المعدل',
        id: str(row.rate_id),
      },
    };
  }
  return { ok: false, kind: 'invalid', messageAr: STATUS_MESSAGES[status] ?? `نتيجة غير متوقعة: ${status}` };
}

export async function expireCloudCostRate(rateId: string, effectiveTo: string): Promise<MutationResult> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc('expire_standard_cost_rate', {
    p_id: rateId,
    p_effective_to: effectiveTo || null,
  });

  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }

  const row = (data ?? {}) as Record<string, unknown>;
  const status = str(row.status) || 'unknown';
  if (status === 'updated') return { ok: true, data: { status, messageAr: 'أُنهي سريان المعدل' } };
  return { ok: false, kind: 'invalid', messageAr: STATUS_MESSAGES[status] ?? `نتيجة غير متوقعة: ${status}` };
}
