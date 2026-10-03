// Role-based Permission Matrix (PermissionAction x RoleName)
// Single source of truth for access control across the UI and workflows.
import { RoleName, PermissionAction } from '../types/erp';
import { NavTab } from '../components/layout/Sidebar';

export type ModuleKey =
  | 'dashboard' | 'items' | 'inventory' | 'manufacturing' | 'quality' | 'costing'
  | 'sales' | 'purchasing' | 'customers' | 'suppliers' | 'representatives'
  | 'export' | 'treasury' | 'banks' | 'cheques' | 'expenses' | 'accounting'
  | 'reports' | 'users' | 'settings' | 'audit';

const AUTHORIZATION_SUPER_ADMIN: RoleName = 'Super Admin';

/** Which module a NavTab belongs to (1:1 here, kept separate so module keys stay stable). */
const TAB_TO_MODULE: Record<NavTab, ModuleKey> = {
  dashboard: 'dashboard', items: 'items', inventory: 'inventory',
  manufacturing: 'manufacturing', quality: 'quality', costing: 'costing',
  sales: 'sales', purchasing: 'purchasing', customers: 'customers',
  suppliers: 'suppliers', representatives: 'representatives', export: 'export',
  treasury: 'treasury', banks: 'banks', cheques: 'cheques', expenses: 'expenses',
  accounting: 'accounting', reports: 'reports', users: 'users', settings: 'settings',
  audit: 'audit',
};

const ALL_ACTIONS: PermissionAction[] = ['view', 'create', 'edit', 'delete', 'approve', 'post', 'cancel', 'export'];

/** F23: every module the Super Admin can grant explicitly, in display order. */
export const ALL_MODULES: ModuleKey[] = [
  'dashboard', 'items', 'inventory', 'manufacturing', 'quality', 'costing',
  'sales', 'purchasing', 'customers', 'suppliers', 'representatives',
  'export', 'treasury', 'banks', 'cheques', 'expenses', 'accounting',
  'reports', 'users', 'settings', 'audit',
];

/** F23: the six explicit actions the Super Admin assigns per module. */
export const ASSIGNABLE_ACTIONS: PermissionAction[] = ['view', 'create', 'edit', 'delete', 'approve', 'post'];

/** Arabic labels for the permission matrix UI. */
export const MODULE_LABELS_AR: Record<ModuleKey, string> = {
  dashboard: 'لوحة المعلومات', items: 'الأصناف والمنتجات', inventory: 'المخازن والجرد',
  manufacturing: 'الإنتاج والتصنيع', quality: 'الجودة', costing: 'الت costing والتكاليف',
  sales: 'المبيعات', purchasing: 'المشتريات', customers: 'العملاء', suppliers: 'الموردون',
  representatives: 'المناديب والعهد', export: 'التصدير', treasury: 'الخزينة',
  banks: 'البنوك', cheques: 'الشيكات', expenses: 'المصروفات', accounting: 'المحاسبة والدفاتر',
  reports: 'التقارير', users: 'المستخدمون والصلاحيات', settings: 'الإعدادات', audit: 'سجل التدقيق',
};

export const ACTION_LABELS_AR: Record<string, string> = {
  view: 'عرض', create: 'إضافة', edit: 'تعديل', delete: 'حذف',
  approve: 'اعتماد', post: 'ترحيل', cancel: 'إلغاء', export: 'استيراد/تصدير',
};
const VIEW_ONLY: PermissionAction[] = ['view'];
const VIEW_EXPORT: PermissionAction[] = ['view', 'export'];
const NO_POST: PermissionAction[] = ['view', 'create', 'edit', 'export'];

/**
 * Permission matrix. Modules absent for a role = no access at all.
 * Principle: financial posting (post/approve/cancel) is restricted to finance roles;
 * warehouse staff see inventory/production; sales reps see only their own modules.
 */
const MATRIX: Record<RoleName, Partial<Record<ModuleKey, PermissionAction[]>>> = {
  'Super Admin': {
    dashboard: ALL_ACTIONS, items: ALL_ACTIONS, inventory: ALL_ACTIONS,
    manufacturing: ALL_ACTIONS, quality: ALL_ACTIONS, costing: ALL_ACTIONS,
    sales: ALL_ACTIONS, purchasing: ALL_ACTIONS, customers: ALL_ACTIONS,
    suppliers: ALL_ACTIONS, representatives: ALL_ACTIONS, export: ALL_ACTIONS,
    treasury: ALL_ACTIONS, banks: ALL_ACTIONS, cheques: ALL_ACTIONS, expenses: ALL_ACTIONS,
    accounting: ALL_ACTIONS, reports: ALL_ACTIONS, users: ALL_ACTIONS,
    settings: ALL_ACTIONS, audit: ALL_ACTIONS,
  },
  'General Manager': {
    dashboard: ALL_ACTIONS, items: VIEW_EXPORT, inventory: VIEW_EXPORT,
    manufacturing: VIEW_EXPORT, quality: VIEW_EXPORT, costing: VIEW_EXPORT,
    sales: VIEW_EXPORT, purchasing: VIEW_EXPORT, customers: VIEW_EXPORT,
    suppliers: VIEW_EXPORT, representatives: VIEW_EXPORT, export: VIEW_EXPORT,
    treasury: VIEW_EXPORT, banks: VIEW_EXPORT, cheques: VIEW_EXPORT, expenses: VIEW_EXPORT,
    accounting: VIEW_EXPORT, reports: ALL_ACTIONS, audit: VIEW_EXPORT,
  },
  'Chief Accountant': {
    dashboard: VIEW_EXPORT, items: VIEW_ONLY, inventory: VIEW_EXPORT,
    manufacturing: VIEW_ONLY, quality: VIEW_ONLY, costing: ALL_ACTIONS,
    sales: [...NO_POST, 'approve'], purchasing: [...NO_POST, 'approve'],
    customers: [...NO_POST, 'approve'], suppliers: [...NO_POST, 'approve'],
    representatives: VIEW_EXPORT, export: VIEW_EXPORT,
    treasury: ALL_ACTIONS, banks: ALL_ACTIONS, cheques: ALL_ACTIONS, expenses: ALL_ACTIONS,
    accounting: ALL_ACTIONS, reports: ALL_ACTIONS, audit: VIEW_EXPORT,
  },
  'Accountant': {
    dashboard: VIEW_ONLY, items: VIEW_ONLY, inventory: VIEW_EXPORT,
    sales: NO_POST, purchasing: NO_POST, customers: NO_POST, suppliers: NO_POST,
    treasury: NO_POST, banks: NO_POST, cheques: NO_POST, expenses: NO_POST,
    accounting: NO_POST, reports: VIEW_EXPORT,
  },
  'Cost Accountant': {
    dashboard: VIEW_ONLY, items: VIEW_EXPORT, inventory: VIEW_EXPORT,
    manufacturing: VIEW_EXPORT, costing: ALL_ACTIONS, quality: VIEW_ONLY,
    sales: VIEW_ONLY, purchasing: VIEW_ONLY, reports: VIEW_EXPORT, accounting: VIEW_ONLY,
  },
  'Warehouse Manager': {
    dashboard: VIEW_ONLY, items: [...NO_POST, 'approve'], inventory: ALL_ACTIONS,
    manufacturing: NO_POST, quality: NO_POST, reports: VIEW_EXPORT,
  },
  'Warehouse Employee': {
    dashboard: VIEW_ONLY, items: VIEW_ONLY, inventory: NO_POST, quality: VIEW_ONLY,
  },
  'Sales Manager': {
    dashboard: VIEW_ONLY, items: VIEW_EXPORT, inventory: VIEW_EXPORT,
    sales: ALL_ACTIONS, customers: [...NO_POST, 'approve'],
    representatives: [...NO_POST, 'approve'], export: NO_POST, reports: VIEW_EXPORT,
  },
  'Sales Representative': {
    dashboard: VIEW_ONLY, items: VIEW_ONLY, customers: ['view', 'create'],
    representatives: ['view', 'create', 'edit'], sales: ['view', 'create'],
  },
  'Purchasing Manager': {
    dashboard: VIEW_ONLY, items: [...NO_POST, 'approve'], purchasing: ALL_ACTIONS,
    suppliers: [...NO_POST, 'approve'], inventory: VIEW_EXPORT, reports: VIEW_EXPORT,
  },
  'Production Manager': {
    dashboard: VIEW_ONLY, items: VIEW_EXPORT, inventory: NO_POST,
    manufacturing: ALL_ACTIONS, quality: NO_POST, costing: VIEW_EXPORT, reports: VIEW_EXPORT,
  },
  'Treasury Accountant': {
    dashboard: VIEW_ONLY, treasury: ALL_ACTIONS, banks: ALL_ACTIONS,
    cheques: ALL_ACTIONS, expenses: NO_POST, accounting: VIEW_ONLY, reports: VIEW_EXPORT,
  },
  'Viewer': {
    dashboard: VIEW_ONLY, items: VIEW_ONLY, inventory: VIEW_ONLY,
    sales: VIEW_ONLY, purchasing: VIEW_ONLY, customers: VIEW_ONLY, suppliers: VIEW_ONLY,
    manufacturing: VIEW_ONLY, quality: VIEW_ONLY, costing: VIEW_ONLY, export: VIEW_ONLY,
    treasury: VIEW_ONLY, banks: VIEW_ONLY, cheques: VIEW_ONLY, expenses: VIEW_ONLY,
    accounting: VIEW_ONLY, reports: VIEW_ONLY, audit: VIEW_ONLY,
  },
};

export class PermissionService {
  /** Actions the role holds on a module (empty array = no access). */
  public static getActions(role: RoleName, module: ModuleKey): PermissionAction[] {
    return MATRIX[role]?.[module] || [];
  }

  /**
   * F23: effective actions of a USER.
   * When the user has an EXPLICIT permission entry for the module, that entry wins
   * over the role matrix (this is how the Super Admin narrows a role per user).
   * When absent, the role matrix governs — so existing users are unaffected.
   */
  public static getActionsForUser(
    user: { role: RoleName; permissions?: Record<string, PermissionAction[]> } | undefined,
    module: ModuleKey
  ): PermissionAction[] {
    if (!user) return [];
    if (user.role === AUTHORIZATION_SUPER_ADMIN) return ALL_ACTIONS;
    const explicit = user.permissions?.[module];
    if (Array.isArray(explicit)) return explicit;
    return this.getActions(user.role, module);
  }

  public static hasPermissionForUser(
    user: { role: RoleName; permissions?: Record<string, PermissionAction[]> } | undefined,
    module: ModuleKey,
    action: PermissionAction
  ): boolean {
    return this.getActionsForUser(user, module).includes(action);
  }

  public static hasPermission(role: RoleName, module: ModuleKey, action: PermissionAction): boolean {
    return this.getActions(role, module).includes(action);
  }

  /** Can the role open the module's view/tab at all? */
  public static canView(role: RoleName, tab: NavTab): boolean {
    return this.hasPermission(role, TAB_TO_MODULE[tab] || 'dashboard', 'view');
  }

  /** Nav tabs the role may see (used by the sidebar). */
  public static visibleTabs(role: RoleName): NavTab[] {
    return (Object.keys(TAB_TO_MODULE) as NavTab[]).filter(tab => this.canView(role, tab));
  }

  public static canCreate(role: RoleName, tab: NavTab): boolean {
    return this.hasPermission(role, TAB_TO_MODULE[tab] || 'dashboard', 'create');
  }

  public static canPost(role: RoleName, tab: NavTab): boolean {
    return this.hasPermission(role, TAB_TO_MODULE[tab] || 'dashboard', 'post');
  }
}
