// Warehouse keepers: create/edit, link to warehouses, grant module permissions,
// and disable without deleting the user or any historical record.
import React, { useState } from 'react';
import { UserCheck, Plus, Save } from 'lucide-react';
import { erpDb } from '../../../services/db';
import { CompanySettingsService, STOREKEEPER_MODULES, STOREKEEPER_ROLES } from '../../../services/companySettings';
import { ACTION_LABELS_AR, ASSIGNABLE_ACTIONS, MODULE_LABELS_AR, ModuleKey, PermissionService } from '../../../services/permissions';
import { PermissionAction, RoleName, User } from '../../../types/erp';
import { SectionCard } from '../../ui';

const ROLE_AR: Record<string, string> = {
  'Warehouse Manager': 'مدير مخازن',
  'Warehouse Employee': 'أمين مخزن',
};

const EMPTY = {
  name: '', username: '', password: '', email: '', phone: '',
  role: 'Warehouse Employee' as RoleName,
  warehouseIds: [] as string[],
  permissions: {} as Record<string, PermissionAction[]>,
};

export const StorekeepersSection: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [form, setForm] = useState({ ...EMPTY });
  const [editing, setEditing] = useState<User | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const keepers = db.users.filter(u => STOREKEEPER_ROLES.includes(u.role));
  const input = 'w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold focus:outline-none focus:ring-2 focus:ring-slate-300';

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY, warehouseIds: db.warehouses.filter(w => w.active).slice(0, 1).map(w => w.id) });
    setShowForm(true);
  };

  const openEdit = (user: User) => {
    setEditing(user);
    setForm({
      name: user.name,
      username: user.username,
      password: '',
      email: user.email || '',
      phone: user.phone || '',
      role: user.role,
      warehouseIds: [...(user.warehouseIds || [])],
      permissions: { ...(user.permissions || {}) },
    });
    setShowForm(true);
  };

  const toggleWarehouse = (id: string) => setForm(f => ({
    ...f,
    warehouseIds: f.warehouseIds.includes(id) ? f.warehouseIds.filter(x => x !== id) : [...f.warehouseIds, id],
  }));

  const togglePermission = (module: ModuleKey, action: PermissionAction) => setForm(f => {
    const current = f.permissions[module] || [];
    const next = current.includes(action) ? current.filter(a => a !== action) : [...current, action];
    const permissions = { ...f.permissions };
    if (next.length) permissions[module] = next; else delete permissions[module];
    return { ...f, permissions };
  });

  const handleSave = () => {
    const payload = {
      name: form.name,
      username: form.username,
      email: form.email,
      phone: form.phone,
      role: form.role,
      warehouseIds: form.warehouseIds,
      permissions: form.permissions,
      ...(form.password ? { password: form.password } : {}),
    };
    const res = editing
      ? CompanySettingsService.updateStorekeeper(editing.id, payload)
      : CompanySettingsService.createStorekeeper({ ...payload, password: form.password });
    if (!res.success) {
      setMessage({ tone: 'error', text: res.error || 'تعذر حفظ بيانات أمين المخزن' });
      return;
    }
    setShowForm(false);
    setEditing(null);
    setMessage({ tone: 'ok', text: 'تم حفظ بيانات أمين المخزن وربطه بالمستودعات والصلاحيات.' });
  };

  const handleToggle = (user: User) => {
    const res = CompanySettingsService.setStorekeeperActive(user.id, !user.active, {
      reason: user.active ? 'إيقاف إداري' : undefined,
    });
    setMessage(res.success
      ? { tone: 'ok', text: user.active ? 'تم إيقاف الحساب — سجلاته التاريخية وصلاحياته محفوظة.' : 'تم تنشيط الحساب.' }
      : { tone: 'error', text: res.error || 'تعذر تغيير حالة الحساب' });
  };

  return (
    <SectionCard
      title="أمناء المخازن"
      hint="بيانات الأمين، ربطه بالمستودعات والصلاحيات، وإيقافه دون حذف سجلاته"
      icon={UserCheck}
      headerAction={
        <button onClick={openCreate} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs cursor-pointer">
          <Plus className="w-3.5 h-3.5" /> إضافة أمين مخزن
        </button>
      }
    >
      {message && (
        <div className={`mb-4 p-3 rounded-xl text-xs font-bold border ${message.tone === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>
          {message.text}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-right text-xs min-w-[720px]">
          <thead className="bg-slate-100 text-slate-700 font-bold">
            <tr>
              <th className="p-3">الاسم</th>
              <th className="p-3">اسم الدخول</th>
              <th className="p-3">الدور</th>
              <th className="p-3">المستودعات</th>
              <th className="p-3 text-center">صلاحيات مخصصة</th>
              <th className="p-3 text-center">الحالة</th>
              <th className="p-3 text-center">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {keepers.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-slate-500">لا يوجد أمناء مخازن مسجلون بعد.</td></tr>
            )}
            {keepers.map(user => {
              const warehouses = (user.warehouseIds || []).map(id => db.warehouses.find(w => w.id === id)?.nameAr).filter(Boolean);
              return (
                <tr key={user.id} className={user.active ? 'hover:bg-slate-50' : 'bg-slate-50/60 text-slate-400'}>
                  <td className="p-3 font-bold text-slate-800">{user.name}</td>
                  <td className="p-3 font-mono">{user.username}</td>
                  <td className="p-3">{ROLE_AR[user.role] || user.role}</td>
                  <td className="p-3">{warehouses.length ? warehouses.join(' · ') : '—'}</td>
                  <td className="p-3 text-center font-mono">{Object.keys(user.permissions || {}).length}</td>
                  <td className="p-3 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${user.active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}>
                      {user.active ? 'نشط' : 'موقوف'}
                    </span>
                  </td>
                  <td className="p-3">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => openEdit(user)} className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-bold cursor-pointer">تعديل</button>
                      <button onClick={() => handleToggle(user)} className={`px-2 py-1 rounded-lg text-[10px] font-bold cursor-pointer ${user.active ? 'bg-amber-50 text-amber-700 hover:bg-amber-100' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}>
                        {user.active ? 'إيقاف' : 'تنشيط'}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] text-slate-500 leading-relaxed">
        الإيقاف لا يحذف الحساب ولا أي سجل تاريخي: تبقى حركاته وقيوده ومستودعاته كما هي، ويُمنع فقط من تسجيل الدخول.
        الصلاحيات المخصصة تتجاوز مصفوفة الدور لهذا المستخدم فقط، والمشرف العام يحتفظ بكل الصلاحيات دائمًا.
      </p>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl p-6 text-right space-y-3 my-6">
            <h3 className="font-black text-sm text-slate-900 pb-2 border-b border-slate-200">
              {editing ? `تعديل أمين المخزن: ${editing.name}` : 'إضافة أمين مخزن جديد'}
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">الاسم *</label>
                <input className={input} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">اسم الدخول *</label>
                <input className={input} dir="ltr" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  كلمة المرور {editing ? '(اتركها فارغة للإبقاء عليها)' : '*'}
                </label>
                <input className={input} dir="ltr" type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">الدور *</label>
                <select className={input} value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value as RoleName }))}>
                  {STOREKEEPER_ROLES.map(r => <option key={r} value={r}>{ROLE_AR[r]}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">البريد الإلكتروني</label>
                <input className={input} dir="ltr" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">الهاتف</label>
                <input className={input} dir="ltr" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
              </div>
            </div>

            <div>
              <div className="text-[11px] font-bold text-slate-700 mb-1">المستودعات المسؤول عنها *</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {db.warehouses.map(wh => (
                  <label key={wh.id} className={`flex items-center gap-2 p-2 rounded-xl border text-[11px] font-bold cursor-pointer ${form.warehouseIds.includes(wh.id) ? 'border-slate-900 bg-slate-50 text-slate-900' : 'border-slate-200 text-slate-600'} ${wh.active ? '' : 'opacity-60'}`}>
                    <input type="checkbox" checked={form.warehouseIds.includes(wh.id)} onChange={() => toggleWarehouse(wh.id)} />
                    <span>{wh.code} — {wh.nameAr}{wh.active ? '' : ' (معطل)'}</span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-bold text-slate-700 mb-1">الصلاحيات المخصصة (اختياري — تتجاوز مصفوفة الدور)</div>
              <div className="space-y-2 max-h-56 overflow-y-auto border border-slate-200 rounded-xl p-2">
                {STOREKEEPER_MODULES.map(module => {
                  const roleDefaults = PermissionService.getActions(form.role, module);
                  return (
                    <div key={module} className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="w-36 font-bold text-slate-700 shrink-0">{MODULE_LABELS_AR[module]}</span>
                      {ASSIGNABLE_ACTIONS.map(action => {
                        const checked = (form.permissions[module] || []).includes(action);
                        return (
                          <label key={action} className={`px-2 py-0.5 rounded-full border cursor-pointer ${checked ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200'} ${roleDefaults.includes(action) ? 'ring-1 ring-emerald-300' : ''}`}>
                            <input type="checkbox" className="hidden" checked={checked} onChange={() => togglePermission(module, action)} />
                            {ACTION_LABELS_AR[action]}
                          </label>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
              <p className="text-[10px] text-slate-500 mt-1">الإطار الأخضر = صلاحية يمنحها الدور افتراضيًا. بدون تخصيص، يعمل المستخدم بمصفوفة دوره.</p>
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
