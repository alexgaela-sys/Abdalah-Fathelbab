// Warehouses: rename, add, link a storekeeper, disable, and delete ONLY when
// nothing historical references the warehouse.
import React, { useState } from 'react';
import { Boxes, Plus, Power, Save, Trash2 } from 'lucide-react';
import { erpDb } from '../../../services/db';
import {
  CompanySettingsService, WAREHOUSE_TYPE_LABELS_AR, STOREKEEPER_ROLES,
} from '../../../services/companySettings';
import { Warehouse, WarehouseType } from '../../../types/erp';
import { SectionCard } from '../../ui';

const EMPTY_FORM = {
  code: '', nameAr: '', type: 'raw_materials' as WarehouseType, location: '', managerUserId: '', managerName: '',
};

export const WarehousesSection: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const keepers = db.users.filter(u => STOREKEEPER_ROLES.includes(u.role));
  const input = 'w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold focus:outline-none focus:ring-2 focus:ring-slate-300';

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, code: `WH-${String(db.warehouses.length + 1).padStart(2, '0')}` });
    setShowForm(true);
  };

  const openEdit = (wh: Warehouse) => {
    setEditing(wh);
    setForm({
      code: wh.code, nameAr: wh.nameAr, type: wh.type, location: wh.location || '',
      managerUserId: wh.managerUserId || '', managerName: wh.managerName || '',
    });
    setShowForm(true);
  };

  const handleSave = () => {
    const keeper = keepers.find(k => k.id === form.managerUserId);
    const payload = {
      code: form.code,
      nameAr: form.nameAr,
      type: form.type,
      location: form.location,
      managerUserId: form.managerUserId || '',
      managerName: keeper?.name || form.managerName,
    };
    const res = editing
      ? CompanySettingsService.updateWarehouse(editing.id, payload)
      : CompanySettingsService.createWarehouse(payload);
    if (!res.success) {
      setMessage({ tone: 'error', text: res.error || 'تعذر حفظ المستودع' });
      return;
    }
    setShowForm(false);
    setEditing(null);
    setMessage({ tone: 'ok', text: 'تم حفظ المستودع. الحركات والأرصدة التاريخية لم تتغير.' });
  };

  const handleToggle = (wh: Warehouse) => {
    const reason = wh.active
      ? window.prompt('سبب تعطيل المستودع (اختياري) — لن تُحذف أي حركة تاريخية:', 'تعطيل مؤقت')
      : '';
    if (wh.active && reason === null) return;
    const res = CompanySettingsService.setWarehouseActive(wh.id, !wh.active, { reason: reason || undefined });
    setMessage(res.success
      ? { tone: 'ok', text: wh.active ? 'تم تعطيل المستودع — السجلات التاريخية محفوظة كما هي.' : 'تم تنشيط المستودع.' }
      : { tone: 'error', text: res.error || 'تعذر تغيير حالة المستودع' });
  };

  const handleDelete = (wh: Warehouse) => {
    const usage = CompanySettingsService.getWarehouseUsage(wh.id);
    if (usage.total > 0 || usage.stockQuantity > 0) {
      setMessage({
        tone: 'error',
        text: `لا يمكن حذف (${wh.code}): يوجد ${usage.batches} دفعة/صنف و${usage.inventoryTransactions} حركة مخزنية و${usage.salesInvoices} فاتورة بيع مرتبطة به. استخدم التعطيل.`,
      });
      return;
    }
    if (!window.confirm(`حذف المستودع (${wh.code}) نهائيًا؟ لا توجد أي حركات مرتبطة به.`)) return;
    const res = CompanySettingsService.deleteWarehouse(wh.id);
    setMessage(res.success
      ? { tone: 'ok', text: 'تم حذف المستودع غير المستخدم.' }
      : { tone: 'error', text: res.error || 'تعذر حذف المستودع' });
  };

  return (
    <SectionCard
      title="المستودعات"
      hint="تعديل الاسم المعروض، إضافة مستودعات، تعطيل غير المستخدم، ومنع الحذف عند وجود حركات"
      icon={Boxes}
      headerAction={
        <button onClick={openCreate} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs cursor-pointer">
          <Plus className="w-3.5 h-3.5" /> إضافة مستودع
        </button>
      }
    >
      {message && (
        <div className={`mb-4 p-3 rounded-xl text-xs font-bold border ${message.tone === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>
          {message.text}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-right text-xs min-w-[760px]">
          <thead className="bg-slate-100 text-slate-700 font-bold">
            <tr>
              <th className="p-3">الكود</th>
              <th className="p-3">الاسم المعروض</th>
              <th className="p-3">النوع</th>
              <th className="p-3">الموقع</th>
              <th className="p-3">أمين المستودع</th>
              <th className="p-3 text-center">الحركات</th>
              <th className="p-3 text-center">الحالة</th>
              <th className="p-3 text-center">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {db.warehouses.map(wh => {
              const usage = CompanySettingsService.getWarehouseUsage(wh.id);
              return (
                <tr key={wh.id} className={wh.active ? 'hover:bg-slate-50' : 'bg-slate-50/60 text-slate-400'}>
                  <td className="p-3 font-mono font-black text-slate-900">{wh.code}</td>
                  <td className="p-3 font-bold text-slate-800">{wh.nameAr}</td>
                  <td className="p-3">{WAREHOUSE_TYPE_LABELS_AR[wh.type] || wh.type}</td>
                  <td className="p-3">{wh.location || '—'}</td>
                  <td className="p-3">{wh.managerName || '—'}</td>
                  <td className="p-3 text-center font-mono text-[11px]">{usage.total}</td>
                  <td className="p-3 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${wh.active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}>
                      {wh.active ? 'نشط' : 'معطل'}
                    </span>
                  </td>
                  <td className="p-3">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => openEdit(wh)} className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-bold cursor-pointer">تعديل</button>
                      <button onClick={() => handleToggle(wh)} className={`px-2 py-1 rounded-lg text-[10px] font-bold cursor-pointer ${wh.active ? 'bg-amber-50 text-amber-700 hover:bg-amber-100' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}>
                        {wh.active ? 'تعطيل' : 'تنشيط'}
                      </button>
                      <button onClick={() => handleDelete(wh)} className="px-2 py-1 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 text-[10px] font-bold cursor-pointer">حذف</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] text-slate-500 leading-relaxed">
        تغيير الاسم أو الكود لا يعيد كتابة أي فاتورة أو حركة سابقة — المستندات تحتفظ بمعرّف المستودع الأصلي.
        الحذف متاح فقط للمستودعات التي لا تحتوي أي دفعات أو حركات أو فواتير أو أوامر إنتاج، وإلا فيجب التعطيل.
      </p>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg p-6 text-right space-y-3">
            <h3 className="font-black text-sm text-slate-900 pb-2 border-b border-slate-200">
              {editing ? `تعديل المستودع ${editing.code}` : 'إضافة مستودع جديد'}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">الكود *</label>
                <input className={input} dir="ltr" value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">النوع</label>
                <select className={input} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as WarehouseType }))}>
                  {(Object.keys(WAREHOUSE_TYPE_LABELS_AR) as WarehouseType[]).map(t => (
                    <option key={t} value={t}>{WAREHOUSE_TYPE_LABELS_AR[t]}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-700 mb-1">الاسم المعروض *</label>
              <input className={input} value={form.nameAr} onChange={e => setForm(f => ({ ...f, nameAr: e.target.value }))} />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-700 mb-1">الموقع</label>
              <input className={input} value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-700 mb-1">أمين المستودع</label>
              <select className={input} value={form.managerUserId} onChange={e => setForm(f => ({ ...f, managerUserId: e.target.value }))}>
                <option value="">— بدون ربط —</option>
                {keepers.map(k => (
                  <option key={k.id} value={k.id}>{k.name} ({k.role === 'Warehouse Manager' ? 'مدير مخازن' : 'أمين مخزن'})</option>
                ))}
              </select>
              {keepers.length === 0 && <p className="text-[10px] text-amber-700 mt-1">أضف أمناء المخازن من تبويب «أمناء المخازن» لربطهم هنا.</p>}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs cursor-pointer">إلغاء</button>
              <button onClick={handleSave} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs cursor-pointer">
                <Save className="w-3.5 h-3.5" /> حفظ
              </button>
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  );
};
