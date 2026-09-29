import React, { useState } from 'react';
import {
  Menu, Bell, ChevronDown,
  Calendar, LogOut, Check, UserCheck, Settings
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { InventoryEngine } from '../../services/inventory';
import { RoleName, User } from '../../types/erp';
import { UserProfileModal } from '../auth/UserProfileModal';

interface HeaderProps {
  onToggleSidebar: () => void;
  currentUser: User;
  currentUserRole: RoleName;
  onRoleChange: (role: RoleName) => void;
  onLogout: () => void;
  onUserUpdated?: (user: User) => void;
}

export const Header: React.FC<HeaderProps> = ({
  onToggleSidebar,
  currentUser,
  currentUserRole,
  onRoleChange,
  onLogout,
  onUserUpdated
}) => {
  const [showAlerts, setShowAlerts] = useState(false);
  const [showRoleMenu, setShowRoleMenu] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);

  const db = erpDb.getSnapshot();
  const expiringBatches = InventoryEngine.getExpiringBatches(10);
  const currentPeriod = db.accountingPeriods.find(p => !p.isClosed);

  const roles: RoleName[] = [
    'Super Admin',
    'General Manager',
    'Chief Accountant',
    'Cost Accountant',
    'Warehouse Manager',
    'Production Manager',
    'Sales Manager',
  ];

  return (
    <header className="sticky top-0 z-30 h-16 bg-white/95 backdrop-blur border-b border-cream-200 px-4 flex items-center justify-between">
      {/* Right side: Mobile toggle & Company identity */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={onToggleSidebar}
          className="p-2 rounded-lg text-ink-700 hover:bg-cream-200/70 lg:hidden cursor-pointer"
          title="القائمة الرئيسية"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="hidden sm:flex items-center gap-2.5 min-w-0">
          {/* Small brand mark */}
          <div className="hidden md:flex w-8 h-8 rounded-lg bg-brand-500 items-center justify-center shadow-brand shrink-0">
            <span className="font-black text-sm text-white tracking-tight">
              S<span className="text-ink-950">D</span>
            </span>
          </div>
          <span className="text-sm font-black text-ink-900 truncate">
            {db.company.nameAr}
          </span>
          <span className="hidden xl:inline-flex text-[11px] px-2.5 py-1 rounded-full bg-cream-100 text-cream-800 border border-cream-300 font-bold">
            سعر الصرف: {db.company.currentUsdExchangeRate.toFixed(2)} ج.م / USD
          </span>
        </div>
      </div>

      {/* Left side actions */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Accounting Period status */}
        <div className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cream-100 text-ink-800 text-[11px] border border-cream-300 font-semibold">
          <Calendar className="w-3.5 h-3.5 text-brand-600" />
          <span className="text-cream-700">الفترة المحاسبية:</span>
          <span className="font-black text-emerald-700">
            {currentPeriod ? currentPeriod.nameAr : 'لا توجد فترة مفتوحة'}
          </span>
        </div>

        {/* Urgent Alerts Bell (10-day expiry alert) */}
        <div className="relative">
          <button
            onClick={() => setShowAlerts(!showAlerts)}
            className="relative p-2 rounded-xl text-ink-700 hover:bg-cream-200/70 transition cursor-pointer"
            title="التنبيهات العاجلة وتواريخ الصلاحية"
          >
            <Bell className="w-5 h-5" />
            {expiringBatches.length > 0 && (
              <span className="absolute top-1 left-1 w-4 h-4 rounded-full bg-brand-600 text-white text-[10px] font-black flex items-center justify-center">
                {expiringBatches.length}
              </span>
            )}
          </button>

          {showAlerts && (
            <div className="absolute left-0 mt-2 w-80 bg-white rounded-2xl shadow-xl border border-cream-200 p-3 z-50 animate-scale-in text-right">
              <div className="flex items-center justify-between pb-2 border-b border-cream-200">
                <span className="font-black text-xs text-ink-900">التنبيهات وتواريخ الصلاحية</span>
                <span className="text-[10px] text-cream-600 font-bold">خلال 10 أيام</span>
              </div>
              <div className="mt-2 max-h-60 overflow-y-auto space-y-2">
                {expiringBatches.length === 0 ? (
                  <p className="text-xs text-cream-600 py-4 text-center font-semibold">
                    لا توجد أصناف تنتهي صلاحيتها خلال 10 أيام
                  </p>
                ) : (
                  expiringBatches.map(b => (
                    <div key={b.id} className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs">
                      <div className="flex items-center justify-between font-black text-amber-900">
                        <span>{b.itemNameAr}</span>
                        <span className="text-brand-700">باقي {b.daysUntilExpiry} أيام</span>
                      </div>
                      <div className="text-[11px] text-amber-800 mt-1 flex justify-between font-semibold">
                        <span>تشغيلة: {b.batchNumber}</span>
                        <span>الكمية: {b.quantity}</span>
                      </div>
                      <div className="text-[10px] text-amber-700">{b.warehouseNameAr}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Current User & Profile Trigger */}
        <div className="relative flex items-center">
          <button
            onClick={() => setShowProfileModal(true)}
            className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-r-xl bg-cream-100 border border-cream-300 hover:bg-cream-200/70 transition cursor-pointer"
            title="تعديل الملف الشخصي"
          >
            <div className="w-8 h-8 rounded-full bg-ink-900 text-brand-400 flex items-center justify-center font-black text-xs">
              {(currentUser?.name || 'أ').charAt(0)}
            </div>
            <div className="text-right hidden sm:block">
              <div className="text-xs font-black text-ink-900 leading-tight">
                {currentUser?.name || 'المشرف العام'}
              </div>
              <div className="text-[10px] text-brand-700 font-bold">
                {currentUserRole}
              </div>
            </div>
          </button>

          {/* Chevron Dropdown Trigger for Role & Account Menu */}
          <button
            onClick={() => setShowRoleMenu(!showRoleMenu)}
            className="p-2 py-2 rounded-l-xl bg-cream-200/80 hover:bg-cream-300/70 border-y border-l border-cream-300 transition cursor-pointer text-cream-700 hover:text-ink-900"
            title="قائمة المستخدم وتبديل الدور"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>

          {showRoleMenu && (
            <div className="absolute left-0 mt-2 w-64 bg-white rounded-2xl shadow-xl border border-cream-200 py-2 z-50 text-right animate-scale-in">
              <div className="px-4 py-2 border-b border-cream-100 flex items-center justify-between">
                <div>
                  <div className="text-xs font-black text-ink-900">{currentUser?.name}</div>
                  <div className="text-[11px] text-cream-600 font-mono">@{currentUser?.username}</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowRoleMenu(false);
                    setShowProfileModal(true);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-brand-50 hover:bg-brand-100 text-brand-800 text-[11px] font-black border border-brand-200 transition cursor-pointer flex items-center gap-1"
                >
                  <Settings className="w-3 h-3" />
                  <span>تعديل الملف</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  setShowRoleMenu(false);
                  setShowProfileModal(true);
                }}
                className="w-full px-4 py-2 text-xs flex items-center gap-2 text-right hover:bg-cream-100 font-bold text-ink-800 border-b border-cream-100 cursor-pointer"
              >
                <UserCheck className="w-4 h-4 text-brand-600" />
                <span>بيانات الحساب وتغيير كلمة المرور</span>
              </button>

              <div className="px-3 py-1.5 text-[11px] text-cream-600 font-black">
                تبديل الدور والصلاحيات (RBAC)
              </div>
              {roles.map(r => (
                <button
                  key={r}
                  onClick={() => {
                    onRoleChange(r);
                    setShowRoleMenu(false);
                  }}
                  className={`w-full px-4 py-2 text-xs flex items-center justify-between text-right hover:bg-cream-100 cursor-pointer ${
                    currentUserRole === r ? 'font-black text-brand-700 bg-brand-50/60' : 'text-ink-700'
                  }`}
                >
                  <span>{r}</span>
                  {currentUserRole === r && <Check className="w-3.5 h-3.5 text-brand-600" />}
                </button>
              ))}

              <div className="border-t border-cream-100 my-1" />

              <button
                onClick={() => {
                  setShowRoleMenu(false);
                  onLogout();
                }}
                className="w-full px-4 py-2.5 text-xs text-rose-600 hover:bg-rose-50 flex items-center gap-2 text-right font-bold transition cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
                <span>تسجيل الخروج من النظام</span>
              </button>
            </div>
          )}
        </div>

        {/* Direct Logout Icon Button */}
        <button
          onClick={onLogout}
          className="hidden sm:flex p-2 rounded-xl text-cream-600 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer"
          title="تسجيل الخروج"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>

      {/* Admin User Profile Modal */}
      <UserProfileModal
        isOpen={showProfileModal}
        onClose={() => setShowProfileModal(false)}
        currentUser={currentUser}
        onUserUpdated={(u) => {
          if (onUserUpdated) onUserUpdated(u);
        }}
      />
    </header>
  );
};
