import React, { useState } from 'react';
import { 
  Factory, Plus, Play, CheckCircle2, AlertCircle, 
  Layers, ChevronRight, Recycle, Trash2, Calendar
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { ManufacturingEngine } from '../../services/manufacturing';
import { ProductionOrder, ProductionOrderStatus } from '../../types/erp';

export const ManufacturingView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDailyOutputModal, setShowDailyOutputModal] = useState<ProductionOrder | null>(null);
  const [selectedOrderDetails, setSelectedOrderDetails] = useState<ProductionOrder | null>(null);

  // Form State for new production order
  const [productId, setProductId] = useState('');
  const [plannedQty, setPlannedQty] = useState(1000);
  const [targetMarket, setTargetMarket] = useState<'local' | 'export'>('local');
  const [destinationWhId, setDestinationWhId] = useState('wh-local');
  const [expectedDate, setExpectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [orderNotes, setOrderNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // Daily output form state
  const [goodQty, setGoodQty] = useState(500);
  const [defectiveQty, setDefectiveQty] = useState(0);
  const [scrapQty, setScrapQty] = useState(0);
  const [defectiveAction, setDefectiveAction] = useState<'to_recycling' | 'to_scrap'>('to_recycling');
  const [wasteReason, setWasteReason] = useState('معيب تغليف مع إعادة تدوير الخلطة');
  const [outputDate, setOutputDate] = useState(new Date().toISOString().split('T')[0]);

  const finishedProducts = db.items.filter(i => i.itemType === 'finished_product' && i.active);

  const handleOpenCreate = () => {
    if (finishedProducts.length > 0) setProductId(finishedProducts[0].id);
    setPlannedQty(1000);
    setTargetMarket('local');
    setDestinationWhId('wh-local');
    setOrderNotes('');
    setFormError(null);
    setShowCreateModal(true);
  };

  const handleSaveOrder = () => {
    setFormError(null);
    if (!productId) {
      setFormError('يرجى اختيار المنتج التام');
      return;
    }
    if (plannedQty <= 0) {
      setFormError('الكمية المخططة يجب أن تكون أكبر من صفر');
      return;
    }

    const bom = db.boms.find(b => b.finishedItemId === productId && b.active);
    if (!bom) {
      setFormError('لا توجد معادلة تصنيع (BOM) نشطة لهذا المنتج');
      return;
    }

    const count = db.productionOrders.length + 1;
    const orderNumber = `PRD-${new Date().getFullYear()}-${String(count).padStart(4, '0')}`;
    const orderId = `pord-${Date.now()}`;
    const todayStr = new Date().toISOString().split('T')[0];

    erpDb.mutate(draft => {
      draft.productionOrders.push({
        id: orderId,
        orderNumber,
        productId,
        bomId: bom.id,
        plannedQuantity: plannedQty,
        producedQuantity: 0,
        defectiveQuantity: 0,
        scrapQuantity: 0,
        remainingQuantity: plannedQty,
        startDate: todayStr,
        expectedCompletionDate: expectedDate,
        status: 'released',
        destinationWarehouseId: destinationWhId,
        targetMarket,
        notes: orderNotes,
        createdUserId: 'usr-admin',
        createdAt: new Date().toISOString(),
      });

      // Audit Log
      draft.auditLogs.push({
        id: `aud-${Date.now()}`,
        timestamp: new Date().toISOString(),
        userId: 'usr-admin',
        userName: 'مدير الإنتاج',
        module: 'الإنتاج والتصنيع',
        action: 'create',
        recordId: orderId,
        description: `إنشاء أمر إنتاج جديد رقم ${orderNumber} لكمية ${plannedQty} كرتونة`,
      });
    });

    setShowCreateModal(false);
  };

  const handleRecordOutput = () => {
    if (!showDailyOutputModal) return;
    const res = ManufacturingEngine.recordDailyProduction({
      orderId: showDailyOutputModal.id,
      goodQuantity: Number(goodQty),
      defectiveQuantity: Number(defectiveQty),
      scrapQuantity: Number(scrapQty),
      defectiveAction,
      wasteReason,
      date: outputDate,
      userId: 'usr-admin',
      userName: 'مدير الإنتاج',
    });

    if (!res.success) {
      alert(res.error || 'حدث خطأ');
      return;
    }

    setShowDailyOutputModal(null);
  };

  const handleCloseOrder = (orderId: string) => {
    if (confirm('تأكيد إغلاق أمر الإنتاج نهائياً، واحتساب التكاليف المعيارية والفعلية وترحيل قيود الانحرافات بالدفاتر؟')) {
      const res = ManufacturingEngine.closeProductionOrder(orderId, 'usr-admin', 'مدير الإنتاج');
      if (!res.success) {
        alert(res.error || 'خطأ في إغلاق أمر الإنتاج');
      }
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">إدارة الإنتاج والتصنيع (Manufacturing)</h2>
          <p className="text-xs text-slate-500 mt-1">
            أوامر التشغيل متعددة الأيام، معادلات التصنيع (BOM)، معالجة التوالف والسكراب، وتتبع تكلفة المنتج
          </p>
        </div>

        <button
          onClick={handleOpenCreate}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition"
        >
          <Plus className="w-4 h-4" />
          <span>أمر إنتاج جديد</span>
        </button>
      </div>

      {/* Production Orders Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
          <h3 className="font-bold text-xs text-slate-800">أوامر الإنتاج والتشغيل الجارية</h3>
          <span className="text-xs text-slate-500 font-semibold">
            إجمالي الأوامر: <span className="font-bold text-slate-900">{db.productionOrders.length}</span>
          </span>
        </div>

        <table className="w-full text-right text-xs">
          <thead className="bg-slate-100 text-slate-700 font-bold">
            <tr>
              <th className="p-3.5">رقم الأمر</th>
              <th className="p-3.5">المنتج التام</th>
              <th className="p-3.5">السوق المستهدف</th>
              <th className="p-3.5 text-center">المخطط</th>
              <th className="p-3.5 text-center">المنتج الفعلي</th>
              <th className="p-3.5 text-center">المعيب / الهالك</th>
              <th className="p-3.5 text-center">المتبقي</th>
              <th className="p-3.5 text-center">الحالة</th>
              <th className="p-3.5 text-center">إجراءات التشغيل</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {db.productionOrders.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-12 text-center text-slate-400">
                  لا توجد أوامر إنتاج مسجلة حالياً
                </td>
              </tr>
            ) : (
              db.productionOrders.map(ord => {
                const prod = db.items.find(i => i.id === ord.productId);
                return (
                  <tr key={ord.id} className="hover:bg-slate-50/80 transition">
                    <td className="p-3.5 font-mono font-bold text-slate-900">{ord.orderNumber}</td>
                    <td className="p-3.5 font-bold text-slate-800">{prod?.nameAr || ord.productId}</td>
                    <td className="p-3.5">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                        ord.targetMarket === 'export' ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'
                      }`}>
                        {ord.targetMarket === 'export' ? 'تصدير خارجي' : 'سوق محلي'}
                      </span>
                    </td>
                    <td className="p-3.5 text-center font-mono font-bold text-slate-800">{ord.plannedQuantity}</td>
                    <td className="p-3.5 text-center font-mono font-black text-emerald-700">{ord.producedQuantity}</td>
                    <td className="p-3.5 text-center font-mono text-rose-600">
                      {ord.defectiveQuantity + ord.scrapQuantity}
                    </td>
                    <td className="p-3.5 text-center font-mono font-bold text-slate-600">{ord.remainingQuantity}</td>
                    <td className="p-3.5 text-center">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                        ord.status === 'completed' 
                          ? 'bg-emerald-100 text-emerald-800' 
                          : ord.status === 'in_progress' 
                          ? 'bg-amber-100 text-amber-800' 
                          : 'bg-slate-100 text-slate-700'
                      }`}>
                        {ord.status === 'completed' ? 'مكتمل ومغلق' : ord.status === 'in_progress' ? 'قيد التشغيل' : 'مطلق'}
                      </span>
                    </td>
                    <td className="p-3.5 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        {ord.status !== 'completed' && (
                          <>
                            <button
                              onClick={() => {
                                setShowDailyOutputModal(ord);
                                setGoodQty(Math.min(500, ord.remainingQuantity || 100));
                                setDefectiveQty(0);
                                setScrapQty(0);
                              }}
                              className="px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold rounded-lg text-xs"
                            >
                              تسجيل إنتاج يومي
                            </button>

                            <button
                              onClick={() => handleCloseOrder(ord.id)}
                              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-900 text-white font-bold rounded-lg text-xs"
                            >
                              إغلاق واحتساب التكاليف
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => setSelectedOrderDetails(ord)}
                          className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-lg text-xs"
                        >
                          التفاصيل و BOM
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

      {/* Create Order Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">إصدار أمر إنتاج وتشغيل جديد</h3>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            {formError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold">
                {formError}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">المنتج التام (أحد الـ 11 صنفاً)</label>
                <select
                  value={productId}
                  onChange={(e) => setProductId(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  {finishedProducts.map(fp => (
                    <option key={fp.id} value={fp.id}>
                      {fp.nameAr} [{fp.productFamily} - {fp.flavor || ''}]
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">الكمية المخططة (كرتونة)</label>
                  <input
                    type="number"
                    min="1"
                    value={plannedQty}
                    onChange={(e) => setPlannedQty(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">السوق المستهدف</label>
                  <select
                    value={targetMarket}
                    onChange={(e) => {
                      const tm = e.target.value as 'local' | 'export';
                      setTargetMarket(tm);
                      setDestinationWhId(tm === 'export' ? 'wh-export' : 'wh-local');
                    }}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    <option value="local">سوق محلي (مستودع المنتج المحلي)</option>
                    <option value="export">تصدير خارجي (مستودع التصدير)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ الانتهاء المتوقع</label>
                <input
                  type="date"
                  value={expectedDate}
                  onChange={(e) => setExpectedDate(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">ملاحظات التشغيل والوردية</label>
                <input
                  type="text"
                  placeholder="مثال: تشغيل بناءً على توقعات مبيعات الشهر"
                  value={orderNotes}
                  onChange={(e) => setOrderNotes(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs"
              >
                إلغاء
              </button>
              <button
                onClick={handleSaveOrder}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md"
              >
                اعتماد وإطلاق أمر الإنتاج
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Record Daily Production Modal */}
      {showDailyOutputModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">
                تسجيل إنتاج يومي: {showDailyOutputModal.orderNumber}
              </h3>
              <button onClick={() => setShowDailyOutputModal(null)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">كمية الإنتاج التام السليم (كرتونة)</label>
                <input
                  type="number"
                  min="0"
                  value={goodQty}
                  onChange={(e) => setGoodQty(Number(e.target.value))}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono font-bold text-emerald-800"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">كمية الإنتاج المعيب (كرتونة)</label>
                  <input
                    type="number"
                    min="0"
                    value={defectiveQty}
                    onChange={(e) => setDefectiveQty(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">كمية الهالك والسكراب (كرتونة)</label>
                  <input
                    type="number"
                    min="0"
                    value={scrapQty}
                    onChange={(e) => setScrapQty(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono text-rose-700"
                  />
                </div>
              </div>

              {defectiveQty > 0 && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">توجيه الإنتاج المعيب</label>
                  <select
                    value={defectiveAction}
                    onChange={(e) => setDefectiveAction(e.target.value as any)}
                    className="w-full p-2 rounded-xl bg-amber-50 border border-amber-300 text-xs font-bold text-amber-900"
                  >
                    <option value="to_recycling">إعادة تدوير (يرجع لمستودع الخامات كمادة خام)</option>
                    <option value="to_scrap">تحويل لمستودع الهالك والسكراب للبيع المنفصل</option>
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">سبب التوالف / الهالك</label>
                <input
                  type="text"
                  value={wasteReason}
                  onChange={(e) => setWasteReason(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ التشغيل</label>
                <input
                  type="date"
                  value={outputDate}
                  onChange={(e) => setOutputDate(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setShowDailyOutputModal(null)}
                className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs"
              >
                إلغاء
              </button>
              <button
                onClick={handleRecordOutput}
                className="px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs shadow-md"
              >
                تأكيد واستلام الإنتاج بالمستودع
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BOM Requirements & Costing Details Modal */}
      {selectedOrderDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">
                معادلة التصنيع (BOM) واحتياجات الخامات لأمر: {selectedOrderDetails.orderNumber}
              </h3>
              <button onClick={() => setSelectedOrderDetails(null)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            {/* BOM Requirements List */}
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-100 text-slate-700">
                  <tr>
                    <th className="p-2.5">المادة الخام / التعبئة</th>
                    <th className="p-2.5 text-center">الكمية المطلوبة</th>
                    <th className="p-2.5 text-center">المتاح بمستودع الخامات</th>
                    <th className="p-2.5 text-center">حالة الكفاية</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ManufacturingEngine.calculateBomRequirements(
                    selectedOrderDetails.bomId, 
                    selectedOrderDetails.plannedQuantity
                  ).map((req, idx) => (
                    <tr key={idx}>
                      <td className="p-2.5 font-bold text-slate-800">{req.itemNameAr}</td>
                      <td className="p-2.5 text-center font-mono font-bold">{req.requiredQuantity} {req.unitNameAr}</td>
                      <td className="p-2.5 text-center font-mono">{req.availableStock} {req.unitNameAr}</td>
                      <td className="p-2.5 text-center">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                          req.sufficient ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                        }`}>
                          {req.sufficient ? 'كافٍ للتشغيل' : 'عجز بالمخزون'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setSelectedOrderDetails(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 text-white font-bold text-xs"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
