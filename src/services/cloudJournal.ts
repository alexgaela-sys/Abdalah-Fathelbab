// Manual journal entry (TEST only) — thin client for the EXISTING server RPC.
//
// No accounting rule is implemented in the browser: public.post_journal (which
// calls fin.post_journal) already enforces
//   * the ERP role gate (Super Admin / Chief Accountant),
//   * an open accounting period (a closed period refuses the entry),
//   * no posting to a header/group account,
//   * at least two lines, non-negative amounts, debit = credit within 0.01,
//   * idempotency, and an audit row per posted entry.
// This module only collects the payload and surfaces the server's message.

import { readCloudRpc, type CloudRow } from './cloudOpsRead';
import { supabaseTestClient } from './supabaseTestClient';
import type { CloudFailureKind, CloudResult } from './masterDataCloudSlice';

const CONFIG_MESSAGE = 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY في بيئة التطوير.';

export type PostingAccount = {
  accountId: string;
  code: string;
  nameAr: string;
  category: string;
  isHeader: boolean;
};

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export async function listPostingAccounts(): Promise<CloudResult<PostingAccount[]>> {
  const res = await readCloudRpc('list_posting_accounts', {});
  if (!res.ok) return res;
  return {
    ok: true,
    data: res.data.map((r: CloudRow) => ({
      accountId: str(r.account_id),
      code: str(r.code),
      nameAr: str(r.name_ar),
      category: str(r.category),
      isHeader: Boolean(r.is_header),
    })),
  };
}

export type JournalLineInput = {
  accountId: string;
  accountCode: string;
  debit: number;
  credit: number;
  description?: string;
};

export type ManualJournalInput = {
  date: string;
  reference: string;
  description: string;
  lines: JournalLineInput[];
  createdBy: string;
};

export type ManualJournalPosted = {
  entryId: string;
  entryNumber: string;
};

export type ManualJournalResult =
  | { ok: true; data: ManualJournalPosted }
  | { ok: false; kind: CloudFailureKind; messageAr: string };

function mapError(message: string): { kind: CloudFailureKind; messageAr: string } {
  if (/not_authenticated|JWT/i.test(message)) {
    return { kind: 'not_authenticated', messageAr: 'لا توجد جلسة سحابية صالحة — سجّل الدخول أولًا.' };
  }
  if (/permission denied|not_authorized|42501|forbidden/i.test(message)) {
    return { kind: 'not_authorized', messageAr: 'هذا الحساب غير مُصرَّح له بترحيل قيود اليومية.' };
  }
  return { kind: 'network', messageAr: `تعذّر ترحيل القيد: ${message}` };
}

export async function postManualJournal(input: ManualJournalInput): Promise<ManualJournalResult> {
  const client = supabaseTestClient();
  if (!client) return { ok: false, kind: 'config', messageAr: CONFIG_MESSAGE };

  if (!input.date) return { ok: false, kind: 'invalid', messageAr: 'حدّد تاريخ القيد.' };
  if (input.lines.length < 2) {
    return { ok: false, kind: 'invalid', messageAr: 'القيد يحتاج طرفين على الأقل (مدين ودائن).' };
  }
  for (const line of input.lines) {
    if (!line.accountId) return { ok: false, kind: 'invalid', messageAr: 'اختر حسابًا لكل سطر.' };
    if (!Number.isFinite(line.debit) || !Number.isFinite(line.credit) || line.debit < 0 || line.credit < 0) {
      return { ok: false, kind: 'invalid', messageAr: 'المبالغ يجب أن تكون أرقامًا غير سالبة.' };
    }
    if (line.debit === 0 && line.credit === 0) {
      return { ok: false, kind: 'invalid', messageAr: 'كل سطر يحتاج مبلغ مدين أو دائن.' };
    }
  }

  // the server validates balance again; this only avoids a pointless round-trip
  const debit = input.lines.reduce((s, l) => s + l.debit, 0);
  const credit = input.lines.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(debit - credit) > 0.01) {
    return {
      ok: false,
      kind: 'invalid',
      messageAr: `القيد غير متزن: مدين ${debit.toFixed(2)} مقابل دائن ${credit.toFixed(2)}.`,
    };
  }

  const { data, error } = await client.rpc('post_journal', {
    p_date: input.date,
    p_reference: input.reference,
    p_description: input.description,
    p_source_document_type: 'manual_journal',
    p_lines: input.lines.map(l => ({
      accountId: l.accountId,
      accountCode: l.accountCode,
      debit: l.debit,
      credit: l.credit,
      description: l.description ?? '',
    })),
    p_created_by: input.createdBy,
    p_idempotency_key: `ui-journal-${crypto.randomUUID()}`,
  });

  if (error) {
    const mapped = mapError(error.message);
    return { ok: false, kind: mapped.kind, messageAr: `${mapped.messageAr} (${error.message})` };
  }

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  const success = Boolean(row?.success);
  const entryNumber = str(row?.entry_number);
  const entryId = str(row?.entry_id);

  if (!success || !entryNumber) {
    return {
      ok: false,
      kind: 'invalid',
      messageAr: str(row?.error) || 'لم يُرحَّل القيد على الخادم.',
    };
  }

  return { ok: true, data: { entryId, entryNumber } };
}
