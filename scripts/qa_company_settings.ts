// Isolated QA for the "إعدادات الشركة والتخصيص" screen.
//
// Runs in a separate Node process with an IN-MEMORY localStorage shim, so it
// exercises the real persistence path (erpDb → localStorage JSON) without ever
// touching the browser profile that holds the company's real data.
//
// It verifies: company save/reload, validation, audit (previous/new + actor),
// warehouse code uniqueness / disable / delete protection / history intact,
// storekeeper linking + disable (no deletion) + login block, Super-Admin-only
// permissions, invoice template save + rendered header/footer/net-due.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type Status = 'PASS' | 'FAIL' | 'WARN';
const rows: Array<{ id: string; label: string; expected: string; actual: string; status: Status; note?: string }> = [];

function check(id: string, label: string, expected: string | number | boolean, actual: string | number | boolean, note?: string) {
  const pass = typeof expected === 'number' && typeof actual === 'number'
    ? Math.abs(expected - actual) <= 0.01
    : String(expected) === String(actual);
  rows.push({
    id, label,
    expected: String(expected), actual: String(actual),
    status: pass ? 'PASS' : 'FAIL', note,
  });
  return pass;
}

function printTable() {
  console.log('\n\n==============================================================================================');
  console.log('📋 COMPANY SETTINGS — PASS / FAIL');
  console.log('==============================================================================================');
  console.log('| # | Status | Check | Expected | Actual | Note |');
  console.log('|---|--------|-------|----------|--------|------|');
  for (const r of rows) {
    const esc = (s: string) => String(s).replace(/\|/g, '/').slice(0, 180);
    console.log(`| ${r.id} | ${r.status} | ${esc(r.label)} | ${esc(r.expected)} | ${esc(r.actual)} | ${esc(r.note || '')} |`);
  }
  const pass = rows.filter(r => r.status === 'PASS').length;
  const fail = rows.filter(r => r.status === 'FAIL').length;
  const warn = rows.filter(r => r.status === 'WARN').length;
  console.log('==============================================================================================');
  console.log(`TOTAL: ${rows.length} — PASS ${pass} / FAIL ${fail} / WARN ${warn}`);
  console.log('==============================================================================================');
}

// ---- In-memory localStorage shim (installed BEFORE the db module loads) --------
const store = new Map<string, string>();
const shim = {
  __qaShim: true,
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size; },
};
(globalThis as unknown as { localStorage: typeof shim }).localStorage = shim;

const STORAGE_KEY = 'abdullah_erp_db_v1';
const readStored = () => JSON.parse(store.get(STORAGE_KEY) || '{}');
const storedCompany = () => readStored().company || {};
const storedTemplate = () => (readStored().settings || {}).invoiceTemplate || {};
const auditOf = (module: string, recordId?: string) => (readStored().auditLogs || [])
  .filter((a: { module: string; recordId: string }) => a.module === module && (!recordId || a.recordId === recordId));

async function main() {
  const { erpDb, INITIAL_COMPANY } = await import('../src/services/db');
  const { CompanySettingsService, computeInvoiceNetDue } = await import('../src/services/companySettings');
  const { MasterDataService } = await import('../src/services/masterData');
  const { WorkflowService } = await import('../src/services/workflows');
  const { AuthService } = await import('../src/services/auth');
  const { InvoiceHeader, InvoiceFooter, NetDueHighlight, InvoiceDocStyle } = await import('../src/components/invoiceTemplate');

  // Mirror the real UI: the screen is used from an authenticated Super Admin session.
  const adminLogin = AuthService.login('admin', '12345');

  console.log('=================================================');
  console.log('🔬 QA: Company Settings & Customization');
  console.log('=================================================');
  check('S0-0', 'Super Admin session established', true, adminLogin.success);
  check('S0-1', 'Isolated in-memory store (no real browser profile)', true, (globalThis as unknown as { localStorage?: { __qaShim?: boolean } }).localStorage?.__qaShim === true);
  check('S0-2', 'Database starts from the shipped master data (nothing replaced)', INITIAL_COMPANY.nameAr, erpDb.getSnapshot().company.nameAr);
  check('S0-3', 'Five existing warehouses preserved', 5, erpDb.getSnapshot().warehouses.length);

  // ============================ Company ============================
  const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wFZkLmRAAAAAElFTkSuQmCC';
  const saveCompany = CompanySettingsService.updateCompany({
    nameAr: 'شركة اختبار الإعدادات (ش.م.م)',
    nameEn: 'Settings QA Co.',
    taxNumber: '123-456-789',
    commercialRegister: '99887 - الجيزة',
    address: 'عنوان اختباري - الجيزة',
    phone: '+20 100 000 0000',
    email: 'qa@example.com',
    website: 'https://example.com',
    contactName: 'مسؤول الاختبار',
    contactPhone: '+20 111 111 1111',
    logoDataUrl: logo,
    currentUsdExchangeRate: 49.25,
  });
  check('S1-1', 'Save company profile', true, saveCompany.success, saveCompany.error);
  check('S1-2', 'Values saved in the live database', 'Settings QA Co.', erpDb.getSnapshot().company.nameEn);
  check('S1-3', 'Values persisted in the stored JSON (survives reload)', 'شركة اختبار الإعدادات (ش.م.م)', storedCompany().nameAr);
  check('S1-4', 'Logo persisted', true, String(storedCompany().logoDataUrl || '').startsWith('data:image/png;base64,'));
  check('S1-5', 'Exchange rate persisted', 49.25, Number(storedCompany().currentUsdExchangeRate));
  const companyAudit = auditOf('إعدادات الشركة والتخصيص', 'company').slice(-1)[0];
  check('S1-6', 'Audit entry written', true, Boolean(companyAudit));
  check('S1-7', 'Audit records the actor', 'usr-admin', companyAudit?.userId || '');
  check('S1-8', 'Audit records previous value', true, String(companyAudit?.previousValue || '').includes(INITIAL_COMPANY.nameAr));
  check('S1-9', 'Audit records new value', true, String(companyAudit?.newValue || '').includes('Settings QA Co.'));

  const before = erpDb.getSnapshot().company.nameAr;
  check('S2-1', 'Reject empty Arabic name', false, CompanySettingsService.updateCompany({ nameAr: '   ' }).success);
  check('S2-2', 'Reject invalid email', false, CompanySettingsService.updateCompany({ email: 'not-an-email' }).success);
  check('S2-3', 'Reject invalid website', false, CompanySettingsService.updateCompany({ website: 'example.com' }).success);
  check('S2-4', 'Reject non-numeric tax number', false, CompanySettingsService.updateCompany({ taxNumber: 'ABC' }).success);
  check('S2-5', 'Reject negative exchange rate', false, CompanySettingsService.updateCompany({ currentUsdExchangeRate: -1 }).success);
  check('S2-6', 'Reject oversized logo (>300KB)', false, CompanySettingsService.updateCompany({ logoDataUrl: 'data:image/png;base64,' + 'A'.repeat(420_000) }).success);
  check('S2-7', 'Reject non-image logo', false, CompanySettingsService.updateCompany({ logoDataUrl: 'javascript:alert(1)' }).success);
  check('S2-8', 'Rejected input left the company untouched', before, erpDb.getSnapshot().company.nameAr);

  // ============================ Warehouses ============================
  const created = CompanySettingsService.createWarehouse({ code: 'wh-90', nameAr: 'مستودع اختبار جديد', type: 'raw_materials', location: 'عنبر تجريبي' });
  check('S3-1', 'Add warehouse (code normalised to upper case)', true, created.success, created.error);
  check('S3-2', 'New code stored uppercase', 'WH-90', created.warehouse?.code || '');
  check('S3-3', 'Duplicate code rejected (case-insensitive)', false, CompanySettingsService.createWarehouse({ code: 'WH-90', nameAr: 'مكرر', type: 'raw_materials' }).success);
  check('S3-4', 'Invalid code format rejected', false, CompanySettingsService.createWarehouse({ code: 'WH 90!', nameAr: 'غير صالح', type: 'raw_materials' }).success);
  check('S3-5', 'Unknown type rejected', false, CompanySettingsService.createWarehouse({ code: 'WH-91', nameAr: 'نوع خطأ', type: 'bogus' as never }).success);
  check('S3-6', 'Renaming existing warehouse works', true, CompanySettingsService.updateWarehouse('wh-local', { nameAr: 'مستودع المنتج التام المحلي (محدث)' }).success);
  check('S3-7', 'Duplicate code on rename rejected', false, CompanySettingsService.updateWarehouse('wh-local', { code: 'WH-01' }).success);

  // Use a real posting so the warehouse carries history.
  const supplier = MasterDataService.createSupplier({ code: 'QA-WH-SUP', name: 'مورد اختبار المستودعات' }).supplier!;
  const item = erpDb.getSnapshot().items.find(i => i.code === 'FP-SNG-01')!;
  const purchase = WorkflowService.createPurchaseInvoice({
    supplierId: supplier.id, warehouseId: 'wh-local', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: 'QA-WH-STOCK', date: new Date().toISOString().split('T')[0],
    lines: [{ itemId: item.id, quantity: 100, unitId: 'unit-piece', unitPrice: 40, batchNumber: 'QA-WH-BATCH', productionDate: '2026-10-01', expiryDate: '2027-10-01', vatRate: 0 }],
    userId: 'usr-admin', userName: 'QA',
  } as never);
  check('S3-8', 'Historical stock posting created for wh-local', true, purchase.success, purchase.error);
  const invoiceWarehouseId = erpDb.getSnapshot().purchaseInvoices.find(p => p.reference === 'QA-WH-STOCK')?.warehouseId;
  check('S3-9', 'Rename does not rewrite the historical document', 'wh-local', invoiceWarehouseId || '');
  const usage = CompanySettingsService.getWarehouseUsage('wh-local');
  check('S3-10', 'Usage counter sees stock/history', true, usage.total > 0 && usage.stockQuantity === 100, `batches=${usage.batches} qty=${usage.stockQuantity} movements=${usage.inventoryTransactions}`);
  const blockedDelete = CompanySettingsService.deleteWarehouse('wh-local');
  check('S3-11', 'Delete blocked when the warehouse has history', false, blockedDelete.success);
  check('S3-12', 'Blocked delete explains why', true, String(blockedDelete.error || '').includes('التعطيل'));
  check('S3-13', 'Warehouse still present after blocked delete', true, erpDb.getSnapshot().warehouses.some(w => w.id === 'wh-local'));
  check('S3-14', 'Stock untouched by the blocked delete', 100, erpDb.getSnapshot().batches.filter(b => b.warehouseId === 'wh-local').reduce((s, b) => s + b.quantity, 0));

  check('S3-15', 'Disable warehouse with stock', true, CompanySettingsService.setWarehouseActive('wh-local', false, { reason: 'إيقاف اختباري' }).success);
  check('S3-16', 'Warehouse disabled but not deleted', false, Boolean(erpDb.getSnapshot().warehouses.find(w => w.id === 'wh-local')?.active));
  check('S3-17', 'Historical stock still intact after disable', 100, erpDb.getSnapshot().batches.filter(b => b.warehouseId === 'wh-local').reduce((s, b) => s + b.quantity, 0));
  check('S3-18', 'Re-activate warehouse', true, CompanySettingsService.setWarehouseActive('wh-local', true).success);
  check('S3-19', 'Deleting an unused warehouse is allowed', true, CompanySettingsService.deleteWarehouse(created.warehouse!.id).success);
  check('S3-20', 'Unused warehouse removed', false, erpDb.getSnapshot().warehouses.some(w => w.code === 'WH-90'));
  const whAudit = auditOf('إعدادات الشركة والتخصيص').slice(-1)[0];
  check('S3-21', 'Warehouse audit carries previous + new values', true, Boolean(whAudit?.previousValue || whAudit?.newValue));

  // ============================ Storekeepers ============================
  const keeper = CompanySettingsService.createStorekeeper({
    name: 'أمين مخزن اختبار', username: 'keeper1', password: 'secret123',
    email: 'keeper@example.com', phone: '+20 122 222 2222',
    role: 'Warehouse Employee', warehouseIds: ['wh-local'],
    permissions: { inventory: ['view', 'create'], reports: ['view'] },
  });
  check('S4-1', 'Create storekeeper', true, keeper.success, keeper.error);
  const keeperId = keeper.user?.id || '';
  check('S4-2', 'Warehouse linkage stored on the user', 'wh-local', (erpDb.getSnapshot().users.find(u => u.id === keeperId)?.warehouseIds || []).join(','));
  check('S4-3', 'Warehouse manager link updated', keeperId, erpDb.getSnapshot().warehouses.find(w => w.id === 'wh-local')?.managerUserId || '');
  check('S4-4', 'Permissions stored', 2, Object.keys(erpDb.getSnapshot().users.find(u => u.id === keeperId)?.permissions || {}).length);
  check('S4-5', 'Duplicate username rejected', false, CompanySettingsService.createStorekeeper({ name: 'مكرر', username: 'keeper1', password: 'secret123', role: 'Warehouse Employee', warehouseIds: ['wh-local'] }).success);
  check('S4-6', 'Non-warehouse role rejected', false, CompanySettingsService.createStorekeeper({ name: 'محاسب', username: 'acc1', password: 'secret123', role: 'Accountant', warehouseIds: ['wh-local'] }).success);
  check('S4-7', 'Unknown warehouse rejected', false, CompanySettingsService.createStorekeeper({ name: 'خطأ', username: 'keeper2', password: 'secret123', role: 'Warehouse Employee', warehouseIds: ['wh-nope'] }).success);
  check('S4-8', 'Short password rejected', false, CompanySettingsService.createStorekeeper({ name: 'قصير', username: 'keeper3', password: '123', role: 'Warehouse Employee', warehouseIds: ['wh-local'] }).success);
  check('S4-9', 'Forbidden module (accounting) rejected', false, CompanySettingsService.createStorekeeper({ name: 'صلاحيات', username: 'keeper4', password: 'secret123', role: 'Warehouse Employee', warehouseIds: ['wh-local'], permissions: { accounting: ['view'] } }).success);
  check('S4-10', 'Update storekeeper + relink warehouse', true, CompanySettingsService.updateStorekeeper(keeperId, { warehouseIds: ['wh-raw'], permissions: { inventory: ['view', 'create', 'edit'] } }).success);
  check('S4-11', 'Old warehouse unlinked', '', erpDb.getSnapshot().warehouses.find(w => w.id === 'wh-local')?.managerUserId || '');
  check('S4-12', 'New warehouse linked', keeperId, erpDb.getSnapshot().warehouses.find(w => w.id === 'wh-raw')?.managerUserId || '');
  check('S4-13', 'No password leaked into audit values', false, JSON.stringify(auditOf('إعدادات الشركة والتخصيص', keeperId)).includes('secret123'));

  check('S4-14', 'Disable storekeeper', true, CompanySettingsService.setStorekeeperActive(keeperId, false, { reason: 'إيقاف اختباري' }).success);
  const disabled = erpDb.getSnapshot().users.find(u => u.id === keeperId);
  check('S4-15', 'User record still exists (not deleted)', true, Boolean(disabled));
  check('S4-16', 'User marked inactive', false, Boolean(disabled?.active));
  check('S4-17', 'Warehouse linkage kept after disable', 'wh-raw', (disabled?.warehouseIds || []).join(','));
  const loginDisabled = AuthService.login('keeper1', 'secret123');
  check('S4-18', 'Disabled storekeeper cannot log in', false, loginDisabled.success);
  check('S4-19', 'Login rejection message', true, String(loginDisabled.messageAr || '').includes('معطل'));
  check('S4-20', 'Audit still contains the user history', true, auditOf('إعدادات الشركة والتخصيص', keeperId).length >= 2);

  // ============================ Permissions ============================
  CompanySettingsService.setStorekeeperActive(keeperId, true);
  const keeperLogin = AuthService.login('keeper1', 'secret123');
  check('S5-1', 'Re-activated storekeeper can log in', true, keeperLogin.success);
  const deniedCompany = CompanySettingsService.updateCompany({ nameAr: 'محاولة غير مصرح بها' });
  check('S5-2', 'Storekeeper cannot change company settings', false, deniedCompany.success);
  check('S5-3', 'Denial comes from the permission layer', true, String(deniedCompany.error || '').includes('صلاحية'), deniedCompany.error);
  check('S5-4', 'Storekeeper cannot add warehouses', false, CompanySettingsService.createWarehouse({ code: 'WH-99', nameAr: 'ممنوع', type: 'raw_materials' }).success);
  check('S5-5', 'Storekeeper cannot edit the invoice template', false, CompanySettingsService.updateInvoiceTemplate({ footerText: 'ممنوع' }).success);
  check('S5-6', 'Company name unchanged after denied attempt', 'شركة اختبار الإعدادات (ش.م.م)', erpDb.getSnapshot().company.nameAr);
  AuthService.logout();
  check('S5-7', 'Super Admin session restored', true, AuthService.login('admin', '12345').success);

  // ============================ Invoice design ============================
  const defaults = CompanySettingsService.getInvoiceTemplate();
  check('S6-1', 'Template defaults resolve on a fresh store', 'center', defaults.alignment);
  check('S6-2', 'Net-due highlight enabled by default', true, defaults.showNetDue);
  check('S6-3', 'Net due = total − withholding', 11300, computeInvoiceNetDue(11400, 100));
  const savedTemplate = CompanySettingsService.updateInvoiceTemplate({
    headerTextAr: 'فاتورة ضريبية — يرجى مراجعة الأصناف',
    headerTextEn: 'Tax invoice — please review the items',
    footerText: 'تذييل مخصص للاختبار',
    showLogo: true, showNetDue: true, showWithholding: true,
    accentColor: '#123456', textColor: '#222222',
    titleFontSize: 24, bodyFontSize: 13, tableFontSize: 11,
    alignment: 'right',
  });
  check('S6-4', 'Save invoice design', true, savedTemplate.success, savedTemplate.error);
  check('S6-5', 'Design persisted in the stored JSON', '#123456', storedTemplate().accentColor);
  check('S6-6', 'Footer persisted', 'تذييل مخصص للاختبار', storedTemplate().footerText);
  const tplAudit = auditOf('إعدادات الشركة والتخصيص', 'settings.invoiceTemplate').slice(-1)[0];
  check('S6-7', 'Design change audited with before/after', true, Boolean(tplAudit?.previousValue && tplAudit?.newValue));
  check('S6-8', 'Reject invalid colour', false, CompanySettingsService.updateInvoiceTemplate({ accentColor: 'red' }).success);
  check('S6-9', 'Reject out-of-range font size', false, CompanySettingsService.updateInvoiceTemplate({ titleFontSize: 99 }).success);
  check('S6-10', 'Reject empty net-due label', false, CompanySettingsService.updateInvoiceTemplate({ netDueLabel: '   ' }).success);

  const company = erpDb.getSnapshot().company;
  const template = CompanySettingsService.getInvoiceTemplate();
  const markup = renderToStaticMarkup(createElement('div', { dir: 'rtl', style: InvoiceDocStyle(template) }, [
    createElement(InvoiceHeader, { key: 'h', company, template }),
    createElement(NetDueHighlight, { key: 'n', template, totalAmount: 11400, withholdingAmount: 100, currency: 'EGP', format: (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }),
    createElement(InvoiceFooter, { key: 'f', company, template }),
  ]));
  check('S6-11', 'Rendered document shows the company name', true, markup.includes(company.nameAr));
  check('S6-12', 'Rendered document shows the custom footer', true, markup.includes('تذييل مخصص للاختبار'));
  check('S6-13', 'Rendered document highlights the net due (11,300)', true, markup.includes('11,300.00'));
  check('S6-14', 'Rendered document applies the saved accent colour', true, markup.includes('#123456'));
  check('S6-15', 'Printed document contains no system name', false, /SnakDip|snakdip/i.test(markup));
  const printSource = readFileSync('src/components/modules/InvoicePrint.tsx', 'utf8') + readFileSync('src/components/invoiceTemplate.tsx', 'utf8');
  check('S6-16', 'Print template source has no system branding / app link', false, /SnakDip|snakdip|abdullah-erp\.com/i.test(printSource));

  // ============================ Reload & history integrity ============================
  const reloaded = readStored();
  check('S7-1', 'Stored JSON keeps the saved company identity', 'Settings QA Co.', reloaded.company?.nameEn);
  check('S7-2', 'Stored JSON keeps the warehouse rename', 'مستودع المنتج التام المحلي (محدث)', reloaded.warehouses.find((w: { id: string }) => w.id === 'wh-local')?.nameAr);
  check('S7-3', 'Stored JSON keeps the storekeeper (disabled→enabled) record', true, reloaded.users.some((u: { username: string }) => u.username === 'keeper1'));
  check('S7-4', 'Stored JSON keeps the invoice template', 'right', reloaded.settings?.invoiceTemplate?.alignment);
  check('S7-5', 'Historical purchase invoice still in the stored JSON', true, reloaded.purchaseInvoices.some((p: { reference: string }) => p.reference === 'QA-WH-STOCK'));
  check('S7-6', 'Historical batch still in the stored JSON', 100, reloaded.batches.filter((b: { warehouseId: string }) => b.warehouseId === 'wh-local').reduce((s: number, b: { quantity: number }) => s + b.quantity, 0));
  check('S7-7', 'Company settings did not alter invoice totals', true, reloaded.purchaseInvoices.find((p: { reference: string }) => p.reference === 'QA-WH-STOCK')?.totalAmount === 4000,
    '100 × 40 = 4,000 expected');
  check('S7-8', 'Every settings change is audited', true, (reloaded.auditLogs || []).filter((a: { module: string }) => a.module === 'إعدادات الشركة والتخصيص').length >= 8);

  printTable();
  console.log('\n⚠️  ملاحظات الحدود:');
  console.log('   - التخزين الفعلي للتطبيق هو localStorage (abdullah_erp_db_v1) — الحفظ يبقى بعد إعادة التحميل على نفس المتصفح،');
  console.log('     لكن لا توجد مزامنة سحابية أو مشتركة بين الأجهزة/المستخدمين.');
  console.log('   - اختبار الطباعة يتحقق من مكوّنات المستند (رأس/تذييل/صافي مستحق) عبر renderToStaticMarkup، وليس من حوار طباعة المتصفح.');
  console.log('   - لم يتم تعديل أي قيد محاسبي أو حركة مخزنية: الإعدادات عرضية فقط.');

  process.exit(rows.some(r => r.status === 'FAIL') ? 1 : 0);
}

main().catch(err => {
  console.error('❌ FATAL:', err);
  rows.push({ id: 'FATAL', label: 'Unhandled failure', expected: '-', actual: '-', status: 'FAIL', note: String((err as Error)?.message || err) });
  printTable();
  process.exit(1);
});
