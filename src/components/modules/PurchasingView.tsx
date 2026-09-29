import React, { useState } from 'react';
import { 
  Plus, Search, ShoppingBag, Truck, Calendar, 
  ArrowRight, TrendingDown, TrendingUp, AlertCircle
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { WorkflowService } from '../../services/workflows';
import { PaymentMethod } from '../../types/erp';

export const PurchasingView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'invoices' | 'price_comparison'>('invoices');

  // Form State
  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('wh-raw');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('credit');
  const [currency, setCurrency] = useState<'EGP' | 'USD'>('EGP');
  const [exchangeRate, setExchangeRate] = useState(1);
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');

  // Line items
  const [lines, setLines] = useState<Array<{
    itemId: string;
    quantity: number;
    unitId: string;
    unitPrice: number;
    batchNumber: string;
    productionDate: string;
    expiryDate: string;
    vatRate: number;
  }>>([]);

  const [formError, setFormError] = useState<string | null>(null);

  const suppliers = db.suppliers.filter(s => s.active);
  const rawAndPackagingItems = db.items.filter(i => 
    i.itemType === 'raw_material' || i.itemType === 'packaging_material'
  );
  const warehouses = db.warehouses.filter(w => w.type === 'raw_materials');

  const addLine = () => {
    const first = rawAndPackagingItems[0];
    if (!first) return;
    const today = new Date().toISOString().split('T')[0];
    // Expiry strictly from the item's configured period (never a hardcoded 180 days)
    const expDate = first.trackExpiry && first.expiryPeriodDays && first.expiryPeriodDays > 0
      ? new Date(Date.now() + first.expiryPeriodDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      : '';

    setLines([
      ...lines,
      {
        itemId: first.id,
        quantity: 100,
        unitId: first.baseUnitId,
        unitPrice: first.standardCost || 50,
        batchNumber: '', // intentionally empty: user enters the supplier's real batch number
        productionDate: today,
        expiryDate: expDate,
        vatRate: first.vatRate,
      }
    ]);
  };

  const removeLine = (index: number) => {
    setLines(lines.filter((_, i) => i !== index));
  };

  const updateLine = (index: number, field: string, val: any) => {
    const updated = [...lines];
    const current = { ...updated[index], [field]: val };
    if (field === 'itemId') {
      const itm = rawAndPackagingItems.find(i => i.id === val);
      if (itm) {
        current.unitId = itm.baseUnitId;
        current.unitPrice = itm.standardCost || 50;
        current.vatRate = itm.vatRate;
      }
    }
    updated[index] = current;
    setLines(updated);
  };

  const handleOpenCreate = () => {
    if (suppliers.length > 0) setSupplierId(suppliers[0].id);
    setWarehouseId('wh-raw');
    setPaymentMethod('credit');
    setCurrency('EGP');
    setReference('');
    setLines([]);
    setFormError(null);
    setShowCreateModal(true);
    setTimeout(() => addLine(), 50);
  };

  const handleSaveInvoice = () => {
    setFormError(null);
    if (!supplierId) {
      setFormError('يرجى اختيار المورد');
      return;
    }
    if (lines.length === 0) {
      setFormError('يجب إضافة أصناف ومواد خام للفاتورة');
      return;
    }

    // Batch numbers are mandatory for batch-tracked items (traceability requirement)
    for (const l of lines) {
      const itm = db.items.find(i => i.id === l.itemId);
      if (itm?.trackBatch && !l.batchNumber.trim()) {
        setFormError(`يرجى إدخال رقم تشغيلة للصنف (${itm.nameAr}) لأنه صنف متتبع بالتشغيلات`);
        return;
      }
    }

    const res = WorkflowService.createPurchaseInvoice({
      supplierId,
      warehouseId,
      paymentMethod,
      currency,
      exchangeRate,
      reference,
      date,
      notes,
      lines: lines.map(l => ({
        itemId: l.itemId,
        quantity: Number(l.quantity),
        unitId: l.unitId,
        unitPrice: Number(l.unitPrice),
        batchNumber: l.batchNumber,
        productionDate: l.productionDate,
        expiryDate: l.expiryDate,
        vatRate: Number(l.vatRate),
      })),
      userId: 'usr-admin',
      userName: 'مدير المشتريات',
    });

    if (!res.success) {
      setFormError(res.error || 'حدث خطأ أثناء حفظ فاتورة المشتريات');
      return;
    }

    setShowCreateModal(false);
  };

  // Price comparison calculation
  // Supplier, Item, Last price, Current price, Previous price, Price difference, Difference %
  const priceHistoryList = rawAndPackagingItems.map(item => {
    const relatedLines = db.purchaseInvoiceLines
      .filter(l => l.itemId === item.id)
      .map(l => {
        const inv = db.purchaseInvoices.find(p => p.id === l.purchaseInvoiceId);
        return {
          line: l,
          date: inv?.date || '',
          supplierId: inv?.supplierId || '',
          price: l.unitPrice,
        };
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const latest = relatedLines[0];
    const previous = relatedLines[1];

    const currentPrice = latest ? latest.price : item.standardCost;
    const prevPrice = previous ? previous.price : currentPrice;
    const diff = currentPrice - prevPrice;
    const diffPercent = prevPrice > 0 ? (diff / prevPrice) * 100 : 0;

    const supplier = db.suppliers.find(s => s.id === latest?.supplierId);

    return {
      item,
      supplierName: supplier?.name || 'مورد عام',
      currentPrice,
      prevPrice,
      diff,
      diffPercent,
    };
  });

  const filteredInvoices = db.purchaseInvoices.filter(inv => {
    const sup = db.suppliers.find(s => s.id === inv.supplierId);
    const text = `${inv.invoiceNumber} ${sup?.name || ''} ${inv.reference || ''}`.toLowerCase();
    return text.includes(searchQuery.toLowerCase());
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">إدارة المشتريات واستلام الخامات</h2>
          <p className="text-xs text-slate-500 mt-1">
            فاتورة استلام مواد خام ومواد تعبئة، متابعة أسعار الموردين، وإثبات قيود المشتريات وحسابات الموردين
          </p>
        </div>

        <button
          onClick={handleOpenCreate}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition"
        >
          <Plus className="w-4 h-4" />
          <span>فاتورة استلام خامات جديدة</span>
        </button>
      </div>

      {/* Tabs Switcher */}
      <div className="flex gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setActiveTab('invoices')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'invoices' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          سجل فواتير استلام الخامات
        </button>
        <button
          onClick={() => setActiveTab('price_comparison')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'price_comparison' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          مقارنة وتاريخ أسعار الموردين
        </button>
      </div>

      {activeTab === 'invoices' && (
        <>
          {/* Search */}
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
            <div className="relative flex-1 max-w-md">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-3" />
              <input
                type="text"
                placeholder="بحث برقم الفاتورة أو اسم المورد..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pr-9 pl-4 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs focus:outline-none focus:border-amber-500 text-right"
              />
            </div>
            <span className="text-xs text-slate-500 font-semibold">
              إجمالي الفواتير: <span className="font-bold text-slate-900">{filteredInvoices.length}</span>
            </span>
          </div>

          {/* Table */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold">
                <tr>
                  <th className="p-3.5">رقم الفاتورة</th>
                  <th className="p-3.5">التاريخ</th>
                  <th className="p-3.5">المورد</th>
                  <th className="p-3.5">طريقة السداد</th>
                  <th className="p-3.5">المرجع / إذن الاستلام</th>
                  <th className="p-3.5">الإجمالي</th>
                  <th className="p-3.5">رقم القيد اليومي</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredInvoices.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-400">
                      لا توجد فواتير مشتريات مسجلة حتى الآن
                    </td>
                  </tr>
                ) : (
                  filteredInvoices.map((inv) => {
                    const sup = db.suppliers.find(s => s.id === inv.supplierId);
                    const jv = db.journalEntries.find(j => j.id === inv.journalEntryId);
                    return (
                      <tr key={inv.id} className="hover:bg-slate-50/80 transition">
                        <td className="p-3.5 font-bold font-mono text-slate-900">{inv.invoiceNumber}</td>
                        <td className="p-3.5 text-slate-600">{inv.date}</td>
                        <td className="p-3.5 font-semibold text-slate-800">{sup?.name || 'غير معروف'}</td>
                        <td className="p-3.5 text-slate-600">
                          {inv.paymentMethod === 'cash' ? 'نقدًا' : inv.paymentMethod === 'bank_transfer' ? 'تحويل بنكي' : 'آجل'}
                        </td>
                        <td className="p-3.5 text-slate-600 font-mono">{inv.reference || '-'}</td>
                        <td className="p-3.5 font-black text-slate-900 font-mono">
                          {inv.totalAmount.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {inv.currency}
                        </td>
                        <td className="p-3.5">
                          <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200">
                            {jv ? jv.entryNumber : 'مرحل'}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {activeTab === 'price_comparison' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200">
            <h3 className="font-bold text-xs text-slate-800">سجل مقارنة أسعار توريد الخامات ومواد التعبئة</h3>
            <p className="text-[11px] text-slate-500">متابعة تقلبات أسعار شراء المواد الخام والعبوات ونسب الفروق</p>
          </div>
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-100 text-slate-700 font-bold">
              <tr>
                <th className="p-3">المادة / الصنف</th>
                <th className="p-3">آخر مورد</th>
                <th className="p-3 text-center">السعر الحالي</th>
                <th className="p-3 text-center">السعر السابق</th>
                <th className="p-3 text-center">فارق السعر</th>
                <th className="p-3 text-center">نسبة التغير %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {priceHistoryList.map(({ item, supplierName, currentPrice, prevPrice, diff, diffPercent }) => (
                <tr key={item.id} className="hover:bg-slate-50">
                  <td className="p-3 font-bold text-slate-900">{item.nameAr}</td>
                  <td className="p-3 text-slate-600">{supplierName}</td>
                  <td className="p-3 text-center font-mono font-bold">{currentPrice.toFixed(2)} ج.م</td>
                  <td className="p-3 text-center font-mono text-slate-500">{prevPrice.toFixed(2)} ج.م</td>
                  <td className="p-3 text-center font-mono font-bold">
                    <span className={diff > 0 ? 'text-rose-600' : diff < 0 ? 'text-emerald-600' : 'text-slate-600'}>
                      {diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)} ج.م
                    </span>
                  </td>
                  <td className="p-3 text-center font-mono font-bold">
                    <span className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] ${
                      diff > 0 ? 'bg-rose-50 text-rose-700' : diff < 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-700'
                    }`}>
                      {diff > 0 ? <TrendingUp className="w-3 h-3" /> : diff < 0 ? <TrendingDown className="w-3 h-3" /> : null}
                      {diffPercent.toFixed(1)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Purchase Invoice Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[92vh] flex flex-col text-right overflow-hidden">
            <div className="p-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShoppingBag className="w-5 h-5 text-amber-400" />
                <h3 className="font-bold text-sm">فاتورة استلام خامات ومواد تعبئة (Material Receipt)</h3>
              </div>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4">
              {formError && (
                <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold">
                  {formError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">المورد</label>
                  <select
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    {suppliers.map(s => (
                      <option key={s.id} value={s.id}>{s.name} ({s.paymentTerms})</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">مستودع الاستلام</label>
                  <select
                    value={warehouseId}
                    onChange={(e) => setWarehouseId(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    {warehouses.map(w => (
                      <option key={w.id} value={w.id}>{w.nameAr}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">طريقة السداد</label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    <option value="credit">آجل على الحساب</option>
                    <option value="cash">نقدًا من الخزينة</option>
                    <option value="bank_transfer">تحويل بنكي</option>
                    <option value="cheque">شيك مصرفي</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">إذن الاستلام / المرجع</label>
                  <input
                    type="text"
                    placeholder="مثال: إذن فحص مخزني 401"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ الاستلام</label>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  />
                </div>
              </div>

              {/* Line items */}
              <div className="border border-slate-200 rounded-xl overflow-hidden mt-4">
                <div className="p-3 bg-slate-100 flex items-center justify-between">
                  <span className="font-bold text-xs text-slate-800">الأصناف والخامات المستلمة والتشغيلات</span>
                  <button
                    onClick={addLine}
                    className="px-2.5 py-1 bg-slate-900 text-white rounded-lg text-xs font-bold"
                  >
                    + إضافة مادة خام / تعبئة
                  </button>
                </div>

                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="p-2">المادة</th>
                      <th className="p-2 w-24">الكمية</th>
                      <th className="p-2 w-24">السعر</th>
                      <th className="p-2 w-32">رقم التشغيلة</th>
                      <th className="p-2 w-28">تاريخ الصلاحية</th>
                      <th className="p-2 w-24">الإجمالي</th>
                      <th className="p-2 w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lines.map((line, idx) => {
                      const total = line.quantity * line.unitPrice * (1 + line.vatRate);
                      return (
                        <tr key={idx}>
                          <td className="p-2">
                            <select
                              value={line.itemId}
                              onChange={(e) => updateLine(idx, 'itemId', e.target.value)}
                              className="w-full p-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                            >
                              {rawAndPackagingItems.map(itm => (
                                <option key={itm.id} value={itm.id}>
                                  {itm.nameAr} [{itm.itemType === 'raw_material' ? 'خام' : 'تعبئة'}]
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              min="1"
                              value={line.quantity}
                              onChange={(e) => updateLine(idx, 'quantity', Number(e.target.value))}
                              className="w-full p-1.5 rounded-lg border border-slate-300 text-xs text-center font-mono"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              step="0.01"
                              value={line.unitPrice}
                              onChange={(e) => updateLine(idx, 'unitPrice', Number(e.target.value))}
                              className="w-full p-1.5 rounded-lg border border-slate-300 text-xs text-center font-mono"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="text"
                              value={line.batchNumber}
                              onChange={(e) => updateLine(idx, 'batchNumber', e.target.value)}
                              className="w-full p-1.5 rounded-lg border border-slate-300 text-xs font-mono"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="date"
                              value={line.expiryDate}
                              onChange={(e) => updateLine(idx, 'expiryDate', e.target.value)}
                              className="w-full p-1.5 rounded-lg border border-slate-300 text-xs"
                            />
                          </td>
                          <td className="p-2 font-mono font-bold">
                            {total.toFixed(2)} ج.م
                          </td>
                          <td className="p-2 text-center">
                            <button
                              onClick={() => removeLine(idx)}
                              className="text-rose-500 font-bold"
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Total */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 flex justify-between items-center text-xs">
                <span className="text-slate-500">
                  ملاحظة: تضاف الكميات فورًا لمستودع المواد الخام مع إثبات قيد محاسبي دائن للمورد ومدين للمخزون
                </span>
                <div className="text-sm font-black text-slate-900 font-mono">
                  الإجمالي: {lines.reduce((s, l) => s + (l.quantity * l.unitPrice * (1 + l.vatRate)), 0).toFixed(2)} ج.م
                </div>
              </div>
            </div>

            <div className="p-4 bg-slate-100 border-t border-slate-200 flex items-center justify-end gap-2">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold text-xs"
              >
                إلغاء
              </button>
              <button
                onClick={handleSaveInvoice}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md"
              >
                حفظ وترحيل الاستلام المخزني
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
