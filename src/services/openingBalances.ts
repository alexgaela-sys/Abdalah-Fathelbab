// Opening balances (أرصدة أول المدة) — loading the books at the cut-over date.
//
// Why this exists: an opening position is NOT income and NOT a stock count.
//   • Typing an opening balance on a customer/supplier card moved only the card, never the books,
//     so the trial balance, the aging and the card disagreed.
//   • Loading opening stock through "تسوية جرد" booked the whole value to 5104 (a COGS variance
//     account) as a "gain".
// Every opening entry here is a balanced journal against ONE equity account — 3103 "أرصدة أول
// المدة" — never against revenue or cost accounts:
//
//   stock      Dr inventory (by warehouse type)          Cr 3103
//   customers  Dr 1105 (local) / 1106 (export)           Cr 3103
//   suppliers  Dr 3103                                   Cr 2101 (payable)
//
// When every opening balance is loaded, 3103 holds the opening net equity and the accountant
// reclassifies it (e.g. to capital / retained earnings) with a normal journal.
import { erpDb, generateErpId } from './db';
import { AccountingEngine } from './accounting';
import { InventoryEngine } from './inventory';
import { AuthorizationService, GuardOptions } from './authorization';
import { currencyForCustomerType } from './pricing';
import type { JournalLine } from '../types/erp';

export const OPENING_EQUITY_ACCOUNT_ID = 'acc-3103';
export const OPENING_SOURCE_TYPES = ['opening_balance_inventory', 'opening_balance_customer', 'opening_balance_supplier', 'opening_balance_general'];
const OPENING_DOC_LABEL = 'رصيد أول المدة';

type Actor = Pick<GuardOptions, 'userId' | 'userName' | 'isTest'>;

function line(accountId: string, debit: number, credit: number, original: number, rate: number, currency: 'EGP' | 'USD', description: string): Omit<JournalLine, never> {
  const acc = erpDb.getSnapshot().accounts.find(a => a.id === accountId);
  return {
    id: '', journalEntryId: '', accountId, accountCode: acc?.code || '', accountNameAr: acc?.nameAr || '',
    debit, credit, currency, originalAmount: original, exchangeRate: rate, description,
  } as JournalLine;
}
const r2 = (n: number) => Math.round(n * 100) / 100;

export class OpeningBalanceService {
  /** Idempotent: adds the dedicated equity account (never reuses revenue/cost accounts). */
  public static ensureOpeningEquityAccount(): void {
    if (erpDb.getSnapshot().accounts.some(a => a.id === OPENING_EQUITY_ACCOUNT_ID)) return;
    erpDb.mutate(draft => {
      if (draft.accounts.some(a => a.id === OPENING_EQUITY_ACCOUNT_ID)) return;
      draft.accounts.push({
        id: OPENING_EQUITY_ACCOUNT_ID, code: '3103', nameAr: 'أرصدة أول المدة (حساب تسوية افتتاحي)',
        nameEn: 'Opening Balance Equity', category: 'Equity', isHeader: false, parentId: 'acc-3', level: 2, currentBalance: 0,
      } as never);
    });
  }

  private static inventoryAccountFor(warehouseType: string): string {
    switch (warehouseType) {
      case 'raw_materials': return AccountingEngine.getMappedAccountId('purchase_raw_inventory', 'acc-1108');
      case 'damaged': return AccountingEngine.getMappedAccountId('inventory_damaged', 'acc-1111');
      case 'scrap': return AccountingEngine.getMappedAccountId('inventory_scrap', 'acc-1112');
      case 'export_finished': return AccountingEngine.getMappedAccountId('inventory_finished_export', 'acc-1110');
      default: return AccountingEngine.getMappedAccountId('inventory_finished_local', 'acc-1109');
    }
  }

  /** Opening stock for ONE warehouse: batch layers at cost + one balanced journal against 3103. */
  public static postInventoryOpening(params: {
    warehouseId: string;
    date: string;
    lines: Array<{ itemId: string; quantity: number; unitCost: number; batchNumber?: string; productionDate?: string; expiryDate?: string }>;
  } & Actor): { success: boolean; error?: string; totalValue?: number; reference?: string } {
    const guard = AuthorizationService.enforce('accounting', 'post', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };
    const db = erpDb.getSnapshot();
    const wh = db.warehouses.find(w => w.id === params.warehouseId);
    if (!wh) return { success: false, error: 'المستودع غير موجود' };
    if (!params.date) return { success: false, error: 'تاريخ الرصيد الافتتاحي مطلوب' };
    const rows = (params.lines || []).filter(l => Number(l.quantity) !== 0 || l.itemId);
    if (rows.length === 0) return { success: false, error: 'لا توجد أصناف في الرصيد الافتتاحي' };

    const seen = new Set<string>();
    let total = 0;
    for (const l of rows) {
      const item = db.items.find(i => i.id === l.itemId);
      if (!item) return { success: false, error: `صنف غير معرّف (${l.itemId})` };
      if (!(Number(l.quantity) > 0)) return { success: false, error: `الكمية يجب أن تكون أكبر من صفر (${item.nameAr})` };
      if (!(Number(l.unitCost) > 0)) return { success: false, error: `تكلفة الوحدة مطلوبة للصنف (${item.nameAr}) — الرصيد الافتتاحي يُقيَّم بالتكلفة` };
      if (seen.has(l.itemId)) return { success: false, error: `الصنف (${item.nameAr}) مكرر في نفس الإدخال` };
      seen.add(l.itemId);
      const already = db.inventoryTransactions.some(t =>
        t.itemId === l.itemId && t.warehouseId === params.warehouseId && t.documentType === OPENING_DOC_LABEL);
      if (already) return { success: false, error: `الصنف (${item.nameAr}) له رصيد افتتاحي مسجّل بالفعل في ${wh.nameAr} — لا يُكرَّر. صحّح الفرق بتسوية جرد.` };
      total += Number(l.quantity) * Number(l.unitCost);
    }
    total = r2(total);
    if (!(total > 0)) return { success: false, error: 'قيمة الرصيد الافتتاحي صفر' };

    this.ensureOpeningEquityAccount();
    const invAcc = this.inventoryAccountFor(wh.type);
    const reference = `OPB-INV-${params.date.replace(/-/g, '')}-${db.journalEntries.length + 1}`;

    const jv = AccountingEngine.postJournal({
      date: params.date, reference,
      description: `رصيد أول المدة — مخزون ${wh.nameAr}`,
      sourceDocumentType: 'opening_balance_inventory', sourceDocumentId: `${params.warehouseId}:${params.date}`,
      lines: [
        line(invAcc, total, 0, total, 1, 'EGP', `رصيد أول المدة — مخزون ${wh.nameAr}`),
        line(OPENING_EQUITY_ACCOUNT_ID, 0, total, total, 1, 'EGP', `مقابل رصيد أول المدة — مخزون ${wh.nameAr}`),
      ],
    } as never, params.userId, params.userName, params.isTest);
    if (!jv.success) return { success: false, error: jv.error };

    for (const l of rows) {
      const mv = InventoryEngine.recordMovement({
        itemId: l.itemId, warehouseId: params.warehouseId, movementType: 'purchase_receipt', date: params.date,
        quantityIn: Number(l.quantity), quantityOut: 0, unitCost: Number(l.unitCost),
        documentType: OPENING_DOC_LABEL, documentNumber: reference,
        batchNumber: l.batchNumber || `OPEN-${params.date.replace(/-/g, '')}-${l.itemId.slice(-6)}`,
        productionDate: l.productionDate, expiryDate: l.expiryDate,
        notes: 'رصيد افتتاحي — ليس مشتريات ولا جرد', isTest: params.isTest,
      });
      if (!mv.success) return { success: false, error: `تعذّر تسجيل حركة الرصيد الافتتاحي: ${mv.error}` };
    }
    erpDb.mutate(draft => {
      draft.auditLogs.push({
        id: generateErpId('aud'), timestamp: new Date().toISOString(),
        userId: guard.userId, userName: guard.userName, module: 'المحاسبة', action: 'post', recordId: reference,
        description: `رصيد أول المدة لمخزون ${wh.nameAr} بقيمة ${total.toLocaleString('ar-EG')} ج.م (${rows.length} صنف)`,
      } as never);
    });
    return { success: true, totalValue: total, reference };
  }

  /** Opening balance of a customer (customer currency; USD customers need the rate). Re-posting posts only the DIFFERENCE. */
  public static postCustomerOpening(params: { customerId: string; amount: number; date: string; exchangeRate?: number } & Actor): { success: boolean; error?: string } {
    const guard = AuthorizationService.enforce('accounting', 'post', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };
    const db = erpDb.getSnapshot();
    const c = db.customers.find(x => x.id === params.customerId);
    if (!c) return { success: false, error: 'العميل غير موجود' };
    const amount = Number(params.amount);
    if (!Number.isFinite(amount)) return { success: false, error: 'المبلغ غير صالح' };
    const usd = currencyForCustomerType(c.customerType) === 'USD';
    const rate = usd ? Number(params.exchangeRate) : 1;
    if (usd && !(rate > 0)) return { success: false, error: 'عميل التصدير يتطلب سعر صرف الرصيد الافتتاحي (جنيه للدولار)' };
    const delta = r2(amount - (Number(c.openingBalance) || 0));
    if (delta === 0) return { success: true };

    this.ensureOpeningEquityAccount();
    const recv = usd
      ? AccountingEngine.getMappedAccountId('customer_receivable_export', 'acc-1106')
      : AccountingEngine.getMappedAccountId('customer_receivable_local', 'acc-1105');
    const egp = r2(Math.abs(delta) * rate);
    const ccy: 'EGP' | 'USD' = usd ? 'USD' : 'EGP';
    const desc = `رصيد أول المدة — العميل ${c.name}`;
    const dr = delta > 0;
    const jv = AccountingEngine.postJournal({
      date: params.date, reference: `OPB-CUS-${c.code}`, description: desc,
      sourceDocumentType: 'opening_balance_customer', sourceDocumentId: c.id,
      lines: [
        dr ? line(recv, egp, 0, Math.abs(delta), rate, ccy, desc) : line(recv, 0, egp, Math.abs(delta), rate, ccy, desc),
        dr ? line(OPENING_EQUITY_ACCOUNT_ID, 0, egp, egp, 1, 'EGP', `مقابل ${desc}`) : line(OPENING_EQUITY_ACCOUNT_ID, egp, 0, egp, 1, 'EGP', `مقابل ${desc}`),
      ],
    } as never, params.userId, params.userName, params.isTest);
    if (!jv.success) return { success: false, error: jv.error };
    erpDb.mutate(draft => {
      const cc = draft.customers.find(x => x.id === c.id);
      if (!cc) return;
      cc.currentBalance = r2((cc.currentBalance || 0) + delta);
      cc.openingBalance = amount;
    });
    return { success: true };
  }

  /** Opening balance of a supplier (what we owe). Re-posting posts only the DIFFERENCE. */
  public static postSupplierOpening(params: { supplierId: string; amount: number; date: string; exchangeRate?: number } & Actor): { success: boolean; error?: string } {
    const guard = AuthorizationService.enforce('accounting', 'post', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };
    const db = erpDb.getSnapshot();
    const s = db.suppliers.find(x => x.id === params.supplierId);
    if (!s) return { success: false, error: 'المورد غير موجود' };
    const amount = Number(params.amount);
    if (!Number.isFinite(amount)) return { success: false, error: 'المبلغ غير صالح' };
    const usd = s.currency === 'USD';
    const rate = usd ? Number(params.exchangeRate) : 1;
    if (usd && !(rate > 0)) return { success: false, error: 'مورد بالدولار يتطلب سعر صرف الرصيد الافتتاحي (جنيه للدولار)' };
    const delta = r2(amount - (Number(s.openingBalance) || 0));
    if (delta === 0) return { success: true };

    this.ensureOpeningEquityAccount();
    const pay = AccountingEngine.getMappedAccountId('supplier_payable', 'acc-2101');
    const egp = r2(Math.abs(delta) * rate);
    const ccy: 'EGP' | 'USD' = usd ? 'USD' : 'EGP';
    const desc = `رصيد أول المدة — المورد ${s.name}`;
    const cr = delta > 0; // we owe more
    const jv = AccountingEngine.postJournal({
      date: params.date, reference: `OPB-SUP-${s.code}`, description: desc,
      sourceDocumentType: 'opening_balance_supplier', sourceDocumentId: s.id,
      lines: [
        cr ? line(OPENING_EQUITY_ACCOUNT_ID, egp, 0, egp, 1, 'EGP', `مقابل ${desc}`) : line(OPENING_EQUITY_ACCOUNT_ID, 0, egp, egp, 1, 'EGP', `مقابل ${desc}`),
        cr ? line(pay, 0, egp, Math.abs(delta), rate, ccy, desc) : line(pay, egp, 0, Math.abs(delta), rate, ccy, desc),
      ],
    } as never, params.userId, params.userName, params.isTest);
    if (!jv.success) return { success: false, error: jv.error };
    erpDb.mutate(draft => {
      const ss = draft.suppliers.find(x => x.id === s.id);
      if (!ss) return;
      ss.currentBalance = r2((ss.currentBalance || 0) + delta);
      ss.openingBalance = amount;
    });
    return { success: true };
  }

  /**
   * Opening balances of cash / bank / cheques / tax accounts: each line is a debit or credit
   * balance of ONE existing account; the net is balanced against 3103. A bank line may name the
   * bank account so its register balance moves together with the GL.
   */
  public static postGeneralOpening(params: {
    date: string;
    lines: Array<{ accountId: string; side: 'debit' | 'credit'; amount: number; description: string; bankAccountId?: string }>;
  } & Actor): { success: boolean; error?: string; reference?: string } {
    const guard = AuthorizationService.enforce('accounting', 'post', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };
    const db = erpDb.getSnapshot();
    if (!params.date) return { success: false, error: 'تاريخ الرصيد الافتتاحي مطلوب' };
    const rows = (params.lines || []).filter(l => Number(l.amount) !== 0);
    if (rows.length === 0) return { success: false, error: 'لا توجد أرصدة' };
    const jl: JournalLine[] = [];
    let net = 0; // debit - credit of the real lines
    for (const l of rows) {
      const acc = db.accounts.find(a => a.id === l.accountId);
      if (!acc || acc.isHeader) return { success: false, error: `حساب غير صالح (${l.accountId})` };
      const amt = r2(Math.abs(Number(l.amount)));
      if (!(amt > 0)) return { success: false, error: `مبلغ غير صالح (${acc.nameAr})` };
      jl.push(l.side === 'debit' ? line(l.accountId, amt, 0, amt, 1, 'EGP', l.description) : line(l.accountId, 0, amt, amt, 1, 'EGP', l.description));
      net += l.side === 'debit' ? amt : -amt;
    }
    net = r2(net);
    this.ensureOpeningEquityAccount();
    if (net !== 0) {
      jl.push(net > 0
        ? line(OPENING_EQUITY_ACCOUNT_ID, 0, net, net, 1, 'EGP', 'مقابل أرصدة أول المدة')
        : line(OPENING_EQUITY_ACCOUNT_ID, -net, 0, -net, 1, 'EGP', 'مقابل أرصدة أول المدة'));
    }
    const reference = `OPB-GEN-${params.date.replace(/-/g, '')}-${db.journalEntries.length + 1}`;
    const jv = AccountingEngine.postJournal({
      date: params.date, reference, description: 'أرصدة أول المدة — خزينة وبنك وشيكات وضرائب',
      sourceDocumentType: 'opening_balance_general', sourceDocumentId: reference, lines: jl,
    } as never, params.userId, params.userName, params.isTest);
    if (!jv.success) return { success: false, error: jv.error };
    erpDb.mutate(draft => {
      for (const l of rows) {
        if (!l.bankAccountId) continue;
        const b = draft.bankAccounts.find(x => x.id === l.bankAccountId);
        if (b) b.currentBalance = r2((b.currentBalance || 0) + (l.side === 'debit' ? 1 : -1) * Math.abs(Number(l.amount)));
      }
      draft.auditLogs.push({
        id: generateErpId('aud'), timestamp: new Date().toISOString(), userId: guard.userId, userName: guard.userName,
        module: 'المحاسبة', action: 'post', recordId: reference, description: `أرصدة أول المدة (${rows.length} حساب)`,
      } as never);
    });
    return { success: true, reference };
  }

  /**
   * Imports an opening-balance PACKAGE (the file built by scripts/build_opening_database.ts) into the
   * live database WITHOUT replacing it: users, settings, items and everything else stay as they are.
   * Only allowed on a database that has no postings, customers or stock yet, so it can never
   * double-load or overwrite real work. Atomic: one mutate.
   */
  public static importPackage(pkg: any, actor: Actor): { success: boolean; error?: string; summary?: string } {
    const guard = AuthorizationService.enforce('accounting', 'post', { userId: actor.userId, userName: actor.userName, isTest: actor.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };
    const arr = (k: string): any[] => (Array.isArray(pkg?.[k]) ? pkg[k] : []);
    const journals = arr('journalEntries');
    if (journals.length === 0 || !journals.every(j => String(j.sourceDocumentType || '').startsWith('opening_balance'))) {
      return { success: false, error: 'الملف ليس ملف أرصدة افتتاحية صالحًا (يجب أن تكون كل قيوده من نوع رصيد أول المدة)' };
    }
    const net = Math.round(journals.reduce((t, j) => t + (Number(j.totalDebit) || 0) - (Number(j.totalCredit) || 0), 0) * 100) / 100;
    if (net !== 0) return { success: false, error: 'قيود الملف غير متوازنة — لن يتم الاستيراد' };
    const db = erpDb.getSnapshot();
    if (db.journalEntries.length > 0 || db.customers.length > 0 || db.batches.length > 0 || db.inventoryTransactions.length > 0) {
      return { success: false, error: 'لا يمكن استيراد الأرصدة الافتتاحية: النظام فيه قيود أو عملاء أو مخزون بالفعل. يُستخدم هذا الاستيراد على نظام فارغ فقط.' };
    }
    erpDb.mutate(draft => {
      journals.forEach(j => draft.journalEntries.push(j));
      arr('batches').forEach(b => draft.batches.push(b));
      arr('inventoryTransactions').forEach(t => draft.inventoryTransactions.push(t));
      arr('customers').forEach(c => draft.customers.push(c));
      for (const s of arr('suppliers')) {
        const t = draft.suppliers.find(x => x.id === s.id);
        if (t) { t.openingBalance = s.openingBalance; t.currentBalance = s.currentBalance; } else draft.suppliers.push(s);
      }
      for (const b of arr('bankAccounts')) {
        const t = draft.bankAccounts.find(x => x.id === b.id);
        if (t) t.currentBalance = b.currentBalance; else draft.bankAccounts.push(b);
      }
      for (const a of arr('accounts')) {
        const t = draft.accounts.find(x => x.id === a.id);
        if (t) t.currentBalance = a.currentBalance; else draft.accounts.push(a);
      }
      arr('auditLogs').forEach(l => draft.auditLogs.push(l));
      draft.auditLogs.push({
        id: generateErpId('aud'), timestamp: new Date().toISOString(), userId: guard.userId, userName: guard.userName,
        module: 'المحاسبة', action: 'post', recordId: 'opening-package',
        description: `استيراد ملف أرصدة أول المدة (${journals.length} قيد، ${arr('customers').length} عميل، ${arr('batches').length} تشغيلة مخزون)`,
      } as never);
    });
    return { success: true, summary: `${journals.length} قيد، ${arr('customers').length} عميل، ${arr('batches').length} تشغيلة مخزون` };
  }
}
