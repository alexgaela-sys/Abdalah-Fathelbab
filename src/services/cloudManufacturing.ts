// Cloud production orders + quality inspections (TEST only).
//
// Scope is deliberate and matches what the database can prove:
//   * a production order can be CREATED as a draft and moved through the
//     non-financial states (released / in_progress / cancelled). No stock
//     movement and no journal is implied by those states,
//   * COMPLETION is refused by the server ('completion_not_available'): it is an
//     accounting event (material consumption, WIP, labour, FG capitalization)
//     whose mappings do not exist in TEST. Nothing is invented here,
//   * a quality inspection is a RECORD only — exactly like the local engine,
//     which also just stores the row and routes stock elsewhere.

import { readCloudRpc, type CloudRow } from './cloudOpsRead';
import { supabaseTestClient } from './supabaseTestClient';
import type { CloudFailureKind, CloudResult } from './masterDataCloudSlice';

const CONFIG_MESSAGE = 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.';

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

function mapError(message: string): { kind: CloudFailureKind; messageAr: string } {
  if (/not_authenticated|JWT/i.test(message)) {
    return { kind: 'not_authenticated', messageAr: 'لا توجد جلسة سحابية صالحة — سجّل الدخول أولًا.' };
  }
  if (/permission denied|not_authorized|42501|forbidden/i.test(message)) {
    return { kind: 'not_authorized', messageAr: 'هذا الحساب غير مُصرَّح له بهذه العملية على الإنتاج/الجودة.' };
  }
  return { kind: 'network', messageAr: `تعذّرت العملية السحابية: ${message}` };
}

const PRODUCTION_STATUS_MESSAGES: Record<string, string> = {
  invalid_item: 'الصنف غير موجود في دليل الأصناف.',
  invalid_warehouse: 'مستودع الصرف غير موجود.',
  invalid_destination: 'مستودع الاستلام غير موجود.',
  invalid_quantity: 'الكمية المخططة يجب أن تكون أكبر من صفر.',
  invalid_market: 'السوق المستهدف يجب أن يكون local أو export.',
  not_found: 'أمر الإنتاج غير موجود.',
  invalid_status: 'الحالة المطلوبة غير معروفة.',
  invalid_transition: 'هذا الانتقال غير مسموح من الحالة الحالية.',
  completion_not_available:
    'إقفال أمر الإنتاج (استهلاك + WIP + تكلفة تحويل + رسملة منتج تام) يحتاج حسابات وتعيينات غير موجودة في TEST — لم يُنفَّذ شيء.',
};

const QUALITY_STATUS_MESSAGES: Record<string, string> = {
  invalid_result: 'نتيجة الفحص يجب أن تكون passed أو rejected أو conditional.',
  invalid_quantity: 'كمية الفحص يجب أن تكون أكبر من صفر.',
  invalid_item: 'الصنف غير موجود.',
  invalid_order: 'أمر الإنتاج غير موجود.',
  invalid_destination: 'مستودع التوجيه غير موجود.',
};

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

// ---------------------------------------------------------------------
// Production orders
// ---------------------------------------------------------------------
export type CloudProductionOrder = {
  orderId: string;
  orderNumber: string;
  itemId: string;
  warehouseId: string;
  status: string;
  plannedQuantity: number;
  producedQuantity: number;
  plannedCost: number;
  actualCost: number;
  startDate: string;
  journalEntryId: string;
};

export async function listCloudProductionOrders(
  from: string | null,
  to: string | null,
  status: string | null,
): Promise<CloudResult<CloudProductionOrder[]>> {
  const res = await readCloudRpc('list_production_orders', {
    p_from: from,
    p_to: to,
    p_status: status,
    p_limit: 200,
    p_offset: 0,
  });
  if (!res.ok) return res;
  return {
    ok: true,
    data: res.data.map((r: CloudRow) => ({
      orderId: str(r.order_id),
      orderNumber: str(r.order_number),
      itemId: str(r.item_id),
      warehouseId: str(r.warehouse_id),
      status: str(r.status),
      plannedQuantity: num(r.planned_quantity),
      producedQuantity: num(r.produced_quantity),
      plannedCost: num(r.planned_cost),
      actualCost: num(r.actual_cost),
      startDate: str(r.start_date),
      journalEntryId: str(r.journal_entry_id),
    })),
  };
}

export type ProductionOrderDraft = {
  itemId: string;
  warehouseId: string;
  destinationWarehouseId: string | null;
  plannedQuantity: number;
  startDate: string;
  expectedCompletionDate: string | null;
  targetMarket: 'local' | 'export';
  notes: string;
};

export function createCloudProductionOrder(draft: ProductionOrderDraft): Promise<MutationResult> {
  return runMutation(
    'create_production_order',
    {
      p_item_id: draft.itemId,
      p_warehouse_id: draft.warehouseId,
      p_destination_warehouse_id: draft.destinationWarehouseId,
      p_planned_quantity: draft.plannedQuantity,
      p_start_date: draft.startDate || null,
      p_expected_completion_date: draft.expectedCompletionDate,
      p_target_market: draft.targetMarket,
      p_notes: draft.notes,
      p_created_by: 'cloud-ui-production',
      p_idempotency_key: `ui-prod-${crypto.randomUUID()}`,
    },
    PRODUCTION_STATUS_MESSAGES,
    'order_id',
  );
}

export function setCloudProductionOrderStatus(
  orderId: string,
  status: 'released' | 'in_progress' | 'cancelled' | 'completed',
): Promise<MutationResult> {
  return runMutation(
    'set_production_order_status',
    { p_order_id: orderId, p_status: status },
    PRODUCTION_STATUS_MESSAGES,
    'order_id',
  );
}

// ---------------------------------------------------------------------
// Quality inspections
// ---------------------------------------------------------------------
export type CloudQualityInspection = {
  inspectionId: string;
  productionOrderId: string;
  orderNumber: string;
  itemId: string;
  itemCode: string;
  itemNameAr: string;
  quantity: number;
  inspectionDate: string;
  result: string;
  destinationWarehouseId: string;
  destinationCode: string;
  notes: string;
};

export async function listCloudQualityInspections(
  from: string | null,
  to: string | null,
  result: string | null,
): Promise<CloudResult<CloudQualityInspection[]>> {
  const res = await readCloudRpc('list_quality_inspections', {
    p_from: from,
    p_to: to,
    p_result: result,
    p_limit: 200,
    p_offset: 0,
  });
  if (!res.ok) return res;
  return {
    ok: true,
    data: res.data.map((r: CloudRow) => ({
      inspectionId: str(r.inspection_id),
      productionOrderId: str(r.production_order_id),
      orderNumber: str(r.order_number),
      itemId: str(r.item_id),
      itemCode: str(r.item_code),
      itemNameAr: str(r.item_name_ar),
      quantity: num(r.quantity),
      inspectionDate: str(r.inspection_date),
      result: str(r.result),
      destinationWarehouseId: str(r.destination_warehouse_id),
      destinationCode: str(r.destination_code),
      notes: str(r.notes),
    })),
  };
}

export type QualityInspectionDraft = {
  productionOrderId: string | null;
  itemId: string;
  quantity: number;
  date: string;
  result: 'passed' | 'rejected' | 'conditional';
  destinationWarehouseId: string | null;
  notes: string;
};

export function createCloudQualityInspection(draft: QualityInspectionDraft): Promise<MutationResult> {
  return runMutation(
    'create_quality_inspection',
    {
      p_production_order_id: draft.productionOrderId,
      p_item_id: draft.itemId,
      p_quantity: draft.quantity,
      p_date: draft.date || null,
      p_result: draft.result,
      p_destination_warehouse_id: draft.destinationWarehouseId,
      p_notes: draft.notes,
      p_idempotency_key: `ui-qi-${crypto.randomUUID()}`,
    },
    QUALITY_STATUS_MESSAGES,
    'inspection_id',
  );
}
