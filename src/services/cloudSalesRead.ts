// Read-only client for the existing sales read RPC (TEST only).
//
// Reuses public.list_sales_invoices — no duplicate RPC, no local store, no write
// path. The RPC is already guarded by RLS/role checks (Viewer can read).

import { supabaseTestClient, signInSupabaseTest } from './supabaseTestClient';
import type { CloudFailureKind, CloudResult } from './masterDataCloudSlice';

export type CloudSalesInvoice = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  customerId: string;
  customerName: string;
  channel: string;
  warehouseId: string;
  currency: string;
  subtotal: number;
  vatAmount: number;
  totalAmount: number;
  totalAmountEgp: number;
  cogsTotal: number;
  status: string;
  journalNumber: string | null;
  lineCount: number;
};

const CONFIG_MESSAGE = 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.';

function mapError(message: string): { kind: CloudFailureKind; messageAr: string } {
  if (/not_authenticated/i.test(message)) {
    return { kind: 'not_authenticated', messageAr: 'لا توجد جلسة سحابية صالحة لقراءة المبيعات.' };
  }
  if (/permission denied|not_authorized|42501/i.test(message)) {
    return { kind: 'not_authorized', messageAr: 'هذا الحساب غير مُصرَّح له بقراءة المبيعات السحابية.' };
  }
  return { kind: 'network', messageAr: `تعذّرت قراءة المبيعات: ${message}` };
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export async function listCloudSalesInvoices(
  limit = 100,
  offset = 0,
  search: string | null = null,
): Promise<CloudResult<CloudSalesInvoice[]>> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc('list_sales_invoices', {
    p_from: null,
    p_to: null,
    p_channel: null,
    p_currency: null,
    p_search: search && search.trim() ? search.trim() : null,
    p_limit: limit,
    p_offset: offset,
  });

  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return {
    ok: true,
    data: rows.map(r => ({
      invoiceId: str(r.invoice_id),
      invoiceNumber: str(r.invoice_number),
      invoiceDate: str(r.invoice_date),
      customerId: str(r.customer_id),
      customerName: str(r.customer_name_ar),
      channel: str(r.channel),
      warehouseId: str(r.warehouse_id),
      currency: str(r.currency),
      subtotal: num(r.subtotal),
      vatAmount: num(r.vat_amount),
      totalAmount: num(r.total_amount),
      totalAmountEgp: num(r.total_amount_egp),
      cogsTotal: num(r.cogs_total),
      status: str(r.status),
      journalNumber: r.journal_entry_number === null || r.journal_entry_number === undefined
        ? null
        : String(r.journal_entry_number),
      lineCount: num(r.line_count),
    })),
  };
}

export type PostSalesInvoiceDraft = {
  customerId: string;
  channel: 'retail' | 'wholesale' | 'export';
  warehouseId: string;
  paymentMethod: string;
  currency: 'EGP' | 'USD';
  exchangeRate: number;
  date: string;
  lines: Array<{
    itemId: string;
    quantity: number;
    freeQuantity: number;
    unitPrice: number;
    discount: number;
    vatRate: number;
  }>;
  createdBy: string;
  idempotencyKey?: string;
};

export type PostSalesInvoiceResult =
  | { ok: false; error: string; code?: string }
  | {
      ok: true;
      invoiceId: string;
      invoiceNumber: string;
      journalEntryId: string | null;
      status: string;
    };

export async function postSalesInvoice(
  payload: PostSalesInvoiceDraft,
  accessToken: string,
): Promise<PostSalesInvoiceResult> {
  const env = (import.meta.env as unknown as { VITE_SUPABASE_URL?: string; VITE_SUPABASE_ANON_KEY?: string }) || {};
  const url = env.VITE_SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_ANON_KEY;

  if (!url || !anonKey || !accessToken) {
    return { ok: false, error: 'مسار نشر الفاتورة السحابية غير مُثبت.', code: 'cloud-not-configured' };
  }

  const body = {
    p_customer_id: payload.customerId,
    p_channel: payload.channel,
    p_warehouse_id: payload.warehouseId,
    p_payment_method: payload.paymentMethod,
    p_currency: payload.currency,
    p_exchange_rate: payload.exchangeRate,
    p_date: new Date(payload.date).toISOString().slice(0, 10),
    p_lines: payload.lines,
    p_created_by: payload.createdBy,
    p_idempotency_key: payload.idempotencyKey ?? ('cloud:' + Date.now()),
  };

  const urlObj = new URL('/rest/v1/rpc/post_sales_invoice', url);
  try {
    const res = await fetch(urlObj.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    });

    const text = await res.text().catch(() => '');
    const rows = text ? (JSON.parse(text) as Array<Record<string, unknown>>) : [];

    if (!res.ok || rows.length === 0) {
      const firstError = String(rows[0]?.error ?? `HTTP ${res.status}`);
      if (/unauthorized/i.test(firstError) || /ليس مُصرَّحًا/i.test(firstError) || /ERP role/i.test(firstError)) {
        return { ok: false, error: 'هذا الحساب غير مُصرَّح له بنشر الفواتير السحابية.', code: 'cloud-not-authorized' };
      }
      return { ok: false, error: String(firstError), code: 'cloud-post-failed' };
    }

    const row = rows[0];
    if (!row.invoice_id || !row.invoice_number) {
      return { ok: false, error: 'لم يُعاد رأس الفاتورة من الخادم.', code: 'cloud-post-bad-shape' };
    }

    return {
      ok: true,
      invoiceId: String(row.invoice_id),
      invoiceNumber: String(row.invoice_number),
      journalEntryId: row.journal_entry_id == null ? null : String(row.journal_entry_id),
      status: String(row.status ?? ''),
    };
  } catch (err) {
    const message = err && typeof err === 'object' && 'message' in err ? String((err as { message: string }).message) : sanitizeAny(err);
    if (/unauthorized/i.test(message) || /401/i.test(message)) {
      return { ok: false, error: 'جلسات المصادقة غير صالحة.', code: 'cloud-auth-expired' };
    }
    return { ok: false, error: `تعذّر الاتصال بالخادم: ${message}`, code: 'cloud-network' };
  }
}

function sanitizeAny(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, 200);
  try {
    return String(value);
  } catch {
    return '[unable to serialize]';
  }
}
