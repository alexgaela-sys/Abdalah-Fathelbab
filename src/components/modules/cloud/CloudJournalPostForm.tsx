// Manual journal entry form (TEST only).
//
// The browser never decides accounting: it collects the lines and calls
// public.post_journal, which enforces the role gate, an OPEN accounting period,
// no header accounts, at least two lines, and debit = credit. Every refusal is
// shown verbatim; nothing is written when the server refuses.

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, Plus, Send, Trash2, XCircle } from 'lucide-react';
import {
  listPostingAccounts,
  postManualJournal,
  type PostingAccount,
} from '../../../services/cloudJournal';
import { cloudCan } from '../../../services/cloudUsers';
import { currentSupabaseTestUser } from '../../../services/supabaseTestClient';

type Line = { accountId: string; debit: string; credit: string };

type Banner = { tone: 'ok' | 'error' | 'warn'; text: string } | null;

const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const toNum = (v: string): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function CloudJournalPostForm({ onPosted }: { onPosted?: () => void }) {
  const [accounts, setAccounts] = useState<PostingAccount[]>([]);
  const [canPost, setCanPost] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string>('');
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<Line[]>([
    { accountId: '', debit: '', credit: '' },
    { accountId: '', debit: '', credit: '' },
  ]);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const [acc, perm, email] = await Promise.all([
      listPostingAccounts(),
      cloudCan('accounting', 'post'),
      currentSupabaseTestUser(),
    ]);
    setSessionEmail(email ?? '');
    setCanPost(perm.ok ? perm.data : false);
    if (!acc.ok) {
      setLoadError(acc.messageAr);
      return;
    }
    setAccounts(acc.data.filter(a => !a.isHeader));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const debitTotal = lines.reduce((s, l) => s + toNum(l.debit), 0);
  const creditTotal = lines.reduce((s, l) => s + toNum(l.credit), 0);
  const balanced = Math.abs(debitTotal - creditTotal) <= 0.01 && debitTotal > 0;

  const update = (index: number, patch: Partial<Line>) =>
    setLines(current => current.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const submit = async () => {
    setBusy(true);
    setBanner(null);
    const payload = lines
      .filter(l => l.accountId && (toNum(l.debit) > 0 || toNum(l.credit) > 0))
      .map(l => {
        const account = accounts.find(a => a.accountId === l.accountId);
        return {
          accountId: l.accountId,
          accountCode: account?.code ?? '',
          debit: toNum(l.debit),
          credit: toNum(l.credit),
        };
      });

    const res = await postManualJournal({
      date,
      reference,
      description,
      lines: payload,
      createdBy: sessionEmail || 'cloud-ui-journal',
    });
    setBusy(false);

    if (!res.ok) {
      setBanner({ tone: 'error', text: res.messageAr });
      return;
    }
    setBanner({ tone: 'ok', text: `رُحّل القيد ${res.data.entryNumber} بقيمة ${debitTotal.toFixed(2)} ج.م.` });
    setReference('');
    setDescription('');
    setLines([
      { accountId: '', debit: '', credit: '' },
      { accountId: '', debit: '', credit: '' },
    ]);
    onPosted?.();
  };

  if (loadError) {
    return (
      <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 space-y-1">
        <p className="text-xs font-black text-rose-800 flex items-center gap-1.5">
          <XCircle className="w-4 h-4" /> تعذّر تحميل دليل الحسابات.
        </p>
        <p className="text-[11px] text-rose-700">{loadError}</p>
      </div>
    );
  }

  if (!canPost) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-2.5 text-[11px] font-bold text-amber-900">
        دورك لا يملك ترحيل قيود اليومية (<span className="font-mono">accounting.post</span>) — النموذج مخفي والخادم يرفض أي محاولة.
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="p-3 border-b border-slate-200">
        <h3 className="text-sm font-black text-slate-900">قيد يومية يدوي</h3>
        <p className="text-[11px] text-slate-500">
          يُرحَّل عبر <span className="font-mono">public.post_journal</span>: يرفض الفترة المغلقة، والحسابات الرئيسية،
          والقيد غير المتزن، ويكتب سجل تدقيق لكل قيد.
        </p>
      </div>

      {banner && (
        <div
          className={`mx-3 mt-3 rounded-xl px-3 py-2 text-[11px] font-bold flex items-start gap-2 border ${
            banner.tone === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : banner.tone === 'error'
                ? 'border-rose-200 bg-rose-50 text-rose-800'
                : 'border-amber-200 bg-amber-50 text-amber-900'
          }`}
        >
          {banner.tone === 'ok' ? (
            <Check className="w-3.5 h-3.5 mt-0.5" />
          ) : (
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5" />
          )}
          <span>{banner.text}</span>
        </div>
      )}

      <div className="p-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="space-y-1">
          <span className="text-[11px] font-bold text-slate-600 block">التاريخ</span>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono"
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] font-bold text-slate-600 block">المرجع</span>
          <input
            value={reference}
            onChange={e => setReference(e.target.value)}
            placeholder="JV-MANUAL-001"
            className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px]"
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] font-bold text-slate-600 block">البيان</span>
          <input
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="بيان القيد"
            className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px]"
          />
        </label>
      </div>

      <div className="overflow-x-auto px-3">
        <table className="w-full text-right text-[11px]">
          <thead className="text-slate-600 border-b border-slate-200">
            <tr>
              <th className="p-2">الحساب</th>
              <th className="p-2 w-28">مدين</th>
              <th className="p-2 w-28">دائن</th>
              <th className="p-2 w-10" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map((line, index) => (
              <tr key={index}>
                <td className="p-2">
                  <select
                    value={line.accountId}
                    onChange={e => update(index, { accountId: e.target.value })}
                    className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px]"
                  >
                    <option value="">— اختر حسابًا —</option>
                    {accounts.map(a => (
                      <option key={a.accountId} value={a.accountId}>
                        {a.code} · {a.nameAr}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="p-2">
                  <input
                    inputMode="decimal"
                    value={line.debit}
                    onChange={e => update(index, { debit: e.target.value, credit: '' })}
                    className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono"
                  />
                </td>
                <td className="p-2">
                  <input
                    inputMode="decimal"
                    value={line.credit}
                    onChange={e => update(index, { credit: e.target.value, debit: '' })}
                    className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono"
                  />
                </td>
                <td className="p-2">
                  <button
                    onClick={() => setLines(current => (current.length > 2 ? current.filter((_, i) => i !== index) : current))}
                    disabled={lines.length <= 2}
                    className="p-1 rounded bg-slate-100 text-slate-500 disabled:opacity-30"
                    aria-label="حذف السطر"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className={balanced ? 'bg-emerald-50' : 'bg-slate-50'}>
            <tr>
              <td className="p-2 font-bold text-slate-600">الإجمالي</td>
              <td className="p-2 font-mono font-black text-slate-800">{debitTotal.toFixed(2)}</td>
              <td className="p-2 font-mono font-black text-slate-800">{creditTotal.toFixed(2)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="p-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200">
        <button
          onClick={() => setLines(current => [...current, { accountId: '', debit: '', credit: '' }])}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 text-[11px] font-bold"
        >
          <Plus className="w-3.5 h-3.5" /> سطر
        </button>
        <div className="flex items-center gap-2">
          <span className={`text-[11px] font-bold ${balanced ? 'text-emerald-700' : 'text-rose-700'}`}>
            {balanced ? 'القيد متزن' : 'القيد غير متزن'}
          </span>
          <button
            onClick={() => void submit()}
            disabled={busy || !balanced}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-black disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            ترحيل القيد
          </button>
        </div>
      </div>
    </div>
  );
}
