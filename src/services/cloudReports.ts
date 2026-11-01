// Cloud report reads (TEST only) for the reports screen.
//
// Every figure comes from a server-side aggregate:
//   * public.profit_and_loss            — sections + subtotals, POSTED lines only,
//   * public.trial_balance              — pre-existing RPC (posted lines only),
//   * public.inventory_movement_report  — opening / in / out / closing per
//                                         item+warehouse from the perpetual ledger.
//
// Rules kept from the rest of the cloud layer:
//   * never imports erpDb and never touches localStorage,
//   * no client-side money arithmetic — amounts are returned, not recomputed,
//   * no fallback: a failed load is an explicit error, never local numbers.

import { readCloudRpc, type CloudRow } from './cloudOpsRead';
import type { CloudResult } from './masterDataCloudSlice';

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown, fallback = ''): string =>
  v === null || v === undefined ? fallback : String(v);
const strOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

export type ProfitLossLine = {
  lineType: 'account' | 'subtotal';
  section: string;
  sortOrder: number;
  labelAr: string;
  accountCode: string | null;
  amount: number;
};

export async function loadProfitAndLoss(
  from: string | null,
  to: string | null,
): Promise<CloudResult<ProfitLossLine[]>> {
  const res = await readCloudRpc('profit_and_loss', { p_from: from, p_to: to });
  if (!res.ok) return res;
  return {
    ok: true,
    data: res.data.map((r: CloudRow) => ({
      lineType: str(r.line_type, 'account') === 'subtotal' ? 'subtotal' : 'account',
      section: str(r.section),
      sortOrder: num(r.sort_order),
      labelAr: str(r.label_ar),
      accountCode: strOrNull(r.account_code),
      amount: num(r.amount),
    })),
  };
}

export type TrialBalanceLine = {
  accountId: string;
  accountCode: string;
  accountNameAr: string;
  category: string;
  debit: number;
  credit: number;
  netDebit: number;
};

export async function loadTrialBalance(
  from: string | null,
  to: string | null,
): Promise<CloudResult<TrialBalanceLine[]>> {
  const res = await readCloudRpc('trial_balance', { p_from: from, p_to: to });
  if (!res.ok) return res;
  return {
    ok: true,
    data: res.data.map((r: CloudRow) => ({
      accountId: str(r.account_id),
      accountCode: str(r.account_code),
      accountNameAr: str(r.account_name_ar),
      category: str(r.category),
      debit: num(r.debit),
      credit: num(r.credit),
      netDebit: num(r.net_debit),
    })),
  };
}

export type InventoryMovementLine = {
  itemId: string;
  itemCode: string;
  itemNameAr: string;
  warehouseId: string;
  warehouseCode: string;
  openingQty: number;
  qtyIn: number;
  qtyOut: number;
  closingQty: number;
  movementValue: number;
};

export async function loadInventoryMovement(
  from: string | null,
  to: string | null,
): Promise<CloudResult<InventoryMovementLine[]>> {
  const res = await readCloudRpc('inventory_movement_report', { p_from: from, p_to: to });
  if (!res.ok) return res;
  return {
    ok: true,
    data: res.data.map((r: CloudRow) => ({
      itemId: str(r.item_id),
      itemCode: str(r.item_code),
      itemNameAr: str(r.item_name_ar),
      warehouseId: str(r.warehouse_id),
      warehouseCode: str(r.warehouse_code),
      openingQty: num(r.opening_qty),
      qtyIn: num(r.qty_in),
      qtyOut: num(r.qty_out),
      closingQty: num(r.closing_qty),
      movementValue: num(r.movement_value),
    })),
  };
}

/** Inclusive period covering a month, as yyyy-mm-dd (server does the filtering). */
export function monthRange(reference = new Date()): { from: string; to: string } {
  const first = new Date(reference.getFullYear(), reference.getMonth(), 1);
  const last = new Date(reference.getFullYear(), reference.getMonth() + 1, 0);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: iso(first), to: iso(last) };
}
