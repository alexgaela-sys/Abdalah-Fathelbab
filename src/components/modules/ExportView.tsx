import React, { useState } from 'react';
import { 
  Globe, Plus, Ship, DollarSign, TrendingUp, 
  Search, Anchor, FileCheck, CheckCircle2, Link2, Banknote
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { WorkflowService } from '../../services/workflows';
import { AuthService } from '../../services/auth';
import { PermissionService } from '../../services/permissions';
import { ExportShipment } from '../../types/erp';

export const ExportView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedShipment, setSelectedShipment] = useState<ExportShipment | null>(null);
  const sessionRole = AuthService.getCurrentSession()?.user.role;
  const canCollect = sessionRole ? PermissionService.canCreate(sessionRole, 'export') : true;

  // New Shipment form
  const [customerId, setCustomerId] = useState('');
  const [salesInvoiceId, setSalesInvoiceId] = useState('');
  const [portOfOrigin, setPortOfOrigin] = useState('ميناء الإسكندرية الدولي');
  const [destinationPort, setDestinationPort] = useState('ميناء جبل علي - دبي');
  const [containerNumber, setContainerNumber] = useState('');
  const [usdRevenue, setUsdRevenue] = useState(15000);
  const [exchangeRate, setExchangeRate] = useState(db.company.currentUsdExchangeRate);
  const [productCost, setProductCost] = useState(420000);
  const [shippingCost, setShippingCost] = useState(45000);
  const [portCosts, setPortCosts] = useState(15000);
  const [customsCost, setCustomsCost] = useState(10000);
  const [otherCosts, setOtherCosts] = useState(5000);
  const [shipmentDate, setShipmentDate] = useState(new Date().toISOString().split('T')[0]);

  // Collection modal state
  const [showCollectModal, setShowCollectModal] = useState<ExportShipment | null>(null);
  const [collectUsd, setCollectUsd] = useState(0);
  const [collectRate, setCollectRate] = useState(db.company.currentUsdExchangeRate);
  const [collectBankId, setCollectBankId] = useState('');
  const [collectDate, setCollectDate] = useState(new Date().toISOString().split('T')[0]);

  const exportCustomers = db.customers.filter(c => c.customerType === 'export');

  // F12: only posted, unlinked USD export invoices are linkable.
  const linkableInvoices = db.salesInvoices.filter(i =>
    i.channel === 'export' && i.currency === 'USD' && i.status === 'posted' && !i.exportShipmentId
  );
  const selectedInvoice = db.salesInvoices.find(i => i.id === salesInvoiceId);

  const usdBanks = db.bankAccounts.filter(b => b.currency === 'USD');

  const handleSelectInvoice = (invoiceId: string) => {
    setSalesInvoiceId(invoiceId);
    const inv = db.salesInvoices.find(i => i.id === invoiceId);
    if (!inv) return;
    // F12: revenue / FX / product cost are DERIVED from the posted invoice.
    setCustomerId(inv.customerId);
    setUsdRevenue(inv.totalAmount);
    setExchangeRate(inv.exchangeRate);
    setProductCost(inv.cogsTotal);
  };

  const handleSaveShipment = () => {
    if (!customerId) {
      alert('يرجى اختيار عميل التصدير');
      return;
    }

    const res = WorkflowService.createExportShipment({
      customerId,
      shipmentDate,
      portOfOrigin,
      destinationPort,
      containerNumber: containerNumber.trim() || undefined,
      usdRevenue: Number(usdRevenue),
      exchangeRate: Number(exchangeRate),
      productCost: Number(productCost),
      shippingCost: Number(shippingCost),
      portCosts: Number(portCosts),
      customsCost: Number(customsCost),
      otherExportCosts: Number(otherCosts),
      salesInvoiceId: salesInvoiceId || undefined,
    });

    if (!res.success) {
      alert(res.error || 'خطأ في تسجيل شحنة التصدير');
      return;
    }

    setShowAddModal(false);
    setSalesInvoiceId('');
  };

  const handleSaveCollection = () => {
    if (!showCollectModal) return;
    const res = WorkflowService.recordExportCollection({
      shipmentId: showCollectModal.id,
      amountUsd: Number(collectUsd),
      actualExchangeRate: Number(collectRate),
      bankAccountId: collectBankId || undefined,
      date: collectDate,
      userId: 'usr-admin',
      userName: 'المشرف العام (Admin)',
    });
    if (!res.success) {
      alert(res.error || 'خطأ في تسجيل تحصيل التصدير');
      return;
    }
    setShowCollectModal(null);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">إدارة التصدير والشحنات الخارجية (Export)</h2>
          <p className="text-xs text-slate-500 mt-1">
            متابعة شحنات التصدير بالدولار USD، فروق الصرف بالجنيه EGP، تكاليف الموانئ والجمارك، وربحية الشحنات
          </p>
        </div>

        <button
          onClick={() => {
            if (exportCustomers.length > 0) setCustomerId(exportCustomers[0].id);
            setExchangeRate(db.company.currentUsdExchangeRate);
            setShowAddModal(true);
          }}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition"
        >
          <Plus className="w-4 h-4" />
          <span>تسجيل شحنة تصدير جديدة</span>
        </button>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-slate-500">إجمالي إيراد التصدير (USD)</span>
            <div className="text-xl font-black text-slate-900 font-mono mt-1">
              ${db.exportShipments.reduce((s, sh) => s + sh.usdRevenue, 0).toLocaleString('en-US')}
            </div>
            <div className="text-[11px] text-emerald-600 font-semibold mt-1">
              ما يعادل {db.exportShipments.reduce((s, sh) => s + sh.egpValue, 0).toLocaleString('ar-EG')} ج.م
            </div>
          </div>
          <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
            <DollarSign className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-slate-500">تكاليف الشحن والموانئ والتخليص</span>
            <div className="text-xl font-black text-slate-900 font-mono mt-1">
              {db.exportShipments.reduce((s, sh) => s + (sh.shippingCost + sh.portCosts + sh.customsCost), 0).toLocaleString('ar-EG')} ج.م
            </div>
            <div className="text-[11px] text-slate-400 mt-1">نولون ومصاريف موانئ</div>
          </div>
          <div className="w-12 h-12 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
            <Anchor className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-slate-500">صافي ربحية شحنات التصدير</span>
            <div className="text-xl font-black text-emerald-700 font-mono mt-1">
              {db.exportShipments.reduce((s, sh) => s + sh.netProfitEGP, 0).toLocaleString('ar-EG')} ج.م
            </div>
            <div className="text-[11px] text-indigo-600 font-semibold mt-1">
              بعد خصم تكلفة المنتج ومصاريف الشحن
            </div>
          </div>
          <div className="w-12 h-12 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center">
            <TrendingUp className="w-6 h-6" />
          </div>
        </div>
      </div>

      {/* Shipments Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200">
          <h3 className="font-bold text-xs text-slate-800">جدول شحنات التصدير وتحليل ربحية كل شحنة</h3>
        </div>

        <table className="w-full text-right text-xs">
          <thead className="bg-slate-100 text-slate-700 font-bold">
            <tr>
              <th className="p-3.5">رقم الشحنة</th>
              <th className="p-3.5">العميل المستورد</th>
              <th className="p-3.5">ميناء الوصول</th>
              <th className="p-3.5 text-center">فاتورة التصدير</th>
              <th className="p-3.5 text-center">الإيراد ($)</th>
              <th className="p-3.5 text-center">سعر الصرف</th>
              <th className="p-3.5 text-center">القيمة بالمصري</th>
              <th className="p-3.5 text-center">صافي الربح (ج.م)</th>
              <th className="p-3.5 text-center">هامش الربح %</th>
              <th className="p-3.5 text-center">المحصّل ($)</th>
              <th className="p-3.5 text-center">الحالة</th>
              <th className="p-3.5 text-center">تحصيل</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-mono">
            {db.exportShipments.length === 0 ? (                <tr>
                  <td colSpan={11} className="py-12 text-center text-slate-400 font-sans">
                    لا توجد شحنات تصدير مسجلة حالياً
                  </td>
                </tr>
            ) : (
              db.exportShipments.map(shp => {
                const cust = db.customers.find(c => c.id === shp.customerId);
                return (
                  <tr key={shp.id} className="hover:bg-slate-50">
                    <td className="p-3.5 font-bold text-slate-900">{shp.shipmentNumber}</td>
                    <td className="p-3.5 font-sans font-bold text-slate-800">{cust?.name}</td>
                    <td className="p-3.5 font-sans text-slate-600">{shp.destinationPort}</td>
                    <td className="p-3.5 text-center font-black text-emerald-700">
                      ${shp.usdRevenue.toLocaleString('en-US')}
                    </td>
                    <td className="p-3.5 text-center text-slate-600">{shp.exchangeRate.toFixed(2)}</td>
                    <td className="p-3.5 text-center font-bold text-slate-900">
                      {shp.egpValue.toLocaleString('ar-EG')}
                    </td>
                    <td className="p-3.5 text-center font-black text-emerald-700">
                      {shp.netProfitEGP.toLocaleString('ar-EG')}
                    </td>
                    <td className="p-3.5 text-center font-bold text-indigo-700">
                      {shp.profitMarginPercent.toFixed(1)}%
                    </td>
                    <td className="p-3.5 text-center font-sans font-mono text-[10px] text-slate-500">
                      {shp.salesInvoiceId
                        ? db.salesInvoices.find(i => i.id === shp.salesInvoiceId)?.invoiceNumber || '-'
                        : 'يدوية'}
                    </td>
                    <td className="p-3.5 text-center font-mono font-bold text-slate-700">
                      ${(shp.collectedUsd || 0).toLocaleString('en-US')}
                      <span className="text-slate-400"> / {shp.usdRevenue.toLocaleString('en-US')}</span>
                    </td>
                    <td className="p-3.5 text-center font-sans">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                        shp.collectionStatus === 'collected'
                          ? 'bg-emerald-100 text-emerald-800'
                          : shp.collectionStatus === 'partially_collected'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-slate-200 text-slate-700'
                      }`}>
                        {shp.collectionStatus === 'collected' ? 'محصّلة بالكامل' : shp.collectionStatus === 'partially_collected' ? 'تحصيل جزئي' : 'لم تُحصّل'}
                      </span>
                    </td>
                    <td className="p-3.5 text-center font-sans">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => {
                            setShowCollectModal(shp);
                            setCollectUsd(Number((shp.usdRevenue - (shp.collectedUsd || 0)).toFixed(2)));
                            setCollectRate(db.company.currentUsdExchangeRate);
                            setCollectBankId(usdBanks[0]?.id || '');
                            setCollectDate(new Date().toISOString().split('T')[0]);
                          }}
                          disabled={!canCollect || shp.collectionStatus === 'collected'}
                          title={shp.collectionStatus === 'collected' ? 'تم تحصيل كامل قيمة الشحنة' : 'تسجيل تحصيل دولار من العميل'}
                          className="px-2 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-bold rounded-lg text-xs border border-emerald-200 disabled:opacity-40"
                        >
                          <Banknote className="w-3 h-3 inline" /> تحصيل
                        </button>
                        {shp.salesInvoiceId && (
                          <span
                            className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-indigo-50 text-indigo-700"
                            title={`مرتبطة بفاتورة التصدير ${db.salesInvoices.find(i => i.id === shp.salesInvoiceId)?.invoiceNumber || ''}`}
                          >
                            <Link2 className="w-3 h-3 inline" /> مرتبطة بفاتورة
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Add Shipment Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">تسجيل شحنة تصدير وتكاليف لوجستية</h3>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="space-y-3">
              {/* F12: link the shipment to the originating posted export sales invoice */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  فاتورة البيع بالتصدير المرتبطة (تُحسب الإيراد والتكلفة وسعر الصرف تلقائياً منها)
                </label>
                <select
                  value={salesInvoiceId}
                  onChange={(e) => handleSelectInvoice(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                >
                  <option value="">— بدون ربط (إدخال يدوي) —</option>
                  {linkableInvoices.map(inv => (
                    <option key={inv.id} value={inv.id}>
                      {inv.invoiceNumber} — {db.customers.find(c => c.id === inv.customerId)?.name || ''} — ${inv.totalAmount.toLocaleString('en-US')} @ {inv.exchangeRate}
                    </option>
                  ))}
                </select>
                {selectedInvoice ? (
                  <div className="mt-2 p-2.5 rounded-xl bg-indigo-50 border border-indigo-200 text-[11px] text-indigo-900 space-y-1">
                    <div>إيراد الفاتورة: <span className="font-mono font-bold">${selectedInvoice.totalAmount.toLocaleString('en-US')}</span> — بقيمة <span className="font-mono font-bold">{selectedInvoice.totalAmountEGP.toLocaleString('ar-EG')} ج.م</span></div>
                    <div>سعر الصرف بالفاتورة: <span className="font-mono font-bold">{selectedInvoice.exchangeRate}</span> — تكلفة البضاعة المسجلة بالمحاسبة (5102): <span className="font-mono font-bold">{selectedInvoice.cogsTotal.toLocaleString('ar-EG')} ج.م</span></div>
                    <div>قيود الإيراد (4103) والمديونية (1106) وتكلفة البضاعة (5102) وحركة مستودع التصدير WH-03 مرحّلة بالفعل بالفاتورة — لا تُرحّل مرة ثانية.</div>
                  </div>
                ) : (
                  <p className="mt-1 text-[11px] text-slate-500">
                    إن لم تربط بفاتورة، لن تُرحّل قيود الإيراد والتكلفة — استخدم فاتورة بيع قناة التصدير أولاً.
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">عميل التصدير</label>
                  <select
                    value={customerId}
                    onChange={(e) => setCustomerId(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    {exportCustomers.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">رقم الحاوية (Container)</label>
                  <input
                    type="text"
                    placeholder="مثال: MSCU-19283-0"
                    value={containerNumber}
                    onChange={(e) => setContainerNumber(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">ميناء الشحن (مصر)</label>
                  <input
                    type="text"
                    value={portOfOrigin}
                    onChange={(e) => setPortOfOrigin(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">ميناء الوصول الخارجي</label>
                  <input
                    type="text"
                    value={destinationPort}
                    onChange={(e) => setDestinationPort(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">قيمة المبيعات بالدولار ($)</label>
                  <input
                    type="number"
                    value={usdRevenue}
                    onChange={(e) => setUsdRevenue(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">سعر الصرف اليدوي (ج.م / $)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={exchangeRate}
                    onChange={(e) => setExchangeRate(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-slate-100">
                <div>
                  <label className="block text-[11px] font-bold text-slate-600 mb-1">تكلفة المنتج التام</label>
                  <input
                    type="number"
                    value={productCost}
                    onChange={(e) => setProductCost(Number(e.target.value))}
                    className="w-full p-1.5 rounded-lg border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-600 mb-1">نولون الشحن البحري</label>
                  <input
                    type="number"
                    value={shippingCost}
                    onChange={(e) => setShippingCost(Number(e.target.value))}
                    className="w-full p-1.5 rounded-lg border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-600 mb-1">رسوم موانئ وأرضيات</label>
                  <input
                    type="number"
                    value={portCosts}
                    onChange={(e) => setPortCosts(Number(e.target.value))}
                    className="w-full p-1.5 rounded-lg border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-600 mb-1">تخليص جمركي</label>
                  <input
                    type="number"
                    value={customsCost}
                    onChange={(e) => setCustomsCost(Number(e.target.value))}
                    className="w-full p-1.5 rounded-lg border border-slate-300 text-xs font-mono"
                  />
                </div>
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
                onClick={handleSaveShipment}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md"
              >
                حفظ الشحنة واحتساب الربحية
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export collection modal (F12) */}
      {showCollectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-md p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">
                تحصيل شحنة التصدير {showCollectModal.shipmentNumber}
              </h3>
              <button onClick={() => setShowCollectModal(null)} className="text-slate-400 hover:text-slate-700">✕</button>
            </div>

            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-[11px] text-slate-700 space-y-1">
              <div>إيراد الشحنة: <span className="font-mono font-bold">${showCollectModal.usdRevenue.toLocaleString('en-US')}</span></div>
              <div>سبق تحصيله: <span className="font-mono font-bold">${(showCollectModal.collectedUsd || 0).toLocaleString('en-US')}</span></div>
              <div>المتبقي: <span className="font-mono font-bold text-emerald-700">${(showCollectModal.usdRevenue - (showCollectModal.collectedUsd || 0)).toLocaleString('en-US')}</span></div>
              <div>سعر صرف الشحنة التاريخي: <span className="font-mono font-bold">{showCollectModal.exchangeRate}</span> — الفرق بين السعر الفعلي والتاريخي يُرحّل كفروق صرف (ربح/خسارة).</div>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">المبلغ المحصّل ($)</label>
                  <input
                    type="number" step="0.01" min="0"
                    value={collectUsd}
                    onChange={(e) => setCollectUsd(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">سعر الصرف الفعلي (ج.م / $)</label>
                  <input
                    type="number" step="0.01" min="0"
                    value={collectRate}
                    onChange={(e) => setCollectRate(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono font-bold"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">البنك / حساب USD</label>
                <select
                  value={collectBankId}
                  onChange={(e) => setCollectBankId(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  {usdBanks.map(b => (
                    <option key={b.id} value={b.id}>{b.bankName} — {b.accountNumber}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ التحصيل</label>
                <input
                  type="date"
                  value={collectDate}
                  onChange={(e) => setCollectDate(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setShowCollectModal(null)}
                className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs"
              >
                إلغاء
              </button>
              <button
                onClick={handleSaveCollection}
                className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-md"
              >
                تسجيل التحصيل وترحيل القيد
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
