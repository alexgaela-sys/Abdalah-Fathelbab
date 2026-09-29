import React from 'react';
import { 
  LayoutDashboard, ShoppingCart, ShoppingBag, Boxes, Factory, 
  ShieldCheck, Calculator, Users, Truck, UserCheck, Globe, 
  Wallet, Landmark, FileCheck2, Receipt, BookOpen, BarChart3, 
  KeyRound, Settings, History, Building2, LogOut, Shield, Package
} from 'lucide-react';
import { User } from '../../types/erp';

export type NavTab = 
  | 'dashboard'
  | 'items'
  | 'sales'
  | 'purchasing'
  | 'inventory'
  | 'manufacturing'
  | 'quality'
  | 'costing'
  | 'customers'
  | 'suppliers'
  | 'representatives'
  | 'export'
  | 'treasury'
  | 'banks'
  | 'cheques'
  | 'expenses'
  | 'accounting'
  | 'reports'
  | 'users'
  | 'settings'
  | 'audit';

interface SidebarProps {
  activeTab: NavTab;
  setActiveTab: (tab: NavTab) => void;
  isOpen: boolean;
  onClose: () => void;
  currentUser?: User;
  onLogout: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ 
  activeTab, 
  setActiveTab, 
  isOpen, 
  onClose,
  currentUser,
  onLogout
}) => {
  const navItems = [
    { id: 'dashboard', label: 'لوحة القيادة', icon: LayoutDashboard },
    { id: 'items', label: 'الأصناف والمنتجات', icon: Package },
    { id: 'inventory', label: 'المستودعات والمخزون', icon: Boxes },
    { id: 'manufacturing', label: 'الإنتاج', icon: Factory },
    { id: 'quality', label: 'الجودة', icon: ShieldCheck },
    { id: 'costing', label: 'التكاليف', icon: Calculator },
    { id: 'sales', label: 'المبيعات', icon: ShoppingCart },
    { id: 'purchasing', label: 'المشتريات', icon: ShoppingBag },
    { id: 'customers', label: 'العملاء', icon: Users },
    { id: 'suppliers', label: 'الموردون', icon: Truck },
    { id: 'representatives', label: 'المندوبون والعهد', icon: UserCheck },
    { id: 'export', label: 'التصدير', icon: Globe },
    { id: 'treasury', label: 'الخزينة', icon: Wallet },
    { id: 'banks', label: 'البنوك', icon: Landmark },
    { id: 'cheques', label: 'الشيكات', icon: FileCheck2 },
    { id: 'expenses', label: 'المصروفات', icon: Receipt },
    { id: 'accounting', label: 'المحاسبة', icon: BookOpen },
    { id: 'reports', label: 'التقارير', icon: BarChart3 },
    { id: 'users', label: 'المستخدمون والصلاحيات', icon: KeyRound },
    { id: 'settings', label: 'الإعدادات', icon: Settings },
    { id: 'audit', label: 'سجل العمليات', icon: History },
  ];

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div 
          className="fixed inset-0 z-40 bg-slate-900/60 backdrop-blur-xs lg:hidden"
          onClick={onClose}
        />
      )}

      <aside className={`
        fixed top-0 right-0 z-50 h-screen w-72 bg-slate-900 text-slate-100 flex flex-col 
        border-l border-slate-800 transition-transform duration-300 ease-in-out shadow-2xl lg:shadow-none
        ${isOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'}
      `}>
        {/* Brand Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-amber-600 to-amber-400 flex items-center justify-center text-slate-950 font-black text-xl shadow-lg shadow-amber-500/20">
              ع
            </div>
            <div>
              <h1 className="text-base font-bold text-white tracking-wide">Abdullah ERP</h1>
              <p className="text-xs text-amber-400 font-medium">نظام عبد الله المتكامل</p>
            </div>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800 font-medium">
            نسخة رئيسية
          </span>
        </div>

        {/* Company Quick Badge */}
        <div className="px-4 py-2 bg-slate-950/60 border-b border-slate-800/80 flex items-center justify-between text-xs text-slate-300">
          <div className="flex items-center gap-1.5 truncate">
            <Building2 className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="truncate">شركة عبد الله للصناعات الغذائية</span>
          </div>
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 font-mono">
            EGP / USD
          </span>
        </div>

        {/* Navigation List */}
        <nav className="flex-1 overflow-y-auto p-3 space-y-1 scrollbar-thin scrollbar-thumb-slate-800">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setActiveTab(item.id as NavTab);
                  onClose();
                }}
                className={`
                  w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all text-right cursor-pointer
                  ${isActive 
                    ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/20 font-bold' 
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'}
                `}
              >
                <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-slate-950' : 'text-amber-400/80'}`} />
                <span className="flex-1">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Production User Info & Logout Footer */}
        <div className="p-3 border-t border-slate-800 bg-slate-950/90 space-y-2">
          <div className="flex items-center justify-between px-2 py-1 text-xs">
            <div className="flex items-center gap-2 truncate">
              <div className="w-7 h-7 rounded-full bg-slate-800 text-amber-400 flex items-center justify-center font-bold text-xs">
                <Shield className="w-3.5 h-3.5" />
              </div>
              <div className="truncate">
                <div className="font-bold text-white text-xs truncate">
                  {currentUser?.name || 'المشرف العام'}
                </div>
                <div className="text-[10px] text-amber-400/80 font-mono">
                  @{currentUser?.username || 'admin'}
                </div>
              </div>
            </div>

            <button
              onClick={onLogout}
              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition cursor-pointer"
              title="تسجيل الخروج"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>

          <div className="text-[10px] text-center text-slate-500 pt-1 border-t border-slate-800/60">
            النسخة الإنتاجية المعتمدة v1.0 • قاعدة بيانات نشطة
          </div>
        </div>
      </aside>
    </>
  );
};
