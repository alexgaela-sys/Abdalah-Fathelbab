import React, { useState, useMemo } from 'react';
import { 
  Wallet, Plus, ArrowDownLeft, ArrowUpRight, 
  DollarSign, Calendar, FileText, Printer, Download,
  CheckCircle2, AlertTriangle, Filter
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { WorkflowService } from '../../services/workflows';

export const TreasuryView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [showAddModal, setShowAddModal] = useState(false);

  // Filters
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().split('T')[0];
  });
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [typeFilter, setTypeFilter] = useState<string>('all');

  // Form State
  const [type, setType] = useState<'cash_receipt' | 'cash_payment' | 'advance_custody'>('cash_receipt');
  const [amount, setAmount] = useState(1000);
  const [partyName, setPartyName] = useState('');
  const [description, setDescription] = useState('');
  const [targetAccId, setTargetAccId] = useState('acc-6101'); // default expenses or other
  const [txDate, setTxDate] = useState(new Date().toISOString().split('T')[0]);

  // GL Treasury account
  const treasuryAcc = db.accounts.find(a => a.id === 'acc-1101');
  const glCashBalance = treasuryAcc?.currentBalance || 0;

  // Requirement 7: Treasury Ledger with Running Balance
  const treasuryLedgerData = useMemo(() => {
    const from = fromDate ? new Date(fromDate) : new Date('2000-01-01');
    const to = toDate ? new Date(toDate) : new Date('2099-12-31');
    to.setHours(23, 59, 59, 999);

    // Initial opening balance of treasury
    let opening = 0;

    // 1. Transactions before From Date
    db.treasuryTransactions
      .filter(tx => new Date(tx.date) < from)
      .forEach(tx => {
        if (tx.type === 'cash_receipt') {
          opening += tx.amount; // Debit treasury
        } else {
          opening -= tx.amount; // Credit treasury
        }
      });

    // Also include customer receipts paid in cash before From Date if recorded in payments table
    db.payments
      .filter(p => p.paymentMethod === 'cash' && new Date(p.date) < from)
      .forEach(p => {
        // If not already in treasuryTransactions
        const existsInTreasury = db.treasuryTransactions.some(t => t.receiptNumber === p.paymentNumber);
        if (!existsInTreasury) {
          if (p.paymentType === 'customer_receipt') {
            opening += p.amountEGP;
          } else if (p.paymentType === 'supplier_payment') {
            opening -= p.amountEGP;
          }
        }
      });

    // 2. Transactions within date range
    interface TreasuryRow {
      id: string;
      date: string;
      documentNumber: string;
      transactionType: string;
      transactionTypeLabelAr: string;
      isDebit: boolean;
      description: string;
      partyName: string;
      debit: number; // مدين - مقبوضات
      credit: number; // دائن - مدفوعات
      postingSequence: string; // رقم القيد المحاسبي (ترتيب الترحيل الفعلي)
      runningBalance: number;
    }

    const rawRows: Array<Omit<TreasuryRow, 'runningBalance'>> = [];

    // F10: deterministic ordering. Map journal entry id -> entry number so that
    // same-day rows fall back to the actual GL posting sequence, never to array order.
    const postingSeqByJournalId = new Map<string, string>();
    db.journalEntries.forEach(jv => {
      if (jv.isPosted && !jv.isReversed) postingSeqByJournalId.set(jv.id, jv.entryNumber);
    });

    // From treasuryTransactions table
    db.treasuryTransactions.forEach(tx => {
      const d = new Date(tx.date);
      if (d >= from && d <= to) {
        if (typeFilter === 'all' || typeFilter === tx.type) {
          const isReceipt = tx.type === 'cash_receipt';
          rawRows.push({
            id: tx.id,
            date: tx.date,
            documentNumber: tx.receiptNumber,
            transactionType: tx.type,
            transactionTypeLabelAr: isReceipt ? 'سند قبض وارد' : tx.type === 'advance_custody' ? 'سلفة / عهدة مؤقتة' : 'سند صرف نقدية',
            isDebit: isReceipt,
            description: tx.description,
            partyName: tx.partyName || '-',
            debit: isReceipt ? tx.amount : 0,
            credit: !isReceipt ? tx.amount : 0,
            postingSequence: (tx.journalEntryId && postingSeqByJournalId.get(tx.journalEntryId)) || '',
          });
        }
      }
    });

    // Also check cash payments from payments table not yet synced
    db.payments
      .filter(p => p.paymentMethod === 'cash')
      .forEach(p => {
        const d = new Date(p.date);
        if (d >= from && d <= to) {
          const alreadyListed = rawRows.some(r => r.documentNumber === p.paymentNumber);
          if (!alreadyListed) {
            const isReceipt = p.paymentType === 'customer_receipt';
            if (typeFilter === 'all' || (isReceipt && typeFilter === 'cash_receipt') || (!isReceipt && typeFilter === 'cash_payment')) {
              rawRows.push({
                id: p.id,
                date: p.date,
                documentNumber: p.paymentNumber,
                transactionType: isReceipt ? 'cash_receipt' : 'cash_payment',
                transactionTypeLabelAr: isReceipt ? 'تحصيل عميل (نقدي)' : 'سداد مورد (نقدي)',
                isDebit: isReceipt,
                description: `${p.reference || ''}`,
                partyName: p.partyId,
                debit: isReceipt ? p.amountEGP : 0,
                credit: !isReceipt ? p.amountEGP : 0,
                postingSequence: (p.journalEntryId && postingSeqByJournalId.get(p.journalEntryId)) || '',
              });
            }
          }
        }
      });

    // F10: deterministic chronological ordering.
    // date -> GL posting sequence -> document number -> stable generated id.
    // No accounting value is touched here; only the row presentation order.
    rawRows.sort((a, b) => {
      const byDate = new Date(a.date).getTime() - new Date(b.date).getTime();
      if (byDate !== 0) return byDate;
      const byPosting = (a.postingSequence || '').localeCompare(b.postingSequence || '', 'en', { numeric: true });
      if (byPosting !== 0) return byPosting;
      const byDoc = (a.documentNumber || '').localeCompare(b.documentNumber || '', 'en', { numeric: true });
      if (byDoc !== 0) return byDoc;
      return a.id.localeCompare(b.id);
    });

    let running = opening;
    let totalDebit = 0;
    let totalCredit = 0;

    const entries: TreasuryRow[] = rawRows.map(row => {
      totalDebit += row.debit;
      totalCredit += row.credit;
      running = running + row.debit - row.credit;
      return {
        ...row,
        runningBalance: running,
      };
    });

    const closingBalance = opening + totalDebit - totalCredit;

    return {
      openingBalance: opening,
      entries,
      totalDebit,
      totalCredit,
      closingBalance,
    };
  }, [fromDate, toDate, typeFilter, db]);

  // Requirement 13: Reconciliation Check with GL acc-1101
  const reconciliation = useMemo(() => {
    // Current total calculated balance of treasury ledger
    const ledgerBalance = treasuryLedgerData.closingBalance;
    const diff = Math.abs(ledgerBalance - glCashBalance);
    const isMatched = diff < 0.05;

    return {
      ledgerBalance,
      glCashBalance,
      diff,
      isMatched,
    };
  }, [treasuryLedgerData, glCashBalance]);

  const handleSaveTransaction = () => {
    if (amount <= 0) {
      alert('المبلغ يجب أن يكون أكبر من صفر');
      return;
    }
    if (!description.trim()) {
      alert('يرجى إدخال بيان الحركة');
      return;
    }
    if (!targetAccId) {
      alert('يرجى اختيار الحساب المحاسبي المقابل');
      return;
    }

    const todayStr = txDate || new Date().toISOString().split('T')[0];

    const res = WorkflowService.recordTreasuryTransaction({
      type,
      amount: Number(amount),
      date: todayStr,
      description: description.trim(),
      glAccountId: targetAccId,
      partyName: partyName.trim() || undefined,
    });

    if (!res.success) {
      alert(res.error || 'خطأ في تسجيل حركة الخزينة');
      return;
    }

    setShowAddModal(false);
    setDescription('');
    setPartyName('');
    setAmount(1000);
  };

  const handleExportCSV = () => {
    const headers = ['التاريخ', 'رقم السند', 'نوع الحركة', 'الطرف', 'البيان', 'مدين (مقبوضات)', 'دائن (مدفوعات)', 'الرصيد'];
    const rows = treasuryLedgerData.entries.map(e => [
      e.date,
      e.documentNumber,
      e.transactionTypeLabelAr,
      `"${e.partyName.replace(/"/g, '""')}"`,
      `"${e.description.replace(/"/g, '""')}"`,
      e.debit.toFixed(2),
      e.credit.toFixed(2),
      e.runningBalance.toFixed(2),
    ]);

    const csvContent = '\uFEFF' + [
      `"دفتر أستاذ الخزينة الرئيسية النقدية (حـ/ 1101)"`,
      `"الفترة من: ${fromDate} إلى: ${toDate}"`,
      `"الرصيد الافتتاحي: ${treasuryLedgerData.openingBalance.toFixed(2)} ج.م"`,
      headers.join(','),
      ...rows.map(r => r.join(',')),
      `"الإجمالي","","","إجمالي الحركات",${treasuryLedgerData.totalDebit.toFixed(2)},${treasuryLedgerData.totalCredit.toFixed(2)},${treasuryLedgerData.closingBalance.toFixed(2)}`,
      `"الرصيد الختامي للخزينة: ${treasuryLedgerData.closingBalance.toFixed(2)} ج.م"`,
    ].join('\r\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `كشف_حساب_الخزينة_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6 text-right">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-black text-slate-900">دفتر أستاذ الخزينة النقدية (Treasury Ledger)</h2>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-900 text-white font-bold">
              حساب الخزينة (GL: 1101)
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            سجل المقبوضات والمدفوعات النقدية بالرصيد التراكمي المستمر، والربط الفوري بالقيود المزدوجة والمطابقة المحاسبية
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs border border-slate-300 transition cursor-pointer"
            title="طباعة دفتر الخزينة"
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
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>حركة قبض / صرف خزينة</span>
          </button>
        </div>
      </div>

      {/* Reconciliation Alert Banner (Requirement 13) */}
      <div className="flex items-center justify-between p-3.5 rounded-2xl bg-white border border-slate-200 shadow-xs">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-bold text-slate-700">مطابقة رصيد الخزينة الدفتري:</span>
          {reconciliation.isMatched ? (
            <span className="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold flex items-center gap-1">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>مطابق تماماً لحساب الأستاذ العام (GL 1101)</span>
            </span>
          ) : (
            <span className="px-2.5 py-1 rounded-lg bg-rose-50 text-rose-800 border border-rose-300 font-bold flex items-center gap-1 animate-pulse">
              <AlertTriangle className="w-4 h-4 text-rose-600" />
              <span>يوجد فرق يحتاج إلى مراجعة ({reconciliation.diff.toFixed(2)} ج.م)</span>
            </span>
          )}
        </div>

        <div className="text-xs font-mono font-bold text-slate-600">
          رصيد الحساب العام (1101): <span className="text-slate-900 font-black">{glCashBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م</span>
        </div>
      </div>

      {/* Filter Bar */}
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
          <label className="block text-xs font-bold text-slate-700 mb-1">نوع الحركة</label>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs focus:bg-white focus:outline-none"
          >
            <option value="all">كافة الحركات النقدية</option>
            <option value="cash_receipt">سندات القبض الواردة (+ مدين)</option>
            <option value="cash_payment">سندات الصرف الصادرة (- دائن)</option>
            <option value="advance_custody">السلف والعهد المؤقتة</option>
          </select>
        </div>
      </div>

      {/* KPI Cards: Opening, Receipts, Payments, Closing (Requirement 7) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
        <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs">
          <span className="text-[11px] text-slate-500 font-medium">الرصيد الافتتاحي (Opening)</span>
          <div className="text-lg font-black text-slate-900 font-mono mt-1">
            {treasuryLedgerData.openingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
            <span className="text-xs font-normal text-slate-500 mr-1">ج.م</span>
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">قبل {fromDate}</div>
        </div>

        <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs">
          <span className="text-[11px] text-slate-500 font-medium">إجمالي المقبوضات (مدين +)</span>
          <div className="text-lg font-black text-emerald-700 font-mono mt-1">
            {treasuryLedgerData.totalDebit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
            <span className="text-xs font-normal text-slate-500 mr-1">ج.م</span>
          </div>
          <div className="text-[10px] text-emerald-600 mt-0.5">واردات الخزينة بالفترة</div>
        </div>

        <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs">
          <span className="text-[11px] text-slate-500 font-medium">إجمالي المدفوعات (دائن -)</span>
          <div className="text-lg font-black text-rose-700 font-mono mt-1">
            {treasuryLedgerData.totalCredit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
            <span className="text-xs font-normal text-slate-500 mr-1">ج.م</span>
          </div>
          <div className="text-[10px] text-rose-600 mt-0.5">منصرفات الخزينة بالفترة</div>
        </div>

        <div className="p-4 rounded-2xl bg-slate-900 text-white shadow-md">
          <span className="text-[11px] text-slate-300 font-medium">الرصيد الحالي (Current Balance)</span>
          <div className="text-lg font-black text-amber-400 font-mono mt-1">
            {treasuryLedgerData.closingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
            <span className="text-xs font-normal text-slate-300 mr-1">ج.م</span>
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">الرصيد الدفتري حتى {toDate}</div>
        </div>
      </div>

      {/* Treasury Ledger Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div>
            <h3 className="font-bold text-xs text-slate-900">سجل حركات الخزينة النقدية (Running Balance)</h3>
            <span className="text-[11px] text-slate-500">
              الرصيد التراكمي = الرصيد الافتتاحي + إجمالي المقبوضات (مدين) - إجمالي المدفوعات (دائن)
            </span>
          </div>
          <div className="text-xs font-mono font-bold text-slate-700 bg-white px-3 py-1 rounded-xl border border-slate-200">
            الفترة: {fromDate} إلى {toDate}
          </div>
        </div>

        <table className="w-full text-right text-xs">
          <thead className="bg-slate-100 border-b border-slate-200 text-slate-700 font-bold">
            <tr>
              <th className="p-3">التاريخ</th>
              <th className="p-3">رقم المستند</th>
              <th className="p-3">نوع الحركة</th>
              <th className="p-3">المستلم / المودع</th>
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
              <td className="p-3">-</td>
              <td className="p-3">رصيد الخزينة المنقول قبل تاريخ {fromDate}</td>
              <td className="p-3 text-center font-mono">-</td>
              <td className="p-3 text-center font-mono">-</td>
              <td className="p-3 text-center font-mono font-black text-slate-900 bg-amber-50/80">
                {treasuryLedgerData.openingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
              </td>
            </tr>

            {/* Entries */}
            {treasuryLedgerData.entries.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-10 text-center text-slate-400">
                  لا توجد حركات نقدية بالخزينة خلال هذه الفترة المحددة
                </td>
              </tr>
            ) : (
              treasuryLedgerData.entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-slate-50 transition">
                  <td className="p-3 font-mono text-slate-600">{entry.date}</td>
                  <td className="p-3 font-mono font-bold text-slate-900">{entry.documentNumber}</td>
                  <td className="p-3 font-semibold">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                      entry.isDebit ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                    }`}>
                      {entry.transactionTypeLabelAr}
                    </span>
                  </td>
                  <td className="p-3 font-bold text-slate-800">{entry.partyName}</td>
                  <td className="p-3 text-slate-600">{entry.description}</td>
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
              <td colSpan={5} className="p-3 text-right">
                إجمالي المقبوضات والمدفوعات والرصيد الحالي:
              </td>
              <td className="p-3 text-center font-mono font-black text-emerald-800">
                {treasuryLedgerData.totalDebit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
              </td>
              <td className="p-3 text-center font-mono font-black text-rose-800">
                {treasuryLedgerData.totalCredit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
              </td>
              <td className="p-3 text-center font-mono font-black text-slate-900 bg-slate-200">
                {treasuryLedgerData.closingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-md p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">تسجيل حركة نقدية بالخزينة</h3>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">نوع العملية</label>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value as any)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold"
                >
                  <option value="cash_receipt">سند قبض نقدي (مدين الخزينة +)</option>
                  <option value="cash_payment">سند صرف نقدي (دائن الخزينة -)</option>
                  <option value="advance_custody">عهدة مؤقتة / سلفة موظف (-)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ الحركة</label>
                <input
                  type="date"
                  value={txDate}
                  onChange={(e) => setTxDate(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">المبلغ (ج.م)</label>
                <input
                  type="number"
                  min="1"
                  value={amount}
                  onChange={(e) => setAmount(Number(e.target.value))}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono font-bold"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">الطرف المستلم / المودع</label>
                <input
                  type="text"
                  placeholder="اسم الشخص أو الموظف أو الجهة"
                  value={partyName}
                  onChange={(e) => setPartyName(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">الحساب المقابل بدليل الحسابات</label>
                <select
                  value={targetAccId}
                  onChange={(e) => setTargetAccId(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  {db.accounts.filter(a => !a.isHeader && a.id !== 'acc-1101').map(a => (
                    <option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">البيان والشرح</label>
                <input
                  type="text"
                  placeholder="بيان سبب الصرف أو التوريد"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
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
                onClick={handleSaveTransaction}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md"
              >
                حفظ وترحيل القيد المحاسبي
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
