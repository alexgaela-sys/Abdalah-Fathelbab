// Cloud sales invoice form — the OTHER writable cloud screen.
//
// Every submit goes to public.post_sales_invoice_integrated, which posts the
// invoice, the sales journal, the FIFO stock issue and the COGS journal in ONE
// server transaction and rolls everything back on any failure. Nothing here
// computes a posting locally: the totals shown before submit are a preview, and
// the invoice number shown after submit is the number the SERVER returned.
//
// The card is rendered only for a role the server gate accepts
// (Super Admin / Chief Accountant AND can_write_inventory()), so a Viewer never
// sees a form that would be refused anyway.

import React, { useEffect, useMemo, useState } from 'react';
import { CloudUpload, Loader2, Plus, ReceiptText, Trash2, XCircle } from 'lucide-react';
import {
  loadSalesOptions,
  postCloudSalesInvoice,
  readCloudSalesRole,
  type CloudSalesLineInput,
  type CloudSalesOptions,
  type CloudSalesPosted,
} from '../../../services/cloudSalesWrite';

type Phase = 'loading' | 'ready' | 'denied' | 'error';

const fmt = (n: number): string => n.toLocaleString('ar-EG', { maximumFractionDigits: 2 });
const todayIso = (): string => new Date().toISOString().slice(0, 10);

type LineRow = CloudSalesLineInput & { key: string };

const emptyLine = (): LineRow => ({
  key: crypto.randomUUID(),
  itemId: '',
  quantity: 1,
  unitPrice: 0,
  discount: 0,
  vatRate: 0.14,
});

export const CloudSalesWritePanel: React.FC<{ onPosted?: () => void }> = ({ onPosted }) => {
  const [phase, setPhase] = useState<Phase>('loading');
  const [role, setRole] = useState('');
  const [opts, setOpts] = useState<CloudSalesOptions | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState('');
  const [channel, setChannel] = useState<'retail' | 'wholesale' | 'export'>('retail');
  const [warehouseId, setWarehouseId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'credit' | 'bank_transfer' | 'cheque'>('cash');
  const [currency, setCurrency] = useState<'EGP' | 'USD'>('EGP');
  const [exchangeRate, setExchangeRate] = useState(1);
  const [date, setDate] = useState(todayIso());
  const [lines, setLines] = useState<LineRow[]>([emptyLine()]);

  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<CloudSalesPosted | null>(null);
  const [postError, setPostError] = useState<string | null>(null);

  const load = async () => {
    setPhase('loading');
    setError(null);
    const r = await readCloudSalesRole();
    if (!r.ok) {
      setPhase('error');
      setError(r.messageAr);
      return;
    }
    setRole(r.role);
    if (!r.canPostSales) {
      setPhase('denied');
      return;
    }
    const o = await loadSalesOptions();
    if (!o.ok) {
      setPhase('error');
      setError(o.messageAr);
      return;
    }
    setOpts(o.data);
    if (o.data.warehouses.length > 0) setWarehouseId(prev => prev || o.data.warehouses[0].id);
    if (o.data.customers.length > 0) setCustomerId(prev => prev || o.data.customers[0].id);
    setPhase('ready');
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchLine = (key: string, patch: Partial<LineRow>) =>
    setLines(prev => prev.map(l => (l.key === key ? { ...l, ...patch } : l)));

  const vatFor = (itemId: string): number => {
    const item = opts?.items.find(i => i.id === itemId);
    const raw = item?.payload?.vat_rate;
    const n = typeof raw === 'number' ? raw : Number(raw ?? 0.14);
    return Number.isFinite(n) && n > 0 ? n : 0.14;
  };

  /** Same arithmetic the server uses for the preview only. */
  const preview = useMemo(() => {
    let subtotal = 0;
    let vat = 0;
    for (const l of lines) {
      if (!l.itemId || !(l.quantity > 0)) continue;
      const net = l.quantity * l.unitPrice * (1 - (l.discount || 0) / 100);
      subtotal += net;
      vat += net * (l.vatRate || 0);
    }
    return { subtotal, vat, total: subtotal + vat };
  }, [lines]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setPosted(null);
    setPostError(null);

    const res = await postCloudSalesInvoice({
      customerId,
      channel,
      warehouseId,
      paymentMethod,
      currency,
      exchangeRate: currency === 'EGP' ? 1 : exchangeRate,
      date,
      lines: lines.map(({ itemId, quantity, unitPrice, discount, vatRate }) => ({
        itemId,
        quantity,
        unitPrice,
        discount,
        vatRate,
      })),
    });

    setBusy(false);
    if (res.ok) {
      setPosted(res.data);
      onPosted?.();
    } else {
      setPostError(res.messageAr);
    }
  };

  const warehouses = opts?.warehouses ?? [];
  const readOnlyNote = (
    <p className="text-[10px] text-slate-400">
      لا يُكتب أي شيء في التخزين المحلي: الفاتورة والقيدان وحركة المخزون تُنفَّذ على الخادم فقط، أو لا شيء.
    </p>
  );

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between gap-3 p-4 border-b border-slate-200">
        <div>
          <h3 className="text-sm font-black text-slate-900 flex items-center gap-2">
            <ReceiptText className="w-4 h-4" /> فاتورة بيع سحابية
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            الكتابة عبر{' '}
            <span className="font-mono font-bold text-sky-700">post_sales_invoice_integrated</span> — فاتورة +
            قيد مبيعات + صرف FIFO + قيد تكلفة في معاملة واحدة.
          </p>
        </div>
        <span className="px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 text-[10px] font-bold text-amber-800">
          كتابة
        </span>
      </div>

      {phase === 'loading' && (
        <div className="p-4 space-y-2 animate-pulse">
          <p className="text-xs font-bold text-slate-600">جارٍ قراءة دورك وبيانات العملاء والمستودعات…</p>
          <div className="h-3 rounded bg-slate-100 w-2/3" />
          <div className="h-3 rounded bg-slate-100 w-1/2" />
        </div>
      )}

      {phase === 'error' && (
        <div className="p-4 bg-rose-50 space-y-2">
          <p className="text-[11px] font-black text-rose-800 flex items-center gap-1.5">
            <XCircle className="w-3.5 h-3.5" /> تعذّر إتاحة إصدار الفاتورة — لا بديل محلي.
          </p>
          <p className="text-[11px] text-rose-700">{error}</p>
          <button
            onClick={() => void load()}
            className="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-[11px] font-bold"
          >
            إعادة المحاولة
          </button>
        </div>
      )}

      {phase === 'denied' && (
        <div className="p-4 bg-slate-50">
          <p className="text-[11px] text-slate-600">
            دورك الحالي <b>{role || 'غير معروف'}</b> لا يملك صلاحية ترحيل فواتير البيع — يرفضه الخادم
            (Super Admin / Chief Accountant + صلاحية مخزون)، ولذلك لا يُعرض النموذج.
          </p>
        </div>
      )}

      {phase === 'ready' && opts && (
        <form onSubmit={submit} className="p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600">العميل</span>
              <select
                value={customerId}
                onChange={e => setCustomerId(e.target.value)}
                className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs"
                required
              >
                <option value="">— اختر —</option>
                {opts.customers.map(c => (
                  <option key={c.id} value={c.id}>{c.code} · {c.nameAr}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600">المستودع (مصدر الصرف)</span>
              <select
                value={warehouseId}
                onChange={e => setWarehouseId(e.target.value)}
                className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs"
                required
              >
                <option value="">— اختر —</option>
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>{w.code} · {w.nameAr}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600">القناة</span>
              <select
                value={channel}
                onChange={e => setChannel(e.target.value as typeof channel)}
                className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs"
              >
                <option value="retail">تجزئة</option>
                <option value="wholesale">جملة</option>
                <option value="export">تصدير</option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600">طريقة السداد</span>
              <select
                value={paymentMethod}
                onChange={e => setPaymentMethod(e.target.value as typeof paymentMethod)}
                className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs"
              >
                <option value="cash">نقدي</option>
                <option value="credit">آجل (ذمم)</option>
                <option value="bank_transfer">تحويل بنكي</option>
                <option value="cheque">شيك</option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600">التاريخ</span>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs font-mono"
                required
              />
            </label>

            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600">العملة</span>
              <select
                value={currency}
                onChange={e => {
                  const c = e.target.value as 'EGP' | 'USD';
                  setCurrency(c);
                  if (c === 'EGP') setExchangeRate(1);
                }}
                className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs"
              >
                <option value="EGP">EGP</option>
                <option value="USD">USD</option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600">سعر الصرف</span>
              <input
                type="number"
                min={0.0001}
                step={0.01}
                value={exchangeRate}
                onChange={e => setExchangeRate(Number(e.target.value))}
                disabled={currency === 'EGP'}
                className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs font-mono disabled:opacity-60"
              />
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-black text-slate-700">البنود</span>
              <button
                type="button"
                onClick={() => setLines(prev => [...prev, emptyLine()])}
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-100 text-slate-700 text-[11px] font-bold"
              >
                <Plus className="w-3.5 h-3.5" /> إضافة بند
              </button>
            </div>

            {lines.map((l, idx) => (
              <div key={l.key} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end bg-slate-50/60 rounded-xl p-2">
                <label className="sm:col-span-4 space-y-1">
                  <span className="text-[10px] font-bold text-slate-500">الصنف #{idx + 1}</span>
                  <select
                    value={l.itemId}
                    onChange={e => {
                      const itemId = e.target.value;
                      const item = opts.items.find(i => i.id === itemId);
                      const price = Number(item?.payload?.selling_price_retail ?? 0);
                      patchLine(l.key, {
                        itemId,
                        vatRate: vatFor(itemId),
                        unitPrice: price > 0 ? price : l.unitPrice,
                      });
                    }}
                    className="w-full p-2 rounded-lg bg-white border border-slate-200 text-xs"
                    required
                  >
                    <option value="">— اختر —</option>
                    {opts.items.map(i => (
                      <option key={i.id} value={i.id}>{i.code} · {i.nameAr}</option>
                    ))}
                  </select>
                </label>

                <label className="sm:col-span-2 space-y-1">
                  <span className="text-[10px] font-bold text-slate-500">الكمية</span>
                  <input
                    type="number"
                    min={0.0001}
                    step="any"
                    value={l.quantity}
                    onChange={e => patchLine(l.key, { quantity: Number(e.target.value) })}
                    className="w-full p-2 rounded-lg bg-white border border-slate-200 text-xs font-mono"
                    required
                  />
                </label>

                <label className="sm:col-span-2 space-y-1">
                  <span className="text-[10px] font-bold text-slate-500">سعر الوحدة</span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={l.unitPrice}
                    onChange={e => patchLine(l.key, { unitPrice: Number(e.target.value) })}
                    className="w-full p-2 rounded-lg bg-white border border-slate-200 text-xs font-mono"
                    required
                  />
                </label>

                <label className="sm:col-span-1 space-y-1">
                  <span className="text-[10px] font-bold text-slate-500">خصم %</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step="any"
                    value={l.discount}
                    onChange={e => patchLine(l.key, { discount: Number(e.target.value) })}
                    className="w-full p-2 rounded-lg bg-white border border-slate-200 text-xs font-mono"
                  />
                </label>

                <label className="sm:col-span-1 space-y-1">
                  <span className="text-[10px] font-bold text-slate-500">ضريبة</span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={l.vatRate}
                    onChange={e => patchLine(l.key, { vatRate: Number(e.target.value) })}
                    className="w-full p-2 rounded-lg bg-white border border-slate-200 text-xs font-mono"
                  />
                </label>

                <div className="sm:col-span-2 flex items-center justify-end gap-1 pb-1">
                  <button
                    type="button"
                    onClick={() => setLines(prev => (prev.length > 1 ? prev.filter(x => x.key !== l.key) : prev))}
                    disabled={lines.length === 1}
                    className="p-1.5 rounded-lg bg-white border border-slate-200 text-rose-600 disabled:opacity-30"
                    title="حذف البند"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
            <div className="text-[11px] text-slate-600 font-mono">
              قبل الضريبة {fmt(preview.subtotal)} · ضريبة {fmt(preview.vat)} ·{' '}
              <b>إجمالي {fmt(preview.total)} {currency}</b>
            </div>
            <button
              type="submit"
              disabled={busy || !customerId || !warehouseId || !date}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 text-white text-[11px] font-black disabled:opacity-40"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudUpload className="w-3.5 h-3.5" />}
              ترحيل الفاتورة على الخادم
            </button>
          </div>

          {posted && (
            <div className="text-[11px] rounded-lg p-3 bg-emerald-50 text-emerald-900 border border-emerald-200 space-y-1">
              <p className="font-black">تم الترحيل — الفاتورة {posted.invoiceNumber}</p>
              <p className="font-mono">
                COGS {fmt(posted.cogs)} · قيد التكلفة {posted.cogsJournalNumber || '—'} · الحالة {posted.status}
              </p>
              <p className="text-[10px] text-emerald-800">
                قيد المبيعات وحركة الصرف المرحّلة موجودة على الخادم؛ راجع الجدول أدناه بعد التحديث.
              </p>
            </div>
          )}

          {postError && (
            <div className="text-[11px] rounded-lg p-3 bg-rose-50 text-rose-800 border border-rose-200 space-y-1">
              <p className="font-black flex items-center gap-1.5">
                <XCircle className="w-3.5 h-3.5" /> لم تُرحَّل الفاتورة — تراجع الخادم بالكامل
              </p>
              <p dir="auto">{postError}</p>
            </div>
          )}

          {readOnlyNote}
        </form>
      )}
    </div>
  );
};
