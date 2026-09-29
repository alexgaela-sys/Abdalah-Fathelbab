import React from 'react';
import {
  TrendingUp, Boxes, Users, AlertTriangle,
  Wallet, Landmark, ShoppingCart, Truck, CreditCard,
  CheckCircle2, BarChart3, DollarSign, Factory, UserCheck, ArrowLeft, Package
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { InventoryEngine } from '../../services/inventory';
import { PageHeader, SectionCard, EmptyState, formatEGP, formatNum } from '../ui';

interface DashboardViewProps {
  onNavigateTab: (tab: string) => void;
  openTestRunner: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({ onNavigateTab }) => {
  const db = erpDb.getSnapshot();

  const now = new Date();
  const currentMonthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // ---- KPIs (all computed from actual database data — no fabricated numbers) ----

  // 1. مبيعات الشهر
  const salesThisMonth = db.salesInvoices
    .filter(i => i.status === 'posted' && i.date.startsWith(currentMonthPrefix))
    .reduce((sum, i) => sum + i.totalAmountEGP, 0);

  // 2. إجمالي المبيعات
  const totalSalesAllTime = db.salesInvoices.filter(i => i.status === 'posted').reduce((sum, i) => sum + i.totalAmountEGP, 0);

  // 3. المبيعات آجلة
  const creditSales = db.salesInvoices
    .filter(i => i.status === 'posted' && i.paymentMethod === 'credit')
    .reduce((sum, i) => sum + i.totalAmountEGP, 0);

  // 4. تحصيلات الشهر
  const collectionsThisMonth = db.payments
    .filter(p => p.paymentType === 'customer_receipt' && p.date.startsWith(currentMonthPrefix))
    .reduce((sum, p) => sum + p.amountEGP, 0);

  // 5. رصيد الخزينة
  const treasuryAccount = db.accounts.find(a => a.id === 'acc-1101');
  const treasuryBalance = treasuryAccount?.currentBalance || 0;

  // 6. أرصدة البنوك (EGP)
  const bankEgpAccount = db.accounts.find(a => a.id === 'acc-1102');
  const bankUsdAccount = db.accounts.find(a => a.id === 'acc-1103');
  const bankBalancesTotal =
    (bankEgpAccount?.currentBalance || 0) +
    (bankUsdAccount?.currentBalance || 0) * db.company.currentUsdExchangeRate;

  // 7. مديونية العملاء
  const customerReceivables = db.customers.reduce((sum, c) => {
    const rate = c.currency === 'USD' ? db.company.currentUsdExchangeRate : 1;
    return sum + (Math.max(0, c.currentBalance || 0) * rate);
  }, 0);

  // 8. مستحقات الموردين
  const supplierPayables = db.suppliers.reduce((sum, s) => {
    const rate = s.currency === 'USD' ? db.company.currentUsdExchangeRate : 1;
    return sum + (Math.max(0, s.currentBalance || 0) * rate);
  }, 0);

  // 9. قيمة المخزون
  const inventoryValue = db.batches.reduce((sum, b) => sum + (b.quantity || 0) * (b.unitCost || 0), 0);

  // 10. العهد القائمة
  const openCustodies = db.representativeCustodies.filter(c => c.status === 'open').length;

  // 11. صافي الربح (الإيرادات - COGS - المصروفات)
  const totalRevenue = db.accounts.filter(a => a.category === 'Revenue').reduce((sum, a) => sum + a.currentBalance, 0);
  const totalCOGS = db.accounts.filter(a => a.category === 'COGS').reduce((sum, a) => sum + a.currentBalance, 0);
  const totalExpenses = db.accounts
    .filter(a => a.category === 'Operating Expenses' || a.category === 'Other Expenses')
    .reduce((sum, a) => sum + a.currentBalance, 0);
  const netProfit = totalRevenue - totalCOGS - totalExpenses;

  const expiringBatches = InventoryEngine.getExpiringBatches(10);
  const isEmptySystem =
    db.salesInvoices.length === 0 && db.purchaseInvoices.length === 0 && db.batches.length === 0;

  // ---- Simple charts from real data ----

  // Revenue vs COGS vs Profit by month (last 6 months from posted sales invoices)
  const monthlySeries = React.useMemo(() => {
    const months: Array<{ key: string; label: string; revenue: number; cogs: number }> = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString('ar-EG', { month: 'short' });
      months.push({ key, label, revenue: 0, cogs: 0 });
    }
    const byKey = new Map(months.map(m => [m.key, m]));
    db.salesInvoices
      .filter(i => i.status === 'posted')
      .forEach(inv => {
        const m = byKey.get(inv.date.slice(0, 7));
        if (m) {
          m.revenue += inv.totalAmountEGP;
          m.cogs += inv.cogsTotal || 0;
        }
      });
    return months;
  }, [db.salesInvoices, now]);

  const monthlyMax = Math.max(1, ...monthlySeries.map(m => Math.max(m.revenue, m.cogs)));

  // Inventory value per warehouse (from perpetual batches)
  const warehouseSeries = React.useMemo(() => {
    const whMap = new Map(db.warehouses.map(w => [w.id, w.nameAr]));
    const byWh = new Map<string, number>();
    db.batches.forEach(b => {
      byWh.set(b.warehouseId, (byWh.get(b.warehouseId) || 0) + (b.quantity || 0) * (b.unitCost || 0));
    });
    return Array.from(byWh.entries())
      .map(([id, value]) => ({ name: whMap.get(id) || id, value }))
      .filter(x => x.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  }, [db.batches, db.warehouses]);

  const whMax = Math.max(1, ...warehouseSeries.map(w => w.value));

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

  // Production flow strip steps
  const flowSteps = [
    { label: 'الخامات', icon: Boxes, tab: 'inventory', count: db.batches.filter(b => db.items.find(i => i.id === b.itemId)?.itemType !== 'finished_product').length },
    { label: 'أمر الإنتاج', icon: Factory, tab: 'manufacturing', count: db.productionOrders.length },
    { label: 'صرف الخامات', icon: Truck, tab: 'manufacturing', count: db.productionConsumptions.length },
    { label: 'الإنتاج', icon: Package, tab: 'manufacturing', count: db.productionOrders.filter(o => o.status === 'in_progress').length },
    { label: 'الجودة', icon: CheckCircle2, tab: 'quality', count: db.qualityInspections.length },
    { label: 'المنتجات التامة', icon: Boxes, tab: 'inventory', count: db.batches.filter(b => db.items.find(i => i.id === b.itemId)?.itemType === 'finished_product').length },
  ];

  return (
    <div className="space-y-6 text-right">
      {/* Welcome banner */}
      <div className="relative overflow-hidden p-5 sm:p-6 bg-ink-900 text-white rounded-2xl shadow-card">
        {/* brand accents */}
        <div className="absolute top-0 left-0 w-64 h-64 bg-brand-500/20 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-16 right-1/3 w-72 h-72 bg-brand-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
          <div className="flex items-start sm:items-center gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-brand-500 flex items-center justify-center shrink-0 shadow-brand">
              <span className="font-black text-lg text-white tracking-tight">
                S<span className="text-ink-950">D</span>
              </span>
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-black text-white">
                  لوحة التحكم — SnakDip ERP
                </h3>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold">
                  بيانات فعلية دقيقة
                </span>
              </div>
              <p className="text-xs text-cream-300 mt-1 font-medium">
                مؤشرات فورية مباشرة من قيود اليومية والمستودعات والعملاء والموردين — بدون أي أرقام وهمية
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
            <button onClick={() => onNavigateTab('purchasing')} className="btn-secondary btn-sm flex-1 sm:flex-none !bg-white/10 !text-white !border-white/20 hover:!bg-white/20">
              + توريد خامات
            </button>
            <button onClick={() => onNavigateTab('manufacturing')} className="btn-primary btn-sm flex-1 sm:flex-none">
              + أمر تشغيل إنتاج
            </button>
            <button onClick={() => onNavigateTab('sales')} className="btn-sm flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg font-bold cursor-pointer transition-all active:scale-[0.98] bg-emerald-600 hover:bg-emerald-700 text-white">
              + فاتورة مبيعات
            </button>
          </div>
        </div>
      </div>

      {/* KPI grid — all real data */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KpiTile
          label="مبيعات الشهر"
          value={formatEGP(salesThisMonth)}
          hint="الفواتير المرحلة خلال الشهر الحالي"
          icon={TrendingUp}
          tone="bg-emerald-50 text-emerald-600"
          onClick={() => onNavigateTab('sales')}
        />
        <KpiTile
          label="إجمالي المبيعات"
          value={formatEGP(totalSalesAllTime)}
          hint="كل الفواتير المرحلة"
          icon={DollarSign}
          tone="bg-brand-50 text-brand-600"
          onClick={() => onNavigateTab('sales')}
        />
        <KpiTile
          label="المبيعات آجلة"
          value={formatEGP(creditSales)}
          hint="مبيعات غير مسددة بالكامل"
          icon={CreditCard}
          tone="bg-indigo-50 text-indigo-600"
          onClick={() => onNavigateTab('sales')}
        />
        <KpiTile
          label="تحصيلات الشهر"
          value={formatEGP(collectionsThisMonth)}
          hint="إجمالي المقبوضات وسندات التحصيل"
          icon={CheckCircle2}
          tone="bg-teal-50 text-teal-600"
          onClick={() => onNavigateTab('customers')}
        />
        <KpiTile
          label="أرصدة العملاء"
          value={formatEGP(customerReceivables)}
          hint="مديونيات مستحقة للشركة"
          icon={Users}
          tone="bg-amber-50 text-amber-700"
          onClick={() => onNavigateTab('customers')}
        />
        <KpiTile
          label="مستحقات الموردين"
          value={formatEGP(supplierPayables)}
          hint="التزامات الخامات والتعبئة"
          icon={Truck}
          tone="bg-rose-50 text-rose-600"
          onClick={() => onNavigateTab('suppliers')}
        />
        <KpiTile
          label="قيمة المخزون"
          value={formatEGP(inventoryValue)}
          hint="تقييم التشغيلات بالمستودعات"
          icon={Boxes}
          tone="bg-violet-50 text-violet-600"
          onClick={() => onNavigateTab('inventory')}
        />
        <KpiTile
          label="العهد القائمة"
          value={formatNum(openCustodies)}
          hint="عهد مناديب لم تُسوَّ بعد"
          icon={UserCheck}
          tone="bg-sky-50 text-sky-600"
          onClick={() => onNavigateTab('representatives')}
        />
        <KpiTile
          label="الخزينة"
          value={formatEGP(treasuryBalance)}
          hint="الخزينة الرئيسية النقدية (1101)"
          icon={Wallet}
          tone="bg-amber-50 text-amber-600"
          onClick={() => onNavigateTab('treasury')}
        />
        <KpiTile
          label="البنوك"
          value={formatEGP(bankBalancesTotal)}
          hint="حسابات البنوك (محولة لـ ج.م)"
          icon={Landmark}
          tone="bg-blue-50 text-blue-600"
          onClick={() => onNavigateTab('banks')}
        />
        <KpiTile
          label="صافي الربح"
          value={formatEGP(netProfit)}
          hint="الإيرادات − التكلفة المباشرة − المصروفات"
          icon={DollarSign}
          tone={netProfit >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}
          valueTone={netProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}
          onClick={() => onNavigateTab('accounting')}
        />
        <KpiTile
          label="أصناف قاربت الانتهاء"
          value={formatNum(expiringBatches.length)}
          hint="تشغيلات تنتهي خلال 10 أيام"
          icon={AlertTriangle}
          tone={expiringBatches.length > 0 ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-600'}
          onClick={() => onNavigateTab('inventory')}
        />
      </div>

      {/* Production flow strip */}
      <SectionCard
        title="دورة الإنتاج والتشغيل"
        hint="الخامات ← أمر الإنتاج ← صرف الخامات ← الإنتاج ← الجودة ← المنتجات التامة"
        icon={Factory}
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
          {flowSteps.map((step, idx) => {
            const Icon = step.icon;
            return (
              <button
                key={idx}
                onClick={() => onNavigateTab(step.tab)}
                className="group relative flex flex-col items-center gap-1.5 p-3 rounded-xl bg-cream-100 border border-cream-200 hover:border-brand-300 hover:bg-brand-50/50 transition cursor-pointer"
              >
                <span className="absolute top-1.5 left-2 text-[9px] font-black text-cream-400">
                  {idx + 1}
                </span>
                <Icon className="w-5 h-5 text-brand-600 group-hover:scale-110 transition-transform" />
                <span className="text-[11px] font-bold text-ink-800 text-center leading-tight">{step.label}</span>
                <span className="text-[10px] font-mono text-cream-600 font-bold">{step.count}</span>
              </button>
            );
          })}
        </div>
      </SectionCard>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Monthly revenue vs COGS bars */}
        <SectionCard title="الإيرادات مقابل التكلفة" hint="آخر 6 أشهر — من فواتير المبيعات المرحلة" icon={BarChart3} className="lg:col-span-2">
          {monthlySeries.every(m => m.revenue === 0) ? (
            <EmptyState
              title="لا توجد مبيعات مرحّلة بعد"
              hint="سيظهر الرسم البياني تلقائياً عند ترحيل فواتير المبيعات"
              icon={BarChart3}
            />
          ) : (
            <div className="flex items-end justify-between gap-3 h-48" dir="ltr">
              {monthlySeries.map(m => (
                <div key={m.key} className="flex-1 flex flex-col items-center gap-1.5 h-full justify-end">
                  <div className="w-full max-w-14 flex items-end justify-center gap-1 h-40">
                    <div
                      className="flex-1 rounded-t-lg bg-brand-500/90 min-h-[3px] transition-all"
                      style={{ height: `${Math.max(2, (m.revenue / monthlyMax) * 100)}%` }}
                      title={`إيرادات ${formatEGP(m.revenue)}`}
                    />
                    <div
                      className="flex-1 rounded-t-lg bg-cream-400 min-h-[3px] transition-all"
                      style={{ height: `${Math.max(2, (m.cogs / monthlyMax) * 100)}%` }}
                      title={`تكلفة ${formatEGP(m.cogs)}`}
                    />
                  </div>
                  <span className="text-[10px] font-bold text-cream-700">{m.label}</span>
                </div>
              ))}
            </div>
          )}
          {!monthlySeries.every(m => m.revenue === 0) && (
            <div className="flex items-center gap-4 mt-3 text-[11px] font-bold text-cream-700 border-t border-cream-100 pt-3">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-brand-500/90" /> الإيرادات
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-cream-400" /> التكلفة المباشرة (COGS)
              </span>
            </div>
          )}
        </SectionCard>

        {/* Inventory by warehouse */}
        <SectionCard title="قيمة المخزون بالمستودعات" hint="من سجل التشغيلات الفعلي" icon={Boxes}>
          {warehouseSeries.length === 0 ? (
            <EmptyState
              title="لا يوجد مخزون حالياً"
              hint="ستظهر قيمة المخزون لكل مستودع عند استلام الخامات أو إنتاج التام"
              icon={Boxes}
            />
          ) : (
            <div className="space-y-3">
              {warehouseSeries.map(w => (
                <div key={w.name}>
                  <div className="flex items-center justify-between text-[11px] font-bold text-ink-800 mb-1">
                    <span className="truncate">{w.name}</span>
                    <span className="font-mono text-cream-700 shrink-0">{formatEGP(w.value)}</span>
                  </div>
                  <div className="h-2.5 rounded-full bg-cream-100 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-l from-brand-500 to-brand-400"
                      style={{ width: `${Math.max(3, (w.value / whMax) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Row: expiry alerts & top products */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 10-day expiry alerts */}
        <div className="card p-5">
          <div className="flex items-center justify-between pb-3 border-b border-cream-200">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-brand-600" />
              <h3 className="font-black text-ink-900 text-sm">أصناف قاربت الصلاحية (خلال 10 أيام)</h3>
            </div>
            <span className="badge-brand">{expiringBatches.length} تشغيلات</span>
          </div>

          <div className="mt-4 space-y-2.5 max-h-72 overflow-y-auto">
            {expiringBatches.length === 0 ? (
              <EmptyState
                title="المخزون سليم — لا توجد تشغيلات قاربت على الانتهاء"
                icon={CheckCircle2}
              />
            ) : (
              expiringBatches.map(b => (
                <div key={b.id} className="p-3 rounded-xl bg-rose-50/70 border border-rose-200 text-xs flex items-center justify-between">
                  <div>
                    <div className="font-black text-rose-950">{b.itemNameAr}</div>
                    <div className="text-[11px] text-rose-700 mt-0.5 font-semibold">
                      تشغيلة: <span className="font-mono">{b.batchNumber}</span> | المستودع: {b.warehouseNameAr}
                    </div>
                  </div>
                  <div className="text-left font-mono shrink-0">
                    <span className="text-brand-700 font-black text-sm block">باقي {b.daysUntilExpiry} أيام</span>
                    <span className="text-[11px] text-cream-700 font-bold">الكمية: {b.quantity}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Best-selling products */}
        <div className="card p-5 lg:col-span-2">
          <div className="flex items-center justify-between pb-3 border-b border-cream-200">
            <div className="flex items-center gap-2">
              <ShoppingCart className="w-5 h-5 text-brand-600" />
              <h3 className="font-black text-ink-900 text-sm">أعلى منتجات SnakDip مبيعاً (Top 5)</h3>
            </div>
            <button
              onClick={() => onNavigateTab('items')}
              className="text-xs font-black text-brand-600 hover:text-brand-700 cursor-pointer flex items-center gap-1"
            >
              عرض سجل الأصناف <ArrowLeft className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="mt-4">
            {bestSelling.length === 0 ? (
              <EmptyState
                title="لا توجد مبيعات مسجلة حتى الآن"
                hint="ستظهر إحصائيات المنتجات فور ترحيل فواتير المبيعات"
                icon={Boxes}
              />
            ) : (
              <div className="space-y-3">
                {bestSelling.map((p, idx) => (
                  <div key={idx} className="p-3 rounded-xl bg-cream-100 border border-cream-200 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2.5">
                      <span className="w-6 h-6 rounded-lg bg-brand-500 text-white font-black flex items-center justify-center text-xs shadow-brand">
                        {idx + 1}
                      </span>
                      <span className="font-bold text-ink-900">{p.nameAr}</span>
                    </div>
                    <div className="flex items-center gap-4 font-mono">
                      <span className="text-cream-700 font-semibold">{p.qty} كرتونة</span>
                      <span className="font-black text-emerald-700">{formatEGP(p.revenue)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Empty-system helper */}
      {isEmptySystem && (
        <div className="card p-5 border-brand-200 bg-brand-50/40">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand-500 text-white flex items-center justify-center shrink-0 shadow-brand">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-black text-ink-900">ابدأ التشغيل الفعلي</h3>
              <p className="text-xs text-cream-700 mt-0.5 font-medium">
                لا توجد فواتير أو مخزون بعد — ابدأ بتوريد الخامات ثم إنشاء أمر إنتاج، وستتحدث كل المؤشرات تلقائياً من البيانات الفعلية.
              </p>
            </div>
            <button onClick={() => onNavigateTab('purchasing')} className="btn-primary btn-sm mr-auto shrink-0 hidden sm:inline-flex">
              توريد خامات
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/* ---------- KPI tile ---------- */
const KpiTile: React.FC<{
  label: string;
  value: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
  valueTone?: string;
  onClick?: () => void;
}> = ({ label, value, hint, icon: Icon, tone, valueTone, onClick }) => (
  <div className="kpi-card" onClick={onClick}>
    <div className="flex items-center justify-between">
      <span className="kpi-label">{label}</span>
      <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${tone}`}>
        <Icon className="w-4 h-4" />
      </div>
    </div>
    <div className={`kpi-value ${valueTone || ''}`}>{value}</div>
    <div className="kpi-hint">{hint}</div>
  </div>
);
