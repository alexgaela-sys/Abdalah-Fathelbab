import React, { useState } from 'react';
import {
  LayoutDashboard, ShoppingCart, ShoppingBag, Boxes, Factory,
  ShieldCheck, Calculator, Users, Truck, UserCheck, Globe,
  Wallet, Landmark, FileCheck2, Receipt, BookOpen, BarChart3,
  KeyRound, Settings, History, LogOut, Package, ChevronDown, X,
} from 'lucide-react';
import { User } from '../../types/erp';
import { PermissionService } from '../../services/permissions';

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

/** Grouped navigation: same tabs, same PermissionService gating, better IA. */
const NAV_GROUPS: Array<{
  titleAr: string;
  items: Array<{ id: NavTab; label: string; icon: React.ComponentType<{ className?: string }> }>;
}> = [
  {
    titleAr: 'لوحة التحكم',
    items: [{ id: 'dashboard', label: 'لوحة القيادة', icon: LayoutDashboard }],
  },
  {
    titleAr: 'المبيعات',
    items: [
      { id: 'sales', label: 'فواتير المبيعات', icon: ShoppingCart },
      { id: 'customers', label: 'العملاء', icon: Users },
      { id: 'representatives', label: 'المندوبون والعهد', icon: UserCheck },
    ],
  },
  {
    titleAr: 'المشتريات',
    items: [
      { id: 'purchasing', label: 'فواتير المشتريات', icon: ShoppingBag },
      { id: 'suppliers', label: 'الموردون', icon: Truck },
    ],
  },
  {
    titleAr: 'المخزون',
    items: [
      { id: 'items', label: 'الأصناف والمنتجات', icon: Package },
      { id: 'inventory', label: 'المستودعات والمخزون', icon: Boxes },
    ],
  },
  {
    titleAr: 'الإنتاج والجودة',
    items: [
      { id: 'manufacturing', label: 'الإنتاج', icon: Factory },
      { id: 'quality', label: 'الجودة', icon: ShieldCheck },
      { id: 'costing', label: 'التكاليف', icon: Calculator },
    ],
  },
  {
    titleAr: 'التصدير',
    items: [{ id: 'export', label: 'الشحنات والتحصيل', icon: Globe }],
  },
  {
    titleAr: 'الحسابات',
    items: [
      { id: 'accounting', label: 'المحاسبة', icon: BookOpen },
      { id: 'treasury', label: 'الخزينة', icon: Wallet },
      { id: 'banks', label: 'البنوك', icon: Landmark },
      { id: 'cheques', label: 'الشيكات', icon: FileCheck2 },
      { id: 'expenses', label: 'المصروفات', icon: Receipt },
    ],
  },
  {
    titleAr: 'الإعدادات',
    items: [
      { id: 'reports', label: 'التقارير', icon: BarChart3 },
      { id: 'users', label: 'المستخدمون والصلاحيات', icon: KeyRound },
      { id: 'audit', label: 'سجل العمليات', icon: History },
      { id: 'settings', label: 'الإعدادات', icon: Settings },
    ],
  },
];

/** Distinct brand marks per group for quick visual scanning. */
const GROUP_ACCENTS: Record<string, string> = {
  'لوحة التحكم': 'bg-brand-500 text-white',
  'المبيعات': 'bg-emerald-100 text-emerald-700',
  'المشتريات': 'bg-sky-100 text-sky-700',
  'المخزون': 'bg-violet-100 text-violet-700',
  'الإنتاج والجودة': 'bg-amber-100 text-amber-700',
  'التصدير': 'bg-teal-100 text-teal-700',
  'الحسابات': 'bg-cream-200 text-cream-800',
  'الإعدادات': 'bg-slate-100 text-slate-600',
};

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  isOpen,
  onClose,
  currentUser,
  onLogout,
}) => {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggleGroup = (title: string) =>
    setCollapsed(prev => ({ ...prev, [title]: !prev[title] }));

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-ink-950/60 backdrop-blur-xs lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`
          fixed top-0 right-0 z-50 h-screen w-72 bg-ink-900 text-white flex flex-col
          border-l border-ink-700 transition-transform duration-300 ease-in-out shadow-2xl lg:shadow-none
          ${isOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'}
        `}
      >
        {/* Brand header */}
        <div className="p-4 border-b border-ink-700 flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            {/* Clean text-based brand mark (no fake logo) */}
            <div className="w-10 h-10 rounded-xl bg-brand-500 flex items-center justify-center shrink-0 shadow-brand">
              <span className="font-black text-lg leading-none tracking-tight">
                S<span className="text-ink-950">D</span>
              </span>
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-black text-white tracking-tight leading-tight">
                SnakDip <span className="text-brand-400">ERP</span>
              </h1>
              <p className="text-[11px] text-cream-400 font-semibold truncate">
                نظام إدارة الموارد والمصانع
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden p-1.5 rounded-lg text-cream-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
            title="إغلاق القائمة"
          >
            <X className="w-4.5 h-4.5" />
          </button>
        </div>

        {/* Company quick badge */}
        <div className="px-4 py-2 bg-ink-950/60 border-b border-ink-700/80 flex items-center justify-between gap-2 text-[11px] text-cream-300">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-400 shrink-0" />
            <span className="truncate font-semibold">شركة SnakDip للصناعات الغذائية</span>
          </div>
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-ink-800 text-cream-300 border border-ink-700 font-mono">
            EGP / USD
          </span>
        </div>

        {/* Grouped navigation — filtered by role permissions */}
        <nav className="flex-1 overflow-y-auto p-3 space-y-2.5 scrollbar-thin scrollbar-thumb-ink-700">
          {NAV_GROUPS.map(group => {
            const visibleItems = group.items.filter(
              item => !currentUser || PermissionService.canView(currentUser.role, item.id)
            );
            if (visibleItems.length === 0) return null;

            const isCollapsed = collapsed[group.titleAr];
            const hasActive = visibleItems.some(i => i.id === activeTab);

            return (
              <div key={group.titleAr}>
                <button
                  onClick={() => toggleGroup(group.titleAr)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-[10px] font-black uppercase tracking-wider text-cream-500 hover:text-cream-300 transition cursor-pointer group"
                >
                  <span
                    className={`w-4 h-4 rounded ${GROUP_ACCENTS[group.titleAr] || 'bg-cream-200 text-cream-800'} flex items-center justify-center text-[8px] font-black`}
                  >
                    {group.titleAr.charAt(0)}
                  </span>
                  <span className="flex-1 text-right">{group.titleAr}</span>
                  <ChevronDown
                    className={`w-3 h-3 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                  />
                </button>

                {!isCollapsed && (
                  <div className="mt-1 space-y-0.5">
                    {visibleItems.map(item => {
                      const Icon = item.icon;
                      const isActive = activeTab === item.id;
                      return (
                        <button
                          key={item.id}
                          onClick={() => {
                            setActiveTab(item.id);
                            onClose();
                          }}
                          className={`nav-item ${isActive ? 'nav-item-active' : ''}`}
                        >
                          <Icon
                            className={`w-4 h-4 shrink-0 ${
                              isActive ? 'text-white' : hasActive ? 'text-brand-400' : 'text-cream-500'
                            }`}
                          />
                          <span className="flex-1">{item.label}</span>
                          {isActive && <span className="w-1.5 h-1.5 rounded-full bg-white/90" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* User footer */}
        <div className="p-3 border-t border-ink-700 bg-ink-950/90 space-y-1.5">
          <div className="flex items-center justify-between gap-2 px-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-full bg-brand-500/20 text-brand-400 flex items-center justify-center font-black text-[11px] shrink-0 border border-brand-500/30">
                {(currentUser?.name || 'أ').charAt(0)}
              </div>
              <div className="min-w-0">
                <div className="font-bold text-white text-xs truncate">
                  {currentUser?.name || 'المشرف العام'}
                </div>
                <div className="text-[10px] text-brand-400/90 font-semibold truncate">
                  {currentUser?.role || 'Super Admin'}
                </div>
              </div>
            </div>

            <button
              onClick={onLogout}
              className="p-1.5 rounded-lg text-cream-400 hover:text-rose-400 hover:bg-white/5 transition cursor-pointer shrink-0"
              title="تسجيل الخروج"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>

          <div className="text-[10px] text-center text-cream-600 pt-1.5 border-t border-ink-700/60">
            SnakDip ERP v2.0 • قاعدة بيانات نشطة
          </div>
        </div>
      </aside>
    </>
  );
};
