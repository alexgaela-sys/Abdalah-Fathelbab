import React, { useState, useMemo } from 'react';
import { 
  BookOpen, Plus, RotateCcw, AlertTriangle, 
  CheckCircle2, Lock, Unlock, Search, Layers, FileText,
  Printer, Download, Calendar, Filter
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { AccountingEngine } from '../../services/accounting';
import { JournalEntry, Account, AccountingPeriod, isDebitNatureCategory } from '../../types/erp';

export const AccountingView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [activeTab, setActiveTab] = useState<'journals' | 'ledger' | 'chart' | 'periods'>('journals');
  const [showAddJvModal, setShowAddJvModal] = useState(false);
  const [selectedJvDetails, setSelectedJvDetails] = useState<JournalEntry | null>(null);

  // General Ledger Filters (Requirement 6)
  const nonHeaderAccounts = useMemo(() => db.accounts.filter(a => !a.isHeader), [db.accounts]);
  const [ledgerAccountId, setLedgerAccountId] = useState<string>(() => nonHeaderAccounts[0]?.id || 'acc-1101');
  const [ledgerFromDate, setLedgerFromDate] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().split('T')[0];
  });
  const [ledgerToDate, setLedgerToDate] = useState(() => new Date().toISOString().split('T')[0]);

  // Manual Journal Entry Form State
  const [jvDate, setJvDate] = useState(new Date().toISOString().split('T')[0]);
  const [jvRef, setJvRef] = useState('');
  const [jvDesc, setJvDesc] = useState('');
  const [lines, setLines] = useState<Array<{
    accountId: string;
    debit: number;
    credit: number;
    description: string;
  }>>([
    { accountId: 'acc-1101', debit: 1000, credit: 0, description: '' },
    { accountId: 'acc-4101', debit: 0, credit: 1000, description: '' },
  ]);

  const [formError, setFormError] = useState<string | null>(null);

  // Reversal state
  const handleReverseJv = (jvId: string) => {
    const reason = prompt('يرجى كتابة سبب إلغاء وعكس القيد المحاسبي:');
    if (!reason) return;

    const res = AccountingEngine.reverseJournal(jvId, reason, 'usr-admin', 'رئيس الحسابات');
    if (!res.success) {
      alert(res.error || 'فشل إجراء القيد العكسي');
      return;
    }
    alert('تم إنشاء القيد العكسي وإلغاء القيد الأصلي وتعديل الأرصدة بنجاح.');
  };

  const addLine = () => {
    setLines([...lines, { accountId: 'acc-1101', debit: 0, credit: 0, description: '' }]);
  };

  const removeLine = (idx: number) => {
    setLines(lines.filter((_, i) => i !== idx));
  };

  const updateLine = (idx: number, field: string, val: any) => {
    const updated = [...lines];
    updated[idx] = { ...updated[idx], [field]: val };
    setLines(updated);
  };

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const diff = Math.abs(totalDebit - totalCredit);
  const isBalanced = diff < 0.01 && totalDebit > 0;

  const handleSaveJv = () => {
    setFormError(null);
    const submittableLines = lines.map(l => {
      const acc = db.accounts.find(a => a.id === l.accountId);
      return {
        id: '',
        journalEntryId: '',
        accountId: l.accountId,
        accountCode: acc?.code || '',
        accountNameAr: acc?.nameAr || '',
        debit: Number(l.debit) || 0,
        credit: Number(l.credit) || 0,
        currency: 'EGP' as const,
        originalAmount: (Number(l.debit) || 0) + (Number(l.credit) || 0),
        exchangeRate: 1,
        description: l.description || jvDesc,
      };
    });

    const res = AccountingEngine.postJournal({
      date: jvDate,
      reference: jvRef,
      description: jvDesc,
      sourceDocumentType: 'manual_journal',
      lines: submittableLines,
    }, 'usr-admin', 'رئيس الحسابات');

    if (!res.success) {
      setFormError(res.error || 'حدث خطأ في ترحيل القيد');
      return;
    }

    setShowAddJvModal(false);
  };

  const handleTogglePeriod = (periodId: string) => {
    // F15: period close/open goes through the guarded AccountingEngine API
    // (AuthorizationService 'accounting:cancel'), never a direct UI mutation.
    const period = db.accountingPeriods.find(x => x.id === periodId);
    if (!period) return;
    const res = AccountingEngine.setPeriodClosed(periodId, !period.isClosed, 'usr-admin', 'رئيس الحسابات');
    if (!res.success) {
      alert(res.error || 'تعذر تغيير حالة الفترة المالية');
    }
  };

  // Requirement 6: General Ledger Computation from actual posted journal entries & lines
  const selectedLedgerAccount = db.accounts.find(a => a.id === ledgerAccountId);

  const ledgerData = useMemo(() => {
    if (!selectedLedgerAccount) {
      return {
        openingBalance: 0,
        entries: [],
        totalDebit: 0,
        totalCredit: 0,
        closingBalance: 0,
        isDebitNormal: true,
      };
    }

    const isDebitNormal = isDebitNatureCategory(selectedLedgerAccount.category);
    const fromDate = ledgerFromDate ? new Date(ledgerFromDate) : new Date('2000-01-01');
    const toDate = ledgerToDate ? new Date(ledgerToDate) : new Date('2099-12-31');
    toDate.setHours(23, 59, 59, 999);

    // 1. Calculate Opening Balance from all posted journal entries before From Date
    let opening = 0;
    db.journalEntries
      .filter(jv => jv.isPosted && !jv.isReversed && new Date(jv.date) < fromDate)
      .forEach(jv => {
        jv.lines
          .filter(l => l.accountId === selectedLedgerAccount.id)
          .forEach(line => {
            if (isDebitNormal) {
              opening += (line.debit - line.credit);
            } else {
              opening += (line.credit - line.debit);
            }
          });
      });

    // 2. Collect transactions within date range
    interface LedgerRow {
      id: string;
      date: string;
      entryNumber: string;
      sourceDocument: string;
      description: string;
      debit: number;
      credit: number;
      runningBalance: number;
    }

    const rawRows: Array<Omit<LedgerRow, 'runningBalance'>> = [];

    db.journalEntries
      .filter(jv => jv.isPosted && !jv.isReversed)
      .forEach(jv => {
        const d = new Date(jv.date);
        if (d >= fromDate && d <= toDate) {
          jv.lines
            .filter(l => l.accountId === selectedLedgerAccount.id)
            .forEach((line, idx) => {
              rawRows.push({
                id: `${jv.id}-${idx}`,
                date: jv.date,
                entryNumber: jv.entryNumber,
                sourceDocument: jv.reference || jv.sourceDocumentType,
                description: line.description || jv.description,
                debit: line.debit,
                credit: line.credit,
              });
            });
        }
      });

    // Sort chronologically
    rawRows.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let running = opening;
    let totalDebit = 0;
    let totalCredit = 0;

    const entries: LedgerRow[] = rawRows.map(row => {
      totalDebit += row.debit;
      totalCredit += row.credit;
      if (isDebitNormal) {
        running = running + row.debit - row.credit;
      } else {
        running = running + row.credit - row.debit;
      }
      return {
        ...row,
        runningBalance: running,
      };
    });

    const closingBalance = running;

    return {
      openingBalance: opening,
      entries,
      totalDebit,
      totalCredit,
      closingBalance,
      isDebitNormal,
    };
  }, [selectedLedgerAccount, ledgerFromDate, ledgerToDate, db.journalEntries]);

  // Export General Ledger to CSV
  const handleExportLedgerCSV = () => {
    if (!selectedLedgerAccount) return;
    const headers = ['التاريخ', 'رقم القيد', 'المستند المصدر', 'البيان والشرح', 'مدين', 'دائن', 'الرصيد'];
    const rows = ledgerData.entries.map(e => [
      e.date,
      e.entryNumber,
      `"${(e.sourceDocument || '').replace(/"/g, '""')}"`,
      `"${e.description.replace(/"/g, '""')}"`,
      e.debit.toFixed(2),
      e.credit.toFixed(2),
      e.runningBalance.toFixed(2),
    ]);

    const csvContent = '\uFEFF' + [
      `"كشف حساب الأستاذ العام: ${selectedLedgerAccount.nameAr} (${selectedLedgerAccount.code})"`,
      `"الفترة من: ${ledgerFromDate} إلى: ${ledgerToDate}"`,
      `"الرصيد الافتتاحي: ${ledgerData.openingBalance.toFixed(2)} ج.م"`,
      headers.join(','),
      ...rows.map(r => r.join(',')),
      `"الإجمالي","","","إجمالي الحركات",${ledgerData.totalDebit.toFixed(2)},${ledgerData.totalCredit.toFixed(2)},${ledgerData.closingBalance.toFixed(2)}`,
      `"الرصيد الختامي: ${ledgerData.closingBalance.toFixed(2)} ج.م (${ledgerData.isDebitNormal ? 'مدين' : 'دائن'})"`,
    ].join('\r\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `كشف_حساب_الأستاذ_${selectedLedgerAccount.code}_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrintLedger = () => {
    window.print();
  };

  return (
    <div className="space-y-6 text-right">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-black text-slate-900">محرك المحاسبة ودفتر الأستاذ العام (General Ledger)</h2>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-900 text-white font-bold">
              القيد المزدوج الإلزامي
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            دفتر اليومية، كشف حساب الأستاذ بالرصيد التراكمي المستمر، دليل الحسابات الشجري، وإقفال الفترات المالية
          </p>
        </div>

        <div className="flex items-center gap-2">
          {activeTab === 'ledger' && (
            <>
              <button
                onClick={handlePrintLedger}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs border border-slate-300 transition cursor-pointer"
                title="طباعة كشف حساب الأستاذ"
              >
                <Printer className="w-4 h-4" />
                <span className="hidden sm:inline">طباعة</span>
              </button>
              <button
                onClick={handleExportLedgerCSV}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-800 font-bold text-xs border border-emerald-300 transition cursor-pointer"
                title="تصدير إكسل / CSV"
              >
                <Download className="w-4 h-4" />
                <span className="hidden sm:inline">تصدير Excel</span>
              </button>
            </>
          )}

          <button
            onClick={() => {
              setFormError(null);
              setShowAddJvModal(true);
            }}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>قيد يومية يدوي متزن</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setActiveTab('journals')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'journals' ? 'bg-slate-900 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          دفتر اليومية العامة ({db.journalEntries.length})
        </button>
        <button
          onClick={() => setActiveTab('ledger')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'ledger' ? 'bg-slate-900 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <BookOpen className="w-3.5 h-3.5" />
          <span>كشف حساب الأستاذ (General Ledger)</span>
        </button>
        <button
          onClick={() => setActiveTab('chart')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'chart' ? 'bg-slate-900 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          دليل الحسابات الشجري ({db.accounts.length})
        </button>
        <button
          onClick={() => setActiveTab('periods')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'periods' ? 'bg-slate-900 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          الفترات المالية والإقفال ({db.accountingPeriods.length})
        </button>
      </div>

      {/* TAB 1: JOURNAL ENTRIES */}
      {activeTab === 'journals' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-100 text-slate-700 font-bold">
              <tr>
                <th className="p-3.5">رقم القيد</th>
                <th className="p-3.5">التاريخ</th>
                <th className="p-3.5">المرجع</th>
                <th className="p-3.5">البيان والشرح</th>
                <th className="p-3.5 text-center">إجمالي المدين (ج.م)</th>
                <th className="p-3.5 text-center">إجمالي الدائن (ج.م)</th>
                <th className="p-3.5 text-center">حالة القيد</th>
                <th className="p-3.5 text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {db.journalEntries.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">
                    لا توجد قيود يومية مسجلة حالياً
                  </td>
                </tr>
              ) : (
                db.journalEntries.slice().reverse().map(jv => (
                  <tr key={jv.id} className={`hover:bg-slate-50 transition ${jv.isReversed ? 'bg-rose-50/40 text-slate-400' : ''}`}>
                    <td className="p-3.5 font-mono font-bold text-slate-900">{jv.entryNumber}</td>
                    <td className="p-3.5 text-slate-600">{jv.date}</td>
                    <td className="p-3.5 font-mono text-slate-600">{jv.reference || '-'}</td>
                    <td className="p-3.5 font-semibold text-slate-800">{jv.description}</td>
                    <td className="p-3.5 text-center font-mono font-bold text-slate-900">
                      {jv.totalDebit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                    </td>
                    <td className="p-3.5 text-center font-mono font-bold text-slate-900">
                      {jv.totalCredit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                    </td>
                    <td className="p-3.5 text-center">
                      {jv.isReversed ? (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-rose-100 text-rose-700">
                          ملغى بقيد عكسي
                        </span>
                      ) : jv.sourceDocumentType === 'journal_reversal' ? (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-slate-200 text-slate-700">
                          قيد عكسي (غير قابل للعكس مجدداً)
                        </span>
                      ) : (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-800">
                          مرحل نهائي
                        </span>
                      )}
                    </td>
                    <td className="p-3.5 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => setSelectedJvDetails(jv)}
                          className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg text-xs cursor-pointer"
                        >
                          عرض الأطراف
                        </button>
                        {!jv.isReversed && jv.sourceDocumentType !== 'journal_reversal' && (
                          <button
                            onClick={() => handleReverseJv(jv.id)}
                            title="إلغاء عبر قيد عكسي Reversal"
                            className="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold rounded-lg text-xs border border-rose-200 cursor-pointer"
                          >
                            عكس وإلغاء
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 2: GENERAL LEDGER (REQUIREMENT 6) */}
      {activeTab === 'ledger' && (
        <div className="space-y-5">
          {/* Account & Date Filters */}
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs grid grid-cols-1 sm:grid-cols-3 gap-3.5">
            {/* Account Selector */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">الحساب المحاسبي (Account)</label>
              <select
                value={ledgerAccountId}
                onChange={(e) => setLedgerAccountId(e.target.value)}
                className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold focus:bg-white focus:outline-none"
              >
                {nonHeaderAccounts.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.code} - {a.nameAr} ({a.category})
                  </option>
                ))}
              </select>
            </div>

            {/* From Date */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">من تاريخ (From Date)</label>
              <input
                type="date"
                value={ledgerFromDate}
                onChange={(e) => setLedgerFromDate(e.target.value)}
                className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono focus:bg-white focus:outline-none"
              />
            </div>

            {/* To Date */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">إلى تاريخ (To Date)</label>
              <input
                type="date"
                value={ledgerToDate}
                onChange={(e) => setLedgerToDate(e.target.value)}
                className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono focus:bg-white focus:outline-none"
              />
            </div>
          </div>

          {/* Account Summary Cards */}
          {selectedLedgerAccount && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
              {/* Opening Balance */}
              <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs">
                <span className="text-[11px] text-slate-500 font-medium">الرصيد الافتتاحي (Opening)</span>
                <div className="text-lg font-black text-slate-900 font-mono mt-1">
                  {ledgerData.openingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-500 mr-1">ج.م</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">قبل {ledgerFromDate}</div>
              </div>

              {/* Total Debit */}
              <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs">
                <span className="text-[11px] text-slate-500 font-medium">إجمالي المدين (Total Debit)</span>
                <div className="text-lg font-black text-emerald-700 font-mono mt-1">
                  {ledgerData.totalDebit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-500 mr-1">ج.م</span>
                </div>
                <div className="text-[10px] text-emerald-600 mt-0.5">حركات مدينة بالفترة</div>
              </div>

              {/* Total Credit */}
              <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs">
                <span className="text-[11px] text-slate-500 font-medium">إجمالي الدائن (Total Credit)</span>
                <div className="text-lg font-black text-rose-700 font-mono mt-1">
                  {ledgerData.totalCredit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-500 mr-1">ج.م</span>
                </div>
                <div className="text-[10px] text-rose-600 mt-0.5">حركات دائنة بالفترة</div>
              </div>

              {/* Closing Balance */}
              <div className="p-4 rounded-2xl bg-slate-900 text-white shadow-md">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-slate-300 font-medium">الرصيد الختامي (Closing)</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-amber-400 font-bold border border-slate-700">
                    طبيعة: {ledgerData.isDebitNormal ? 'مدين' : 'دائن'}
                  </span>
                </div>
                <div className="text-lg font-black text-amber-400 font-mono mt-1">
                  {ledgerData.closingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-300 mr-1">ج.م</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">حتى تاريخ {ledgerToDate}</div>
              </div>
            </div>
          )}

          {/* Ledger Table */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
              <div>
                <h3 className="font-bold text-xs text-slate-900">
                  دفتر أستاذ الحساب: {selectedLedgerAccount?.nameAr} ({selectedLedgerAccount?.code})
                </h3>
                <span className="text-[11px] text-slate-500">
                  كافة الحركات المرحلة بالقيود المحاسبية مع الرصيد بعد كل قيد (Running Balance)
                </span>
              </div>
              <div className="text-xs font-mono font-bold text-slate-700 bg-white px-3 py-1 rounded-xl border border-slate-200">
                الفترة: {ledgerFromDate} إلى {ledgerToDate}
              </div>
            </div>

            <table className="w-full text-right text-xs">
              <thead className="bg-slate-100 border-b border-slate-200 text-slate-700 font-bold">
                <tr>
                  <th className="p-3">التاريخ</th>
                  <th className="p-3">رقم القيد</th>
                  <th className="p-3">المستند المصدر</th>
                  <th className="p-3">البيان والشرح</th>
                  <th className="p-3 text-center">مدين</th>
                  <th className="p-3 text-center">دائن</th>
                  <th className="p-3 text-center bg-slate-200/50">الرصيد التراكمي</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {/* Opening Balance Row */}
                <tr className="bg-amber-50/40 font-bold text-slate-800">
                  <td className="p-3 font-mono text-slate-500">{ledgerFromDate}</td>
                  <td className="p-3 font-mono">-</td>
                  <td className="p-3">-</td>
                  <td className="p-3">
                    <span className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-800 text-[10px] font-bold">
                      رصيد أول المدة المنقول
                    </span>
                  </td>
                  <td className="p-3 text-center font-mono">-</td>
                  <td className="p-3 text-center font-mono">-</td>
                  <td className="p-3 text-center font-mono font-black text-slate-900 bg-amber-50/80">
                    {ledgerData.openingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  </td>
                </tr>

                {/* Ledger Entries */}
                {ledgerData.entries.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-slate-400">
                      لا توجد قيود مرحلة على هذا الحساب خلال الفترة المحددة
                    </td>
                  </tr>
                ) : (
                  ledgerData.entries.map((entry) => (
                    <tr key={entry.id} className="hover:bg-slate-50 transition">
                      <td className="p-3 font-mono text-slate-600">{entry.date}</td>
                      <td className="p-3 font-mono font-bold text-slate-900">{entry.entryNumber}</td>
                      <td className="p-3 font-mono text-slate-600">{entry.sourceDocument}</td>
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
                    {ledgerData.totalDebit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  </td>
                  <td className="p-3 text-center font-mono font-black text-rose-800">
                    {ledgerData.totalCredit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  </td>
                  <td className="p-3 text-center font-mono font-black text-slate-900 bg-slate-200">
                    {ledgerData.closingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: CHART OF ACCOUNTS */}
      {activeTab === 'chart' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200">
            <h3 className="font-bold text-xs text-slate-800">دليل الحسابات المحاسبي الشجري الكامل</h3>
            <p className="text-[11px] text-slate-500">الأصول، الخصوم، حقوق الملكية، الإيرادات، تكلفة المبيعات، والمصروفات</p>
          </div>

          <table className="w-full text-right text-xs">
            <thead className="bg-slate-100 text-slate-700 font-bold">
              <tr>
                <th className="p-3">رقم الحساب (Code)</th>
                <th className="p-3">اسم الحساب العربي</th>
                <th className="p-3">English Name</th>
                <th className="p-3">التصنيف</th>
                <th className="p-3 text-center">طبيعة الحساب</th>
                <th className="p-3 text-center">الرصيد الدفتري الحالي (ج.م)</th>
                <th className="p-3 text-center">كشف الأستاذ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {db.accounts.map(acc => {
                const isHead = acc.isHeader;
                const indentClass = acc.level === 1 ? 'font-black text-slate-900 bg-slate-50/80 text-sm' : acc.level === 2 ? 'font-bold text-slate-800 pr-6' : 'pr-12 text-slate-700';
                return (
                  <tr key={acc.id} className={`hover:bg-slate-50 ${isHead ? 'bg-slate-50/50' : ''}`}>
                    <td className="p-3 font-mono font-bold">{acc.code}</td>
                    <td className={`p-3 ${indentClass}`}>{acc.nameAr}</td>
                    <td className="p-3 text-slate-500 font-sans text-[11px]">{acc.nameEn}</td>
                    <td className="p-3 font-medium text-slate-600">{acc.category}</td>
                    <td className="p-3 text-center">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                        isDebitNatureCategory(acc.category)
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-indigo-50 text-indigo-700'
                      }`}>
                        {isDebitNatureCategory(acc.category) ? 'مدين' : 'دائن'}
                      </span>
                    </td>
                    <td className="p-3 text-center font-mono font-bold">
                      {acc.currentBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                    </td>
                    <td className="p-3 text-center">
                      {!acc.isHeader && (
                        <button
                          onClick={() => {
                            setLedgerAccountId(acc.id);
                            setActiveTab('ledger');
                          }}
                          className="px-2 py-1 rounded bg-amber-50 hover:bg-amber-100 text-amber-900 text-[11px] font-bold border border-amber-200 cursor-pointer"
                        >
                          كشف الأستاذ
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 4: PERIODS */}
      {activeTab === 'periods' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
            <div>
              <h3 className="font-bold text-xs text-slate-800">إدارة الفترات المالية والإقفال المحاسبي</h3>
              <p className="text-[11px] text-slate-500">منع الترحيل نهائياً على الفترات المغلقة وإقفال الأرباح المرحلة</p>
            </div>
          </div>

          <table className="w-full text-right text-xs">
            <thead className="bg-slate-100 text-slate-700 font-bold">
              <tr>
                <th className="p-3.5">كود الفترة</th>
                <th className="p-3.5">اسم الفترة</th>
                <th className="p-3.5 text-center">تاريخ البداية</th>
                <th className="p-3.5 text-center">تاريخ النهاية</th>
                <th className="p-3.5 text-center">حالة الفترة</th>
                <th className="p-3.5 text-center">تاريخ الإقفال</th>
                <th className="p-3.5 text-center">إجراءات الإقفال</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {db.accountingPeriods.map(p => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="p-3.5 font-mono font-bold text-slate-900">{p.code}</td>
                  <td className="p-3.5 font-bold text-slate-800">{p.nameAr}</td>
                  <td className="p-3.5 text-center text-slate-600">{p.startDate}</td>
                  <td className="p-3.5 text-center text-slate-600">{p.endDate}</td>
                  <td className="p-3.5 text-center">
                    {p.isClosed ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-rose-100 text-rose-800 flex items-center justify-center gap-1 w-max mx-auto">
                        <Lock className="w-3 h-3" />
                        <span>مغلقة ومحمية</span>
                      </span>
                    ) : (
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-800 flex items-center justify-center gap-1 w-max mx-auto">
                        <Unlock className="w-3 h-3" />
                        <span>مفتوحة للترحيل</span>
                      </span>
                    )}
                  </td>
                  <td className="p-3.5 text-center text-slate-500 font-mono text-[11px]">
                    {p.closedAt ? p.closedAt.split('T')[0] : '-'}
                  </td>
                  <td className="p-3.5 text-center">
                    <button
                      onClick={() => handleTogglePeriod(p.id)}
                      className={`px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                        p.isClosed 
                          ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200' 
                          : 'bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200'
                      }`}
                    >
                      {p.isClosed ? 'إعادة فتح الفترة' : 'إقفال الفترة المحاسبية'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Manual JV Modal */}
      {showAddJvModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-3xl overflow-hidden text-right flex flex-col max-h-[90vh]">
            <div className="p-4 bg-gradient-to-r from-slate-900 to-slate-800 text-white flex items-center justify-between">
              <div>
                <h3 className="font-bold text-sm">إنشاء قيد يومية عامة يدوي متزن (Double-Entry Journal)</h3>
                <p className="text-[11px] text-slate-300">يجب أن يتطابق إجمالي المدين مع إجمالي الدائن بدقة</p>
              </div>
              <button onClick={() => setShowAddJvModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4">
              {formError && (
                <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ القيد</label>
                  <input
                    type="date"
                    value={jvDate}
                    onChange={(e) => setJvDate(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">المرجع / رقم الإشعار</label>
                  <input
                    type="text"
                    placeholder="مثال: JV-MANUAL-001"
                    value={jvRef}
                    onChange={(e) => setJvRef(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">شرح القيد العام</label>
                  <input
                    type="text"
                    placeholder="بيان القيد المحاسبي"
                    value={jvDesc}
                    onChange={(e) => setJvDesc(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  />
                </div>
              </div>

              {/* Journal Lines Table */}
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="p-3 bg-slate-100 flex items-center justify-between">
                  <span className="font-bold text-xs text-slate-800">أطراف القيد (الحسابات المدينة والدائنة)</span>
                  <button
                    onClick={addLine}
                    type="button"
                    className="px-2.5 py-1 bg-white hover:bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-700"
                  >
                    + إضافة طرف
                  </button>
                </div>

                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="p-2.5">الحساب الفرعي (ممنوع الحسابات الرئيسية)</th>
                      <th className="p-2.5 text-center w-28">مدين (Debit)</th>
                      <th className="p-2.5 text-center w-28">دائن (Credit)</th>
                      <th className="p-2.5">البيان الخاص بالطرف</th>
                      <th className="p-2.5 text-center w-10">حذف</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lines.map((line, idx) => (
                      <tr key={idx}>
                        <td className="p-2">
                          <select
                            value={line.accountId}
                            onChange={(e) => updateLine(idx, 'accountId', e.target.value)}
                            className="w-full p-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                          >
                            {nonHeaderAccounts.map(a => (
                              <option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>
                            ))}
                          </select>
                        </td>
                        <td className="p-2">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={line.debit}
                            onChange={(e) => updateLine(idx, 'debit', e.target.value)}
                            className="w-full p-1.5 rounded-lg border border-slate-300 text-xs text-center font-mono font-bold"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={line.credit}
                            onChange={(e) => updateLine(idx, 'credit', e.target.value)}
                            className="w-full p-1.5 rounded-lg border border-slate-300 text-xs text-center font-mono font-bold"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="text"
                            placeholder="شرح الطرف..."
                            value={line.description}
                            onChange={(e) => updateLine(idx, 'description', e.target.value)}
                            className="w-full p-1.5 rounded-lg border border-slate-300 text-xs"
                          />
                        </td>
                        <td className="p-2 text-center">
                          {lines.length > 2 && (
                            <button onClick={() => removeLine(idx)} className="text-rose-500 font-bold">✕</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Balancing Status Bar */}
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between text-xs">
                <div className="flex items-center gap-4 font-mono font-bold">
                  <span>إجمالي المدين: {totalDebit.toFixed(2)}</span>
                  <span>إجمالي الدائن: {totalCredit.toFixed(2)}</span>
                  <span className={diff < 0.01 ? 'text-emerald-700' : 'text-rose-700'}>
                    الفرق: {diff.toFixed(2)} ج.م
                  </span>
                </div>
                <div>
                  {isBalanced ? (
                    <span className="text-[11px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
                      القيد متزن تماماً ✓
                    </span>
                  ) : (
                    <span className="text-[11px] font-bold text-rose-700 bg-rose-100 px-2 py-0.5 rounded-full">
                      القيد غير متزن ✕
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="p-4 bg-slate-100 border-t border-slate-200 flex items-center justify-end gap-2">
              <button
                onClick={() => setShowAddJvModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold text-xs cursor-pointer"
              >
                إلغاء
              </button>
              <button
                onClick={handleSaveJv}
                disabled={!isBalanced}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md disabled:opacity-40 cursor-pointer"
              >
                ترحيل القيد بالدفاتر
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View JV Details Modal */}
      {selectedJvDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">
                أطراف قيد اليومية: {selectedJvDetails.entryNumber}
              </h3>
              <button onClick={() => setSelectedJvDetails(null)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="text-xs text-slate-600 bg-slate-50 p-3 rounded-xl border border-slate-200">
              <div className="font-bold text-slate-900 mb-1">{selectedJvDetails.description}</div>
              <div>التاريخ: {selectedJvDetails.date} | المرجع: {selectedJvDetails.reference || '-'}</div>
            </div>

            <table className="w-full text-right text-xs border border-slate-200 rounded-xl overflow-hidden">
              <thead className="bg-slate-100 text-slate-700">
                <tr>
                  <th className="p-2.5">كود الحساب</th>
                  <th className="p-2.5">اسم الحساب</th>
                  <th className="p-2.5 text-center">مدين</th>
                  <th className="p-2.5 text-center">دائن</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
                {selectedJvDetails.lines.map((l, idx) => (
                  <tr key={idx}>
                    <td className="p-2.5">{l.accountCode}</td>
                    <td className="p-2.5 font-sans font-bold text-slate-800">{l.accountNameAr}</td>
                    <td className="p-2.5 text-center text-emerald-700 font-bold">{l.debit > 0 ? l.debit.toFixed(2) : '-'}</td>
                    <td className="p-2.5 text-center text-rose-700 font-bold">{l.credit > 0 ? l.credit.toFixed(2) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setSelectedJvDetails(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 text-white font-bold text-xs cursor-pointer"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
