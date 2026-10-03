import React, { useState, useMemo } from 'react';
import { 
  Users, Plus, Search, FileText, Phone, 
  MapPin, AlertTriangle, DollarSign, ArrowDownLeft,
  Calendar, Printer, Download, Filter, CheckCircle2, RefreshCw, Undo2
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { Customer, QualityDestination } from '../../types/erp';
import { WorkflowService } from '../../services/workflows';
import { MasterDataService } from '../../services/masterData';
import { LedgerService } from '../../services/ledger';
import { printDocument } from '../printUtils';

export const CustomersView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [activeTab, setActiveTab] = useState<'list' | 'statement' | 'returns'>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState<Customer | null>(null);

  // Sales Return form state
  const [retCustomerId, setRetCustomerId] = useState('');
  const [retItemId, setRetItemId] = useState('');
  const [retQty, setRetQty] = useState(10);
  const [retUnitPrice, setRetUnitPrice] = useState(100);
  const [retReason, setRetReason] = useState('مرتجع بضاعة من العميل');
  const [retDestination, setRetDestination] = useState<QualityDestination>('saleable');
  const [retMessage, setRetMessage] = useState<string | null>(null);

  const finishedProducts = db.items.filter(i => i.itemType === 'finished_product' && i.active);

  // Post a sales return through the engine (reverses revenue/VAT/receivable, restocks goods)
  const handlePostSalesReturn = () => {
    setRetMessage(null);
    if (!retCustomerId) { alert('يرجى اختيار العميل'); return; }
    if (!retItemId) { alert('يرجى اختيار الصنف المرتجع'); return; }
    if (Number(retQty) <= 0) { alert('كمية المرتجع يجب أن تكون أكبر من صفر'); return; }
    if (Number(retUnitPrice) <= 0) { alert('يرجى إدخال سعر البيع الأصلي'); return; }

    const item = db.items.find(i => i.id === retItemId);
    const res = WorkflowService.postSalesReturn({
      customerId: retCustomerId,
      date: new Date().toISOString().split('T')[0],
      reason: retReason.trim() || 'مرتجع بضاعة من العميل',
      lines: [{
        itemId: retItemId,
        quantity: Number(retQty),
        unitPrice: Number(retUnitPrice),
        vatRate: item?.vatRate ?? 0.14,
      }],
      inspectionOverrides: { [retItemId]: retDestination },
    });

    if (!res.success) {
      setRetMessage(`فشل الترحيل: ${res.error}`);
      return;
    }

    setRetMessage(`نجاح الترحيل: تم إصدار مرتجع مبيعات برقم ${res.salesReturn?.returnNumber} بقيمة ${res.salesReturn?.totalAmount.toLocaleString('ar-EG')} ج.م`);
    setRetQty(10);
  };

  // Statement Filters
  const [statementCustomerId, setStatementCustomerId] = useState<string>(db.customers[0]?.id || '');
  const [statementFromDate, setStatementFromDate] = useState(() => {
    const d = new Date();
    d.setDate(1); // 1st of month
    return d.toISOString().split('T')[0];
  });
  const [statementToDate, setStatementToDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [statementDocType, setStatementDocType] = useState<string>('all');

  // New Customer Form State
  const [code, setCode] = useState(`CUST-00${db.customers.length + 1}`);
  const [name, setName] = useState('');
  const [customerType, setCustomerType] = useState<'retail' | 'wholesale' | 'export'>('wholesale');
  const [channel, setChannel] = useState('wholesale');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [taxNumber, setTaxNumber] = useState('');
  const [currency, setCurrency] = useState<'EGP' | 'USD'>('EGP');
  const [creditLimit, setCreditLimit] = useState(100000);
  const [paymentTerms, setPaymentTerms] = useState('آجل 30 يوم');
  const [openingBalanceInput, setOpeningBalanceInput] = useState(0);

  // Payment form state
  const [paymentAmount, setPaymentAmount] = useState(5000);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'bank' | 'cheque'>('cash');
  const [bankAccountId, setBankAccountId] = useState('bank-1');
  const [chequeNumber, setChequeNumber] = useState('');
  const [paymentRef, setPaymentRef] = useState('');
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);

  const handleSaveCustomer = () => {
    if (!name.trim()) {
      alert('يرجى إدخال اسم العميل');
      return;
    }

    // F15: writes go through the guarded master-data service (AuthorizationService).
    const res = MasterDataService.createCustomer({
      code,
      name,
      customerType,
      channel,
      address,
      phone,
      taxNumber,
      currency,
      creditLimit: Number(creditLimit) || 0,
      openingBalance: Number(openingBalanceInput) || 0,
      paymentTerms,
      userId: 'usr-admin',
      userName: 'المشرف العام (Admin)',
    });
    if (!res.success) {
      alert(res.error || 'تعذر حفظ بيانات العميل');
      return;
    }

    setShowAddModal(false);
    setName('');
    setOpeningBalanceInput(0);
  };

  const handleRecordPayment = () => {
    if (!showPaymentModal) return;
    const res = WorkflowService.recordCustomerPayment({
      customerId: showPaymentModal.id,
      amount: Number(paymentAmount),
      currency: showPaymentModal.currency,
      exchangeRate: db.company.currentUsdExchangeRate,
      paymentMethod,
      bankAccountId: paymentMethod === 'bank' ? bankAccountId : undefined,
      chequeNumber: paymentMethod === 'cheque' ? chequeNumber : undefined,
      date: paymentDate,
      reference: paymentRef || 'سند تحصيل عميل',
      userId: 'usr-admin',
      userName: 'المشرف العام (Admin)',
    });

    if (!res.success) {
      alert(res.error || 'خطأ في تسجيل التحصيل');
      return;
    }

    setShowPaymentModal(null);
  };

  // Filtered customer list
  const filteredCustomers = db.customers.filter(c => 
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    c.code.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Selected customer for Statement
  const selectedCustomer = db.customers.find(c => c.id === statementCustomerId);

  // Requirement 4: Customer Statement Computation (REAL Ledger with running balance)
  // F27/F28/F30: the statement is now a projection of the POSTED GL receivable
  // control account (1105 local / 1106 export) — ONE authoritative source. Every
  // customer movement appears: invoices, returns, cash/bank collections, cheques
  // registered on the Cheques screen, cheque bounces, export collections.
  const statement = useMemo(() => {
    if (!selectedCustomer) return null;
    return LedgerService.buildCustomerStatement({
      customerId: selectedCustomer.id,
      fromDate: statementFromDate,
      toDate: statementToDate,
      docType: statementDocType as any,
    });
  }, [selectedCustomer, statementFromDate, statementToDate, statementDocType, db]);

  const statementData = useMemo(() => ({
    openingBalance: statement?.openingBalance || 0,
    entries: statement?.rows || [],
    totalDebit: statement?.totalDebit || 0,
    totalCredit: statement?.totalCredit || 0,
    closingBalance: statement?.closingBalance || 0,
  }), [statement]);

  // Requirement 13: Subledger vs General Ledger Reconciliation Check
  const reconciliation = useMemo(() => {
    // Total subledger balance of all customers
    const subledgerTotalEGP = db.customers.reduce((sum, c) => {
      const rate = c.currency === 'USD' ? db.company.currentUsdExchangeRate : 1;
      return sum + (c.currentBalance * rate);
    }, 0);

    // GL Control Accounts: acc-1105 (Local Customers) + acc-1106 (Export Customers)
    const glLocal = db.accounts.find(a => a.id === 'acc-1105')?.currentBalance || 0;
    const glExport = (db.accounts.find(a => a.id === 'acc-1106')?.currentBalance || 0) * db.company.currentUsdExchangeRate;
    const glControlTotalEGP = glLocal + glExport;

    const diff = Math.abs(subledgerTotalEGP - glControlTotalEGP);
    const isMatched = diff < 0.05;

    return {
      subledgerTotalEGP,
      glControlTotalEGP,
      diff,
      isMatched,
    };
  }, [db]);

  // Export to Excel (CSV with UTF-8 BOM for proper Arabic support)
  const handleExportCSV = () => {
    if (!selectedCustomer) return;
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
      `"كشف حساب عميل: ${selectedCustomer.name} (${selectedCustomer.code})"`,
      `"الفترة من: ${statementFromDate} إلى: ${statementToDate}"`,
      `"الرصيد الافتتاحي: ${statementData.openingBalance.toFixed(2)} ${selectedCustomer.currency}"`,
      headers.join(','),
      ...rows.map(r => r.join(',')),
      `"الإجمالي","","","إجمالي الحركات",${statementData.totalDebit.toFixed(2)},${statementData.totalCredit.toFixed(2)},${statementData.closingBalance.toFixed(2)}`,
      `"الرصيد الختامي المستحق: ${statementData.closingBalance.toFixed(2)} ${selectedCustomer.currency}"`,
    ].join('\r\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `كشف_حساب_${selectedCustomer.code}_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handlePrint = () => {
    printDocument();
  };

  return (
    <div className="space-y-6 text-right">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">إدارة العملاء والحسابات المدينة (Receivables)</h2>
          <p className="text-xs text-slate-500 mt-1">
            سجل العملاء، كشف الحساب التفصيلي مع الرصيد التراكمي، سندات التحصيل، ومطابقة الأستاذ العام
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setCode(`CUST-00${db.customers.length + 1}`);
              setShowAddModal(true);
            }}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>إضافة عميل جديد</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setActiveTab('list')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'list' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          دليل وسجل العملاء ({db.customers.length})
        </button>
        <button
          onClick={() => setActiveTab('statement')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer flex items-center gap-1.5 ${
            activeTab === 'statement' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <FileText className="w-3.5 h-3.5" />
          <span>كشف حساب عميل تفصيلي (Statement)</span>
        </button>
        <button
          onClick={() => setActiveTab('returns')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer flex items-center gap-1.5 ${
            activeTab === 'returns' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Undo2 className="w-3.5 h-3.5" />
          <span>مرتجعات المبيعات ({db.salesReturns.length})</span>
        </button>
      </div>

      {/* Reconciliation Alert Banner (Requirement 13) */}
      {!reconciliation.isMatched && (
        <div className="p-3.5 bg-amber-50 border border-amber-300 rounded-2xl flex items-center gap-2.5 text-xs text-amber-900 font-bold">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
          <span>
            تنبيه المطابقة الرقابية: يوجد فرق يحتاج إلى مراجعة بين إجمالي ميزان العملاء الفرعي ({reconciliation.subledgerTotalEGP.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م) وحساب مراقبة العملاء بالأستاذ العام ({reconciliation.glControlTotalEGP.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م) - الفرق: {reconciliation.diff.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م
          </span>
        </div>
      )}

      {/* TAB 1: CUSTOMERS LIST */}
      {activeTab === 'list' && (
        <div className="space-y-4">
          {/* Search Bar */}
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
            <div className="relative flex-1 max-w-md">
              <input
                type="text"
                placeholder="بحث باسم العميل أو الكود..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pr-9 pl-4 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs focus:outline-none focus:border-amber-500 text-right"
              />
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
            </div>
            <div className="text-xs font-semibold text-slate-500">
              عدد العملاء: <span className="font-bold text-slate-900">{filteredCustomers.length}</span>
            </div>
          </div>

          {/* Table */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold">
                <tr>
                  <th className="p-3.5">الكود</th>
                  <th className="p-3.5">الاسم التجاري</th>
                  <th className="p-3.5">النوع والقناة</th>
                  <th className="p-3.5">الهاتف</th>
                  <th className="p-3.5 text-center">الحد الائتماني</th>
                  <th className="p-3.5 text-center">الرصيد المدين الحالي</th>
                  <th className="p-3.5 text-center">حالة الائتمان</th>
                  <th className="p-3.5 text-center">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredCustomers.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-400">
                      لا يوجد عملاء مسجلون حالياً
                    </td>
                  </tr>
                ) : (
                  filteredCustomers.map(cust => {
                    const isOverLimit = cust.creditLimit > 0 && cust.currentBalance > cust.creditLimit;
                    return (
                      <tr key={cust.id} className="hover:bg-slate-50/80 transition">
                        <td className="p-3.5 font-mono font-bold text-slate-900">{cust.code}</td>
                        <td className="p-3.5 font-bold text-slate-800">{cust.name}</td>
                        <td className="p-3.5">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                            cust.customerType === 'export' ? 'bg-emerald-50 text-emerald-700' : 'bg-purple-50 text-purple-700'
                          }`}>
                            {cust.customerType === 'export' ? 'تصدير (USD)' : cust.customerType === 'wholesale' ? 'جملة' : 'تجزئة'}
                          </span>
                        </td>
                        <td className="p-3.5 font-mono text-slate-600">{cust.phone || '-'}</td>
                        <td className="p-3.5 text-center font-mono">
                          {cust.creditLimit > 0 ? `${cust.creditLimit.toLocaleString('ar-EG')} ${cust.currency}` : 'بلا سقف'}
                        </td>
                        <td className="p-3.5 text-center font-mono font-black text-slate-900">
                          {cust.currentBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {cust.currency}
                        </td>
                        <td className="p-3.5 text-center">
                          {isOverLimit ? (
                            <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-rose-100 text-rose-800 flex items-center justify-center gap-1">
                              <AlertTriangle className="w-3 h-3" />
                              متجاوز للحد
                            </span>
                          ) : (
                            <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-800">
                              ضمن الحد
                            </span>
                          )}
                        </td>
                        <td className="p-3.5 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              onClick={() => {
                                setStatementCustomerId(cust.id);
                                setActiveTab('statement');
                              }}
                              className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold rounded-lg text-xs transition cursor-pointer flex items-center gap-1"
                              title="عرض كشف حساب تفصيلي"
                            >
                              <FileText className="w-3 h-3 text-indigo-600" />
                              <span>كشف الحساب</span>
                            </button>
                            <button
                              onClick={() => {
                                setShowPaymentModal(cust);
                                setPaymentAmount(Math.min(5000, cust.currentBalance > 0 ? cust.currentBalance : 5000));
                              }}
                              className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs transition cursor-pointer"
                            >
                              قبض وتحصيل
                            </button>
                          </div>
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

      {/* TAB 3: SALES RETURNS (posting through WorkflowService) */}
      {activeTab === 'returns' && (
        <div className="space-y-4">
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-3">
            <div>
              <h3 className="font-bold text-sm text-slate-900">تسجيل وترحيل مرتجع مبيعات</h3>
              <p className="text-[11px] text-slate-500 mt-0.5">
                يقوم النظام تلقائيًا بعكس الإيراد والضريبة والمديونية، وإعادة الكمية للمخزون وفق توجيه الجودة، مع عكس تكلفة البضاعة المباعة
              </p>
            </div>

            {retMessage && (
              <div className={`p-3 rounded-xl text-xs font-bold border ${retMessage.includes('نجاح') ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>
                {retMessage}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">العميل *</label>
                <select
                  value={retCustomerId}
                  onChange={(e) => setRetCustomerId(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  <option value="">اختر العميل</option>
                  {db.customers.map(c => (
                    <option key={c.id} value={c.id}>{c.code} - {c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">الصنف المرتجع *</label>
                <select
                  value={retItemId}
                  onChange={(e) => {
                    const it = finishedProducts.find(i => i.id === e.target.value);
                    setRetItemId(e.target.value);
                    if (it) setRetUnitPrice(it.sellingPriceWholesale || it.sellingPriceRetail || 100);
                  }}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  <option value="">اختر الصنف</option>
                  {finishedProducts.map(i => (
                    <option key={i.id} value={i.id}>{i.code} - {i.nameAr}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">الكمية المرتجعة</label>
                <input
                  type="number"
                  min="1"
                  value={retQty}
                  onChange={(e) => setRetQty(Number(e.target.value))}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">سعر البيع الأصلي (قبل الضريبة)</label>
                <input
                  type="number"
                  min="0"
                  value={retUnitPrice}
                  onChange={(e) => setRetUnitPrice(Number(e.target.value))}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">توجيه الجودة</label>
                <select
                  value={retDestination}
                  onChange={(e) => setRetDestination(e.target.value as QualityDestination)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  <option value="saleable">قابل للبيع (مخزون تام محلي)</option>
                  <option value="raw_materials">خامات (إعادة تدوير)</option>
                  <option value="damaged">توالف ومعيب</option>
                  <option value="scrap">هالك / سكراب</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">سبب الإرجاع</label>
                <input
                  type="text"
                  value={retReason}
                  onChange={(e) => setRetReason(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <button
                onClick={handlePostSalesReturn}
                disabled={!retCustomerId || !retItemId}
                className="px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-bold text-xs shadow-md transition cursor-pointer"
              >
                ترحيل المرتجع وإصدار القيود
              </button>
            </div>
          </div>

          {/* Returns history */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="p-4 bg-slate-50 border-b border-slate-200">
              <h3 className="font-bold text-xs text-slate-800">سجل مرتجعات المبيعات المرحّلة</h3>
            </div>
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-100 text-slate-700 font-bold">
                <tr>
                  <th className="p-3">رقم المرتجع</th>
                  <th className="p-3">العميل</th>
                  <th className="p-3">التاريخ</th>
                  <th className="p-3 text-center">الإجمالي</th>
                  <th className="p-3 text-center">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {db.salesReturns.length === 0 ? (
                  <tr><td colSpan={5} className="py-8 text-center text-slate-400">لا توجد مرتجعات مسجلة</td></tr>
                ) : (
                  db.salesReturns.map(r => {
                    const c = db.customers.find(x => x.id === r.customerId);
                    return (
                      <tr key={r.id} className="hover:bg-slate-50">
                        <td className="p-3 font-bold font-mono">{r.returnNumber}</td>
                        <td className="p-3">{c?.name || r.customerId}</td>
                        <td className="p-3 font-mono">{r.date}</td>
                        <td className="p-3 text-center font-mono">{r.totalAmount.toLocaleString('ar-EG')} ج.م</td>
                        <td className="p-3 text-center">{r.status === 'posted' ? 'مرحّل' : r.status}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: REAL CUSTOMER STATEMENT (Requirement 4) */}
      {activeTab === 'statement' && (
        <div className="space-y-5">
          {/* Statement Controls Card */}
          <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-xs space-y-4">
            <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
              {/* Customer Selector */}
              <div className="flex-1">
                <label className="block text-xs font-bold text-slate-700 mb-1">اختيار العميل *</label>
                <select
                  value={statementCustomerId}
                  onChange={(e) => setStatementCustomerId(e.target.value)}
                  className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold text-slate-900 focus:bg-white focus:border-amber-500 focus:outline-none"
                >
                  {db.customers.length === 0 ? (
                    <option value="">لا يوجد عملاء مسجلون</option>
                  ) : (
                    db.customers.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.code} - {c.name} ({c.currency})
                      </option>
                    ))
                  )}
                </select>
              </div>

              {/* Date Filters */}
              <div className="flex items-center gap-2">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">من تاريخ</label>
                  <input
                    type="date"
                    value={statementFromDate}
                    onChange={(e) => setStatementFromDate(e.target.value)}
                    className="p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">إلى تاريخ</label>
                  <input
                    type="date"
                    value={statementToDate}
                    onChange={(e) => setStatementToDate(e.target.value)}
                    className="p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
              </div>

              {/* Document Type Filter */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">نوع المستند</label>
                <select
                  value={statementDocType}
                  onChange={(e) => setStatementDocType(e.target.value)}
                  className="p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  <option value="all">كل المستندات</option>
                  <option value="sales_invoice">فواتير المبيعات فقط (مدين)</option>
                  <option value="customer_payment">سندات التحصيل فقط (دائن)</option>
                  <option value="sales_return">مردودات المبيعات فقط (دائن)</option>
                  <option value="cheque">الشيكات فقط (وارد/صادر)</option>
                  <option value="cheque_bounce">ارتجاع/ارتداد الشيكات فقط</option>
                  <option value="export_collection">تحصيلات التصدير فقط</option>
                </select>
              </div>

              {/* Export Buttons */}
              <div className="flex items-end gap-2 pt-2 md:pt-0">
                <button
                  onClick={handlePrint}
                  className="p-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold transition flex items-center gap-1.5 cursor-pointer"
                  title="طباعة كشف الحساب"
                >
                  <Printer className="w-4 h-4 text-slate-600" />
                  <span className="hidden sm:inline">طباعة</span>
                </button>
                <button
                  onClick={handleExportCSV}
                  className="p-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition flex items-center gap-1.5 cursor-pointer shadow-xs"
                  title="تصدير إلى ملف Excel"
                >
                  <Download className="w-4 h-4" />
                  <span className="hidden sm:inline">Excel</span>
                </button>
              </div>
            </div>
          </div>

          {/* Statement Summary KPI Cards */}
          {selectedCustomer ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs">
                <span className="text-[11px] text-slate-500 font-semibold block">الرصيد الافتتاحي</span>
                <span className="text-lg font-black font-mono text-slate-800 mt-1 block">
                  {statementData.openingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {selectedCustomer.currency}
                </span>
                <span className="text-[10px] text-slate-400">قبل {statementFromDate}</span>
              </div>

              <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs">
                <span className="text-[11px] text-slate-500 font-semibold block">إجمالي المدين (فواتير)</span>
                <span className="text-lg font-black font-mono text-rose-700 mt-1 block">
                  {statementData.totalDebit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {selectedCustomer.currency}
                </span>
                <span className="text-[10px] text-slate-400">مشتريات العميل بالمدة</span>
              </div>

              <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs">
                <span className="text-[11px] text-slate-500 font-semibold block">إجمالي الدائن (سدادات)</span>
                <span className="text-lg font-black font-mono text-emerald-700 mt-1 block">
                  {statementData.totalCredit.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {selectedCustomer.currency}
                </span>
                <span className="text-[10px] text-slate-400">تحصيلات ومرتجعات</span>
              </div>

              <div className="p-4 rounded-2xl bg-amber-50/70 border border-amber-300 shadow-xs">
                <span className="text-[11px] text-amber-900 font-bold block">الرصيد الختامي المستحق</span>
                <span className="text-xl font-black font-mono text-amber-950 mt-1 block">
                  {statementData.closingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {selectedCustomer.currency}
                </span>
                <span className="text-[10px] text-amber-800">
                  {statementData.closingBalance > 0 ? 'مستحق على العميل' : 'رصيد دائن للعميل'}
                </span>
              </div>
            </div>
          ) : null}

          {/* F30: card balance vs statement closing balance reconciliation */}
          {statement && selectedCustomer && (
            <div className={`flex items-center gap-2 p-3 rounded-xl text-xs font-bold border ${
              Math.abs(statement.cardDiff) < 0.05
                ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                : 'bg-rose-50 border-rose-300 text-rose-800'
            }`}>
              <CheckCircle2 className="w-4 h-4" />
              <span>
                رصيد كارت العميل: {statement.cardBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {statement.currency}
                {' • '}رصيد كشف الحساب (GL 1105/1106): {statement.closingBalance.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {statement.currency}
                {Math.abs(statement.cardDiff) < 0.05
                  ? ' • المطابقة سليمة'
                  : ` • فرق غير مغطى: ${statement.cardDiff.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}`}
              </span>
            </div>
          )}

          {/* Statement Ledger Table */}
          <div className="print-area bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden print:border-none print:shadow-none">
            <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
              <div>
                <h3 className="font-bold text-sm text-slate-900">
                  كشف حساب العميل: {selectedCustomer ? `${selectedCustomer.name} (${selectedCustomer.code})` : '—'}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  من {statementFromDate} إلى {statementToDate} • العملة: {selectedCustomer?.currency}
                </p>
              </div>
              <span className="text-xs font-mono font-bold text-slate-700">
                عدد الحركات: {statementData.entries.length}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-100 text-slate-700 font-bold border-b border-slate-200">
                  <tr>
                    <th className="p-3.5 whitespace-nowrap">التاريخ</th>
                    <th className="p-3.5 whitespace-nowrap">رقم المستند</th>
                    <th className="p-3.5 whitespace-nowrap">نوع المستند</th>
                    <th className="p-3.5">البيان</th>
                    <th className="p-3.5 text-left whitespace-nowrap font-mono">مدين (+)</th>
                    <th className="p-3.5 text-left whitespace-nowrap font-mono">دائن (-)</th>
                    <th className="p-3.5 text-left whitespace-nowrap font-mono bg-slate-200/50">الرصيد التراكمي</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {/* Opening Balance Row */}
                  <tr className="bg-slate-50/70 font-semibold text-slate-700">
                    <td className="p-3 font-mono text-slate-500">{statementFromDate}</td>
                    <td className="p-3 font-mono text-slate-400">—</td>
                    <td className="p-3 text-slate-500">رصيد افتتاحي</td>
                    <td className="p-3 text-slate-600">الرصيد المرحل من الفترات السابقة</td>
                    <td className="p-3 text-left font-mono text-slate-400">—</td>
                    <td className="p-3 text-left font-mono text-slate-400">—</td>
                    <td className="p-3 text-left font-mono font-black text-slate-900 bg-slate-100">
                      {statementData.openingBalance.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  </tr>

                  {/* Movements */}
                  {statementData.entries.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-slate-400">
                        لا توجد حركات مالية مسجلة لهذا العميل خلال هذه الفترة
                      </td>
                    </tr>
                  ) : (
                    statementData.entries.map((line, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/80 transition">
                        <td className="p-3.5 text-slate-600 font-mono whitespace-nowrap">{line.date}</td>
                        <td className="p-3.5 font-mono font-bold text-slate-900 whitespace-nowrap">{line.documentNumber}</td>
                        <td className="p-3.5 whitespace-nowrap">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            line.documentType === 'sales_invoice' 
                              ? 'bg-blue-50 text-blue-800 border border-blue-200' 
                              : line.documentType === 'customer_payment'
                              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                              : 'bg-amber-50 text-amber-800 border border-amber-200'
                          }`}>
                            {line.documentTypeLabelAr}
                          </span>
                        </td>
                        <td className="p-3.5 text-slate-800">{line.description}</td>
                        <td className="p-3.5 text-left font-mono font-bold text-rose-700 whitespace-nowrap">
                          {line.debit > 0 ? line.debit.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}
                        </td>
                        <td className="p-3.5 text-left font-mono font-bold text-emerald-700 whitespace-nowrap">
                          {line.credit > 0 ? line.credit.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}
                        </td>
                        <td className="p-3.5 text-left font-mono font-black text-slate-900 whitespace-nowrap bg-slate-50">
                          {line.runningBalance.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                      </tr>
                    ))
                  )}

                  {/* Summary Totals Row */}
                  <tr className="bg-slate-100 font-bold border-t-2 border-slate-300 text-slate-900">
                    <td colSpan={4} className="p-3.5 text-right font-black">
                      إجمالي الحركات والرصيد الختامي المستحق:
                    </td>
                    <td className="p-3.5 text-left font-mono font-black text-rose-700">
                      {statementData.totalDebit.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="p-3.5 text-left font-mono font-black text-emerald-700">
                      {statementData.totalCredit.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="p-3.5 text-left font-mono font-black text-slate-950 bg-amber-100 text-sm">
                      {statementData.closingBalance.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {selectedCustomer?.currency}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Add Customer Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">إضافة عميل جديد للنظام</h3>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-slate-600 cursor-pointer">✕</button>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">كود العميل</label>
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono font-bold"
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
                <label className="block text-xs font-bold text-slate-700 mb-1">اسم العميل / الشركة *</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="مثال: سوبر ماركت البركة"
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">نوع العميل والقناة</label>
                  <select
                    value={customerType}
                    onChange={(e) => setCustomerType(e.target.value as any)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    <option value="wholesale">تاجر جملة</option>
                    <option value="retail">تجزئة وسوبرماركت</option>
                    <option value="export">عميل تصدير خارجي</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">الحد الائتماني المسموح ({currency})</label>
                  <input
                    type="number"
                    value={creditLimit}
                    onChange={(e) => setCreditLimit(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">رقم الهاتف</label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="01000000000"
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">الرقم الضريبي</label>
                  <input
                    type="text"
                    value={taxNumber}
                    onChange={(e) => setTaxNumber(e.target.value)}
                    placeholder="000-000-000"
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">الرصيد الافتتاحي (Opening Balance)</label>
                <input
                  type="number"
                  value={openingBalanceInput}
                  onChange={(e) => setOpeningBalanceInput(Number(e.target.value))}
                  placeholder="0.00"
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs cursor-pointer"
              >
                إلغاء
              </button>
              <button
                onClick={handleSaveCustomer}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md cursor-pointer"
              >
                حفظ العميل
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payment Modal */}
      {showPaymentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-md p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">
                تسجيل سند قبض وتحصيل: {showPaymentModal.name}
              </h3>
              <button onClick={() => setShowPaymentModal(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer">✕</button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">المبلغ المحصل ({showPaymentModal.currency})</label>
                <input
                  type="number"
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(Number(e.target.value))}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono font-bold"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">طريقة التحصيل</label>
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value as any)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  <option value="cash">نقدًا بالخزينة الرئيسية</option>
                  <option value="bank">تحويل / إيداع بنكي</option>
                  <option value="cheque">شيك مصرفي (ورقة قبض)</option>
                </select>
              </div>

              {paymentMethod === 'bank' && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">الحساب البنكي</label>
                  <select
                    value={bankAccountId}
                    onChange={(e) => setBankAccountId(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    {db.bankAccounts.map(b => (
                      <option key={b.id} value={b.id}>{b.bankName}</option>
                    ))}
                  </select>
                </div>
              )}

              {paymentMethod === 'cheque' && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">رقم الشيك المصرفي</label>
                  <input
                    type="text"
                    value={chequeNumber}
                    onChange={(e) => setChequeNumber(e.target.value)}
                    placeholder="مثال: CHQ-88991"
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ السند</label>
                <input
                  type="date"
                  value={paymentDate}
                  onChange={(e) => setPaymentDate(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setShowPaymentModal(null)}
                className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs cursor-pointer"
              >
                إلغاء
              </button>
              <button
                onClick={handleRecordPayment}
                className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-md cursor-pointer"
              >
                تأكيد القبض وترحيل القيد
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
