// Cloud sales invoice posting and listing backed by Supabase TEST RPCs.
// This is the authoritative cloud path for sales invoices during the migration.
// It calls PostgREST RPCs over REST using the Supabase anon key and a
// fresh authenticated access token. It never exposes service_role/admin secrets.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { SalesChannel } from '../types/erp';

export type CloudSalesInvoiceRow = {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerNameAr: string;
  channel: SalesChannel;
  warehouseId: string;
  warehouseNameAr: string;
  paymentMethod: string;
  currency: 'EGP' | 'USD';
  exchangeRate: number;
  date: string;
  totalAmount: number;
  totalAmountEGP: number;
  withholdingAmountEGP: number;
  withholdingApplied: boolean;
  status: string;
  invoice: {
    invoiceNumber: string;
    customerNameAr: string;
    channel: SalesChannel;
    warehouseNameAr: string;
    paymentMethod: string;
    currency: 'EGP' | 'USD';
    exchangeRate: number;
    date: string;
    totalAmount: number;
    totalAmountEGP: number;
    withholdingAmountEGP: number;
    withholdingApplied: boolean;
  };
  customerName: string;
  journalNumber: string | null;
};

export type CloudSalesInvoiceDetail = {
  invoice: {
    invoiceNumber: string;
    customerNameAr: string;
    channel: SalesChannel;
    warehouseNameAr: string;
    paymentMethod: string;
    currency: 'EGP' | 'USD';
    exchangeRate: number;
    date: string;
    totalAmount: number;
    totalAmountEGP: number;
    withholdingAmountEGP: number;
    withholdingApplied: boolean;
  };
  lines: Array<{
    itemNameAr: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    vatRate: number;
    vatAmount: number;
  }>;
};

export type PostSalesInvoiceAction = {
  request: {
    customerId: string;
    channel: SalesChannel;
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
  };
  idempotencyKey: string;
  createdBy: string;
};

export type PostSalesInvoiceResult =
  | { ok: false; error: string }
  | { ok: true; invoiceId?: string; invoiceNumber?: string };

export interface ListSalesInvoicesParams {
  channel?: SalesChannel;
  currency?: 'EGP' | 'USD';
  search?: string;
  limit?: number;
}

export type ListSalesInvoicesResult =
  | { ok: false; error: string; code?: string }
  | { ok: true; data: CloudSalesInvoiceRow[] };

export interface GetSalesInvoiceParams {
  id: string;
}

export type GetSalesInvoiceResult =
  | { ok: false; error: string; code?: string }
  | { ok: true; data: CloudSalesInvoiceDetail };

// ---------- internal helpers ----------

function sanitizeMessage(m: unknown): string {
  if (m == null) return '';
  if (typeof m === 'string') return m.slice(0, 300);
  try {
    return String(m);
  } catch {
    return '[unable to serialize]';
  }
}

async function loadTestClient(): Promise<{ ok: true; supabase: SupabaseClient } | { ok: false; error: string }> {
  const mod = await import('./supabaseTestClient');
  if (!mod.supabaseTestConfigured()) {
    return { ok: false, error: 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.' };
  }
  const instance = mod.supabaseTestClient();
  if (!instance) return { ok: false, error: 'SUPABASE client not initialized' };
  return { ok: true, supabase: instance };
}

/**
 * Signs in the dedicated TEST ERP user and returns its access token.
 *
 * The credentials come from the shared TEST client helper, which resolves
 * process.env first (Node/tsx) and import.meta.env second (Vite/browser) —
 * so the browser and the scripts authenticate against the same account with
 * the same key names. Neither value is ever logged or echoed back.
 *
 * Fail-closed: without a configured TEST user there is no token, and the
 * caller gets an explicit error instead of an unauthenticated request.
 */
async function loadSignedSupabaseContext(): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const mod = await import('./supabaseTestClient');

  const email = mod.supabaseTestUserEmail();
  if (!email) return { ok: false, error: 'SUPABASE_TEST_USER_EMAIL not configured' };

  const password = mod.supabaseTestUserPassword();
  if (!password) {
    return { ok: false, error: 'SUPABASE_TEST_USER_PASSWORD not configured — cannot sign in to the cloud sales path' };
  }

  const result = await mod.signInSupabaseTest(email, password);
  if (!result.ok || !result.accessToken) {
    return { ok: false, error: result.ok ? 'signInSupabaseTest returned no token' : result.message };
  }
  return { ok: true, token: result.accessToken };
}

// The actual Supabase client shape we use internally is small and does not need
// the full SDK surface here; we call REST directly for the write path so the
// behavior is transparent and auditable. For reads we use the existing helper.

export async function listSalesInvoices(params: ListSalesInvoicesParams): Promise<ListSalesInvoicesResult> {
  const client = await loadTestClient();
  if (!client.ok) return { ok: false, error: client.error, code: 'cloud-disabled' };

  const {
    data,
    error,
  } = await client.supabase.rpc('list_sales_invoices', {
    p_from: null,
    p_to: null,
    p_channel: params.channel ?? null,
    p_currency: params.currency ?? null,
    p_search: params.search && params.search.trim() ? params.search.trim() : null,
    p_limit: params.limit ?? 100,
    p_offset: 0,
  });

  if (error) {
    const message = error.message ?? String(error);
    if (/not_authenticated/i.test(message)) return { ok: false, error: 'Session not authenticated', code: 'cloudnot-authenticated' };
    if (/permission denied|not_authorized|42501/i.test(message)) return { ok: false, error: 'Access denied', code: 'cloud-not-authorized' };
    return { ok: false, error: message, code: 'cloud-list-failed' };
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return {
    ok: true,
    data: rows.map(mapInvoiceRow),
  };
}

export async function getSalesInvoice(params: GetSalesInvoiceParams): Promise<GetSalesInvoiceResult> {
  const client = await loadTestClient();
  if (!client.ok) return { ok: false, error: client.error, code: 'cloud-disabled' };

  const { data, error } = await client.supabase.rpc('get_sales_invoice', { p_id: params.id });
  if (error) {
    const message = error.message ?? String(error);
    if (/not_authenticated/i.test(message)) return { ok: false, error: 'علمات المصادقة غير صالحة', code: 'cloudnot-authenticated' };
    if (/permission denied|not_authorized|42501/i.test(message)) return { ok: false, error: 'Access denied', code: 'cloud-not-authorized' };
    return { ok: false, error: message, code: 'cloud-get-failed' };
  }

  const row = (data ?? [])[0];
  if (!row || !row.invoice_id) return { ok: false, error: 'Invoice not found', code: 'cloud-not-found' };

  return {
    ok: true,
    data: {
      invoice: {
        invoiceNumber: String(row.invoice_number),
        customerNameAr: String(row.customer_name_ar ?? ''),
        channel: String(row.channel) as SalesChannel,
        warehouseNameAr: String(row.warehouse_name_ar ?? ''),
        paymentMethod: String(row.payment_method),
        currency: (String(row.currency) as 'EGP' | 'USD') || 'EGP',
        exchangeRate: Number(row.exchange_rate),
        date: String(row.invoice_date),
        totalAmount: Number(row.total_amount),
        totalAmountEGP: Number(row.total_amount_egp),
        withholdingAmountEGP: Number(row.withholding_amount_egp ?? 0),
        withholdingApplied: Boolean(row.withholding_applied),
      },
      lines: (row.lines as Array<Record<string, unknown>> ?? [])
        .map(line => ({
          itemNameAr: String(line.item_name_ar ?? ''),
          quantity: Number(line.quantity),
          unitPrice: Number(line.unit_price),
          lineTotal: Number(line.line_total),
          vatRate: Number(line.vat_rate),
          vatAmount: Number(line.vat_amount),
        })),
    },
  };
}

export async function postSalesInvoice(action: PostSalesInvoiceAction): Promise<PostSalesInvoiceResult> {
  const signed = await loadSignedSupabaseContext();
  if (!signed.ok) return { ok: false, error: signed.error };

  const endpoint = (await import('./supabaseTestClient')).supabaseTestEndpoint();
  const url = endpoint.url;
  const anonKey = endpoint.anonKey;
  const token = signed.token;
  if (!url || !anonKey) {
    return { ok: false, error: 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.' };
  }

  const body = {
    p_customer_id: action.request.customerId,
    p_channel: action.request.channel,
    p_warehouse_id: action.request.warehouseId,
    p_payment_method: action.request.paymentMethod,
    p_currency: action.request.currency,
    p_exchange_rate: action.request.exchangeRate,
    p_date: new Date(action.request.date).toISOString().slice(0, 10),
    p_lines: action.request.lines,
    p_created_by: action.createdBy,
    p_idempotency_key: action.idempotencyKey,
  };

  const urlObj = new URL('/rest/v1/rpc/post_sales_invoice', url);
  try {
    const res = await fetch(urlObj.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
        Authorization: `Bearer ${token}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    });

    const text = await res.text().catch(() => '');
    const rows = text ? (JSON.parse(text) as Array<Record<string, unknown>>) : [];

    if (!res.ok || rows.length === 0) {
      const firstError = String(rows[0]?.error ?? `HTTP ${res.status}`);
      if (/unauthorized/i.test(firstError) || /ERP role/i.test(firstError)) {
        return { ok: false, error: 'هذا الحساب غير مُصرَّح له بنشر الفواتير السحابية.' };
      }
      return { ok: false, error: String(firstError) };
    }

    const row = rows[0];
    if (!row.invoice_id || !row.invoice_number) {
      return { ok: false, error: 'لم يُعاد رأس الفاتورة من الخادم.' };
    }

    return {
      ok: true,
      invoiceId: String(row.invoice_id),
      invoiceNumber: String(row.invoice_number),
    };
  } catch (err) {
    const message = sanitizeMessage(err);
    if (/unauthorized/i.test(message) || /401/i.test(message)) {
      return { ok: false, error: 'جلسات المصادقة غير صالحة.' };
    }
    return { ok: false, error: `تعذّر الاتصال بالخادم: ${message}` };
  }
}

// ---------- internal ----------

function mapInvoiceRow(row: Record<string, unknown>): CloudSalesInvoiceRow {
  const invoiceNumber = String(row.invoice_number ?? '');
  const channel = String(row.channel ?? '') as SalesChannel;
  return {
    id: String(row.invoice_id ?? ''),
    invoiceNumber,
    customerId: String(row.customer_id ?? ''),
    customerNameAr: String(row.customer_name_ar ?? ''),
    channel,
    warehouseId: String(row.warehouse_id ?? ''),
    warehouseNameAr: String(row.warehouse_name_ar ?? ''),
    paymentMethod: String(row.payment_method ?? ''),
    currency: (String(row.currency ?? 'EGP') as 'EGP' | 'USD') || 'EGP',
    exchangeRate: Number(row.exchange_rate ?? 1),
    date: String(row.invoice_date ?? ''),
    totalAmount: Number(row.total_amount ?? 0),
    totalAmountEGP: Number(row.total_amount_egp ?? 0),
    withholdingAmountEGP: Number(row.withholding_amount_egp ?? 0),
    withholdingApplied: Boolean(row.withholding_applied),
    status: String(row.status ?? ''),
    invoice: {
      invoiceNumber,
      customerNameAr: String(row.customer_name_ar ?? ''),
      channel,
      warehouseNameAr: String(row.warehouse_name_ar ?? ''),
      paymentMethod: String(row.payment_method ?? ''),
      currency: (String(row.currency ?? 'EGP') as 'EGP' | 'USD') || 'EGP',
      exchangeRate: Number(row.exchange_rate ?? 1),
      date: String(row.invoice_date ?? ''),
      totalAmount: Number(row.total_amount ?? 0),
      totalAmountEGP: Number(row.total_amount_egp ?? 0),
      withholdingAmountEGP: Number(row.withholding_amount_egp ?? 0),
      withholdingApplied: Boolean(row.withholding_applied),
    },
    customerName: String(row.customer_name_ar ?? ''),
    journalNumber: row.journal_entry_number == null ? null : String(row.journal_entry_number),
  };
}
