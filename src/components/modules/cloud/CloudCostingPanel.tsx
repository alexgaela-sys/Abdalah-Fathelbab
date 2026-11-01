// Standard cost rates (TEST only).
//
// Master data only: an active rate is appended, an existing one is expired.
// No valuation or journal is created here — a standard cost affects accounting
// only through production completion, which is still blocked on mappings.

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Coins, Loader2, RefreshCw, XCircle } from 'lucide-react';
import {
  COST_TYPES,
  createCloudCostRate,
  expireCloudCostRate,
  listCloudCostRates,
  type CloudCostRate,
  type CloudCostType,
} from '../../../services/cloudCosting';
import { readCoreMaster, type CoreMasterRecord } from '../../../services/coreMasterRead';
import { cloudCan } from '../../../services/cloudUsers';

const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const money = (v: number): string => v.toLocaleString('ar-EG', { maximumFractionDigits: 4 });

type Banner = { tone: 'ok' | 'error'; text: string } | null;

export function CloudCostingPanel() {
  const [rows, setRows] = useState<CloudCostRate[]>([]);
  const [items, setItems] = useState<CoreMasterRecord[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [costType, setCostType] = useState<CloudCostType>('electricity');
  const [nameAr, setNameAr] = useState('كهرباء');
  const [family, setFamily] = useState('');
  const [productId, setProductId] = useState('');
  const [baseQuantity, setBaseQuantity] = useState('1000');
  const [rate, setRate] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(today());

  const load = useCallback(async () => {
    setPhase('loading');
    setError(null);
    const [rates, it, createPerm, editPerm] = await Promise.all([
      listCloudCostRates(null),
      readCoreMaster('items'),
      cloudCan('costing', 'create'),
      cloudCan('costing', 'edit'),
    ]);
    if (!rates.ok) {
      setPhase('error');
      setError(rates.messageAr);
      return;
    }
    setRows(rates.data);
    setItems(it.ok ? it.data.filter(i => i.active) : []);
    setCanCreate(createPerm.ok ? createPerm.data : false);
    setCanEdit(editPerm.ok ? editPerm.data : false);
    setPhase('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    setBusyId('new');
    setBanner(null);
    const res = await createCloudCostRate({
      costType,
      costTypeNameAr: nameAr || COST_TYPES.find(c => c.key === costType)?.labelAr || costType,
      productFamily: family,
      productId: productId || null,
      baseQuantity: Number(baseQuantity),
      rate: Number(rate),
      effectiveFrom,
    });
    setBusyId(null);
    if (!res.ok) {
      setBanner({ tone: 'error', text: res.messageAr });
      return;
    }
    setBanner({ tone: 'ok', text: res.data.messageAr });
    setRate('');
    await load();
  };

  const expire = async (row: CloudCostRate) => {
    setBusyId(row.rateId);
    setBanner(null);
    const res = await expireCloudCostRate(row.rateId, today());
    setBusyId(null);
    if (!res.ok) {
      setBanner({ tone: 'error', text: res.messageAr });
      return;
    }
    setBanner({ tone: 'ok', text: res.data.messageAr });
    await load();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-slate-900 flex items-center gap-2">
            <Coins className="w-5 h-5 text-sky-600" /> التكاليف المعيارية
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            المصدر: <span className="font-mono">core.standard_cost_rates</span> — بيانات رئيسية قابلة للإضافة
            ولإنهاء السريان، ومُدقَّقة في سجل العمليات. لا تُنشئ تقييمًا ولا قيدًا بذاتها.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-bold"
        >
          <RefreshCw className="w-3.5 h-3.5" /> تحديث
        </button>
      </div>

      {banner && (
        <div
          className={`rounded-2xl px-4 py-2.5 text-[11px] font-bold flex items-start gap-2 border ${
            banner.tone === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-rose-200 bg-rose-50 text-rose-800'
          }`}
        >
          {banner.tone === 'ok' ? <Check className="w-3.5 h-3.5 mt-0.5" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5" />}
          <span>{banner.text}</span>
        </div>
      )}

      {canCreate && phase === 'ready' && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="p-3 border-b border-slate-200">
            <h3 className="text-sm font-black text-slate-900">معدل تكلفة جديد</h3>
          </div>
          <div className="p-3 grid grid-cols-1 sm:grid-cols-4 gap-3">
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600 block">نوع التكلفة</span>
              <select
                value={costType}
                onChange={e => {
                  const next = e.target.value as CloudCostType;
                  setCostType(next);
                  setNameAr(COST_TYPES.find(c => c.key === next)?.labelAr ?? next);
                }}
                className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px]"
              >
                {COST_TYPES.map(c => (
                  <option key={c.key} value={c.key}>{c.labelAr}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600 block">الاسم</span>
              <input
                value={nameAr}
                onChange={e => setNameAr(e.target.value)}
                className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600 block">عائلة المنتج (اختياري)</span>
              <input
                value={family}
                onChange={e => setFamily(e.target.value)}
                className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600 block">الصنف (اختياري)</span>
              <select
                value={productId}
                onChange={e => setProductId(e.target.value)}
                className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px]"
              >
                <option value="">— عام —</option>
                {items.map(i => (
                  <option key={i.id} value={i.id}>{i.code} · {i.nameAr}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600 block">الكمية الأساسية</span>
              <input
                inputMode="decimal"
                value={baseQuantity}
                onChange={e => setBaseQuantity(e.target.value)}
                className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600 block">المعدل (ج.م)</span>
              <input
                inputMode="decimal"
                value={rate}
                onChange={e => setRate(e.target.value)}
                className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600 block">ساري من</span>
              <input
                type="date"
                value={effectiveFrom}
                onChange={e => setEffectiveFrom(e.target.value)}
                className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono"
              />
            </label>
            <div className="flex items-end">
              <button
                onClick={() => void submit()}
                disabled={busyId === 'new' || rate === ''}
                className="flex items-center gap-1 px-3 py-2 rounded-lg bg-slate-900 text-white text-[11px] font-black disabled:opacity-40"
              >
                {busyId === 'new' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                إضافة المعدل
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === 'loading' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 flex items-center gap-2 text-xs text-slate-600">
          <Loader2 className="w-4 h-4 animate-spin" /> جارٍ تحميل التكاليف المعيارية…
        </div>
      )}

      {phase === 'error' && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 space-y-2">
          <p className="text-xs font-black text-rose-800 flex items-center gap-1.5">
            <XCircle className="w-4 h-4" /> تعذّر تحميل التكاليف المعيارية — لا بديل محلي.
          </p>
          <p className="text-[11px] text-rose-700">{error}</p>
        </div>
      )}

      {phase === 'ready' && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="p-3 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-black text-slate-900">المعدلات</h3>
            <span className="text-[10px] font-mono text-slate-500">rows={rows.length}</span>
          </div>
          {rows.length === 0 ? (
            <p className="p-5 text-center text-[11px] text-slate-500">لا معدلات تكلفة بعد.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-[11px]">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                  <tr>
                    <th className="p-2.5">النوع</th>
                    <th className="p-2.5">الصنف / العائلة</th>
                    <th className="p-2.5">الكمية الأساس</th>
                    <th className="p-2.5">المعدل</th>
                    <th className="p-2.5">السريان</th>
                    <th className="p-2.5">الحالة</th>
                    <th className="p-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map(r => (
                    <tr key={r.rateId} className="hover:bg-slate-50">
                      <td className="p-2.5 text-slate-700">{r.costTypeNameAr || r.costType}</td>
                      <td className="p-2.5 text-slate-600">
                        {r.itemCode ? `${r.itemCode} · ${r.itemNameAr}` : r.productFamily || 'عام'}
                      </td>
                      <td className="p-2.5 font-mono">{money(r.baseQuantity)}</td>
                      <td className="p-2.5 font-mono">{money(r.rate)}</td>
                      <td className="p-2.5 font-mono text-slate-500">
                        {r.effectiveFrom} → {r.effectiveTo || '…'}
                      </td>
                      <td className="p-2.5">
                        <span
                          className={`px-2 py-0.5 rounded-lg text-[10px] font-bold ${
                            r.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {r.status === 'active' ? 'ساري' : 'منتهي'}
                        </span>
                      </td>
                      <td className="p-2.5">
                        {canEdit && r.status === 'active' && (
                          <button
                            onClick={() => void expire(r)}
                            disabled={busyId === r.rateId}
                            className="px-2 py-1 rounded-lg bg-rose-50 text-rose-700 text-[10px] font-bold disabled:opacity-40"
                          >
                            إنهاء السريان
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
