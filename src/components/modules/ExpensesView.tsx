import React, { useState } from 'react';
import { 
  Receipt, Plus, Tag, Search, DollarSign, 
  Calendar, Building2, User
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { AccountingEngine } from '../../services/accounting';
import { Expense } from '../../types/erp';

export const ExpensesView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [showAddModal, setShowAddModal] = useState(false);

  // Form State
  const [glAccountId, setGlAccountId] = useState('acc-6101');
  const [costCenterId, setCostCenterId] = useState('cc-admin');
  const [salesRepId, setSalesRepId] = useState('');
  const [amount, setAmount] = useState(1500);
  const [vatAmount, setVatAmount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'bank'>('cash');
  const [bankAccountId, setBankAccountId] = useState('bank-1');
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);

  const expenseAccounts = db.accounts.filter(a => 
    !a.isHeader && (a.category === 'Operating Expenses' || a.category === 'COGS')
  );
  const costCenters = db.costCenters.filter(c => c.active);
  const reps = db.salesReps.filter(r => r.active);

  const handleSaveExpense = () => {
    if (amount <= 0) {
      alert('المبلغ يجب أن يكون أكبر من صفر');
      return;
    }

    const count = db.expenses.length + 1;
    const expenseNumber = `EXP-${new Date().getFullYear()}-${String(count).padStart(4, '0')}`;
    const expenseId = `exp-${Date.now()}`;
    const totalAmount = Number(amount) + Number(vatAmount);

    const creditAcc = paymentMethod === 'cash' ? 'acc-1101' : 'acc-1102';
    const acc = db.accounts.find(a => a.id === glAccountId);

    const journalLines = [
      {
        id: '',
        journalEntryId: '',
        accountId: glAccountId,
        accountCode: acc?.code || '6101',
        accountNameAr: acc?.nameAr || 'مصروفات تشغيلية',
        debit: Number(amount),
        credit: 0,
        currency: 'EGP' as const,
        originalAmount: Number(amount),
        exchangeRate: 1,
        costCenterId,
        description: `إثبات مصروف: ${description}`,
      },
      ...(vatAmount > 0 ? [{
        id: '',
        journalEntryId: '',
        accountId: 'acc-1113',
        accountCode: '1113',
        accountNameAr: 'ضريبة القيمة المضافة - مدخلات',
        debit: Number(vatAmount),
        credit: 0,
        currency: 'EGP' as const,
        originalAmount: Number(vatAmount),
        exchangeRate: 1,
        description: `ضريبة مدخلات مصروف ${expenseNumber}`,
      }] : []),
      {
        id: '',
        journalEntryId: '',
        accountId: creditAcc,
        accountCode: creditAcc === 'acc-1101' ? '1101' : '1102',
        accountNameAr: creditAcc === 'acc-1101' ? 'الخزينة الرئيسية' : 'البنك',
        debit: 0,
        credit: totalAmount,
        currency: 'EGP' as const,
        originalAmount: totalAmount,
        exchangeRate: 1,
        description: `سداد مصروف ${expenseNumber}`,
      }
    ];

    const jvRes = AccountingEngine.postJournal({
      date,
      reference: reference || expenseNumber,
      description: `مصروف ${expenseNumber} - ${description}`,
      sourceDocumentType: 'expense',
      sourceDocumentId: expenseId,
      lines: journalLines,
    });

    if (!jvRes.success) {
      alert(jvRes.error || 'خطأ في ترحيل المصروف');
      return;
    }

    erpDb.mutate(draft => {
      draft.expenses.push({
        id: expenseId,
        expenseNumber,
        date,
        glAccountId,
        costCenterId,
        salesRepId: salesRepId || undefined,
        amount: Number(amount),
        vatAmount: Number(vatAmount),
        totalAmount,
        paymentMethod,
        bankAccountId: paymentMethod === 'bank' ? bankAccountId : undefined,
        description,
        reference,
        journalEntryId: jvRes.entry?.id,
      });
    });

    setShowAddModal(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">إدارة المصروفات ومراكز التكلفة (Expenses)</h2>
          <p className="text-xs text-slate-500 mt-1">
            تسجيل مصروفات التشغيل، التوزيع، عمولات المناديب، والربط الدفتري بمراكز التكلفة
          </p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition"
        >
          <Plus className="w-4 h-4" />
          <span>تسجيل إذن صرف مصروف</span>
        </button>
      </div>

      {/* Expenses Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200">
          <h3 className="font-bold text-xs text-slate-800">سجل المصروفات ومراكز التكلفة</h3>
        </div>

        <table className="w-full text-right text-xs">
          <thead className="bg-slate-100 text-slate-700 font-bold">
            <tr>
              <th className="p-3.5">رقم الإذن</th>
              <th className="p-3.5">التاريخ</th>
              <th className="p-3.5">بند الحساب (GL)</th>
              <th className="p-3.5">مركز التكلفة</th>
              <th className="p-3.5">المندوب المنسوب إليه</th>
              <th className="p-3.5">البيان</th>
              <th className="p-3.5 text-center">المبلغ الإجمالي</th>
              <th className="p-3.5 text-center">القيد اليومي</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {db.expenses.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-slate-400">
                  لا توجد مصروفات مسجلة حالياً
                </td>
              </tr>
            ) : (
              db.expenses.map(exp => {
                const acc = db.accounts.find(a => a.id === exp.glAccountId);
                const cc = db.costCenters.find(c => c.id === exp.costCenterId);
                const rep = db.salesReps.find(r => r.id === exp.salesRepId);
                const jv = db.journalEntries.find(j => j.id === exp.journalEntryId);

                return (
                  <tr key={exp.id} className="hover:bg-slate-50">
                    <td className="p-3.5 font-mono font-bold text-slate-900">{exp.expenseNumber}</td>
                    <td className="p-3.5 text-slate-600">{exp.date}</td>
                    <td className="p-3.5 font-bold text-slate-800">{acc?.nameAr}</td>
                    <td className="p-3.5">
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-indigo-50 text-indigo-700">
                        {cc?.nameAr}
                      </span>
                    </td>
                    <td className="p-3.5 text-slate-700">{rep?.name || '-'}</td>
                    <td className="p-3.5 text-slate-600">{exp.description}</td>
                    <td className="p-3.5 text-center font-mono font-black text-rose-700">
                      {exp.totalAmount.toLocaleString('ar-EG')} ج.م
                    </td>
                    <td className="p-3.5 text-center font-mono text-[10px]">
                      {jv?.entryNumber || 'مرحل'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">تسجيل مصروف ومصادقة على الصرف</h3>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">بند المصروف بدليل الحسابات</label>
                <select
                  value={glAccountId}
                  onChange={(e) => setGlAccountId(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  {expenseAccounts.map(a => (
                    <option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">مركز التكلفة</label>
                  <select
                    value={costCenterId}
                    onChange={(e) => setCostCenterId(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    {costCenters.map(cc => (
                      <option key={cc.id} value={cc.id}>{cc.nameAr}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">تنسيب لمندوب مبيعات (إن وجد)</label>
                  <select
                    value={salesRepId}
                    onChange={(e) => setSalesRepId(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    <option value="">بدون مندوب (مصروف إداري/عام)</option>
                    {reps.map(r => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">المبلغ قبل الضريبة (ج.م)</label>
                  <input
                    type="number"
                    min="1"
                    value={amount}
                    onChange={(e) => setAmount(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">ضريبة القيمة المضافة (ج.م)</label>
                  <input
                    type="number"
                    min="0"
                    value={vatAmount}
                    onChange={(e) => setVatAmount(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">طريقة الصرف</label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as any)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    <option value="cash">نقدًا من الخزينة الرئيسية</option>
                    <option value="bank">تحويل / خصم بنكي</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ المصروف</label>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">شرح وبيان المصروف</label>
                <input
                  type="text"
                  placeholder="بيان سبب الصرف والجهة"
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
                onClick={handleSaveExpense}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md"
              >
                تأكيد الصرف وترحيل القيد
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
