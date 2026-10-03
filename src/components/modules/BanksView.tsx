import React, { useState, useMemo } from 'react';
import { 
  Landmark, Plus, ArrowUpRight, ArrowDownLeft, 
  DollarSign, FileText, CheckCircle2, AlertTriangle,
  Printer, Download, Calendar, Filter
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { BankAccount } from '../../types/erp';
import { AccountingEngine } from '../../services/accounting';
import { WorkflowService } from '../../services/workflows';
import { printDocument } from '../printUtils';

export const BanksView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [selectedBankId, setSelectedBankId] = useState<string>(db.bankAccounts[0]?.id || '');
  const [showAddTxModal, setShowAddTxModal] = useState(false);

  // Filters
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().split('T')[0];
  });
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [typeFilter, setTypeFilter] = useState<string>('all');

  // Form State
  const [txType, setTxType] = useState<'deposit' | 'withdrawal' | 'transfer' | 'bank_fee'>('deposit');
  const [amount, setAmount] = useState(5000);
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [targetBankId, setTargetBankId] = useState<string>('');
  const [targetAccountId, setTargetAccountId] = useState('acc-1101'); // cash or expense
  const [txDate, setTxDate] = useState(new Date().toISOString().split('T')[0]);

  const currentBank = db.bankAccounts.find(b => b.id === selectedBankId);
  const glAccount = db.accounts.find(a => a.id === currentBank?.glAccountId);
  const glBalance = glAccount?.currentBalance || 0;

  // Requirement 8: Bank Account Statement with Running Balance & Totals
  const bankStatementData = useMemo(() => {
    if (!currentBank || !currentBank.glAccountId) {
      return {
        openingBalance: 0,
        entries: [],
        totalDeposits: 0,
        totalWithdrawals: 0,
        totalBankFees: 0,
        totalTransfers: 0,
        totalDebit: 0,
        totalCredit: 0,
        closingBalance: 0,
      };
    }

    const from = fromDate ? new Date(fromDate) : new Date('2000-01-01');
    const to = toDate ? new Date(toDate) : new Date('2099-12-31');
    to.setHours(23, 59, 59, 999);

    // 1. Calculate Opening Balance from all posted journal entries before From Date
    let opening = 0;
    db.journalEntries
      .filter(jv => jv.isPosted && !jv.isReversed && new Date(jv.date) < from)
      .forEach(jv => {
        jv.lines
          .filter(l => l.accountId === currentBank.glAccountId)
          .forEach(line => {
            opening += (line.debit - line.credit);
          });
      });

    // 2. Collect in-range transactions from journal entries touching this bank's GL account
    interface BankRow {
      id: string;
      date: string;
      reference: string;
      entryNumber: string;
      type: 'deposit' | 'withdrawal' | 'transfer' | 'bank_fee';
      typeLabelAr: string;
      description: string;
      debit: number; // إيداعات
      credit: number; // مسحوبات ومصاريف
      runningBalance: number;
    }

    const rawRows: Array<Omit<BankRow, 'runningBalance'>> = [];

    db.journalEntries
      .filter(jv => jv.isPosted && !jv.isReversed)
      .forEach(jv => {
        const d = new Date(jv.date);
        if (d >= from && d <= to) {
          const bankLines = jv.lines.filter(l => l.accountId === currentBank.glAccountId);
          bankLines.forEach((line, idx) => {
            const isDebit = line.debit > 0;
            // Determine transaction category
            let bType: 'deposit' | 'withdrawal' | 'transfer' | 'bank_fee' = isDebit ? 'deposit' : 'withdrawal';
            let label = isDebit ? 'إيداع بنكي' : 'سحب بنكي';

            if (jv.lines.some(l => l.accountId === 'acc-6109')) {
              bType = 'bank_fee';
              label = 'مصاريف وعمولات بنكية';
            } else if (jv.lines.some(l => l.accountId !== currentBank.glAccountId && (l.accountId === 'acc-1102' || l.accountId === 'acc-1103'))) {
              bType = 'transfer';
              label = 'تحويل بين البنوك';
            }

            if (typeFilter === 'all' || typeFilter === bType) {
              rawRows.push({
                id: `${jv.id}-${idx}`,
                date: jv.date,
                reference: jv.reference || jv.entryNumber,
                entryNumber: jv.entryNumber,
                type: bType,
                typeLabelAr: label,
                description: line.description || jv.description,
                debit: line.debit,
                credit: line.credit,
              });
            }
          });
        }
      });

    // Sort chronologically
    rawRows.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let running = opening;
    let totalDeposits = 0;
    let totalWithdrawals = 0;
    let totalBankFees = 0;
    let totalTransfers = 0;
    let totalDebit = 0;
    let totalCredit = 0;

    const entries: BankRow[] = rawRows.map(row => {
      totalDebit += row.debit;
      totalCredit += row.credit;

      if (row.type === 'deposit') totalDeposits += row.debit;
      if (row.type === 'withdrawal') totalWithdrawals += row.credit;
      if (row.type === 'bank_fee') totalBankFees += row.credit;
      if (row.type === 'transfer') totalTransfers += (row.debit > 0 ? row.debit : row.credit);

      running = running + row.debit - row.credit;
      return {
        ...row,
        runningBalance: running,
      };
    });

    const closingBalance = running;

    return {
      openingBalance: opening,
      entries,
      totalDeposits,
      totalWithdrawals,
      totalBankFees,
      totalTransfers,
      totalDebit,
      totalCredit,
      closingBalance,
    };
  }, [currentBank, fromDate, toDate, typeFilter, db.journalEntries]);

  // Requirement 13: Reconciliation Check with GL
  const reconciliation = useMemo(() => {
    const diff = Math.abs(bankStatementData.closingBalance - glBalance);
    const isMatched = diff < 0.05;
    return {
      statementBalance: bankStatementData.closingBalance,
      glBalance,
      diff,
      isMatched,
    };
  }, [bankStatementData.closingBalance, glBalance]);

  const handleSaveTransaction = () => {
    if (!currentBank) return;
    if (amount <= 0) {
      alert('المبلغ يجب أن يكون أكبر من صفر');
      return;
    }
    if (!description.trim()) {
      alert('يرجى إدخال بيان الحركة');
      return;
    }

    const todayStr = txDate || new Date().toISOString().split('T')[0];
    const ref = reference || `BNK-${Date.now().toString().slice(-6)}`;

    // Bank fee posts against the mapped bank-charges account; deposits/withdrawals
    // post against the user-selected counterpart account.
    const counterAcc = txType === 'bank_fee'
      ? AccountingEngine.getMappedAccountId('bank_fees', 'acc-6109')
      : targetAccountId;

    if (!counterAcc) {
      alert('يرجى اختيار الحساب المحاسبي المقابل');
      return;
    }

    const res = WorkflowService.recordBankTransaction({
      bankAccountId: currentBank.id,
      type: txType,
      amount: Number(amount),
      date: todayStr,
      reference: ref,
      description: description.trim(),
      counterGlAccountId: counterAcc,
      targetBankAccountId: txType === 'transfer' ? targetBankId : undefined,
    });

    if (!res.success) {
      alert(res.error || 'خطأ في تسجيل الحركة المصرفية');
      return;
    }

    setShowAddTxModal(false);
    setDescription('');
    setReference('');
    setAmount(5000);
  };

  const handleExportCSV = () => {
    if (!currentBank) return;
    const headers = ['التاريخ', 'المرجع', 'نوع الحركة', 'البيان', 'مدين (إيداعات)', 'دائن (مسحوبات)', 'الرصيد'];
    const rows = bankStatementData.entries.map(e => [
      e.date,
      e.reference,
      e.typeLabelAr,
      `"${e.description.replace(/"/g, '""')}"`,
      e.debit.toFixed(2),
      e.credit.toFixed(2),
      e.runningBalance.toFixed(2),
    ]);

    const csvContent = '\uFEFF' + [
      `"كشف حساب البنك: ${currentBank.bankName} (${currentBank.accountNumber})"`,
      `"الفترة من: ${fromDate} إلى: ${toDate}"`,
      `"الرصيد الافتتاحي: ${bankStatementData.openingBalance.toFixed(2)} ${currentBank.currency}"`,
      headers.join(','),
      ...rows.map(r => r.join(',')),
      `"الإجمالي","","","إجمالي الحركات",${bankStatementData.totalDebit.toFixed(2)},${bankStatementData.totalCredit.toFixed(2)},${bankStatementData.closingBalance.toFixed(2)}`,
      `"الرصيد الختامي: ${bankStatementData.closingBalance.toFixed(2)} ${currentBank.currency}"`,
    ].join('\r\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `كشف_حساب_البنك_${currentBank.bankName}_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6 text-right">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-black text-slate-900">إدارة الحسابات البنكية وكشوف الحساب (Bank Statements)</h2>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-900 text-white font-bold">
              الحسابات المصرفية
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            كشف حساب مصرفي تفصيلي بالرصيد المستمر، الإيداعات، المسحوبات، العمولات، التحويلات، ومطابقة الأستاذ العام
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={printDocument}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs border border-slate-300 transition cursor-pointer"
            title="طباعة كشف الحساب البنكي"
          >
            <Printer className="w-4 h-4" />
            <span className="hidden sm:inline">طباعة</span>
          </button>
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-800 font-bold text-xs border border-emerald-300 transition cursor-pointer"
            title="تصدير إكسل / CSV"
          >
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">تصدير Excel</span>
          </button>
          <button
            onClick={() => setShowAddTxModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>إجراء حركة مصرفية</span>
          </button>
        </div>
      </div>

      {/* Bank Account Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {db.bankAccounts.map(b => {
          const acc = db.accounts.find(a => a.id === b.glAccountId);
          const isSelected = b.id === selectedBankId;
          return (
            <div
              key={b.id}
              onClick={() => setSelectedBankId(b.id)}
              className={`p-5 rounded-2xl border cursor-pointer transition-all ${
                isSelected 
                  ? 'bg-white border-amber-500 shadow-md ring-2 ring-amber-500/20' 
                  : 'bg-white/80 border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-indigo-600">
                    <Landmark className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-bold text-sm text-slate-900">{b.bankName}</h3>
                    <span className="text-[11px] font-mono text-slate-400">{b.accountNumber}</span>
                  </div>
                </div>
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-800 font-bold border border-slate-200">
                  {b.currency}
                </span>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
                <span className="text-xs text-slate-500">الرصيد الدفتري الحالي:</span>
                <span className="text-lg font-black font-mono text-slate-900">
                  {(acc?.currentBalance || 0).toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {b.currency}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Reconciliation Alert Banner (Requirement 13) */}
      <div className="flex items-center justify-between p-3.5 rounded-2xl bg-white border border-slate-200 shadow-xs">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-bold text-slate-700">مطابقة رصيد كشف الحساب البنكي:</span>
          {reconciliation.isMatched ? (
            <span className="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold flex items-center gap-1">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>مطابق تماماً لحساب الأستاذ العام ({glAccount?.code})</span>
            </span>
          ) : (
            <span className="px-2.5 py-1 rounded-lg bg-rose-50 text-rose-800 border border-rose-300 font-bold flex items-center gap-1 animate-pulse">
              <AlertTriangle className="w-4 h-4 text-rose-600" />
              <span>يوجد فرق يحتاج إلى مراجعة ({reconciliation.diff.toFixed(2)} {currentBank?.currency})</span>
            </span>
          )}
        </div>

        <div className="text-xs font-mono font-bold text-slate-600">
          رصيد الأستاذ العام: <span className="text-slate-900 font-black">{glBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {currentBank?.currency}</span>
        </div>
      </div>

      {/* Date & Type Filters */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">من تاريخ</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono focus:bg-white focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">إلى تاريخ</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono focus:bg-white focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">نوع العملية المصرفية</label>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs focus:bg-white focus:outline-none"
          >
            <option value="all">كافة العمليات المصرفية</option>
            <option value="deposit">إيداعات نقدية وتحصيلات (مدين +)</option>
            <option value="withdrawal">مسحوبات بنكية (دائن -)</option>
            <option value="bank_fee">مصاريف وعمولات بنكية</option>
            <option value="transfer">تحويلات بين الحسابات</option>
          </select>
        </div>
      </div>

      {/* KPI Cards: Opening, Deposits, Withdrawals, Bank Fees, Transfers, Closing (Requirement 8) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {/* Opening Balance */}
        <div className="p-3.5 rounded-2xl bg-white border border-slate-200 shadow-xs">
          <span className="text-[10px] text-slate-500 font-medium">الرصيد الافتتاحي</span>
          <div className="text-base font-black text-slate-900 font-mono mt-1">
            {bankStatementData.openingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">قبل {fromDate}</div>
        </div>

        {/* Deposits */}
        <div className="p-3.5 rounded-2xl bg-white border border-slate-200 shadow-xs">
          <span className="text-[10px] text-slate-500 font-medium">إيداعات (Deposits)</span>
          <div className="text-base font-black text-emerald-700 font-mono mt-1">
            +{bankStatementData.totalDeposits.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
          </div>
          <div className="text-[10px] text-emerald-600 mt-0.5">إيداعات واردة</div>
        </div>

        {/* Withdrawals */}
        <div className="p-3.5 rounded-2xl bg-white border border-slate-200 shadow-xs">
          <span className="text-[10px] text-slate-500 font-medium">مسحوبات (Withdrawals)</span>
          <div className="text-base font-black text-rose-700 font-mono mt-1">
            -{bankStatementData.totalWithdrawals.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
          </div>
          <div className="text-[10px] text-rose-600 mt-0.5">مدفوعات ومسحوبات</div>
        </div>

        {/* Bank Fees */}
        <div className="p-3.5 rounded-2xl bg-white border border-slate-200 shadow-xs">
          <span className="text-[10px] text-slate-500 font-medium">عمولات ومصاريف</span>
          <div className="text-base font-black text-amber-700 font-mono mt-1">
            {bankStatementData.totalBankFees.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
          </div>
          <div className="text-[10px] text-amber-600 mt-0.5">رسوم بنكية</div>
        </div>

        {/* Transfers */}
        <div className="p-3.5 rounded-2xl bg-white border border-slate-200 shadow-xs">
          <span className="text-[10px] text-slate-500 font-medium">تحويلات (Transfers)</span>
          <div className="text-base font-black text-indigo-700 font-mono mt-1">
            {bankStatementData.totalTransfers.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
          </div>
          <div className="text-[10px] text-indigo-600 mt-0.5">تحويلات بينية</div>
        </div>

        {/* Closing Balance */}
        <div className="p-3.5 rounded-2xl bg-slate-900 text-white shadow-md">
          <span className="text-[10px] text-slate-300 font-medium">الرصيد الختامي</span>
          <div className="text-base font-black text-amber-400 font-mono mt-1">
            {bankStatementData.closingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">{currentBank?.currency}</div>
        </div>
      </div>

      {/* Selected Bank Ledger View */}
      {currentBank && (
        <div className="print-area bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
            <div>
              <h3 className="font-bold text-xs text-slate-900">
                كشف حساب البنك التفصيلي: {currentBank.bankName} ({glAccount?.code})
              </h3>
              <p className="text-[11px] text-slate-500">
                حساب رقم {currentBank.accountNumber} - الرصيد بعد كل معاملة مصرفية (Running Balance)
              </p>
            </div>
            <div className="text-xs font-mono font-bold text-emerald-800 bg-emerald-50 px-3 py-1 rounded-xl border border-emerald-200">
              الرصيد: {bankStatementData.closingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {currentBank.currency}
            </div>
          </div>

          <table className="w-full text-right text-xs">
            <thead className="bg-slate-100 text-slate-700 font-bold border-b border-slate-200">
              <tr>
                <th className="p-3">التاريخ</th>
                <th className="p-3">المرجع / رقم القيد</th>
                <th className="p-3">نوع الحركة</th>
                <th className="p-3">البيان والشرح</th>
                <th className="p-3 text-center">مدين (+)</th>
                <th className="p-3 text-center">دائن (-)</th>
                <th className="p-3 text-center bg-slate-200/50">الرصيد التراكمي</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {/* Opening Balance Row */}
              <tr className="bg-amber-50/40 font-bold text-slate-800">
                <td className="p-3 font-mono text-slate-500">{fromDate}</td>
                <td className="p-3 font-mono">-</td>
                <td className="p-3">
                  <span className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-800 text-[10px] font-bold">
                    رصيد أول المدة
                  </span>
                </td>
                <td className="p-3">رصيد الحساب البنكي المنقول قبل تاريخ {fromDate}</td>
                <td className="p-3 text-center font-mono">-</td>
                <td className="p-3 text-center font-mono">-</td>
                <td className="p-3 text-center font-mono font-black text-slate-900 bg-amber-50/80">
                  {bankStatementData.openingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                </td>
              </tr>

              {/* Entries */}
              {bankStatementData.entries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-400">
                    لا توجد حركات مصرفية مسجلة على هذا الحساب خلال الفترة المحددة
                  </td>
                </tr>
              ) : (
                bankStatementData.entries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-slate-50 transition">
                    <td className="p-3 font-mono text-slate-600">{entry.date}</td>
                    <td className="p-3 font-mono font-bold text-slate-900">{entry.reference}</td>
                    <td className="p-3 font-semibold">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                        entry.type === 'deposit' 
                          ? 'bg-emerald-100 text-emerald-800' 
                          : entry.type === 'bank_fee' 
                          ? 'bg-amber-100 text-amber-800'
                          : entry.type === 'transfer'
                          ? 'bg-indigo-100 text-indigo-800'
                          : 'bg-rose-100 text-rose-800'
                      }`}>
                        {entry.typeLabelAr}
                      </span>
                    </td>
                    <td className="p-3 text-slate-700">{entry.description}</td>
                    <td className="p-3 text-center font-mono font-bold text-emerald-700">
                      {entry.debit > 0 ? entry.debit.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) : '-'}
                    </td>
                    <td className="p-3 text-center font-mono font-bold text-rose-700">
                      {entry.credit > 0 ? entry.credit.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) : '-'}
                    </td>
                    <td className="p-3 text-center font-mono font-black text-slate-900 bg-slate-50">
                      {entry.runningBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))
              )}

              {/* Summary Totals Row */}
              <tr className="bg-slate-100 border-t-2 border-slate-300 font-bold text-slate-900">
                <td colSpan={4} className="p-3 text-right">
                  إجمالي حركات الفترة والرصيد الختامي:
                </td>
                <td className="p-3 text-center font-mono font-black text-emerald-800">
                  {bankStatementData.totalDebit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                </td>
                <td className="p-3 text-center font-mono font-black text-rose-800">
                  {bankStatementData.totalCredit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                </td>
                <td className="p-3 text-center font-mono font-black text-slate-900 bg-slate-200">
                  {bankStatementData.closingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {currentBank.currency}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* New Banking Transaction Modal */}
      {showAddTxModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-md p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">تسجيل حركة مصرفية جديدة</h3>
              <button onClick={() => setShowAddTxModal(false)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>

            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
              <div className="text-xs text-slate-500">الحساب البنكي المحدد:</div>
              <div className="font-bold text-xs text-slate-900 mt-0.5">{currentBank?.bankName} ({currentBank?.currency})</div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">نوع المعاملة المصرفية</label>
                <select
                  value={txType}
                  onChange={(e) => setTxType(e.target.value as any)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold"
                >
                  <option value="deposit">إيداع بنكي (+ زيادة الرصيد)</option>
                  <option value="withdrawal">سحب بنكي (- نقص الرصيد)</option>
                  <option value="bank_fee">مصاريف وعمولات بنكية (-)</option>
                  <option value="transfer">تحويل إلى حساب بنكي آخر</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ المعاملة</label>
                <input
                  type="date"
                  value={txDate}
                  onChange={(e) => setTxDate(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">المبلغ ({currentBank?.currency})</label>
                <input
                  type="number"
                  min="1"
                  value={amount}
                  onChange={(e) => setAmount(Number(e.target.value))}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono font-bold"
                />
              </div>

              {txType === 'transfer' && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">الحساب المحول إليه</label>
                  <select
                    value={targetBankId}
                    onChange={(e) => setTargetBankId(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold"
                  >
                    <option value="">-- اختر البنك المستلم --</option>
                    {db.bankAccounts.filter(b => b.id !== selectedBankId).map(b => (
                      <option key={b.id} value={b.id}>{b.bankName} ({b.currency})</option>
                    ))}
                  </select>
                </div>
              )}

              {(txType === 'deposit' || txType === 'withdrawal') && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">الحساب المقابل</label>
                  <select
                    value={targetAccountId}
                    onChange={(e) => setTargetAccountId(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    {db.accounts.filter(a => !a.isHeader && a.id !== currentBank?.glAccountId).map(a => (
                      <option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">رقم المرجع / رقم التحويل</label>
                <input
                  type="text"
                  placeholder="مثال: REF-TRF-001"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">البيان والشرح</label>
                <input
                  type="text"
                  placeholder="شرح سبب المعاملة المصرفية"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setShowAddTxModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs"
              >
                إلغاء
              </button>
              <button
                onClick={handleSaveTransaction}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md"
              >
                ترحيل الحركة بالدفاتر
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
