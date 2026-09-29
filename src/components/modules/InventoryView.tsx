import React, { useState } from 'react';
import { 
  Boxes, ArrowLeftRight, CheckSquare, Search, 
  AlertTriangle, Filter, Plus, Calendar, Check
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { InventoryEngine } from '../../services/inventory';
import { AccountingEngine } from '../../services/accounting';

export const InventoryView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [activeTab, setActiveTab] = useState<'balances' | 'ledger' | 'transfers' | 'physical_count'>('balances');
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Transfer modal state
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [transferItemId, setTransferItemId] = useState('');
  const [fromWhId, setFromWhId] = useState('wh-local');
  const [toWhId, setToWhId] = useState('wh-export');
  const [transferQty, setTransferQty] = useState(10);
  const [transferNotes, setTransferNotes] = useState('');
  const [transferError, setTransferError] = useState<string | null>(null);

  // Physical Count state
  const [showCountModal, setShowCountModal] = useState(false);
  const [countWarehouseId, setCountWarehouseId] = useState('wh-local');
  const [countLines, setCountLines] = useState<Array<{
    itemId: string;
    systemQty: number;
    physicalQty: number;
    unitCost: number;
  }>>([]);

  const warehouses = db.warehouses;
  const items = db.items;
  const unitsMap = new Map(db.units.map(u => [u.id, u.nameAr]));
  const whMap = new Map(db.warehouses.map(w => [w.id, w.nameAr]));

  // Calculate stock balance list
  const stockBalances: Array<{
    item: any;
    warehouse: any;
    quantity: number;
    unitCost: number;
    totalValue: number;
    batchesCount: number;
  }> = [];

  items.forEach(item => {
    warehouses.forEach(wh => {
      if (selectedWarehouseId !== 'all' && wh.id !== selectedWarehouseId) return;
      const batches = db.batches.filter(b => b.itemId === item.id && b.warehouseId === wh.id && b.quantity > 0);
      const qty = batches.reduce((sum, b) => sum + b.quantity, 0);
      if (qty > 0) {
        const avgCost = batches.length > 0 ? batches.reduce((s, b) => s + (b.quantity * b.unitCost), 0) / qty : (item.standardCost || 0);
        stockBalances.push({
          item,
          warehouse: wh,
          quantity: qty,
          unitCost: avgCost,
          totalValue: qty * avgCost,
          batchesCount: batches.length,
        });
      }
    });
  });

  const handleOpenTransfer = () => {
    if (items.length > 0) setTransferItemId(items[0].id);
    setFromWhId('wh-local');
    setToWhId('wh-export');
    setTransferQty(10);
    setTransferNotes('');
    setTransferError(null);
    setShowTransferModal(true);
  };

  const handleExecuteTransfer = () => {
    setTransferError(null);
    const item = items.find(i => i.id === transferItemId);
    const res = InventoryEngine.transferWarehouse(
      transferItemId,
      fromWhId,
      toWhId,
      Number(transferQty),
      item?.standardCost || 50,
      undefined,
      transferNotes
    );

    if (!res.success) {
      setTransferError(res.error || 'فشل التحويل المخزني');
      return;
    }

    setShowTransferModal(false);
  };

  const handleOpenPhysicalCount = () => {
    const whItems = items.map(itm => {
      const current = InventoryEngine.getItemBalance(itm.id, countWarehouseId);
      return {
        itemId: itm.id,
        systemQty: current,
        physicalQty: current,
        unitCost: itm.standardCost || 50,
      };
    });
    setCountLines(whItems);
    setShowCountModal(true);
  };

  const handleApproveCount = () => {
    const todayStr = new Date().toISOString().split('T')[0];
    const countId = `cnt-${Date.now()}`;
    const countNumber = `STK-CNT-${Date.now().toString().slice(-4)}`;

    erpDb.mutate(draft => {
      draft.inventoryCounts.push({
        id: countId,
        countNumber,
        date: todayStr,
        warehouseId: countWarehouseId,
        status: 'posted',
        approvedBy: 'مدير عام المخازن والمراجعة',
      });

      countLines.forEach(l => {
        const varianceQty = l.physicalQty - l.systemQty;
        if (varianceQty !== 0) {
          draft.inventoryCountLines.push({
            id: `cntl-${countId}-${l.itemId}`,
            countId,
            itemId: l.itemId,
            systemQuantity: l.systemQty,
            physicalQuantity: l.physicalQty,
            varianceQuantity: varianceQty,
            unitCost: l.unitCost,
            varianceCost: varianceQty * l.unitCost,
          });

          // Create adjustment movement
          InventoryEngine.recordMovement({
            itemId: l.itemId,
            warehouseId: countWarehouseId,
            movementType: 'inventory_adjustment',
            quantityIn: varianceQty > 0 ? varianceQty : 0,
            quantityOut: varianceQty < 0 ? Math.abs(varianceQty) : 0,
            unitCost: l.unitCost,
            documentType: 'تسوية جرد فعلي',
            documentNumber: countNumber,
            notes: `فروق جرد فعلي (النظام: ${l.systemQty}، الفعلي: ${l.physicalQty})`,
          });
        }
      });
    });

    setShowCountModal(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">إدارة المخزون المستمر (Perpetual Inventory)</h2>
          <p className="text-xs text-slate-500 mt-1">
            متابعة أرصدة الـ 5 مستودعات، حركات الصرف والإضافة الموثقة، التحويل الداخلي، والجرد الدوري
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleOpenTransfer}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs transition"
          >
            <ArrowLeftRight className="w-4 h-4 text-indigo-600" />
            <span>تحويل مخزني داخلي</span>
          </button>

          <button
            onClick={handleOpenPhysicalCount}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs shadow-md transition"
          >
            <CheckSquare className="w-4 h-4" />
            <span>جرد فعلي وتسوية</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setActiveTab('balances')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'balances' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          أرصدة المستودعات الحالية
        </button>
        <button
          onClick={() => setActiveTab('ledger')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'ledger' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          حركات المخزون المستمر (Inventory Ledger)
        </button>
      </div>

      {activeTab === 'balances' && (
        <div className="space-y-4">
          {/* Warehouse Selector & Filter */}
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-700">تصفية حسب المستودع:</span>
              <select
                value={selectedWarehouseId}
                onChange={(e) => setSelectedWarehouseId(e.target.value)}
                className="p-1.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-semibold"
              >
                <option value="all">كافة المستودعات الـ 5</option>
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>{w.nameAr} ({w.code})</option>
                ))}
              </select>
            </div>

            <div className="text-xs text-slate-500 font-semibold">
              إجمالي الأرصدة المتاحة: <span className="font-bold text-slate-900">{stockBalances.length}</span> صنف بمستودع
            </div>
          </div>

          {/* Balances Table */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold">
                <tr>
                  <th className="p-3.5">كود الصنف</th>
                  <th className="p-3.5">اسم الصنف</th>
                  <th className="p-3.5">نوع الصنف</th>
                  <th className="p-3.5">المستودع</th>
                  <th className="p-3.5 text-center">الرصيد المتاح</th>
                  <th className="p-3.5 text-center">متوسط التكلفة</th>
                  <th className="p-3.5 text-left">القيمة الإجمالية</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {stockBalances.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-400">
                      لا يوجد مخزون حالي في المستودعات المحددة (قم بالشراء أو الإنتاج لإضافة رصيد)
                    </td>
                  </tr>
                ) : (
                  stockBalances.map((sb, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/80 transition">
                      <td className="p-3.5 font-mono font-bold text-slate-900">{sb.item.code}</td>
                      <td className="p-3.5 font-bold text-slate-800">{sb.item.nameAr}</td>
                      <td className="p-3.5">
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-semibold">
                          {sb.item.itemType === 'finished_product' ? 'منتج تام' : sb.item.itemType === 'raw_material' ? 'مادة خام' : 'تعبئة وتغليف'}
                        </span>
                      </td>
                      <td className="p-3.5 text-slate-700">{sb.warehouse.nameAr}</td>
                      <td className="p-3.5 text-center font-mono font-black text-slate-900">
                        {sb.quantity.toLocaleString('ar-EG')} {unitsMap.get(sb.item.baseUnitId) || ''}
                      </td>
                      <td className="p-3.5 text-center font-mono text-slate-600">
                        {sb.unitCost.toFixed(2)} ج.م
                      </td>
                      <td className="p-3.5 text-left font-mono font-black text-emerald-700">
                        {sb.totalValue.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'ledger' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200">
            <h3 className="font-bold text-xs text-slate-800">سجل حركات المخزون المستمر (Traceable Stock Ledger)</h3>
            <p className="text-[11px] text-slate-500">توثيق كامل لكل حركة صرف أو إضافة أو تحويل أو بونص أو جرد</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-100 text-slate-700 font-bold">
                <tr>
                  <th className="p-3">التاريخ</th>
                  <th className="p-3">نوع الحركة</th>
                  <th className="p-3">رقم المستند</th>
                  <th className="p-3">الصنف</th>
                  <th className="p-3">المستودع</th>
                  <th className="p-3">التشغيلة</th>
                  <th className="p-3 text-center">وارد (+)</th>
                  <th className="p-3 text-center">صادر (-)</th>
                  <th className="p-3 text-center">الرصيد بعد</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {db.inventoryTransactions.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-slate-400">
                      لا توجد حركات مخزنية مسجلة
                    </td>
                  </tr>
                ) : (
                  db.inventoryTransactions.slice().reverse().map(tx => {
                    const itm = items.find(i => i.id === tx.itemId);
                    return (
                      <tr key={tx.id} className="hover:bg-slate-50">
                        <td className="p-3 text-slate-600">{tx.date}</td>
                        <td className="p-3 font-semibold text-slate-800">{tx.documentType}</td>
                        <td className="p-3 font-mono text-slate-600">{tx.documentNumber}</td>
                        <td className="p-3 font-bold text-slate-900">{itm?.nameAr || tx.itemId}</td>
                        <td className="p-3 text-slate-600">{whMap.get(tx.warehouseId) || tx.warehouseId}</td>
                        <td className="p-3 font-mono text-[11px] text-slate-500">{tx.batchNumber || '-'}</td>
                        <td className="p-3 text-center font-mono font-bold text-emerald-600">
                          {tx.quantityIn > 0 ? `+${tx.quantityIn}` : '-'}
                        </td>
                        <td className="p-3 text-center font-mono font-bold text-rose-600">
                          {tx.quantityOut > 0 ? `-${tx.quantityOut}` : '-'}
                        </td>
                        <td className="p-3 text-center font-mono font-black text-slate-900">
                          {tx.balanceAfter}
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

      {/* Internal Transfer Modal */}
      {showTransferModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">تحويل مخزني داخلي بين المستودعات</h3>
              <button onClick={() => setShowTransferModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            {transferError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold">
                {transferError}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">الصنف المراد تحويله</label>
                <select
                  value={transferItemId}
                  onChange={(e) => setTransferItemId(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  {items.map(itm => (
                    <option key={itm.id} value={itm.id}>{itm.nameAr} [{itm.code}]</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">من مستودع</label>
                  <select
                    value={fromWhId}
                    onChange={(e) => setFromWhId(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    {warehouses.map(w => (
                      <option key={w.id} value={w.id}>{w.nameAr}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">إلى مستودع</label>
                  <select
                    value={toWhId}
                    onChange={(e) => setToWhId(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    {warehouses.map(w => (
                      <option key={w.id} value={w.id}>{w.nameAr}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">الكمية المحولة</label>
                <input
                  type="number"
                  min="1"
                  value={transferQty}
                  onChange={(e) => setTransferQty(Number(e.target.value))}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">ملاحظات التحويل</label>
                <input
                  type="text"
                  placeholder="سبب التحويل أو إذن النقل"
                  value={transferNotes}
                  onChange={(e) => setTransferNotes(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setShowTransferModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs"
              >
                إلغاء
              </button>
              <button
                onClick={handleExecuteTransfer}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md"
              >
                تنفيذ التحويل وتوثيق الحركات
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Physical Count & Adjustment Modal */}
      {showCountModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-3xl max-h-[90vh] flex flex-col text-right overflow-hidden">
            <div className="p-4 bg-slate-900 text-white flex items-center justify-between">
              <h3 className="font-bold text-sm">محضر جرد فعلي وتسوية الفروق المخزنية</h3>
              <button onClick={() => setShowCountModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4">
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-slate-700">مستودع الجرد:</span>
                <span className="font-bold text-xs text-amber-700 bg-amber-50 px-2 py-1 rounded-lg border border-amber-200">
                  {whMap.get(countWarehouseId)}
                </span>
              </div>

              <table className="w-full text-right text-xs border border-slate-200 rounded-xl overflow-hidden">
                <thead className="bg-slate-100 text-slate-700">
                  <tr>
                    <th className="p-2.5">الصنف</th>
                    <th className="p-2.5 text-center">الرصيد الدفتري</th>
                    <th className="p-2.5 text-center w-32">الرصيد الفعلي</th>
                    <th className="p-2.5 text-center">فارق الكمية</th>
                    <th className="p-2.5 text-left">فارق التكلفة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {countLines.map((line, idx) => {
                    const itm = items.find(i => i.id === line.itemId);
                    const diff = line.physicalQty - line.systemQty;
                    const diffCost = diff * line.unitCost;
                    return (
                      <tr key={line.itemId}>
                        <td className="p-2 font-bold">{itm?.nameAr}</td>
                        <td className="p-2 text-center font-mono">{line.systemQty}</td>
                        <td className="p-2 text-center">
                          <input
                            type="number"
                            value={line.physicalQty}
                            onChange={(e) => {
                              const updated = [...countLines];
                              updated[idx].physicalQty = Number(e.target.value);
                              setCountLines(updated);
                            }}
                            className="w-24 p-1.5 rounded-lg border border-slate-300 text-xs text-center font-mono"
                          />
                        </td>
                        <td className="p-2 text-center font-mono font-bold">
                          <span className={diff === 0 ? 'text-slate-500' : diff > 0 ? 'text-emerald-600' : 'text-rose-600'}>
                            {diff > 0 ? `+${diff}` : diff}
                          </span>
                        </td>
                        <td className="p-2 text-left font-mono font-bold">
                          {diffCost.toFixed(2)} ج.م
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="p-4 bg-slate-100 border-t border-slate-200 flex items-center justify-end gap-2">
              <button
                onClick={() => setShowCountModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold text-xs"
              >
                إلغاء
              </button>
              <button
                onClick={handleApproveCount}
                className="px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs shadow-md"
              >
                اعتماد الجرد وتسوية الفروق بالدفاتر
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
