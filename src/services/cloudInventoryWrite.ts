// Cloud WRITE path for the inventory transfer document.
//
// Source of truth: public.post_inventory_transfer (TEST), which
//   * gates on public.can_write_inventory() server-side (Viewer is refused),
//   * plans the FIFO layers exactly like src/services/inventory.ts,
//   * refuses when the source warehouse cannot cover the quantity,
//   * guards the total stock VALUE (tolerance 0.01) before committing,
//   * is idempotent on p_idempotency_key (fin.inventory_transfer_log).
//
// Rules for this module:
//   * anon-key client, session in memory (supabaseTestClient),
//   * NEVER reads or writes localStorage and never falls back to erpDb,
//   * the server answer is surfaced as-is: no silent local fallback,
//   * no optimistic UI: the caller only shows a document number the SERVER
//     returned.

import { supabaseTestClient } from './supabaseTestClient';
import { readCoreMaster, type CoreMasterRecord } from './coreMasterRead';
import { readCloudRpc, type CloudRow } from './cloudOpsRead';
import type { CloudFailureKind } from './masterDataCloudSlice';

const CONFIG_MESSAGE = 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.';

/** Roles the server-side gate accepts (public.can_write_inventory). */
const INVENTORY_WRITERS = new Set([
  'Super Admin',
  'Warehouse Manager',
  'Warehouse Employee',
  'Production Manager',
]);

export type CloudTransferResult =
  | { ok: true; documentNumber: string }
  | { ok: false; kind: CloudFailureKind; messageAr: string };

export type CloudRole =
  | { ok: true; role: string; canWriteInventory: boolean }
  | { ok: false; kind: CloudFailureKind; messageAr: string };

function mapError(message: string): { kind: CloudFailureKind; messageAr: string } {
  if (/not_authenticated|JWT/i.test(message)) {
    return { kind: 'not_authenticated', messageAr: 'لا توجد جلسة سحابية صالحة — سجّل الدخول أولًا.' };
  }
  if (/permission denied|not_authorized|42501|forbidden/i.test(message)) {
    return { kind: 'not_authorized', messageAr: 'هذا الحساب غير مُصرَّح له بتنفيذ هذه العملية.' };
  }
  return { kind: 'network', messageAr: `تعذّرت العملية السحابية: ${message}` };
}

/**
 * Reads the caller's ERP role through the self-scoped SECURITY DEFINER RPC.
 * core.app_profiles is not readable from the client (permission denied), so
 * this is the only role source available to the browser.
 */
export async function readCloudInventoryRole(): Promise<CloudRole> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc('current_erp_role');
  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }
  const role = typeof data === 'string' ? data : '';
  if (!role) {
    // current_erp_role() returns NULL outside a Supabase session.
    return {
      ok: false,
      kind: 'not_authenticated',
      messageAr: 'لا توجد جلسة سحابية صالحة — سجّل الدخول لاستخدام التحويل.',
    };
  }
  return {
    ok: true,
    role,
    canWriteInventory: INVENTORY_WRITERS.has(role),
  };
}

export type CloudTransferForm = {
  itemId: string;
  sourceWarehouseId: string;
  targetWarehouseId: string;
  quantity: number;
  notes?: string;
  date?: string;
};

/** Executes the transfer on the server and returns its document number. */
export async function postCloudTransfer(
  form: CloudTransferForm,
): Promise<CloudTransferResult> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  if (!form.itemId) return { ok: false, kind: 'invalid', messageAr: 'اختر الصنف المُحوَّل.' };
  if (!form.sourceWarehouseId || !form.targetWarehouseId) {
    return { ok: false, kind: 'invalid', messageAr: 'اختر مستودع المصدر والوجهة.' };
  }
  if (form.sourceWarehouseId === form.targetWarehouseId) {
    return { ok: false, kind: 'invalid', messageAr: 'مستودع المصدر والوجهة يجب أن يختلفا.' };
  }
  if (!Number.isFinite(form.quantity) || form.quantity <= 0) {
    return { ok: false, kind: 'invalid', messageAr: 'الكمية يجب أن تكون أكبر من صفر.' };
  }

  const { data, error } = await client.rpc('post_inventory_transfer', {
    p_item_id: form.itemId,
    p_source_warehouse_id: form.sourceWarehouseId,
    p_target_warehouse_id: form.targetWarehouseId,
    p_quantity: form.quantity,
    p_batch_number: null,
    p_notes: form.notes ?? null,
    p_date: form.date ?? null,
    // one key per submission: a retry of the SAME submission can never move
    // stock twice, while a new submission always gets a new document.
    p_idempotency_key: `ui-transfer-${crypto.randomUUID()}`,
  });

  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }

  const row = (Array.isArray(data) ? data[0] : data) as CloudRow | undefined;
  const success = Boolean(row?.out_success);
  const doc = typeof row?.out_document_number === 'string' ? row.out_document_number : '';
  const serverError = typeof row?.out_error === 'string' ? row.out_error : '';

  if (!success || !doc) {
    return {
      ok: false,
      kind: 'invalid',
      messageAr: serverError || 'لم يُنفَّذ التحويل على الخادم.',
    };
  }
  return { ok: true, documentNumber: doc };
}

export type CloudTransferOptions = {
  warehouses: CoreMasterRecord[];
  items: CoreMasterRecord[];
};

/** Loads the pickers for the transfer form (read-only RPCs). */
export async function loadTransferOptions(): Promise<
  { ok: true; data: CloudTransferOptions } | { ok: false; kind: CloudFailureKind; messageAr: string }
> {
  const warehouses = await readCoreMaster('warehouses');
  if (!warehouses.ok) return { ok: false, kind: warehouses.kind, messageAr: warehouses.messageAr };
  const items = await readCoreMaster('items');
  if (!items.ok) return { ok: false, kind: items.kind, messageAr: items.messageAr };

  return { ok: true, data: { warehouses: warehouses.data, items: items.data } };
}

/** Current stock of the selected item, so the user sees the cover before posting. */
export async function readCloudStock(itemId: string): Promise<
  { ok: true; data: CloudRow[] } | { ok: false; kind: CloudFailureKind; messageAr: string }
> {
  const res = await readCloudRpc('stock_on_hand', { p_warehouse_id: null });
  if (!res.ok) return { ok: false, kind: res.kind, messageAr: res.messageAr };
  return { ok: true, data: res.data.filter(r => String(r.item_id) === itemId) };
}
