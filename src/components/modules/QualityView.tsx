import React, { useState } from 'react';
import { 
  ShieldCheck, Plus, CheckCircle2, XCircle, 
  AlertTriangle, Filter, Search
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { WorkflowService } from '../../services/workflows';
import { QualityResult, QualityDestination } from '../../types/erp';

export const QualityView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [showAddModal, setShowAddModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Form State
  const [documentType, setDocumentType] = useState<'purchase_receipt' | 'production_output' | 'sales_return'>('production_output');
  const [documentNumber, setDocumentNumber] = useState('');
  const [itemId, setItemId] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [inspectedQty, setInspectedQty] = useState(100);
  const [inspectorName, setInspectorName] = useState('م. طارق كمال (مراقب الجودة)');
  const [result, setResult] = useState<QualityResult>('passed');
  const [destination, setDestination] = useState<QualityDestination>('saleable');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');

  const items = db.items;
  const whMap = new Map(db.warehouses.map(w => [w.id, w.nameAr]));

  const handleOpenAdd = () => {
    if (items.length > 0) setItemId(items[0].id);
    setDocumentNumber(`DOC-${Date.now().toString().slice(-4)}`);
    setBatchNumber(`BATCH-${new Date().toLocaleDateString('en-CA').replace(/-/g, '')}-01`);
    setReason('');
    setNotes('');
    setShowAddModal(true);
  };

  const handleSaveInspection = () => {
    if (!itemId) {
      alert('يرجى اختيار الصنف');
      return;
    }
    if (!documentNumber.trim()) {
      alert('يرجى إدخال رقم المستند المرجعي');
      return;
    }

    // Routing-enabled inspection: rejected/conditional quantities physically move out of
    // saleable inventory to the destination warehouse with an accounting reclassification.
    const res = WorkflowService.recordQualityInspectionWithRouting({
      documentType,
      documentNumber: documentNumber.trim(),
      itemId,
      batchNumber,
      inspectedQuantity: Number(inspectedQty),
      date: new Date().toISOString().split('T')[0],
      inspectorName,
      result,
      destination,
      sourceWarehouseId: 'wh-local',
      reason: reason.trim() || undefined,
      notes: notes.trim() || undefined,
    });

    if (!res.success) {
      alert(res.error || 'خطأ في حفظ الفحص');
      return;
    }

    setShowAddModal(false);
  };

  const destinationNameMap: Record<QualityDestination, string> = {
    saleable: 'مستودع المنتج الصالح للبيع (WH-02)',
    raw_materials: 'مستودع الخامات ومواد التعبئة (WH-01)',
    damaged: 'مستودع التوالف والمعيب (WH-04)',
    scrap: 'مستودع الهالك / السكراب (WH-05)',
    recycling: 'إعادة تدوير (يعاد لمستودع الخامات)',
  };

  const filteredInspections = db.qualityInspections.filter(i => {
    const itm = items.find(x => x.id === i.itemId);
    const text = `${i.documentNumber} ${i.batchNumber} ${itm?.nameAr || ''}`.toLowerCase();
    return text.includes(searchQuery.toLowerCase());
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">إدارة ومراقبة الجودة (Quality Inspection)</h2>
          <p className="text-xs text-slate-500 mt-1">
            فحص الخامات الواردة، مخرجات خطوط الإنتاج، وتحديد وجهة المعيب والتوالف والهالك
          </p>
        </div>

        <button
          onClick={handleOpenAdd}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition"
        >
          <Plus className="w-4 h-4" />
          <span>تسجيل محضر فحص جودة</span>
        </button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
          <h3 className="font-bold text-xs text-slate-800">سجل محاضر فحص الجودة وتوجيهات المستودعات</h3>
          <span className="text-xs text-slate-500 font-semibold">
            عدد المحاضر: <span className="font-bold text-slate-900">{filteredInspections.length}</span>
          </span>
        </div>

        <table className="w-full text-right text-xs">
          <thead className="bg-slate-100 text-slate-700 font-bold">
            <tr>
              <th className="p-3.5">نوع المستند</th>
              <th className="p-3.5">رقم المستند</th>
              <th className="p-3.5">الصنف</th>
              <th className="p-3.5">رقم التشغيلة</th>
              <th className="p-3.5 text-center">الكمية المفحوصة</th>
              <th className="p-3.5 text-center">النتيجة</th>
              <th className="p-3.5">التوجيه المخزني المعتمد</th>
              <th className="p-3.5">الفاحص المعتمد</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredInspections.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-slate-400">
                  لا توجد محاضر فحص جودة مسجلة حالياً
                </td>
              </tr>
            ) : (
              filteredInspections.map(qi => {
                const itm = items.find(i => i.id === qi.itemId);
                return (
                  <tr key={qi.id} className="hover:bg-slate-50">
                    <td className="p-3.5 text-slate-700">
                      {qi.documentType === 'purchase_receipt' ? 'استلام خامات' : qi.documentType === 'production_output' ? 'إنتاج مصنع' : 'مرتجع مبيعات'}
                    </td>
                    <td className="p-3.5 font-mono font-bold text-slate-900">{qi.documentNumber}</td>
                    <td className="p-3.5 font-bold text-slate-800">{itm?.nameAr || qi.itemId}</td>
                    <td className="p-3.5 font-mono text-slate-600">{qi.batchNumber}</td>
                    <td className="p-3.5 text-center font-mono font-bold">{qi.inspectedQuantity}</td>
                    <td className="p-3.5 text-center">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                        qi.result === 'passed' ? 'bg-emerald-100 text-emerald-800' : qi.result === 'conditional' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'
                      }`}>
                        {qi.result === 'passed' ? 'مطابق / قبول' : qi.result === 'conditional' ? 'قبول مشروط' : 'مرفوض'}
                      </span>
                    </td>
                    <td className="p-3.5 font-semibold text-slate-800">
                      {destinationNameMap[qi.destination] || qi.destination}
                    </td>
                    <td className="p-3.5 text-slate-600">{qi.inspectorName}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Add Inspection Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">تسجيل محضر فحص جودة جديد</h3>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">نوع المستند المفحوص</label>
                  <select
                    value={documentType}
                    onChange={(e) => setDocumentType(e.target.value as any)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    <option value="production_output">إنتاج خط التصنيع</option>
                    <option value="purchase_receipt">استلام مشتريات خامات</option>
                    <option value="sales_return">مرتجع مبيعات من عميل</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">رقم المستند / التشغيلة</label>
                  <input
                    type="text"
                    value={documentNumber}
                    onChange={(e) => setDocumentNumber(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">الصنف المراد فحصه</label>
                <select
                  value={itemId}
                  onChange={(e) => setItemId(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  {items.map(i => (
                    <option key={i.id} value={i.id}>{i.nameAr} [{i.code}]</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">الكمية المفحوصة</label>
                  <input
                    type="number"
                    min="1"
                    value={inspectedQty}
                    onChange={(e) => setInspectedQty(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">نتيجة الفحص</label>
                  <select
                    value={result}
                    onChange={(e) => setResult(e.target.value as any)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold"
                  >
                    <option value="passed">مطابق للمواصفات القياسية (قبول)</option>
                    <option value="rejected">غير مطابق (رفض)</option>
                    <option value="conditional">قبول مشروط بفرز</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">قرار التوجيه المخزني المعتمد</label>
                <select
                  value={destination}
                  onChange={(e) => setDestination(e.target.value as any)}
                  className="w-full p-2 rounded-xl bg-amber-50 border border-amber-300 text-xs font-bold text-amber-900"
                >
                  <option value="saleable">مستودع المنتج التام الصالح للبيع (WH-02)</option>
                  <option value="raw_materials">مستودع الخامات ومواد التعبئة (WH-01)</option>
                  <option value="damaged">مستودع التوالف والمعيب للعزل (WH-04)</option>
                  <option value="scrap">مستودع الهالك والسكراب للبيع المنفصل (WH-05)</option>
                  <option value="recycling">إعادة تدوير وإرجاع للخامات (WH-01)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">ملاحظات وتقرير الفحص الفني</label>
                <input
                  type="text"
                  placeholder="بيان أسباب الرفض أو التوجيه"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs"
              >
                إلغاء
              </button>
              <button
                onClick={handleSaveInspection}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md"
              >
                اعتماد محضر الفحص وتوجيه البضاعة
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
