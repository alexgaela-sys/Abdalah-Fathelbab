import React, { useState, useMemo } from 'react';
import { 
  FileCheck2, Plus, ArrowDownLeft, ArrowUpRight, 
  Calendar, CheckCircle2, AlertCircle, Clock, Search,
  Printer, Download, Filter, RefreshCw, XCircle
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { Cheque, ChequeType, ChequeStatus } from '../../types/erp';
import { AccountingEngine } from '../../services/accounting';

export const ChequesView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [activeTab, setActiveTab] = useState<'incoming' | 'outgoing'>('incoming');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

  // New Cheque Form State
  const [chequeNumber, setChequeNumber] = useState('');
  const [bankName, setBankName] = useState('بنك مصر');
  const [partyId, setPartyId] = useState('');
  const [amount, setAmount] = useState(10000);
  const [currency, setCurrency] = useState<'EGP' | 'USD'>('EGP');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().split('T')[0]);
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().split('T')[0];
  });
  const [notes, setNotes] = useState('');

  const incomingCheques = useMemo(() => db.cheques.filter(c => c.type === 'incoming'), [db.cheques]);
  const outgoingCheques = useMemo(() => db.cheques.filter(c => c.type === 'outgoing'), [db.cheques]);

  const activeCheques = activeTab === 'incoming' ? incomingCheques : outgoingCheques;

  // Filtered Cheques
  const filteredCheques = useMemo(() => {
    const todayStr = new Date().toISOString().split('T')[0];

    return activeCheques.filter(c => {
      // Status filter
      let matchesStatus = true;
      if (statusFilter === 'pending') {
        matchesStatus = c.status === 'received' || c.status === 'issued';
      } else if (statusFilter === 'due') {
        matchesStatus = (c.status === 'received' || c.status === 'issued' || c.status === 'under_collection') && c.dueDate <= todayStr;
      } else if (statusFilter === 'collected') {
        matchesStatus = c.status === 'collected';
      } else if (statusFilter === 'paid') {
        matchesStatus = c.status === 'paid';
      } else if (statusFilter === 'returned') {
        matchesStatus = c.status === 'bounced';
      }

      // Search filter
      const party = c.partyType === 'customer' 
        ? db.customers.find(x => x.id === c.partyId)?.name || ''
        : db.suppliers.find(x => x.id === c.partyId)?.name || '';

      const matchesSearch = 
        c.chequeNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.bankName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        party.toLowerCase().includes(searchQuery.toLowerCase());

      return matchesStatus && matchesSearch;
    });
  }, [activeCheques, statusFilter, searchQuery, db]);

  // Action handlers
  const handleUpdateStatus = (cheque: Cheque, newStatus: ChequeStatus) => {
    const todayStr = new Date().toISOString().split('T')[0];

    if (newStatus === 'collected' && cheque.type === 'incoming') {
      // Dr Bank acc-1102 / Cr Cheques under collection acc-1104
      const jvRes = AccountingEngine.postJournal({
        date: todayStr,
        reference: `CHQ-COL-${cheque.chequeNumber}`,
        description: `تحصيل وإيداع شيك رقم ${cheque.chequeNumber} بالبنك`,
        sourceDocumentType: 'cheque',
        sourceDocumentId: cheque.id,
        lines: [
          {
            id: '',
            journalEntryId: '',
            accountId: 'acc-1102',
            accountCode: '1102',
            accountNameAr: 'بنك مصر - حساب جاري بالجنيه',
            debit: cheque.amount,
            credit: 0,
            currency: cheque.currency,
            originalAmount: cheque.amount,
            exchangeRate: 1,
            description: `إيداع شيك محصل رقم ${cheque.chequeNumber}`,
          },
          {
            id: '',
            journalEntryId: '',
            accountId: 'acc-1104',
            accountCode: '1104',
            accountNameAr: 'أوراق قبض (شيكات تحت التحصيل)',
            debit: 0,
            credit: cheque.amount,
            currency: cheque.currency,
            originalAmount: cheque.amount,
            exchangeRate: 1,
            description: `تسوية أوراق قبض محصلة ${cheque.chequeNumber}`,
          }
        ],
      }, 'usr-admin', 'المشرف العام (Admin)');

      if (!jvRes.success) {
        alert(jvRes.error || 'خطأ في ترحيل قيد التحصيل');
        return;
      }
    } else if (newStatus === 'paid' && cheque.type === 'outgoing') {
      // Dr Cheques payable acc-2102 / Cr Bank acc-1102
      const jvRes = AccountingEngine.postJournal({
        date: todayStr,
        reference: `CHQ-PAY-${cheque.chequeNumber}`,
        description: `صرف شيك ورقة دفع رقم ${cheque.chequeNumber} من البنك`,
        sourceDocumentType: 'cheque',
        sourceDocumentId: cheque.id,
        lines: [
          {
            id: '',
            journalEntryId: '',
            accountId: 'acc-2102',
            accountCode: '2102',
            accountNameAr: 'أوراق دفع (شيكات صادرة للدفع)',
            debit: cheque.amount,
            credit: 0,
            currency: cheque.currency,
            originalAmount: cheque.amount,
            exchangeRate: 1,
            description: `صرف ورقة دفع شيك رقم ${cheque.chequeNumber}`,
          },
          {
            id: '',
            journalEntryId: '',
            accountId: 'acc-1102',
            accountCode: '1102',
            accountNameAr: 'بنك مصر - حساب جاري بالجنيه',
            debit: 0,
            credit: cheque.amount,
            currency: cheque.currency,
            originalAmount: cheque.amount,
            exchangeRate: 1,
            description: `خصم شيك مصرف للمورد رقم ${cheque.chequeNumber}`,
          }
        ],
      }, 'usr-admin', 'المشرف العام (Admin)');

      if (!jvRes.success) {
        alert(jvRes.error || 'خطأ في ترحيل قيد صرف الشيك');
        return;
      }
    } else if (newStatus === 'bounced') {
      // Cheque bounced / returned
      if (!confirm(`هل أنت متأكد من تسجيل ارتداد الشيك رقم ${cheque.chequeNumber} وإعادته للطرف؟`)) {
        return;
      }
    }

    erpDb.mutate(draft => {
      const c = draft.cheques.find(x => x.id === cheque.id);
      if (c) {
        c.status = newStatus;
        c.statusDate = todayStr;
      }

      draft.auditLogs.push({
        id: `aud-${Date.now()}`,
        timestamp: new Date().toISOString(),
        userId: 'usr-admin',
        userName: 'المشرف العام (Admin)',
        module: 'إدارة الشيكات',
        action: 'edit',
        recordId: cheque.id,
        description: `تحديث حالة الشيك ${cheque.chequeNumber} إلى: ${newStatus}`,
      });
    });
  };

  const handleCreateCheque = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chequeNumber.trim()) {
      alert('يرجى إدخال رقم الشيك');
      return;
    }
    if (!partyId) {
      alert(`يرجى تحديد ${activeTab === 'incoming' ? 'العميل' : 'المورد'}`);
      return;
    }

    const newCheque: Cheque = {
      id: `chq-${Date.now()}`,
      chequeNumber: chequeNumber.trim(),
      type: activeTab,
      partyType: activeTab === 'incoming' ? 'customer' : 'supplier',
      partyId,
      bankName: bankName.trim(),
      amount: Number(amount) || 0,
      currency,
      issueDate,
      dueDate,
      status: activeTab === 'incoming' ? 'received' : 'issued',
      statusDate: issueDate,
      notes: notes.trim(),
    };

    erpDb.mutate(draft => {
      draft.cheques.push(newCheque);
      draft.auditLogs.push({
        id: `aud-${Date.now()}`,
        timestamp: new Date().toISOString(),
        userId: 'usr-admin',
        userName: 'المشرف العام (Admin)',
        module: 'إدارة الشيكات',
        action: 'create',
        recordId: newCheque.id,
        description: `تسجيل شيك ${activeTab === 'incoming' ? 'وارد' : 'صادر'} برقم ${newCheque.chequeNumber} بمبلغ ${newCheque.amount} ${newCheque.currency}`,
      });
    });

    setShowAddModal(false);
    setChequeNumber('');
    setNotes('');
    setAmount(10000);
  };

  const handleExportCSV = () => {
    const isIncoming = activeTab === 'incoming';
    const headers = [
      'رقم الشيك', 
      isIncoming ? 'العميل' : 'المورد', 
      'البنك', 
      'المبلغ', 
      'العملة', 
      'تاريخ الإصدار', 
      'تاريخ الاستحقاق', 
      'الحالة'
    ];

    const rows = filteredCheques.map(c => {
      const party = c.partyType === 'customer' 
        ? db.customers.find(x => x.id === c.partyId)?.name || c.partyId
        : db.suppliers.find(x => x.id === c.partyId)?.name || c.partyId;

      return [
        c.chequeNumber,
        `"${party.replace(/"/g, '""')}"`,
        `"${c.bankName.replace(/"/g, '""')}"`,
        c.amount.toFixed(2),
        c.currency,
        c.issueDate,
        c.dueDate,
        c.status === 'received' ? 'مستلم بالخزينة' : 
        c.status === 'under_collection' ? 'أودع للتحصيل' : 
        c.status === 'collected' ? 'تم التحصيل' : 
        c.status === 'issued' ? 'صادر للمورد' : 
        c.status === 'paid' ? 'مدفوع ومصروف' : 
        c.status === 'bounced' ? 'مرتد ومرفوض' : c.status
      ];
    });

    const csvContent = '\uFEFF' + [
      `"سجل ${isIncoming ? 'الشيكات الواردة (أوراق القبض)' : 'الشيكات الصادرة (أوراق الدفع)'}"`,
      `"تاريخ التقرير: ${new Date().toISOString().split('T')[0]}"`,
      headers.join(','),
      ...rows.map(r => r.join(',')),
    ].join('\r\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `سجل_الشيكات_${activeTab}_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Status counts
  const today = new Date().toISOString().split('T')[0];
  const countAll = activeCheques.length;
  const countPending = activeCheques.filter(c => c.status === 'received' || c.status === 'issued').length;
  const countDue = activeCheques.filter(c => (c.status === 'received' || c.status === 'issued' || c.status === 'under_collection') && c.dueDate <= today).length;
  const countCollectedPaid = activeCheques.filter(c => c.status === 'collected' || c.status === 'paid').length;
  const countReturned = activeCheques.filter(c => c.status === 'bounced').length;

  return (
    <div className="space-y-6 text-right">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-black text-slate-900">سجل الشيكات وأوراق القبض والدفع (Cheque Register)</h2>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-900 text-white font-bold">
              إدارة الأوراق المالية
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            متابعة الشيكات الواردة من العملاء والشيكات الصادرة للموردين، مواعيد الاستحقاق، التحصيل، والصرف المصرفي
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs border border-slate-300 transition cursor-pointer"
            title="طباعة سجل الشيكات"
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
            onClick={() => {
              if (activeTab === 'incoming') {
                setPartyId(db.customers[0]?.id || '');
              } else {
                setPartyId(db.suppliers[0]?.id || '');
              }
              setShowAddModal(true);
            }}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>تسجيل شيك جديد</span>
          </button>
        </div>
      </div>

      {/* Primary Tabs (Incoming / Outgoing) */}
      <div className="flex gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => {
            setActiveTab('incoming');
            setStatusFilter('all');
          }}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'incoming' 
              ? 'bg-slate-900 text-white shadow-xs' 
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <ArrowDownLeft className="w-4 h-4 text-emerald-400" />
          <span>أوراق القبض (الشيكات الواردة من العملاء) ({incomingCheques.length})</span>
        </button>
        <button
          onClick={() => {
            setActiveTab('outgoing');
            setStatusFilter('all');
          }}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'outgoing' 
              ? 'bg-slate-900 text-white shadow-xs' 
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <ArrowUpRight className="w-4 h-4 text-rose-400" />
          <span>أوراق الدفع (الشيكات الصادرة للموردين) ({outgoingCheques.length})</span>
        </button>
      </div>

      {/* Status Filter Buttons (Requirement 9: Pending, Due, Collected, Paid, Returned) */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setStatusFilter('all')}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
            statusFilter === 'all' ? 'bg-slate-800 text-white' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          كافة الشيكات ({countAll})
        </button>
        <button
          onClick={() => setStatusFilter('pending')}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
            statusFilter === 'pending' ? 'bg-amber-600 text-white' : 'bg-white text-amber-800 border border-amber-200 hover:bg-amber-50'
          }`}
        >
          معلق / لم يستحق ({countPending})
        </button>
        <button
          onClick={() => setStatusFilter('due')}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
            statusFilter === 'due' ? 'bg-rose-600 text-white' : 'bg-white text-rose-800 border border-rose-200 hover:bg-rose-50'
          }`}
        >
          مستحق الصرف (Due) ({countDue})
        </button>
        <button
          onClick={() => setStatusFilter(activeTab === 'incoming' ? 'collected' : 'paid')}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
            statusFilter === 'collected' || statusFilter === 'paid' ? 'bg-emerald-600 text-white' : 'bg-white text-emerald-800 border border-emerald-200 hover:bg-emerald-50'
          }`}
        >
          {activeTab === 'incoming' ? 'محصل بالبنك (Collected)' : 'مدفوع ومصروف (Paid)'} ({countCollectedPaid})
        </button>
        <button
          onClick={() => setStatusFilter('returned')}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
            statusFilter === 'returned' ? 'bg-slate-700 text-white' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          مرتد ومرفوض (Returned) ({countReturned})
        </button>
      </div>

      {/* Search Bar */}
      <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="بحث برقم الشيك، اسم البنك، أو اسم الطرف..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pr-9 pl-4 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs focus:outline-none focus:border-amber-500 text-right"
          />
        </div>
        <div className="text-xs font-semibold text-slate-500">
          عدد الشيكات المعروضة: <span className="font-bold text-slate-900">{filteredCheques.length}</span>
        </div>
      </div>

      {/* Cheques Table (Requirement 9) */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <table className="w-full text-right text-xs">
          <thead className="bg-slate-100 text-slate-700 font-bold border-b border-slate-200">
            <tr>
              <th className="p-3.5">رقم الشيك</th>
              <th className="p-3.5">{activeTab === 'incoming' ? 'العميل' : 'المورد'}</th>
              <th className="p-3.5">البنك</th>
              <th className="p-3.5 text-center">المبلغ</th>
              <th className="p-3.5 text-center">تاريخ الإصدار</th>
              <th className="p-3.5 text-center">تاريخ الاستحقاق</th>
              <th className="p-3.5 text-center">الحالة</th>
              <th className="p-3.5 text-center">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredCheques.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-slate-400">
                  لا توجد شيكات مطابقة لمعايير البحث والفلترة المحددة
                </td>
              </tr>
            ) : (
              filteredCheques.map(chq => {
                const party = chq.partyType === 'customer' 
                  ? db.customers.find(c => c.id === chq.partyId)?.name 
                  : db.suppliers.find(s => s.id === chq.partyId)?.name;

                const isDue = (chq.status === 'received' || chq.status === 'issued' || chq.status === 'under_collection') && chq.dueDate <= today;

                return (
                  <tr key={chq.id} className="hover:bg-slate-50 transition">
                    <td className="p-3.5 font-mono font-bold text-slate-900">{chq.chequeNumber}</td>
                    <td className="p-3.5 font-bold text-slate-800">{party || chq.partyId}</td>
                    <td className="p-3.5 text-slate-700">{chq.bankName}</td>
                    <td className="p-3.5 text-center font-mono font-black text-slate-900">
                      {chq.amount.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} {chq.currency}
                    </td>
                    <td className="p-3.5 text-center text-slate-600 font-mono">{chq.issueDate}</td>
                    <td className="p-3.5 text-center font-mono">
                      <span className={isDue ? 'text-rose-700 font-black flex items-center justify-center gap-1' : 'text-slate-800 font-bold'}>
                        {isDue && <Clock className="w-3.5 h-3.5 text-rose-600 inline" />}
                        {chq.dueDate}
                      </span>
                    </td>
                    <td className="p-3.5 text-center">
                      <span className={`text-[10px] px-2.5 py-0.5 rounded-full font-bold ${
                        chq.status === 'collected' || chq.status === 'paid' 
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' 
                          : chq.status === 'under_collection' 
                          ? 'bg-indigo-100 text-indigo-800 border border-indigo-200' 
                          : chq.status === 'bounced'
                          ? 'bg-rose-100 text-rose-800 border border-rose-200'
                          : isDue
                          ? 'bg-rose-50 text-rose-700 border border-rose-200'
                          : 'bg-amber-100 text-amber-800 border border-amber-200'
                      }`}>
                        {chq.status === 'received' ? 'مستلم بالخزينة' : 
                         chq.status === 'under_collection' ? 'أودع للتحصيل' : 
                         chq.status === 'collected' ? 'تم التحصيل' : 
                         chq.status === 'issued' ? 'صادر للمورد' : 
                         chq.status === 'paid' ? 'مدفوع ومصروف' : 
                         chq.status === 'bounced' ? 'مرتد ومرفوض' : chq.status}
                      </span>
                    </td>
                    <td className="p-3.5 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        {chq.type === 'incoming' && chq.status === 'received' && (
                          <button
                            onClick={() => handleUpdateStatus(chq, 'under_collection')}
                            className="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold rounded-lg text-xs border border-indigo-200 cursor-pointer"
                          >
                            إيداع للتحصيل
                          </button>
                        )}
                        {chq.type === 'incoming' && (chq.status === 'under_collection' || chq.status === 'received') && (
                          <button
                            onClick={() => handleUpdateStatus(chq, 'collected')}
                            className="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs cursor-pointer shadow-xs"
                          >
                            تحصيل بالبنك
                          </button>
                        )}
                        {chq.type === 'incoming' && chq.status !== 'collected' && chq.status !== 'bounced' && (
                          <button
                            onClick={() => handleUpdateStatus(chq, 'bounced')}
                            className="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold rounded-lg text-xs border border-rose-200 cursor-pointer"
                          >
                            ارتداد الشيك
                          </button>
                        )}
                        {chq.type === 'outgoing' && chq.status === 'issued' && (
                          <>
                            <button
                              onClick={() => handleUpdateStatus(chq, 'paid')}
                              className="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-lg text-xs cursor-pointer shadow-xs"
                            >
                              صرف من البنك
                            </button>
                            <button
                              onClick={() => handleUpdateStatus(chq, 'bounced')}
                              className="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold rounded-lg text-xs border border-rose-200 cursor-pointer"
                            >
                              إلغاء / ارتداد
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Add New Cheque Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-md p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">
                تسجيل شيك {activeTab === 'incoming' ? 'وارد من عميل (ورقة قبض)' : 'صادر لمورد (ورقة دفع)'}
              </h3>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>

            <form onSubmit={handleCreateCheque} className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  {activeTab === 'incoming' ? 'العميل' : 'المورد'}
                </label>
                <select
                  value={partyId}
                  onChange={(e) => setPartyId(e.target.value)}
                  required
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold focus:bg-white focus:outline-none"
                >
                  <option value="">-- اختر --</option>
                  {activeTab === 'incoming' 
                    ? db.customers.map(c => (
                        <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
                      ))
                    : db.suppliers.map(s => (
                        <option key={s.id} value={s.id}>{s.name} ({s.code})</option>
                      ))
                  }
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">رقم الشيك</label>
                  <input
                    type="text"
                    required
                    placeholder="CHQ-..."
                    value={chequeNumber}
                    onChange={(e) => setChequeNumber(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono font-bold focus:bg-white focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">البنك المسحوب عليه</label>
                  <input
                    type="text"
                    required
                    placeholder="اسم البنك"
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs focus:bg-white focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">المبلغ</label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={amount}
                    onChange={(e) => setAmount(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono font-bold focus:bg-white focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">العملة</label>
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

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ الإصدار</label>
                  <input
                    type="date"
                    required
                    value={issueDate}
                    onChange={(e) => setIssueDate(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono focus:bg-white focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ الاستحقاق</label>
                  <input
                    type="date"
                    required
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono focus:bg-white focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">ملاحظات وبيان</label>
                <input
                  type="text"
                  placeholder="ملاحظات الشيك..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs focus:bg-white focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md"
                >
                  حفظ الشيك بالسجل
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
