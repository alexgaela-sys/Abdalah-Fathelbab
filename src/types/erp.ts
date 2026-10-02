// Types definition for Abdullah ERP (نظام عبد الله لإدارة الموارد والمصانع)

export type RoleName = 
  | 'Super Admin'
  | 'General Manager'
  | 'Chief Accountant'
  | 'Accountant'
  | 'Cost Accountant'
  | 'Warehouse Manager'
  | 'Warehouse Employee'
  | 'Sales Manager'
  | 'Sales Representative'
  | 'Purchasing Manager'
  | 'Production Manager'
  | 'Treasury Accountant'
  | 'Viewer';

export type PermissionAction = 'view' | 'create' | 'edit' | 'approve' | 'post' | 'cancel' | 'export';

export interface User {
  id: string;
  username: string;
  password?: string;
  name: string;
  email: string;
  phone?: string;
  avatar?: string;
  role: RoleName;
  active: boolean;
  createdAt: string;
  lastLogin?: string;
  isTest?: boolean;
}

export interface Company {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  taxNumber: string;
  commercialRegister: string;
  address: string;
  phone: string;
  baseCurrency: 'EGP';
  exportCurrency: 'USD';
  currentUsdExchangeRate: number; // e.g. 48.50
}

export type WarehouseType = 
  | 'raw_materials' 
  | 'local_finished' 
  | 'export_finished' 
  | 'damaged' 
  | 'scrap';

export interface Warehouse {
  id: string;
  code: string;
  nameAr: string;
  type: WarehouseType;
  location: string;
  managerName?: string;
  active: boolean;
}

export type ItemType = 
  | 'finished_product'
  | 'raw_material'
  | 'packaging_material'
  | 'damaged'
  | 'scrap'
  | 'recyclable';

export type ProductFamily = 'Single' | 'Duo';

export interface Unit {
  id: string;
  code: string;
  nameAr: string; // كرتونة، كجم، طن، قطعة
  isBase: boolean;
}

export interface UnitConversion {
  id: string;
  fromUnitId: string;
  toUnitId: string;
  factor: number; // e.g. 1 Ton = 1000 Kg -> factor = 1000
}

export interface Item {
  id: string;
  code: string; // e.g. SNK-001
  barcode?: string;
  nameAr: string;
  nameEn: string;
  itemType: ItemType;
  productFamily?: ProductFamily;
  flavor?: string; // variant
  baseUnitId: string;
  purchaseUnitId?: string;
  vatRate: number; // e.g. 0.14 or 0
  vatCategory: string; // 'standard' (14%), 'exempt' (0%), 'export' (0%)
  trackBatch: boolean;
  trackExpiry: boolean;
  expiryPeriodDays?: number; // e.g. 180 days
  standardCost: number; // EGP
  actualCost: number; // EGP
  sellingPriceRetail: number; // Before VAT
  sellingPriceWholesale: number; // Before VAT
  sellingPriceExportUSD: number; // In USD
  active: boolean;
  minStockLevel: number;
  isTest?: boolean;
}

export interface Batch {
  id: string;
  batchNumber: string;
  itemId: string;
  warehouseId: string;
  productionDate: string;
  expiryDate: string;
  quantity: number;
  unitCost: number; // EGP
  isTest?: boolean;
}

export interface BomHeader {
  id: string;
  bomNumber?: string;
  finishedItemId?: string;
  productId?: string;
  code?: string;
  nameAr?: string;
  version?: number;
  baseQuantity: number; // e.g. 1000 cartons
  unitId: string;
  active: boolean;
  effectiveDate: string;
  notes?: string;
  isTest?: boolean;
}

export interface BomLine {
  id: string;
  bomId: string;
  materialItemId: string;
  quantityRequired: number; // e.g. 100 kg
  unitId: string;
  wastePercentage?: number; // % expected scrap
}

export type ProductionOrderStatus = 'draft' | 'released' | 'in_progress' | 'completed' | 'cancelled';

export interface ProductionOrder {
  id: string;
  orderNumber: string;
  productId: string;
  bomId: string;
  plannedQuantity: number;
  producedQuantity: number;
  defectiveQuantity: number;
  scrapQuantity: number;
  remainingQuantity: number;
  startDate: string;
  expectedCompletionDate: string;
  actualCompletionDate?: string;
  status: ProductionOrderStatus;
  destinationWarehouseId: string; // Local or Export
  targetMarket: 'local' | 'export';
  notes?: string;
  createdUserId: string;
  createdAt: string;
  isTest?: boolean;
}

export interface ProductionConsumption {
  id: string;
  productionOrderId: string;
  materialItemId: string;
  batchId?: string;
  warehouseId: string; // raw materials
  plannedQuantity: number;
  actualQuantity: number;
  unitCost: number;
  date: string;
}

export interface ProductionWaste {
  id: string;
  productionOrderId: string;
  materialItemId: string;
  batchNumber: string;
  quantity: number;
  wasteType: 'scrap' | 'damaged' | 'recyclable';
  destinationWarehouseId: string; // scrap or damaged or raw materials (recycling)
  reason: string;
  actionTaken: 'to_scrap' | 'to_recycling';
  date: string;
  userId: string;
}

export type QualityResult = 'passed' | 'rejected' | 'conditional';
export type QualityDestination = 'saleable' | 'raw_materials' | 'damaged' | 'scrap' | 'recycling';

export interface QualityInspection {
  id: string;
  documentType: 'purchase_receipt' | 'production_output' | 'sales_return';
  documentNumber: string;
  itemId: string;
  batchNumber: string;
  inspectedQuantity: number;
  date: string;
  inspectorName: string;
  result: QualityResult;
  reason?: string;
  destination: QualityDestination;
  destinationWarehouseId: string;
  notes?: string;
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  customerType: 'retail' | 'wholesale' | 'export';
  channel: string;
  address: string;
  phone: string;
  taxNumber?: string;
  currency: 'EGP' | 'USD';
  creditLimit: number;
  currentBalance: number; // Positive = owes us
  paymentTerms?: string; // e.g. "نقدًا", "آجل 30 يوم"
  openingBalance: number;
  active: boolean;
  isTest?: boolean;
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  taxNumber?: string;
  contactPerson?: string;
  phone: string;
  address: string;
  paymentTerms?: string;
  currency: 'EGP' | 'USD';
  openingBalance: number;
  currentBalance: number; // Positive = we owe them
  active: boolean;
  isTest?: boolean;
}

export interface SalesRepresentative {
  id: string;
  code: string;
  name: string;
  phone: string;
  active: boolean;
  targetMonthlySales: number;
  isTest?: boolean;
}

export interface RepresentativeCustody {
  id: string;
  custodyNumber: string;
  repId: string;
  status: 'open' | 'settled' | 'reconciled';
  openDate: string;
  settleDate?: string;
  closeDate?: string;
  notes?: string;
}

export interface CustodyMovement {
  id: string;
  custodyId: string;
  itemId: string;
  movementType: 'loaded' | 'sold' | 'returned';
  quantity: number;
  unitPrice: number;
  batchNumber?: string;
  date: string;
  referenceDoc?: string;
}

export type SalesChannel = 'retail' | 'wholesale' | 'export';
export type PaymentMethod = 'cash' | 'bank_transfer' | 'credit' | 'cheque';

export interface SalesInvoice {
  id: string;
  invoiceNumber: string;
  date: string;
  customerId: string;
  channel: SalesChannel;
  warehouseId: string;
  repId?: string;
  paymentMethod: PaymentMethod;
  currency: 'EGP' | 'USD';
  exchangeRate: number;
  subtotal: number;
  discountAmount: number;
  vatAmount: number;
  totalAmount: number; // In invoice currency
  totalAmountEGP: number;
  cogsTotal: number;
  status: 'posted' | 'cancelled';
  journalEntryId?: string;
  notes?: string;
  exportShipmentId?: string;
  /** Invoice-level tax treatment. Absent = legacy/current behavior (line rates govern). */
  taxTreatment?: 'taxable' | 'exempt';
  isTest?: boolean;
}

export interface SalesInvoiceLine {
  id: string;
  invoiceId: string;
  itemId: string;
  batchId?: string;
  quantity: number;
  freeQuantity: number; // e.g. Buy 10 get 1 free promotion
  unitPrice: number; // Before VAT
  unitCost: number; // Standard cost for COGS
  discount: number;
  vatRate: number;
  vatAmount: number;
  totalBeforeVat: number;
  netTotal: number;
}

export interface SalesReturn {
  id: string;
  returnNumber: string;
  invoiceId?: string;
  customerId: string;
  date: string;
  reason: string;
  totalAmount: number;
  totalVat: number;
  status: 'pending_inspection' | 'inspected' | 'posted' | 'cancelled';
  journalEntryId?: string;
  isTest?: boolean;
}

export interface SalesReturnLine {
  id: string;
  returnId: string;
  itemId: string;
  quantity: number;
  unitPrice: number;
  batchNumber: string;
  qualityDestination?: QualityDestination;
  destinationWarehouseId?: string;
}

export interface PurchaseInvoice {
  id: string;
  invoiceNumber: string;
  date: string;
  supplierId: string;
  warehouseId: string;
  paymentTerms: string;
  paymentMethod: PaymentMethod;
  currency: 'EGP' | 'USD';
  exchangeRate: number;
  reference: string;
  subtotal: number;
  vatAmount: number;
  totalAmount: number;
  totalAmountEGP: number;
  status: 'posted' | 'cancelled';
  journalEntryId?: string;
  notes?: string;
  isTest?: boolean;
}

export interface PurchaseInvoiceLine {
  id: string;
  purchaseInvoiceId: string;
  itemId: string;
  quantity: number;
  unitId: string;
  unitPrice: number;
  batchNumber: string;
  productionDate: string;
  expiryDate: string;
  vatRate: number;
  vatAmount: number;
  netTotal: number;
}

export interface PurchaseReturn {
  id: string;
  returnNumber: string;
  purchaseInvoiceId?: string;
  supplierId: string;
  warehouseId: string;
  date: string;
  reason: string;
  totalAmount: number;
  totalVat: number;
  status: 'posted' | 'cancelled';
  journalEntryId?: string;
  isTest?: boolean;
}

export type InventoryMovementType = 
  | 'purchase_receipt'
  | 'purchase_return'
  | 'warehouse_transfer'
  | 'production_consumption'
  | 'production_issue'
  | 'production_output'
  | 'sales'
  | 'sales_return'
  | 'rep_loading'
  | 'rep_return'
  | 'scrap'
  | 'recycling'
  | 'inventory_adjustment'
  | 'physical_inventory';

export interface InventoryTransaction {
  id: string;
  date: string;
  documentType: string;
  documentNumber: string;
  movementType: InventoryMovementType;
  itemId: string;
  warehouseId: string;
  batchNumber?: string;
  quantityIn: number;
  quantityOut: number;
  balanceAfter: number;
  unitCost: number;
  totalCost: number;
  notes?: string;
  isTest?: boolean;
}

export interface InventoryCount {
  id: string;
  countNumber: string;
  date: string;
  warehouseId: string;
  status: 'draft' | 'approved' | 'posted';
  notes?: string;
  approvedBy?: string;
  journalEntryId?: string;
  isTest?: boolean;
}

export interface InventoryCountLine {
  id: string;
  countId: string;
  itemId: string;
  batchNumber?: string;
  systemQuantity: number;
  physicalQuantity: number;
  varianceQuantity: number;
  unitCost: number;
  varianceCost: number;
}

export interface Payment {
  id: string;
  paymentNumber: string;
  paymentType: 'customer_receipt' | 'supplier_payment';
  partyId: string; // customerId or supplierId
  date: string;
  paymentMethod: 'cash' | 'bank' | 'cheque';
  bankAccountId?: string;
  chequeId?: string;
  amount: number;
  currency: 'EGP' | 'USD';
  exchangeRate: number;
  amountEGP: number;
  reference: string;
  notes?: string;
  journalEntryId?: string;
  isTest?: boolean;
}

export interface PaymentAllocation {
  id: string;
  paymentId: string;
  invoiceId: string; // salesInvoiceId or purchaseInvoiceId
  invoiceType: 'sales' | 'purchase';
  allocatedAmount: number;
}

export type ChequeType = 'incoming' | 'outgoing';
export type ChequeStatus = 'received' | 'under_collection' | 'collected' | 'returned' | 'bounced' | 'issued' | 'due' | 'paid';

export interface Cheque {
  id: string;
  chequeNumber: string;
  type: ChequeType;
  partyType: 'customer' | 'supplier';
  partyId: string;
  bankName: string;
  amount: number;
  currency: 'EGP' | 'USD';
  issueDate: string;
  dueDate: string;
  status: ChequeStatus;
  statusDate: string;
  relatedTransactionId?: string;
  notes?: string;
  /** Last journal posted for the latest status transition (informational). */
  journalEntryId?: string;
  /**
   * Journal that recognized the trade balance for this cheque (set exactly once):
   * incoming → Dr 1104 | Cr receivable (+ customer balance),
   * outgoing → Dr supplier payable | Cr 2102 (+ supplier balance).
   * PATH A sets it to the payment journal; PATH B (registerCheque) posts its own.
   * Bounce reverses ONLY when this exists (never fabricates an adjustment).
   */
  receiptJournalId?: string;
  isTest?: boolean;
}

export interface BankAccount {
  id: string;
  accountNumber: string;
  bankName: string;
  branch: string;
  currency: 'EGP' | 'USD';
  currentBalance: number;
  glAccountId: string;
  active: boolean;
}

export interface BankTransaction {
  id: string;
  transactionNumber: string;
  bankAccountId: string;
  type: 'deposit' | 'withdrawal' | 'transfer' | 'bank_fee';
  amount: number;
  currency?: 'EGP' | 'USD';
  date: string;
  reference: string;
  description: string;
  journalEntryId?: string;
  isTest?: boolean;
}

export interface TreasuryTransaction {
  id: string;
  receiptNumber: string;
  type: 'cash_receipt' | 'cash_payment' | 'cash_transfer' | 'advance_custody';
  amount: number;
  partyName?: string;
  date: string;
  description: string;
  glAccountId: string;
  documentType?: string;
  journalEntryId?: string;
  isTest?: boolean;
}

export interface CostCenter {
  id: string;
  code: string;
  nameAr: string;
  active: boolean;
}

export interface Expense {
  id: string;
  expenseNumber: string;
  date: string;
  glAccountId: string;
  costCenterId: string;
  category?: string;
  salesRepId?: string; // If representative-specific expense
  amount: number;
  vatAmount: number;
  totalAmount: number;
  paymentMethod: 'cash' | 'bank';
  bankAccountId?: string;
  description: string;
  reference: string;
  journalEntryId?: string;
  isTest?: boolean;
}

export interface ExportShipment {
  id: string;
  shipmentNumber: string;
  customerId: string;
  shipmentDate: string;
  portOfOrigin: string;
  destinationPort: string;
  containerNumber?: string;
  usdRevenue: number;
  exchangeRate: number;
  egpValue: number;
  productCost: number;
  shippingCost: number;
  portCosts: number;
  customsCost: number;
  otherExportCosts: number;
  totalCosts: number;
  netProfitEGP: number;
  profitMarginPercent: number;
  collectionStatus: 'pending' | 'partially_collected' | 'collected';
  collectedUsd: number;
  status: 'draft' | 'shipped' | 'delivered' | 'closed';
  /** Linked export sales invoice (additive/backward compatible). When set, revenue/FX/cost
   *  figures are derived from the real invoice and revenue/COGS are posted ONLY by the invoice. */
  salesInvoiceId?: string;
  notes?: string;
  isTest?: boolean;
}

export type AccountCategory = 
  | 'Assets'
  | 'Liabilities'
  | 'Equity'
  | 'Revenue'
  | 'COGS'
  | 'Operating Expenses'
  | 'Other Income'
  | 'Other Expenses';

/**
 * Canonical debit-nature categories: increase with debits, decrease with credits.
 * All other categories (Liabilities, Equity, Revenue, Other Income) increase with credits.
 * Single source of truth for GL balance math across the entire system.
 */
export const DEBIT_NATURE_CATEGORIES: AccountCategory[] = [
  'Assets', 'COGS', 'Operating Expenses', 'Other Expenses'
];

export function isDebitNatureCategory(category: AccountCategory): boolean {
  return DEBIT_NATURE_CATEGORIES.includes(category);
}

export interface Account {
  id: string;
  code: string; // e.g. "1101"
  nameAr: string;
  nameEn: string;
  category: AccountCategory;
  isHeader: boolean; // cannot post directly to header accounts
  parentId?: string;
  currentBalance: number; // positive = debit for assets/expenses, credit for liabilities/equity/revenue
  level: number;
}

export interface JournalLine {
  id: string;
  journalEntryId: string;
  accountId: string;
  accountCode: string;
  accountNameAr: string;
  debit: number;
  credit: number;
  currency: 'EGP' | 'USD';
  originalAmount: number;
  exchangeRate: number;
  costCenterId?: string;
  description?: string;
}

export interface JournalEntry {
  id: string;
  entryNumber: string;
  date: string;
  reference: string;
  description: string;
  sourceDocumentType: string;
  sourceDocumentId?: string;
  isPosted: boolean;
  postedAt?: string;
  isReversed?: boolean;
  reversedByEntryId?: string;
  lines: JournalLine[];
  totalDebit: number;
  totalCredit: number;
  createdUserId: string;
  isTest?: boolean;
}

export interface AccountingPeriod {
  id: string;
  code: string; // e.g. "2026-Q1" or "2026-09"
  nameAr: string;
  startDate: string;
  endDate: string;
  isClosed: boolean;
  closedAt?: string;
  closedBy?: string;
}

export interface StandardCostRate {
  id: string;
  costType: 'direct_labor' | 'electricity' | 'gas' | 'maintenance' | 'supervision' | 'overhead';
  costTypeNameAr: string;
  productFamily?: ProductFamily;
  productId?: string;
  baseQuantity: number; // e.g. 1000 cartons
  rate: number; // EGP
  effectiveFrom: string;
  effectiveTo: string;
  status: 'active' | 'expired';
}

export interface SalesForecast {
  id: string;
  period: string; // e.g. "2026-10"
  productId: string;
  forecastQuantity: number;
  actualQuantity: number;
  varianceQuantity: number;
  accuracyPercentage: number;
}

export interface AccountMapping {
  key: string;
  nameAr: string;
  accountId: string;
}

export interface AuditLog {
  id: string;
  timestamp: string;
  userId: string;
  userName: string;
  module: string;
  action: 'login' | 'create' | 'edit' | 'approve' | 'post' | 'cancel' | 'reverse';
  recordId: string;
  previousValue?: string;
  newValue?: string;
  description: string;
}
