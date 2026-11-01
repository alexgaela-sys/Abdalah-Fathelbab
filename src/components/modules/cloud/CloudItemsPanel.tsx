// Read-only cloud rendering of the ORIGINAL items screen (شاشة الأصناف).
//
// Mounted by ProductsMasterView when the screen runs in cloud mode. It reads the
// existing normalized ERP table core.items through the allowlisted, read-only
// bridge public.erp_core_master_read — no writes, no local store, no fallback.

import React, { useEffect, useState } from 'react';
import { AlertTriangle, Cloud, RefreshCw, Search, ShieldCheck, XCircle } from 'lucide-react';
import { readCoreMaster, type CoreMasterRecord } from '../../../services/coreMasterRead';

type Phase = 'loading' | 'ready' | 'error';

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));

export const CloudItemsPanel: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('loading');
  const [rows, setRows] = useState<CoreMasterRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setError(null);
    (async () => {
      const res = await readCoreMaster('items');
      if (cancelled) return;
      if (!res.ok) {
        setPhase('error');
        setError(res.messageAr);
        setRows([]);
        return;
      }
      setRows(res.data);
      setLoadedAt(new Date().toLocaleTimeString('ar-EG'));
      setPhase('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const filtered = rows.filter(r => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return r.code.toLowerCase().includes(q) || r.nameAr.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-slate-900">إدارة الأصناف والمنتجات</h2>
          <p className="text-xs text-slate-500 mt-1">
            المصدر:{' '}
            <span className="font-mono font-bold text-sky-700">
              {phase === 'ready' ? 'Supabase TEST · core.items' : 'لا يوجد مصدر (لم تُحمّل البيانات)'}
            </span>{' '}
            · قراءة فقط
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-1 rounded-lg bg-sky-50 border border-sky-200 text-[11px] font-bold text-sky-800 flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5" /> وضع القراءة فقط — لا إنشاء/تعديل/حذف
          </span>
          <button
            onClick={() => setReloadKey(k => k + 1)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold"
          >
            <RefreshCw className="w-3.5 h-3.5" /> إعادة المحاولة/التحميل
          </button>
        </div>
      </div>

      <div className="bg-white p-3 rounded-2xl border border-slate-200 flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث بالكود أو الاسم…"
            className="w-full pr-9 pl-3 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
          />
        </div>
        <span className="text-[11px] font-mono text-slate-500">
          {phase === 'ready' ? `rows=${filtered.length}/${rows.length}` : 'rows=—'}
          {loadedAt && phase === 'ready' ? ` · ${loadedAt}` : ''}
        </span>
      </div>

      {phase === 'loading' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-3 animate-pulse">
          <p className="text-xs font-bold text-slate-600">جارٍ تحميل الأصناف من Supabase TEST…</p>
          <p className="text-[11px] text-slate-500">
            لا تُعرض أي أصناف من التخزين المحلي أثناء التحميل، ولا يُستخدم بديل محلي.
          </p>
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="h-3 rounded bg-slate-100" style={{ width: `${95 - i * 15}%` }} />
          ))}
        </div>
      )}

      {phase === 'error' && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 space-y-2">
          <p className="text-xs font-black text-rose-800 flex items-center gap-2">
            <XCircle className="w-4 h-4" /> تعذّر تحميل الأصناف من السحابة — لا تُعرض أي بيانات محلية هنا.
          </p>
          <p className="text-[11px] text-rose-700 flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" /> {error}
          </p>
          <button
            onClick={() => setReloadKey(k => k + 1)}
            className="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-bold"
          >
            إعادة المحاولة
          </button>
        </div>
      )}

      {phase === 'ready' && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {filtered.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500">
              {rows.length === 0 ? 'لا توجد أصناف في core.items.' : 'لا نتائج مطابقة للبحث.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                  <tr>
                    <th className="p-3">الكود</th>
                    <th className="p-3">الاسم</th>
                    <th className="p-3">النوع</th>
                    <th className="p-3">ض.ق.م</th>
                    <th className="p-3">سعر التجزئة</th>
                    <th className="p-3">التكلفة المعيارية</th>
                    <th className="p-3">الحالة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map(item => (
                    <tr key={item.id} className="hover:bg-slate-50">
                      <td className="p-3 font-mono font-bold text-slate-800">{item.code}</td>
                      <td className="p-3 text-slate-800">{item.nameAr}</td>
                      <td className="p-3 text-slate-500 font-mono">{String(item.payload.item_type ?? '—')}</td>
                      <td className="p-3 font-mono">{num(item.payload.vat_rate) * 100}%</td>
                      <td className="p-3 font-mono">{num(item.payload.selling_price_retail).toFixed(2)}</td>
                      <td className="p-3 font-mono">{num(item.payload.standard_cost).toFixed(2)}</td>
                      <td className="p-3">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            item.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {item.active ? 'نشط' : 'موقوف'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <p className="text-[11px] text-slate-500 flex items-center gap-1">
        <Cloud className="w-3.5 h-3.5" />
        الأسعار والكميات هنا معروضة كما هي في السحابة؛ لا تُحسب تكاليف ولا تُنشأ حركات مخزون من هذه الشاشة.
      </p>
    </div>
  );
};
