import React, { useState } from 'react';
import { 
  KeyRound, Plus, Shield, UserCheck, 
  Lock, Check, Trash2, Key
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { RoleName, User } from '../../types/erp';

export const UsersView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [showAddModal, setShowAddModal] = useState(false);

  // Form State
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('12345');
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

    const newUser: User = {
      id: `usr-${Date.now()}`,
      username: username.trim().toLowerCase(),
      password: password.trim() || '12345',
      name: name.trim(),
      email: email.trim(),
      role,
      active: true,
      createdAt: new Date().toISOString(),
    };

    erpDb.mutate(draft => {
      draft.users.push(newUser);
    });

    setShowAddModal(false);
    setName('');
    setUsername('');
    setPassword('12345');
    setEmail('');
  };

  const handleDeleteUser = (userId: string, userName: string) => {
    if (userId === 'usr-admin') {
      alert('لا يمكن حذف حساب المشرف العام الأساسي للنظام');
      return;
    }
    if (confirm(`هل أنت متأكد من حذف المستخدم "${userName}"؟`)) {
      erpDb.mutate(draft => {
        draft.users = draft.users.filter(u => u.id !== userId);
      });
    }
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
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition cursor-pointer"
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
                    {u.password ? '•••••' : '12345'}
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
                  {u.id !== 'usr-admin' && u.username !== 'admin' && (
                    <button
                      onClick={() => handleDeleteUser(u.id, u.name)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer"
                      title="حذف المستخدم"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
                <label className="block text-xs font-bold text-slate-700 mb-1">كلمة المرور (Password)</label>
                <input
                  type="text"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="12345"
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
