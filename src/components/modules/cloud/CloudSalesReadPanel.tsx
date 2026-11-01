// Read-only cloud rendering of the ORIGINAL sales screen (قراءة فقط).
// Uses the existing public.list_sales_invoices RPC (Viewer), never erpDb,
// never localStorage, and exposes no create/update/cancel actions.

import React, { useEffect, useState } from 'react';
import { AlertTriangle, Cloud, RefreshCw, Search, ShieldCheck, XCircle } from 'lucide-react';
import { listCloudSalesInvoices, type CloudSalesInvoice } from '../../../services/cloudSalesRead';
import { CloudRpcPanel } from './CloudRpcPanel';
import { CloudSalesWritePanel } from './CloudSalesWritePanel';

type Phase = 'loading' | 'ready' | 'error';

const fmt = (n: number): string => n.toLocaleString('ar-EG', { maximumFractionDigits: 2 });

export const CloudSalesReadPanel: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('loading');
  const [rows, setRows] = useState<CloudSalesInvoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setError(null);
    (async () => {
      const res = await listCloudSalesInvoices(100, 0, search);
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
    })();
    return () => {
      cancelled = true;
    };
  }, [search, reloadKey]);

  const totalEgp = rows.reduce((s, r) => s + r.totalAmountEgp, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-slate-900">إدارة المبيعات والفواتير</h2>
          <p className="text-xs text-slate-500 mt-1">
            المصدر:{' '}
            <span className="font-mono font-bold text-sky-700">
              {phase === 'ready' ? 'Supabase TEST · sales.invoices (list_sales_invoices)' : 'لا يوجد مصدر (لم تُحمّل البيانات)'}
            </span>{' '}
            · قراءة + إصدار فاتورة (لأصحاب صلاحية الترحيل)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-1 rounded-lg bg-sky-50 border border-sky-200 text-[11px] font-bold text-sky-800 flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5" /> الإلغاء/التعديل غير متاح — الإصدار فقط
          </span>
          <button
            onClick={() => setReloadKey(k => k + 1)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold"
          >
            <RefreshCw className="w-3.5 h-3.5" /> إعادة المحاولة/التحميل
          </button>
        </div>
      </div>

      <div className="bg-white p-3 rounded-2xl border border-slate-200 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث برقم الفاتورة أو العميل…"
            className="w-full pr-9 pl-3 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
          />
        </div>
        <span className="text-[11px] font-mono text-slate-500">
          {phase === 'ready' ? `rows=${rows.length} · totalEGP=${fmt(totalEgp)}` : 'rows=—'}
          {loadedAt && phase === 'ready' ? ` · ${loadedAt}` : ''}
        </span>
      </div>

      <CloudSalesWritePanel onPosted={() => setReloadKey(k => k + 1)} />

      {phase === 'loading' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-3 animate-pulse">
          <p className="text-xs font-bold text-slate-600">جارٍ تحميل فواتير البيع من Supabase TEST…</p>
          <p className="text-[11px] text-slate-500">
            لا تُعرض أي فواتير من التخزين المحلي أثناء التحميل، ولا يُستخدم بديل محلي.
          </p>
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="h-3 rounded bg-slate-100" style={{ width: `${95 - i * 15}%` }} />
          ))}
        </div>
      )}

      {phase === 'error' && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 space-y-2">
          <p className="text-xs font-black text-rose-800 flex items-center gap-2">
            <XCircle className="w-4 h-4" /> تعذّر تحميل فواتير البيع من السحابة — لا تُعرض أي بيانات محلية هنا.
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
          {rows.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500">لا فواتير مطابقة في sales.invoices.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                  <tr>
                    <th className="p-3">الرقم</th>
                    <th className="p-3">التاريخ</th>
                    <th className="p-3">العميل</th>
                    <th className="p-3">القناة</th>
                    <th className="p-3">العملة</th>
                    <th className="p-3">قبل الضريبة</th>
                    <th className="p-3">الضريبة</th>
                    <th className="p-3">الإجمالي</th>
                    <th className="p-3">بالجنيه</th>
                    <th className="p-3">COGS</th>
                    <th className="p-3">القيد</th>
                    <th className="p-3">الحالة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map(r => (
                    <tr key={r.invoiceId} className="hover:bg-slate-50">
                      <td className="p-3 font-mono font-bold text-slate-800">{r.invoiceNumber}</td>
                      <td className="p-3 font-mono text-slate-500">{r.invoiceDate}</td>
                      <td className="p-3 text-slate-800">{r.customerName || r.customerId}</td>
                      <td className="p-3 text-slate-500">{r.channel}</td>
                      <td className="p-3 font-mono">{r.currency}</td>
                      <td className="p-3 font-mono">{fmt(r.subtotal)}</td>
                      <td className="p-3 font-mono">{fmt(r.vatAmount)}</td>
                      <td className="p-3 font-mono font-bold">{fmt(r.totalAmount)}</td>
                      <td className="p-3 font-mono">{fmt(r.totalAmountEgp)}</td>
                      <td className="p-3 font-mono text-amber-700">{fmt(r.cogsTotal)}</td>
                      <td className="p-3 font-mono text-slate-500">{r.journalNumber ?? '—'}</td>
                      <td className="p-3">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700">
                          {r.status}
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
        الفواتير التي تُرحَّل من النموذج أعلاه تحمل COGS فعليًا من صرف FIFO على الخادم؛ الفواتير القديمة
        (قبل ربط دالة الترحيل المتكاملة) قد تظهر بـ COGS = 0 لأنها لم تُصرف مخزنيًا.
      </p>

      <CloudRpcPanel
        title="مرتجعات المبيعات"
        sourceLabel="sales.returns (list_sales_returns)"
        rpc="list_sales_returns"
        params={{ p_from: null, p_to: null, p_limit: 100, p_offset: 0 }}
        searchKeys={['return_number', 'customer_id', 'reason', 'status']}
        columns={[
          { key: 'return_number', labelAr: 'رقم المرتجع' },
          { key: 'invoice_id', labelAr: 'الفاتورة' },
          { key: 'customer_id', labelAr: 'العميل' },
          { key: 'return_date', labelAr: 'التاريخ', kind: 'date' },
          { key: 'total_amount', labelAr: 'الإجمالي', kind: 'money' },
          { key: 'total_vat', labelAr: 'الضريبة', kind: 'money' },
          { key: 'status', labelAr: 'الحالة' },
        ]}
        footerNote="قراءة فقط؛ إنشاء المرتجع يحتاج مسار كتابة مخزني/محاسبي ذري لم يُفعّل بعد."
      />
    </div>
  );
};
