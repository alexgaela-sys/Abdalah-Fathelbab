// Master-data write service (F15).
//
// Purpose: no UI screen may mutate the database directly any more. Every
// create/edit/toggle of a master record (customers, suppliers, items, users,
// company settings, account mappings) goes through this service, which:
//
//   1. enforces AuthorizationService BEFORE any mutation (hiding a button is
//      never treated as authorization),
//   2. validates referential/uniqueness rules,
//   3. writes a proper audit log entry attributed to the resolved actor.
//
// Existing records are only ever updated in place — this service never resets,
// reseeds or re-creates master data.
import { erpDb, generateErpId } from './db';
import { AuthorizationService, GuardOptions } from './authorization';
import { Customer, Supplier, Item, User, RoleName, PermissionAction } from '../types/erp';
import { ALL_MODULES, ASSIGNABLE_ACTIONS } from './permissions';
import { channelForCustomerType } from './pricing';

type ModuleAction = { module: any; action: 'create' | 'edit' };

function guard(ma: ModuleAction, options?: GuardOptions) {
  return AuthorizationService.enforce(ma.module, ma.action, options);
}

export class MasterDataService {
  // ============================ Customers ============================

  public static createCustomer(params: {
    code: string; name: string; customerType: Customer['customerType']; channel: string;
    address?: string; phone?: string; taxNumber?: string; currency?: 'EGP' | 'USD';
    creditLimit?: number; openingBalance?: number; paymentTerms?: string;
    userId?: string; userName?: string; isTest?: boolean;
  }): { success: boolean; customer?: Customer; error?: string } {
    const g = guard({ module: 'customers', action: 'create' }, params);
    if (!g.allowed) return { success: false, error: g.error };

    const db = erpDb.getSnapshot();
    const code = (params.code || '').trim();
    const name = (params.name || '').trim();
    if (!code) return { success: false, error: 'كود العميل مطلوب' };
    if (!name) return { success: false, error: 'اسم العميل مطلوب' };
    if (db.customers.some(c => c.code.toLowerCase() === code.toLowerCase())) {
      return { success: false, error: `كود العميل (${code}) مستخدم بالفعل` };
    }
    if (db.customers.some(c => c.name.trim() === name)) {
      return { success: false, error: `العميل (${name}) مسجل بالفعل` };
    }

    const opening = Number(params.openingBalance) || 0;
    const customer: Customer = {
      id: generateErpId('cust'),
      code,
      name,
      customerType: params.customerType,
      // QA-26: the persisted channel is DERIVED from the customer master type
      // using the single existing mapping (the same one SalesView uses), so a
      // caller passing a stale/blank `channel` can never persist a
      // contradiction such as "retail customer / wholesale channel".
      channel: channelForCustomerType(params.customerType),
      address: params.address || '',
      phone: params.phone || '',
      taxNumber: params.taxNumber || '',
      currency: params.currency || 'EGP',
      creditLimit: Number(params.creditLimit) || 0,
      currentBalance: opening,
      paymentTerms: params.paymentTerms || '',
      openingBalance: opening,
      active: true,
    };

    erpDb.mutate(draft => {
      draft.customers.push(customer);
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: g.userId, userName: g.userName,
        module: 'إدارة العملاء', action: 'create', recordId: customer.id,
        description: `إنشاء عميل جديد: ${customer.code} - ${customer.name} (${customer.customerType})`,
      });
    });

    return { success: true, customer };
  }

  /** Toggle customer active flag without touching their balance or history. */
  public static setCustomerActive(customerId: string, active: boolean, options?: GuardOptions): { success: boolean; error?: string } {
    const g = guard({ module: 'customers', action: 'edit' }, options);
    if (!g.allowed) return { success: false, error: g.error };

    const db = erpDb.getSnapshot();
    const existing = db.customers.find(c => c.id === customerId);
    if (!existing) return { success: false, error: 'العميل غير موجود' };

    erpDb.mutate(draft => {
      const c = draft.customers.find(x => x.id === customerId);
      if (!c) return;
      c.active = active;
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: g.userId, userName: g.userName,
        module: 'إدارة العملاء', action: 'edit', recordId: customerId,
        description: `${active ? 'إعادة تنشيط' : 'تعطيل'} العميل ${existing.code} - ${existing.name}`,
      });
    });

    return { success: true };
  }

  // ============================ Suppliers ============================

  public static createSupplier(params: {
    code: string; name: string; taxNumber?: string; contactPerson?: string; phone?: string;
    address?: string; paymentTerms?: string; currency?: 'EGP' | 'USD'; openingBalance?: number;
    userId?: string; userName?: string; isTest?: boolean;
  }): { success: boolean; supplier?: Supplier; error?: string } {
    const g = guard({ module: 'suppliers', action: 'create' }, params);
    if (!g.allowed) return { success: false, error: g.error };

    const db = erpDb.getSnapshot();
    const code = (params.code || '').trim();
    const name = (params.name || '').trim();
    if (!code) return { success: false, error: 'كود المورد مطلوب' };
    if (!name) return { success: false, error: 'اسم المورد مطلوب' };
    if (db.suppliers.some(s => s.code.toLowerCase() === code.toLowerCase())) {
      return { success: false, error: `كود المورد (${code}) مستخدم بالفعل` };
    }
    if (db.suppliers.some(s => s.name.trim() === name)) {
      return { success: false, error: `المورد (${name}) مسجل بالفعل` };
    }

    const opening = Number(params.openingBalance) || 0;
    const supplier: Supplier = {
      id: generateErpId('sup'),
      code,
      name,
      taxNumber: (params.taxNumber || '').trim(),
      contactPerson: (params.contactPerson || '').trim(),
      phone: (params.phone || '').trim(),
      address: (params.address || '').trim(),
      paymentTerms: params.paymentTerms || '',
      currency: params.currency || 'EGP',
      openingBalance: opening,
      currentBalance: opening,
      active: true,
    };

    erpDb.mutate(draft => {
      draft.suppliers.push(supplier);
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: g.userId, userName: g.userName,
        module: 'إدارة الموردين', action: 'create', recordId: supplier.id,
        description: `إنشاء مورد جديد: ${supplier.code} - ${supplier.name}`,
      });
    });

    return { success: true, supplier };
  }

  public static setSupplierActive(supplierId: string, active: boolean, options?: GuardOptions): { success: boolean; error?: string } {
    const g = guard({ module: 'suppliers', action: 'edit' }, options);
    if (!g.allowed) return { success: false, error: g.error };

    const db = erpDb.getSnapshot();
    const existing = db.suppliers.find(s => s.id === supplierId);
    if (!existing) return { success: false, error: 'المورد غير موجود' };

    erpDb.mutate(draft => {
      const s = draft.suppliers.find(x => x.id === supplierId);
      if (!s) return;
      s.active = active;
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: g.userId, userName: g.userName,
        module: 'إدارة الموردين', action: 'edit', recordId: supplierId,
        description: `${active ? 'إعادة تنشيط' : 'تعطيل'} المورد ${existing.code} - ${existing.name}`,
      });
    });

    return { success: true };
  }

  // ============================ Items (products / raw / packaging) ============================

  public static createItem(item: Omit<Item, 'id'>, options?: GuardOptions): { success: boolean; item?: Item; error?: string } {
    const g = guard({ module: 'items', action: 'create' }, options);
    if (!g.allowed) return { success: false, error: g.error };

    const db = erpDb.getSnapshot();
    const code = (item.code || '').trim().toUpperCase();
    if (!code) return { success: false, error: 'كود الصنف مطلوب' };
    if (!item.nameAr?.trim()) return { success: false, error: 'اسم الصنف بالعربية مطلوب' };
    if (db.items.some(i => i.code.toUpperCase() === code)) {
      return { success: false, error: `كود الصنف (${code}) مستخدم بالفعل` };
    }
    if (!db.units.some(u => u.id === item.baseUnitId)) {
      return { success: false, error: 'وحدة القياس الأساسية غير مسجلة بدليل الوحدات' };
    }

    const created: Item = { ...item, id: generateErpId('item'), code };
    erpDb.mutate(draft => {
      draft.items.push(created);
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: g.userId, userName: g.userName,
        module: 'سجل الأصناف', action: 'create', recordId: created.id,
        description: `إنشاء صنف جديد ${created.code} - ${created.nameAr}`,
      });
    });

    return { success: true, item: created };
  }

  /** Edit an existing item in place (id, code and ledger-bearing fields preserved). */
  public static updateItem(item: Item, options?: GuardOptions): { success: boolean; error?: string } {
    const g = guard({ module: 'items', action: 'edit' }, options);
    if (!g.allowed) return { success: false, error: g.error };

    const db = erpDb.getSnapshot();
    const existing = db.items.find(i => i.id === item.id);
    if (!existing) return { success: false, error: 'الصنف غير موجود' };
    if (db.items.some(i => i.id !== item.id && i.code.toUpperCase() === (item.code || '').trim().toUpperCase())) {
      return { success: false, error: `كود الصنف (${item.code}) مستخدم بالفعل` };
    }

    erpDb.mutate(draft => {
      const idx = draft.items.findIndex(i => i.id === item.id);
      if (idx === -1) return;
      // Keep the original id so stock, batches, BOMs and invoice lines stay linked.
      draft.items[idx] = { ...item, id: existing.id };
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: g.userId, userName: g.userName,
        module: 'سجل الأصناف', action: 'edit', recordId: item.id,
        description: `تعديل بيانات الصنف ${item.code} - ${item.nameAr}`,
      });
    });

    return { success: true };
  }

  public static setItemActive(itemId: string, active: boolean, options?: GuardOptions): { success: boolean; error?: string } {
    const g = guard({ module: 'items', action: 'edit' }, options);
    if (!g.allowed) return { success: false, error: g.error };

    const db = erpDb.getSnapshot();
    const existing = db.items.find(i => i.id === itemId);
    if (!existing) return { success: false, error: 'الصنف غير موجود' };

    erpDb.mutate(draft => {
      const itm = draft.items.find(i => i.id === itemId);
      if (!itm) return;
      itm.active = active;
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: g.userId, userName: g.userName,
        module: 'سجل الأصناف', action: 'edit', recordId: itemId,
        description: `${active ? 'إعادة تنشيط' : 'تعطيل'} الصنف ${existing.code} - ${existing.nameAr}`,
      });
    });

    return { success: true };
  }

  // ============================ Users ============================

  /**
   * Create a system user. F15: there is NO insecure default password — the
   * password is mandatory and must be at least 6 characters.
   */
  public static createUser(params: {
    username: string; password: string; name: string; email?: string; role: RoleName;
    userId?: string; userName?: string; isTest?: boolean;
  }): { success: boolean; user?: User; error?: string } {
    const g = guard({ module: 'users', action: 'create' }, params);
    if (!g.allowed) return { success: false, error: g.error };

    const db = erpDb.getSnapshot();
    const username = (params.username || '').trim().toLowerCase();
    const name = (params.name || '').trim();
    const password = (params.password || '').trim();

    if (!username) return { success: false, error: 'اسم الدخول (username) مطلوب' };
    if (!name) return { success: false, error: 'اسم المستخدم مطلوب' };
    if (!password) return { success: false, error: 'كلمة المرور مطلوبة — لا يوجد كلمة مرور افتراضية' };
    if (password.length < 6) return { success: false, error: 'كلمة المرور يجب ألا تقل عن 6 أحرف' };
    if (db.users.some(u => u.username.toLowerCase() === username)) {
      return { success: false, error: `اسم الدخول (${username}) مستخدم بالفعل` };
    }

    const user: User = {
      id: generateErpId('usr'),
      username,
      password,
      name,
      email: (params.email || '').trim(),
      role: params.role,
      active: true,
      createdAt: new Date().toISOString(),
    };

    erpDb.mutate(draft => {
      draft.users.push(user);
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: g.userId, userName: g.userName,
        module: 'المستخدمون والصلاحيات', action: 'create', recordId: user.id,
        description: `إنشاء مستخدم جديد ${user.username} (${user.role}) بواسطة ${g.userName}`,
      });
    });

    return { success: true, user };
  }

  public static setUserActive(userId: string, active: boolean, options?: GuardOptions): { success: boolean; error?: string } {
    const g = guard({ module: 'users', action: 'edit' }, options);
    if (!g.allowed) return { success: false, error: g.error };

    const db = erpDb.getSnapshot();
    const existing = db.users.find(u => u.id === userId);
    if (!existing) return { success: false, error: 'المستخدم غير موجود' };
    if (existing.role === 'Super Admin' && !active) {
      return { success: false, error: 'لا يمكن تعطيل حساب المشرف العام' };
    }

    erpDb.mutate(draft => {
      const u = draft.users.find(x => x.id === userId);
      if (!u) return;
      u.active = active;
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: g.userId, userName: g.userName,
        module: 'المستخدمون والصلاحيات', action: 'edit', recordId: userId,
        description: `${active ? 'تنشيط' : 'تعطيل'} المستخدم ${existing.username}`,
      });
    });

    return { success: true };
  }

  /**
   * Self-service profile update. A user may always edit their own contact data
   * and password; changing role/active status is a PRIVILEGED action and is only
   * applied when AuthorizationService grants 'edit' on the users module.
   */
  public static updateOwnProfile(params: {
    userId: string; name: string; username: string; email?: string; phone?: string;
    avatar?: string; newPassword?: string; requestedRole?: RoleName; requestedActive?: boolean;
    options?: GuardOptions;
  }): { success: boolean; user?: User; error?: string } {
    const db = erpDb.getSnapshot();
    const existing = db.users.find(u => u.id === params.userId);
    if (!existing) return { success: false, error: 'المستخدم غير موجود' };

    const privileged = AuthorizationService.enforce('users', 'edit', params.options).allowed;
    const name = (params.name || '').trim();
    const username = (params.username || '').trim().toLowerCase();
    if (!name) return { success: false, error: 'الاسم مطلوب' };
    if (!username) return { success: false, error: 'اسم المستخدم مطلوب' };
    if (db.users.some(u => u.id !== existing.id && u.username.toLowerCase() === username)) {
      return { success: false, error: `اسم الدخول (${username}) مستخدم بالفعل` };
    }
    if (params.newPassword && params.newPassword.trim().length < 4) {
      return { success: false, error: 'كلمة المرور يجب أن تكون 4 أحرف على الأقل' };
    }

    let updated: User | undefined;
    erpDb.mutate(draft => {
      const u = draft.users.find(x => x.id === existing.id);
      if (!u) return;
      u.name = name;
      u.username = username;
      u.email = (params.email || '').trim();
      if (params.phone !== undefined) u.phone = params.phone.trim();
      if (params.avatar !== undefined) u.avatar = params.avatar;
      if (params.newPassword && params.newPassword.trim()) u.password = params.newPassword.trim();
      // Role / active status only move with 'users:edit' — no self-elevation.
      if (privileged) {
        if (params.requestedRole) u.role = params.requestedRole;
        if (params.requestedActive !== undefined) {
          if (u.role === 'Super Admin' && !params.requestedActive && u.id === 'usr-admin') {
            // keep as-is; deleting/disabling the bootstrap admin is blocked
          } else {
            u.active = params.requestedActive;
          }
        }
      }
      updated = { ...u };
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: existing.id, userName: existing.name,
        module: 'الملف الشخصي والمستخدمين', action: 'edit', recordId: u.id,
        previousValue: JSON.stringify({ name: existing.name, username: existing.username, role: existing.role }),
        newValue: JSON.stringify({ name: u.name, username: u.username, role: u.role, passwordChanged: !!params.newPassword }),
        description: `تعديل بيانات المستخدم (${u.name})${privileged ? ' [تحديث الصلاحيات]' : ''}${params.newPassword ? ' + كلمة المرور' : ''}`,
      });
    });

    return { success: true, user: updated };
  }

  public static deleteUser(userId: string, options?: GuardOptions): { success: boolean; error?: string } {
    // Deleting a user is an 'edit'-level administrative action on the users module.
    const g = guard({ module: 'users', action: 'edit' }, options);
    if (!g.allowed) return { success: false, error: g.error };

    const db = erpDb.getSnapshot();
    const existing = db.users.find(u => u.id === userId);
    if (!existing) return { success: false, error: 'المستخدم غير موجود' };
    if (userId === 'usr-admin') return { success: false, error: 'لا يمكن حذف حساب المشرف العام الأساسي للنظام' };
    if (db.users.filter(u => u.role === 'Super Admin' && u.active).length <= 1 && existing.role === 'Super Admin') {
      return { success: false, error: 'لا يمكن حذف المشرف العام الوحيد المتبقي بالنظام' };
    }

    erpDb.mutate(draft => {
      draft.users = draft.users.filter(u => u.id !== userId);
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: g.userId, userName: g.userName,
        module: 'المستخدمون والصلاحيات', action: 'edit', recordId: userId,
        description: `حذف المستخدم ${existing.username} (${existing.role}) بواسطة ${g.userName}`,
      });
    });

    return { success: true };
  }

  /**
   * F23 — EXPLICIT per-user permission assignment.
   *
   * The Super Admin grants, per user and per module, the exact actions
   * (view / create / edit / delete / approve / post). The written map REPLACES
   * the role matrix for the modules it contains; modules it omits keep following
   * the user's role. This is enforced by AuthorizationService (the real security
   * boundary) — the permissions screen is only the UI that calls this service.
   *
   * Super Admin is PROTECTED: it can never be edited, disabled, demoted or
   * permission-overridden, and no user (including a Super Admin) can grant more
   * than the role matrix allows unless the Super Admin is the actor.
   */
  public static updateUserPermissions(params: {
    userId: string;
    permissions: Record<string, string[]>; // module key -> action names
    options?: GuardOptions;
  }): { success: boolean; error?: string } {
    const g = guard({ module: 'users', action: 'edit' }, params.options);
    if (!g.allowed) return { success: false, error: g.error };

    const db = erpDb.getSnapshot();
    const target = db.users.find(u => u.id === params.userId);
    if (!target) return { success: false, error: 'المستخدم غير موجود' };
    if (target.id === 'usr-admin' || target.username?.toLowerCase() === 'admin' || target.role === 'Super Admin') {
      return { success: false, error: 'حساب المشرف العام محمي ولا يمكن تعديل صلاحياته' };
    }

    const actor = db.users.find(u => u.id === g.userId);
    const actorIsSuper = !actor || actor.role === AuthorizationService.SUPER_ADMIN_ROLE;
    if (!actorIsSuper) {
      return { success: false, error: 'إدارة صلاحيات المستخدمين متاحة للمشرف العام فقط' };
    }

    const clean: Record<string, PermissionAction[]> = {};
    for (const key of Object.keys(params.permissions || {})) {
      if (!(ALL_MODULES as string[]).includes(key)) {
        return { success: false, error: `وحدة غير معروفة في مصفوفة الصلاحيات: ${key}` };
      }
      const actions = (params.permissions[key] || []).filter(a =>
        (ASSIGNABLE_ACTIONS as string[]).includes(a)
      ) as PermissionAction[];
      clean[key] = Array.from(new Set(actions));
    }

    erpDb.mutate(draft => {
      const u = draft.users.find(x => x.id === params.userId);
      if (!u) return;
      u.permissions = clean;
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: g.userId, userName: g.userName,
        module: 'المستخدمون والصلاحيات', action: 'edit', recordId: params.userId,
        description: `تحديث صلاحيات المستخدم ${u.username} (${u.role}) بواسطة ${g.userName}: ${Object.keys(clean).length} وحدة`,
      });
    });

    return { success: true };
  }

  /** Clear a user's explicit overrides and return them to their role matrix. */
  public static resetUserPermissions(userId: string, options?: GuardOptions): { success: boolean; error?: string } {
    const g = guard({ module: 'users', action: 'edit' }, options);
    if (!g.allowed) return { success: false, error: g.error };
    const db = erpDb.getSnapshot();
    const target = db.users.find(u => u.id === userId);
    if (!target) return { success: false, error: 'المستخدم غير موجود' };
    if (target.role === 'Super Admin') {
      return { success: false, error: 'حساب المشرف العام محمي ولا يمكن تعديل صلاحياته' };
    }
    erpDb.mutate(draft => {
      const u = draft.users.find(x => x.id === userId);
      if (!u) return;
      delete u.permissions;
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: g.userId, userName: g.userName,
        module: 'المستخدمون والصلاحيات', action: 'edit', recordId: userId,
        description: `إلغاء تخصيص الصلاحيات للمستخدم ${u.username} والعودة لصلاحيات دوره`,
      });
    });
    return { success: true };
  }

  // ============================ Settings ============================

  /**
   * Create a finished product together with its initial active BOM (V1) — the
   * behavior the Settings screen had, now guarded and with deterministic ids.
   * Default material lines are only added when those catalog items exist.
   */
  public static createFinishedProductWithBom(params: {
    item: Omit<Item, 'id'>;
    bom?: { baseQuantity: number; unitId: string; notes?: string };
    userId?: string; userName?: string; isTest?: boolean;
  }): { success: boolean; item?: Item; error?: string } {
    const g = guard({ module: 'items', action: 'create' }, params);
    if (!g.allowed) return { success: false, error: g.error };

    const db = erpDb.getSnapshot();
    const code = (params.item.code || '').trim().toUpperCase();
    if (!code) return { success: false, error: 'كود المنتج مطلوب' };
    if (!params.item.nameAr?.trim()) return { success: false, error: 'اسم المنتج بالعربية مطلوب' };
    if (db.items.some(i => i.code.toUpperCase() === code)) return { success: false, error: `كود الصنف (${code}) مستخدم بالفعل` };

    const item: Item = { ...params.item, id: generateErpId('item'), code };
    const bomId = generateErpId('bom');
    const baseQuantity = params.bom?.baseQuantity || 1000;
    const unitId = params.bom?.unitId || item.baseUnitId;

    // Default starter recipe, only for materials that actually exist in the catalog.
    const defaultLines = [
      { materialItemId: 'item-raw-corn', quantityRequired: 800, unitId: 'unit-kg' },
      { materialItemId: 'item-raw-oil', quantityRequired: 180, unitId: 'unit-kg' },
      { materialItemId: 'item-pkg-carton', quantityRequired: 1000, unitId: 'unit-piece' },
    ].filter(l => db.items.some(i => i.id === l.materialItemId));

    erpDb.mutate(draft => {
      draft.items.push(item);
      draft.boms.push({
        id: bomId,
        bomNumber: `BOM-${item.code}-V1`,
        finishedItemId: item.id,
        version: 1,
        baseQuantity,
        unitId,
        active: true,
        effectiveDate: new Date().toISOString().split('T')[0],
        notes: params.bom?.notes || `معادلة تصنيع ${baseQuantity} ${unitId} من ${item.nameAr}`,
      });
      defaultLines.forEach((l, idx) => {
        draft.bomLines.push({ id: `bline-${bomId}-${idx + 1}`, bomId, ...l });
      });
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: g.userId, userName: g.userName,
        module: 'إعدادات المنتجات', action: 'create', recordId: item.id,
        description: `إنشاء منتج تام جديد مع معادلة تصنيع V1: ${item.code} - ${item.nameAr}`,
      });
    });

    return { success: true, item };
  }

  public static updateCompanySettings(params: {
    nameAr?: string; taxNumber?: string; currentUsdExchangeRate?: number;
    userId?: string; userName?: string; isTest?: boolean;
  }): { success: boolean; error?: string } {
    const g = guard({ module: 'settings', action: 'edit' }, params);
    if (!g.allowed) return { success: false, error: g.error };

    if (params.currentUsdExchangeRate !== undefined && !(Number(params.currentUsdExchangeRate) > 0)) {
      return { success: false, error: 'سعر صرف الدولار يجب أن يكون أكبر من صفر' };
    }

    erpDb.mutate(draft => {
      if (params.nameAr !== undefined) draft.company.nameAr = params.nameAr;
      if (params.taxNumber !== undefined) draft.company.taxNumber = params.taxNumber;
      if (params.currentUsdExchangeRate !== undefined) draft.company.currentUsdExchangeRate = Number(params.currentUsdExchangeRate);
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: g.userId, userName: g.userName,
        module: 'إعدادات النظام', action: 'edit', recordId: 'company',
        description: `تحديث إعدادات الشركة (سعر الصرف: ${draft.company.currentUsdExchangeRate})`,
      });
    });

    return { success: true };
  }

  /** Re-map a posting key (e.g. export_costs) to a different GL account. */  public static updateAccountMapping(mappingKey: string, accountId: string, options?: GuardOptions): { success: boolean; error?: string } {
    const g = guard({ module: 'settings', action: 'edit' }, options);
    if (!g.allowed) return { success: false, error: g.error };

    const db = erpDb.getSnapshot();
    const account = db.accounts.find(a => a.id === accountId);
    if (!account) return { success: false, error: 'الحساب المختار غير موجود بدليل الحسابات' };
    if (account.isHeader) return { success: false, error: 'لا يمكن ربط مفتاحترحيل بحساب رئيسي تجميعي' };
    if (!(mappingKey in db.accountMappings)) return { success: false, error: `مفتاح الترحيل (${mappingKey}) غير معروف` };

    erpDb.mutate(draft => {
      const previous = draft.accountMappings[mappingKey];
      draft.accountMappings[mappingKey] = accountId;
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: g.userId, userName: g.userName,
        module: 'إعدادات النظام', action: 'edit', recordId: mappingKey,
        description: `تغيير ربط مفتاح الترحيل ${mappingKey} من ${previous} إلى ${account.code} - ${account.nameAr}`,
      });
    });

    return { success: true };
  }
}
