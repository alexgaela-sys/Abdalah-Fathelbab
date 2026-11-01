// Warehouses: rename, add, link a storekeeper, disable, and delete ONLY when
// nothing historical references the warehouse.
import React, { useState } from 'react';
import { Boxes, Plus, Power, Save, Trash2 } from 'lucide-react';
import { erpDb } from '../../../services/db';
import {
  CompanySettingsService,
  WAREHOUSE_TYPE_LABELS_AR,
  STOREKEEPER_ROLES,
} from '../../../services/companySettings';
import { Warehouse, WarehouseType, User } from '../../../types/erp';
import { SectionCard } from '../../ui';
import { WarehousesCloudTestPanel } from './WarehousesCloudTestPanel';

const EMPTY_FORM = {
  code: '',
  nameAr: '',
  type: 'raw_materials' as WarehouseType,
  location: '',
  managerUserId: '',
  managerName: '',
};

export const WarehousesSection: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const keepers = db.users.filter(u => STOREKEEPER_ROLES.includes(u.role));
  const input =
    'w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold focus:outline-none focus:ring-2 focus:ring-slate-300';

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, code: `WH-${String(db.warehouses.length + 1).padStart(2, '0')}` });
    setShowForm(true);
  };

  const openEdit = (wh: Warehouse) => {
    setEditing(wh);
    setForm({
      code: wh.code,
      nameAr: wh.nameAr,
      type: wh.type,
      location: wh.location || '',
      managerUserId: wh.managerUserId || '',
      managerName: wh.managerName || '',
    });
    setShowForm(true);
  };

  const handleSave = () => {
    if (!form.code.trim() || !form.nameAr.trim()) {
      setMessage({ tone: 'error', text: 'الكود والاسم مطلوبان' });
      return;
    }
    const keeper = keepers.find(k => k.id === (form.managerUserId || ''));
    const payload = {
      code: form.code.trim(),
      nameAr: form.nameAr.trim(),
      type: form.type,
      location: form.location.trim(),
      managerUserId: form.managerUserId || '',
      managerName: keeper?.name || form.managerName || '',
    };

    if (editing) {
      const res = CompanySettingsService.updateWarehouse(editing.id, payload);
      if (!res.success) {
        setMessage({ tone: 'error', text: res.error || 'تعذّر تعديل المستودع.' });
        return;
      }
      setMessage({ tone: 'ok', text: 'تم تعديل المستودع بنجاح.' });
      setEditing(null);
      setShowForm(false);
      return;
    }

    const res = CompanySettingsService.createWarehouse(payload);
    if (!res.success) {
      setMessage({ tone: 'error', text: res.error || 'تعذّر إضافة المستودع.' });
      return;
    }
    setMessage({ tone: 'ok', text: 'تم إضافة المستودع بنجاح.' });
    setShowForm(false);
  };

  const handleDiscard = () => {
    setEditing(null);
    setShowForm(false);
    setForm({ ...EMPTY_FORM });
    setMessage(null);
  };

  const confirmDelete = (wh: Warehouse) => {
    if (!confirm(`حذف المستودع ${wh.code} (${wh.nameAr})؟ لا يمكن التراجع.`)) return;
    const res = CompanySettingsService.deleteWarehouse(wh.id);
    if (!res.success) {
      alert(res.error);
      return;
    }
    setMessage({ tone: 'ok', text: `تم حذف المستودع ${wh.code}.` });
  };

  function keeperOption(k: User) {
    return (
      <option key={k.id} value={k.id}>
        {k.name} ({k.role === 'Warehouse Manager' ? 'مدير مخازن' : 'أمين مخزن'})
      </option>
    );
  }

  return (
    <SectionCard title="المستودعات">
      {message && (
        <div
          className={`mb-4 p-3 rounded-xl text-xs font-bold ${
            message.tone === 'ok'
              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
              : 'bg-rose-50 text-rose-800 border border-rose-200'
          }`}
        >
          {message.text}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="text-xs text-slate-500">
          <span className="text-slate-400">وضع محلي — تُدار المستودعات من قاعدة البيانات المحلية</span>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" /> إضافة مستودع
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {db.warehouses.map((wh) => (
          <WarehouseCard
            key={wh.id}
            warehouse={wh}
            editing={editing?.id === wh.id}
            onEdit={() => openEdit(wh)}
            onDiscard={handleDiscard}
            onSave={handleSave}
            onDelete={() => confirmDelete(wh)}
            input={input}
            form={form}
            setForm={setForm}
            keepers={keepers}
            keeperOption={keeperOption}
          />
        ))}
      </div>

      {db.warehouses.length === 0 && (
        <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-200 rounded-xl">
          لم تُضاف مستودعات بعد.
        </div>
      )}

      {/* Cloud TEST mode: reads/writes Supabase TEST only. It never uploads,
          replaces or merges the local warehouses rendered above. */}
      <WarehousesCloudTestPanel localCount={db.warehouses.length} />
    </SectionCard>
  );
};

type WarehouseCardProps = {
  warehouse: Warehouse;
  editing: boolean;
  onEdit: () => void;
  onDiscard: () => void;
  onSave: () => void;
  onDelete: () => void;
  input: string;
  form: typeof EMPTY_FORM;
  setForm: React.Dispatch<React.SetStateAction<typeof EMPTY_FORM>>;
  keepers: User[];
  keeperOption: (k: User) => React.ReactElement;
};

export function WarehouseCard({
  warehouse,
  editing,
  onEdit,
  onDiscard,
  onSave,
  onDelete,
  input,
  form,
  setForm,
  keepers,
  keeperOption,
}: WarehouseCardProps) {
  const selectedKeeperId = form.managerUserId || '';

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
      {editing ? (
        <div className="p-3 space-y-2 border-b border-slate-200">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-bold text-slate-600 mb-1">كود المستودع</label>
              <input
                type="text"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                className={input}
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-600 mb-1">نوع المستودع</label>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as WarehouseType })}
                className={input}
              >
                {Object.entries(WAREHOUSE_TYPE_LABELS_AR).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-600 mb-1">أمين المستودع</label>
            <select
              value={selectedKeeperId}
              onChange={(e) => setForm({ ...form, managerUserId: e.target.value })}
              className={input}
            >
              <option value="">— بدون ربط —</option>
              {keepers.length === 0 ? (
                <option disabled>— لا يوجد أمناء —</option>
              ) : (
                keepers.map(keeperOption)
              )}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-600 mb-1">الاسم بالعربية</label>
            <input
              type="text"
              value={form.nameAr}
              onChange={(e) => setForm({ ...form, nameAr: e.target.value })}
              className={input}
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-600 mb-1">الموقع</label>
            <input
              type="text"
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              className={input}
            />
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onDiscard}
              className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-600 hover:bg-slate-100 transition cursor-pointer"
            >
              إلغاء
            </button>
            <button
              type="button"
              onClick={onSave}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 transition cursor-pointer"
            >
              <Save className="w-3 h-3 inline mr-1" /> حفظ
            </button>
          </div>
        </div>
      ) : (
        <div className="p-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Boxes className="w-4 h-4 text-slate-500 shrink-0" />
              <span className="font-bold text-xs text-slate-900">{warehouse.code}</span>
              <span className="text-[10px] text-slate-500">{warehouse.nameAr}</span>
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              {warehouse.location && `${warehouse.location} — `}
              {WAREHOUSE_TYPE_LABELS_AR[warehouse.type] || warehouse.type}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onEdit}
              className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 text-xs transition cursor-pointer"
              title="تعديل"
            >
              <Power className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onDelete}
              className="p-1.5 rounded-lg text-slate-500 hover:bg-rose-50 text-xs transition cursor-pointer"
              title="حذف"
            >
              <Trash2 className="w-3.5 h-3.5 text-rose-600" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
