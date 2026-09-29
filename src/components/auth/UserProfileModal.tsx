import React, { useState } from 'react';
import { 
  User as UserIcon, Lock, Mail, Phone, Shield, 
  Check, AlertCircle, Eye, EyeOff, X, Image as ImageIcon
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { AuthService } from '../../services/auth';
import { RoleName, User } from '../../types/erp';

interface UserProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: User;
  onUserUpdated: (updatedUser: User) => void;
}

export const UserProfileModal: React.FC<UserProfileModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  onUserUpdated,
}) => {
  const [name, setName] = useState(currentUser.name || '');
  const [username, setUsername] = useState(currentUser.username || '');
  const [email, setEmail] = useState(currentUser.email || '');
  const [phone, setPhone] = useState(currentUser.phone || '');
  const [role, setRole] = useState<RoleName>(currentUser.role || 'Super Admin');
  const [active, setActive] = useState<boolean>(currentUser.active ?? true);
  const [avatar, setAvatar] = useState(currentUser.avatar || '');

  // Password change state
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  if (!isOpen) return null;

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

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!name.trim()) {
      setErrorMsg('يرجى إدخال الاسم بالكامل');
      return;
    }
    if (!username.trim()) {
      setErrorMsg('يرجى إدخال اسم المستخدم');
      return;
    }

    if (newPassword) {
      if (newPassword.length < 4) {
        setErrorMsg('كلمة المرور يجب أن تكون 4 أحرف أو أرقام على الأقل');
        return;
      }
      if (newPassword !== confirmPassword) {
        setErrorMsg('كلمتا المرور غير متطابقتين');
        return;
      }
    }

    const previousData = { ...currentUser };
    let updatedUser: User | null = null;

    erpDb.mutate(draft => {
      const u = draft.users.find(x => x.id === currentUser.id);
      if (u) {
        u.name = name.trim();
        u.username = username.trim().toLowerCase();
        u.email = email.trim();
        u.phone = phone.trim();
        u.role = role;
        u.active = active;
        u.avatar = avatar;
        if (newPassword) {
          u.password = newPassword.trim();
        }
        updatedUser = { ...u };
      }

      // Record Audit Log for every modification
      draft.auditLogs.push({
        id: `aud-${Date.now()}`,
        timestamp: new Date().toISOString(),
        userId: currentUser.id,
        userName: currentUser.name,
        module: 'الملف الشخصي والمستخدمين',
        action: 'edit',
        recordId: currentUser.id,
        previousValue: JSON.stringify({ name: previousData.name, username: previousData.username, role: previousData.role }),
        newValue: JSON.stringify({ name: name.trim(), username: username.trim(), role, passwordChanged: !!newPassword }),
        description: `تعديل بيانات الملف الشخصي للمستخدم (${currentUser.name}) [تحديث الصلاحيات وكلمة المرور]`,
      });
    });

    if (updatedUser) {
      // Update session in localStorage
      const currentSession = AuthService.getCurrentSession();
      if (currentSession) {
        currentSession.user = { ...(updatedUser as User) };
        localStorage.setItem('abdullah_erp_auth_session', JSON.stringify(currentSession));
      }
      onUserUpdated(updatedUser);
      setSuccessMsg('تم حفظ التعديلات بنجاح وتحديث الجلسة');
      setTimeout(() => {
        onClose();
      }, 700);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-xs p-4 animate-fade-in" dir="rtl">
      <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden text-right">
        {/* Modal Header */}
        <div className="p-5 bg-gradient-to-r from-slate-900 to-slate-800 text-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-amber-500 text-slate-950 flex items-center justify-center font-bold text-lg shadow-md shadow-amber-500/20">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold">الملف الشخصي للمسؤول (User Profile)</h2>
              <p className="text-xs text-slate-300">تعديل بيانات الحساب، الصلاحيات، وكلمة المرور</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-700 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSave} className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
              <Check className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            {/* Full Name */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                الاسم بالكامل (Full Name)
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="w-full pr-9 pl-3 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs focus:bg-white focus:border-amber-500 focus:outline-none"
                />
                <UserIcon className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>

            {/* Username */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                اسم المستخدم (Username)
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  className="w-full pr-9 pl-3 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono focus:bg-white focus:border-amber-500 focus:outline-none"
                />
                <span className="text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono">@</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            {/* Email */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                البريد الإلكتروني (Email)
              </label>
              <div className="relative">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pr-9 pl-3 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono focus:bg-white focus:border-amber-500 focus:outline-none"
                />
                <Mail className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>

            {/* Phone */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                رقم الهاتف (Phone)
              </label>
              <div className="relative">
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+20 100 0000000"
                  className="w-full pr-9 pl-3 py-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono focus:bg-white focus:border-amber-500 focus:outline-none"
                />
                <Phone className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            {/* Role */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                الدور الوظيفي والصلاحيات (Role)
              </label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as any)}
                className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs focus:bg-white focus:border-amber-500 focus:outline-none"
              >
                {roles.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>

            {/* Active Status */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                حالة الحساب (Status)
              </label>
              <select
                value={active ? 'active' : 'inactive'}
                onChange={(e) => setActive(e.target.value === 'active')}
                className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs focus:bg-white focus:border-amber-500 focus:outline-none"
              >
                <option value="active">نشط ومفعل (Active)</option>
                <option value="inactive">معطل وموقوف (Inactive)</option>
              </select>
            </div>
          </div>

          {/* Secure Password Update Section */}
          <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5 text-amber-600" />
                <span>تغيير كلمة المرور بأمان</span>
              </span>
              <span className="text-[11px] text-slate-400">اتركها فارغة إذا لم ترغب بتغييرها</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-slate-600 mb-1">
                  كلمة المرور الجديدة
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-white border border-slate-300 text-xs font-mono focus:border-amber-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5"
                  >
                    {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-600 mb-1">
                  تأكيد كلمة المرور
                </label>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-3 py-1.5 rounded-lg bg-white border border-slate-300 text-xs font-mono focus:border-amber-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Modal Actions */}
          <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition cursor-pointer"
            >
              إلغاء
            </button>
            <button
              type="submit"
              className="px-6 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition cursor-pointer"
            >
              حفظ التعديلات
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
