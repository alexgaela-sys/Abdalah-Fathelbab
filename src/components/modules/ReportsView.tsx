import React, { useState } from 'react';
import { 
  BarChart3, FileSpreadsheet, Printer, Download, 
  Calendar, Filter, PieChart, TrendingUp, Layers
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { isDebitNatureCategory } from '../../types/erp';
import { LedgerService } from '../../services/ledger';
import { printDocument } from '../printUtils';

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

  // ---------- Period filter (F13: reports are period-aware, nothing is hidden) ----------
  const firstOfMonth = new Date();
  firstOfMonth.setDate(1);
  const [fromDate, setFromDate] = useState(firstOfMonth.toISOString().split('T')[0]);
  const [toDate, setToDate] = useState(new Date().toISOString().split('T')[0]);
  const [allPeriods, setAllPeriods] = useState(true);

  const inPeriod = (dateStr: string) => {
    if (allPeriods) return true;
    const d = new Date(dateStr);
    const from = new Date(fromDate);
    const to = new Date(toDate);
    to.setHours(23, 59, 59, 999);
    return d >= from && d <= to;
  };

  const accounts = db.accounts.filter(a => !a.isHeader);

  /** Signed balance (nature-aware) of an account over the selected period. Never clamped. */
  const signedBalance = (acc: { id: string; category: string }, periodOnly: boolean) => {
    let debit = 0;
    let credit = 0;
    db.journalEntries.filter(j => j.isPosted && (!periodOnly || inPeriod(j.date))).forEach(jv => {
      jv.lines.filter(l => l.accountId === acc.id).forEach(l => {
        debit += l.debit;
        credit += l.credit;
      });
    });
    return isDebitNatureCategory(acc.category as any) ? (debit - credit) : (credit - debit);
  };

  // 1. Trial Balance calculation — every movement, plus the SIGNED closing balance so
  //    abnormal (negative) balances stay visible instead of being clamped to zero.
  const trialBalanceData = accounts.map(acc => {
    let totalDebit = 0;
    let totalCredit = 0;

    db.journalEntries.filter(j => j.isPosted).forEach(jv => {
      jv.lines.filter(l => l.accountId === acc.id).forEach(l => {
        totalDebit += l.debit;
        totalCredit += l.credit;
      });
    });

    const isDebitNature = isDebitNatureCategory(acc.category);
    const net = isDebitNature ? (totalDebit - totalCredit) : (totalCredit - totalDebit);

    return {
      acc,
      totalDebit,
      totalCredit,
      net,
      isDebitNature,
      closingDebit: net >= 0 ? net : 0,
      closingCredit: net < 0 ? Math.abs(net) : 0,
      abnormal: net < 0,
    };
  }).filter(r => Math.abs(r.totalDebit) > 0.005 || Math.abs(r.totalCredit) > 0.005 || Math.abs(r.net) > 0.005);

  const tbTotalDebitMoves = trialBalanceData.reduce((s, r) => s + r.totalDebit, 0);
  const tbTotalCreditMoves = trialBalanceData.reduce((s, r) => s + r.totalCredit, 0);
  const tbTotalClosingDebit = trialBalanceData.reduce((s, r) => s + r.closingDebit, 0);
  const tbTotalClosingCredit = trialBalanceData.reduce((s, r) => s + r.closingCredit, 0);
  const tbNetMoves = tbTotalDebitMoves - tbTotalCreditMoves;
  const tbAbnormal = trialBalanceData.filter(r => r.abnormal);

  // 2. Income Statement — period-aware, signed (no Math.max clamping).
  const revenueAccounts = accounts.filter(a => a.category === 'Revenue');
  const revenueRows = revenueAccounts.map(a => ({ acc: a, balance: signedBalance(a, !allPeriods) }));
  const totalRevenue = revenueRows.reduce((s, r) => s + r.balance, 0);

  const cogsAccounts = accounts.filter(a => a.category === 'COGS');
  const cogsRows = cogsAccounts.map(a => ({ acc: a, balance: signedBalance(a, !allPeriods) }));
  const totalCogs = cogsRows.reduce((s, r) => s + r.balance, 0);
  const grossProfit = totalRevenue - totalCogs;

  const expenseAccounts = accounts.filter(a => a.category === 'Operating Expenses' || a.category === 'Other Expenses');
  const expenseRows = expenseAccounts.map(a => ({ acc: a, balance: signedBalance(a, !allPeriods) }));
  const totalOperatingExpenses = expenseRows.reduce((s, r) => s + r.balance, 0);
  const netOperatingIncome = grossProfit - totalOperatingExpenses;

  // 3. Balance Sheet — cumulative (all periods), signed, with an explicit imbalance line.
  const assetAccounts = accounts.filter(a => a.category === 'Assets');
  const assetRows = assetAccounts.map(a => ({ acc: a, balance: signedBalance(a, false) }));
  const totalAssets = assetRows.reduce((s, r) => s + r.balance, 0);

  const liabilityAccounts = accounts.filter(a => a.category === 'Liabilities');
  const liabilityRows = liabilityAccounts.map(a => ({ acc: a, balance: signedBalance(a, false) }));
  const totalLiabilities = liabilityRows.reduce((s, r) => s + r.balance, 0);

  const equityAccounts = accounts.filter(a => a.category === 'Equity');
  const equityRows = equityAccounts.map(a => ({ acc: a, balance: signedBalance(a, false) }));
  const baseEquity = equityRows.reduce((s, r) => s + r.balance, 0);
  // Current-period result flows into equity; the opening equity stays as booked.
  const totalEquity = baseEquity + netOperatingIncome;
  const bsImbalance = totalAssets - (totalLiabilities + totalEquity);

  // 4. Receivables Aging — derived from the AUTHORITATIVE customer statement
  // (posted GL receivable lines), so invoices, returns, cash/bank collections,
  // cheques and bounces, and export collections all net correctly. Credit
  // balances are shown in their own column and are NEVER hidden.
  // QA-10: the aging report is a VIEW over the single authoritative
  // settlement-aware allocation in LedgerService — the buckets always tie to
  // the customer statement closing balance, and a cheque receipt settles its
  // invoice exactly once (no double counting).
  const receivablesAging = LedgerService.buildReceivablesAging()
    .map(r => ({
      custId: r.customerId,
      b0_30: r.b0_30,
      b31_60: r.b31_60,
      b61_90: r.b61_90,
      b90plus: r.b90plus,
      credit: r.credit,
      total: r.total,
      cust: db.customers.find(c => c.id === r.customerId)!,
    }))
    .filter(r => r.cust);

  const agingTotals = receivablesAging.reduce((acc, r) => ({
    b0_30: acc.b0_30 + r.b0_30,
    b31_60: acc.b31_60 + r.b31_60,
    b61_90: acc.b61_90 + r.b61_90,
    b90plus: acc.b90plus + r.b90plus,
    credit: acc.credit + r.credit,
    total: acc.total + r.total,
  }), { b0_30: 0, b31_60: 0, b61_90: 0, b90plus: 0, credit: 0, total: 0 });

  // 5. VAT Report — derived from the ACTUAL 1113/2103 journal lines in the period.
  const vatLines = (accountId: string) => {
    let balance = 0;
    db.journalEntries.filter(j => j.isPosted && inPeriod(j.date)).forEach(jv => {
      jv.lines.filter(l => l.accountId === accountId).forEach(l => { balance += l.debit - l.credit; });
    });
    return balance;
  };
  const inputVatDebits = db.journalEntries.filter(j => j.isPosted && inPeriod(j.date))
    .flatMap(j => j.lines).filter(l => l.accountId === 'acc-1113');
  const outputVatCredits = db.journalEntries.filter(j => j.isPosted && inPeriod(j.date))
    .flatMap(j => j.lines).filter(l => l.accountId === 'acc-2103');
  const inputVatBalance = vatLines('acc-1113');
  const outputVatBalance = -vatLines('acc-2103'); // 2103 is a liability (credit nature)
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
          onClick={printDocument}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs border border-slate-300 transition"
        >
          <Printer className="w-4 h-4" />
          <span>طباعة التقرير (Print / PDF)</span>
        </button>
      </div>

      {/* Period filter */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-4 flex flex-col sm:flex-row sm:items-end gap-3">
        <label className="flex items-center gap-2 text-xs font-bold text-slate-700">
          <input
            type="checkbox"
            checked={allPeriods}
            onChange={(e) => setAllPeriods(e.target.checked)}
            className="w-4 h-4 accent-slate-900"
          />
          كل الفترات (تراكمي)
        </label>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Calendar className="w-4 h-4" />
          <span className="font-bold text-slate-700">من</span>
          <input
            type="date"
            value={fromDate}
            disabled={allPeriods}
            onChange={(e) => setFromDate(e.target.value)}
            className="p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs disabled:opacity-50"
          />
          <span className="font-bold text-slate-700">إلى</span>
          <input
            type="date"
            value={toDate}
            disabled={allPeriods}
            onChange={(e) => setToDate(e.target.value)}
            className="p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs disabled:opacity-50"
          />
        </div>
        <p className="text-[11px] text-slate-500 sm:mr-auto">
          {allPeriods
            ? 'التقارير تُحسب على كامل الحركات المرحلة (تراكمي)'
            : 'قائمة الدخل وضريبة القيمة المضافة تُحسب على الفترة المحددة فقط، بينما الميزانية وميزان المراجعة تظل تراكمية'}
        </p>
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
        <div className="print-area bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
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
                <th className="p-3 text-center">صافي الرصيد (طبيعة الحساب)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {trialBalanceData.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400 font-sans">
                    لا توجد حركات مرحلة بميزان المراجعة بعد
                  </td>
                </tr>
              ) : (
                trialBalanceData.map(r => (
                  <tr key={r.acc.id} className="hover:bg-slate-50">
                    <td className="p-3 font-bold">
                      {r.acc.code}
                      {r.abnormal && (
                        <span className="mr-1 text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold" title="رصيد معاكس لطبيعة الحساب">
                          رصيد عكسي
                        </span>
                      )}
                    </td>
                    <td className="p-3 font-sans font-bold text-slate-800">{r.acc.nameAr}</td>
                    <td className="p-3 text-center">{r.totalDebit > 0 ? r.totalDebit.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) : '-'}</td>
                    <td className="p-3 text-center">{r.totalCredit > 0 ? r.totalCredit.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) : '-'}</td>
                    <td className="p-3 text-center font-bold text-emerald-700">{r.closingDebit > 0 ? r.closingDebit.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) : '-'}</td>
                    <td className="p-3 text-center font-bold text-rose-700">{r.closingCredit > 0 ? r.closingCredit.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) : '-'}</td>
                    <td className={`p-3 text-center font-bold ${r.net < 0 ? 'text-amber-700' : 'text-slate-800'}`}>
                      {r.net.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {r.isDebitNature ? 'مدين' : 'دائن'}
                    </td>
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
                  <td className="p-3 text-center">
                    {(tbTotalClosingDebit - tbTotalClosingCredit).toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {tbAbnormal.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs text-amber-900">
          <p className="font-bold mb-1">حسابات برصيد معاكس لطبيعتها ({tbAbnormal.length})</p>
          <p className="mb-2">هذه الأرصدة ظاهرة أعلاه كما هي ولم يتم إخفاؤها أو تصفيرها:</p>
          <ul className="space-y-0.5 font-mono">
            {tbAbnormal.map(r => (
              <li key={r.acc.id}>
                • {r.acc.code} — {r.acc.nameAr}: {Math.abs(r.net).toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {r.isDebitNature ? 'دائن' : 'مدين'} (عكس طبيعة الحساب)
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 2. Income Statement */}
      {selectedReport === 'income_statement' && (
        <div className="print-area bg-white rounded-2xl border border-slate-200 shadow-xs p-6 space-y-6 max-w-3xl mx-auto">
          <div className="text-center pb-4 border-b border-slate-200">
            <h3 className="text-base font-black text-slate-900">{db.company.nameAr}</h3>
            <h4 className="text-sm font-bold text-slate-700 mt-1">قائمة الدخل الشامل (الأرباح والخسائر)</h4>
            <span className="text-xs text-slate-400">
              {allPeriods ? 'عن كامل الحركات المرحلة حتى ' : `عن الفترة من ${fromDate} إلى ${toDate} - `}
              العملة: ج.م
            </span>
          </div>

          <div className="space-y-4 text-xs font-sans">
            {/* Revenue */}
            <div>
              <div className="flex justify-between font-bold text-sm bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                <span>1. إيرادات المبيعات والنشاط</span>
                <span className="font-mono text-emerald-700">{totalRevenue.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م</span>
              </div>
              <div className="p-2 space-y-1 pr-6 font-mono text-slate-600">
                {revenueRows.map(r => (
                  <div key={r.acc.id} className="flex justify-between">
                    <span>{r.acc.nameAr}</span>
                    <span>{r.balance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</span>
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
                {cogsRows.map(r => (
                  <div key={r.acc.id} className="flex justify-between">
                    <span>{r.acc.nameAr}</span>
                    <span>{r.balance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</span>
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
                {expenseRows.map(r => (
                  <div key={r.acc.id} className="flex justify-between">
                    <span>{r.acc.nameAr}</span>
                    <span>{r.balance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</span>
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
        <div className="print-area bg-white rounded-2xl border border-slate-200 shadow-xs p-6 space-y-6 max-w-4xl mx-auto">
          <div className="text-center pb-4 border-b border-slate-200">
            <h3 className="text-base font-black text-slate-900">{db.company.nameAr}</h3>
            <h4 className="text-sm font-bold text-slate-700 mt-1">قائمة المركز المالي (الميزانية العمومية)</h4>
            <span className="text-xs text-slate-400">
              كما في {new Date().toLocaleDateString('ar-EG')} — تراكمية على كامل الحركات المرحلة - العملة: ج.م
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
            {/* Assets */}
            <div className="space-y-3">
              <div className="p-2.5 bg-slate-100 rounded-lg font-bold text-sm text-slate-800 flex justify-between">
                <span>الأصول المتداولة (Assets)</span>
                <span className="font-mono">{totalAssets.toLocaleString('ar-EG')} ج.م</span>
              </div>
              <div className="divide-y divide-slate-100 font-mono">
                {assetRows.map(r => (
                  <div key={r.acc.id} className="py-1.5 flex justify-between text-slate-700">
                    <span className="font-sans">{r.acc.nameAr}</span>
                    <span className={r.balance < 0 ? 'text-amber-700 font-bold' : ''}>{r.balance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</span>
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
                {liabilityRows.map(r => (
                  <div key={r.acc.id} className="py-1.5 flex justify-between text-slate-700">
                    <span className="font-sans">{r.acc.nameAr}</span>
                    <span className={r.balance < 0 ? 'text-amber-700 font-bold' : ''}>{r.balance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</span>
                  </div>
                ))}
              </div>

              <div className="p-2.5 bg-slate-100 rounded-lg font-bold text-sm text-slate-800 flex justify-between mt-4">
                <span>حقوق الملكية (Equity)</span>
                <span className="font-mono">{totalEquity.toLocaleString('ar-EG')} ج.م</span>
              </div>
              <div className="divide-y divide-slate-100 font-mono">
                {equityRows.map(r => (
                  <div key={r.acc.id} className="py-1.5 flex justify-between text-slate-700">
                    <span className="font-sans">{r.acc.nameAr}</span>
                    <span>{r.balance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</span>
                  </div>
                ))}
                <div className="py-1.5 flex justify-between text-emerald-700 font-bold">
                  <span className="font-sans">أرباح الفترة الحالية</span>
                  <span>{netOperatingIncome.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</span>
                </div>
              </div>

              <div className="p-3 bg-slate-900 text-white font-black flex justify-between rounded-xl font-mono text-sm shadow-md">
                <span className="font-sans">إجمالي الخصوم وحقوق الملكية:</span>
                <span>{(totalLiabilities + totalEquity).toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م</span>
              </div>

              {/* F13: the balance-sheet identity is shown explicitly, never forced. */}
              <div className={`p-3 rounded-xl border font-mono text-xs font-bold flex justify-between ${
                Math.abs(bsImbalance) < 0.01
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-amber-50 border-amber-300 text-amber-900'
              }`}>
                <span className="font-sans">
                  {Math.abs(bsImbalance) < 0.01
                    ? 'الميزانية متوازنة: الأصول = الخصوم + حقوق الملكية'
                    : 'فرق غير موزون (معروض كما هو دون إخفاء)'}
                </span>
                <span>{(totalAssets - (totalLiabilities + totalEquity)).toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. Receivables Aging */}
      {selectedReport === 'receivables_aging' && (
        <div className="print-area bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200">
            <h3 className="font-bold text-xs text-slate-800">تقرير أعمار ديون العملاء (Aging of Receivables)</h3>
            <p className="text-[11px] text-slate-500">
              محسوب من فواتير البيع المرحّلة الفعلية مطروحاً منها التخصيصات المحصّلة فعلياً، buckets: 0-30 / 31-60 / 61-90 / +90 يوم
            </p>
          </div>

          <table className="w-full text-right text-xs">
            <thead className="bg-slate-100 text-slate-700 font-bold">                <tr>
                  <th className="p-3.5">العميل</th>
                  <th className="p-3.5 text-center">الرصيد الكلي</th>
                  <th className="p-3.5 text-center">سارٍ (0 - 30 يوم)</th>
                  <th className="p-3.5 text-center">متأخر (31 - 60 يوم)</th>
                  <th className="p-3.5 text-center">متأخر (61 - 90 يوم)</th>
                  <th className="p-3.5 text-center">متحمل (أكثر من 90 يوم)</th>
                  <th className="p-3.5 text-center">رصيد دائن (دفع مقدمة)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
              {receivablesAging.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400 font-sans">
                    لا توجد مديونيات عملاء قائمة
                  </td>
                </tr>
              ) : (
                receivablesAging.map((r, idx) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="p-3.5 font-sans font-bold text-slate-900">{r.cust.name}</td>
                    <td className={`p-3.5 text-center font-black ${r.total < 0 ? 'text-rose-700' : 'text-slate-900'}`}>
                      {r.total.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                    </td>
                    <td className="p-3.5 text-center text-emerald-700 font-bold">{r.b0_30.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</td>
                    <td className="p-3.5 text-center text-amber-700 font-bold">{r.b31_60.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</td>
                    <td className="p-3.5 text-center text-orange-700 font-bold">{r.b61_90.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</td>
                    <td className="p-3.5 text-center text-rose-700 font-bold">{r.b90plus.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</td>
                    <td className="p-3.5 text-center text-slate-600 font-bold">{r.credit > 0 ? r.credit.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) : '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
            {receivablesAging.length > 0 && (
              <tfoot className="bg-slate-100 font-mono font-black text-slate-900 border-t-2 border-slate-300">
                <tr>
                  <td className="p-3.5 font-sans">الإجمالي</td>
                  <td className="p-3.5 text-center">{agingTotals.total.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</td>
                  <td className="p-3.5 text-center text-emerald-800">{agingTotals.b0_30.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</td>
                  <td className="p-3.5 text-center text-amber-800">{agingTotals.b31_60.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</td>
                  <td className="p-3.5 text-center text-orange-800">{agingTotals.b61_90.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</td>
                  <td className="p-3.5 text-center text-rose-800">{agingTotals.b90plus.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</td>
                  <td className="p-3.5 text-center text-slate-700">{agingTotals.credit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* 5. VAT Report */}
      {selectedReport === 'vat_report' && (
        <div className="print-area bg-white rounded-2xl border border-slate-200 shadow-xs p-6 max-w-2xl mx-auto space-y-4">
          <div className="text-center pb-3 border-b border-slate-200">
            <h3 className="font-bold text-sm text-slate-900">إقرار ضريبة القيمة المضافة المصرية (VAT 14%)</h3>
            <p className="text-xs text-slate-500">
              محسوب من قيود الدفاتر الفعلية على 1113 (مدخلات) و2103 (مخرجات) —
              {allPeriods ? ' كل الفترات' : ` الفترة من ${fromDate} إلى ${toDate}`}
            </p>
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

            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-[11px] text-slate-600 font-mono">
              <div>عدد قيود ضريبة المدخلات (1113) في الفترة: <span className="font-bold">{inputVatDebits.length}</span></div>
              <div>عدد قيود ضريبة المخرجات (2103) في الفترة: <span className="font-bold">{outputVatCredits.length}</span></div>
              <div>فواتير التصدير (صفرية الضريبة) لا تُنشئ قيود على 2103 بالتصميم.</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
