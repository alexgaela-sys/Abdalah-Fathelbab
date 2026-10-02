import React, { useState } from 'react';
import { 
  UserCheck, Plus, PackageCheck, RotateCcw, 
  DollarSign, TrendingUp, AlertTriangle, Layers, Calendar
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { WorkflowService } from '../../services/workflows';
import { AuthService } from '../../services/auth';
import { PermissionService } from '../../services/permissions';
import { SalesRepresentative, RepresentativeCustody } from '../../types/erp';

export const RepresentativesView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [activeTab, setActiveTab] = useState<'custody' | 'profitability' | 'reps'>('custody');
  const [showOpenCustodyModal, setShowOpenCustodyModal] = useState(false);
  const [showLoadModal, setShowLoadModal] = useState<RepresentativeCustody | null>(null);
  const [showReturnModal, setShowReturnModal] = useState<RepresentativeCustody | null>(null);

  // ---------- Representative master data (F2) ----------
  const sessionRole = AuthService.getCurrentSession()?.user.role;
  const canManageReps = sessionRole ? PermissionService.canCreate(sessionRole, 'representatives') : true;
  const [showRepModal, setShowRepModal] = useState(false);
  const [editingRep, setEditingRep] = useState<SalesRepresentative | null>(null);
  const [repForm, setRepForm] = useState({ code: '', name: '', phone: '', targetMonthlySales: 0 });
  const [repError, setRepError] = useState<string | null>(null);

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

  const openRepCreate = () => {
    setEditingRep(null);
    setRepForm({ code: '', name: '', phone: '', targetMonthlySales: 0 });
    setRepError(null);
    setShowRepModal(true);
  };

  const openRepEdit = (rep: SalesRepresentative) => {
    setEditingRep(rep);
    setRepForm({
      code: rep.code,
      name: rep.name,
      phone: rep.phone || '',
      targetMonthlySales: Number(rep.targetMonthlySales) || 0,
    });
    setRepError(null);
    setShowRepModal(true);
  };

  const handleSaveRep = () => {
    setRepError(null);
    const res = editingRep
      ? WorkflowService.updateSalesRepresentative({
          repId: editingRep.id,
          name: repForm.name,
          phone: repForm.phone,
          targetMonthlySales: Number(repForm.targetMonthlySales) || 0,
          userId: 'usr-admin',
          userName: 'المشرف العام (Admin)',
        })
      : WorkflowService.createSalesRepresentative({
          code: repForm.code,
          name: repForm.name,
          phone: repForm.phone,
          targetMonthlySales: Number(repForm.targetMonthlySales) || 0,
          userId: 'usr-admin',
          userName: 'المشرف العام (Admin)',
        });
    if (!res.success) {
      setRepError(res.error || 'تعذر حفظ بيانات المندوب');
      return;
    }
    setShowRepModal(false);
  };

  const handleToggleRepActive = (rep: SalesRepresentative) => {
    const res = WorkflowService.updateSalesRepresentative({
      repId: rep.id,
      active: !rep.active,
      userId: 'usr-admin',
      userName: 'المشرف العام (Admin)',
    });
    if (!res.success) alert(res.error || 'تعذر تغيير حالة المندوب');
  };

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
    const cashInput = prompt('المبلغ النقدي المُحصل والمسلَّم مع تسوية العهدة (اتركه فارغاً أو صفراً إن لم يوجد):', '0');
    if (cashInput === null) return;

    const res = WorkflowService.settleRepCustody({
      custodyId,
      cashCollected: Number(cashInput) > 0 ? Number(cashInput) : undefined,
      date: new Date().toISOString().split('T')[0],
    });

    if (!res.success) {
      alert(res.error || 'خطأ في تسوية العهدة');
      return;
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

        <div className="flex items-center gap-2">
          <button
            onClick={openRepCreate}
            disabled={!canManageReps}
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs transition disabled:opacity-40"
          >
            <UserCheck className="w-4 h-4" />
            <span>مندوب جديد</span>
          </button>
          <button
            onClick={() => {
              if (reps.length > 0) setSelectedRepId(reps[0].id);
              setShowOpenCustodyModal(true);
            }}
            disabled={reps.length === 0}
            title={reps.length === 0 ? 'سجّل مندوبي المبيعات أولاً من تبويب بيانات المندوبين' : ''}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs shadow-md transition disabled:opacity-40"
          >
            <Plus className="w-4 h-4" />
            <span>فتح عهدة مندوب جديدة</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setActiveTab('reps')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'reps' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          بيانات المندوبين (Master Data)
        </button>
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

      {/* Representative master data (F2) */}
      {activeTab === 'reps' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-bold text-xs text-slate-800">بيانات مندوبي المبيعات (Sales Representatives)</h3>
              <p className="text-[11px] text-slate-500">
                المندوب المسجل هنا يظهر مباشرة في فواتير المبيعات، العهدة، التسوية، المصروفات، وتقرير الربحية
              </p>
            </div>
            <button
              onClick={openRepCreate}
              disabled={!canManageReps}
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs disabled:opacity-40"
            >
              <Plus className="w-4 h-4" />
              <span>تسجيل مندوب</span>
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-100 text-slate-700 font-bold">
                <tr>
                  <th className="p-3.5">الكود</th>
                  <th className="p-3.5">الاسم</th>
                  <th className="p-3.5">الهاتف</th>
                  <th className="p-3.5 text-center">المستهدف الشهري (ج.م)</th>
                  <th className="p-3.5 text-center">المبيعات المحققة</th>
                  <th className="p-3.5 text-center">نسبة التحقق</th>
                  <th className="p-3.5 text-center">الحالة</th>
                  <th className="p-3.5 text-center">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {db.salesReps.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-400">
                      لا يوجد مندوبون مسجلون — اضغط «تسجيل مندوب» لإضافة أول مندوب
                    </td>
                  </tr>
                ) : (
                  db.salesReps.map(rep => {
                    const achieved = db.salesInvoices
                      .filter(i => i.status === 'posted' && i.repId === rep.id)
                      .reduce((s, i) => s + (i.totalAmountEGP || 0), 0);
                    const target = Number(rep.targetMonthlySales) || 0;
                    const attainment = target > 0 ? (achieved / target) * 100 : 0;
                    return (
                      <tr key={rep.id} className="hover:bg-slate-50/80">
                        <td className="p-3.5 font-mono font-bold text-slate-900">{rep.code}</td>
                        <td className="p-3.5 font-bold text-slate-800">{rep.name}</td>
                        <td className="p-3.5 font-mono text-slate-600">{rep.phone || '-'}</td>
                        <td className="p-3.5 text-center font-mono">{target.toLocaleString('ar-EG')}</td>
                        <td className="p-3.5 text-center font-mono font-bold text-slate-900">{achieved.toLocaleString('ar-EG')}</td>
                        <td className="p-3.5 text-center font-mono font-bold">
                          <span className={attainment >= 100 ? 'text-emerald-700' : 'text-amber-700'}>
                            {attainment.toFixed(1)}%
                          </span>
                        </td>
                        <td className="p-3.5 text-center">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                            rep.active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'
                          }`}>
                            {rep.active ? 'نشط' : 'موقوف'}
                          </span>
                        </td>
                        <td className="p-3.5 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              onClick={() => openRepEdit(rep)}
                              disabled={!canManageReps}
                              className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg text-xs disabled:opacity-40"
                            >
                              تعديل
                            </button>
                            <button
                              onClick={() => handleToggleRepActive(rep)}
                              disabled={!canManageReps}
                              className={`px-2 py-1 font-bold rounded-lg text-xs border disabled:opacity-40 ${
                                rep.active
                                  ? 'bg-rose-50 text-rose-700 border-rose-200'
                                  : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              }`}
                            >
                              {rep.active ? 'إيقاف' : 'تنشيط'}
                            </button>
                          </div>
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

      {/* Representative create/edit modal */}
      {showRepModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-md p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">
                {editingRep ? `تعديل بيانات المندوب: ${editingRep.name}` : 'تسجيل مندوب مبيعات جديد'}
              </h3>
              <button onClick={() => setShowRepModal(false)} className="text-slate-400 hover:text-slate-700">✕</button>
            </div>

            {repError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold">{repError}</div>
            )}

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">كود المندوب</label>
                  <input
                    type="text"
                    value={repForm.code}
                    disabled={!!editingRep}
                    onChange={(e) => setRepForm({ ...repForm, code: e.target.value })}
                    placeholder="REP-01"
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">رقم الهاتف</label>
                  <input
                    type="text"
                    value={repForm.phone}
                    onChange={(e) => setRepForm({ ...repForm, phone: e.target.value })}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">اسم المندوب</label>
                <input
                  type="text"
                  value={repForm.name}
                  onChange={(e) => setRepForm({ ...repForm, name: e.target.value })}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">المستهدف الشهري (ج.م)</label>
                <input
                  type="number"
                  min="0"
                  value={repForm.targetMonthlySales}
                  onChange={(e) => setRepForm({ ...repForm, targetMonthlySales: Number(e.target.value) })}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setShowRepModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs"
              >
                إلغاء
              </button>
              <button
                onClick={handleSaveRep}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md"
              >
                {editingRep ? 'حفظ التعديلات' : 'تسجيل المندوب'}
              </button>
            </div>
          </div>
        </div>
      )}

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
