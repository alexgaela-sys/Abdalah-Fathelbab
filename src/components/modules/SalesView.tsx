import React, { useState } from 'react';
import { 
  Plus, Search, ShoppingCart, AlertTriangle, 
  CheckCircle2, FileText, ArrowRight, Printer, Tag
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { WorkflowService } from '../../services/workflows';
import { SalesChannel, PaymentMethod } from '../../types/erp';
import { priceFor, channelForCustomerType, currencyForChannel, warehouseForChannel } from '../../services/pricing';
import { PermissionService } from '../../services/permissions';
import { AuthService } from '../../services/auth';
import InvoicePrint from './InvoicePrint';

export const SalesView: React.FC = () => {
  const db = erpDb.getSnapshot();
  // F15: UI gating — the service (AuthorizationService) remains the real boundary.
  const sessionRole = AuthService.getCurrentSession()?.user.role || 'Viewer';
  const canCreateSales = PermissionService.canCreate(sessionRole, 'sales');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedInvoice, setSelectedInvoice] = useState<any | null>(null);

  // Form State
  const [customerId, setCustomerId] = useState('');
  const [channel, setChannel] = useState<SalesChannel>('wholesale');
  const [warehouseId, setWarehouseId] = useState('wh-local');
  const [repId, setRepId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('credit');
  const [currency, setCurrency] = useState<'EGP' | 'USD'>('EGP');
  const [exchangeRate, setExchangeRate] = useState(db.company.currentUsdExchangeRate);
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  // F5: invoice-level tax treatment (default = current behavior: line rates govern)
  const [taxTreatment, setTaxTreatment] = useState<'taxable' | 'exempt'>('taxable');
  // F7: printable document state
  const [printInvoiceId, setPrintInvoiceId] = useState<string | null>(null);

  // Invoice Lines
  const [lines, setLines] = useState<Array<{
    itemId: string;
    quantity: number;
    freeQuantity: number;
    unitPrice: number;
    vatRate: number;
    /** F4: set when the user manually typed a price — re-pricing skips these lines. */
    priceOverridden?: boolean;
  }>>([]);

  const [formError, setFormError] = useState<string | null>(null);
  const [creditAlert, setCreditAlert] = useState<string | null>(null);

  const customers = db.customers.filter(c => c.active);
  const finishedProducts = db.items.filter(i => i.itemType === 'finished_product' && i.active);
  const salesReps = db.salesReps.filter(r => r.active);
  const warehouses = db.warehouses.filter(w => w.type === 'local_finished' || w.type === 'export_finished');

  const addLine = (e: React.MouseEvent<HTMLButtonElement>, channelOverride?: SalesChannel) => {
    e.preventDefault();
    const firstItem = finishedProducts[0];
    if (!firstItem) return;
    const effectiveChannel = channelOverride || channel;
    const price = priceFor(firstItem, effectiveChannel);

    setLines([
      ...lines,
      {
        itemId: firstItem.id,
        quantity: 10,
        freeQuantity: 0,
        unitPrice: price,
        vatRate: effectiveChannel === 'export' ? 0 : firstItem.vatRate,
        priceOverridden: false,
      }
    ]);
  };

  const removeLine = (index: number) => {
    setLines(lines.filter((_, i) => i !== index));
  };

  /** F4: re-price existing lines for a new channel — skipping manually overridden prices. */
  const repriceLinesForChannel = (
    currentLines: typeof lines,
    effectiveChannel: SalesChannel,
    applyVat: boolean
  ): typeof lines =>
    currentLines.map(l => {
      const itm = finishedProducts.find(i => i.id === l.itemId);
      if (!itm) return l;
      return {
        ...l,
        unitPrice: l.priceOverridden ? l.unitPrice : priceFor(itm, effectiveChannel),
        vatRate: applyVat ? (effectiveChannel === 'export' ? 0 : itm.vatRate) : l.vatRate,
      };
    });

  const updateLine = (index: number, field: string, val: any) => {
    const updated = [...lines];
    const current = { ...updated[index], [field]: val };

    // Auto update price when item changes (adopts the channel price, clearing any override)
    if (field === 'itemId') {
      const itm = finishedProducts.find(i => i.id === val);
      if (itm) {
        current.unitPrice = priceFor(itm, channel);
        current.vatRate = channel === 'export' ? 0 : itm.vatRate;
        current.priceOverridden = false;
      }
    }

    // Manual price edit marks the line as overridden (F4)
    if (field === 'unitPrice') {
      current.priceOverridden = true;
    }

    // Auto promotion helper: e.g. Buy 10 get 1 free
    if (field === 'applyPromo') {
      current.freeQuantity = Math.floor(current.quantity / 10);
    }

    updated[index] = current;
    setLines(updated);
  };

  /** F3: selecting a customer automatically applies their type:
   *  channel + currency + warehouse + (re)pricing of non-overridden lines. */
  const applyCustomer = (custId: string) => {
    setCustomerId(custId);
    const cust = db.customers.find(c => c.id === custId);
    if (!cust) return;
    const derivedChannel = channelForCustomerType(cust.customerType);
    const derivedCurrency = currencyForChannel(derivedChannel);
    const derivedWarehouse = warehouseForChannel(derivedChannel);
    setChannel(derivedChannel);
    setCurrency(derivedCurrency);
    setWarehouseId(derivedWarehouse);
    if (derivedChannel !== 'export') setExchangeRate(db.company.currentUsdExchangeRate);
    setLines(prev => repriceLinesForChannel(prev, derivedChannel, taxTreatment === 'taxable'));
  };

  /** Manual channel switch keeps currency/warehouse consistent and re-prices (F3/F4). */
  const applyChannel = (ch: SalesChannel) => {
    setChannel(ch);
    setCurrency(currencyForChannel(ch));
    setWarehouseId(warehouseForChannel(ch));
    setLines(prev => repriceLinesForChannel(prev, ch, taxTreatment === 'taxable'));
  };

  /** F5: switching tax treatment re-applies per-line rates; exempt forces 0%. */
  const applyTaxTreatment = (treatment: 'taxable' | 'exempt') => {
    setTaxTreatment(treatment);
    setLines(prev => prev.map(l => {
      if (treatment === 'exempt') return { ...l, vatRate: 0 };
      const itm = finishedProducts.find(i => i.id === l.itemId);
      return { ...l, vatRate: channel === 'export' ? 0 : (itm ? itm.vatRate : l.vatRate) };
    }));
  };

  const handleOpenCreate = () => {
    let defaultChannel: SalesChannel = 'wholesale';
    if (customers.length > 0) {
      setCustomerId(customers[0].id);
      defaultChannel = channelForCustomerType(customers[0].customerType);
    }
    setChannel(defaultChannel);
    setWarehouseId(warehouseForChannel(defaultChannel));
    setCurrency(currencyForChannel(defaultChannel));
    setTaxTreatment('taxable');
    setExchangeRate(db.company.currentUsdExchangeRate);
    setLines([]);
    setFormError(null);
    setCreditAlert(null);
    setShowCreateModal(true);
    setTimeout(() => addLine({ preventDefault() {} } as React.MouseEvent<HTMLButtonElement>, defaultChannel), 50);
  };

  const handleSaveInvoice = () => {
    setFormError(null);
    setCreditAlert(null);

    if (!customerId) {
      setFormError('يرجى اختيار العميل');
      return;
    }
    if (lines.length === 0) {
      setFormError('يجب إضافة صنف واحد على الأقل');
      return;
    }

    const res = WorkflowService.createSalesInvoice({
      customerId,
      channel,
      warehouseId,
      repId: repId || undefined,
      paymentMethod,
      currency,
      exchangeRate,
      date,
      notes,
      taxTreatment,
      lines: lines.map(l => ({
        itemId: l.itemId,
        quantity: Number(l.quantity),
        freeQuantity: Number(l.freeQuantity) || 0,
        unitPrice: Number(l.unitPrice),
        vatRate: Number(l.vatRate),
      })),
      userId: 'usr-admin',
      userName: 'مدير المبيعات',
    });

    if (!res.success) {
      setFormError(res.error || 'حدث خطأ أثناء حفظ الفاتورة');
      return;
    }

    if (res.creditWarning) {
      alert(res.creditWarning);
    }

    setShowCreateModal(false);
  };

  const filteredInvoices = db.salesInvoices.filter(inv => {
    const cust = db.customers.find(c => c.id === inv.customerId);
    const text = `${inv.invoiceNumber} ${cust?.name || ''}`.toLowerCase();
    return text.includes(searchQuery.toLowerCase());
  });

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">إدارة المبيعات والفواتير</h2>
          <p className="text-xs text-slate-500 mt-1">
            إصدار فواتير بيع محلية وتصدير، العروض الترويجية (البونص)، والربط الآلي بالمخزون ودفاتر الأستاذ
          </p>
        </div>

        <button
          onClick={handleOpenCreate}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-xs shadow-md transition ${
            canCreateSales
              ? 'bg-amber-500 hover:bg-amber-600 text-slate-950 cursor-pointer'
              : 'bg-slate-200 text-slate-400 cursor-not-allowed'
          }`}
          disabled={!canCreateSales}
          title={canCreateSales ? '' : 'لا تملك صلاحية إنشاء فواتير مبيعات'}
        >
          <Plus className="w-4 h-4" />
          <span>فاتورة بيع جديدة</span>
        </button>
      </div>

      {/* Search & Filters */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-3" />
          <input
            type="text"
            placeholder="بحث برقم الفاتورة أو اسم العميل..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pr-9 pl-4 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs focus:outline-none focus:border-amber-500 text-right"
          />
        </div>
        <div className="text-xs font-semibold text-slate-500">
          إجمالي الفواتير: <span className="font-bold text-slate-900">{filteredInvoices.length}</span>
        </div>
      </div>

      {/* Invoices Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold">
              <tr>
                <th className="p-3.5">رقم الفاتورة</th>
                <th className="p-3.5">التاريخ</th>
                <th className="p-3.5">العميل</th>
                <th className="p-3.5">القناة البيعية</th>
                <th className="p-3.5">طريقة الدفع</th>
                <th className="p-3.5">الإجمالي</th>
                <th className="p-3.5">القيد اليومي</th>
                <th className="p-3.5 text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredInvoices.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">
                    لا توجد فواتير مبيعات مسجلة حتى الآن
                  </td>
                </tr>
              ) : (
                filteredInvoices.map((inv) => {
                  const cust = db.customers.find(c => c.id === inv.customerId);
                  const jv = db.journalEntries.find(j => j.id === inv.journalEntryId);
                  return (
                    <tr key={inv.id} className="hover:bg-slate-50/80 transition">
                      <td className="p-3.5 font-bold font-mono text-slate-900">{inv.invoiceNumber}</td>
                      <td className="p-3.5 text-slate-600">{inv.date}</td>
                      <td className="p-3.5 font-semibold text-slate-800">{cust?.name || 'غير معروف'}</td>
                      <td className="p-3.5">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          inv.channel === 'retail' 
                            ? 'bg-blue-50 text-blue-700' 
                            : inv.channel === 'wholesale' 
                            ? 'bg-purple-50 text-purple-700' 
                            : 'bg-emerald-50 text-emerald-700'
                        }`}>
                          {inv.channel === 'retail' ? 'تجزئة' : inv.channel === 'wholesale' ? 'جملة' : 'تصدير'}
                        </span>
                      </td>
                      <td className="p-3.5 text-slate-600">
                        {inv.paymentMethod === 'cash' ? 'نقدًا' : inv.paymentMethod === 'bank_transfer' ? 'تحويل بنكي' : 'آجل'}
                      </td>
                      <td className="p-3.5 font-black text-slate-900 font-mono">
                        {inv.totalAmount.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {inv.currency}
                      </td>
                      <td className="p-3.5">
                        <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200">
                          {jv ? jv.entryNumber : 'مرحل'}
                        </span>
                      </td>
                      <td className="p-3.5 text-center">
                        <button
                          onClick={() => setSelectedInvoice(inv)}
                          className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold"
                        >
                          عرض
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

      {/* Create Sales Invoice Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[92vh] flex flex-col text-right overflow-hidden">
            {/* Header */}
            <div className="p-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShoppingCart className="w-5 h-5 text-amber-400" />
                <h3 className="font-bold text-sm">إصدار فاتورة مبيعات جديدة</h3>
              </div>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            {/* Body */}
            <div className="p-6 overflow-y-auto space-y-4">
              {formError && (
                <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              {/* Form Controls */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">العميل</label>
                  <select
                    value={customerId}
                    onChange={(e) => applyCustomer(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    {customers.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.customerType}) - حد ائتمان: {c.creditLimit.toLocaleString('ar-EG')} ج.م
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">القناة البيعية</label>
                  <select
                    value={channel}
                    onChange={(e) => applyChannel(e.target.value as SalesChannel)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    <option value="wholesale">جملة (Wholesale)</option>
                    <option value="retail">تجزئة (Retail)</option>
                    <option value="export">تصدير (Export - USD)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">المعالجة الضريبية (VAT)</label>
                  <select
                    value={taxTreatment}
                    onChange={(e) => applyTaxTreatment(e.target.value as 'taxable' | 'exempt')}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    <option value="taxable">خاضع للضريبة (Taxable - حسب الصنف)</option>
                    <option value="exempt">معفى / صفر ضريبة (Exempt - 0%)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">مستودع الصرف</label>
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
                  <label className="block text-xs font-bold text-slate-700 mb-1">طريقة الدفع</label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    <option value="credit">آجل على الحساب</option>
                    <option value="cash">نقدًا بالخزينة</option>
                    <option value="bank_transfer">تحويل بنكي</option>
                    <option value="cheque">شيك مصرفي</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">مندوب المبيعات</label>
                  <select
                    value={repId}
                    onChange={(e) => setRepId(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    <option value="">بدون مندوب (مبيعات إدارة مباشرة)</option>
                    {salesReps.map(r => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ الفاتورة</label>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  />
                </div>
              </div>

              {/* Line Items Table */}
              <div className="border border-slate-200 rounded-xl overflow-hidden mt-4">
                <div className="p-3 bg-slate-100 flex items-center justify-between">
                  <span className="font-bold text-xs text-slate-800">بنود الفاتورة والمنتجات</span>
                  <button
                    onClick={addLine}
                    className="px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold rounded-lg text-xs"
                  >
                    + إضافة صنف
                  </button>
                </div>

                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="p-2.5">المنتج (سناكس)</th>
                      <th className="p-2.5 w-24">الكمية</th>
                      <th className="p-2.5 w-28">بونص مجاني (عرض)</th>
                      <th className="p-2.5 w-28">السعر قبل الضريبة</th>
                      <th className="p-2.5 w-20">ضريبة %</th>
                      <th className="p-2.5 w-28">الإجمالي</th>
                      <th className="p-2.5 w-12"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lines.map((line, idx) => {
                      const lineTotal = line.quantity * line.unitPrice * (1 + line.vatRate);
                      return (
                        <tr key={idx}>
                          <td className="p-2">
                            <select
                              value={line.itemId}
                              onChange={(e) => updateLine(idx, 'itemId', e.target.value)}
                              className="w-full p-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                            >
                              {finishedProducts.map(fp => (
                                <option key={fp.id} value={fp.id}>
                                  {fp.nameAr} [{fp.productFamily}]
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
                              className="w-full p-1.5 rounded-lg border border-slate-300 text-xs text-center"
                            />
                          </td>
                          <td className="p-2">
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                min="0"
                                value={line.freeQuantity}
                                onChange={(e) => updateLine(idx, 'freeQuantity', Number(e.target.value))}
                                className="w-16 p-1.5 rounded-lg border border-emerald-300 bg-emerald-50/50 text-xs text-center font-bold"
                              />
                              <button
                                type="button"
                                onClick={() => updateLine(idx, 'applyPromo', true)}
                                title="تطبيق بونص 1 مجاني لكل 10 كراتين"
                                className="p-1 rounded bg-amber-100 text-amber-800 hover:bg-amber-200 text-[10px]"
                              >
                                عرض 10+1
                              </button>
                            </div>
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
                              type="number"
                              min="0"
                              step="1"
                              value={Math.round(line.vatRate * 100)}
                              onChange={(e) => updateLine(idx, 'vatRate', Math.max(0, Number(e.target.value)) / 100)}
                              title="نسبة ضريبة القيمة المضافة للبند (قابلة للتعديل - 0% أو 14%)"
                              className="w-full p-1.5 rounded-lg border border-slate-300 text-xs text-center font-mono"
                            />
                          </td>
                          <td className="p-2 font-mono font-bold">
                            {lineTotal.toFixed(2)} {currency}
                          </td>
                          <td className="p-2 text-center">
                            <button
                              onClick={() => removeLine(idx)}
                              className="text-rose-500 hover:text-rose-700 font-bold"
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

              {/* Total Summary */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 flex justify-between items-center text-xs">
                <span className="text-slate-500">
                  ملاحظة: البونص المجاني يظهر بسعر 0 على الفاتورة ويخصم من المخزون ويحمل على تكلفة المبيعات COGS
                </span>
                <div className="text-left font-mono space-y-1">
                  <div className="text-sm font-black text-slate-900">
                    الإجمالي النهائي: {lines.reduce((s, l) => s + (l.quantity * l.unitPrice * (1 + l.vatRate)), 0).toFixed(2)} {currency}
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="p-4 bg-slate-100 border-t border-slate-200 flex items-center justify-end gap-2">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold text-xs"
              >
                إلغاء
              </button>
              <button
                onClick={handleSaveInvoice}
                className="px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-black text-xs shadow-md"
              >
                حفظ وترحيل الفاتورة بالدفاتر
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View Selected Invoice Modal */}
      {selectedInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-3xl p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">
                فاتورة مبيعات: {selectedInvoice.invoiceNumber}
              </h3>
              <button onClick={() => setSelectedInvoice(null)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-slate-50 p-3 rounded-xl border border-slate-200">
              <div>
                <span className="text-slate-400 block">التاريخ:</span>
                <span className="font-bold text-slate-800">{selectedInvoice.date}</span>
              </div>
              <div>
                <span className="text-slate-400 block">العميل:</span>
                <span className="font-bold text-slate-800">
                  {db.customers.find(c => c.id === selectedInvoice.customerId)?.name}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block">القناة:</span>
                <span className="font-bold text-slate-800">{selectedInvoice.channel}</span>
              </div>
              <div>
                <span className="text-slate-400 block">القيمة الإجمالية:</span>
                <span className="font-black text-slate-900 font-mono">
                  {selectedInvoice.totalAmount.toLocaleString('ar-EG')} {selectedInvoice.currency}
                </span>
              </div>
            </div>

            {/* Lines list */}
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-100 text-slate-700">
                  <tr>
                    <th className="p-2">الصنف</th>
                    <th className="p-2 text-center">الكمية المباعة</th>
                    <th className="p-2 text-center">بونص مجاني</th>
                    <th className="p-2 text-center">سعر الوحدة</th>
                    <th className="p-2 text-left">الإجمالي</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {db.salesInvoiceLines.filter(l => l.invoiceId === selectedInvoice.id).map(line => {
                    const itm = db.items.find(i => i.id === line.itemId);
                    return (
                      <tr key={line.id}>
                        <td className="p-2 font-bold">{itm?.nameAr || line.itemId}</td>
                        <td className="p-2 text-center font-mono">{line.quantity} كرتونة</td>
                        <td className="p-2 text-center font-mono text-emerald-700 font-bold">{line.freeQuantity || 0}</td>
                        <td className="p-2 text-center font-mono">{line.unitPrice}</td>
                        <td className="p-2 text-left font-mono font-black">{line.netTotal.toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end pt-2 gap-2">
              <button
                onClick={() => setPrintInvoiceId(selectedInvoice.id)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs border border-slate-300"
              >
                <Printer className="w-4 h-4" />
                طباعة الفاتورة
              </button>
              <button
                onClick={() => setSelectedInvoice(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 text-white font-bold text-xs"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* F7: printable invoice document (browser print / PDF) */}
      {printInvoiceId && (
        <InvoicePrint invoiceId={printInvoiceId} onClose={() => setPrintInvoiceId(null)} />
      )}
    </div>
  );
};
