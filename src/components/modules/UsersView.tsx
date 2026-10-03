import React, { useState } from 'react';
import { useModuleWriteAccess } from '../../hooks/usePermissions';
import { 
  KeyRound, Plus, Shield, UserCheck, 
  Lock, Check, Trash2, Key
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { MasterDataService } from '../../services/masterData';
import { RoleName, User, PermissionAction } from '../../types/erp';
import {
  ALL_MODULES, ASSIGNABLE_ACTIONS, MODULE_LABELS_AR, ACTION_LABELS_AR,
  PermissionService, ModuleKey,
} from '../../services/permissions';

export const UsersView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [showAddModal, setShowAddModal] = useState(false);
  // QA-25: UI permission affordance (service authorization stays the real wall).
  const writeAccess = useModuleWriteAccess('users', 'إدارة المستخدمين');
  // F23: explicit per-user, per-module, per-action permission assignment.
  const [permUserId, setPermUserId] = useState<string>('');
  const [permDraft, setPermDraft] = useState<Record<string, PermissionAction[]>>({});

  // Form State
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  // F15: no default password — the admin must type one explicitly.
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<RoleName>('Chief Accountant');

  const roles: RoleName[] = [
    'Super Admin',
    'General Manager',
    'Chief Accountant',
    'Accountant',
    'Cost Accountant',
    'Warehouse Manager',
    'Warehouse Employee',
    'Sales Manager',
    'Sales Representative',
    'Purchasing Manager',
    'Production Manager',
    'Treasury Accountant',
    'Viewer'
  ];

  const handleSaveUser = () => {
    if (!name.trim() || !username.trim()) {
      alert('يرجى إدخال اسم المستخدم وبياناته');
      return;
    }
    if (!password.trim()) {
      alert('كلمة المرور مطلوبة — لا يوجد كلمة مرور افتراضية (الحد الأدنى 6 أحرف)');
      return;
    }

    // F15: guarded service write; password is mandatory (no insecure default).
    const res = MasterDataService.createUser({
      username,
      password,
      name,
      email,
      role,
      userId: 'usr-admin',
      userName: 'المشرف العام (Admin)',
    });
    if (!res.success) {
      alert(res.error || 'تعذر إنشاء المستخدم');
      return;
    }

    setShowAddModal(false);
    setName('');
    setUsername('');
    setPassword('');
    setEmail('');
  };

  const handleDeleteUser = (userId: string, userName: string) => {
    if (userId === 'usr-admin') {
      alert('لا يمكن حذف حساب المشرف العام الأساسي للنظام');
      return;
    }
    if (confirm(`هل أنت متأكد من حذف المستخدم "${userName}"؟`)) {
      const res = MasterDataService.deleteUser(userId, {
        userId: 'usr-admin', userName: 'المشرف العام (Admin)',
      });
      if (!res.success) alert(res.error || 'تعذر حذف المستخدم');
    }
  };

  // ---------- F23: permission matrix ----------
  const editableUsers = db.users.filter(u => u.role !== 'Super Admin');
  const activePermUser = db.users.find(u => u.id === permUserId) || null;

  const loadPermissions = (userId: string) => {
    setPermUserId(userId);
    const u = db.users.find(x => x.id === userId);
    setPermDraft(u?.permissions ? { ...u.permissions } : {});
  };

  const togglePerm = (module: ModuleKey, action: PermissionAction) => {
    const cur = permDraft[module] || PermissionService.getActions(activePermUser?.role || 'Viewer', module);
    const next = cur.includes(action) ? cur.filter(a => a !== action) : [...cur, action];
    setPermDraft({ ...permDraft, [module]: next });
  };

  const savePermissions = () => {
    if (!permUserId) return;
    const res = MasterDataService.updateUserPermissions({
      userId: permUserId,
      permissions: permDraft as Record<string, string[]>,
      options: { userId: 'usr-admin', userName: 'المشرف العام (Admin)' },
    });
    if (!res.success) { alert(res.error || 'تعذر حفظ الصلاحيات'); return; }
    alert('تم حفظ الصلاحيات — يسري المبدأ فورًا على مستوى الخدمات (AuthorizationService)');
  };

  const resetPermissions = () => {
    if (!permUserId) return;
    const res = MasterDataService.resetUserPermissions(permUserId, {
      userId: 'usr-admin', userName: 'المشرف العام (Admin)',
    });
    if (!res.success) { alert(res.error || 'تعذر إلغاء التخصيص'); return; }
    setPermDraft({});
    alert('تم إلغاء التخصيص والعودة إلى صلاحيات الدور');
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">المستخدمون والصلاحيات (Users & RBAC)</h2>
          <p className="text-xs text-slate-500 mt-1">
            إدارة حسابات الفريق وصلاحيات الدخول (المشرف العام، المدير المالي، مديري الإنتاج والمخازن)
          </p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          disabled={!writeAccess.canCreate}
          title={writeAccess.canCreate ? '' : writeAccess.createDeniedTitle}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus className="w-4 h-4" />
          <span>إضافة مستخدم جديد</span>
        </button>
      </div>

      {/* Users Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <table className="w-full text-right text-xs">
          <thead className="bg-slate-100 text-slate-700 font-bold">
            <tr>
              <th className="p-3.5">اسم الموظف / المسؤول</th>
              <th className="p-3.5">اسم الدخول (Username)</th>
              <th className="p-3.5">كلمة المرور</th>
              <th className="p-3.5">الدور الوظيفي (Role)</th>
              <th className="p-3.5 text-center">الحالة</th>
              <th className="p-3.5 text-center">آخر تسجيل دخول</th>
              <th className="p-3.5 text-center">الإجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {db.users.map(u => (
              <tr key={u.id} className="hover:bg-slate-50">
                <td className="p-3.5 font-bold text-slate-900">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-full bg-slate-900 text-amber-400 flex items-center justify-center font-bold text-xs shadow-xs">
                      {u.role === 'Super Admin' ? <Shield className="w-4 h-4 text-amber-400" /> : u.name.charAt(0)}
                    </div>
                    <div>
                      <div className="font-bold text-slate-900">{u.name}</div>
                      <div className="text-[11px] text-slate-400 font-mono">{u.email || '—'}</div>
                    </div>
                  </div>
                </td>
                <td className="p-3.5 font-mono font-bold text-slate-800">@{u.username}</td>
                <td className="p-3.5 font-mono text-slate-500">
                  <span className="px-2 py-0.5 rounded bg-slate-100 border border-slate-200 text-[11px]">
                    {u.password ? '•••••' : '—'}
                  </span>
                </td>
                <td className="p-3.5 font-bold text-indigo-700">
                  <span className={`px-2.5 py-1 rounded-full text-xs font-bold border ${
                    u.role === 'Super Admin' 
                      ? 'bg-amber-50 text-amber-900 border-amber-300' 
                      : 'bg-indigo-50 text-indigo-800 border-indigo-200'
                  }`}>
                    {u.role}
                  </span>
                </td>
                <td className="p-3.5 text-center">
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-800">
                    نشط ومفعل
                  </span>
                </td>
                <td className="p-3.5 text-center text-slate-500 font-mono text-[11px]">
                  {u.lastLogin ? u.lastLogin.replace('T', ' ').substring(0, 16) : '—'}
                </td>
                <td className="p-3.5 text-center">
                  <div className="flex items-center justify-center gap-1.5">
                    {u.role !== 'Super Admin' && (
                      <button
                        onClick={() => loadPermissions(u.id)}
                        className={`p-1.5 rounded-lg transition cursor-pointer ${
                          permUserId === u.id ? 'bg-amber-100 text-amber-800' : 'text-slate-400 hover:text-amber-600 hover:bg-amber-50'
                        }`}
                        title="تخصيص الصلاحيات"
                      >
                        <Shield className="w-4 h-4" />
                      </button>
                    )}
                    {u.id !== 'usr-admin' && u.username !== 'admin' && (
                      <button
                        onClick={() => handleDeleteUser(u.id, u.name)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer"
                        title="حذف المستخدم"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* F23: EXPLICIT permission matrix (per module x per action) */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-black text-slate-900">إدارة صلاحيات المستخدمين (Permissions Matrix)</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              تخصيص صريح لكل مستخدم: عرض / إضافة / تعديل / حذف / اعتماد / ترحيل لكل نموذج. الحد الحقيقي للتنفيذ هو
              ‏AuthorizationService على مستوى الخدمات — الواجهة ترسيخ إضافي فقط ولا يمكن منح صلاحيات بتعديل المتصفح.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={permUserId}
              onChange={(e) => loadPermissions(e.target.value)}
              className="p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold"
            >
              <option value="">— اختر مستخدمًا —</option>
              {editableUsers.map(u => (
                <option key={u.id} value={u.id}>{u.name} ({u.username}) — {u.role}</option>
              ))}
            </select>
            <button
              onClick={savePermissions}
              disabled={!permUserId}
              className="px-3 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold disabled:opacity-40 cursor-pointer"
            >
              حفظ
            </button>
            <button
              onClick={resetPermissions}
              disabled={!permUserId}
              className="px-3 py-2 rounded-xl bg-slate-100 text-slate-700 text-xs font-bold disabled:opacity-40 cursor-pointer"
            >
              إلغاء التخصيص
            </button>
          </div>
        </div>

        {activePermUser ? (
          <>
            <div className="text-[11px] text-slate-600 bg-slate-50 rounded-xl p-2">
              المستخدم: <b>{activePermUser.name}</b> — الدور: <b>{activePermUser.role}</b>.
              التخصيص الصريح يطغى على الدور في الوحدات المحددة فقط؛ باقي الوحدات تتبع مصفوفة الدور.
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-[11px]">
                <thead className="bg-slate-100 text-slate-700 font-bold">
                  <tr>
                    <th className="p-2">النموذج</th>
                    {ASSIGNABLE_ACTIONS.map(a => (
                      <th key={a} className="p-2 text-center">{ACTION_LABELS_AR[a]}</th>
                    ))}
                    <th className="p-2 text-center">مصدر</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ALL_MODULES.map(m => {
                    const explicit = permDraft[m];
                    const effective = explicit || PermissionService.getActions(activePermUser.role, m);
                    return (
                      <tr key={m}>
                        <td className="p-2 font-bold text-slate-800">{MODULE_LABELS_AR[m]}</td>
                        {ASSIGNABLE_ACTIONS.map(a => (
                          <td key={a} className="p-2 text-center">
                            <input
                              type="checkbox"
                              checked={effective.includes(a)}
                              onChange={() => togglePerm(m, a)}
                              className="w-4 h-4 accent-slate-900 cursor-pointer"
                            />
                          </td>
                        ))}
                        <td className="p-2 text-center">
                          <span className={`px-2 py-0.5 rounded-full font-bold ${
                            explicit ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'
                          }`}>
                            {explicit ? 'تخصيص صريح' : 'الدور'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="text-xs text-slate-400">اختر مستخدمًا لعرض وتخصيص صلاحياته.</p>
        )}
      </div>

      {/* Add User Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-md p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">إضافة مستخدم جديد للنظام</h3>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-slate-700 cursor-pointer">✕</button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">اسم الموظف الثلاثي</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="مثال: أحمد عبد الرحمن"
                  className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">اسم الدخول (Username)</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="ahmed"
                  className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">كلمة المرور (Password) — إجبارية، 6 أحرف فأكثر</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••"
                  className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">البريد الإلكتروني</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="ahmed@abdullah-erp.com"
                  className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">الدور الوظيفي والصلاحيات</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as any)}
                  className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                >
                  {roles.map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
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
                onClick={handleSaveUser}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md cursor-pointer"
              >
                إنشاء المستخدم
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
