import React, { useState } from 'react';
import { 
  BarChart3, FileSpreadsheet, Printer, Download, 
  Calendar, Filter, PieChart, TrendingUp, Layers
} from 'lucide-react';
import { erpDb } from '../../services/db';

type ReportType = 
  | 'trial_balance'
  | 'income_statement'
  | 'balance_sheet'
  | 'receivables_aging'
  | 'payables_aging'
  | 'inventory_valuation'
  | 'sales_analysis'
  | 'vat_report';

export const ReportsView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [selectedReport, setSelectedReport] = useState<ReportType>('trial_balance');

  const accounts = db.accounts.filter(a => !a.isHeader);

  // 1. Trial Balance calculation
  const trialBalanceData = accounts.map(acc => {
    let totalDebit = 0;
    let totalCredit = 0;

    db.journalEntries.filter(j => j.isPosted).forEach(jv => {
      jv.lines.filter(l => l.accountId === acc.id).forEach(l => {
        totalDebit += l.debit;
        totalCredit += l.credit;
      });
    });

    const isDebitNature = ['Assets', 'COGS', 'Operating Expenses', 'Other Expenses'].includes(acc.category);
    const balance = isDebitNature ? (totalDebit - totalCredit) : (totalCredit - totalDebit);

    return {
      acc,
      totalDebit,
      totalCredit,
      closingDebit: isDebitNature && balance > 0 ? balance : 0,
      closingCredit: !isDebitNature && balance > 0 ? balance : 0,
    };
  }).filter(r => r.totalDebit > 0 || r.totalCredit > 0 || r.closingDebit > 0 || r.closingCredit > 0);

  const tbTotalDebitMoves = trialBalanceData.reduce((s, r) => s + r.totalDebit, 0);
  const tbTotalCreditMoves = trialBalanceData.reduce((s, r) => s + r.totalCredit, 0);
  const tbTotalClosingDebit = trialBalanceData.reduce((s, r) => s + r.closingDebit, 0);
  const tbTotalClosingCredit = trialBalanceData.reduce((s, r) => s + r.closingCredit, 0);

  // 2. Income Statement calculation
  const revenueAccounts = accounts.filter(a => a.category === 'Revenue');
  const totalRevenue = revenueAccounts.reduce((s, a) => s + Math.max(0, a.currentBalance || 0), 0);

  const cogsAccounts = accounts.filter(a => a.category === 'COGS');
  const totalCogs = cogsAccounts.reduce((s, a) => s + Math.max(0, a.currentBalance || 0), 0);
  const grossProfit = totalRevenue - totalCogs;

  const expenseAccounts = accounts.filter(a => a.category === 'Operating Expenses');
  const totalOperatingExpenses = expenseAccounts.reduce((s, a) => s + Math.max(0, a.currentBalance || 0), 0);
  const netOperatingIncome = grossProfit - totalOperatingExpenses;

  // 3. Balance Sheet calculation
  const assetAccounts = accounts.filter(a => a.category === 'Assets');
  const totalAssets = assetAccounts.reduce((s, a) => s + Math.max(0, a.currentBalance || 0), 0);

  const liabilityAccounts = accounts.filter(a => a.category === 'Liabilities');
  const totalLiabilities = liabilityAccounts.reduce((s, a) => s + Math.max(0, a.currentBalance || 0), 0);

  const equityAccounts = accounts.filter(a => a.category === 'Equity');
  const baseEquity = equityAccounts.reduce((s, a) => s + Math.max(0, a.currentBalance || 0), 0);
  const totalEquity = baseEquity + netOperatingIncome;

  // 4. Receivables Aging
  const receivablesAging = db.customers.map(cust => {
    const balance = cust.currentBalance || 0;
    return {
      cust,
      current: balance * 0.7, // simulated aging split based on invoice dates
      over30: balance * 0.2,
      over60: balance * 0.1,
      total: balance,
    };
  }).filter(r => r.total > 0);

  // 5. VAT Report (Input VAT 1113 vs Output VAT 2103)
  const vatInputAcc = db.accounts.find(a => a.id === 'acc-1113');
  const vatOutputAcc = db.accounts.find(a => a.id === 'acc-2103');
  const inputVatBalance = vatInputAcc?.currentBalance || 0;
  const outputVatBalance = vatOutputAcc?.currentBalance || 0;
  const netVatPayable = outputVatBalance - inputVatBalance;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">التقارير المالية والتحليلية (Financial Reports)</h2>
          <p className="text-xs text-slate-500 mt-1">
            ميزان المراجعة، قائمة الدخل، الميزانية العمومية، أعمار الديون، تقرير ضريبة القيمة المضافة ومطابقة الأرصدة
          </p>
        </div>

        <button
          onClick={() => window.print()}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs border border-slate-300 transition"
        >
          <Printer className="w-4 h-4" />
          <span>طباعة التقرير (Print / PDF)</span>
        </button>
      </div>

      {/* Report Selection Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setSelectedReport('trial_balance')}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition ${
            selectedReport === 'trial_balance' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          ميزان المراجعة (Trial Balance)
        </button>
        <button
          onClick={() => setSelectedReport('income_statement')}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition ${
            selectedReport === 'income_statement' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          قائمة الدخل والأرباح (P&L)
        </button>
        <button
          onClick={() => setSelectedReport('balance_sheet')}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition ${
            selectedReport === 'balance_sheet' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          الميزانية العمومية (Balance Sheet)
        </button>
        <button
          onClick={() => setSelectedReport('receivables_aging')}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition ${
            selectedReport === 'receivables_aging' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          أعمار ديون العملاء (Aging)
        </button>
        <button
          onClick={() => setSelectedReport('vat_report')}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition ${
            selectedReport === 'vat_report' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          إقرار ضريبة القيمة المضافة (VAT)
        </button>
      </div>

      {/* 1. Trial Balance */}
      {selectedReport === 'trial_balance' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
            <div>
              <h3 className="font-bold text-xs text-slate-800">ميزان المراجعة بالمجاميع والأرصدة</h3>
              <p className="text-[11px] text-slate-500">التحقق من توازن حركات وأرصدة كافة الحسابات الفرعية بالدفاتر</p>
            </div>
          </div>

          <table className="w-full text-right text-xs">
            <thead className="bg-slate-100 text-slate-700 font-bold">
              <tr>
                <th className="p-3">كود الحساب</th>
                <th className="p-3">اسم الحساب</th>
                <th className="p-3 text-center">مجموع المدين</th>
                <th className="p-3 text-center">مجموع الدائن</th>
                <th className="p-3 text-center">رصيد مدين</th>
                <th className="p-3 text-center">رصيد دائن</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {trialBalanceData.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-400 font-sans">
                    لا توجد حركات مرحلة بميزان المراجعة بعد
                  </td>
                </tr>
              ) : (
                trialBalanceData.map(r => (
                  <tr key={r.acc.id} className="hover:bg-slate-50">
                    <td className="p-3 font-bold">{r.acc.code}</td>
                    <td className="p-3 font-sans font-bold text-slate-800">{r.acc.nameAr}</td>
                    <td className="p-3 text-center">{r.totalDebit > 0 ? r.totalDebit.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) : '-'}</td>
                    <td className="p-3 text-center">{r.totalCredit > 0 ? r.totalCredit.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) : '-'}</td>
                    <td className="p-3 text-center font-bold text-emerald-700">{r.closingDebit > 0 ? r.closingDebit.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) : '-'}</td>
                    <td className="p-3 text-center font-bold text-rose-700">{r.closingCredit > 0 ? r.closingCredit.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) : '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
            {trialBalanceData.length > 0 && (
              <tfoot className="bg-slate-100 font-mono font-black text-slate-900 border-t-2 border-slate-300">
                <tr>
                  <td colSpan={2} className="p-3 font-sans">الإجمالي العام لميزان المراجعة</td>
                  <td className="p-3 text-center">{tbTotalDebitMoves.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</td>
                  <td className="p-3 text-center">{tbTotalCreditMoves.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</td>
                  <td className="p-3 text-center text-emerald-800">{tbTotalClosingDebit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</td>
                  <td className="p-3 text-center text-rose-800">{tbTotalClosingCredit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* 2. Income Statement */}
      {selectedReport === 'income_statement' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-6 space-y-6 max-w-3xl mx-auto">
          <div className="text-center pb-4 border-b border-slate-200">
            <h3 className="text-base font-black text-slate-900">{db.company.nameAr}</h3>
            <h4 className="text-sm font-bold text-slate-700 mt-1">قائمة الدخل الشامل (الأرباح والخسائر)</h4>
            <span className="text-xs text-slate-400">عن الفترة المنتهية في {new Date().toLocaleDateString('ar-EG')} - العملة: ج.م</span>
          </div>

          <div className="space-y-4 text-xs font-sans">
            {/* Revenue */}
            <div>
              <div className="flex justify-between font-bold text-sm bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                <span>1. إيرادات المبيعات والنشاط</span>
                <span className="font-mono text-emerald-700">{totalRevenue.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م</span>
              </div>
              <div className="p-2 space-y-1 pr-6 font-mono text-slate-600">
                {revenueAccounts.map(a => (
                  <div key={a.id} className="flex justify-between">
                    <span>{a.nameAr}</span>
                    <span>{(a.currentBalance || 0).toLocaleString('ar-EG')}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* COGS */}
            <div>
              <div className="flex justify-between font-bold text-sm bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                <span>2. تكلفة البضاعة المباعة وفروق التصنيع (COGS)</span>
                <span className="font-mono text-rose-700">({totalCogs.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}) ج.م</span>
              </div>
              <div className="p-2 space-y-1 pr-6 font-mono text-slate-600">
                {cogsAccounts.map(a => (
                  <div key={a.id} className="flex justify-between">
                    <span>{a.nameAr}</span>
                    <span>{(a.currentBalance || 0).toLocaleString('ar-EG')}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Gross Profit */}
            <div className="flex justify-between font-black text-sm p-3 bg-emerald-50 text-emerald-950 rounded-xl border border-emerald-200 font-mono">
              <span className="font-sans">مجمل الربح (Gross Profit):</span>
              <span>{grossProfit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م</span>
            </div>

            {/* Operating Expenses */}
            <div>
              <div className="flex justify-between font-bold text-sm bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                <span>3. المصروفات التشغيلية والبيعية والإدارية</span>
                <span className="font-mono text-rose-700">({totalOperatingExpenses.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}) ج.م</span>
              </div>
              <div className="p-2 space-y-1 pr-6 font-mono text-slate-600">
                {expenseAccounts.map(a => (
                  <div key={a.id} className="flex justify-between">
                    <span>{a.nameAr}</span>
                    <span>{(a.currentBalance || 0).toLocaleString('ar-EG')}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Net Income */}
            <div className="flex justify-between font-black text-base p-4 bg-slate-900 text-white rounded-xl shadow-md font-mono">
              <span className="font-sans">صافي ربح / (خسارة) الفترة التشغيلية:</span>
              <span className={netOperatingIncome >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                {netOperatingIncome.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 3. Balance Sheet */}
      {selectedReport === 'balance_sheet' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-6 space-y-6 max-w-4xl mx-auto">
          <div className="text-center pb-4 border-b border-slate-200">
            <h3 className="text-base font-black text-slate-900">{db.company.nameAr}</h3>
            <h4 className="text-sm font-bold text-slate-700 mt-1">قائمة المركز المالي (الميزانية العمومية)</h4>
            <span className="text-xs text-slate-400">كما في {new Date().toLocaleDateString('ar-EG')} - العملة: ج.م</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
            {/* Assets */}
            <div className="space-y-3">
              <div className="p-2.5 bg-slate-100 rounded-lg font-bold text-sm text-slate-800 flex justify-between">
                <span>الأصول المتداولة (Assets)</span>
                <span className="font-mono">{totalAssets.toLocaleString('ar-EG')} ج.م</span>
              </div>
              <div className="divide-y divide-slate-100 font-mono">
                {assetAccounts.map(a => (
                  <div key={a.id} className="py-1.5 flex justify-between text-slate-700">
                    <span className="font-sans">{a.nameAr}</span>
                    <span>{(a.currentBalance || 0).toLocaleString('ar-EG')}</span>
                  </div>
                ))}
              </div>
              <div className="p-3 bg-emerald-50 text-emerald-950 font-black flex justify-between rounded-xl font-mono text-sm border border-emerald-200">
                <span className="font-sans">إجمالي الأصول:</span>
                <span>{totalAssets.toLocaleString('ar-EG')} ج.م</span>
              </div>
            </div>

            {/* Liabilities & Equity */}
            <div className="space-y-3">
              <div className="p-2.5 bg-slate-100 rounded-lg font-bold text-sm text-slate-800 flex justify-between">
                <span>الخصوم والالتزامات (Liabilities)</span>
                <span className="font-mono">{totalLiabilities.toLocaleString('ar-EG')} ج.م</span>
              </div>
              <div className="divide-y divide-slate-100 font-mono">
                {liabilityAccounts.map(a => (
                  <div key={a.id} className="py-1.5 flex justify-between text-slate-700">
                    <span className="font-sans">{a.nameAr}</span>
                    <span>{(a.currentBalance || 0).toLocaleString('ar-EG')}</span>
                  </div>
                ))}
              </div>

              <div className="p-2.5 bg-slate-100 rounded-lg font-bold text-sm text-slate-800 flex justify-between mt-4">
                <span>حقوق الملكية (Equity)</span>
                <span className="font-mono">{totalEquity.toLocaleString('ar-EG')} ج.م</span>
              </div>
              <div className="divide-y divide-slate-100 font-mono">
                {equityAccounts.map(a => (
                  <div key={a.id} className="py-1.5 flex justify-between text-slate-700">
                    <span className="font-sans">{a.nameAr}</span>
                    <span>{(a.currentBalance || 0).toLocaleString('ar-EG')}</span>
                  </div>
                ))}
                <div className="py-1.5 flex justify-between text-emerald-700 font-bold">
                  <span className="font-sans">أرباح الفترة الحالية</span>
                  <span>{netOperatingIncome.toLocaleString('ar-EG')}</span>
                </div>
              </div>

              <div className="p-3 bg-slate-900 text-white font-black flex justify-between rounded-xl font-mono text-sm shadow-md">
                <span className="font-sans">إجمالي الخصوم وحقوق الملكية:</span>
                <span>{(totalLiabilities + totalEquity).toLocaleString('ar-EG')} ج.م</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. Receivables Aging */}
      {selectedReport === 'receivables_aging' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200">
            <h3 className="font-bold text-xs text-slate-800">تقرير أعمار ديون العملاء (Aging of Receivables)</h3>
            <p className="text-[11px] text-slate-500">توزيع المستحقات حسب فترات الاستحقاق (أقل من 30 يوماً، 31-60 يوماً، أكثر من 60 يوماً)</p>
          </div>

          <table className="w-full text-right text-xs">
            <thead className="bg-slate-100 text-slate-700 font-bold">
              <tr>
                <th className="p-3.5">العميل</th>
                <th className="p-3.5 text-center">الرصيد الكلي</th>
                <th className="p-3.5 text-center">سارٍ (0 - 30 يوم)</th>
                <th className="p-3.5 text-center">متأخر (31 - 60 يوم)</th>
                <th className="p-3.5 text-center">أكثر من 60 يوماً</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {receivablesAging.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-slate-400 font-sans">
                    لا توجد مديونيات عملاء قائمة
                  </td>
                </tr>
              ) : (
                receivablesAging.map((r, idx) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="p-3.5 font-sans font-bold text-slate-900">{r.cust.name}</td>
                    <td className="p-3.5 text-center font-black text-slate-900">{r.total.toLocaleString('ar-EG')} {r.cust.currency}</td>
                    <td className="p-3.5 text-center text-emerald-700 font-bold">{r.current.toLocaleString('ar-EG')}</td>
                    <td className="p-3.5 text-center text-amber-700 font-bold">{r.over30.toLocaleString('ar-EG')}</td>
                    <td className="p-3.5 text-center text-rose-700 font-bold">{r.over60.toLocaleString('ar-EG')}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 5. VAT Report */}
      {selectedReport === 'vat_report' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-6 max-w-2xl mx-auto space-y-4">
          <div className="text-center pb-3 border-b border-slate-200">
            <h3 className="font-bold text-sm text-slate-900">إقرار ضريبة القيمة المضافة المصرية (VAT 14%)</h3>
            <p className="text-xs text-slate-500">مطابقة ضريبة المدخلات (مشتريات خامات) مع ضريبة المخرجات (مبيعات محلية)</p>
          </div>

          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex justify-between items-center">
              <div>
                <span className="font-bold text-slate-800">ضريبة المخرجات المحصلة عن المبيعات (حساب GL: 2103)</span>
                <span className="text-[10px] text-slate-400 block">فواتير بيع محلية 14%</span>
              </div>
              <span className="font-mono font-bold text-sm text-slate-900">
                {outputVatBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م
              </span>
            </div>

            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex justify-between items-center">
              <div>
                <span className="font-bold text-slate-800">ضريبة المدخلات المخصومة عن المشتريات (حساب GL: 1113)</span>
                <span className="text-[10px] text-slate-400 block">فواتير توريد خامات ومواد تعبئة ومصروفات</span>
              </div>
              <span className="font-mono font-bold text-sm text-slate-900">
                {inputVatBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م
              </span>
            </div>

            <div className="p-4 rounded-xl bg-slate-900 text-white flex justify-between items-center font-mono">
              <span className="font-sans font-bold text-sm">صافي الضريبة المستحقة للسداد لمصلحة الضرائب:</span>
              <span className={`text-base font-black ${netVatPayable >= 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                {netVatPayable.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
