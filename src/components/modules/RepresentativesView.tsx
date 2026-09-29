import React, { useState } from 'react';
import { 
  UserCheck, Plus, PackageCheck, RotateCcw, 
  DollarSign, TrendingUp, AlertTriangle, Layers, Calendar
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { WorkflowService } from '../../services/workflows';
import { SalesRepresentative, RepresentativeCustody } from '../../types/erp';

export const RepresentativesView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [activeTab, setActiveTab] = useState<'custody' | 'profitability' | 'reps'>('custody');
  const [showOpenCustodyModal, setShowOpenCustodyModal] = useState(false);
  const [showLoadModal, setShowLoadModal] = useState<RepresentativeCustody | null>(null);
  const [showReturnModal, setShowReturnModal] = useState<RepresentativeCustody | null>(null);

  // Open Custody state
  const [selectedRepId, setSelectedRepId] = useState('');
  const [custodyNotes, setCustodyNotes] = useState('عهدة توزيع يومية');

  // Load modal state
  const [loadItemId, setLoadItemId] = useState('');
  const [loadQty, setLoadQty] = useState(20);
  const [loadWhId, setLoadWhId] = useState('wh-local');

  // Return modal state
  const [returnItemId, setReturnItemId] = useState('');
  const [returnQty, setReturnQty] = useState(5);
  const [returnWhId, setReturnWhId] = useState('wh-local');

  const reps = db.salesReps.filter(r => r.active);
  const finishedProducts = db.items.filter(i => i.itemType === 'finished_product' && i.active);

  const handleOpenCustody = () => {
    if (!selectedRepId) return;
    const res = WorkflowService.openRepCustody(selectedRepId, custodyNotes);
    if (!res.success) {
      alert(res.error || 'خطأ في فتح العهدة');
      return;
    }
    setShowOpenCustodyModal(false);
  };

  const handleExecuteLoad = () => {
    if (!showLoadModal || !loadItemId) return;
    const item = finishedProducts.find(i => i.id === loadItemId);
    const res = WorkflowService.loadGoodsToRep({
      custodyId: showLoadModal.id,
      itemId: loadItemId,
      quantity: Number(loadQty),
      unitPrice: item?.sellingPriceRetail || 140,
      warehouseId: loadWhId,
      date: new Date().toISOString().split('T')[0],
    });

    if (!res.success) {
      alert(res.error || 'خطأ في تحميل البضاعة');
      return;
    }
    setShowLoadModal(null);
  };

  const handleExecuteReturn = () => {
    if (!showReturnModal || !returnItemId) return;
    const res = WorkflowService.returnGoodsFromRep({
      custodyId: showReturnModal.id,
      itemId: returnItemId,
      quantity: Number(returnQty),
      warehouseId: returnWhId,
      date: new Date().toISOString().split('T')[0],
    });

    if (!res.success) {
      alert(res.error || 'خطأ في إرجاع البضاعة');
      return;
    }
    setShowReturnModal(null);
  };

  const handleSettleCustody = (custodyId: string) => {
    if (confirm('تأكيد تسوية وإغلاق عهدة المندوب؟')) {
      erpDb.mutate(draft => {
        const c = draft.representativeCustodies.find(x => x.id === custodyId);
        if (c) {
          c.status = 'settled';
          c.settleDate = new Date().toISOString().split('T')[0];
        }
      });
    }
  };

  // Representative Profitability calculation
  const repProfitability = reps.map(rep => {
    const repInvoices = db.salesInvoices.filter(i => i.status === 'posted' && i.repId === rep.id);
    const totalSales = repInvoices.reduce((s, i) => s + i.totalAmountEGP, 0);
    const totalCogs = repInvoices.reduce((s, i) => s + (i.cogsTotal || 0), 0);
    const repExpenses = db.expenses
      .filter(e => e.salesRepId === rep.id)
      .reduce((s, e) => s + e.totalAmount, 0);

    const netProfit = totalSales - totalCogs - repExpenses;
    const margin = totalSales > 0 ? (netProfit / totalSales) * 100 : 0;

    return {
      rep,
      totalSales,
      totalCogs,
      repExpenses,
      netProfit,
      margin,
      invoicesCount: repInvoices.length,
    };
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">إدارة مناديب المبيعات والعهد الميدانية</h2>
          <p className="text-xs text-slate-500 mt-1">
            تحميل البضاعة، تسوية العهد، مطابقة الفروق الفعلية، واحتساب ربحية المندوب بعد خصم المصروفات
          </p>
        </div>

        <button
          onClick={() => {
            if (reps.length > 0) setSelectedRepId(reps[0].id);
            setShowOpenCustodyModal(true);
          }}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs shadow-md transition"
        >
          <Plus className="w-4 h-4" />
          <span>فتح عهدة مندوب جديدة</span>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setActiveTab('custody')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'custody' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          العهد المفتوحة وحركات التحميل والمرتجع
        </button>
        <button
          onClick={() => setActiveTab('profitability')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'profitability' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          ربحية المناديب (صافي المساهمة)
        </button>
      </div>

      {activeTab === 'custody' && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="p-4 bg-slate-50 border-b border-slate-200">
              <h3 className="font-bold text-xs text-slate-800">سجل عهد المناديب (Custody Reconciliation)</h3>
              <p className="text-[11px] text-slate-500">
                الرصيد المتوقع = الرصيد الافتتاحي + البضاعة المحملة - المبيعات - المرتجعات والمطابقة
              </p>
            </div>

            <table className="w-full text-right text-xs">
              <thead className="bg-slate-100 text-slate-700 font-bold">
                <tr>
                  <th className="p-3.5">رقم العهدة</th>
                  <th className="p-3.5">مندوب المبيعات</th>
                  <th className="p-3.5">تاريخ الفتح</th>
                  <th className="p-3.5 text-center">المحمل للعهدة</th>
                  <th className="p-3.5 text-center">المرتجع للمستودع</th>
                  <th className="p-3.5 text-center">المتبقي بالعهدة</th>
                  <th className="p-3.5 text-center">الحالة</th>
                  <th className="p-3.5 text-center">إجراءات العهدة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {db.representativeCustodies.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-400">
                      لا توجد عهد مناديب مسجلة حالياً
                    </td>
                  </tr>
                ) : (
                  db.representativeCustodies.map(cust => {
                    const rep = db.salesReps.find(r => r.id === cust.repId);
                    const moves = db.custodyMovements.filter(m => m.custodyId === cust.id);
                    const loadedQty = moves.filter(m => m.movementType === 'loaded').reduce((s, m) => s + m.quantity, 0);
                    const returnedQty = moves.filter(m => m.movementType === 'returned').reduce((s, m) => s + m.quantity, 0);
                    const soldQty = moves.filter(m => m.movementType === 'sold').reduce((s, m) => s + m.quantity, 0);
                    const remainingQty = loadedQty - returnedQty - soldQty;

                    return (
                      <tr key={cust.id} className="hover:bg-slate-50">
                        <td className="p-3.5 font-mono font-bold text-slate-900">{cust.custodyNumber}</td>
                        <td className="p-3.5 font-bold text-slate-800">{rep?.name}</td>
                        <td className="p-3.5 text-slate-600">{cust.openDate}</td>
                        <td className="p-3.5 text-center font-mono font-bold text-slate-900">{loadedQty} كرتونة</td>
                        <td className="p-3.5 text-center font-mono text-emerald-700 font-bold">{returnedQty} كرتونة</td>
                        <td className="p-3.5 text-center font-mono font-black text-amber-700">{remainingQty} كرتونة</td>
                        <td className="p-3.5 text-center">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                            cust.status === 'open' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'
                          }`}>
                            {cust.status === 'open' ? 'عهدة مفتوحة' : 'تمت التسوية'}
                          </span>
                        </td>
                        <td className="p-3.5 text-center">
                          {cust.status === 'open' ? (
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                onClick={() => {
                                  if (finishedProducts.length > 0) setLoadItemId(finishedProducts[0].id);
                                  setShowLoadModal(cust);
                                }}
                                className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-lg text-xs"
                              >
                                تحميل بضاعة
                              </button>
                              <button
                                onClick={() => {
                                  if (finishedProducts.length > 0) setReturnItemId(finishedProducts[0].id);
                                  setShowReturnModal(cust);
                                }}
                                className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs"
                              >
                                إرجاع بضاعة
                              </button>
                              <button
                                onClick={() => handleSettleCustody(cust.id)}
                                className="px-2 py-1 bg-slate-200 hover:bg-slate-300 text-slate-800 font-semibold rounded-lg text-xs"
                              >
                                تسوية العهدة
                              </button>
                            </div>
                          ) : (
                            <span className="text-[11px] text-slate-400">مغلقة في {cust.settleDate}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'profitability' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200">
            <h3 className="font-bold text-xs text-slate-800">تحليل ربحية ومساهمة مناديب المبيعات (Representative Profitability)</h3>
            <p className="text-[11px] text-slate-500">
              المبيعات - تكلفة البضاعة المباعة COGS - مصروفات وعمولات المندوب = صافي ربح ومساهمة المندوب
            </p>
          </div>

          <table className="w-full text-right text-xs">
            <thead className="bg-slate-100 text-slate-700 font-bold">
              <tr>
                <th className="p-3.5">مندوب المبيعات</th>
                <th className="p-3.5 text-center">إجمالي المبيعات</th>
                <th className="p-3.5 text-center">تكلفة البضاعة (COGS)</th>
                <th className="p-3.5 text-center">مصروفات وعمولات المندوب</th>
                <th className="p-3.5 text-center">صافي مساهمة المندوب</th>
                <th className="p-3.5 text-center">نسبة هامش الربح %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {repProfitability.map(({ rep, totalSales, totalCogs, repExpenses, netProfit, margin }) => (
                <tr key={rep.id} className="hover:bg-slate-50">
                  <td className="p-3.5 font-bold text-slate-900">{rep.name}</td>
                  <td className="p-3.5 text-center font-mono font-bold">{totalSales.toLocaleString('ar-EG')} ج.م</td>
                  <td className="p-3.5 text-center font-mono text-slate-600">{totalCogs.toLocaleString('ar-EG')} ج.م</td>
                  <td className="p-3.5 text-center font-mono text-rose-600">{repExpenses.toLocaleString('ar-EG')} ج.م</td>
                  <td className="p-3.5 text-center font-mono font-black">
                    <span className={netProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
                      {netProfit.toLocaleString('ar-EG')} ج.م
                    </span>
                  </td>
                  <td className="p-3.5 text-center font-mono font-black text-indigo-700">
                    {margin.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Open Custody Modal */}
      {showOpenCustodyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-md p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">فتح عهدة مندوب مبيعات جديدة</h3>
              <button onClick={() => setShowOpenCustodyModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">المندوب</label>
                <select
                  value={selectedRepId}
                  onChange={(e) => setSelectedRepId(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  {reps.map(r => (
                    <option key={r.id} value={r.id}>{r.name} ({r.code})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">ملاحظات وخط السير</label>
                <input
                  type="text"
                  value={custodyNotes}
                  onChange={(e) => setCustodyNotes(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setShowOpenCustodyModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs"
              >
                إلغاء
              </button>
              <button
                onClick={handleOpenCustody}
                className="px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs shadow-md"
              >
                فتح العهدة
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Load Goods Modal */}
      {showLoadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-md p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">
                تحميل بضاعة لعهدة {showLoadModal.custodyNumber}
              </h3>
              <button onClick={() => setShowLoadModal(null)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">المنتج المراد تحميله</label>
                <select
                  value={loadItemId}
                  onChange={(e) => setLoadItemId(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  {finishedProducts.map(fp => (
                    <option key={fp.id} value={fp.id}>{fp.nameAr}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">الكمية المحملة (كرتونة)</label>
                <input
                  type="number"
                  min="1"
                  value={loadQty}
                  onChange={(e) => setLoadQty(Number(e.target.value))}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">الصرف من مستودع</label>
                <select
                  value={loadWhId}
                  onChange={(e) => setLoadWhId(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  <option value="wh-local">مستودع المنتج التام المحلي (WH-02)</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setShowLoadModal(null)}
                className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs"
              >
                إلغاء
              </button>
              <button
                onClick={handleExecuteLoad}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md"
              >
                تأكيد التحميل وصرف المخزون
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Return Goods Modal */}
      {showReturnModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-md p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">
                إرجاع بضاعة متبقية من عهدة {showReturnModal.custodyNumber}
              </h3>
              <button onClick={() => setShowReturnModal(null)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">المنتج المرتجع</label>
                <select
                  value={returnItemId}
                  onChange={(e) => setReturnItemId(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  {finishedProducts.map(fp => (
                    <option key={fp.id} value={fp.id}>{fp.nameAr}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">الكمية المرتجعة (كرتونة)</label>
                <input
                  type="number"
                  min="1"
                  value={returnQty}
                  onChange={(e) => setReturnQty(Number(e.target.value))}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">إيداع في مستودع</label>
                <select
                  value={returnWhId}
                  onChange={(e) => setReturnWhId(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  <option value="wh-local">مستودع المنتج التام المحلي (WH-02)</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setShowReturnModal(null)}
                className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs"
              >
                إلغاء
              </button>
              <button
                onClick={handleExecuteReturn}
                className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-md"
              >
                تأكيد الإرجاع للمستودع
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
