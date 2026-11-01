// Audit trail screen (TEST only). Read-only: audit rows are append-only and the
// internal writer is revoked from clients.
//
// Source: public.list_audit_log (SECURITY DEFINER, gated on audit.view) — the
// table audit.app_audit_log is not readable directly by the browser.

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ClipboardList, Filter, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { AUDIT_ACTIONS, AUDIT_MODULES, listAuditLog, type AuditRow } from '../../../services/cloudAudit';

const fmtDate = (iso: string): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
};

const jsonPreview = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  try {
    const text = JSON.stringify(value);
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  } catch {
    return '';
  }
};

export function CloudAuditPanel() {
  const [module, setModule] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    setError(null);
    const res = await listAuditLog({
      module: module || null,
      action: action || null,
      from: from || null,
      to: to || null,
      limit: 500,
    });
    if (!res.ok) {
      setPhase('error');
      setError(res.messageAr);
      return;
    }
    setRows(res.data);
    setPhase('ready');
  }, [module, action, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-slate-900 flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-sky-600" /> سجل العمليات (Audit Log)
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            المصدر: <span className="font-mono">audit.app_audit_log</span> عبر{' '}
            <span className="font-mono">list_audit_log</span> — قراءة فقط وبصلاحية{' '}
            <span className="font-mono">audit.view</span>. السجل غير قابل للتعديل أو الحذف من العميل.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-bold"
        >
          <RefreshCw className="w-3.5 h-3.5" /> تحديث
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap items-end gap-3">
        <span className="text-[11px] font-bold text-slate-500 flex items-center gap-1 pb-2">
          <Filter className="w-3.5 h-3.5" /> تصفية
        </span>
        <label className="space-y-1">
          <span className="text-[11px] font-bold text-slate-600 block">الوحدة</span>
          <select
            value={module}
            onChange={e => setModule(e.target.value)}
            className="p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px]"
          >
            {AUDIT_MODULES.map(m => (
              <option key={m.key || 'all'} value={m.key}>{m.labelAr}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[11px] font-bold text-slate-600 block">العملية</span>
          <select
            value={action}
            onChange={e => setAction(e.target.value)}
            className="p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px]"
          >
            {AUDIT_ACTIONS.map(a => (
              <option key={a.key || 'all'} value={a.key}>{a.labelAr}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[11px] font-bold text-slate-600 block">من</span>
          <input
            type="date"
            value={from}
            onChange={e => setFrom(e.target.value)}
            className="p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono"
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] font-bold text-slate-600 block">إلى</span>
          <input
            type="date"
            value={to}
            onChange={e => setTo(e.target.value)}
            className="p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono"
          />
        </label>
        <span className="text-[10px] font-mono text-slate-500 pb-2">
          {phase === 'ready' ? `rows=${rows.length}` : 'rows=—'}
        </span>
      </div>

      {phase === 'loading' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 flex items-center gap-2 text-xs text-slate-600">
          <Loader2 className="w-4 h-4 animate-spin" /> جارٍ تحميل سجل العمليات من TEST…
        </div>
      )}

      {phase === 'error' && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 space-y-2">
          <p className="text-xs font-black text-rose-800 flex items-center gap-1.5">
            <XCircle className="w-4 h-4" /> تعذّر تحميل السجل — لا تُعرض أي بيانات محلية بديلة.
          </p>
          <p className="text-[11px] text-rose-700 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> {error}
          </p>
        </div>
      )}

      {phase === 'ready' && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {rows.length === 0 ? (
            <p className="p-5 text-center text-[11px] text-slate-500">لا صفوف مطابقة للتصفية.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-[11px]">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                  <tr>
                    <th className="p-2.5">الوقت</th>
                    <th className="p-2.5">المستخدم</th>
                    <th className="p-2.5">الوحدة</th>
                    <th className="p-2.5">العملية</th>
                    <th className="p-2.5">البيان</th>
                    <th className="p-2.5">السجل</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map(r => {
                    const diff = jsonPreview(r.newValue);
                    return (
                      <tr key={r.auditId} className="hover:bg-slate-50 align-top">
                        <td className="p-2.5 font-mono text-slate-500 whitespace-nowrap">{fmtDate(r.occurredAt)}</td>
                        <td className="p-2.5 text-slate-700">
                          {r.userName || r.userId || '—'}
                          {r.userId && r.userName ? (
                            <div className="font-mono text-[9px] text-slate-400">{r.userId}</div>
                          ) : null}
                        </td>
                        <td className="p-2.5 font-mono text-slate-600">{r.module || '—'}</td>
                        <td className="p-2.5">
                          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] font-bold text-slate-700">
                            {r.action || '—'}
                          </span>
                        </td>
                        <td className="p-2.5 text-slate-700 max-w-[420px]">
                          {r.description || '—'}
                          {diff && (
                            <div className="font-mono text-[9px] text-slate-400 mt-0.5 break-all" dir="ltr">
                              {diff}
                            </div>
                          )}
                        </td>
                        <td className="p-2.5 font-mono text-[10px] text-slate-500">
                          {r.recordTable || '—'}
                          {r.recordId && <div className="text-slate-400">{r.recordId}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="px-4 py-2 text-[10px] text-slate-500 border-t border-slate-100">
            السجل يُكتب من دوال الخادم فقط (ترحيل، إضافة، تعديل) ولا يمكن تعديله أو حذفه من الواجهة.
          </p>
        </div>
      )}
    </div>
  );
}
