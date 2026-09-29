import React, { useState } from 'react';
import { 
  Calculator, TrendingUp, TrendingDown, Clock, 
  Layers, BarChart2, Plus, CheckCircle2
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { ManufacturingEngine } from '../../services/manufacturing';
import { StandardCostRate, ProductFamily } from '../../types/erp';

export const CostingView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [activeTab, setActiveTab] = useState<'standard_rates' | 'order_variances' | 'forecast_comparison'>('standard_rates');
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
    const newRate: StandardCostRate = {
      id: `scr-${Date.now()}`,
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
                      إجمالي الإنتاج: <span className="font-bold text-slate-900">{order.producedQuantity}</span> كرتونة
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

      {activeTab === 'forecast_comparison' && (
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
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {db.forecasts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-400">
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
                      <td className="p-3.5 text-center font-mono">{fc.forecastQuantity} كرتونة</td>
                      <td className="p-3.5 text-center font-mono font-bold">{fc.actualQuantity} كرتونة</td>
                      <td className="p-3.5 text-center font-mono font-bold">
                        <span className={fc.varianceQuantity >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                          {fc.varianceQuantity}
                        </span>
                      </td>
                      <td className="p-3.5 text-center font-mono font-black text-indigo-700">
                        {fc.accuracyPercentage}%
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

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
