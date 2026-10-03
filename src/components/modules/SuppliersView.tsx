import React, { useState, useMemo } from 'react';
import { useModuleWriteAccess } from '../../hooks/usePermissions';
import { 
  Truck, Plus, Search, FileText, Phone, 
  MapPin, DollarSign, ArrowUpRight, ArrowDownLeft,
  Calendar, Printer, Download, Filter, CheckCircle2, AlertTriangle, RefreshCw
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { Supplier } from '../../types/erp';
import { WorkflowService } from '../../services/workflows';
import { MasterDataService } from '../../services/masterData';
import { printDocument } from '../printUtils';

export const SuppliersView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [activeTab, setActiveTab] = useState<'list' | 'statement'>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  // QA-25: UI permission affordance (service authorization stays the real wall).
  const writeAccess = useModuleWriteAccess('suppliers', 'الموردون');
  const [showPaymentModal, setShowPaymentModal] = useState<Supplier | null>(null);

  // Statement Filters
  const [statementSupplierId, setStatementSupplierId] = useState<string>(db.suppliers[0]?.id || '');
  const [statementFromDate, setStatementFromDate] = useState(() => {
    const d = new Date();
    d.setDate(1); // 1st of month
    return d.toISOString().split('T')[0];
  });
  const [statementToDate, setStatementToDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [statementDocType, setStatementDocType] = useState<string>('all');

  // New Supplier form
  const [code, setCode] = useState(`SUP-00${db.suppliers.length + 1}`);
  const [name, setName] = useState('');
  const [taxNumber, setTaxNumber] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('آجل 30 يوم');
  const [currency, setCurrency] = useState<'EGP' | 'USD'>('EGP');
  const [openingBalanceInput, setOpeningBalanceInput] = useState(0);

  // Payment form
  const [payAmount, setPayAmount] = useState(10000);
  const [payMethod, setPayMethod] = useState<'cash' | 'bank' | 'cheque'>('bank');
  const [bankId, setBankId] = useState('bank-1');
  const [chequeNum, setChequeNum] = useState('');
  const [payRef, setPayRef] = useState('');
  const [payDate, setPayDate] = useState(new Date().toISOString().split('T')[0]);

  const handleSaveSupplier = () => {
    if (!name.trim()) {
      alert('يرجى كتابة اسم المورد');
      return;
    }

    // F15: writes go through the guarded master-data service (AuthorizationService).
    const res = MasterDataService.createSupplier({
      code,
      name,
      taxNumber,
      contactPerson,
      phone,
      address,
      paymentTerms,
      currency,
      openingBalance: Number(openingBalanceInput) || 0,
      userId: 'usr-admin',
      userName: 'المشرف العام (Admin)',
    });
    if (!res.success) {
      alert(res.error || 'تعذر حفظ بيانات المورد');
      return;
    }

    setShowAddModal(false);
    setName('');
    setTaxNumber('');
    setContactPerson('');
    setPhone('');
    setAddress('');
    setOpeningBalanceInput(0);
  };

  const handleRecordPayment = () => {
    if (!showPaymentModal) return;
    const res = WorkflowService.recordSupplierPayment({
      supplierId: showPaymentModal.id,
      amount: Number(payAmount),
      currency: showPaymentModal.currency,
      exchangeRate: db.company.currentUsdExchangeRate,
      paymentMethod: payMethod,
      bankAccountId: payMethod === 'bank' ? bankId : undefined,
      chequeNumber: payMethod === 'cheque' ? chequeNum : undefined,
      date: payDate,
      reference: payRef || 'سداد مستحقات مورد',
      userId: 'usr-admin',
      userName: 'المشرف العام (Admin)',
    });

    if (!res.success) {
      alert(res.error || 'خطأ في تسجيل السداد');
      return;
    }

    setShowPaymentModal(null);
  };

  const filteredSuppliers = db.suppliers.filter(s => 
    s.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    s.code.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Selected supplier for Statement
  const selectedSupplier = db.suppliers.find(s => s.id === statementSupplierId);

  // Requirement 5: Supplier Statement Computation (REAL Ledger with running balance)
  const statementData = useMemo(() => {
    if (!selectedSupplier) {
      return {
        openingBalance: 0,
        entries: [],
        totalDebit: 0,
        totalCredit: 0,
        closingBalance: 0,
      };
    }

    const fromDate = statementFromDate ? new Date(statementFromDate) : new Date('2000-01-01');
    const toDate = statementToDate ? new Date(statementToDate) : new Date('2099-12-31');
    toDate.setHours(23, 59, 59, 999);

    // Initial configured opening balance (credit)
    let opening = Number(selectedSupplier.openingBalance) || 0;

    // 1. Transactions before From Date (accumulate to opening balance)
    // Purchases (Credit -> increases liability)
    db.purchaseInvoices
      .filter(i => i.supplierId === selectedSupplier.id && i.status === 'posted' && new Date(i.date) < fromDate)
      .forEach(i => {
        opening += (selectedSupplier.currency === 'USD' ? i.totalAmount : i.totalAmountEGP);
      });

    // Payments (Debit -> reduces liability)
    db.payments
      .filter(p => p.partyId === selectedSupplier.id && p.paymentType === 'supplier_payment' && new Date(p.date) < fromDate)
      .forEach(p => {
        opening -= (selectedSupplier.currency === 'USD' ? p.amount : p.amountEGP);
      });

    // Purchase Returns (Debit -> reduces liability)
    db.purchaseReturns
      .filter(r => r.supplierId === selectedSupplier.id && r.status === 'posted' && new Date(r.date) < fromDate)
      .forEach(r => {
        opening -= r.totalAmount;
      });

    // 2. Transactions within date range
    interface LedgerLine {
      id: string;
      date: string;
      documentNumber: string;
      documentType: 'purchase_invoice' | 'supplier_payment' | 'purchase_return';
      documentTypeLabelAr: string;
      description: string;
      debit: number; // مدين (Payments & Returns)
      credit: number; // دائن (Purchases)
      runningBalance: number;
    }

    const rawLines: Array<Omit<LedgerLine, 'runningBalance'>> = [];

    // Purchase Invoices (Credit)
    if (statementDocType === 'all' || statementDocType === 'purchase_invoice') {
      db.purchaseInvoices
        .filter(i => i.supplierId === selectedSupplier.id && i.status === 'posted')
        .forEach(i => {
          const d = new Date(i.date);
          if (d >= fromDate && d <= toDate) {
            const amount = selectedSupplier.currency === 'USD' ? i.totalAmount : i.totalAmountEGP;
            rawLines.push({
              id: i.id,
              date: i.date,
              documentNumber: i.invoiceNumber,
              documentType: 'purchase_invoice',
              documentTypeLabelAr: 'فاتورة توريد خامات',
              description: `فاتورة شراء خامات ومواد تعبئة ${i.notes ? `- ${i.notes}` : ''}`,
              debit: 0,
              credit: amount,
            });
          }
        });
    }

    // Payments (Debit)
    if (statementDocType === 'all' || statementDocType === 'supplier_payment') {
      db.payments
        .filter(p => p.partyId === selectedSupplier.id && p.paymentType === 'supplier_payment')
        .forEach(p => {
          const d = new Date(p.date);
          if (d >= fromDate && d <= toDate) {
            const amount = selectedSupplier.currency === 'USD' ? p.amount : p.amountEGP;
            rawLines.push({
              id: p.id,
              date: p.date,
              documentNumber: p.paymentNumber,
              documentType: 'supplier_payment',
              documentTypeLabelAr: 'سند صرف وسداد',
              description: `سند سداد ${p.paymentMethod === 'cash' ? 'نقدية بالخزينة' : p.paymentMethod === 'bank' ? 'تحويل بنكي' : 'شيك'} (${p.reference || ''})`,
              debit: amount,
              credit: 0,
            });
          }
        });
    }

    // Purchase Returns (Debit)
    if (statementDocType === 'all' || statementDocType === 'purchase_return') {
      db.purchaseReturns
        .filter(r => r.supplierId === selectedSupplier.id && r.status === 'posted')
        .forEach(r => {
          const d = new Date(r.date);
          if (d >= fromDate && d <= toDate) {
            rawLines.push({
              id: r.id,
              date: r.date,
              documentNumber: r.returnNumber,
              documentType: 'purchase_return',
              documentTypeLabelAr: 'مرتجع مشتريات',
              description: `مردودات مشتريات خامات تالفة / معيبة (${r.reason || 'إرجاع للمورد'})`,
              debit: r.totalAmount,
              credit: 0,
            });
          }
        });
    }

    // Sort chronologically
    rawLines.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Calculate Running Balance line by line:
    // Opening Balance (Credit) + Invoices (Credit) - Payments (Debit) - Returns (Debit) = Running Balance
    let running = opening;
    let totalDebit = 0;
    let totalCredit = 0;

    const entries: LedgerLine[] = rawLines.map(line => {
      totalDebit += line.debit;
      totalCredit += line.credit;
      running = running + line.credit - line.debit;
      return {
        ...line,
        runningBalance: running,
      };
    });

    const closingBalance = opening + totalCredit - totalDebit;

    return {
      openingBalance: opening,
      entries,
      totalDebit,
      totalCredit,
      closingBalance,
    };
  }, [selectedSupplier, statementFromDate, statementToDate, statementDocType, db]);

  // Requirement 13: Subledger vs General Ledger Reconciliation Check
  const reconciliation = useMemo(() => {
    // Total subledger balance of all suppliers
    const subledgerTotalEGP = db.suppliers.reduce((sum, s) => {
      const rate = s.currency === 'USD' ? db.company.currentUsdExchangeRate : 1;
      return sum + (s.currentBalance * rate);
    }, 0);

    // GL Control Account: acc-2101 (Trade Payables - Local)
    const glControl = db.accounts.find(a => a.id === 'acc-2101')?.currentBalance || 0;
    const diff = Math.abs(subledgerTotalEGP - glControl);
    const isMatched = diff < 0.05;

    return {
      subledgerTotalEGP,
      glControlTotalEGP: glControl,
      diff,
      isMatched,
    };
  }, [db]);

  // Export to Excel (CSV with UTF-8 BOM for proper Arabic support)
  const handleExportCSV = () => {
    if (!selectedSupplier) return;
    const headers = ['التاريخ', 'رقم المستند', 'نوع المستند', 'البيان', 'مدين', 'دائن', 'الرصيد'];
    const rows = statementData.entries.map(e => [
      e.date,
      e.documentNumber,
      e.documentTypeLabelAr,
      `"${e.description.replace(/"/g, '""')}"`,
      e.debit.toFixed(2),
      e.credit.toFixed(2),
      e.runningBalance.toFixed(2),
    ]);

    const csvContent = '\uFEFF' + [
      `"كشف حساب مورد: ${selectedSupplier.name} (${selectedSupplier.code})"`,
      `"الفترة من: ${statementFromDate} إلى: ${statementToDate}"`,
      `"الرصيد الافتتاحي: ${statementData.openingBalance.toFixed(2)} ${selectedSupplier.currency}"`,
      headers.join(','),
      ...rows.map(r => r.join(',')),
      `"الإجمالي","","","إجمالي الحركات",${statementData.totalDebit.toFixed(2)},${statementData.totalCredit.toFixed(2)},${statementData.closingBalance.toFixed(2)}`,
      `"الرصيد الختامي المستحق للمورد: ${statementData.closingBalance.toFixed(2)} ${selectedSupplier.currency}"`,
    ].join('\r\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `كشف_حساب_مورد_${selectedSupplier.code}_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => {
    printDocument();
  };

  return (
    <div className="space-y-6 text-right">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-black text-slate-900">إدارة الموردين والحسابات الدائنة (Payables & Statements)</h2>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-900 text-white font-bold">
              حسابات الأستاذ المساعد
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            سجل الموردين، كشوف الحساب التفصيلية بالرصيد التراكمي المستمر، وسندات الصرف مع المطابقة الدفترية (Reconciliation)
          </p>
        </div>

        <div className="flex items-center gap-2">
          {activeTab === 'statement' && (
            <>
              <button
                onClick={handlePrint}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs border border-slate-300 transition cursor-pointer"
                title="طباعة كشف الحساب"
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
            </>
          )}

          <button
            onClick={() => {
              if (!writeAccess.canCreate) { alert(writeAccess.createDeniedTitle); return; }
              setCode(`SUP-00${db.suppliers.length + 1}`);
              setShowAddModal(true);
            }}
            disabled={!writeAccess.canCreate}
            title={writeAccess.canCreate ? '' : writeAccess.createDeniedTitle}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" />
            <span>إضافة مورد جديد</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center justify-between border-b border-slate-200 pb-2">
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('list')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeTab === 'list' 
                ? 'bg-slate-900 text-white shadow-xs' 
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Truck className="w-4 h-4" />
            <span>قائمة الموردين ({db.suppliers.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('statement')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeTab === 'statement' 
                ? 'bg-slate-900 text-white shadow-xs' 
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <FileText className="w-4 h-4" />
            <span>كشف حساب المورد (Statement)</span>
          </button>
        </div>

        {/* GL Reconciliation Check (Requirement 13) */}
        <div className="hidden md:flex items-center gap-2 text-xs">
          {reconciliation.isMatched ? (
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>أستاذ الموردين مطابق للأستاذ العام (حـ/ 2101)</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-rose-50 text-rose-800 border border-rose-300 font-bold animate-pulse">
              <AlertTriangle className="w-4 h-4 text-rose-600" />
              <span>يوجد فرق يحتاج إلى مراجعة ({reconciliation.diff.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م)</span>
            </div>
          )}
        </div>
      </div>

      {/* TAB 1: SUPPLIERS LIST */}
      {activeTab === 'list' && (
        <div className="space-y-4">
          {/* Search Bar */}
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
            <div className="relative flex-1 max-w-md">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="بحث باسم المورد أو الكود..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pr-9 pl-4 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs focus:outline-none focus:border-amber-500 text-right"
              />
            </div>
            <div className="text-xs font-semibold text-slate-500">
              عدد الموردين: <span className="font-bold text-slate-900">{filteredSuppliers.length}</span>
            </div>
          </div>

          {/* Suppliers Table */}
          <div className="print-area bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold">
                <tr>
                  <th className="p-3.5">الكود</th>
                  <th className="p-3.5">اسم المورد</th>
                  <th className="p-3.5">مسؤول الاتصال</th>
                  <th className="p-3.5">الهاتف</th>
                  <th className="p-3.5">شروط السداد</th>
                  <th className="p-3.5 text-center">الرصيد الدائن المستحق</th>
                  <th className="p-3.5 text-center">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredSuppliers.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-400">
                      لا يوجد موردون مسجلون حالياً
                    </td>
                  </tr>
                ) : (
                  filteredSuppliers.map(sup => (
                    <tr key={sup.id} className="hover:bg-slate-50/80 transition">
                      <td className="p-3.5 font-mono font-bold text-slate-900">{sup.code}</td>
                      <td className="p-3.5 font-bold text-slate-800">{sup.name}</td>
                      <td className="p-3.5 text-slate-600">{sup.contactPerson || '-'}</td>
                      <td className="p-3.5 font-mono text-slate-600">{sup.phone || '-'}</td>
                      <td className="p-3.5 text-slate-600">{sup.paymentTerms}</td>
                      <td className="p-3.5 text-center font-mono font-black text-rose-700">
                        {sup.currentBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {sup.currency}
                      </td>
                      <td className="p-3.5 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={() => {
                              setStatementSupplierId(sup.id);
                              setActiveTab('statement');
                            }}
                            className="px-2.5 py-1 bg-amber-50 hover:bg-amber-100 text-amber-900 font-bold rounded-lg text-xs border border-amber-200 transition cursor-pointer"
                          >
                            كشف الحساب
                          </button>
                          <button
                            onClick={() => {
                              setShowPaymentModal(sup);
                              setPayAmount(Math.min(10000, sup.currentBalance > 0 ? sup.currentBalance : 10000));
                            }}
                            className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-lg text-xs transition cursor-pointer"
                          >
                            سند صرف
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: SUPPLIER STATEMENT (REQUIREMENT 5) */}
      {activeTab === 'statement' && (
        <div className="space-y-5">
          {/* Statement Filter Bar */}
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
            {/* Supplier Select */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">المورد</label>
              <select
                value={statementSupplierId}
                onChange={(e) => setStatementSupplierId(e.target.value)}
                className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold focus:bg-white focus:outline-none"
              >
                {db.suppliers.map(s => (
                  <option key={s.id} value={s.id}>{s.name} ({s.code}) - {s.currency}</option>
                ))}
              </select>
            </div>

            {/* From Date */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">من تاريخ</label>
              <input
                type="date"
                value={statementFromDate}
                onChange={(e) => setStatementFromDate(e.target.value)}
                className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono focus:bg-white focus:outline-none"
              />
            </div>

            {/* To Date */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">إلى تاريخ</label>
              <input
                type="date"
                value={statementToDate}
                onChange={(e) => setStatementToDate(e.target.value)}
                className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono focus:bg-white focus:outline-none"
              />
            </div>

            {/* Document Type Filter */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">نوع المستند</label>
              <select
                value={statementDocType}
                onChange={(e) => setStatementDocType(e.target.value)}
                className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs focus:bg-white focus:outline-none"
              >
                <option value="all">كافة المستندات والحركات</option>
                <option value="purchase_invoice">فواتير الشراء والتوريد فقط</option>
                <option value="supplier_payment">سندات الصرف والسداد فقط</option>
                <option value="purchase_return">مردودات المشتريات فقط</option>
              </select>
            </div>
          </div>

          {/* Supplier Info & KPI Cards */}
          {selectedSupplier && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
              {/* Opening Balance */}
              <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs">
                <span className="text-[11px] text-slate-500 font-medium">الرصيد الافتتاحي</span>
                <div className="text-lg font-black text-slate-900 font-mono mt-1">
                  {statementData.openingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-500 mr-1">{selectedSupplier.currency}</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">قبل {statementFromDate}</div>
              </div>

              {/* Total Debit */}
              <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs">
                <span className="text-[11px] text-slate-500 font-medium">إجمالي المدين (سدادات ومردودات)</span>
                <div className="text-lg font-black text-emerald-700 font-mono mt-1">
                  {statementData.totalDebit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-500 mr-1">{selectedSupplier.currency}</span>
                </div>
                <div className="text-[10px] text-emerald-600 mt-0.5">تخفيض الالتزام</div>
              </div>

              {/* Total Credit */}
              <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs">
                <span className="text-[11px] text-slate-500 font-medium">إجمالي الدائن (فواتير مشتريات)</span>
                <div className="text-lg font-black text-amber-700 font-mono mt-1">
                  {statementData.totalCredit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-500 mr-1">{selectedSupplier.currency}</span>
                </div>
                <div className="text-[10px] text-amber-600 mt-0.5">استحقاق مشتريات</div>
              </div>

              {/* Closing Balance */}
              <div className="p-4 rounded-2xl bg-slate-900 text-white shadow-md">
                <span className="text-[11px] text-slate-300 font-medium">الرصيد الختامي المستحق للمورد</span>
                <div className="text-lg font-black text-amber-400 font-mono mt-1">
                  {statementData.closingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  <span className="text-xs font-normal text-slate-300 mr-1">{selectedSupplier.currency}</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">حتى تاريخ {statementToDate}</div>
              </div>
            </div>
          )}

          {/* Statement Ledger Table */}
          <div className="print-area bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
              <div>
                <h3 className="font-bold text-xs text-slate-900">
                  كشف حساب حركة المورد: {selectedSupplier?.name} ({selectedSupplier?.code})
                </h3>
                <span className="text-[11px] text-slate-500">
                  الرصيد التراكمي المستمر بعد كل حركة مالية ومشتريات (Running Balance)
                </span>
              </div>
              <div className="text-xs font-mono font-bold text-slate-700 bg-white px-3 py-1 rounded-xl border border-slate-200">
                الفترة: {statementFromDate} إلى {statementToDate}
              </div>
            </div>

            <table className="w-full text-right text-xs">
              <thead className="bg-slate-100/80 border-b border-slate-200 text-slate-700 font-bold">
                <tr>
                  <th className="p-3">التاريخ</th>
                  <th className="p-3">رقم المستند</th>
                  <th className="p-3">نوع المستند</th>
                  <th className="p-3">البيان والشرح</th>
                  <th className="p-3 text-center">مدين (-)</th>
                  <th className="p-3 text-center">دائن (+)</th>
                  <th className="p-3 text-center bg-slate-200/50">الرصيد الدائن</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {/* Opening Balance Row */}
                <tr className="bg-amber-50/40 font-bold text-slate-800">
                  <td className="p-3 font-mono text-slate-500">{statementFromDate}</td>
                  <td className="p-3 font-mono">-</td>
                  <td className="p-3">
                    <span className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-800 text-[10px] font-bold">
                      رصيد أول المدة
                    </span>
                  </td>
                  <td className="p-3">رصيد افتتاحي منقول قبل تاريخ {statementFromDate}</td>
                  <td className="p-3 text-center font-mono">-</td>
                  <td className="p-3 text-center font-mono">-</td>
                  <td className="p-3 text-center font-mono font-black text-slate-900 bg-amber-50/80">
                    {statementData.openingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  </td>
                </tr>

                {/* Entry Rows */}
                {statementData.entries.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-slate-400">
                      لا توجد حركات مسجلة للمورد في هذه الفترة المحددة
                    </td>
                  </tr>
                ) : (
                  statementData.entries.map((entry) => (
                    <tr key={entry.id} className="hover:bg-slate-50 transition">
                      <td className="p-3 font-mono text-slate-600">{entry.date}</td>
                      <td className="p-3 font-mono font-bold text-slate-900">{entry.documentNumber}</td>
                      <td className="p-3">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                          entry.documentType === 'purchase_invoice' 
                            ? 'bg-amber-100 text-amber-900' 
                            : entry.documentType === 'supplier_payment' 
                            ? 'bg-emerald-100 text-emerald-900' 
                            : 'bg-rose-100 text-rose-900'
                        }`}>
                          {entry.documentTypeLabelAr}
                        </span>
                      </td>
                      <td className="p-3 text-slate-700">{entry.description}</td>
                      <td className="p-3 text-center font-mono font-bold text-emerald-700">
                        {entry.debit > 0 ? entry.debit.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) : '-'}
                      </td>
                      <td className="p-3 text-center font-mono font-bold text-amber-800">
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
                    {statementData.totalDebit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  </td>
                  <td className="p-3 text-center font-mono font-black text-amber-900">
                    {statementData.totalCredit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}
                  </td>
                  <td className="p-3 text-center font-mono font-black text-slate-900 bg-slate-200">
                    {statementData.closingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {selectedSupplier?.currency}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add Supplier Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">تسجيل مورد خامات ومواد تعبئة جديد</h3>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">كود المورد</label>
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">عملة التعامل</label>
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value as any)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    <option value="EGP">جنيه مصري (EGP)</option>
                    <option value="USD">دولار أمريكي (USD)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">اسم المورد / الشركة</label>
                <input
                  type="text"
                  placeholder="اسم شركة توريد الخامات أو الكرتون"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">مسؤول الاتصال</label>
                  <input
                    type="text"
                    value={contactPerson}
                    onChange={(e) => setContactPerson(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">رقم الهاتف</label>
                  <input
                    type="text"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">الرقم الضريبي</label>
                  <input
                    type="text"
                    value={taxNumber}
                    onChange={(e) => setTaxNumber(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">الرصيد الافتتاحي</label>
                  <input
                    type="number"
                    value={openingBalanceInput}
                    onChange={(e) => setOpeningBalanceInput(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">شروط السداد المعتمدة</label>
                <input
                  type="text"
                  value={paymentTerms}
                  onChange={(e) => setPaymentTerms(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">العنوان / المصنع</label>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
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
                onClick={handleSaveSupplier}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md"
              >
                حفظ المورد
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Record Supplier Payment Modal */}
      {showPaymentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-md p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">سند صرف وسداد لمورد</h3>
              <button onClick={() => setShowPaymentModal(null)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>

            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
              <div className="text-xs font-bold text-slate-900">{showPaymentModal.name}</div>
              <div className="text-xs text-rose-700 font-mono font-bold">
                الرصيد الدائن الحالي: {showPaymentModal.currentBalance.toLocaleString('ar-EG')} {showPaymentModal.currency}
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">المبلغ المطلوب سداده</label>
                <input
                  type="number"
                  min="1"
                  value={payAmount}
                  onChange={(e) => setPayAmount(Number(e.target.value))}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono font-bold"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">طريقة السداد</label>
                <select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value as any)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold"
                >
                  <option value="bank">تحويل بنكي من حساب الشركة</option>
                  <option value="cash">نقداً من الخزينة الرئيسية</option>
                  <option value="cheque">إصدار شيك بنكي آجل</option>
                </select>
              </div>

              {payMethod === 'bank' && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">الحساب البنكي المصدر</label>
                  <select
                    value={bankId}
                    onChange={(e) => setBankId(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    {db.bankAccounts.map(b => (
                      <option key={b.id} value={b.id}>{b.bankName} ({b.currency})</option>
                    ))}
                  </select>
                </div>
              )}

              {payMethod === 'cheque' && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">رقم الشيك الصادر</label>
                  <input
                    type="text"
                    placeholder="CHQ-..."
                    value={chequeNum}
                    onChange={(e) => setChequeNum(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ السداد</label>
                  <input
                    type="date"
                    value={payDate}
                    onChange={(e) => setPayDate(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">المرجع / رقم الإيصال</label>
                  <input
                    type="text"
                    value={payRef}
                    onChange={(e) => setPayRef(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setShowPaymentModal(null)}
                className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs"
              >
                إلغاء
              </button>
              <button
                onClick={handleRecordPayment}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md"
              >
                ترحيل سند الصرف والقيد
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
