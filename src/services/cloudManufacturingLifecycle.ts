// Cloud production operations — READ + the new write path for completion.
//
// The cloud surface for production already had:
//   * create_production_order       (draft only)
//   * set_production_order_status  (released / in_progress / cancelled)
//   * create_quality_inspection    (record only, no stock movement)
//
// This file adds the missing production lifecycle that the server now exposes
// in TEST (supabase/migrations/171_cloud_production_completion.sql):
//   * issue materials to an in_progress order (FIFO consumption)
//   * record finished-goods output (no cost assumption)
//   * close the order atomically: actual material cost + posted conversion cost
//     -> one balanced completion journal + FG capitalisation
//
// It keeps the existing refusal behaviour intact:
//   - setCloudProductionOrderStatus still refuses 'completed' at the server:
//     completion only happens through close_production_order, which posts the
//     journal and flips the order in the same transaction.
//   - completion still refuses when a mapping, an open period, the FIFO
//     consumption or the material cost is missing (server-side).
//   - every write accepts an optional idempotency key so a retried submission
//     returns the first result instead of repeating the posting.

import { supabaseTestClient } from './supabaseTestClient';
import { readCloudRpc, type CloudRow } from './cloudOpsRead';
import type { CloudFailureKind, CloudResult } from './masterDataCloudSlice';

const CONFIG_MESSAGE = 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.';

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

function mapError(message: string): { kind: CloudFailureKind; messageAr: string } {
  if (/not_authenticated|JWT/i.test(message)) {
    return { kind: 'not_authenticated', messageAr: 'لا توجد جلسة سحابية صالحة — سجّل الدخول أولًا.' };
  }
  if (/permission denied|not_authorized|42501|forbidden/i.test(message)) {
    return { kind: 'not_authorized', messageAr: 'هذا الحساب غير مُصرَّح له بهذه العملية على الإنتاج.' };
  }
  return { kind: 'network', messageAr: `تعذّرت العملية السحابية: ${message}` };
}

type MutationResult = CloudResult<{ status: string; messageAr: string; id?: string }>;

async function runMutation(
  rpc: string,
  params: Record<string, unknown>,
  messages: Record<string, string>,
  idKey: string,
): Promise<MutationResult> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc(rpc, params);
  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }

  const row = (data ?? {}) as Record<string, unknown>;
  const status = str(row.status) || 'unknown';

  if (status === 'created' || status === 'updated' || status === 'existing') {
    return {
      ok: true,
      data: {
        status,
        messageAr: status === 'updated' ? 'تم التحديث' : status === 'existing' ? 'نفس العملية مسجَّلة مسبقًا' : 'تم الحفظ',
        id: row[idKey] === undefined ? undefined : str(row[idKey]),
      },
    };
  }

  return {
    ok: false,
    kind: status === 'not_found' ? 'invalid' : 'invalid',
    messageAr: messages[status] ?? `نتيجة غير متوقعة من الخادم: ${status}`,
  };
}

// Re-export the already-wired read + thin write surfaces so panels don't break.
export {
  listCloudProductionOrders,
  createCloudProductionOrder as createCloudProductionOrderDraft,
  setCloudProductionOrderStatus,
  listCloudQualityInspections,
  createCloudQualityInspection,
  type CloudProductionOrder,
  type CloudQualityInspection,
  type ProductionOrderDraft,
  type QualityInspectionDraft,
} from '../services/cloudManufacturing';

// ---------------------------------------------------------------------
// Production lifecycle (completion path) — TEST only, guarded by server
// ---------------------------------------------------------------------

export type ProductionConsumptionLine = {
  materialItemId: string;
  quantity: number;
  unitId?: string;
  warehouseId?: string;
};

export type ProductionConsumptionResult =
  | { ok: true; consumed: ProductionConsumedLine[] }
  | { ok: false; kind: CloudFailureKind; messageAr: string };

export type ProductionConsumedLine = {
  materialItemId: string;
  quantity: number;
  warehouseId: string;
};

const CONSUMPTION_MESSAGES: Record<string, string> = {
  not_found: 'أمر الإنتاج غير موجود.',
  invalid_status: 'لا يمكن صرف مواد لهذا الأمر في حالته الحالية.',
  invalid_lines: 'لم تُحدَّد أي مادة صحيحة للصرف.',
  invalid_material: 'أحد أصناف المواد غير موجود في دليل الأصناف.',
  invalid_warehouse: 'مستودع الصرف غير محدد أو غير موجود.',
  insufficient_material: 'الرصيد المتاح لا يكفي — لم يُصرف أي شيء.',
  not_authenticated: 'لا توجد جلسة سحابية صالحة — سجّل الدخول أولًا.',
  not_authorized: 'هذا الحساب غير مُصرَّح له بصرف مواد الإنتاج.',
};

export async function issueProductionConsumption(
  orderId: string,
  lines: ProductionConsumptionLine[],
  idempotencyKey?: string,
): Promise<ProductionConsumptionResult> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc('create_production_consumption', {
    p_order_id: orderId,
    p_lines: lines.map(l => ({
      materialItemId: l.materialItemId,
      quantity: l.quantity,
      unitId: l.unitId ?? null,
      warehouseId: l.warehouseId ?? null,
    })),
    p_created_by: 'cloud-ui-production',
    p_idempotency_key: idempotencyKey ?? 'ui-prod-consume-' + crypto.randomUUID(),
  });

  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }

  const row = (data ?? {}) as Record<string, unknown>;
  const status = str(row.out_status) || 'unknown';

  if (status === 'ok' || status === 'existing') {
    const raw = (row.out_consumed ?? '[]') as unknown;
    const consumed: ProductionConsumedLine[] = Array.isArray(raw)
      ? raw.map((r: Record<string, unknown>) => ({
          materialItemId: str(r.materialItemId),
          quantity: num(r.quantity),
          warehouseId: str(r.warehouseId),
        }))
      : [];
    return { ok: true, consumed };
  }

  return {
    ok: false,
    kind: 'invalid',
    messageAr: CONSUMPTION_MESSAGES[status] ?? `رفض الخادم الصرف: ${status}`,
  };
}

export type ProductionOutputResult =
  | { ok: true; batchId?: string }
  | { ok: false; kind: CloudFailureKind; messageAr: string };

const OUTPUT_MESSAGES: Record<string, string> = {
  not_found: 'أمر الإنتاج غير موجود.',
  invalid_status: 'لا يمكن تسجيل مخرجات لهذا الأمر في حالته الحالية.',
  invalid_warehouse: 'مستودع الاستلام غير موجود.',
  invalid_quantity: 'يجب تحديد كمية منتج حادة أو معيبة أو هالك أكبر من صفر.',
  not_authenticated: 'لا توجد جلسة سحابية صالحة — سجّل الدخول أولًا.',
  not_authorized: 'هذا الحساب غير مُصرَّح له بتسجيل مخرجات الإنتاج.',
};

export async function recordProductionOutput(
  orderId: string,
  goodQuantity: number,
  defectiveQuantity = 0,
  scrapQuantity = 0,
  destinationWarehouseId?: string,
  idempotencyKey?: string,
): Promise<ProductionOutputResult> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc('record_production_output', {
    p_order_id: orderId,
    p_good_quantity: goodQuantity,
    p_defective_quantity: defectiveQuantity,
    p_scrap_quantity: scrapQuantity,
    p_destination_warehouse_id: destinationWarehouseId ?? null,
    p_unit_cost: null,
    p_created_by: 'cloud-ui-production',
    p_idempotency_key: idempotencyKey ?? 'ui-prod-output-' + crypto.randomUUID(),
  });

  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }

  const row = (data ?? {}) as Record<string, unknown>;
  const status = str(row.out_status) || 'unknown';

  if (status === 'ok' || status === 'existing') {
    return {
      ok: true,
      batchId: row.out_batch_id === undefined ? undefined : str(row.out_batch_id),
    };
  }

  return {
    ok: false,
    kind: 'invalid',
    messageAr: OUTPUT_MESSAGES[status] ?? `رفض الخادم المخرجات: ${status}`,
  };
}

export type ProductionCloseResult =
  | {
      ok: true;
      status: 'completed' | 'already_completed' | 'existing';
      journalEntryId?: string;
      fgBatchId?: string;
      materialCost: number;
      conversionCost: number;
      totalCost: number;
    }
  | { ok: false; kind: CloudFailureKind; messageAr: string };

const CLOSE_MESSAGES: Record<string, string> = {
  not_found: 'أمر الإنتاج غير موجود.',
  // Raised while the server-side completion cycle is not yet safe to post.
  // It is a refusal, never a success — the UI must not show "تم الإكمال".
  completion_not_available:
    'إقفال أمر الإنتاج غير متاح بعد على الخادم — لم يُرحَّل أي قيد ولا تغيّر أي مخزون.',
  not_available:
    'دورة إكمال الإنتاج غير متاحة على هذا الخادم بعد — لم يُرحَّل أي قيد ولا تغيّر أي مخزون.',
  cancelled: 'أمر الإنتاج ملغى ولا يمكن إكماله.',
  closed_period: 'الفترة المالية مغلقة — لا يمكن إكمال أمر الإنتاج.',
  no_consumption: 'لا يوجد صرف مواد فعلي على هذا الأمر — اصرف المواد أولًا.',
  error: 'تعذّر إكمال أمر الإنتاج (نفذ الخادم فحصًا ثم رفض).',
  invalid_status: 'هذا الأمر لا يمكن إكماله في حالته الحالية.',
  not_authenticated: 'لا توجد جلسة سحابية صالحة — سجّل الدخول أولًا.',
  not_authorized: 'هذا الحساب غير مُصرَّح له بإكمال أوامر الإنتاج.',
};

export async function closeProductionOrder(
  orderId: string,
  idempotencyKey?: string,
): Promise<ProductionCloseResult> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc('close_production_order', {
    p_order_id: orderId,
    p_unit_cost: null,
    p_created_by: 'cloud-ui-production',
    p_idempotency_key: idempotencyKey ?? 'ui-prod-close-' + crypto.randomUUID(),
  });

  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }

  const row = (data ?? {}) as Record<string, unknown>;
  const status = str(row.out_status) || 'unknown';

  const materialCost = num(row.out_material_cost);
  const conversionCost = num(row.out_total_cost) - materialCost;
  const totalCost = num(row.out_total_cost);

  if (status === 'completed' || status === 'already_completed' || status === 'existing') {
    return {
      ok: true,
      status,
      journalEntryId: row.out_journal_entry_id === undefined ? undefined : str(row.out_journal_entry_id),
      fgBatchId: row.out_fg_batch_id === undefined ? undefined : str(row.out_fg_batch_id),
      materialCost,
      conversionCost,
      totalCost,
    };
  }

  return {
    ok: false,
    kind: 'invalid',
    messageAr: CLOSE_MESSAGES[status] ?? `رفض الخادم الإكمال: ${status}`,
  };
}

// ---------------------------------------------------------------------
// BOM requirements (read) — the cloud copy of the approved BOM
// ---------------------------------------------------------------------

export type ProductionBomLine = {
  materialItemId: string;
  materialCode: string;
  materialNameAr: string;
  /** Required quantity per one BOM base batch (as stored in the BOM). */
  quantityRequired: number;
  wastePercentage: number;
  unitId: string;
  /** How many finished units one BOM batch yields (default 1 when absent). */
  baseQuantity: number;
  bomCode: string;
};

export type ProductionRequirement = ProductionBomLine & {
  /** Net material needed for the requested good quantity, before waste. */
  netQuantity: number;
  /** Waste allowance implied by wastePercentage. */
  wasteQuantity: number;
  /** Net + waste — what the FIFO issue must be able to cover. */
  requiredQuantity: number;
};

export async function listProductionBom(
  orderId: string,
): Promise<{ ok: true; data: ProductionBomLine[] } | { ok: false; kind: CloudFailureKind; messageAr: string }> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc('list_production_bom', { p_order_id: orderId });
  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return {
    ok: true,
    data: rows.map(r => ({
      materialItemId: str(r.material_item_id),
      materialCode: str(r.material_code),
      materialNameAr: str(r.material_name_ar),
      quantityRequired: num(r.quantity_required),
      wastePercentage: num(r.waste_percentage),
      unitId: str(r.unit_id),
      baseQuantity: num(r.base_quantity) || 1,
      bomCode: str(r.bom_code),
    })),
  };
}

/**
 * Requirement + waste calculation, identical in shape to the local engine:
 *   perUnit = quantityRequired / baseQuantity
 *   net     = perUnit * goodQuantity
 *   waste   = net * wastePercentage / 100
 *   required= net + waste
 * Rounded to 4 decimals (the inventory numeric(18,4) precision).
 */
export function planBomRequirements(
  lines: ProductionBomLine[],
  goodQuantity: number,
): ProductionRequirement[] {
  const qty = Number.isFinite(goodQuantity) && goodQuantity > 0 ? goodQuantity : 0;
  return lines.map(line => {
    const base = line.baseQuantity > 0 ? line.baseQuantity : 1;
    const perUnit = line.quantityRequired / base;
    const net = round4(perUnit * qty);
    const waste = round4(net * (line.wastePercentage / 100));
    return {
      ...line,
      netQuantity: net,
      wasteQuantity: waste,
      requiredQuantity: round4(net + waste),
    };
  });
}

const round4 = (v: number): number => Math.round((v + Number.EPSILON) * 10000) / 10000;
