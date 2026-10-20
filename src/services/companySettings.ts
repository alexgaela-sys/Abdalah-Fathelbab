// Company / warehouse / storekeeper / invoice-design settings service.
//
// SINGLE write path for the "إعدادات الشركة والتخصيص" screen. Every change:
//   1. is authorized through AuthorizationService BEFORE any mutation
//      (the `settings` module is Super Admin-only in the permission matrix),
//   2. is validated here (the UI is never trusted),
//   3. is written through erpDb.mutate() so it is persisted by the SAME store the
//      application actually reads — localStorage 'abdullah_erp_db_v1'.
//
// LIMITATION (stated, never hidden): this application persists to browser
// localStorage only. Saving here survives a reload/reopen of the same browser
// profile, but it is NOT synchronized to a server or between devices.
//
// Nothing in this service touches accounting entries, stock movements, invoice
// totals, VAT or withholding calculations. Warehouses and storekeepers can be
// disabled — never deleted when they carry history.
import { erpDb, generateErpId, DEFAULT_INVOICE_TEMPLATE } from './db';
import { AuthorizationService } from './authorization';
import { ALL_MODULES, ASSIGNABLE_ACTIONS, ModuleKey } from './permissions';
import {
  Company, Warehouse, WarehouseType, InvoiceTemplateSettings, InvoiceAlignment,
  User, RoleName, PermissionAction,
} from '../types/erp';

export interface SettingsResult {
  success: boolean;
  error?: string;
}

export interface WarehouseUsage {
  batches: number;
  stockQuantity: number;
  inventoryTransactions: number;
  salesInvoices: number;
  purchaseInvoices: number;
  purchaseReturns: number;
  productionOrders: number;
  inventoryCounts: number;
  total: number;
}

const WAREHOUSE_TYPES: WarehouseType[] = ['raw_materials', 'local_finished', 'export_finished', 'damaged', 'scrap'];

export const WAREHOUSE_TYPE_LABELS_AR: Record<WarehouseType, string> = {
  raw_materials: 'مواد خام وتعبئة',
  local_finished: 'منتج تام محلي',
  export_finished: 'منتج تام للتصدير',
  damaged: 'توالف ومعيب',
  scrap: 'هالك / سكراب',
};

export const STOREKEEPER_ROLES: RoleName[] = ['Warehouse Manager', 'Warehouse Employee'];

/** Modules a storekeeper may be granted directly (finance/security stay out). */
export const STOREKEEPER_MODULES: ModuleKey[] = [
  'dashboard', 'inventory', 'items', 'manufacturing', 'quality', 'purchasing', 'sales', 'reports',
];

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const WEBSITE = /^https?:\/\/[^\s]+$/i;
const LOGO_DATA = /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i;
const MAX_LOGO_CHARS = 400_000; // ≈300 KB — keeps the whole DB within localStorage limits
const TAX_NUMBER = /^[0-9][0-9\-\/]{2,29}$/;
const WAREHOUSE_CODE = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;

const COMPANY_FIELD_LABELS_AR: Record<string, string> = {
  nameAr: 'الاسم العربي',
  nameEn: 'الاسم الإنجليزي',
  taxNumber: 'الرقم الضريبي',
  commercialRegister: 'السجل التجاري',
  address: 'العنوان',
  phone: 'الهاتف',
  email: 'البريد الإلكتروني',
  website: 'الموقع الإلكتروني',
  contactName: 'مسؤول التواصل',
  contactPhone: 'هاتف التواصل',
  logoDataUrl: 'الشعار',
  currentUsdExchangeRate: 'سعر صرف الدولار',
};

const TEMPLATE_FIELD_LABELS_AR: Record<string, string> = {
  showLogo: 'إظهار الشعار',
  headerTextAr: 'نص رأس الفاتورة',
  headerTextEn: 'النص الإنجليزي للرأس',
  footerText: 'نص التذييل',
  showTaxNumber: 'إظهار الرقم الضريبي',
  showAddress: 'إظهار العنوان',
  showPhone: 'إظهار الهاتف',
  showEmail: 'إظهار البريد',
  showCustomerTax: 'إظهار رقم العميل الضريبي',
  showWarehouse: 'إظهار المستودع',
  showWithholding: 'إظهار الخصم من المنبع',
  showNetDue: 'إبراز صافي المستحق',
  netDueLabel: 'عنوان صافي المستحق',
  accentColor: 'اللون الأساسي',
  textColor: 'لون النص',
  titleFontSize: 'حجم خط العنوان',
  bodyFontSize: 'حجم خط النص',
  tableFontSize: 'حجم خط الجدول',
  alignment: 'المحاذاة',
  showAccentBar: 'الشريط اللوني',
};

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

function trimTo(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function jsonForAudit(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 1200);
  } catch {
    return '';
  }
}

function labelsFor(changed: string[], labels: Record<string, string>): string {
  return changed.map(k => labels[k] || k).join('، ');
}

function validateLogo(logo: string | undefined): string | null {
  if (logo === undefined || logo === '') return null;
  if (!LOGO_DATA.test(logo)) return 'صيغة الشعار غير مدعومة — المسموح صور PNG / JPG / WEBP / GIF / SVG';
  if (logo.length > MAX_LOGO_CHARS) return 'حجم الشعار كبير جدًا — الحد الأقصى 300 كيلوبايت تقريبًا';
  return null;
}

function validEmail(email: string | undefined): boolean {
  return !email || EMAIL.test(email);
}

function normalizePermissions(
  permissions: Record<string, string[]> | undefined
): { value?: Record<string, PermissionAction[]>; error?: string } {
  if (permissions === undefined) return { value: undefined };
  const clean: Record<string, PermissionAction[]> = {};
  for (const [moduleKey, actions] of Object.entries(permissions)) {
    if (!STOREKEEPER_MODULES.includes(moduleKey as ModuleKey) || !ALL_MODULES.includes(moduleKey as ModuleKey)) {
      return { error: `الوحدة (${moduleKey}) لا يمكن منحها لأمين مخزن` };
    }
    if (!Array.isArray(actions)) return { error: `صلاحيات الوحدة (${moduleKey}) غير صالحة` };
    const allowed = actions.filter((a): a is PermissionAction =>
      ASSIGNABLE_ACTIONS.includes(a as PermissionAction));
    if (allowed.length !== actions.length) {
      return { error: `إحدى صلاحيات الوحدة (${moduleKey}) غير معروفة` };
    }
    if (allowed.length) clean[moduleKey] = Array.from(new Set(allowed));
  }
  return { value: clean };
}

/** Net amount due after taxes and documented deductions (display only). */
export function computeInvoiceNetDue(totalAmount: number, withholdingAmount?: number): number {
  const total = Number(totalAmount) || 0;
  const withheld = Math.max(0, Number(withholdingAmount) || 0);
  return money(total - withheld);
}

export class CompanySettingsService {
  // ============================ Read ============================

  public static getCompany(): Company {
    return erpDb.getSnapshot().company;
  }

  /** Effective template: shipped defaults overlaid with the saved values. */
  public static getInvoiceTemplate(): InvoiceTemplateSettings {
    const saved = erpDb.getSnapshot().settings?.invoiceTemplate;
    return { ...DEFAULT_INVOICE_TEMPLATE, ...(saved || {}) };
  }

  public static getWarehouses(): Warehouse[] {
    return erpDb.getSnapshot().warehouses;
  }

  public static getStorekeepers(): User[] {
    return erpDb.getSnapshot().users.filter(u => STOREKEEPER_ROLES.includes(u.role));
  }

  /** How many historical records reference a warehouse (used before disabling/deleting). */
  public static getWarehouseUsage(warehouseId: string): WarehouseUsage {
    const db = erpDb.getSnapshot();
    const batches = db.batches.filter(b => b.warehouseId === warehouseId);
    const usage = {
      batches: batches.length,
      stockQuantity: money(batches.reduce((s, b) => s + (Number(b.quantity) || 0), 0)),
      inventoryTransactions: db.inventoryTransactions.filter(t => t.warehouseId === warehouseId).length,
      salesInvoices: db.salesInvoices.filter(i => i.warehouseId === warehouseId).length,
      purchaseInvoices: db.purchaseInvoices.filter(i => i.warehouseId === warehouseId).length,
      purchaseReturns: db.purchaseReturns.filter(r => r.warehouseId === warehouseId).length,
      productionOrders: db.productionOrders.filter(o => o.destinationWarehouseId === warehouseId).length,
      inventoryCounts: db.inventoryCounts.filter(c => c.warehouseId === warehouseId).length,
    };
    return { ...usage, total: usage.batches + usage.inventoryTransactions + usage.salesInvoices
      + usage.purchaseInvoices + usage.purchaseReturns + usage.productionOrders + usage.inventoryCounts };
  }

  // ============================ Company ============================

  public static updateCompany(params: {
    nameAr?: string; nameEn?: string; taxNumber?: string; commercialRegister?: string;
    address?: string; phone?: string; email?: string; website?: string;
    contactName?: string; contactPhone?: string; logoDataUrl?: string;
    currentUsdExchangeRate?: number; userId?: string; userName?: string; isTest?: boolean;
  }): SettingsResult {
    const guard = AuthorizationService.enforce('settings', 'edit', params);
    if (!guard.allowed) return { success: false, error: guard.error };

    const db = erpDb.getSnapshot();
    const company = db.company;
    const patch: Partial<Company> = {};

    if (params.nameAr !== undefined) {
      const nameAr = trimTo(params.nameAr, 120);
      if (!nameAr) return { success: false, error: 'اسم الشركة العربي مطلوب' };
      patch.nameAr = nameAr;
    }
    if (params.nameEn !== undefined) {
      const nameEn = trimTo(params.nameEn, 160);
      if (!nameEn) return { success: false, error: 'اسم الشركة الإنجليزي مطلوب' };
      patch.nameEn = nameEn;
    }
    if (params.taxNumber !== undefined) {
      const taxNumber = trimTo(params.taxNumber, 30);
      if (taxNumber && !TAX_NUMBER.test(taxNumber)) {
        return { success: false, error: 'الرقم الضريبي غير صالح — أرقام وشرطات فقط (3 إلى 30 خانة)' };
      }
      patch.taxNumber = taxNumber;
    }
    if (params.commercialRegister !== undefined) patch.commercialRegister = trimTo(params.commercialRegister, 80);
    if (params.address !== undefined) patch.address = trimTo(params.address, 250);
    if (params.phone !== undefined) patch.phone = trimTo(params.phone, 40);
    if (params.contactPhone !== undefined) patch.contactPhone = trimTo(params.contactPhone, 40);
    if (params.contactName !== undefined) patch.contactName = trimTo(params.contactName, 80);
    if (params.email !== undefined) {
      const email = trimTo(params.email, 120);
      if (!validEmail(email)) return { success: false, error: 'البريد الإلكتروني غير صالح' };
      patch.email = email;
    }
    if (params.website !== undefined) {
      const website = trimTo(params.website, 200);
      if (website && !WEBSITE.test(website)) return { success: false, error: 'الموقع الإلكتروني يجب أن يبدأ بـ http:// أو https://' };
      patch.website = website;
    }
    if (params.logoDataUrl !== undefined) {
      const logoError = validateLogo(params.logoDataUrl);
      if (logoError) return { success: false, error: logoError };
      patch.logoDataUrl = params.logoDataUrl;
    }
    if (params.currentUsdExchangeRate !== undefined) {
      const rate = Number(params.currentUsdExchangeRate);
      if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) {
        return { success: false, error: 'سعر صرف الدولار يجب أن يكون رقمًا أكبر من صفر' };
      }
      patch.currentUsdExchangeRate = rate;
    }

    const changed = (Object.keys(patch) as Array<keyof Company>).filter(k => company[k] !== patch[k]);
    if (changed.length === 0) return { success: false, error: 'لا توجد تغييرات جديدة لحفظها' };

    const previous: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    for (const key of changed) {
      previous[key as string] = key === 'logoDataUrl' ? Boolean(company[key]) : company[key];
      next[key as string] = key === 'logoDataUrl' ? Boolean(patch[key]) : patch[key];
    }

    erpDb.mutate(draft => {
      Object.assign(draft.company, patch);
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId, userName: guard.userName,
        module: 'إعدادات الشركة والتخصيص', action: 'edit', recordId: 'company',
        previousValue: jsonForAudit(previous),
        newValue: jsonForAudit(next),
        description: `تعديل بيانات الشركة: ${labelsFor(changed as string[], COMPANY_FIELD_LABELS_AR)}`,
      });
    });

    return { success: true };
  }

  // ============================ Warehouses ============================

  public static createWarehouse(params: {
    code: string; nameAr: string; type: WarehouseType; location?: string;
    managerName?: string; managerUserId?: string; active?: boolean;
    userId?: string; userName?: string; isTest?: boolean;
  }): { success: boolean; warehouse?: Warehouse; error?: string } {
    const guard = AuthorizationService.enforce('settings', 'edit', params);
    if (!guard.allowed) return { success: false, error: guard.error };

    const db = erpDb.getSnapshot();
    const code = trimTo(params.code, 20).toUpperCase();
    const nameAr = trimTo(params.nameAr, 120);
    if (!WAREHOUSE_CODE.test(code)) {
      return { success: false, error: 'كود المستودع غير صالح — حروف إنجليزية وأرقام وشرطة (2 إلى 20 خانة)' };
    }
    if (!nameAr) return { success: false, error: 'اسم المستودع مطلوب' };
    if (!WAREHOUSE_TYPES.includes(params.type)) return { success: false, error: 'نوع المستودع غير معروف' };
    if (db.warehouses.some(w => w.code.trim().toUpperCase() === code)) {
      return { success: false, error: `كود المستودع (${code}) مستخدم بالفعل` };
    }
    if (params.managerUserId && !db.users.find(u => u.id === params.managerUserId)) {
      return { success: false, error: 'أمين المستودع المختار غير موجود' };
    }

    const warehouse: Warehouse = {
      id: generateErpId('wh'),
      code,
      nameAr,
      type: params.type,
      location: trimTo(params.location, 120),
      managerName: trimTo(params.managerName, 80),
      managerUserId: params.managerUserId,
      active: params.active !== false,
    };

    erpDb.mutate(draft => {
      draft.warehouses.push(warehouse);
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId, userName: guard.userName,
        module: 'إعدادات الشركة والتخصيص', action: 'create', recordId: warehouse.id,
        newValue: jsonForAudit({ code: warehouse.code, nameAr: warehouse.nameAr, type: warehouse.type }),
        description: `إضافة مستودع جديد ${warehouse.code} — ${warehouse.nameAr}`,
      });
    });

    return { success: true, warehouse };
  }

  public static updateWarehouse(warehouseId: string, params: {
    code?: string; nameAr?: string; type?: WarehouseType; location?: string;
    managerName?: string; managerUserId?: string;
    userId?: string; userName?: string; isTest?: boolean;
  }): SettingsResult {
    const guard = AuthorizationService.enforce('settings', 'edit', params);
    if (!guard.allowed) return { success: false, error: guard.error };

    const db = erpDb.getSnapshot();
    const existing = db.warehouses.find(w => w.id === warehouseId);
    if (!existing) return { success: false, error: 'المستودع غير موجود' };

    const patch: Partial<Warehouse> = {};
    if (params.code !== undefined) {
      const code = trimTo(params.code, 20).toUpperCase();
      if (!WAREHOUSE_CODE.test(code)) {
        return { success: false, error: 'كود المستودع غير صالح — حروف إنجليزية وأرقام وشرطة (2 إلى 20 خانة)' };
      }
      if (db.warehouses.some(w => w.id !== warehouseId && w.code.trim().toUpperCase() === code)) {
        return { success: false, error: `كود المستودع (${code}) مستخدم بالفعل` };
      }
      patch.code = code;
    }
    if (params.nameAr !== undefined) {
      const nameAr = trimTo(params.nameAr, 120);
      if (!nameAr) return { success: false, error: 'اسم المستودع مطلوب' };
      patch.nameAr = nameAr;
    }
    if (params.type !== undefined) {
      if (!WAREHOUSE_TYPES.includes(params.type)) return { success: false, error: 'نوع المستودع غير معروف' };
      patch.type = params.type;
    }
    if (params.location !== undefined) patch.location = trimTo(params.location, 120);
    if (params.managerName !== undefined) patch.managerName = trimTo(params.managerName, 80);
    if (params.managerUserId !== undefined) {
      if (params.managerUserId && !db.users.find(u => u.id === params.managerUserId)) {
        return { success: false, error: 'أمين المستودع المختار غير موجود' };
      }
      patch.managerUserId = params.managerUserId || undefined;
    }

    const changed = (Object.keys(patch) as Array<keyof Warehouse>).filter(k => existing[k] !== patch[k]);
    if (changed.length === 0) return { success: false, error: 'لا توجد تغييرات جديدة لحفظها' };

    const previous: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    for (const key of changed) {
      previous[key as string] = existing[key];
      next[key as string] = patch[key];
    }

    erpDb.mutate(draft => {
      const target = draft.warehouses.find(w => w.id === warehouseId);
      if (!target) return;
      Object.assign(target, patch);
      // Historical documents keep their own warehouseId and are never rewritten:
      // only the display name/code of the master record changes.
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId, userName: guard.userName,
        module: 'إعدادات الشركة والتخصيص', action: 'edit', recordId: warehouseId,
        previousValue: jsonForAudit(previous),
        newValue: jsonForAudit(next),
        description: `تعديل مستودع ${existing.code}: ${changed.join('، ')}`,
      });
    });

    return { success: true };
  }

  /**
   * Disable/enable a warehouse. Disabling never deletes it and never touches a
   * single historical movement or balance — only new documents stop offering it.
   */
  public static setWarehouseActive(warehouseId: string, active: boolean, options?: {
    reason?: string; userId?: string; userName?: string; isTest?: boolean;
  }): SettingsResult {
    const guard = AuthorizationService.enforce('settings', 'edit', options);
    if (!guard.allowed) return { success: false, error: guard.error };

    const db = erpDb.getSnapshot();
    const existing = db.warehouses.find(w => w.id === warehouseId);
    if (!existing) return { success: false, error: 'المستودع غير موجود' };
    if (existing.active === active) {
      return { success: false, error: active ? 'المستودع نشط بالفعل' : 'المستودع معطل بالفعل' };
    }

    erpDb.mutate(draft => {
      const target = draft.warehouses.find(w => w.id === warehouseId);
      if (!target) return;
      target.active = active;
      target.disabledReason = active ? undefined : trimTo(options?.reason, 200) || 'تعطيل إداري';
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId, userName: guard.userName,
        module: 'إعدادات الشركة والتخصيص', action: 'edit', recordId: warehouseId,
        previousValue: jsonForAudit({ active: existing.active }),
        newValue: jsonForAudit({ active }),
        description: `${active ? 'تنشيط' : 'تعطيل'} المستودع ${existing.code} — ${existing.nameAr}`
          + (active ? '' : ` (${trimTo(options?.reason, 200) || 'تعطيل إداري'})`),
      });
    });

    return { success: true };
  }

  /**
   * Delete is allowed ONLY when nothing references the warehouse. Any stock,
   * movement, invoice, return, production order or count blocks it — history is
   * never lost to a master-data edit.
   */
  public static deleteWarehouse(warehouseId: string, options?: {
    userId?: string; userName?: string; isTest?: boolean;
  }): SettingsResult {
    const guard = AuthorizationService.enforce('settings', 'delete', options);
    if (!guard.allowed) return { success: false, error: guard.error };

    const db = erpDb.getSnapshot();
    const existing = db.warehouses.find(w => w.id === warehouseId);
    if (!existing) return { success: false, error: 'المستودع غير موجود' };

    const usage = this.getWarehouseUsage(warehouseId);
    if (usage.total > 0 || usage.stockQuantity > 0) {
      return {
        success: false,
        error: `لا يمكن حذف المستودع (${existing.code}) لوجود حركات أو أرصدة تاريخية مرتبطة به `
          + `(أصناف/دفعات: ${usage.batches}، حركات مخزنية: ${usage.inventoryTransactions}، `
          + `فواتير بيع: ${usage.salesInvoices}، فواتير شراء: ${usage.purchaseInvoices}، `
          + `أوامر إنتاج: ${usage.productionOrders}). استخدم التعطيل بدلًا من الحذف.`,
      };
    }

    erpDb.mutate(draft => {
      draft.warehouses = draft.warehouses.filter(w => w.id !== warehouseId);
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId, userName: guard.userName,
        module: 'إعدادات الشركة والتخصيص', action: 'cancel', recordId: warehouseId,
        previousValue: jsonForAudit({ code: existing.code, nameAr: existing.nameAr, type: existing.type }),
        description: `حذف مستودع غير مستخدم ${existing.code} — ${existing.nameAr} (لا توجد حركات تاريخية)`,
      });
    });

    return { success: true };
  }

  // ============================ Storekeepers ============================

  public static createStorekeeper(params: {
    username: string; password: string; name: string; email?: string; phone?: string;
    role: RoleName; warehouseIds: string[]; permissions?: Record<string, string[]>;
    userId?: string; userName?: string; isTest?: boolean;
  }): { success: boolean; user?: User; error?: string } {
    const guard = AuthorizationService.enforce('users', 'create', params);
    if (!guard.allowed) return { success: false, error: guard.error };

    const db = erpDb.getSnapshot();
    const username = trimTo(params.username, 32).toLowerCase();
    const name = trimTo(params.name, 100);
    const password = String(params.password || '').trim();

    if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
      return { success: false, error: 'اسم الدخول غير صالح — حروف إنجليزية/أرقام/نقطة/شرطة (3 إلى 32) بدون مسافات' };
    }
    if (db.users.some(u => u.username.toLowerCase() === username)) {
      return { success: false, error: `اسم الدخول (${username}) مستخدم بالفعل` };
    }
    if (!name) return { success: false, error: 'اسم أمين المخزن مطلوب' };
    if (password.length < 6) return { success: false, error: 'كلمة المرور يجب ألا تقل عن 6 أحرف' };
    if (!STOREKEEPER_ROLES.includes(params.role)) {
      return { success: false, error: 'دور أمين المخزن يجب أن يكون (Warehouse Manager) أو (Warehouse Employee)' };
    }
    const email = trimTo(params.email, 120);
    if (!validEmail(email)) return { success: false, error: 'البريد الإلكتروني غير صالح' };

    const warehouseIds = Array.from(new Set((params.warehouseIds || []).map(id => String(id))));
    if (warehouseIds.length === 0) return { success: false, error: 'يجب ربط أمين المخزن بمستودع واحد على الأقل' };
    const unknown = warehouseIds.filter(id => !db.warehouses.some(w => w.id === id));
    if (unknown.length) return { success: false, error: 'أحد المستودعات المختارة غير موجود' };

    const perms = normalizePermissions(params.permissions);
    if (perms.error) return { success: false, error: perms.error };

    const user: User = {
      id: generateErpId('usr'),
      username,
      password,
      name,
      email,
      phone: trimTo(params.phone, 40),
      role: params.role,
      active: true,
      warehouseIds,
      permissions: perms.value,
      createdAt: new Date().toISOString(),
    };

    erpDb.mutate(draft => {
      draft.users.push(user);
      for (const wh of draft.warehouses) {
        if (warehouseIds.includes(wh.id)) {
          wh.managerUserId = user.id;
          wh.managerName = user.name;
        }
      }
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId, userName: guard.userName,
        module: 'إعدادات الشركة والتخصيص', action: 'create', recordId: user.id,
        // The password is never written to the audit trail.
        newValue: jsonForAudit({ username, name, role: user.role, warehouseIds, permissions: user.permissions }),
        description: `إضافة أمين مخزن ${user.name} (${user.username}) وربطه بـ ${warehouseIds.length} مستودع`,
      });
    });

    return { success: true, user };
  }

  public static updateStorekeeper(userId: string, params: {
    username?: string; password?: string; name?: string; email?: string; phone?: string;
    role?: RoleName; warehouseIds?: string[]; permissions?: Record<string, string[]>;
    userId?: string; userName?: string; isTest?: boolean;
  }): SettingsResult {
    const guard = AuthorizationService.enforce('users', 'edit', params);
    if (!guard.allowed) return { success: false, error: guard.error };

    const db = erpDb.getSnapshot();
    const existing = db.users.find(u => u.id === userId);
    if (!existing) return { success: false, error: 'أمين المخزن غير موجود' };
    if (!STOREKEEPER_ROLES.includes(existing.role)) {
      return { success: false, error: 'هذا المستخدم ليس أمين مخزن — عدّله من شاشة المستخدمين والصلاحيات' };
    }

    const patch: Partial<User> = {};
    if (params.username !== undefined) {
      const username = trimTo(params.username, 32).toLowerCase();
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
        return { success: false, error: 'اسم الدخول غير صالح — 3 إلى 32 حرفًا إنجليزيًا بدون مسافات' };
      }
      if (db.users.some(u => u.id !== userId && u.username.toLowerCase() === username)) {
        return { success: false, error: `اسم الدخول (${username}) مستخدم بالفعل` };
      }
      patch.username = username;
    }
    if (params.name !== undefined) {
      const name = trimTo(params.name, 100);
      if (!name) return { success: false, error: 'اسم أمين المخزن مطلوب' };
      patch.name = name;
    }
    if (params.email !== undefined) {
      const email = trimTo(params.email, 120);
      if (!validEmail(email)) return { success: false, error: 'البريد الإلكتروني غير صالح' };
      patch.email = email;
    }
    if (params.phone !== undefined) patch.phone = trimTo(params.phone, 40);
    if (params.role !== undefined) {
      if (!STOREKEEPER_ROLES.includes(params.role)) {
        return { success: false, error: 'دور أمين المخزن يجب أن يكون (Warehouse Manager) أو (Warehouse Employee)' };
      }
      patch.role = params.role;
    }
    if (params.password !== undefined && params.password.trim()) {
      if (params.password.trim().length < 6) return { success: false, error: 'كلمة المرور يجب ألا تقل عن 6 أحرف' };
      patch.password = params.password.trim();
    }
    let warehouseIds: string[] | undefined;
    if (params.warehouseIds !== undefined) {
      warehouseIds = Array.from(new Set(params.warehouseIds.map(id => String(id))));
      if (warehouseIds.length === 0) return { success: false, error: 'يجب ربط أمين المخزن بمستودع واحد على الأقل' };
      if (warehouseIds.some(id => !db.warehouses.some(w => w.id === id))) {
        return { success: false, error: 'أحد المستودعات المختارة غير موجود' };
      }
      patch.warehouseIds = warehouseIds;
    }
    const perms = normalizePermissions(params.permissions);
    if (perms.error) return { success: false, error: perms.error };
    if (perms.value !== undefined) patch.permissions = perms.value;

    const changed = (Object.keys(patch) as Array<keyof User>).filter(k => {
      if (k === 'warehouseIds' || k === 'permissions') {
        return JSON.stringify(existing[k] || null) !== JSON.stringify(patch[k] || null);
      }
      return existing[k] !== patch[k];
    });
    if (changed.length === 0) return { success: false, error: 'لا توجد تغييرات جديدة لحفظها' };

    const previous: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    for (const key of changed) {
      if (key === 'password') {
        previous.password = '********';
        next.password = '********';
        continue;
      }
      previous[key as string] = existing[key];
      next[key as string] = patch[key];
    }

    erpDb.mutate(draft => {
      const target = draft.users.find(u => u.id === userId);
      if (!target) return;
      Object.assign(target, patch);
      if (warehouseIds) {
        for (const wh of draft.warehouses) {
          if (wh.managerUserId === userId && !warehouseIds.includes(wh.id)) {
            wh.managerUserId = undefined;
            wh.managerName = '';
          }
          if (warehouseIds.includes(wh.id)) {
            wh.managerUserId = userId;
            wh.managerName = target.name;
          }
        }
      } else if (patch.name) {
        for (const wh of draft.warehouses) {
          if (wh.managerUserId === userId) wh.managerName = patch.name;
        }
      }
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId, userName: guard.userName,
        module: 'إعدادات الشركة والتخصيص', action: 'edit', recordId: userId,
        previousValue: jsonForAudit(previous),
        newValue: jsonForAudit(next),
        description: `تعديل بيانات أمين المخزن ${target.name} (${target.username}): ${changed.join('، ')}`,
      });
    });

    return { success: true };
  }

  /** Disable/enable a storekeeper. Never deletes the user or any history. */
  public static setStorekeeperActive(userId: string, active: boolean, options?: {
    reason?: string; userId?: string; userName?: string; isTest?: boolean;
  }): SettingsResult {
    const guard = AuthorizationService.enforce('users', 'edit', options);
    if (!guard.allowed) return { success: false, error: guard.error };

    const db = erpDb.getSnapshot();
    const existing = db.users.find(u => u.id === userId);
    if (!existing) return { success: false, error: 'أمين المخزن غير موجود' };
    if (existing.role === 'Super Admin') {
      return { success: false, error: 'لا يمكن تعطيل حساب المشرف العام من هذه الشاشة' };
    }
    if (existing.active === active) {
      return { success: false, error: active ? 'الحساب نشط بالفعل' : 'الحساب معطل بالفعل' };
    }

    erpDb.mutate(draft => {
      const target = draft.users.find(u => u.id === userId);
      if (!target) return;
      target.active = active;
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId, userName: guard.userName,
        module: 'إعدادات الشركة والتخصيص', action: 'edit', recordId: userId,
        previousValue: jsonForAudit({ active: existing.active }),
        newValue: jsonForAudit({ active }),
        description: `${active ? 'تنشيط' : 'تعطيل'} أمين المخزن ${existing.name} (${existing.username})`
          + (active ? '' : ` — ${trimTo(options?.reason, 200) || 'تعطيل إداري'} — السجلات التاريخية محفوظة`),
      });
    });

    return { success: true };
  }

  // ============================ Invoice design ============================

  public static updateInvoiceTemplate(params: Partial<InvoiceTemplateSettings> & {
    userId?: string; userName?: string; isTest?: boolean;
  }): SettingsResult {
    const guard = AuthorizationService.enforce('settings', 'edit', params);
    if (!guard.allowed) return { success: false, error: guard.error };

    const current = this.getInvoiceTemplate();
    const patch: Partial<InvoiceTemplateSettings> = {};

    const text = (key: keyof InvoiceTemplateSettings, max: number, required = false) => {
      if (params[key] === undefined) return;
      const value = trimTo(params[key], max);
      if (required && !value) throw new Error('نص التذييل لا يمكن أن يكون فارغًا');
      (patch as Record<string, unknown>)[key as string] = value;
    };

    try {
      text('headerTextAr', 1500);
      text('headerTextEn', 500);
      text('footerText', 1500);
      text('netDueLabel', 80, true);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }

    for (const key of ['accentColor', 'textColor'] as const) {
      if (params[key] === undefined) continue;
      const value = trimTo(params[key], 7);
      if (!HEX_COLOR.test(value)) return { success: false, error: 'اللون يجب أن يكون بصيغة HEX مثل #0f172a' };
      patch[key] = value;
    }

    const sizes: Array<[keyof InvoiceTemplateSettings, number, number]> = [
      ['titleFontSize', 10, 40], ['bodyFontSize', 8, 24], ['tableFontSize', 8, 24],
    ];
    for (const [key, min, max] of sizes) {
      if (params[key] === undefined) continue;
      const value = Number(params[key]);
      if (!Number.isInteger(value) || value < min || value > max) {
        return { success: false, error: `حجم الخط (${TEMPLATE_FIELD_LABELS_AR[key as string]}) يجب أن يكون بين ${min} و ${max}` };
      }
      (patch as Record<string, unknown>)[key as string] = value;
    }

    if (params.alignment !== undefined) {
      if (!['right', 'center', 'left'].includes(params.alignment)) return { success: false, error: 'المحاذاة غير صالحة' };
      patch.alignment = params.alignment as InvoiceAlignment;
    }

    const booleans: Array<keyof InvoiceTemplateSettings> = [
      'showLogo', 'showTaxNumber', 'showAddress', 'showPhone', 'showEmail', 'showCustomerTax',
      'showWarehouse', 'showWithholding', 'showNetDue', 'showAccentBar',
    ];
    for (const key of booleans) {
      if (params[key] === undefined) continue;
      (patch as Record<string, unknown>)[key as string] = Boolean(params[key]);
    }

    if (params.logoDataUrl !== undefined) {
      const logoError = validateLogo(params.logoDataUrl);
      if (logoError) return { success: false, error: logoError };
      patch.logoDataUrl = params.logoDataUrl;
    }

    const changed = (Object.keys(patch) as Array<keyof InvoiceTemplateSettings>)
      .filter(k => current[k] !== patch[k]);
    if (changed.length === 0) return { success: false, error: 'لا توجد تغييرات جديدة لحفظها' };

    const previous: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    for (const key of changed) {
      previous[key as string] = current[key];
      next[key as string] = patch[key];
    }

    erpDb.mutate(draft => {
      draft.settings = {
        ...(draft.settings || { expiryWarningDays: 10 }),
        invoiceTemplate: { ...this.getInvoiceTemplate(), ...patch },
      };
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId, userName: guard.userName,
        module: 'إعدادات الشركة والتخصيص', action: 'edit', recordId: 'settings.invoiceTemplate',
        previousValue: jsonForAudit(previous),
        newValue: jsonForAudit(next),
        description: `تعديل تصميم الفاتورة: ${labelsFor(changed as string[], TEMPLATE_FIELD_LABELS_AR)}`,
      });
    });

    return { success: true };
  }
}
