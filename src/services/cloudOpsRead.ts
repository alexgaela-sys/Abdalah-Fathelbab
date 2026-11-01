// Generic read-only bridge to the EXISTING TEST read RPCs (no new SQL, no
// duplicate functions). Used by the operational screens that previously had no
// cloud path (journal, inventory, purchasing, production, custody, payments).
//
// Guarantees:
//   * anon key only, session in memory (see supabaseTestClient),
//   * never imports erpDb and never touches localStorage,
//   * no silent fallback: a failure is returned as an explicit error,
//   * no write RPC is reachable from this module.

import { supabaseTestClient } from './supabaseTestClient';
import type { CloudFailureKind, CloudResult } from './masterDataCloudSlice';

export type CloudRow = Record<string, unknown>;

const CONFIG_MESSAGE = 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.';

function mapError(message: string): { kind: CloudFailureKind; messageAr: string } {
  if (/not_authenticated|JWT/i.test(message)) {
    return { kind: 'not_authenticated', messageAr: 'لا توجد جلسة سحابية صالحة — سجّل الدخول بحساب الاختبار.' };
  }
  if (/permission denied|not_authorized|42501|forbidden/i.test(message)) {
    return { kind: 'not_authorized', messageAr: 'هذا الحساب غير مُصرَّح له بقراءة هذه الوحدة.' };
  }
  if (/does not exist|could not find the function/i.test(message)) {
    return { kind: 'unknown', messageAr: `الدالة السحابية غير موجودة في TEST: ${message}` };
  }
  return { kind: 'network', messageAr: `تعذّرت القراءة من السحابة: ${message}` };
}

export async function readCloudRpc(
  rpc: string,
  params: Record<string, unknown> = {},
): Promise<CloudResult<CloudRow[]>> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  const { data, error } = await client.rpc(rpc, params);
  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: mapped.messageAr };
  }
  return { ok: true, data: (data ?? []) as CloudRow[] };
}
