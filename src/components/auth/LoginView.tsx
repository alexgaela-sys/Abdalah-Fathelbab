import React, { useState } from 'react';
import { 
  Lock, User as UserIcon, Shield, Eye, EyeOff, 
  CheckCircle2, AlertCircle, ArrowLeft, Building2, Factory, Sparkles
} from 'lucide-react';
import { AuthService } from '../../services/auth';
import { User } from '../../types/erp';

interface LoginViewProps {
  onLoginSuccess: (user: User) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('12345');
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

  const handleQuickFill = () => {
    setUsername('admin');
    setPassword('12345');
    setErrorMsg(null);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-amber-950 flex flex-col justify-center items-center p-4 sm:p-6 font-['Cairo',sans-serif] text-slate-100 antialiased relative overflow-hidden" dir="rtl">
      {/* Background Ambient Glows */}
      <div className="absolute top-1/4 -right-24 w-96 h-96 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 -left-24 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-md z-10 space-y-6">
        {/* Brand & System Title */}
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-tr from-amber-600 to-amber-400 text-slate-950 font-black text-3xl shadow-2xl shadow-amber-500/30 border border-amber-300/40">
            ع
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-black text-white tracking-wide">
              Abdullah ERP
            </h1>
            <p className="text-sm font-semibold text-amber-400 mt-0.5">
              نظام عبد الله لإدارة الموارد والمصانع
            </p>
            <p className="text-xs text-slate-400 mt-1">
              شركة عبد الله للصناعات الغذائية (ش.م.م) - النسخة الرئيسية
            </p>
          </div>

          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800/80 border border-slate-700/80 text-xs text-emerald-400 font-medium">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>النسخة الرئيسية المعتمدة - Production Release</span>
          </div>
        </div>

        {/* Login Card */}
        <div className="bg-slate-900/90 backdrop-blur-xl border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-2xl space-y-5">
          <div className="border-b border-slate-800/80 pb-3 flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-white">تسجيل الدخول للمسؤول</h2>
              <p className="text-xs text-slate-400 mt-0.5">أدخل بيانات الحساب للوصول إلى لوحة التحكم</p>
            </div>
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
              <Shield className="w-5 h-5" />
            </div>
          </div>

          {/* Error Alert */}
          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2 animate-shake">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
              <span>{errorMsg}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Username */}
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-300">
                اسم المستخدم (Username)
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  required
                  className="w-full pl-3 pr-10 py-3 rounded-xl bg-slate-950/70 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition font-mono"
                />
                <UserIcon className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-bold text-slate-300">
                  كلمة المرور (Password)
                </label>
                <button
                  type="button"
                  onClick={handleQuickFill}
                  className="text-[11px] text-amber-400 hover:text-amber-300 transition"
                >
                  تعبئة بيانات الأدمن (admin / 12345)
                </button>
              </div>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="•••••"
                  required
                  className="w-full pl-10 pr-10 py-3 rounded-xl bg-slate-950/70 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition font-mono tracking-wider"
                />
                <Lock className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition p-1"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Credentials Info Badge */}
            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 text-xs space-y-1">
              <div className="flex items-center justify-between text-slate-300">
                <span className="text-slate-400">حساب المشرف العام:</span>
                <span className="font-mono font-bold text-amber-400">admin</span>
              </div>
              <div className="flex items-center justify-between text-slate-300">
                <span className="text-slate-400">كلمة المرور الافتراضية:</span>
                <span className="font-mono font-bold text-amber-400">12345</span>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-bold text-sm shadow-lg shadow-amber-500/25 active:scale-[0.99] transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-70"
            >
              {isLoading ? (
                <div className="w-5 h-5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <span>دخول إلى النظام الرئيسي</span>
                  <ArrowLeft className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>

        {/* Feature Badges Footer */}
        <div className="grid grid-cols-2 gap-3 text-center text-xs">
          <div className="p-3 rounded-2xl bg-slate-900/60 border border-slate-800 text-slate-300 flex items-center gap-2 justify-center">
            <Factory className="w-4 h-4 text-amber-400 shrink-0" />
            <span>سجل المنتجات الـ 11 مهيأ</span>
          </div>
          <div className="p-3 rounded-2xl bg-slate-900/60 border border-slate-800 text-slate-300 flex items-center gap-2 justify-center">
            <Building2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>قيد مزدوج و 5 مستودعات</span>
          </div>
        </div>
      </div>
    </div>
  );
};
