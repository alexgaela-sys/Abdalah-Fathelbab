import React, { useState } from 'react';
import { 
  Menu, Bell, Shield, ChevronDown, 
  Calendar, CheckCircle2, LogOut, Check, UserCheck, Settings
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
    <header className="sticky top-0 z-30 h-16 bg-white border-b border-slate-200 px-4 flex items-center justify-between shadow-xs">
      {/* Right side: Mobile toggle & Breadcrumb */}
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleSidebar}
          className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 lg:hidden cursor-pointer"
          title="القائمة الرئيسية"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="hidden sm:flex items-center gap-2">
          <span className="text-sm font-bold text-slate-800">
            {db.company.nameAr}
          </span>
          <span className="text-xs px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-900 border border-amber-200 font-medium">
            سعر الصرف: {db.company.currentUsdExchangeRate.toFixed(2)} ج.م / USD
          </span>
        </div>
      </div>

      {/* Left side actions */}
      <div className="flex items-center gap-2.5">
        {/* Accounting Period status badge */}
        <div className="hidden lg:flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-50 text-slate-700 text-xs border border-slate-200">
          <Calendar className="w-3.5 h-3.5 text-slate-500" />
          <span>الفترة المحاسبية:</span>
          <span className="font-bold text-emerald-700">
            {currentPeriod ? currentPeriod.nameAr : 'لا توجد فترة مفتوحة'}
          </span>
        </div>

        {/* Production Mode Badge */}
        <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-800 text-xs border border-emerald-200 font-semibold">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>النسخة الرئيسية</span>
        </div>

        {/* Urgent Alerts Bell (10-day expiry alert) */}
        <div className="relative">
          <button
            onClick={() => setShowAlerts(!showAlerts)}
            className="relative p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition cursor-pointer"
            title="التنبيهات العاجلة وتواريخ الصلاحية"
          >
            <Bell className="w-5 h-5" />
            {expiringBatches.length > 0 && (
              <span className="absolute top-1 left-1 w-4 h-4 rounded-full bg-rose-600 text-white text-[10px] font-bold flex items-center justify-center animate-bounce">
                {expiringBatches.length}
              </span>
            )}
          </button>

          {showAlerts && (
            <div className="absolute left-0 mt-2 w-80 bg-white rounded-xl shadow-2xl border border-slate-200 p-3 z-50 animate-scale-in text-right">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                <span className="font-bold text-xs text-slate-800">التنبيهات وتواريخ الصلاحية</span>
                <span className="text-[10px] text-slate-500 font-medium">خلال 10 أيام</span>
              </div>
              <div className="mt-2 max-h-60 overflow-y-auto space-y-2">
                {expiringBatches.length === 0 ? (
                  <p className="text-xs text-slate-500 py-4 text-center">لا توجد أصناف تنتهي صلاحيتها خلال 10 أيام</p>
                ) : (
                  expiringBatches.map(b => (
                    <div key={b.id} className="p-2 rounded-lg bg-amber-50 border border-amber-200 text-xs">
                      <div className="flex items-center justify-between font-bold text-amber-900">
                        <span>{b.itemNameAr}</span>
                        <span className="text-rose-600 font-bold">باقي {b.daysUntilExpiry} أيام</span>
                      </div>
                      <div className="text-[11px] text-amber-800 mt-1 flex justify-between">
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
            className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-r-xl bg-slate-50 border border-slate-200 hover:bg-slate-100 transition cursor-pointer"
            title="تعديل الملف الشخصي للمسؤول (User Profile)"
          >
            <div className="w-8 h-8 rounded-full bg-slate-900 text-amber-400 flex items-center justify-center font-bold text-xs shadow-xs">
              <Shield className="w-4 h-4 text-amber-400" />
            </div>
            <div className="text-right hidden sm:block">
              <div className="text-xs font-bold text-slate-900 leading-tight">
                {currentUser?.name || 'المشرف العام (admin)'}
              </div>
              <div className="text-[10px] text-amber-700 font-medium">
                {currentUserRole}
              </div>
            </div>
          </button>

          {/* Chevron Dropdown Trigger for Role & Account Menu */}
          <button
            onClick={() => setShowRoleMenu(!showRoleMenu)}
            className="p-2 py-2 rounded-l-xl bg-slate-100 hover:bg-slate-200 border-y border-l border-slate-200 transition cursor-pointer text-slate-500 hover:text-slate-800"
            title="قائمة المستخدم وتبديل الدور"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>

          {showRoleMenu && (
            <div className="absolute left-0 mt-2 w-64 bg-white rounded-2xl shadow-2xl border border-slate-200 py-2 z-50 text-right animate-scale-in">
              <div className="px-4 py-2 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-slate-900">{currentUser?.name}</div>
                  <div className="text-[11px] text-slate-500 font-mono">@{currentUser?.username}</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowRoleMenu(false);
                    setShowProfileModal(true);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-900 text-[11px] font-bold border border-amber-200 transition cursor-pointer flex items-center gap-1"
                >
                  <Settings className="w-3 h-3 text-amber-700" />
                  <span>تعديل الملف</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  setShowRoleMenu(false);
                  setShowProfileModal(true);
                }}
                className="w-full px-4 py-2 text-xs flex items-center gap-2 text-right hover:bg-slate-50 font-bold text-slate-800 border-b border-slate-100 cursor-pointer"
              >
                <UserCheck className="w-4 h-4 text-amber-600" />
                <span>بيانات الحساب وتغيير كلمة المرور</span>
              </button>

              <div className="px-3 py-1.5 text-[11px] text-slate-400 font-semibold">
                تبديل الدور والصلاحيات (RBAC)
              </div>
              {roles.map(r => (
                <button
                  key={r}
                  onClick={() => {
                    onRoleChange(r);
                    setShowRoleMenu(false);
                  }}
                  className={`w-full px-4 py-2 text-xs flex items-center justify-between text-right hover:bg-slate-50 cursor-pointer ${
                    currentUserRole === r ? 'font-bold text-amber-700 bg-amber-50/50' : 'text-slate-700'
                  }`}
                >
                  <span>{r}</span>
                  {currentUserRole === r && <Check className="w-3.5 h-3.5 text-amber-600" />}
                </button>
              ))}

              <div className="border-t border-slate-100 my-1" />
              
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
          className="p-2 rounded-xl text-slate-500 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer border border-transparent hover:border-rose-200"
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
