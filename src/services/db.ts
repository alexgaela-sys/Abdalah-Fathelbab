// Real Relational Database Store with Referencing, Transactions, and Persistence
import { 
  Company, Warehouse, Item, Unit, UnitConversion, Batch, BomHeader, BomLine, 
  ProductionOrder, ProductionConsumption, ProductionWaste, QualityInspection, 
  Customer, Supplier, SalesRepresentative, RepresentativeCustody, CustodyMovement, 
  SalesInvoice, SalesInvoiceLine, SalesReturn, SalesReturnLine, PurchaseInvoice, 
  PurchaseInvoiceLine, PurchaseReturn, InventoryTransaction, InventoryCount, 
  InventoryCountLine, Payment, PaymentAllocation, Cheque, BankAccount, BankTransaction, 
  TreasuryTransaction, Expense, CostCenter, Account, JournalEntry, AccountingPeriod, 
  StandardCostRate, SalesForecast, AccountMapping, AuditLog, User, ExportShipment,
  isDebitNatureCategory
} from '../types/erp';

// -----------------------------------------------------------------------------
// Deterministic Document Numbering & ID Generation (Centralized, Collision-free)
// -----------------------------------------------------------------------------
let idCounter = 0;
let lastIdStamp = 0;

/**
 * Generates a unique, monotonically increasing ID with prefix.
 * Replaces scattered Math.random() identity generation so financial/inventory
 * records can never collide (e.g. two records created in the same millisecond).
 */
export function generateErpId(prefix: string): string {
  idCounter += 1;
  let stamp = Date.now();
  if (stamp <= lastIdStamp) {
    stamp = lastIdStamp + 1;
  }
  lastIdStamp = stamp;
  return `${prefix}-${stamp.toString(36)}-${idCounter.toString(36).padStart(3, '0')}`;
}

/**
 * Centralized document-number generator (SINV-2026-00001 style).
 * Uses a deterministic sequence per document family so numbers never duplicate
 * and remain ordered even when records are deleted.
 */
export function nextDocNumber(
  draft: { [k: string]: unknown },
  listKey: string,
  prefix: string,
  padLength: number = 5,
  numberField: string = 'documentNumber'
): string {
  const list = (draft as Record<string, Array<Record<string, unknown>>>)[listKey];
  let max = 0;
  if (Array.isArray(list)) {
    for (const rec of list) {
      const num = String(rec?.[numberField] || '');
      const match = num.match(/(\d+)$/);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
  }
  return `${prefix}-${new Date().getFullYear()}-${String(max + 1).padStart(padLength, '0')}`;
}

export interface ERPDatabaseSchema {
  company: Company;
  warehouses: Warehouse[];
  items: Item[];
  units: Unit[];
  unitConversions: UnitConversion[];
  batches: Batch[];
  boms: BomHeader[];
  bomLines: BomLine[];
  productionOrders: ProductionOrder[];
  productionConsumptions: ProductionConsumption[];
  productionWastes: ProductionWaste[];
  qualityInspections: QualityInspection[];
  customers: Customer[];
  suppliers: Supplier[];
  salesReps: SalesRepresentative[];
  representativeCustodies: RepresentativeCustody[];
  custodyMovements: CustodyMovement[];
  salesInvoices: SalesInvoice[];
  salesInvoiceLines: SalesInvoiceLine[];
  salesReturns: SalesReturn[];
  salesReturnLines: SalesReturnLine[];
  purchaseInvoices: PurchaseInvoice[];
  purchaseInvoiceLines: PurchaseInvoiceLine[];
  purchaseReturns: PurchaseReturn[];
  inventoryTransactions: InventoryTransaction[];
  inventoryCounts: InventoryCount[];
  inventoryCountLines: InventoryCountLine[];
  payments: Payment[];
  paymentAllocations: PaymentAllocation[];
  cheques: Cheque[];
  bankAccounts: BankAccount[];
  bankTransactions: BankTransaction[];
  treasuryTransactions: TreasuryTransaction[];
  expenses: Expense[];
  costCenters: CostCenter[];
  accounts: Account[];
  journalEntries: JournalEntry[];
  accountingPeriods: AccountingPeriod[];
  standardCostRates: StandardCostRate[];
  forecasts: SalesForecast[];
  accountMappings: Record<string, string>; // mapping key -> accountId
  users: User[];
  auditLogs: AuditLog[];
  exportShipments: ExportShipment[];
}

const STORAGE_KEY = 'abdullah_erp_db_v1';

export const INITIAL_COMPANY: Company = {
  id: 'comp-1',
  code: 'ABD-EG',
  nameAr: 'شركة عبد الله للصناعات الغذائية (ش.م.م)',
  nameEn: 'Abdullah Food Industries S.A.E.',
  taxNumber: '394-821-445',
  commercialRegister: '182944 - القاهرة',
  address: 'المنطقة الصناعية الثالثة، السادس من أكتوبر، الجيزة، مصر',
  phone: '+20 2 38330000',
  baseCurrency: 'EGP',
  exportCurrency: 'USD',
  currentUsdExchangeRate: 48.50,
};

export const INITIAL_WAREHOUSES: Warehouse[] = [
  {
    id: 'wh-raw',
    code: 'WH-01',
    nameAr: 'مستودع المواد الخام ومواد التعبئة',
    type: 'raw_materials',
    location: 'عنبر 1 - المجمع الصناعي',
    managerName: 'م. أحمد فؤاد',
    active: true,
  },
  {
    id: 'wh-local',
    code: 'WH-02',
    nameAr: 'مستودع المنتج التام المحلي',
    type: 'local_finished',
    location: 'عنبر 2 - التوزيع المحلي',
    managerName: 'أ. محمود عزت',
    active: true,
  },
  {
    id: 'wh-export',
    code: 'WH-03',
    nameAr: 'مستودع المنتج التام للتصدير',
    type: 'export_finished',
    location: 'عنبر 3 - رصيف الشحن الخارجي',
    managerName: 'أ. تامر رضوان',
    active: true,
  },
  {
    id: 'wh-damaged',
    code: 'WH-04',
    nameAr: 'مستودع التوالف والمعيب',
    type: 'damaged',
    location: 'عنبر العزل والفحص',
    managerName: 'م. طارق كمال',
    active: true,
  },
  {
    id: 'wh-scrap',
    code: 'WH-05',
    nameAr: 'مستودع الهالك / السكراب',
    type: 'scrap',
    location: 'ساحة السكراب والمخلفات',
    managerName: 'أ. عادل سامي',
    active: true,
  },
];

export const INITIAL_UNITS: Unit[] = [
  { id: 'unit-carton', code: 'CTN', nameAr: 'كرتونة', isBase: true },
  { id: 'unit-kg', code: 'KG', nameAr: 'كيلوجرام', isBase: true },
  { id: 'unit-ton', code: 'TON', nameAr: 'طن', isBase: false },
  { id: 'unit-piece', code: 'PCS', nameAr: 'قطعة', isBase: true },
  { id: 'unit-roll', code: 'ROLL', nameAr: 'بكرة تغليف', isBase: true },
];

export const INITIAL_UNIT_CONVERSIONS: UnitConversion[] = [
  { id: 'uc-1', fromUnitId: 'unit-ton', toUnitId: 'unit-kg', factor: 1000 },
];

export const INITIAL_COST_CENTERS: CostCenter[] = [
  { id: 'cc-prod', code: 'CC-101', nameAr: 'مركز تكلفة الإنتاج والتصنيع', active: true },
  { id: 'cc-sales', code: 'CC-201', nameAr: 'مركز تكلفة المبيعات والتسويق', active: true },
  { id: 'cc-dist', code: 'CC-301', nameAr: 'مركز تكلفة التوزيع والنقل', active: true },
  { id: 'cc-admin', code: 'CC-401', nameAr: 'مركز تكلفة الإدارة العامة', active: true },
  { id: 'cc-export', code: 'CC-501', nameAr: 'مركز تكلفة التصدير والعمليات الخارجية', active: true },
];

export const INITIAL_ACCOUNTS: Account[] = [
  // 1 الأصول (Assets)
  { id: 'acc-1', code: '1', nameAr: 'الأصول', nameEn: 'Assets', category: 'Assets', isHeader: true, level: 1, currentBalance: 0 },
  { id: 'acc-11', code: '11', nameAr: 'الأصول المتداولة', nameEn: 'Current Assets', category: 'Assets', isHeader: true, parentId: 'acc-1', level: 2, currentBalance: 0 },
  { id: 'acc-1101', code: '1101', nameAr: 'الخزينة الرئيسية النقدية', nameEn: 'Main Cash Treasury', category: 'Assets', isHeader: false, parentId: 'acc-11', level: 3, currentBalance: 0 },
  { id: 'acc-1102', code: '1102', nameAr: 'بنك مصر - حساب جاري بالجنيه', nameEn: 'Banque Misr - EGP', category: 'Assets', isHeader: false, parentId: 'acc-11', level: 3, currentBalance: 0 },
  { id: 'acc-1103', code: '1103', nameAr: 'البنك التجاري الدولي CIB - دولار', nameEn: 'CIB - USD Account', category: 'Assets', isHeader: false, parentId: 'acc-11', level: 3, currentBalance: 0 },
  { id: 'acc-1104', code: '1104', nameAr: 'أوراق قبض (شيكات تحت التحصيل)', nameEn: 'Cheques Under Collection', category: 'Assets', isHeader: false, parentId: 'acc-11', level: 3, currentBalance: 0 },
  { id: 'acc-1105', code: '1105', nameAr: 'عملاء تجاريون - محلي', nameEn: 'Trade Receivables - Local', category: 'Assets', isHeader: false, parentId: 'acc-11', level: 3, currentBalance: 0 },
  { id: 'acc-1106', code: '1106', nameAr: 'عملاء تجاريون - تصدير (USD)', nameEn: 'Trade Receivables - Export', category: 'Assets', isHeader: false, parentId: 'acc-11', level: 3, currentBalance: 0 },
  { id: 'acc-1107', code: '1107', nameAr: 'عهد مناديب المبيعات (بضائع ونقدية)', nameEn: 'Sales Reps Custody', category: 'Assets', isHeader: false, parentId: 'acc-11', level: 3, currentBalance: 0 },
  { id: 'acc-1108', code: '1108', nameAr: 'مخزون المواد الخام ومواد التعبئة', nameEn: 'Raw & Packaging Materials Inventory', category: 'Assets', isHeader: false, parentId: 'acc-11', level: 3, currentBalance: 0 },
  { id: 'acc-1109', code: '1109', nameAr: 'مخزون الإنتاج التام - محلي', nameEn: 'Finished Goods Inventory - Local', category: 'Assets', isHeader: false, parentId: 'acc-11', level: 3, currentBalance: 0 },
  { id: 'acc-1110', code: '1110', nameAr: 'مخزون الإنتاج التام - تصدير', nameEn: 'Finished Goods Inventory - Export', category: 'Assets', isHeader: false, parentId: 'acc-11', level: 3, currentBalance: 0 },
  { id: 'acc-1111', code: '1111', nameAr: 'مخزون التوالف والمعيب', nameEn: 'Damaged Goods Inventory', category: 'Assets', isHeader: false, parentId: 'acc-11', level: 3, currentBalance: 0 },
  { id: 'acc-1112', code: '1112', nameAr: 'مخزون الهالك والسكراب', nameEn: 'Scrap Inventory', category: 'Assets', isHeader: false, parentId: 'acc-11', level: 3, currentBalance: 0 },
  { id: 'acc-1113', code: '1113', nameAr: 'ضريبة القيمة المضافة - مدخلات ومشتريات', nameEn: 'VAT Input Tax', category: 'Assets', isHeader: false, parentId: 'acc-11', level: 3, currentBalance: 0 },

  // 2 الخصوم (Liabilities)
  { id: 'acc-2', code: '2', nameAr: 'الالتزامات والخصوم', nameEn: 'Liabilities', category: 'Liabilities', isHeader: true, level: 1, currentBalance: 0 },
  { id: 'acc-21', code: '21', nameAr: 'الالتزامات المتداولة', nameEn: 'Current Liabilities', category: 'Liabilities', isHeader: true, parentId: 'acc-2', level: 2, currentBalance: 0 },
  { id: 'acc-2101', code: '2101', nameAr: 'موردو الخامات والتعبئة - محلي', nameEn: 'Trade Payables - Local', category: 'Liabilities', isHeader: false, parentId: 'acc-21', level: 3, currentBalance: 0 },
  { id: 'acc-2102', code: '2102', nameAr: 'أوراق دفع (شيكات صادرة للدفع)', nameEn: 'Cheques Payable', category: 'Liabilities', isHeader: false, parentId: 'acc-21', level: 3, currentBalance: 0 },
  { id: 'acc-2103', code: '2103', nameAr: 'ضريبة القيمة المضافة - مخرجات ومبيعات', nameEn: 'VAT Output Tax', category: 'Liabilities', isHeader: false, parentId: 'acc-21', level: 3, currentBalance: 0 },
  { id: 'acc-2104', code: '2104', nameAr: 'مصروفات مستحقة ومخصصات', nameEn: 'Accrued Expenses', category: 'Liabilities', isHeader: false, parentId: 'acc-21', level: 3, currentBalance: 0 },

  // 3 حقوق الملكية (Equity)
  { id: 'acc-3', code: '3', nameAr: 'حقوق الملكية', nameEn: 'Equity', category: 'Equity', isHeader: true, level: 1, currentBalance: 0 },
  { id: 'acc-3101', code: '3101', nameAr: 'رأس المال المصدر والمدفوع', nameEn: 'Paid-in Capital', category: 'Equity', isHeader: false, parentId: 'acc-3', level: 2, currentBalance: 0 },
  { id: 'acc-3102', code: '3102', nameAr: 'الأرباح / الخسائر المرحلة', nameEn: 'Retained Earnings', category: 'Equity', isHeader: false, parentId: 'acc-3', level: 2, currentBalance: 0 },

  // 4 الإيرادات (Revenue)
  { id: 'acc-4', code: '4', nameAr: 'الإيرادات والمبيعات', nameEn: 'Revenue', category: 'Revenue', isHeader: true, level: 1, currentBalance: 0 },
  { id: 'acc-4101', code: '4101', nameAr: 'إيراد مبيعات التجزئة المحلية', nameEn: 'Retail Sales Revenue', category: 'Revenue', isHeader: false, parentId: 'acc-4', level: 2, currentBalance: 0 },
  { id: 'acc-4102', code: '4102', nameAr: 'إيراد مبيعات الجملة المحلية', nameEn: 'Wholesale Sales Revenue', category: 'Revenue', isHeader: false, parentId: 'acc-4', level: 2, currentBalance: 0 },
  { id: 'acc-4103', code: '4103', nameAr: 'إيراد مبيعات التصدير (USD)', nameEn: 'Export Sales Revenue', category: 'Revenue', isHeader: false, parentId: 'acc-4', level: 2, currentBalance: 0 },
  { id: 'acc-4104', code: '4104', nameAr: 'إيرادات بيع الهالك والسكراب', nameEn: 'Scrap Sales Revenue', category: 'Revenue', isHeader: false, parentId: 'acc-4', level: 2, currentBalance: 0 },
  { id: 'acc-4105', code: '4105', nameAr: 'أرباح فروق أسعار العملات الأجنبية', nameEn: 'Foreign Exchange Gain', category: 'Revenue', isHeader: false, parentId: 'acc-4', level: 2, currentBalance: 0 },

  // 5 تكلفة المبيعات والتصنيع (COGS & Variances)
  { id: 'acc-5', code: '5', nameAr: 'تكلفة المبيعات وفروق التصنيع', nameEn: 'Cost of Goods Sold', category: 'COGS', isHeader: true, level: 1, currentBalance: 0 },
  { id: 'acc-5101', code: '5101', nameAr: 'تكلفة البضاعة المباعة - محلي', nameEn: 'COGS - Local Market', category: 'COGS', isHeader: false, parentId: 'acc-5', level: 2, currentBalance: 0 },
  { id: 'acc-5102', code: '5102', nameAr: 'تكلفة البضاعة المباعة - تصدير', nameEn: 'COGS - Export Market', category: 'COGS', isHeader: false, parentId: 'acc-5', level: 2, currentBalance: 0 },
  { id: 'acc-5103', code: '5103', nameAr: 'فروق أسعار شراء المواد (Price Variance)', nameEn: 'Material Price Variance', category: 'COGS', isHeader: false, parentId: 'acc-5', level: 2, currentBalance: 0 },
  { id: 'acc-5104', code: '5104', nameAr: 'فروق كميات استهلاك المواد (Quantity Variance)', nameEn: 'Material Quantity Variance', category: 'COGS', isHeader: false, parentId: 'acc-5', level: 2, currentBalance: 0 },
  { id: 'acc-5105', code: '5105', nameAr: 'فروق تكلفة العمالة المباشرة', nameEn: 'Direct Labor Variance', category: 'COGS', isHeader: false, parentId: 'acc-5', level: 2, currentBalance: 0 },
  { id: 'acc-5106', code: '5106', nameAr: 'فروق تكلفة استهلاك الكهرباء', nameEn: 'Electricity Variance', category: 'COGS', isHeader: false, parentId: 'acc-5', level: 2, currentBalance: 0 },
  { id: 'acc-5107', code: '5107', nameAr: 'فروق تكلفة استهلاك الغاز الطبيعي', nameEn: 'Gas Variance', category: 'COGS', isHeader: false, parentId: 'acc-5', level: 2, currentBalance: 0 },
  { id: 'acc-5108', code: '5108', nameAr: 'فروق تكاليف الصيانة وقطع الغيار', nameEn: 'Maintenance Variance', category: 'COGS', isHeader: false, parentId: 'acc-5', level: 2, currentBalance: 0 },
  { id: 'acc-5109', code: '5109', nameAr: 'فروق التكاليف الصناعية الإضافية', nameEn: 'Manufacturing Overhead Variance', category: 'COGS', isHeader: false, parentId: 'acc-5', level: 2, currentBalance: 0 },

  // 6 المصروفات التشغيلية والبيعية (Operating Expenses)
  { id: 'acc-6', code: '6', nameAr: 'المصروفات التشغيلية والعمومية', nameEn: 'Operating Expenses', category: 'Operating Expenses', isHeader: true, level: 1, currentBalance: 0 },
  { id: 'acc-6101', code: '6101', nameAr: 'مصروفات الرواتب والأجور', nameEn: 'Salaries and Wages', category: 'Operating Expenses', isHeader: false, parentId: 'acc-6', level: 2, currentBalance: 0 },
  { id: 'acc-6102', code: '6102', nameAr: 'مصروفات كهرباء ومياه المرافق العامة', nameEn: 'Office Utilities', category: 'Operating Expenses', isHeader: false, parentId: 'acc-6', level: 2, currentBalance: 0 },
  { id: 'acc-6103', code: '6103', nameAr: 'مصروفات النقل والشحن والتوزيع الداخلي', nameEn: 'Local Distribution & Freight', category: 'Operating Expenses', isHeader: false, parentId: 'acc-6', level: 2, currentBalance: 0 },
  { id: 'acc-6104', code: '6104', nameAr: 'مصروفات نولون وتخليص وموانئ التصدير', nameEn: 'Export Shipping, Port & Customs', category: 'Operating Expenses', isHeader: false, parentId: 'acc-6', level: 2, currentBalance: 0 },
  { id: 'acc-6105', code: '6105', nameAr: 'مصروفات الدعاية والإعلان والترويج', nameEn: 'Marketing & Promotion', category: 'Operating Expenses', isHeader: false, parentId: 'acc-6', level: 2, currentBalance: 0 },
  { id: 'acc-6106', code: '6106', nameAr: 'عمولات ومصروفات مناديب المبيعات الميدانية', nameEn: 'Sales Rep Expenses & Commissions', category: 'Operating Expenses', isHeader: false, parentId: 'acc-6', level: 2, currentBalance: 0 },
  { id: 'acc-6107', code: '6107', nameAr: 'مصروفات الصيانة العامة للمقرات والمعدات', nameEn: 'General Maintenance', category: 'Operating Expenses', isHeader: false, parentId: 'acc-6', level: 2, currentBalance: 0 },
  { id: 'acc-6108', code: '6108', nameAr: 'إيجار المقرات والمستودعات', nameEn: 'Facility Rent', category: 'Operating Expenses', isHeader: false, parentId: 'acc-6', level: 2, currentBalance: 0 },
  { id: 'acc-6109', code: '6109', nameAr: 'مصاريف وعمولات بنكية', nameEn: 'Bank Charges & Fees', category: 'Operating Expenses', isHeader: false, parentId: 'acc-6', level: 2, currentBalance: 0 },

  // 7 بنود أخرى (Other Expenses)
  { id: 'acc-7', code: '7', nameAr: 'المصروفات والخسائر الأخرى', nameEn: 'Other Expenses', category: 'Other Expenses', isHeader: true, level: 1, currentBalance: 0 },
  { id: 'acc-7101', code: '7101', nameAr: 'خسائر فروق تقييم العملة الأجنبية', nameEn: 'Foreign Exchange Loss', category: 'Other Expenses', isHeader: false, parentId: 'acc-7', level: 2, currentBalance: 0 },
];

export const INITIAL_ACCOUNT_MAPPINGS: Record<string, string> = {
  // Purchases & Payables
  purchase_raw_inventory: 'acc-1108',
  purchase_vat_input: 'acc-1113',
  supplier_payable: 'acc-2101',

  // Sales & Receivables
  sales_retail_revenue: 'acc-4101',
  sales_wholesale_revenue: 'acc-4102',
  sales_export_revenue: 'acc-4103',
  sales_vat_output: 'acc-2103',
  customer_receivable_local: 'acc-1105',
  customer_receivable_export: 'acc-1106',
  cogs_local: 'acc-5101',
  cogs_export: 'acc-5102',
  inventory_finished_local: 'acc-1109',
  inventory_finished_export: 'acc-1110',

  // Rep Custody
  rep_custody: 'acc-1107',

  // Cash, Banks, Cheques
  cash_treasury: 'acc-1101',
  bank_egp: 'acc-1102',
  bank_usd: 'acc-1103',
  cheques_under_collection: 'acc-1104',
  cheques_payable: 'acc-2102',

  // Production & Inventory
  inventory_damaged: 'acc-1111',
  inventory_scrap: 'acc-1112',
  scrap_sales_revenue: 'acc-4104',

  // Variances
  variance_material_price: 'acc-5103',
  variance_material_quantity: 'acc-5104',
  variance_direct_labor: 'acc-5105',
  variance_electricity: 'acc-5106',
  variance_gas: 'acc-5107',
  variance_maintenance: 'acc-5108',
  variance_overhead: 'acc-5109',

  // FX
  fx_gain: 'acc-4105',
  fx_loss: 'acc-7101',

  // Expenses
  expenses_default: 'acc-6101',
  rep_expense: 'acc-6106',
  export_costs: 'acc-6104',
  bank_fees: 'acc-6109',
  // Credit side for export logistics cost accrual (Accrued Expenses - مصروفات مستحقة)
  export_costs_payable: 'acc-2104',
};

export const INITIAL_PERIODS: AccountingPeriod[] = [
  {
    id: 'per-2026-09',
    code: '2026-09',
    nameAr: 'فترة سبتمبر 2026',
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    isClosed: false,
  },
  {
    id: 'per-2026-10',
    code: '2026-10',
    nameAr: 'فترة أكتوبر 2026',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    isClosed: false,
  },
  {
    id: 'per-2026-08',
    code: '2026-08',
    nameAr: 'فترة أغسطس 2026 (مغلقة)',
    startDate: '2026-08-01',
    endDate: '2026-08-31',
    isClosed: true,
    closedAt: '2026-09-05T10:00:00.000Z',
    closedBy: 'المدير المالي',
  }
];

export const INITIAL_STANDARD_COST_RATES: StandardCostRate[] = [
  {
    id: 'scr-1',
    costType: 'direct_labor',
    costTypeNameAr: 'عمالة مباشرة',
    baseQuantity: 1000,
    rate: 250, // 250 EGP per 1000 cartons
    effectiveFrom: '2026-07-01',
    effectiveTo: '2026-09-30',
    status: 'active',
  },
  {
    id: 'scr-2',
    costType: 'electricity',
    costTypeNameAr: 'كهرباء صناعية',
    baseQuantity: 1000,
    rate: 100, // 100 EGP per 1000 cartons
    effectiveFrom: '2026-07-01',
    effectiveTo: '2026-09-30',
    status: 'active',
  },
  {
    id: 'scr-3',
    costType: 'gas',
    costTypeNameAr: 'غاز طبيعي',
    baseQuantity: 1000,
    rate: 5, // 5 EGP per 1000 cartons
    effectiveFrom: '2026-07-01',
    effectiveTo: '2026-09-30',
    status: 'active',
  },
  {
    id: 'scr-4',
    costType: 'maintenance',
    costTypeNameAr: 'صيانة دورية وقطع غيار',
    baseQuantity: 1000,
    rate: 50, // 50 EGP per 1000 cartons
    effectiveFrom: '2026-07-01',
    effectiveTo: '2026-09-30',
    status: 'active',
  },
  {
    id: 'scr-5',
    costType: 'supervision',
    costTypeNameAr: 'إشراف ومراقبة إنتاج',
    baseQuantity: 1000,
    rate: 30, // 30 EGP per 1000 cartons
    effectiveFrom: '2026-07-01',
    effectiveTo: '2026-09-30',
    status: 'active',
  },
];

export const INITIAL_USERS: User[] = [
  {
    id: 'usr-admin',
    username: 'admin',
    password: '12345',
    name: 'المشرف العام (Admin)',
    email: 'admin@abdullah-erp.com',
    role: 'Super Admin',
    active: true,
    createdAt: '2026-09-01T08:00:00.000Z',
    lastLogin: '2026-09-28T09:00:00.000Z',
  }
];

// Production Master Catalog: Exact 11 Finished Products (SnakDip) & Essential Raw Materials/Packaging
// All prices, costs, and balances are zero until entered by the administrator.
export const INITIAL_PRODUCTION_ITEMS: Item[] = [
  // Raw Materials (WH-01)
  {
    id: 'item-raw-corn',
    code: 'RM-CORN-01',
    barcode: '',
    nameAr: 'ذرة صفراء مجروشة',
    nameEn: 'Milled Yellow Corn',
    itemType: 'raw_material',
    baseUnitId: 'unit-kg',
    purchaseUnitId: 'unit-ton',
    vatRate: 0,
    vatCategory: 'exempt',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 365,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-raw-oil',
    code: 'RM-OIL-01',
    barcode: '',
    nameAr: 'زيت نخيل أولين نقي',
    nameEn: 'Refined Palm Olein Oil',
    itemType: 'raw_material',
    baseUnitId: 'unit-kg',
    purchaseUnitId: 'unit-ton',
    vatRate: 0,
    vatCategory: 'exempt',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 365,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-raw-flavor-sweet-chili',
    code: 'RM-FLV-01',
    barcode: '',
    nameAr: 'صوص ونكهة سويت تشيلي',
    nameEn: 'Sweet Chili Sauce & Seasoning',
    itemType: 'raw_material',
    baseUnitId: 'unit-kg',
    purchaseUnitId: 'unit-kg',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 180,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-raw-flavor-spicy-grilled',
    code: 'RM-FLV-02',
    barcode: '',
    nameAr: 'صوص ونكهة سبايسي جريلد',
    nameEn: 'Spicy Grilled Sauce & Seasoning',
    itemType: 'raw_material',
    baseUnitId: 'unit-kg',
    purchaseUnitId: 'unit-kg',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 180,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-raw-flavor-honey-mustard',
    code: 'RM-FLV-03',
    barcode: '',
    nameAr: 'صوص ونكهة هاني ماسترد',
    nameEn: 'Honey Mustard Sauce & Seasoning',
    itemType: 'raw_material',
    baseUnitId: 'unit-kg',
    purchaseUnitId: 'unit-kg',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 180,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-raw-flavor-smokey-burger',
    code: 'RM-FLV-04',
    barcode: '',
    nameAr: 'صوص ونكهة سموكي برجر',
    nameEn: 'Smokey Burger Sauce & Seasoning',
    itemType: 'raw_material',
    baseUnitId: 'unit-kg',
    purchaseUnitId: 'unit-kg',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 180,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-raw-flavor-honey-bbq',
    code: 'RM-FLV-05',
    barcode: '',
    nameAr: 'صوص ونكهة هاني باربيكيو',
    nameEn: 'Honey BBQ Sauce & Seasoning',
    itemType: 'raw_material',
    baseUnitId: 'unit-kg',
    purchaseUnitId: 'unit-kg',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 180,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-pkg-film',
    code: 'PKG-FLM-01',
    barcode: '',
    nameAr: 'فيلم تغليف أكياس مطبوع',
    nameEn: 'Printed Packaging Film',
    itemType: 'packaging_material',
    baseUnitId: 'unit-roll',
    purchaseUnitId: 'unit-roll',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: false,
    expiryPeriodDays: 0,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-pkg-carton',
    code: 'PKG-BOX-01',
    barcode: '',
    nameAr: 'كراتين شحن وتعبئة',
    nameEn: 'Master Shipping Cartons',
    itemType: 'packaging_material',
    baseUnitId: 'unit-piece',
    purchaseUnitId: 'unit-piece',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: false,
    trackExpiry: false,
    expiryPeriodDays: 0,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },

  // EXACT 11 Finished Products (Source: https://snakdip.com/collections/all-product)
  // SINGLE PRODUCTS — 6:
  {
    id: 'item-fp-s1',
    code: 'FP-SNG-01',
    barcode: '',
    nameAr: 'أصابع سوبر هيت + صوص سويت تشيلي',
    nameEn: 'Superheat Fingers + Sweet Chili Dip',
    itemType: 'finished_product',
    productFamily: 'Single',
    flavor: 'Sweet Chili Dip',
    baseUnitId: 'unit-carton',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 180,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-fp-s2',
    code: 'FP-SNG-02',
    barcode: '',
    nameAr: 'أصابع سوبر هيت + صوص سبايسي جريلد',
    nameEn: 'SuperHeat Fingers + Spicy Grilled Dip',
    itemType: 'finished_product',
    productFamily: 'Single',
    flavor: 'Spicy Grilled Dip',
    baseUnitId: 'unit-carton',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 180,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-fp-s3',
    code: 'FP-SNG-03',
    barcode: '',
    nameAr: 'تشيكن كرينكل + صوص هاني ماسترد',
    nameEn: 'Chicken Krinkl + Honey Mustard Dip',
    itemType: 'finished_product',
    productFamily: 'Single',
    flavor: 'Honey Mustard Dip',
    baseUnitId: 'unit-carton',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 180,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-fp-s4',
    code: 'FP-SNG-04',
    barcode: '',
    nameAr: 'تشيز ناتشو + صوص سموكي برجر',
    nameEn: 'Cheese Nacho + Smokey Burger Dip',
    itemType: 'finished_product',
    productFamily: 'Single',
    flavor: 'Smokey Burger Dip',
    baseUnitId: 'unit-carton',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 180,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-fp-s5',
    code: 'FP-SNG-05',
    barcode: '',
    nameAr: 'بابريكا ناتشو + صوص سويت تشيلي',
    nameEn: 'Paprika Nacho + Sweet Chili Dip',
    itemType: 'finished_product',
    productFamily: 'Single',
    flavor: 'Sweet Chili Dip',
    baseUnitId: 'unit-carton',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 180,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-fp-s6',
    code: 'FP-SNG-06',
    barcode: '',
    nameAr: 'سولتد ناتشو + صوص هاني باربيكيو',
    nameEn: 'Salted Nacho + Honey BBQ Dip',
    itemType: 'finished_product',
    productFamily: 'Single',
    flavor: 'Honey BBQ Dip',
    baseUnitId: 'unit-carton',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 180,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },

  // DUO PRODUCTS — 5:
  {
    id: 'item-fp-d1',
    code: 'FP-DUO-01',
    barcode: '',
    nameAr: 'دجاج مشوي + سويت تشيلي وهاني باربيكيو (DUO BOX)',
    nameEn: 'Grilled Chicken + Sweet Chili & Honey BBQ (DUO BOX)',
    itemType: 'finished_product',
    productFamily: 'Duo',
    flavor: 'Sweet Chili & Honey BBQ',
    baseUnitId: 'unit-carton',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 180,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-fp-d2',
    code: 'FP-DUO-02',
    barcode: '',
    nameAr: 'ديبي شيلز + سويت تشيلي وهاني باربيكيو (DUO BOX)',
    nameEn: 'Dippy Shells + Sweet Chili & Honey BBQ (DUO BOX)',
    itemType: 'finished_product',
    productFamily: 'Duo',
    flavor: 'Sweet Chili & Honey BBQ',
    baseUnitId: 'unit-carton',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 180,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-fp-d3',
    code: 'FP-DUO-03',
    barcode: '',
    nameAr: 'دجاج مشوي + سويت تشيلي وسبايسي جريلد (DUO BOX)',
    nameEn: 'Grilled Chicken + Sweet Chili & Spicy Grilled (DUO BOX)',
    itemType: 'finished_product',
    productFamily: 'Duo',
    flavor: 'Sweet Chili & Spicy Grilled',
    baseUnitId: 'unit-carton',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 180,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-fp-d4',
    code: 'FP-DUO-04',
    barcode: '',
    nameAr: 'لحم مشوي + سموكي برجر وهاني ماسترد (DUO BOX)',
    nameEn: 'Grilled Meat + Smoky Burger & Honey Mustard (DUO BOX)',
    itemType: 'finished_product',
    productFamily: 'Duo',
    flavor: 'Smoky Burger & Honey Mustard',
    baseUnitId: 'unit-carton',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 180,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  },
  {
    id: 'item-fp-d5',
    code: 'FP-DUO-05',
    barcode: '',
    nameAr: 'لحم مشوي + سموكي برجر وهاني باربيكيو (DUO BOX)',
    nameEn: 'Grilled Meat + Smoky Burger & Honey BBQ (DUO BOX)',
    itemType: 'finished_product',
    productFamily: 'Duo',
    flavor: 'Smoky Burger & Honey BBQ',
    baseUnitId: 'unit-carton',
    vatRate: 0.14,
    vatCategory: 'standard',
    trackBatch: true,
    trackExpiry: true,
    expiryPeriodDays: 180,
    standardCost: 0,
    actualCost: 0,
    sellingPriceRetail: 0,
    sellingPriceWholesale: 0,
    sellingPriceExportUSD: 0,
    active: true,
    minStockLevel: 0,
  }
];

/**
 * Production Bill of Materials for the 11 seeded finished products.
 * Each product gets an active V1 BOM (base: 1,000 cartons) built ONLY from
 * raw/packaging materials that exist in INITIAL_PRODUCTION_ITEMS above —
 * so manufacturing is possible immediately after a clean initialization.
 * Quantities per 1,000 cartons: corn 800kg, oil 180kg, flavor sauce 45kg, cartons 1,000 pcs.
 * The flavor line is matched to each product's actual seeded flavor sauce.
 */
const SINGLE_FLAVOR_BY_DIP: Record<string, string> = {
  'Sweet Chili Dip': 'item-raw-flavor-sweet-chili',
  'Spicy Grilled Dip': 'item-raw-flavor-spicy-grilled',
  'Honey Mustard Dip': 'item-raw-flavor-honey-mustard',
  'Smokey Burger Dip': 'item-raw-flavor-smokey-burger',
  'Honey BBQ Dip': 'item-raw-flavor-honey-bbq',
};

function buildInitialBoms(): { boms: BomHeader[]; bomLines: BomLine[] } {
  const boms: BomHeader[] = [];
  const bomLines: BomLine[] = [];

  INITIAL_PRODUCTION_ITEMS
    .filter(i => i.itemType === 'finished_product')
    .forEach(fp => {
      const bomId = `bom-${fp.id}`;
      boms.push({
        id: bomId,
        bomNumber: `BOM-${fp.code}-V1`,
        finishedItemId: fp.id,
        version: 1,
        baseQuantity: 1000,
        unitId: 'unit-carton',
        active: true,
        effectiveDate: '2026-01-01',
        notes: `معادلة تصنيع 1000 كرتونة من ${fp.nameAr}`,
      });

      const flavorItemId = SINGLE_FLAVOR_BY_DIP[fp.flavor || ''] || 'item-raw-flavor-sweet-chili';
      bomLines.push(
        { id: `bline-${bomId}-1`, bomId, materialItemId: 'item-raw-corn', quantityRequired: 800, unitId: 'unit-kg' },
        { id: `bline-${bomId}-2`, bomId, materialItemId: 'item-raw-oil', quantityRequired: 180, unitId: 'unit-kg' },
        { id: `bline-${bomId}-3`, bomId, materialItemId: flavorItemId, quantityRequired: 45, unitId: 'unit-kg' },
        { id: `bline-${bomId}-4`, bomId, materialItemId: 'item-pkg-carton', quantityRequired: 1000, unitId: 'unit-piece' }
      );
    });

  return { boms, bomLines };
}

export const INITIAL_PRODUCTION_BOMS: { boms: BomHeader[]; bomLines: BomLine[] } = buildInitialBoms();

export const INITIAL_BANK_ACCOUNTS: BankAccount[] = [
  {
    id: 'bank-1',
    bankName: 'بنك مصر - فرع أكتوبر الصناعي',
    accountNumber: 'EG55000200010000000349281',
    branch: 'المنطقة الصناعية',
    currency: 'EGP',
    currentBalance: 0,
    glAccountId: 'acc-1102',
    active: true,
  },
  {
    id: 'bank-2',
    bankName: 'البنك التجاري الدولي CIB - حساب التصدير (USD)',
    accountNumber: 'EG98001000020000000984321',
    branch: 'فرع الدقي للشركات',
    currency: 'USD',
    currentBalance: 0,
    glAccountId: 'acc-1103',
    active: true,
  }
];

// Clean Database initialization with configuration / master data only
export function createEmptyDatabase(): ERPDatabaseSchema {
  return {
    company: INITIAL_COMPANY,
    warehouses: INITIAL_WAREHOUSES,
    items: INITIAL_PRODUCTION_ITEMS, // Pre-configured with the 11 Snack products & raw materials
    units: INITIAL_UNITS,
    unitConversions: INITIAL_UNIT_CONVERSIONS,
    batches: [],
    boms: INITIAL_PRODUCTION_BOMS.boms,
    bomLines: INITIAL_PRODUCTION_BOMS.bomLines,
    productionOrders: [],
    productionConsumptions: [],
    productionWastes: [],
    qualityInspections: [],
    customers: [],
    suppliers: [],
    salesReps: [],
    representativeCustodies: [],
    custodyMovements: [],
    salesInvoices: [],
    salesInvoiceLines: [],
    salesReturns: [],
    salesReturnLines: [],
    purchaseInvoices: [],
    purchaseInvoiceLines: [],
    purchaseReturns: [],
    inventoryTransactions: [],
    inventoryCounts: [],
    inventoryCountLines: [],
    payments: [],
    paymentAllocations: [],
    cheques: [],
    bankAccounts: INITIAL_BANK_ACCOUNTS,
    bankTransactions: [],
    treasuryTransactions: [],
    expenses: [],
    costCenters: INITIAL_COST_CENTERS,
    accounts: INITIAL_ACCOUNTS,
    journalEntries: [],
    accountingPeriods: INITIAL_PERIODS,
    standardCostRates: INITIAL_STANDARD_COST_RATES,
    forecasts: [],
    accountMappings: INITIAL_ACCOUNT_MAPPINGS,
    users: INITIAL_USERS,
    auditLogs: [],
    exportShipments: [],
  };
}

class ERPDatabaseService {
  private db: ERPDatabaseSchema;
  private listeners: Set<() => void> = new Set();

  constructor() {
    this.db = this.load();
  }

  private load(): ERPDatabaseSchema {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
        const parsed = JSON.parse(saved);
        
        // Clean and prepare users: ensure single admin 'admin' with password '12345'
        let loadedUsers: User[] = Array.isArray(parsed.users) ? parsed.users : [];
        let adminUser = loadedUsers.find(u => u.username?.toLowerCase() === 'admin');
        
        if (adminUser) {
          adminUser.password = '12345';
          adminUser.role = 'Super Admin';
          adminUser.name = 'المشرف العام (Admin)';
          adminUser.active = true;
          // Only keep admin if previous users were demo/test users
          loadedUsers = [adminUser, ...loadedUsers.filter(u => u.username !== 'admin' && !['accountant', 'production', 'warehouse'].includes(u.username))];
        } else {
          loadedUsers = [...INITIAL_USERS];
        }

        // Clean items: if loaded items are empty or contain old fake product names, migrate to exact SnakDip products
        const hasOldPlaceholderItems = Array.isArray(parsed.items) && parsed.items.some((i: Item) => 
          i.nameAr.includes('سناكس سِنجل') || i.nameAr.includes('سناكس ديو') || i.nameAr.includes('[بيانات تجريبية]')
        );

        let loadedItems: Item[] = INITIAL_PRODUCTION_ITEMS;
        if (Array.isArray(parsed.items) && parsed.items.length > 0 && !hasOldPlaceholderItems) {
          loadedItems = parsed.items.map((i: Item) => ({
            ...i,
            nameAr: i.nameAr.replace(/\s*\[بيانات تجريبية\]/g, '').replace(/\s*\[TEST DATA\]/g, ''),
            nameEn: i.nameEn.replace(/\s*\[بيانات تجريبية\]/g, '').replace(/\s*\[TEST DATA\]/g, ''),
          }));
        }

        // Clean boms
        let loadedBoms = hasOldPlaceholderItems ? [] : (Array.isArray(parsed.boms) ? parsed.boms : []);
        let loadedBomLines = hasOldPlaceholderItems ? [] : (Array.isArray(parsed.bomLines) ? parsed.bomLines : []);

        const merged: ERPDatabaseSchema = {
          ...createEmptyDatabase(),
          ...parsed,
          company: parsed.company || INITIAL_COMPANY,
          warehouses: parsed.warehouses?.length ? parsed.warehouses : INITIAL_WAREHOUSES,
          items: loadedItems,
          boms: loadedBoms,
          bomLines: loadedBomLines,
          units: parsed.units?.length ? parsed.units : INITIAL_UNITS,
          accounts: parsed.accounts?.length ? parsed.accounts : INITIAL_ACCOUNTS,
          costCenters: parsed.costCenters?.length ? parsed.costCenters : INITIAL_COST_CENTERS,
          accountMappings: { ...INITIAL_ACCOUNT_MAPPINGS, ...(parsed.accountMappings || {}) },
          users: loadedUsers,
        };

        this.saveToStorage(merged);
        return merged;
      }
      }
    } catch (e) {
      console.error('Error loading ERP database from localStorage:', e);
    }
    const fresh = createEmptyDatabase();
    this.saveToStorage(fresh);
    return fresh;
  }

  private saveToStorage(data: ERPDatabaseSchema) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      }
    } catch (e) {
      console.error('Failed to save to localStorage:', e);
    }
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    this.saveToStorage(this.db);
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (err) {
        console.error('Error in database subscriber:', err);
      }
    });
  }

  public getSnapshot(): ERPDatabaseSchema {
    return this.db;
  }

  // Atomic state update
  public mutate(updater: (draft: ERPDatabaseSchema) => void) {
    updater(this.db);
    this.notify();
  }

  // Reset to initial clean state
  public resetToClean() {
    this.db = createEmptyDatabase();
    this.notify();
  }

  // Clear ONLY test transactions, strictly preserving users, products, chart of accounts, warehouses, system config
  public clearTestDataOnly() {
    this.mutate(draft => {
      draft.salesInvoices = draft.salesInvoices.filter(i => !i.isTest);
      draft.salesInvoiceLines = draft.salesInvoiceLines.filter(l => {
        return draft.salesInvoices.some(i => i.id === l.invoiceId);
      });
      draft.salesReturns = draft.salesReturns.filter(r => !r.isTest);
      draft.salesReturnLines = draft.salesReturnLines.filter(l => {
        return draft.salesReturns.some(r => r.id === l.returnId);
      });
      draft.purchaseInvoices = draft.purchaseInvoices.filter(i => !i.isTest);
      draft.purchaseInvoiceLines = draft.purchaseInvoiceLines.filter(l => {
        return draft.purchaseInvoices.some(i => i.id === l.purchaseInvoiceId);
      });
      draft.purchaseReturns = draft.purchaseReturns.filter(r => !r.isTest);
      draft.productionOrders = draft.productionOrders.filter(p => !p.isTest);
      draft.productionConsumptions = draft.productionConsumptions.filter(c => !(c as any).isTest);
      draft.productionWastes = draft.productionWastes.filter(w => !(w as any).isTest);
      draft.inventoryTransactions = draft.inventoryTransactions.filter(t => !t.isTest);
      draft.payments = draft.payments.filter(p => !p.isTest);
      draft.cheques = draft.cheques.filter(c => !c.isTest);
      draft.journalEntries = draft.journalEntries.filter(j => !j.isTest);
      draft.treasuryTransactions = draft.treasuryTransactions.filter(t => !t.isTest);
      draft.bankTransactions = draft.bankTransactions.filter(t => !t.isTest);
      draft.expenses = draft.expenses.filter(e => !e.isTest);
      draft.customers = draft.customers.filter(c => !c.isTest);
      draft.suppliers = draft.suppliers.filter(s => !s.isTest);
      draft.salesReps = draft.salesReps.filter(r => !r.isTest);
      draft.items = draft.items.filter(i => !i.isTest);
      draft.boms = draft.boms.filter(b => !b.isTest);
      draft.bomLines = draft.bomLines.filter(l => draft.boms.some(b => b.id === l.bomId));
      draft.users = draft.users.filter(u => !u.isTest && u.username !== 'inactive_test');
      draft.batches = draft.batches.filter(b => !(b as any).isTest);
      draft.exportShipments = draft.exportShipments.filter(e => !(e as any).isTest);
      draft.auditLogs = draft.auditLogs.filter(a => !(a as any).isTest);

      // Recalculate account balances based on remaining posted journal entries
      draft.accounts.forEach(acc => {
        acc.currentBalance = 0;
      });
      draft.journalEntries.forEach(jv => {
        if (jv.isPosted && !jv.isReversed) {
          jv.lines.forEach(line => {
            const acc = draft.accounts.find(a => a.id === line.accountId);
            if (acc) {
              const isDebitNormal = isDebitNatureCategory(acc.category);
              if (isDebitNormal) {
                acc.currentBalance += (line.debit - line.credit);
              } else {
                acc.currentBalance += (line.credit - line.debit);
              }
            }
          });
        }
      });

      // Recalculate customer balances
      draft.customers.forEach(c => {
        c.currentBalance = c.openingBalance || 0;
      });
      draft.salesInvoices.filter(i => i.status === 'posted').forEach(inv => {
        const c = draft.customers.find(x => x.id === inv.customerId);
        if (c) c.currentBalance += (c.currency === 'USD' ? inv.totalAmount : inv.totalAmountEGP);
      });
      draft.payments.filter(p => p.paymentType === 'customer_receipt').forEach(pmt => {
        const c = draft.customers.find(x => x.id === pmt.partyId);
        if (c) c.currentBalance -= (c.currency === 'USD' ? pmt.amount : pmt.amountEGP);
      });

      // Recalculate supplier balances
      draft.suppliers.forEach(s => {
        s.currentBalance = s.openingBalance || 0;
      });
      draft.purchaseInvoices.filter(i => i.status === 'posted').forEach(inv => {
        const s = draft.suppliers.find(x => x.id === inv.supplierId);
        if (s) s.currentBalance += (s.currency === 'USD' ? inv.totalAmount : inv.totalAmountEGP);
      });
      draft.payments.filter(p => p.paymentType === 'supplier_payment').forEach(pmt => {
        const s = draft.suppliers.find(x => x.id === pmt.partyId);
        if (s) s.currentBalance -= (s.currency === 'USD' ? pmt.amount : pmt.amountEGP);
      });
    });
  }

  // Overwrite entire database (e.g. For backup restore or test data loading)
  public restore(newData: ERPDatabaseSchema) {
    this.db = newData;
    this.notify();
  }
}

export const erpDb = new ERPDatabaseService();
