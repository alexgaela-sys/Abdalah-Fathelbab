// Read-only cloud table shared by the ORIGINAL operational screens.
//
// It renders ONE existing read RPC (never a write RPC), shows an explicit
// loading / error / retry / empty state, prints the exact source it is reading,
// and never falls back to local data.

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Cloud, RefreshCw, Search, ShieldCheck, XCircle } from 'lucide-react';
import { readCloudRpc, type CloudRow } from '../../../services/cloudOpsRead';

export type CloudColumnKind = 'text' | 'number' | 'money' | 'date';

export type CloudColumn = {
  key: string;
  labelAr: string;
  kind?: CloudColumnKind;
};

type Phase = 'loading' | 'ready' | 'error';

const fmtNum = (v: unknown): string =>
  v === null || v === undefined || v === ''
    ? '—'
    : Number(v).toLocaleString('ar-EG', { maximumFractionDigits: 2 });

const renderCell = (value: unknown, kind: CloudColumnKind | undefined): string => {
  if (value === null || value === undefined || value === '') return '—';
  if (kind === 'number') return fmtNum(value);
  if (kind === 'money') return `${fmtNum(value)} ج.م`;
  return String(value);
};

export const CloudRpcPanel: React.FC<{
  title: string;
  sourceLabel: string;
  rpc: string;
  params?: Record<string, unknown>;
  columns: CloudColumn[];
  searchKeys?: string[];
  hint?: string;
  footerNote?: string;
  onLoaded?: (rows: CloudRow[]) => void;
  /** Bump this after a write to reload the list. */
  refreshToken?: number;
}> = ({ title, sourceLabel, rpc, params, columns, searchKeys, hint, footerNote, onLoaded, refreshToken = 0 }) => {
  const [phase, setPhase] = useState<Phase>('loading');
  const [rows, setRows] = useState<CloudRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  // Params are positional RPC arguments; a stable key keeps the effect from
  // re-firing on every render.
  const paramsKey = useMemo(() => JSON.stringify(params ?? {}), [params]);
  const stableParams = useMemo(() => JSON.parse(paramsKey) as Record<string, unknown>, [paramsKey]);

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setError(null);
    (async () => {
      const res = await readCloudRpc(rpc, stableParams);
      if (cancelled) return;
      if (!res.ok) {
        setRows([]);
        setPhase('error');
        setError(res.messageAr);
        return;
      }
      setRows(res.data);
      setLoadedAt(new Date().toLocaleTimeString('ar-EG'));
      setPhase('ready');
      onLoaded?.(res.data);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, paramsKey, reloadKey, refreshToken]);

  const keys = searchKeys ?? columns.map(c => c.key);
  const q = search.trim().toLowerCase();
  const filtered = q
    ? rows.filter(r => keys.some(k => String(r[k] ?? '').toLowerCase().includes(q)))
    : rows;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 border-b border-slate-200">
        <div className="min-w-0">
          <h3 className="text-sm font-black text-slate-900">{title}</h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            المصدر:{' '}
            <span className="font-mono font-bold text-sky-700">
              {phase === 'ready' ? `Supabase TEST · ${sourceLabel}` : 'لا يوجد مصدر (لم تُحمّل البيانات)'}
            </span>
          </p>
          {hint && <p className="text-[11px] text-slate-400 mt-0.5">{hint}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="px-2 py-1 rounded-lg bg-sky-50 border border-sky-200 text-[10px] font-bold text-sky-800 flex items-center gap-1">
            <ShieldCheck className="w-3 h-3" /> قراءة فقط
          </span>
          <button
            onClick={() => setReloadKey(k => k + 1)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-bold"
          >
            <RefreshCw className="w-3 h-3" /> تحديث
          </button>
        </div>
      </div>

      <div className="p-3 flex flex-wrap items-center gap-3 border-b border-slate-100">
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-2.5" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="بحث…"
            className="w-full pr-8 pl-2 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px]"
          />
        </div>
        <span className="text-[10px] font-mono text-slate-500">
          {phase === 'ready' ? `rows=${filtered.length}/${rows.length}` : 'rows=—'}
          {phase === 'ready' && loadedAt ? ` · ${loadedAt}` : ''}
        </span>
      </div>

      {phase === 'loading' && (
        <div className="p-4 space-y-2 animate-pulse">
          <p className="text-[11px] font-bold text-slate-600">جارٍ تحميل {title} من Supabase TEST…</p>
          {[0, 1, 2].map(i => (
            <div key={i} className="h-3 rounded bg-slate-100" style={{ width: `${95 - i * 18}%` }} />
          ))}
        </div>
      )}

      {phase === 'error' && (
        <div className="p-4 space-y-2 bg-rose-50">
          <p className="text-[11px] font-black text-rose-800 flex items-center gap-1.5">
            <XCircle className="w-3.5 h-3.5" /> تعذّر تحميل {title} — لا تُعرض أي بيانات محلية هنا.
          </p>
          <p className="text-[11px] text-rose-700 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> {error}
          </p>
          <button
            onClick={() => setReloadKey(k => k + 1)}
            className="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-[11px] font-bold"
          >
            إعادة المحاولة
          </button>
        </div>
      )}

      {phase === 'ready' && (
        filtered.length === 0 ? (
          <div className="p-5 text-center text-[11px] text-slate-500">
            {rows.length === 0 ? `لا توجد صفوف بعد في ${sourceLabel}.` : 'لا نتائج مطابقة للبحث.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-[11px]">
              <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                <tr>
                  {columns.map(c => (
                    <th key={c.key} className="p-2.5 whitespace-nowrap">{c.labelAr}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((r, idx) => (
                  <tr key={String(r.id ?? r[columns[0]?.key] ?? idx)} className="hover:bg-slate-50">
                    {columns.map(c => (
                      <td
                        key={c.key}
                        className={`p-2.5 ${c.kind === 'money' || c.kind === 'number' || c.kind === 'date' ? 'font-mono' : ''} text-slate-700`}
                      >
                        {renderCell(r[c.key], c.kind)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      <p className="px-4 py-2 text-[10px] text-slate-500 flex items-center gap-1 border-t border-slate-100">
        <Cloud className="w-3 h-3" />
        {footerNote ?? 'قراءة فقط من المخطط السحابي؛ لا كتابة ولا رجوع تلقائي للبيانات المحلية عند الفشل.'}
      </p>
    </div>
  );
};
