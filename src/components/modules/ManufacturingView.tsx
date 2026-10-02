import React, { useMemo, useState } from 'react';
import { 
  Factory, Plus, Play, CheckCircle2, AlertCircle, 
  Layers, ChevronRight, Recycle, Trash2, Calendar, PackageOpen,
  FileStack, Pencil, Power, GitBranch, Save
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { ManufacturingEngine } from '../../services/manufacturing';
import { AuthService } from '../../services/auth';
import { PermissionService } from '../../services/permissions';
import { ProductionOrder, ProductionOrderStatus } from '../../types/erp';

export const ManufacturingView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDailyOutputModal, setShowDailyOutputModal] = useState<ProductionOrder | null>(null);
  const [selectedOrderDetails, setSelectedOrderDetails] = useState<ProductionOrder | null>(null);
  const [activeSection, setActiveSection] = useState<'orders' | 'bom'>('orders');

  // ---------- BOM management (F1) ----------
  const sessionRole = AuthService.getCurrentSession()?.user.role;
  const canEditBom = sessionRole ? PermissionService.canCreate(sessionRole, 'manufacturing') : true;
  const [bomProductId, setBomProductId] = useState('');
  const [bomHeader, setBomHeader] = useState({
    baseQuantity: 1000,
    unitId: 'unit-carton',
    effectiveDate: new Date().toISOString().split('T')[0],
    notes: '',
  });
  const [bomLines, setBomLines] = useState<Array<{
    materialItemId: string; quantityRequired: number; unitId: string; wastePercentage: number;
  }>>([]);
  const [bomError, setBomError] = useState<string | null>(null);
  const [bomNotice, setBomNotice] = useState<string | null>(null);

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
  const allFinishedProducts = db.items.filter(i => i.itemType === 'finished_product');
  const materialItems = db.items.filter(i => i.itemType === 'raw_material' || i.itemType === 'packaging_material');
  const units = db.units || [];

  // Active BOM + full version history for the selected finished product.
  const bomsForProduct = useMemo(
    () => db.boms.filter(b => (b.finishedItemId || b.productId) === bomProductId)
      .sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0)),
    [db.boms, bomProductId]
  );
  const activeBom = bomsForProduct.find(b => b.active) || null;
  const linesFor = (bomId: string) => db.bomLines.filter(l => l.bomId === bomId);

  const loadBomIntoEditor = (bomId: string | null) => {
    setBomError(null);
    setBomNotice(null);
    if (!bomId) {
      setBomHeader({
        baseQuantity: 1000,
        unitId: 'unit-carton',
        effectiveDate: new Date().toISOString().split('T')[0],
        notes: '',
      });
      setBomLines([]);
      return;
    }
    const bom = db.boms.find(b => b.id === bomId);
    if (!bom) return;
    setBomHeader({
      baseQuantity: bom.baseQuantity,
      unitId: bom.unitId,
      effectiveDate: bom.effectiveDate || new Date().toISOString().split('T')[0],
      notes: bom.notes || '',
    });
    setBomLines(linesFor(bomId).map(l => ({
      materialItemId: l.materialItemId,
      quantityRequired: l.quantityRequired,
      unitId: l.unitId,
      wastePercentage: Number(l.wastePercentage) || 0,
    })));
  };

  const handleSelectBomProduct = (productId: string) => {
    setBomProductId(productId);
    const act = db.boms.find(b => (b.finishedItemId || b.productId) === productId && b.active);
    loadBomIntoEditor(act ? act.id : null);
  };

  const handleAddBomLine = () => {
    const first = materialItems[0];
    if (!first) return;
    setBomLines([...bomLines, {
      materialItemId: first.id,
      quantityRequired: 1,
      unitId: first.baseUnitId,
      wastePercentage: 0,
    }]);
  };

  const handleUpdateBomLine = (idx: number, field: string, value: any) => {
    const next = [...bomLines];
    const line = { ...next[idx] };
    if (field === 'materialItemId') {
      const itm = materialItems.find(i => i.id === value);
      if (itm) line.unitId = itm.baseUnitId;
    }
    (line as any)[field] = value;
    next[idx] = line;
    setBomLines(next);
  };

  const handleRemoveBomLine = (idx: number) => setBomLines(bomLines.filter((_, i) => i !== idx));

  const handleSaveBom = () => {
    setBomError(null);
    setBomNotice(null);
    if (!bomProductId) {
      setBomError('يرجى اختيار المنتج التام أولاً');
      return;
    }
    const payloadLines = bomLines.map(l => ({
      materialItemId: l.materialItemId,
      quantityRequired: Number(l.quantityRequired),
      unitId: l.unitId,
      wastePercentage: Number(l.wastePercentage) || undefined,
    }));

    if (activeBom) {
      const res = ManufacturingEngine.updateBom({
        bomId: activeBom.id,
        baseQuantity: Number(bomHeader.baseQuantity),
        unitId: bomHeader.unitId,
        effectiveDate: bomHeader.effectiveDate,
        notes: bomHeader.notes,
        lines: payloadLines,
        userId: 'usr-admin',
        userName: 'مدير الإنتاج',
      });
      if (!res.success) {
        setBomError(res.error || 'تعذر حفظ معادلة التصنيع');
        return;
      }
      setBomNotice('تم تحديث بنود معادلة التصنيع النشطة بنجاح');
      return;
    }

    const res = ManufacturingEngine.createBomVersion({
      finishedItemId: bomProductId,
      baseQuantity: Number(bomHeader.baseQuantity),
      unitId: bomHeader.unitId,
      effectiveDate: bomHeader.effectiveDate,
      notes: bomHeader.notes,
      lines: payloadLines,
      userId: 'usr-admin',
      userName: 'مدير الإنتاج',
    });
    if (!res.success) {
      setBomError(res.error || 'تعذر حفظ معادلة التصنيع');
      return;
    }
    setBomNotice('تم إنشاء معادلة تصنيع جديدة وتفعيلها — يمكنك الآن بناء أمر إنتاج لهذا المنتج');
    // The editor already holds exactly what was saved; the version history below
    // re-renders from the fresh snapshot, so no reload from the stale snapshot here.
  };

  const handleNewBomVersion = () => {
    setBomError(null);
    setBomNotice(null);
    if (!bomProductId) {
      setBomError('يرجى اختيار المنتج التام أولاً');
      return;
    }
    if (bomLines.length === 0) {
      setBomError('يجب تعبئة بنود الخامات قبل إنشاء نسخة جديدة');
      return;
    }
    const res = ManufacturingEngine.createBomVersion({
      finishedItemId: bomProductId,
      baseQuantity: Number(bomHeader.baseQuantity),
      unitId: bomHeader.unitId,
      effectiveDate: bomHeader.effectiveDate || new Date().toISOString().split('T')[0],
      notes: bomHeader.notes,
      lines: bomLines.map(l => ({
        materialItemId: l.materialItemId,
        quantityRequired: Number(l.quantityRequired),
        unitId: l.unitId,
        wastePercentage: Number(l.wastePercentage) || undefined,
      })),
      userId: 'usr-admin',
      userName: 'مدير الإنتاج',
    });
    if (!res.success) {
      setBomError(res.error || 'تعذر إنشاء نسخة جديدة من المعادلة');
      return;
    }
    setBomNotice('تم إنشاء نسخة جديدة وتعطيل النسخة السابقة تلقائياً (نسخة نشطة واحدة فقط لكل منتج)');
  };

  const handleToggleBomActive = (bomId: string, nextActive: boolean) => {
    setBomError(null);
    setBomNotice(null);
    const res = ManufacturingEngine.setBomActive(bomId, nextActive, 'usr-admin', 'مدير الإنتاج');
    if (!res.success) {
      setBomError(res.error || 'تعذر تغيير حالة المعادلة');
      return;
    }
    setBomNotice(nextActive ? 'تم تفعيل المعادلة.' : 'تم إيقاف المعادلة. لن يُسمح ببناء أمر إنتاج بدون معادلة نشطة.');
  };

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
    // F15: guarded service write. The "active BOM required" rule is enforced
    // inside ManufacturingEngine.createProductionOrder and is not weakened.
    const res = ManufacturingEngine.createProductionOrder({
      productId,
      plannedQuantity: plannedQty,
      targetMarket,
      destinationWarehouseId: destinationWhId,
      expectedCompletionDate: expectedDate,
      notes: orderNotes,
      userId: 'usr-admin',
      userName: 'مدير الإنتاج',
    });
    if (!res.success) {
      setFormError(res.error || 'تعذر إنشاء أمر الإنتاج');
      return;
    }
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

  // Issue BOM raw/packaging materials from WH-01 to the production order (FIFO, actual cost)
  const handleIssueMaterials = (order: ProductionOrder) => {
    if (!confirm(`صرف خامات ومواد التعبئة من مستودع الخامات لأمر الإنتاج ${order.orderNumber} وفق معادلة التصنيع؟`)) {
      return;
    }
    const res = ManufacturingEngine.issueMaterialsToOrder({
      orderId: order.id,
      date: new Date().toISOString().split('T')[0],
      userId: 'usr-admin',
      userName: 'مدير الإنتاج',
    });
    if (!res.success) {
      alert(res.error || 'خطأ في صرف خامات أمر الإنتاج');
      return;
    }
    alert(`تم صرف المواد بنجاح بتكلفة فعلية ${res.totalActualCost?.toLocaleString('ar-EG') || '0'} ج.م`);
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
            أوامر التشغيل متعددة الأيام، معادلات التصنيع (BOM)، معالجة التوالف والسكراب، وتتبع تكلفة المنتج — راجع تبويب «إدارة معادلات التصنيع (BOM)» لإنشاء/تعديل/تفعيل المعادلة قبل بناء أمر الإنتاج
          </p>
        </div>

        <div className="flex items-center gap-2">
          {activeSection === 'orders' && (
            <button
              onClick={handleOpenCreate}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition"
            >
              <Plus className="w-4 h-4" />
              <span>أمر إنتاج جديد</span>
            </button>
          )}
        </div>
      </div>

      {/* Section switcher: production orders / BOM master data */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setActiveSection('orders')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition ${
            activeSection === 'orders' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Factory className="w-3.5 h-3.5" />
          أوامر الإنتاج
        </button>
        <button
          onClick={() => setActiveSection('bom')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition ${
            activeSection === 'bom' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <FileStack className="w-3.5 h-3.5" />
          إدارة معادلات التصنيع (BOM)
        </button>
      </div>

      {activeSection === 'bom' && (
        <div className="space-y-4">
          {/* Product selector + active BOM summary */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="flex-1">
                <label className="block text-xs font-bold text-slate-700 mb-1">اختر المنتج التام لإدارة معادلته</label>
                <select
                  value={bomProductId}
                  onChange={(e) => handleSelectBomProduct(e.target.value)}
                  className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold"
                >
                  <option value="">— اختر منتجاً تاماً —</option>
                  {allFinishedProducts.map(fp => {
                    const act = db.boms.find(b => (b.finishedItemId || b.productId) === fp.id && b.active);
                    return (
                      <option key={fp.id} value={fp.id}>
                        {fp.code} — {fp.nameAr} {act ? `(نسخة نشطة V${act.version})` : '(لا توجد معادلة نشطة)'}
                      </option>
                    );
                  })}
                </select>
              </div>
              <div className="text-xs font-sans rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5">
                {activeBom ? (
                  <span className="text-emerald-800 font-bold">
                    المعادلة النشطة: {activeBom.bomNumber || activeBom.id} (V{activeBom.version}) — ساري في {activeBom.effectiveDate}
                  </span>
                ) : bomProductId ? (
                  <span className="text-rose-700 font-bold">لا توجد معادلة نشطة — أمر الإنتاج لهذا المنتج محظور حتى إنشاء/تفعيل معادلة</span>
                ) : (
                  <span className="text-slate-500">اختر منتجاً لعرض معادلته</span>
                )}
              </div>
            </div>

            {/* Version history */}
            {bomProductId && bomsForProduct.length > 0 && (
              <div className="border border-slate-200 rounded-xl overflow-x-auto">
                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-100 text-slate-700 font-bold">
                    <tr>
                      <th className="p-2.5">رقم المعادلة</th>
                      <th className="p-2.5 text-center">النسخة</th>
                      <th className="p-2.5 text-center">كمية الأساس</th>
                      <th className="p-2.5 text-center">عدد البنود</th>
                      <th className="p-2.5 text-center">ساري في</th>
                      <th className="p-2.5 text-center">الحالة</th>
                      <th className="p-2.5 text-center">إجراءات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {bomsForProduct.map(b => (
                      <tr key={b.id} className={b.active ? 'bg-emerald-50/50' : 'hover:bg-slate-50'}>
                        <td className="p-2.5 font-mono font-bold text-slate-900">{b.bomNumber || b.id}</td>
                        <td className="p-2.5 text-center font-mono font-black text-slate-900">V{b.version}</td>
                        <td className="p-2.5 text-center font-mono">{b.baseQuantity}</td>
                        <td className="p-2.5 text-center font-mono">{linesFor(b.id).length}</td>
                        <td className="p-2.5 text-center font-mono text-slate-600">{b.effectiveDate}</td>
                        <td className="p-2.5 text-center">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                            b.active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'
                          }`}>
                            {b.active ? 'نشطة' : 'مؤرشفة'}
                          </span>
                        </td>
                        <td className="p-2.5">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              onClick={() => loadBomIntoEditor(b.id)}
                              disabled={!canEditBom}
                              className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg text-xs disabled:opacity-40"
                            >
                              <Pencil className="w-3 h-3 inline" /> تحرير
                            </button>
                            <button
                              onClick={() => handleToggleBomActive(b.id, !b.active)}
                              disabled={!canEditBom}
                              className={`px-2 py-1 font-bold rounded-lg text-xs disabled:opacity-40 ${
                                b.active ? 'bg-rose-50 text-rose-700 border border-rose-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              }`}
                            >
                              <Power className="w-3 h-3 inline" /> {b.active ? 'إيقاف' : 'تفعيل'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* BOM editor */}
          {bomProductId && (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
              <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold text-xs text-slate-800">
                    {activeBom ? `تحرير بنود ${activeBom.bomNumber || 'المعادلة'} (V${activeBom.version})` : 'إنشاء معادلة تصنيع جديدة'}
                  </h3>
                  <p className="text-[11px] text-slate-500">خامات ومواد تعبئة + الكمية + الوحدة + نسبة الهالك + كمية الأساس</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={handleSaveBom}
                    disabled={!canEditBom}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs disabled:opacity-40"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {activeBom ? 'حفظ تعديلات المعادلة النشطة' : 'حفظ وتفعيل المعادلة'}
                  </button>
                  <button
                    onClick={handleNewBomVersion}
                    disabled={!canEditBom}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs disabled:opacity-40"
                  >
                    <GitBranch className="w-3.5 h-3.5" />
                    إنشاء نسخة جديدة
                  </button>
                </div>
              </div>

              <div className="p-4 space-y-3">
                {bomError && (
                  <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold">{bomError}</div>
                )}
                {bomNotice && (
                  <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold">{bomNotice}</div>
                )}
                {!canEditBom && (
                  <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs font-semibold">
                    دورك الحالي لا يملك صلاحية إنشاء/تعديل معادلات التصنيع — العرض فقط
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">كمية الأساس (وحدة الإنتاج)</label>
                    <input
                      type="number" min="1"
                      value={bomHeader.baseQuantity}
                      onChange={(e) => setBomHeader({ ...bomHeader, baseQuantity: Number(e.target.value) })}
                      className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">وحدة الأساس</label>
                    <select
                      value={bomHeader.unitId}
                      onChange={(e) => setBomHeader({ ...bomHeader, unitId: e.target.value })}
                      className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                    >
                      {units.map(u => (
                        <option key={u.id} value={u.id}>{u.nameAr} ({u.code})</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ السريان</label>
                    <input
                      type="date"
                      value={bomHeader.effectiveDate}
                      onChange={(e) => setBomHeader({ ...bomHeader, effectiveDate: e.target.value })}
                      className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">ملاحظات المعادلة</label>
                  <input
                    type="text"
                    value={bomHeader.notes}
                    onChange={(e) => setBomHeader({ ...bomHeader, notes: e.target.value })}
                    placeholder="مثال: تركيبة محسنة بانخفاض هالك التعبئة 1%"
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  />
                </div>

                {/* BOM lines */}
                <div className="border border-slate-200 rounded-xl overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-slate-100 text-slate-700 font-bold">
                      <tr>
                        <th className="p-2.5">الخامة / مادة التعبئة</th>
                        <th className="p-2.5 w-32 text-center">الكمية المطلوبة</th>
                        <th className="p-2.5 w-28 text-center">الوحدة</th>
                        <th className="p-2.5 w-28 text-center">نسبة الهالك %</th>
                        <th className="p-2.5 w-10"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {bomLines.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-slate-400">
                            لا توجد بنود — أضف خامة أو مادة تعبئة للبدء
                          </td>
                        </tr>
                      ) : (
                        bomLines.map((l, idx) => (
                          <tr key={idx}>
                            <td className="p-2">
                              <select
                                value={l.materialItemId}
                                onChange={(e) => handleUpdateBomLine(idx, 'materialItemId', e.target.value)}
                                disabled={!canEditBom}
                                className="w-full p-1.5 rounded-lg border border-slate-300 text-xs bg-white disabled:opacity-60"
                              >
                                {materialItems.map(itm => (
                                  <option key={itm.id} value={itm.id}>
                                    {itm.nameAr} [{itm.itemType === 'raw_material' ? 'خام' : 'تعبئة'}]
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="p-2">
                              <input
                                type="number" min="0" step="0.01"
                                value={l.quantityRequired}
                                onChange={(e) => handleUpdateBomLine(idx, 'quantityRequired', Number(e.target.value))}
                                disabled={!canEditBom}
                                className="w-full p-1.5 rounded-lg border border-slate-300 text-xs text-center font-mono disabled:opacity-60"
                              />
                            </td>
                            <td className="p-2">
                              <select
                                value={l.unitId}
                                onChange={(e) => handleUpdateBomLine(idx, 'unitId', e.target.value)}
                                disabled={!canEditBom}
                                className="w-full p-1.5 rounded-lg border border-slate-300 text-xs bg-white disabled:opacity-60"
                              >
                                {units.map(u => (
                                  <option key={u.id} value={u.id}>{u.nameAr}</option>
                                ))}
                              </select>
                            </td>
                            <td className="p-2">
                              <input
                                type="number" min="0" max="100" step="0.1"
                                value={l.wastePercentage}
                                onChange={(e) => handleUpdateBomLine(idx, 'wastePercentage', Number(e.target.value))}
                                disabled={!canEditBom}
                                className="w-full p-1.5 rounded-lg border border-slate-300 text-xs text-center font-mono disabled:opacity-60"
                              />
                            </td>
                            <td className="p-2 text-center">
                              <button
                                onClick={() => handleRemoveBomLine(idx)}
                                disabled={!canEditBom}
                                className="text-rose-500 font-bold disabled:opacity-40"
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <button
                  onClick={handleAddBomLine}
                  disabled={!canEditBom || materialItems.length === 0}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs disabled:opacity-40"
                >
                  <Plus className="w-3.5 h-3.5" />
                  إضافة خامة / مادة تعبئة
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Production Orders Table */}
      {activeSection === 'orders' && (
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
                        {(ord.status === 'released' || ord.status === 'in_progress' || ord.status === 'draft') && (
                          <button
                            onClick={() => handleIssueMaterials(ord)}
                            className="px-2 py-1 bg-indigo-100 hover:bg-indigo-200 text-indigo-800 font-semibold rounded-lg text-xs flex items-center gap-1"
                            title="صرف الخامات والتعبئة من مستودع الخامات وفق BOM"
                          >
                            <PackageOpen className="w-3 h-3" />
                            صرف خامات
                          </button>
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
      )}

      {/* Create Order Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">إصدار أمر إنتاج وتشغيل جديد</h3>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            {formError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold flex flex-wrap items-center justify-between gap-2">
                <span>{formError}</span>
                {formError.includes('معادلة تصنيع') && (
                  <button
                    onClick={() => {
                      setShowCreateModal(false);
                      setActiveSection('bom');
                      handleSelectBomProduct(productId);
                    }}
                    className="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-lg text-[10px]"
                  >
                    الذهاب إلى إدارة معادلات التصنيع (BOM)
                  </button>
                )}
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
