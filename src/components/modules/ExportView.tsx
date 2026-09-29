import React, { useState } from 'react';
import { 
  Globe, Plus, Ship, DollarSign, TrendingUp, 
  Search, Anchor, FileCheck, CheckCircle2
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { ExportShipment } from '../../types/erp';

export const ExportView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedShipment, setSelectedShipment] = useState<ExportShipment | null>(null);

  // New Shipment form
  const [customerId, setCustomerId] = useState('');
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

  const exportCustomers = db.customers.filter(c => c.customerType === 'export');

  const handleSaveShipment = () => {
    if (!customerId) {
      alert('يرجى اختيار عميل التصدير');
      return;
    }

    const egpValue = Number(usdRevenue) * Number(exchangeRate);
    const totalCosts = Number(productCost) + Number(shippingCost) + Number(portCosts) + Number(customsCost) + Number(otherCosts);
    const netProfitEGP = egpValue - totalCosts;
    const profitMarginPercent = egpValue > 0 ? (netProfitEGP / egpValue) * 100 : 0;

    const count = db.exportShipments.length + 1;
    const shipmentNumber = `EXP-SHP-${new Date().getFullYear()}-${String(count).padStart(3, '0')}`;

    const newShp: ExportShipment = {
      id: `shp-${Date.now()}`,
      shipmentNumber,
      customerId,
      shipmentDate,
      portOfOrigin,
      destinationPort,
      containerNumber,
      usdRevenue: Number(usdRevenue),
      exchangeRate: Number(exchangeRate),
      egpValue,
      productCost: Number(productCost),
      shippingCost: Number(shippingCost),
      portCosts: Number(portCosts),
      customsCost: Number(customsCost),
      otherExportCosts: Number(otherCosts),
      totalCosts,
      netProfitEGP,
      profitMarginPercent,
      collectionStatus: 'pending',
      collectedUsd: 0,
      status: 'shipped',
    };

    erpDb.mutate(draft => {
      draft.exportShipments.push(newShp);
    });

    setShowAddModal(false);
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
              <th className="p-3.5 text-center">الإيراد ($)</th>
              <th className="p-3.5 text-center">سعر الصرف</th>
              <th className="p-3.5 text-center">القيمة بالمصري</th>
              <th className="p-3.5 text-center">صافي الربح (ج.م)</th>
              <th className="p-3.5 text-center">هامش الربح %</th>
              <th className="p-3.5 text-center">الحالة</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-mono">
            {db.exportShipments.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-12 text-center text-slate-400 font-sans">
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
                    <td className="p-3.5 text-center font-sans">
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-blue-100 text-blue-800">
                        مشحونة
                      </span>
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
    </div>
  );
};
