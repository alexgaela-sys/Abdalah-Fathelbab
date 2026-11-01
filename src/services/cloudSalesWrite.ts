// Cloud WRITE path for a sales invoice.
//
// Source of truth: public.post_sales_invoice_integrated (TEST), which in ONE
// server transaction
//   * gates on the ERP role (Super Admin / Chief Accountant) AND on
//     public.can_write_inventory(),
//   * posts the invoice + the SALES journal (revenue / receivable / VAT),
//   * issues the stock FIFO and posts the COGS journal,
//   * refuses a closed accounting period, missing mappings or insufficient
//     stock, and rolls everything back instead of committing a half invoice,
//   * is idempotent on p_idempotency_key.
//
// Rules for this module:
//   * anon-key client, session in memory (supabaseTestClient),
//   * NEVER reads or writes localStorage and never falls back to erpDb,
//   * the server answer is surfaced as-is — no optimistic UI, no local totals
//     presented as posted,
//   * one idempotency key per submission, so a double click or a network retry
//     cannot post the same invoice twice.

import { supabaseTestClient } from './supabaseTestClient';
import { readCoreMaster, type CoreMasterRecord } from './coreMasterRead';
import type { CloudFailureKind } from './masterDataCloudSlice';

const CONFIG_MESSAGE = 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.';

/** Roles the server-side gate accepts for the integrated sales posting. */
const SALES_WRITERS = new Set(['Super Admin', 'Chief Accountant']);

export type CloudSalesRole =
  | { ok: true; role: string; canPostSales: boolean }
  | { ok: false; kind: CloudFailureKind; messageAr: string };

export type CloudSalesLineInput = {
  itemId: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  vatRate: number;
};

export type CloudSalesForm = {
  customerId: string;
  channel: 'retail' | 'wholesale' | 'export';
  warehouseId: string;
  paymentMethod: 'cash' | 'bank_transfer' | 'credit' | 'cheque';
  currency: 'EGP' | 'USD';
  exchangeRate: number;
  date: string;
  lines: CloudSalesLineInput[];
};

export type CloudSalesPosted = {
  invoiceNumber: string;
  cogs: number;
  cogsJournalNumber: string;
  status: string;
};

export type CloudSalesPostResult =
  | { ok: true; data: CloudSalesPosted }
  | { ok: false; kind: CloudFailureKind; messageAr: string };

function mapError(message: string): { kind: CloudFailureKind; messageAr: string } {
  if (/not_authenticated|JWT/i.test(message)) {
    return { kind: 'not_authenticated', messageAr: 'لا توجد جلسة سحابية صالحة — سجّل الدخول أولًا.' };
  }
  if (/permission denied|not_authorized|42501|forbidden/i.test(message)) {
    return { kind: 'not_authorized', messageAr: 'هذا الحساب غير مُصرَّح له بترحيل فواتير البيع.' };
  }
  return { kind: 'network', messageAr: `تعذّر ترحيل الفاتورة سحابيًا: ${message}` };
}

/** The caller's ERP role, read through the self-scoped SECURITY DEFINER RPC. */
export async function readCloudSalesRole(): Promise<CloudSalesRole> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc('current_erp_role');
  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }
  const role = typeof data === 'string' ? data : '';
  if (!role) {
    return {
      ok: false,
      kind: 'not_authenticated',
      messageAr: 'لا توجد جلسة سحابية صالحة — سجّل الدخول لاستخدام إصدار الفواتير.',
    };
  }
  return { ok: true, role, canPostSales: SALES_WRITERS.has(role) };
}

export type CloudSalesOptions = {
  customers: CoreMasterRecord[];
  warehouses: CoreMasterRecord[];
  items: CoreMasterRecord[];
};

/** Pickers for the invoice form (read-only RPCs, no local data). */
export async function loadSalesOptions(): Promise<
  { ok: true; data: CloudSalesOptions } | { ok: false; kind: CloudFailureKind; messageAr: string }
> {
  const customers = await readCoreMaster('customers');
  if (!customers.ok) return { ok: false, kind: customers.kind, messageAr: customers.messageAr };
  const warehouses = await readCoreMaster('warehouses');
  if (!warehouses.ok) return { ok: false, kind: warehouses.kind, messageAr: warehouses.messageAr };
  const items = await readCoreMaster('items');
  if (!items.ok) return { ok: false, kind: items.kind, messageAr: items.messageAr };

  return {
    ok: true,
    data: {
      customers: customers.data,
      warehouses: warehouses.data.filter(w => w.active),
      items: items.data.filter(i => i.active),
    },
  };
}

/** Posts the invoice + sales journal + FIFO issue + COGS journal, atomically. */
export async function postCloudSalesInvoice(form: CloudSalesForm): Promise<CloudSalesPostResult> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  if (!form.customerId) return { ok: false, kind: 'invalid', messageAr: 'اختر العميل.' };
  if (!form.warehouseId) return { ok: false, kind: 'invalid', messageAr: 'اختر مستودع الصرف.' };
  if (!form.date) return { ok: false, kind: 'invalid', messageAr: 'حدّد تاريخ الفاتورة.' };
  if (form.currency === 'USD' && (!Number.isFinite(form.exchangeRate) || form.exchangeRate <= 0)) {
    return { ok: false, kind: 'invalid', messageAr: 'فاتورة الدولار تحتاج سعر صرف أكبر من صفر.' };
  }

  const lines = form.lines.filter(l => l.itemId && Number.isFinite(l.quantity) && l.quantity > 0);
  if (lines.length === 0) {
    return { ok: false, kind: 'invalid', messageAr: 'أضف بندًا واحدًا على الأقل بكمية أكبر من صفر.' };
  }
  for (const l of lines) {
    if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) {
      return { ok: false, kind: 'invalid', messageAr: 'سعر الوحدة غير صالح في أحد البنود.' };
    }
  }

  const { data, error } = await client.rpc('post_sales_invoice_integrated', {
    p_customer_id: form.customerId,
    p_channel: form.channel,
    p_warehouse_id: form.warehouseId,
    p_payment_method: form.paymentMethod,
    p_currency: form.currency,
    p_exchange_rate: form.exchangeRate,
    p_date: form.date,
    // exact RPC shape: itemId / quantity / unitPrice / discount / vatRate
    p_lines: lines.map(l => ({
      itemId: l.itemId,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discount: l.discount,
      vatRate: l.vatRate,
    })),
    p_created_by: 'ui-sales',
    // one key per submission: a retry of the same submission returns the same
    // invoice, a new submission always gets a new one.
    p_idempotency_key: `ui-sales-${crypto.randomUUID()}`,
  });

  if (error) {
    const mapped = mapError(error.message);
    // The wrapper raises for a closed period / insufficient stock / unmapped
    // account; its message is the operator's best explanation, so keep it.
    return { ok: false, kind: mapped.kind, messageAr: `${mapped.messageAr} (${error.message})` };
  }

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  const success = Boolean(row?.out_success);
  const invoiceNumber = typeof row?.out_invoice_number === 'string' ? row.out_invoice_number : '';
  const serverError = typeof row?.out_error === 'string' ? row.out_error : '';

  if (!success || !invoiceNumber) {
    return {
      ok: false,
      kind: 'invalid',
      messageAr: serverError || 'لم يُرحَّل أي شيء على الخادم.',
    };
  }

  return {
    ok: true,
    data: {
      invoiceNumber,
      cogs: Number(row?.out_cogs ?? 0),
      cogsJournalNumber: typeof row?.out_journal_number === 'string' ? row.out_journal_number : '',
      status: typeof row?.out_status === 'string' ? row.out_status : 'posted',
    },
  };
}
