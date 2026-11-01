// TEST-ONLY proof of concept: ONE JSON document in Supabase with server-side
// compare-and-swap (optimistic concurrency).
//
// Hard boundaries of this module:
//   * talks to the TEST project only (configured via VITE_SUPABASE_URL /
//     VITE_SUPABASE_ANON_KEY). No service_role, no admin secret, ever.
//   * never imports erpDb, never touches localStorage, never reads or uploads
//     abdullah_erp_db_v1, never flips the app into cloud data mode.
//   * there is NO silent fallback: every failure is returned to the caller with
//     an explicit reason so the POC panel can show it.
//   * all writes are done by the SQL function public.erp_doc_cas, which
//     enforces auth, the writer allowlist and the version predicate atomically.

import {
  currentSupabaseTestUser,
  signInSupabaseTest,
  signOutSupabaseTest,
  supabaseTestClient,
  supabaseTestConfigured,
} from './supabaseTestClient';

export const POC_SCOPE = 'snakdip-test-poc';
export const POC_DOC_KEY = 'erp-db-poc-default';

export type PocDocument = {
  scope: string;
  docKey: string;
  version: number;
  payload: unknown;
  updatedAt: string | null;
};

export type PocFailureKind =
  | 'config'
  | 'not_authenticated'
  | 'not_authorized'
  | 'conflict'
  | 'invalid'
  | 'network'
  | 'unknown';

export type PocResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: PocFailureKind; messageAr: string; currentVersion?: number | null };

export function pocConfigured(): boolean {
  return supabaseTestConfigured();
}

function getClient(): PocResult<import('@supabase/supabase-js').SupabaseClient> {
  const client = supabaseTestClient();
  if (!client) {
    return {
      ok: false,
      kind: 'config',
      messageAr: 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.',
    };
  }
  return { ok: true, data: client };
}

const STATUS_MESSAGES: Record<string, { kind: PocFailureKind; messageAr: string }> = {
  not_authenticated: { kind: 'not_authenticated', messageAr: 'لا توجد جلسة سحابية صالحة — سجّل الدخول بحساب الاختبار.' },
  not_authorized: { kind: 'not_authorized', messageAr: 'هذا الحساب غير مُدرج في قائمة كتاب POC لهذا المشروع.' },
  conflict: { kind: 'conflict', messageAr: 'تعارض نسخ: السجل تغيّر بعد آخر قراءة — أعد التحميل ثم أعد المحاولة.' },
  invalid_scope: { kind: 'invalid', messageAr: 'نطاق غير مسموح: POC يعمل فقط على snakdip-test-poc.' },
  invalid_key: { kind: 'invalid', messageAr: 'مفتاح المستند غير صالح.' },
  invalid_payload: { kind: 'invalid', messageAr: 'الحِمل JSON غير صالح.' },
  payload_too_large: { kind: 'invalid', messageAr: 'حجم المستند يتجاوز 256 كيلوبايت.' },
  invalid_expected_version: { kind: 'invalid', messageAr: 'رقم النسخة المتوقعة غير صالح.' },
};

function storageFailureMessage(kind: PocFailureKind, fallback: string): string {
  if (kind === 'network') return `تعذّر الاتصال بـ Supabase TEST: ${fallback}`;
  return fallback;
}

export async function signInPoc(email: string, password: string): Promise<PocResult<{ email: string | null }>> {
  const res = await signInSupabaseTest(email, password);
  if (!res.ok) return { ok: false, kind: 'not_authenticated', messageAr: res.message };
  return { ok: true, data: { email: res.email } };
}

export async function signOutPoc(): Promise<void> {
  await signOutSupabaseTest();
}

export async function currentPocUser(): Promise<string | null> {
  return currentSupabaseTestUser();
}

export async function loadPocDoc(key: string = POC_DOC_KEY): Promise<PocResult<PocDocument | null>> {
  const c = getClient();
  if (!c.ok) return c;

  const { data, error } = await c.data
    .from('erp_json_documents')
    .select('scope, doc_key, version, payload, updated_at')
    .eq('scope', POC_SCOPE)
    .eq('doc_key', key)
    .maybeSingle();

  if (error) {
    return { ok: false, kind: 'network', messageAr: `تعذّرت قراءة المستند: ${error.message}` };
  }
  if (!data) return { ok: true, data: null };

  return {
    ok: true,
    data: {
      scope: data.scope as string,
      docKey: data.doc_key as string,
      version: Number(data.version),
      payload: data.payload,
      updatedAt: (data.updated_at as string) ?? null,
    },
  };
}

export async function savePocDoc(
  expectedVersion: number,
  payload: unknown,
  key: string = POC_DOC_KEY,
): Promise<PocResult<{ status: string; version: number | null }>> {
  const c = getClient();
  if (!c.ok) return c;

  const { data, error } = await c.data.rpc('erp_doc_cas', {
    p_scope: POC_SCOPE,
    p_doc_key: key,
    p_expected_version: expectedVersion,
    p_payload: payload,
  });

  if (error) {
    return { ok: false, kind: 'network', messageAr: storageFailureMessage('network', `تعذّر تنفيذ الحفظ: ${error.message}`) };
  }

  const row = Array.isArray(data) ? data[0] : data;
  const status = String(row?.status ?? 'unknown');
  const version = row?.version === null || row?.version === undefined ? null : Number(row.version);

  if (status === 'created' || status === 'updated') {
    return { ok: true, data: { status, version } };
  }

  const mapped = STATUS_MESSAGES[status] ?? {
    kind: 'unknown' as PocFailureKind,
    messageAr: `نتيجة غير متوقعة من الخادم: ${status}`,
  };
  return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr, currentVersion: version };
}

/** Synthetic demo payload — never derived from localStorage or real ERP data. */
export function makeSyntheticDoc(seed = Date.now()): Record<string, unknown> {
  return {
    kind: 'snakdip-poc-synthetic',
    note: 'بيانات اختبار مصطنعة للتحقق من الحفظ والقراءة والتزامن فقط',
    seed,
    counter: 1,
    sample: {
      warehouses: [{ code: 'POC-WH-1', nameAr: 'مستودع اختبار' }],
      items: [{ code: 'POC-ITEM-1', nameAr: 'صنف اختبار', price: 12.5 }],
      totals: { subtotal: 125, vat: 17.5, total: 142.5, currency: 'EGP' },
    },
  };
}
