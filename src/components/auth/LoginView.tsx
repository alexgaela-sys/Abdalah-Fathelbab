import React, { useState } from 'react';
import {
  Lock, User as UserIcon, Shield, Eye, EyeOff,
  AlertCircle, ArrowLeft, Building2, Factory
} from 'lucide-react';
import { AuthService } from '../../services/auth';
import { User } from '../../types/erp';

interface LoginViewProps {
  onLoginSuccess: (user: User) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setIsLoading(true);

    setTimeout(() => {
      const result = AuthService.login(username, password);
      setIsLoading(false);

      if (result.success && result.session) {
        onLoginSuccess(result.session.user);
      } else {
        setErrorMsg(result.messageAr || 'تعذر تسجيل الدخول، يرجى التحقق من البيانات');
      }
    }, 200);
  };

  return (
    <div
      className="min-h-screen bg-cream-100 flex flex-col justify-center items-center p-4 sm:p-6 font-sans text-ink-900 antialiased relative overflow-hidden"
      dir="rtl"
    >
      {/* SnakDip brand ambient shapes */}
      <div className="absolute top-1/4 -right-24 w-96 h-96 bg-brand-100 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 -left-24 w-96 h-96 bg-cream-300/60 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute top-0 left-0 w-72 h-72 bg-brand-50 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-md z-10 space-y-6 animate-slide-up">
        {/* Brand & System Title */}
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-brand-500 shadow-brand border border-brand-400/60">
            <span className="font-black text-2xl text-white tracking-tight">
              S<span className="text-ink-950">D</span>
            </span>
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-black text-ink-900 tracking-tight">
              SnakDip <span className="text-brand-600">ERP</span>
            </h1>
            <p className="text-sm font-bold text-cream-800 mt-0.5">
              نظام سناك ديب لإدارة الموارد والمصانع
            </p>
            <p className="text-xs text-cream-600 mt-1 font-medium">
              شركة SnakDip للصناعات الغذائية — النسخة الرئيسية
            </p>
          </div>

          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white border border-cream-300 text-xs text-emerald-700 font-bold shadow-xs">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>النسخة الرئيسية المعتمدة — Production Release</span>
          </div>
        </div>

        {/* Login Card */}
        <div className="bg-white rounded-3xl border border-cream-200 shadow-card p-6 sm:p-8 space-y-5">
          <div className="border-b border-cream-200 pb-3 flex items-center justify-between">
            <div>
              <h2 className="text-base font-black text-ink-900">تسجيل الدخول</h2>
              <p className="text-xs text-cream-600 mt-0.5 font-medium">
                أدخل بيانات الحساب للوصول إلى لوحة التحكم
              </p>
            </div>
            <div className="w-9 h-9 rounded-xl bg-brand-50 border border-brand-200 flex items-center justify-center text-brand-600">
              <Shield className="w-5 h-5" />
            </div>
          </div>

          {/* Error Alert */}
          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2 animate-shake font-semibold">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-500" />
              <span>{errorMsg}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Username */}
            <div className="space-y-1.5">
              <label className="field-label">اسم المستخدم (Username)</label>
              <div className="relative">
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="أدخل اسم المستخدم"
                  required
                  className="field-input pl-3 pr-10 font-mono"
                />
                <UserIcon className="w-4 h-4 text-cream-500 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <label className="field-label">كلمة المرور (Password)</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="أدخل كلمة المرور"
                  required
                  className="field-input pl-10 pr-10 font-mono tracking-wider"
                />
                <Lock className="w-4 h-4 text-cream-500 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-cream-500 hover:text-ink-800 transition p-1"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3 px-4 rounded-xl bg-brand-500 hover:bg-brand-600 text-white font-black text-sm shadow-brand active:scale-[0.99] transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-70"
            >
              {isLoading ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <span>دخول إلى النظام</span>
                  <ArrowLeft className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>

        {/* Feature Badges Footer */}
        <div className="grid grid-cols-2 gap-3 text-center text-xs">
          <div className="p-3 rounded-2xl bg-white border border-cream-200 text-ink-800 flex items-center gap-2 justify-center font-bold shadow-xs">
            <Factory className="w-4 h-4 text-brand-500 shrink-0" />
            <span>سجل المنتجات الـ 11 مهيأ</span>
          </div>
          <div className="p-3 rounded-2xl bg-white border border-cream-200 text-ink-800 flex items-center gap-2 justify-center font-bold shadow-xs">
            <Building2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>قيد مزدوج و 5 مستودعات</span>
          </div>
        </div>
      </div>
    </div>
  );
};
