import React, { useState } from 'react';
import { 
  Calculator, TrendingUp, TrendingDown, Clock, 
  Layers, BarChart2, Plus, CheckCircle2
} from 'lucide-react';
import { erpDb, generateErpId } from '../../services/db';
import { AuthorizationService } from '../../services/authorization';

/** Resolve an item's configured base-unit display name, or a fixed fallback. */
function itemUnitLabel(db: ReturnType<typeof erpDb.getSnapshot>, itemId?: string): string {
  if (itemId) {
    const itm = db.items.find((i) => i.id === itemId);
    if (itm?.baseUnitId) {
      const u = db.units.find((u) => u.id === itm.baseUnitId);
      if (u?.nameAr) return u.nameAr;
    }
  }
  return 'قطعة';
}
import { ManufacturingEngine } from '../../services/manufacturing';
import { ForecastService } from '../../services/forecast';
import { AuthService } from '../../services/auth';
import { StandardCostRate, ProductFamily } from '../../types/erp';

export const CostingView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [activeTab, setActiveTab] = useState<'standard_rates' | 'order_variances' | 'payroll_distribution' | 'forecast_comparison'>('standard_rates');
  const sessionUser = AuthService.getCurrentSession()?.user;
  const actorId = sessionUser?.id || 'usr-admin';
  const actorName = sessionUser?.name || 'رئيس التكاليف';

  // ---------- ITEM 3 — monthly payroll / supervision distribution ----------
  const todayStr = new Date().toISOString().split('T')[0];
  const [payPeriod, setPayPeriod] = useState(todayStr.slice(0, 7));
  const [payCostType, setPayCostType] = useState<'direct_labor' | 'supervision'>('direct_labor');
  const [payAmount, setPayAmount] = useState(0);
  const [paySource, setPaySource] = useState('');
  const [payDate, setPayDate] = useState(todayStr);
  const [payAlreadyRecognized, setPayAlreadyRecognized] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [payNotice, setPayNotice] = useState<string | null>(null);

  // Production output per order in the selected period — the allocation basis.
  const payBasis = (() => {
    const qtyByOrder = new Map<string, number>();
    for (const t of db.inventoryTransactions) {
      if (t.movementType !== 'production_output') continue;
      if (!String(t.date || '').startsWith(payPeriod)) continue;
      const order = db.productionOrders.find(o => o.orderNumber === t.documentNumber);
      if (!order || order.status === 'cancelled') continue;
      qtyByOrder.set(order.id, (qtyByOrder.get(order.id) || 0) + (Number(t.quantityIn) || 0));
    }
    const rows = [...qtyByOrder.entries()]
      .map(([id, qty]) => ({ order: db.productionOrders.find(o => o.id === id)!, qty }))
      .filter(r => !!r.order && r.qty > 0);
    const total = rows.reduce((s, r) => s + r.qty, 0);
    return { rows, total };
  })();

  const handleDistributePayroll = () => {
    setPayError(null);
    setPayNotice(null);
    const res = ManufacturingEngine.distributeProductionPayroll({
      period: payPeriod,
      costType: payCostType,
      totalAmount: Number(payAmount),
      sourceDescription: paySource,
      date: payDate,
      alreadyRecognized: payAlreadyRecognized,
      userId: actorId,
      userName: actorName,
    });
    if (!res.success) { setPayError(res.error || 'تعذر توزيع رواتب الإنتاج'); return; }
    setPayNotice(`تم توزيع ${res.distribution?.totalAmount.toLocaleString('ar-EG')} ج.م على ${res.distribution?.allocations.length} أمر إنتاج بقيود متوازنة مربوطة بكل أمر.`);
    setPayAmount(0);
    setPaySource('');
  };

  // ---------- ITEM 5 — manual sales forecast entry (upsert per period + item) ----------
  const [fcPeriod, setFcPeriod] = useState(todayStr.slice(0, 7));
  const [fcProductId, setFcProductId] = useState('');
  const [fcQty, setFcQty] = useState(0);
  const [fcUnitId, setFcUnitId] = useState('');
  const [fcNotes, setFcNotes] = useState('');
  const [fcEditingId, setFcEditingId] = useState<string | null>(null);
  const [fcError, setFcError] = useState<string | null>(null);
  const [fcNotice, setFcNotice] = useState<string | null>(null);
  const [fcRecalcPeriod, setFcRecalcPeriod] = useState(todayStr.slice(0, 7));

  const resetFcForm = () => {
    setFcPeriod(todayStr.slice(0, 7));
    setFcProductId('');
    setFcQty(0);
    setFcUnitId('');
    setFcNotes('');
    setFcEditingId(null);
    setFcError(null);
    setFcNotice(null);
  };

  const handleSaveForecast = () => {
    setFcError(null);
    setFcNotice(null);
    if (!fcProductId) { setFcError('اختر الصنف أولاً'); return; }
    const res = ForecastService.upsertForecast({
      period: fcPeriod,
      productId: fcProductId,
      forecastQuantity: Number(fcQty),
      unitId: fcUnitId || undefined,
      notes: fcNotes || undefined,
      userId: actorId,
      userName: actorName,
    });
    if (!res.success) { setFcError(res.error || 'تعذر حفظ التوقع'); return; }
    setFcNotice(res.created
      ? `تم إنشاء توقع الفترة ${fcPeriod} للصنف (${res.forecast?.forecastQuantity} في وحدة الأساس).`
      : `تم تحديث توقع الفترة ${fcPeriod} لهذا الصنف (بدون تكرار السجل).`);
    setFcEditingId(res.forecast?.id || null);
    setFcNotes('');
  };

  const handleRecalcForecasts = () => {
    setFcError(null);
    setFcNotice(null);
    const res = ForecastService.recalculatePeriod(fcRecalcPeriod);
    if (!res.success) { setFcError(res.error || 'تعذر إعادة الحساب'); return; }
    setFcNotice(`تم تحديث ${res.updated || 0} سجل توقع للفترة ${fcRecalcPeriod} من فواتير المبيعات والمرتجعات المرحّلة.`);
  };
  const [showAddRateModal, setShowAddRateModal] = useState(false);

  // New rate state
  const [costType, setCostType] = useState<StandardCostRate['costType']>('direct_labor');
  const [rateVal, setRateVal] = useState(250);
  const [baseQty, setBaseQty] = useState(1000);
  const [effectiveFrom, setEffectiveFrom] = useState('2026-10-01');
  const [effectiveTo, setEffectiveTo] = useState('2026-12-31');

  const costTypeNameMap: Record<string, string> = {
    direct_labor: 'عمالة مباشرة وتصنيع',
    electricity: 'كهرباء صناعية',
    gas: 'غاز طبيعي',
    maintenance: 'صيانة دورية وقطع غيار',
    supervision: 'إشراف ومراقبة خطوط الإنتاج',
    overhead: 'تكاليف صناعية إضافية أخرى',
  };

  const handleSaveRate = () => {
    // F15: guarded service write (AuthorizationService 'costing:create').
    const guard = AuthorizationService.enforce('costing', 'create', { userId: 'usr-admin', userName: 'رئيس costing' });
    if (!guard.allowed) {
      alert(guard.error || 'ليس لديك صلاحية إضافة معدل تكلفة معياري');
      return;
    }

    const newRate: StandardCostRate = {
      id: generateErpId('scr'),
      costType,
      costTypeNameAr: costTypeNameMap[costType] || costType,
      baseQuantity: baseQty,
      rate: Number(rateVal),
      effectiveFrom,
      effectiveTo,
      status: 'active',
    };

    erpDb.mutate(draft => {
      draft.standardCostRates.push(newRate);
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId, userName: guard.userName,
        module: 'إدارة التكاليف', action: 'create', recordId: newRate.id,
        description: `إضافة معدل تكلفة معياري ${newRate.costTypeNameAr} بمعدل ${newRate.rate} على أساس ${newRate.baseQuantity}`,
      });
    });

    setShowAddRateModal(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">إدارة التكاليف المعيارية والفعلية (Costing)</h2>
          <p className="text-xs text-slate-500 mt-1">
            معدلات التحويل الربع سنوية، مقارنة المعياري بالفعلي، انحرافات التشغيل، ودقة التنبؤ بالمبيعات
          </p>
        </div>

        <button
          onClick={() => setShowAddRateModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition"
        >
          <Plus className="w-4 h-4" />
          <span>تحديث معدل تكلفة معياري جديد</span>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setActiveTab('standard_rates')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'standard_rates' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          معدلات التكاليف المعيارية (الربع سنوية)
        </button>
        <button
          onClick={() => setActiveTab('order_variances')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'order_variances' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          انحرافات تكلفة أوامر الإنتاج (Variances)
        </button>
        <button
          onClick={() => setActiveTab('payroll_distribution')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'payroll_distribution' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          توزيع رواتب الإنتاج الشهرية
        </button>
        <button
          onClick={() => setActiveTab('forecast_comparison')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'forecast_comparison' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          مقارنة التنبؤ بالمبيعات بالفعلي (Forecast vs Actual)
        </button>
      </div>

      {activeTab === 'standard_rates' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200">
            <h3 className="font-bold text-xs text-slate-800">معدلات تكاليف التحويل الصناعي المعيارية</h3>
            <p className="text-[11px] text-slate-500">تراجع الأسعار كل 3 أشهر وتحدد نصيب الـ 1000 كرتونة من الأجور والطاقة والمصروفات</p>
          </div>

          <table className="w-full text-right text-xs">
            <thead className="bg-slate-100 text-slate-700 font-bold">
              <tr>
                <th className="p-3.5">بند التكلفة المعيارية</th>
                <th className="p-3.5 text-center">الكمية الأساسية</th>
                <th className="p-3.5 text-center">المعدل (ج.م)</th>
                <th className="p-3.5 text-center">تاريخ السريان من</th>
                <th className="p-3.5 text-center">تاريخ السريان إلى</th>
                <th className="p-3.5 text-center">الحالة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {db.standardCostRates.map(rate => (
                <tr key={rate.id} className="hover:bg-slate-50">
                  <td className="p-3.5 font-bold text-slate-900">{rate.costTypeNameAr}</td>
                  <td className="p-3.5 text-center font-mono">{rate.baseQuantity} كرتونة</td>
                  <td className="p-3.5 text-center font-mono font-black text-slate-900">{rate.rate.toFixed(2)} ج.م</td>
                  <td className="p-3.5 text-center text-slate-600">{rate.effectiveFrom}</td>
                  <td className="p-3.5 text-center text-slate-600">{rate.effectiveTo}</td>
                  <td className="p-3.5 text-center">
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-800">
                      سارٍ
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'order_variances' && (
        <div className="space-y-4">
          {db.productionOrders.length === 0 ? (
            <div className="p-12 text-center bg-white rounded-2xl border border-slate-200 text-slate-400 text-xs">
              لا توجد أوامر إنتاج لحساب انحرافاتها
            </div>
          ) : (
            db.productionOrders.map(order => {
              const breakdown = ManufacturingEngine.calculateCostBreakdown(order.id);
              const prod = db.items.find(i => i.id === order.productId);
              return (
                <div key={order.id} className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
                    <div>
                      <span className="font-mono font-bold text-slate-900 text-sm ml-2">{order.orderNumber}</span>
                      <span className="font-bold text-slate-800 text-sm">{prod?.nameAr}</span>
                    </div>
                    <div className="text-xs font-semibold text-slate-600">
                      إجمالي الإنتاج: <span className="font-bold text-slate-900">{order.producedQuantity}</span> {itemUnitLabel(db, prod?.id)}
                    </div>
                  </div>

                  {/* Summary Comparison */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-center">
                      <span className="text-[11px] text-slate-500 font-semibold block">التكلفة المعيارية الإجمالية</span>
                      <span className="text-base font-black text-slate-900 font-mono">
                        {breakdown.totalStandardCost.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م
                      </span>
                    </div>

                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-center">
                      <span className="text-[11px] text-slate-500 font-semibold block">التكلفة الفعلية المحققة</span>
                      <span className="text-base font-black text-slate-900 font-mono">
                        {breakdown.totalActualCost.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م
                      </span>
                    </div>

                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-center">
                      <span className="text-[11px] text-slate-500 font-semibold block">صافي انحراف التصنيع الإجمالي</span>
                      <span className={`text-base font-black font-mono ${
                        breakdown.totalProductionVariance > 0 ? 'text-rose-600' : 'text-emerald-600'
                      }`}>
                        {breakdown.totalProductionVariance > 0 ? `+${breakdown.totalProductionVariance.toFixed(2)}` : breakdown.totalProductionVariance.toFixed(2)} ج.م
                      </span>
                      <span className="text-[10px] text-slate-400 block">
                        {breakdown.totalProductionVariance > 0 ? '(إسراف / غير مفضل)' : '(وفر / مفضل)'}
                      </span>
                    </div>
                  </div>

                  {/* Variance Breakdown Table */}
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <table className="w-full text-right text-xs">
                      <thead className="bg-slate-100 text-slate-700">
                        <tr>
                          <th className="p-2.5">عنصر التكلفة</th>
                          <th className="p-2.5 text-center">معياري</th>
                          <th className="p-2.5 text-center">فعلي</th>
                          <th className="p-2.5 text-center">الانحراف</th>
                          <th className="p-2.5 text-center">الحالة</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-mono">
                        <tr>
                          <td className="p-2.5 font-bold font-sans">تكلفة الخامات ومواد التعبئة</td>
                          <td className="p-2.5 text-center">{breakdown.standardMaterialCost.toFixed(2)}</td>
                          <td className="p-2.5 text-center">{breakdown.actualMaterialCost.toFixed(2)}</td>
                          <td className="p-2.5 text-center font-bold">{breakdown.materialQuantityVariance.toFixed(2)}</td>
                          <td className="p-2.5 text-center font-sans font-bold">
                            {breakdown.materialQuantityVariance > 0 ? 'انحراف كمية سالب' : 'وفر كمية'}
                          </td>
                        </tr>
                        <tr>
                          <td className="p-2.5 font-bold font-sans">الأجور المباشرة</td>
                          <td className="p-2.5 text-center">{breakdown.standardLaborCost.toFixed(2)}</td>
                          <td className="p-2.5 text-center">{breakdown.actualLaborCost.toFixed(2)}</td>
                          <td className="p-2.5 text-center font-bold">{breakdown.laborVariance.toFixed(2)}</td>
                          <td className="p-2.5 text-center font-sans">{breakdown.laborVariance > 0 ? 'زيادة أجور' : 'وفر'}</td>
                        </tr>
                        <tr>
                          <td className="p-2.5 font-bold font-sans">الكهرباء والغاز والصيانة</td>
                          <td className="p-2.5 text-center">
                            {(breakdown.standardElectricityCost + breakdown.standardGasCost + breakdown.standardMaintenanceCost).toFixed(2)}
                          </td>
                          <td className="p-2.5 text-center">
                            {(breakdown.actualElectricityCost + breakdown.actualGasCost + breakdown.actualMaintenanceCost).toFixed(2)}
                          </td>
                          <td className="p-2.5 text-center font-bold">
                            {(breakdown.electricityVariance + breakdown.gasVariance + breakdown.maintenanceVariance).toFixed(2)}
                          </td>
                          <td className="p-2.5 text-center font-sans">انحراف تكاليف تحويل</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ITEM 3 — monthly payroll / supervision distribution over production orders */}
      {activeTab === 'payroll_distribution' && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-4 space-y-3">
            <div>
              <h3 className="font-bold text-xs text-slate-800">توزيع رواتب الإنتاج ومشرفيه على أوامر الإنتاج في الشهر نفسه</h3>
              <p className="text-[11px] text-slate-500 mt-1">
                يُوزَّع المبلغ على أوامر الإنتاج <b>بنسبة كمية الإنتاج الفعلية</b> في الفترة (لا تحميل الإجمالي على كل أمر)،
                بقيد متوازن لكل حصة مربوط بأمر الإنتاج — تُحتسب التكلفة المعيارية والفعليّة والفروق دون مضاعفة، ويُمنع تكرار تحميل الفترة والنوع.
                الرواتب الإدارية غير الإنتاجية خارج هذا المسار.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-6 gap-3 items-end">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">الفترة (الشهر)</label>
                <input
                  type="month"
                  value={payPeriod}
                  onChange={(e) => { setPayPeriod(e.target.value); setPayError(null); setPayNotice(null); }}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">نوع التكلفة</label>
                <select
                  value={payCostType}
                  onChange={(e) => setPayCostType(e.target.value as 'direct_labor' | 'supervision')}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  <option value="direct_labor">عمالة مباشرة</option>
                  <option value="supervision">مشرفو الإنتاج</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">المبلغ القابل للتوزيع (ج.م)</label>
                <input
                  type="number" min="0" step="0.01"
                  value={payAmount}
                  onChange={(e) => setPayAmount(Number(e.target.value))}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">مصدر المبلغ (إلزامي)</label>
                <input
                  type="text"
                  value={paySource}
                  onChange={(e) => setPaySource(e.target.value)}
                  placeholder="مثال: كشف رواتب الإنتاج رقم 10/2026"
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ الترحيل</label>
                <input
                  type="date"
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>
              <div>
                <button
                  onClick={handleDistributePayroll}
                  disabled={!(payAmount > 0) || !paySource.trim()}
                  className="w-full px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md disabled:opacity-40"
                >
                  توزيع وترحيل
                </button>
              </div>
            </div>

            <label className="flex items-center gap-2 text-[11px] font-semibold text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={payAlreadyRecognized}
                onChange={(e) => setPayAlreadyRecognized(e.target.checked)}
              />
              الراتب مُسجَّل مسبقًا كمصروف (6101) — ارحِل التوزيع كـ«تصنيف فقط» من 6101 إلى حساب التكلفة بدل إنشاء مصروف جديد
            </label>

            {payError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold">{payError}</div>
            )}
            {payNotice && (
              <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold">{payNotice}</div>
            )}

            <div className="border border-slate-200 rounded-xl overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-100 text-slate-700 font-bold">
                  <tr>
                    <th className="p-2.5">أمر الإنتاج</th>
                    <th className="p-2.5 text-center">كمية الإنتاج في الفترة</th>
                    <th className="p-2.5 text-center">النسبة</th>
                    <th className="p-2.5 text-center">الحصة المحسوبة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {payBasis.rows.length === 0 ? (
                    <tr><td colSpan={4} className="py-5 text-center text-slate-400">
                      لا توجد كمية إنتاج مسجّلة في الفترة {payPeriod} — لا يمكن توزيع صامت
                    </td></tr>
                  ) : (
                    payBasis.rows.map(r => (
                      <tr key={r.order.id} className="hover:bg-slate-50">
                        <td className="p-2.5 font-mono font-bold">{r.order.orderNumber} — {db.items.find(i => i.id === r.order.productId)?.nameAr}</td>
                        <td className="p-2.5 text-center font-mono">{r.qty}</td>
                        <td className="p-2.5 text-center font-mono font-bold">{((r.qty / payBasis.total) * 100).toFixed(2)}%</td>
                        <td className="p-2.5 text-center font-mono font-bold text-indigo-700">
                          {((payAmount * r.qty) / payBasis.total).toFixed(2)} ج.م
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                {payBasis.rows.length > 0 && (
                  <tfoot className="bg-slate-100 font-black text-slate-900 border-t-2 border-slate-300">
                    <tr>
                      <td className="p-2.5">الإجمالي</td>
                      <td className="p-2.5 text-center font-mono">{payBasis.total}</td>
                      <td className="p-2.5 text-center font-mono">100%</td>
                      <td className="p-2.5 text-center font-mono">{payAmount.toFixed(2)} ج.م</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          {/* Posted distributions */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="p-4 bg-slate-50 border-b border-slate-200">
              <h3 className="font-bold text-xs text-slate-800">التوزيعات المسجّلة (مصدر المبلغ والفترة والأوامر ونسب التوزيع)</h3>
            </div>
            {db.payrollDistributions.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-xs">لا توجد توزيعات رواتب إنتاج مسجّلة بعد</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {db.payrollDistributions.map(dist => (
                  <div key={dist.id} className="p-4 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="font-bold text-slate-900">
                        <span className="font-mono ml-2">{dist.distributionNumber}</span>
                        {dist.costTypeNameAr} — فترة {dist.period}
                        <span className="mx-2 font-mono text-indigo-700">{dist.totalAmount.toLocaleString('ar-EG')} ج.م</span>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] ${dist.status === 'posted' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}>
                          {dist.status === 'posted' ? 'مرحّل' : 'معكوس'}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500">
                        المصدر: {dist.sourceDescription} — بواسطة {dist.userName}
                      </div>
                    </div>
                    <table className="w-full text-right text-[11px]">
                      <thead className="bg-slate-50 text-slate-600 font-bold">
                        <tr>
                          <th className="p-2">أمر الإنتاج</th>                          <th className="p-2 text-center">كمية الأساس</th>
                          <th className="p-2 text-center">النسبة</th>
                          <th className="p-2 text-center">المبلغ المحمّل</th>
                          <th className="p-2 text-center">قيد الحصة</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50 font-mono">
                        {dist.allocations.map((a, i) => (
                          <tr key={i}>
                            <td className="p-2 font-bold">{a.productionOrderNumber}</td>
                            <td className="p-2 text-center">{a.basisQuantity}</td>
                            <td className="p-2 text-center">{(a.ratio * 100).toFixed(2)}%</td>
                            <td className="p-2 text-center font-bold">{a.allocatedAmount.toFixed(2)}</td>
                            <td className="p-2 text-center text-slate-500">{a.journalEntryId.slice(-8)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-slate-100 font-black border-t-2 border-slate-300">
                        <tr>
                          <td className="p-2" colSpan={3}>مجموع المبالغ المحمّلة (يجب أن يساوي المبلغ القابل للتوزيع بالضبط)</td>
                          <td className="p-2 text-center">{dist.allocations.reduce((s, a) => s + a.allocatedAmount, 0).toFixed(2)}</td>
                          <td className="p-2 text-center">{dist.totalAmount.toFixed(2)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'forecast_comparison' && (() => {
        const fcFormUnitId = fcUnitId || db.items.find(i => i.id === fcProductId)?.baseUnitId || 'unit-piece';
        return (
        <div className="space-y-4">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-4 space-y-3">
          <div>
            <h3 className="font-bold text-xs text-slate-800">إدخال / تعديل توقع مبيعات شهري (يدوي لكل صنف)</h3>
            <p className="text-[11px] text-slate-500 mt-1">
              يُحفظ التوقع بالفترة والصنف والكمية والوحدة والمستخدم وتاريخ التعديل. للفترة/الصنف نفسه يُحدَّث السجل القائم
              (لا تكرار صامت)، والفعلي يُحسب من <b>فواتير المبيعات المرحلة</b> للperiod نفسها بعد طرح المرتجعات المرحّلة.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">الفترة (الشهر)</label>
              <input
                type="month"
                value={fcPeriod}
                onChange={(e) => { setFcPeriod(e.target.value); setFcError(null); }}
                className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">الصنف</label>
              <select
                value={fcProductId}
                onChange={(e) => { setFcProductId(e.target.value); setFcUnitId(''); setFcError(null); }}
                className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
              >
                <option value="">— اختر الصنف —</option>
                {db.items.filter(i => i.active).map(i => (
                  <option key={i.id} value={i.id}>{i.nameAr}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">وحدة الكمية</label>
              <select
                value={fcFormUnitId}
                onChange={(e) => setFcUnitId(e.target.value)}
                className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
              >
                {db.units.map(u => <option key={u.id} value={u.id}>{u.nameAr}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">الكمية المتوقعة</label>
              <input
                type="number" min="0" step="0.001"
                value={fcQty}
                onChange={(e) => setFcQty(Number(e.target.value))}
                className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSaveForecast}
                disabled={!fcProductId || !(fcQty >= 0)}
                className="flex-1 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md disabled:opacity-40"
              >
                {fcEditingId ? 'حفظ التعديل' : 'إنشاء التوقع'}
              </button>
              {fcEditingId && (
                <button
                  onClick={resetFcForm}
                  className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs"
                >
                  جديد
                </button>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div className="sm:col-span-2">
              <label className="block text-xs font-bold text-slate-700 mb-1">ملاحظات (اختياري)</label>
              <input
                type="text"
                value={fcNotes}
                onChange={(e) => setFcNotes(e.target.value)}
                placeholder="مثال: حملة إعلانية متوقعة"
                className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
              />
            </div>
            <div className="flex gap-2">
              <input
                type="month"
                value={fcRecalcPeriod}
                onChange={(e) => setFcRecalcPeriod(e.target.value)}
                className="flex-1 p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
              />
              <button
                onClick={handleRecalcForecasts}
                className="px-3 py-2 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-800 font-bold text-xs whitespace-nowrap"
                title="إعادة احتساب الفعلي والفرق ونسبة الدقة من الفواتير المرحّلة للفترة"
              >
                إعادة حساب الفعلي
              </button>
            </div>
          </div>
          {fcError && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold">{fcError}</div>
          )}
          {fcNotice && (
            <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold">{fcNotice}</div>
          )}
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200">
            <h3 className="font-bold text-xs text-slate-800">مقارنة التنبؤ بالمبيعات بالفعلي ونسبة الدقة (Forecast vs Actual)</h3>
            <p className="text-[11px] text-slate-500">حساب دقة التنبؤ المالي والإنتاجي لتفادي الهدر وتغطية الطلب</p>
          </div>

          <table className="w-full text-right text-xs">
            <thead className="bg-slate-100 text-slate-700 font-bold">
              <tr>
                <th className="p-3.5">الفترة</th>
                <th className="p-3.5">المنتج</th>
                <th className="p-3.5 text-center">الكمية المتوقعة (Forecast)</th>
                <th className="p-3.5 text-center">الكمية المباعة الفعلية</th>
                <th className="p-3.5 text-center">الفارق</th>
                <th className="p-3.5 text-center">نسبة دقة التنبؤ %</th>
                <th className="p-3.5 text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {db.forecasts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    لا توجد مقارنات تنبؤ مسجلة
                  </td>
                </tr>
              ) : (
                db.forecasts.map(fc => {
                  const prod = db.items.find(i => i.id === fc.productId);
                  return (
                    <tr key={fc.id} className="hover:bg-slate-50">
                      <td className="p-3.5 font-bold font-mono">{fc.period}</td>
                      <td className="p-3.5 font-bold">{prod?.nameAr}</td>
                      <td className="p-3.5 text-center font-mono">{fc.forecastQuantity} {itemUnitLabel(db, prod?.id)}</td>
                      <td className="p-3.5 text-center font-mono font-bold">{fc.actualQuantity} {itemUnitLabel(db, prod?.id)}</td>
                      <td className="p-3.5 text-center font-mono font-bold">
                        <span className={fc.varianceQuantity >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                          {fc.varianceQuantity}
                        </span>
                      </td>
                      <td className="p-3.5 text-center font-mono font-black text-indigo-700">
                        {fc.accuracyPercentage}%
                      </td>
                      <td className="p-3.5 text-center">
                        <button
                          onClick={() => {
                            setFcEditingId(fc.id);
                            setFcPeriod(fc.period);
                            setFcProductId(fc.productId);
                            setFcQty(fc.forecastQuantity);
                            setFcUnitId(fc.unitId || '');
                            setFcNotes(fc.notes || '');
                            setFcError(null);
                            setFcNotice(null);
                          }}
                          className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg text-[11px]"
                        >
                          تعديل
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        </div>
        );
      })()}

      {/* Add Rate Modal */}
      {showAddRateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">تحديث معدل تكلفة تحويل صناعية معيارية</h3>
              <button onClick={() => setShowAddRateModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">نوع عنصر التكلفة</label>
                <select
                  value={costType}
                  onChange={(e) => setCostType(e.target.value as any)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  <option value="direct_labor">أجور مباشرة وتصنيع</option>
                  <option value="electricity">كهرباء صناعية</option>
                  <option value="gas">غاز طبيعي</option>
                  <option value="maintenance">صيانة دورية وقطع غيار</option>
                  <option value="supervision">إشراف ومراقبة إنتاج</option>
                  <option value="overhead">تكاليف صناعية إضافية</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">المعدل (ج.م)</label>
                  <input
                    type="number"
                    value={rateVal}
                    onChange={(e) => setRateVal(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">الكمية الأساسية (كرتونة)</label>
                  <input
                    type="number"
                    value={baseQty}
                    onChange={(e) => setBaseQty(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">سارٍ من تاريخ</label>
                  <input
                    type="date"
                    value={effectiveFrom}
                    onChange={(e) => setEffectiveFrom(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">سارٍ إلى تاريخ</label>
                  <input
                    type="date"
                    value={effectiveTo}
                    onChange={(e) => setEffectiveTo(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setShowAddRateModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs"
              >
                إلغاء
              </button>
              <button
                onClick={handleSaveRate}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md"
              >
                حفظ المعدل المعياري
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
