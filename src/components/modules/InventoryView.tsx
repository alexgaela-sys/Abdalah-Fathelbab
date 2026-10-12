import React, { useState } from 'react';
import { useModuleWriteAccess } from '../../hooks/usePermissions';
import { 
  Boxes, ArrowLeftRight, CheckSquare, Search, 
  AlertTriangle, Filter, Plus, Calendar, Check
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { InventoryEngine } from '../../services/inventory';
import { WorkflowService } from '../../services/workflows';
import ItemCardReport from './ItemCardReport';
import { printDocument } from '../printUtils';

type InventoryTab = 'balances' | 'ledger' | 'item_card' | 'transfers' | 'physical_count' | 'scrap_sales';

export const InventoryView: React.FC<{
  initialTab?: InventoryTab;
  initialWarehouseId?: string;
}> = ({ initialTab, initialWarehouseId }) => {
  const db = erpDb.getSnapshot();
  const [activeTab, setActiveTab] = useState<InventoryTab>(initialTab || 'balances');
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>(initialWarehouseId || 'all');
  const [searchQuery, setSearchQuery] = useState('');

  // Transfer modal state
  const [showTransferModal, setShowTransferModal] = useState(false);
  // QA-25: UI permission affordance (service authorization stays the real wall).
  const writeAccess = useModuleWriteAccess('inventory', 'المخزون');
  // ITEM 12: the scrap-sale service authorizes against the 'sales' module.
  const salesWriteAccess = useModuleWriteAccess('sales', 'المبيعات');
  const [transferItemId, setTransferItemId] = useState('');
  const [fromWhId, setFromWhId] = useState('wh-local');
  const [toWhId, setToWhId] = useState('wh-export');
  const [transferQty, setTransferQty] = useState(10);
  const [transferNotes, setTransferNotes] = useState('');
  const [transferError, setTransferError] = useState<string | null>(null);

  // Physical Count state
  const [showCountModal, setShowCountModal] = useState(false);
  const [countWarehouseId, setCountWarehouseId] = useState('wh-local');
  // ITEM 9: option to include zero-balance items so missing stock can be counted too.
  const [countIncludeZero, setCountIncludeZero] = useState(false);
  const [countLines, setCountLines] = useState<Array<{
    itemId: string;
    systemQty: number;
    physicalQty: number;
    unitCost: number;
  }>>([]);

  // ITEM 12: scrap-sale document (internal sale out of wh-scrap, VAT exempt).
  const [scrapItemId, setScrapItemId] = useState('');
  const [scrapQty, setScrapQty] = useState(1);
  const [scrapPrice, setScrapPrice] = useState(1);
  const [scrapBuyer, setScrapBuyer] = useState('');
  const [scrapPay, setScrapPay] = useState<'cash' | 'credit'>('cash');
  const [scrapDate, setScrapDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [scrapNotes, setScrapNotes] = useState('');
  const [scrapError, setScrapError] = useState<string | null>(null);

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
    if (!writeAccess.canCreate) { alert(writeAccess.createDeniedTitle); return; }
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
    let res: { success: boolean; error?: string };
    // R-09: an unexpected throw must not unmount the whole inventory screen.
    try {
      res = InventoryEngine.transferWarehouse(
        transferItemId,
        fromWhId,
        toWhId,
        Number(transferQty),
        item?.standardCost || undefined,
        undefined,
        transferNotes
      );
    } catch (e) {
      setTransferError(`حدث خطأ غير متوقع أثناء التحويل: ${(e as Error).message}`);
      return;
    }

    if (!res.success) {
      setTransferError(res.error || 'فشل التحويل المخزني');
      return;
    }

    setShowTransferModal(false);
  };

  // ITEM 9: shared count-line builder. Zero-balance items are excluded by
  // default (QA-11: only the selected warehouse's real stock is counted), but
  // the user can opt in so items that SHOULD have stock are counted too.
  // R-09: resolve the REAL valuation the settlement will use (FIFO in the
  // counted warehouse, falling back to the item's standard cost) so the
  // preview's فارق التكلفة column shows the value that will actually post —
  // the old form always previewed 0.00 ج.م and passed unitCost: 0, which left
  // every zero-FIFO-cost item impossible to count.
  const buildCountLines = (whId: string, includeZero: boolean) =>
    items
      .map(itm => ({ itemId: itm.id, systemQty: InventoryEngine.getItemBalance(itm.id, whId) }))
      .filter(x => includeZero || x.systemQty !== 0)
      .map(({ itemId, systemQty }) => {
        const resolved = InventoryEngine.resolveActualUnitCost(itemId, whId, 1);
        const unitCost = resolved.ok ? resolved.unitCost : (items.find(i => i.id === itemId)?.standardCost || 0);
        return { itemId, systemQty, physicalQty: systemQty, unitCost };
      });

  const handleOpenPhysicalCount = () => {
    if (!writeAccess.canCreate) { alert(writeAccess.createDeniedTitle); return; }
    // QA-11: the count is scoped to the SELECTED warehouse, and every warehouse
    // (WH-01..WH-05) is selectable.
    setCountLines(buildCountLines(countWarehouseId, countIncludeZero));
    setShowCountModal(true);
  };

  const handleCountWarehouseChange = (whId: string) => {
    setCountWarehouseId(whId);
    setCountLines(buildCountLines(whId, countIncludeZero));
  };

  const handleApproveCount = () => {
    const todayStr = new Date().toISOString().split('T')[0];

    // R-09: never let an unexpected engine throw blank the inventory screen —
    // the message is surfaced instead and the modal stays open for correction.
    let res: { success: boolean; error?: string };
    try {
      res = WorkflowService.postInventoryCount({
        warehouseId: countWarehouseId,
        date: todayStr,
        approvedBy: 'مدير عام المخازن والمراجعة',
        lines: countLines.map(l => ({
          itemId: l.itemId,
          systemQuantity: l.systemQty,
          physicalQuantity: l.physicalQty,
          // The builder already resolved the FIFO/standard valuation, so the
          // settlement value matches the previewed فارق التكلفة exactly.
          unitCost: l.unitCost,
        })),
      });
    } catch (e) {
      alert(`حدث خطأ غير متوقع أثناء ترحيل الجرد: ${(e as Error).message}`);
      return;
    }

    if (!res.success) {
      alert(res.error || 'خطأ في ترحيل الجرد الفعلي');
      return;
    }

    setShowCountModal(false);
  };

  // ---- ITEM 12: scrap-sale document handlers ----
  const scrapBal = scrapItemId ? InventoryEngine.getItemBalance(scrapItemId, 'wh-scrap') : 0;

  const handleCreateScrapSale = () => {
    setScrapError(null);
    let res: { success: boolean; error?: string };
    // R-09: never let an engine throw blank the screen; surface it instead.
    try {
      res = WorkflowService.createScrapSale({
        itemId: scrapItemId,
        quantity: Number(scrapQty),
        unitPrice: Number(scrapPrice),
        buyerName: scrapBuyer,
        paymentMethod: scrapPay,
        date: scrapDate,
        notes: scrapNotes.trim() || undefined,
        userId: 'usr-admin',
        userName: 'المشرف العام (Admin)',
      });
    } catch (e) {
      setScrapError(`حدث خطأ غير متوقع أثناء تسجيل بيع السكراب: ${(e as Error).message}`);
      return;
    }
    if (!res.success) {
      setScrapError(res.error || 'تعذر تسجيل مستند بيع السكراب');
      return;
    }
    setScrapQty(1);
    setScrapNotes('');
  };

  const handleCancelScrapSale = (scrapSaleId: string) => {
    const reason = prompt('سبب إلغاء مستند بيع السكراب (يُسجَّل في سجل التدقيق):');
    if (reason === null) return;
    const res = WorkflowService.cancelScrapSale({
      scrapSaleId,
      reason: reason.trim() || 'إلغاء من شاشة المخزون',
      userId: 'usr-admin',
      userName: 'المشرف العام (Admin)',
    });
    if (!res.success) alert(res.error || 'تعذر إلغاء مستند بيع السكراب');
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
            disabled={!writeAccess.canCreate}
            title={writeAccess.canCreate ? '' : writeAccess.createDeniedTitle}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ArrowLeftRight className="w-4 h-4 text-indigo-600" />
            <span>تحويل مخزني داخلي</span>
          </button>

          <button
            onClick={handleOpenPhysicalCount}
            disabled={!writeAccess.canCreate}
            title={writeAccess.canCreate ? '' : writeAccess.createDeniedTitle}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs shadow-md transition disabled:opacity-40 disabled:cursor-not-allowed"
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

        {/* F18: item card */}
        <button
          onClick={() => setActiveTab('item_card')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'item_card' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          كارت الصنف (Item Card)
        </button>

        {/* ITEM 12: internal scrap-sale document */}
        <button
          onClick={() => setActiveTab('scrap_sales')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'scrap_sales' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          مستند بيع السكراب (Scrap Sale)
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

      {activeTab === 'item_card' && (
        <ItemCardReport />
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

      {/* ITEM 12: Scrap Sale Document screen */}
      {activeTab === 'scrap_sales' && (
        <div className="space-y-4">
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-3">
            <div>
              <h3 className="font-bold text-sm text-slate-900">إصدار مستند بيع السكراب (Scrap Sale Document)</h3>
              <p className="text-[11px] text-slate-500 mt-0.5">
                مستند داخلي معفى من ضريبة القيمة المضافة — الإيراد إلى حساب 4104، والرصيد يخرج من مخزن السكراب (WH-05) بمنهجية FIFO، والإلغاء قيد عكسي وليس حذفًا
              </p>
            </div>

            {scrapError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold">
                {scrapError}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-3">
                <label className="block text-xs font-bold text-slate-700 mb-1">الصنف (من مخزن السكراب)</label>
                <select
                  value={scrapItemId}
                  onChange={(e) => setScrapItemId(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  <option value="">— اختر الصنف —</option>
                  {items.map(itm => (
                    <option key={itm.id} value={itm.id}>{itm.nameAr} [{itm.code}]</option>
                  ))}
                </select>
                {scrapItemId && (
                  <p className="text-[11px] text-slate-500 mt-1 font-semibold">
                    المتاح في مخزن السكراب: <span className="font-mono font-black text-slate-800">{scrapBal}</span> {unitsMap.get(items.find(i => i.id === scrapItemId)?.baseUnitId || '') || ''}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">الكمية</label>
                <input
                  type="number"
                  min="0.001"
                  step="any"
                  value={scrapQty}
                  onChange={(e) => setScrapQty(Number(e.target.value))}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">سعر الوحدة (ج.م)</label>
                <input
                  type="number"
                  min="0.01"
                  step="any"
                  value={scrapPrice}
                  onChange={(e) => setScrapPrice(Number(e.target.value))}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ المستند</label>
                <input
                  type="date"
                  value={scrapDate}
                  onChange={(e) => setScrapDate(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">المشتري / الجهة المستلمة</label>
                <input
                  type="text"
                  placeholder="مثال:شركة النظافة بالمصنع"
                  value={scrapBuyer}
                  onChange={(e) => setScrapBuyer(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">طريقة الدفع</label>
                <select
                  value={scrapPay}
                  onChange={(e) => setScrapPay(e.target.value as 'cash' | 'credit')}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  <option value="cash">نقدًا (من المورد النقدي)</option>
                  <option value="credit">آجل (ذمم مدينة)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">ملاحظات</label>
                <input
                  type="text"
                  placeholder="سبب البيع أو إذن التسليم"
                  value={scrapNotes}
                  onChange={(e) => setScrapNotes(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>

              <div className="flex items-end">
                <button
                  onClick={handleCreateScrapSale}
                  disabled={!salesWriteAccess.canCreate}
                  title={salesWriteAccess.canCreate ? '' : salesWriteAccess.createDeniedTitle}
                  className="w-full px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  تسجيل مستند بيع السكراب وترحيله
                </button>
              </div>
            </div>
          </div>

          <div className="print-area bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2">
              <div>
                <h3 className="font-bold text-xs text-slate-800">مستندات بيع السكراب المسجلة</h3>
                <p className="text-[11px] text-slate-500">{db.scrapSales.length} مستند — الإلغاء قيد عكسي دائمًا</p>
              </div>
              <button
                onClick={() => printDocument()}
                className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-[11px]"
              >
                طباعة / حفظ PDF
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-100 text-slate-700 font-bold">
                  <tr>
                    <th className="p-3">رقم المستند</th>
                    <th className="p-3">التاريخ</th>
                    <th className="p-3">الصنف</th>
                    <th className="p-3 text-center">الكمية</th>
                    <th className="p-3 text-center">سعر الوحدة</th>
                    <th className="p-3 text-left">القيمة</th>
                    <th className="p-3 text-left">القيمة الدفترية</th>
                    <th className="p-3">المشتري</th>
                    <th className="p-3">الدفع</th>
                    <th className="p-3">الحالة</th>
                    <th className="p-3">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {db.scrapSales.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="py-12 text-center text-slate-400">
                        لا توجد مستندات بيع سكراب مسجلة بعد
                      </td>
                    </tr>
                  ) : (
                    db.scrapSales.slice().reverse().map(doc => {
                      const itm = items.find(i => i.id === doc.itemId);
                      return (
                        <tr key={doc.id} className="hover:bg-slate-50">
                          <td className="p-3 font-mono font-bold text-slate-900">{doc.docNumber}</td>
                          <td className="p-3 text-slate-600">{doc.date}</td>
                          <td className="p-3 font-bold text-slate-800">{itm?.nameAr || doc.itemId}</td>
                          <td className="p-3 text-center font-mono">{doc.quantity}</td>
                          <td className="p-3 text-center font-mono">{doc.unitPrice.toFixed(2)}</td>
                          <td className="p-3 text-left font-mono font-black text-emerald-700">{doc.totalValue.toFixed(2)} ج.م</td>
                          <td className="p-3 text-left font-mono text-slate-600">{doc.bookValue.toFixed(2)} ج.م</td>
                          <td className="p-3 text-slate-700">{doc.buyerName}</td>
                          <td className="p-3">{doc.paymentMethod === 'cash' ? 'نقدًا' : 'آجل'}</td>
                          <td className="p-3">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                              doc.status === 'posted' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'
                            }`}>
                              {doc.status === 'posted' ? 'مرحل' : 'ملغى'}
                            </span>
                          </td>
                          <td className="p-3">
                            {doc.status === 'posted' && (
                              <button
                                onClick={() => handleCancelScrapSale(doc.id)}
                                className="px-2.5 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold text-[11px] border border-rose-200"
                              >
                                إلغاء مستند
                              </button>
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
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-xs font-bold text-slate-700">مستودع الجرد:</label>
                <select
                  value={countWarehouseId}
                  onChange={(e) => handleCountWarehouseChange(e.target.value)}
                  className="p-1.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-semibold"
                >
                  {db.warehouses.map(w => (
                    <option key={w.id} value={w.id}>{w.code} — {w.nameAr}</option>
                  ))}
                </select>
                <span className="text-[11px] text-slate-500">
                  الجرد يشمل أصناف المستودع المختار ({countLines.length} صنف)
                </span>
                <label className="flex items-center gap-1.5 text-xs font-bold text-slate-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={countIncludeZero}
                    onChange={(e) => {
                      setCountIncludeZero(e.target.checked);
                      setCountLines(buildCountLines(countWarehouseId, e.target.checked));
                    }}
                    className="w-4 h-4 rounded accent-amber-500"
                  />
                  عرض الأصناف ذات الرصيد الصفر (لجرد الأصناف المفقودة)
                </label>
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
