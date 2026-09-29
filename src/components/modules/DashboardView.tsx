import React from 'react';
import { 
  TrendingUp, Boxes, Users, DollarSign, AlertTriangle, 
  Globe, Wallet, Landmark, ArrowUpRight, Clock,
  PieChart as PieIcon, BarChart3, CheckCircle2, ShoppingCart, Truck, CreditCard, Sparkles
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { InventoryEngine } from '../../services/inventory';

interface DashboardViewProps {
  onNavigateTab: (tab: string) => void;
  openTestRunner: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({ onNavigateTab, openTestRunner }) => {
  const db = erpDb.getSnapshot();

  const now = new Date();
  const currentMonthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // REQUIREMENT 10: The EXACT 9 KPIs calculated from actual database data (no hardcoded fake values)
  
  // 1. مبيعات الشهر (Sales of current month)
  const salesThisMonth = db.salesInvoices
    .filter(i => i.status === 'posted' && i.date.startsWith(currentMonthPrefix))
    .reduce((sum, i) => sum + i.totalAmountEGP, 0);

  // 2. المبيعات آجلة (Credit sales)
  const creditSales = db.salesInvoices
    .filter(i => i.status === 'posted' && i.paymentMethod === 'credit')
    .reduce((sum, i) => sum + i.totalAmountEGP, 0);

  // 3. تحصيلات الشهر (Collections of current month)
  const collectionsThisMonth = db.payments
    .filter(p => p.paymentType === 'customer_receipt' && p.date.startsWith(currentMonthPrefix))
    .reduce((sum, p) => sum + p.amountEGP, 0);

  // 4. رصيد الخزينة (Treasury balance)
  const treasuryAccount = db.accounts.find(a => a.id === 'acc-1101');
  const treasuryBalance = treasuryAccount?.currentBalance || 0;

  // 5. أرصدة البنوك (Bank balances total in EGP)
  const bankEgpAccount = db.accounts.find(a => a.id === 'acc-1102');
  const bankUsdAccount = db.accounts.find(a => a.id === 'acc-1103');
  const bankBalancesTotal = (bankEgpAccount?.currentBalance || 0) + ((bankUsdAccount?.currentBalance || 0) * db.company.currentUsdExchangeRate);

  // 6. مديونية العملاء (Customer receivables total in EGP)
  const customerReceivables = db.customers.reduce((sum, c) => {
    const rate = c.currency === 'USD' ? db.company.currentUsdExchangeRate : 1;
    return sum + (Math.max(0, c.currentBalance || 0) * rate);
  }, 0);

  // 7. مستحقات الموردين (Supplier payables total in EGP)
  const supplierPayables = db.suppliers.reduce((sum, s) => {
    const rate = s.currency === 'USD' ? db.company.currentUsdExchangeRate : 1;
    return sum + (Math.max(0, s.currentBalance || 0) * rate);
  }, 0);

  // 8. قيمة المخزون (Inventory value from perpetual batches)
  const inventoryValue = db.batches.reduce((sum, b) => {
    return sum + ((b.quantity || 0) * (b.unitCost || 0));
  }, 0);

  // 9. صافي الربح (Net profit: Total Revenue - COGS - Operating Expenses)
  const totalRevenue = db.accounts.filter(a => a.category === 'Revenue').reduce((sum, a) => sum + a.currentBalance, 0);
  const totalCOGS = db.accounts.filter(a => a.category === 'Cost of Goods Sold').reduce((sum, a) => sum + a.currentBalance, 0);
  const totalExpenses = db.accounts.filter(a => a.category === 'Operating Expenses' || a.category === 'Other Expenses').reduce((sum, a) => sum + a.currentBalance, 0);
  const netProfit = totalRevenue - totalCOGS - totalExpenses;

  // Additional operational stats
  const totalSalesAllTime = db.salesInvoices.filter(i => i.status === 'posted').reduce((sum, i) => sum + i.totalAmountEGP, 0);
  const expiringBatches = InventoryEngine.getExpiringBatches(10);
  const isEmptySystem = db.salesInvoices.length === 0 && db.purchaseInvoices.length === 0 && db.batches.length === 0;

  // Best-selling products from salesInvoiceLines
  const productSalesMap = new Map<string, { nameAr: string; qty: number; revenue: number }>();
  const itemsMap = new Map(db.items.map(i => [i.id, i]));

  db.salesInvoiceLines.forEach(line => {
    const item = itemsMap.get(line.itemId);
    const existing = productSalesMap.get(line.itemId) || {
      nameAr: item?.nameAr || line.itemId,
      qty: 0,
      revenue: 0,
    };
    existing.qty += line.quantity;
    existing.revenue += line.netTotal;
    productSalesMap.set(line.itemId, existing);
  });

  const bestSelling = Array.from(productSalesMap.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  return (
    <div className="space-y-6 text-right">
      {/* Welcome & System Status Banner */}
      <div className="p-5 bg-gradient-to-r from-slate-900 to-slate-800 text-white rounded-2xl flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 shadow-md">
        <div className="flex items-start sm:items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-amber-500 text-slate-950 flex items-center justify-center font-black text-xl shrink-0 shadow-md shadow-amber-500/20">
            ع
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-black text-white">
                لوحة القيادة والمؤشرات المالية (Executive Dashboard)
              </h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold">
                بيانات فعلية دقيقة
              </span>
            </div>
            <p className="text-xs text-slate-300 mt-1">
              حسابات فورية مباشرة من قيود اليومية العامة والمستودعات والعملاء والموردين بدون أي أرقام وهمية
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
          <button
            onClick={() => onNavigateTab('purchasing')}
            className="flex-1 sm:flex-none px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs rounded-xl border border-slate-700 transition cursor-pointer"
          >
            + توريد خامات
          </button>
          <button
            onClick={() => onNavigateTab('manufacturing')}
            className="flex-1 sm:flex-none px-3.5 py-2 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs rounded-xl shadow-xs transition cursor-pointer"
          >
            + أمر تشغيل إنتاج
          </button>
          <button
            onClick={() => onNavigateTab('sales')}
            className="flex-1 sm:flex-none px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl shadow-xs transition cursor-pointer"
          >
            + فاتورة مبيعات
          </button>
        </div>
      </div>

      {/* REQUIREMENT 10: 9 EXACT KPI METRICS FROM ACTUAL DATABASE DATA */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-black text-slate-900 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-amber-600" />
            <span>المؤشرات المالية الرئيسية التسعة (Real-Time Financial KPIs)</span>
          </h3>
          <span className="text-xs text-slate-500 font-medium">شهر {currentMonthPrefix}</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {/* 1. مبيعات الشهر */}
          <div 
            onClick={() => onNavigateTab('sales')}
            className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs hover:border-amber-400 transition cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-600">مبيعات الشهر</span>
              <div className="w-8 h-8 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
                <TrendingUp className="w-4 h-4" />
              </div>
            </div>
            <div className="text-xl font-black text-slate-900 mt-2 font-mono">
              {salesThisMonth > 0 ? (
                <>
                  {salesThisMonth.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-500 mr-1">ج.م</span>
                </>
              ) : (
                <span className="text-sm font-semibold text-slate-400">0 ج.م</span>
              )}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">الفواتير المرحلة خلال الشهر الحالي</div>
          </div>

          {/* 2. المبيعات آجلة */}
          <div 
            onClick={() => onNavigateTab('sales')}
            className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs hover:border-amber-400 transition cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-600">المبيعات آجلة</span>
              <div className="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
                <CreditCard className="w-4 h-4" />
              </div>
            </div>
            <div className="text-xl font-black text-indigo-900 mt-2 font-mono">
              {creditSales > 0 ? (
                <>
                  {creditSales.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-500 mr-1">ج.م</span>
                </>
              ) : (
                <span className="text-sm font-semibold text-slate-400">0 ج.م</span>
              )}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">مبيعات غير مسددة بالكامل</div>
          </div>

          {/* 3. تحصيلات الشهر */}
          <div 
            onClick={() => onNavigateTab('customers')}
            className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs hover:border-amber-400 transition cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-600">تحصيلات الشهر</span>
              <div className="w-8 h-8 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center">
                <CheckCircle2 className="w-4 h-4" />
              </div>
            </div>
            <div className="text-xl font-black text-teal-700 mt-2 font-mono">
              {collectionsThisMonth > 0 ? (
                <>
                  {collectionsThisMonth.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-500 mr-1">ج.م</span>
                </>
              ) : (
                <span className="text-sm font-semibold text-slate-400">0 ج.م</span>
              )}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">إجمالي المقبوضات وسندات التحصيل</div>
          </div>

          {/* 4. رصيد الخزينة */}
          <div 
            onClick={() => onNavigateTab('treasury')}
            className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs hover:border-amber-400 transition cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-600">رصيد الخزينة</span>
              <div className="w-8 h-8 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center">
                <Wallet className="w-4 h-4" />
              </div>
            </div>
            <div className="text-xl font-black text-slate-900 mt-2 font-mono">
              {treasuryBalance !== 0 ? (
                <>
                  {treasuryBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-500 mr-1">ج.م</span>
                </>
              ) : (
                <span className="text-sm font-semibold text-slate-400">0 ج.م</span>
              )}
            </div>
            <div className="text-[10px] text-emerald-600 mt-1">الخزينة الرئيسية النقدية (1101)</div>
          </div>

          {/* 5. أرصدة البنوك */}
          <div 
            onClick={() => onNavigateTab('banks')}
            className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs hover:border-amber-400 transition cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-600">أرصدة البنوك</span>
              <div className="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
                <Landmark className="w-4 h-4" />
              </div>
            </div>
            <div className="text-xl font-black text-blue-900 mt-2 font-mono">
              {bankBalancesTotal !== 0 ? (
                <>
                  {bankBalancesTotal.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-500 mr-1">ج.م</span>
                </>
              ) : (
                <span className="text-sm font-semibold text-slate-400">0 ج.م</span>
              )}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">حسابات بنك مصر و CIB (محولة لـ ج.م)</div>
          </div>

          {/* 6. مديونية العملاء */}
          <div 
            onClick={() => onNavigateTab('customers')}
            className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs hover:border-amber-400 transition cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-600">مديونية العملاء</span>
              <div className="w-8 h-8 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center">
                <Users className="w-4 h-4" />
              </div>
            </div>
            <div className="text-xl font-black text-amber-900 mt-2 font-mono">
              {customerReceivables > 0 ? (
                <>
                  {customerReceivables.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-500 mr-1">ج.م</span>
                </>
              ) : (
                <span className="text-sm font-semibold text-slate-400">0 ج.م (لا توجد مديونيات)</span>
              )}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">أرصدة العملاء المستحقة للشركة</div>
          </div>

          {/* 7. مستحقات الموردين */}
          <div 
            onClick={() => onNavigateTab('suppliers')}
            className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs hover:border-amber-400 transition cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-600">مستحقات الموردين</span>
              <div className="w-8 h-8 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center">
                <Truck className="w-4 h-4" />
              </div>
            </div>
            <div className="text-xl font-black text-rose-800 mt-2 font-mono">
              {supplierPayables > 0 ? (
                <>
                  {supplierPayables.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-500 mr-1">ج.م</span>
                </>
              ) : (
                <span className="text-sm font-semibold text-slate-400">0 ج.م (لا توجد مستحقات)</span>
              )}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">التزامات توريد الخامات والتعبئة (2101)</div>
          </div>

          {/* 8. قيمة المخزون */}
          <div 
            onClick={() => onNavigateTab('inventory')}
            className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs hover:border-amber-400 transition cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-600">قيمة المخزون</span>
              <div className="w-8 h-8 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center">
                <Boxes className="w-4 h-4" />
              </div>
            </div>
            <div className="text-xl font-black text-purple-900 mt-2 font-mono">
              {inventoryValue > 0 ? (
                <>
                  {inventoryValue.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-500 mr-1">ج.م</span>
                </>
              ) : (
                <span className="text-sm font-semibold text-slate-400">0 ج.م</span>
              )}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">تقييم التشغيلات بالمستودعات الـ 5</div>
          </div>

          {/* 9. صافي الربح */}
          <div 
            onClick={() => onNavigateTab('accounting')}
            className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs hover:border-amber-400 transition cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-600">صافي الربح</span>
              <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${netProfit >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>
                <DollarSign className="w-4 h-4" />
              </div>
            </div>
            <div className={`text-xl font-black mt-2 font-mono ${netProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
              {netProfit !== 0 ? (
                <>
                  {netProfit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-500 mr-1">ج.م</span>
                </>
              ) : (
                <span className="text-sm font-semibold text-slate-400">0 ج.م</span>
              )}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">الإيرادات - التكلفة المباشرة - المصروفات</div>
          </div>
        </div>
      </div>

      {/* Row 2: Urgent Expiry Alert & Top Selling Products */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Urgent 10-day Expiry Alert */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-rose-600" />
              <h3 className="font-bold text-slate-900 text-sm">أصناف قاربت الصلاحية (خلال 10 أيام)</h3>
            </div>
            <span className="text-xs px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 font-bold border border-rose-200">
              {expiringBatches.length} تشغيلات
            </span>
          </div>

          <div className="mt-4 space-y-2.5 max-h-72 overflow-y-auto">
            {expiringBatches.length === 0 ? (
              <div className="py-8 text-center text-slate-400">
                <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto mb-2 opacity-60" />
                <p className="text-xs font-semibold">المخزون سليم تماماً ولا توجد تشغيلات قاربت على الانتهاء</p>
              </div>
            ) : (
              expiringBatches.map(b => (
                <div key={b.id} className="p-3 rounded-xl bg-rose-50/60 border border-rose-200 text-xs flex items-center justify-between">
                  <div>
                    <div className="font-bold text-rose-950">{b.itemNameAr}</div>
                    <div className="text-[11px] text-rose-700 mt-0.5">
                      تشغيلة: <span className="font-mono">{b.batchNumber}</span> | المستودع: {b.warehouseNameAr}
                    </div>
                  </div>
                  <div className="text-left font-mono">
                    <span className="text-rose-700 font-black text-sm block">باقي {b.daysUntilExpiry} أيام</span>
                    <span className="text-[11px] text-slate-600 font-medium">الكمية: {b.quantity}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Best-selling Snack Products */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs lg:col-span-2">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <ShoppingCart className="w-5 h-5 text-amber-600" />
              <h3 className="font-bold text-slate-900 text-sm">أعلى منتجات سناك ديب مبيعاً (Top 5 Products)</h3>
            </div>
            <button
              onClick={() => onNavigateTab('items')}
              className="text-xs font-bold text-amber-700 hover:text-amber-800 cursor-pointer"
            >
              عرض سجل الأصناف الـ 11 ←
            </button>
          </div>

          <div className="mt-4">
            {bestSelling.length === 0 ? (
              <div className="py-10 text-center text-slate-400">
                <Boxes className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                <p className="text-xs font-semibold">لا توجد مبيعات مسجلة حتى الآن</p>
                <p className="text-[11px] text-slate-400 mt-1">ستظهر إحصائيات المنتجات فور ترحيل فواتير المبيعات</p>
              </div>
            ) : (
              <div className="space-y-3">
                {bestSelling.map((p, idx) => (
                  <div key={idx} className="p-3 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2.5">
                      <span className="w-6 h-6 rounded-lg bg-amber-500 text-slate-950 font-black flex items-center justify-center text-xs">
                        {idx + 1}
                      </span>
                      <span className="font-bold text-slate-900">{p.nameAr}</span>
                    </div>
                    <div className="flex items-center gap-4 font-mono">
                      <span className="text-slate-600">{p.qty} كرتونة</span>
                      <span className="font-black text-emerald-700">
                        {p.revenue.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
