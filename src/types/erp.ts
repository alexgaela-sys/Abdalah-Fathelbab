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

export type PermissionAction = 'view' | 'create' | 'edit' | 'delete' | 'approve' | 'post' | 'cancel' | 'export';

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
  /**
   * F23: EXPLICIT per-user permission overrides (additive, optional).
   * Keyed by module key (see src/services/permissions.ts ModuleKey). When a module
   * key is present it REPLACES the role-matrix actions for that user; when absent
   * the role matrix governs. Super Admin is never overridable.
   */
  permissions?: Record<string, PermissionAction[]>;
  /**
   * Storekeeper ↔ warehouse linkage (ITEM: company settings screen).
   * Warehouse staff are ordinary users with a warehouse role; this list is the
   * set of warehouses they are responsible for. Disabling the user keeps this
   * linkage and every historical record: nothing is deleted.
   */
  warehouseIds?: string[];
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
  /** Optional company identity/contact fields added for the settings screen. */
  logoDataUrl?: string;   // data:image/...;base64 — stored in the database
  email?: string;
  website?: string;
  contactName?: string;
  contactPhone?: string;
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
  /** The storekeeper (user) responsible for this warehouse, when linked. */
  managerUserId?: string;
  /** Audit note recorded when the warehouse was disabled. */
  disabledReason?: string;
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
  /**
   * FIX 2 — HOW the order was closed. An order produced below its planned
   * quantity can never be closed as `full`: it must go through the explicit
   * partial-close workflow (mode + persisted reason + material reconciliation).
   */
  closeMode?: 'full' | 'partial';
  /** FIX 2 — mandatory, persisted, auditable reason of a PARTIAL close. */
  closeReason?: string;
  closedByUserId?: string;
  closedByName?: string;
  closedAt?: string;
  /**
   * FIX 2 — cumulative cost already booked into this order's finished-goods
   * batches (material + conversion). The difference to `consumed + conversion`
   * is reconciled into the batches at closure so the batch ledger and the FG
   * journal always agree to the cent.
   */
  fgCapitalizedCost?: number;
  /** Conversion cost already booked into the FG batches (see fgCapitalizedCost). */
  fgConversionCapitalized?: number;
  /**
   * FIX 2 — the per-material reconciliation snapshot taken at close time:
   * `issued = consumed + returned + approvedVariance` for EVERY material.
   */
  materialReconciliation?: Array<{
    materialItemId: string;
    issuedQuantity: number;
    consumedQuantity: number;
    returnedQuantity: number;
    approvedVarianceQuantity: number;
    approvedVarianceReason?: string;
  }>;
  destinationWarehouseId: string; // Local or Export
  targetMarket: 'local' | 'export';
  /**
   * ITEM 7 — BOM reference frozen at order creation so later BOM edits never
   * rewrite the history of an old order. `expected`/variance calculations use
   * this snapshot when present, falling back to the live BOM only for legacy
   * orders created before the snapshot existed.
   */
  bomSnapshot?: {
    bomId: string;
    bomNumber?: string;
    version?: number;
    baseQuantity: number;
    unitId: string;
    lines: Array<{ materialItemId: string; quantityRequired: number; unitId: string; wastePercentage?: number }>;
  };
  /**
   * ITEM 1 — audit trail of planned-quantity edits. An edit is only legal while
   * NO material issue has been recorded for the order (enforced in the service
   * layer, not here). Historical production/issue movements are never touched.
   */
  quantityEditHistory?: Array<{
    id: string;
    editedAt: string;
    userId: string;
    userName: string;
    fromQuantity: number;
    toQuantity: number;
    reason: string;
  }>;
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
  /** FIX 1 — the unit the BOM line was expressed in; quantities below are the
   * item's BASE inventory unit (requirement converted before the issue). */
  unitId?: string;
  plannedQuantity: number;
  actualQuantity: number;
  unitCost: number;
  date: string;
  /**
   * FIX 2 — the exact FIFO batch layers this issue drew from, so a later return
   * of unconsumed material can be posted back to the ORIGINAL batches (identity,
   * production date and expiry preserved) instead of inventing a new batch.
   */
  batchAllocations?: Array<{ batchNumber: string; quantity: number; unitCost: number }>;
  /** FIX 2 — reconciliation (base unit): actualQuantity = consumed + returned + approvedVariance. */
  returnedQuantity?: number;
  approvedVarianceQuantity?: number;
  approvedVarianceReason?: string;
  /**
   * ITEM 8 — classification of the issue line. 'bom' = normal BOM material,
   * 'substitute' = replaces a named BOM material (linked via
   * substituteForMaterialItemId, never added to the original material's
   * expected), 'additional' = extra material outside the BOM. Non-BOM kinds
   * require an approval-grade permission plus a persisted reason.
   */
  issueKind?: 'bom' | 'substitute' | 'additional';
  substituteForMaterialItemId?: string;
  issueReason?: string;
  issuedByUserId?: string;
  issuedByName?: string;
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
  unitCost?: number;
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
  /**
   * F20: stock source of the invoice. 'warehouse' (default) issues from
   * SalesInvoice.warehouseId. 'rep_custody' issues from a representative custody
   * and NEVER decrements warehouse stock a second time.
   */
  stockSource?: 'warehouse' | 'rep_custody';
  /** F20: custody the goods were issued from when stockSource === 'rep_custody'. */
  custodyId?: string;
  /** F17: total bonus (free) quantity on the invoice — value is always zero. */
  bonusQuantity?: number;
  /** F25: cash actually collected at posting time (0 for credit sales). */
  cashAmount?: number;
  /**
   * F-WH: withholding income tax at source preview, populated at invoice creation.
   * Optional and explicit — absent or zero means the feature is not applicable to
   * this invoice. Does NOT reduce subtotal / totalAmount / revenue / receivable.
   */
  withholdingAmount?: number;
  /** F-WH: human-readable applicability reason stored with the preview (Arabic). */
  withholdingReason?: string;
  /** F-WH: configured withholding rate used for the preview (fraction, e.g. 0.01). */
  withholdingRate?: number;
  /**
   * F-WH-MANUAL: the user's explicit choice on the create screen. True only when
   * "تطبيق خصم تحت حساب ضريبة الدخل 1%" was ticked for this invoice; absent/false
   * means it was never applied (no automatic eligibility anymore).
   */
  withholdingEnabled?: boolean;
  /** F-WH-MANUAL: the pre-VAT base the 1% was computed from (invoice subtotal). */
  withholdingBase?: number;
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
  /**
   * F-WH: optional per-line withholding income tax preview amount (EGP). When
   * populated, it is a shrinkage of the CASH/SETTLEMENT basis only — it does NOT
   * change the line netTotal used for revenue or receivable and is only an
   * informational preview of a later actual withholding event.
   */
  withholdingAmount?: number;
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
  /** F-WH fix: documented withholding reversed through this return (EGP). */
  withholdingReversedAmountEGP?: number;
  isTest?: boolean;
}

/**
 * F-WH fix — independent settlement document for a documented withholding that
 * is reversed by a sales return. It never edits the original receipt: it posts
 * Dr customer receivable / Cr withholding tax receivable and is limited to the
 * still-unreversed documented amount of the linked receipt.
 */
export interface WithholdingAdjustment {
  id: string;
  adjustmentNumber: string;
  type: 'return_reversal';
  adjustmentDate: string;
  paymentId: string;
  invoiceId?: string;
  salesReturnId?: string;
  amountEGP: number;
  journalEntryId?: string;
  reason: string;
  isTest?: boolean;
}

export interface SalesReturnLine {
  id: string;
  returnId: string;
  itemId: string;
  quantity: number;
  unitPrice: number;
  batchNumber: string;
  /**
   * F17: portion of `quantity` that was a zero-priced bonus on the original
   * invoice. Preserved so the return keeps the bonus zero-value nature
   * (no revenue, no VAT for the bonus portion).
   */
  freeQuantity?: number;
  /** F17/F22: VAT rate actually inherited from the original invoice line. */
  vatRate?: number;
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

export interface PurchaseReturnLine {
  id: string;
  returnId: string;
  itemId: string;
  quantity: number;
  unitId: string;
  /** Unit price of the ORIGINAL purchase invoice line (price basis of the return). */
  unitPrice: number;
  /** VAT rate inherited from the original purchase invoice line. */
  vatRate: number;
  vatAmount: number;
  netTotal: number;
  batchNumber?: string;
  /** FIFO cost actually credited out of inventory for this line. */
  issuedUnitCost?: number;
  issuedCostTotal?: number;
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
  /** ITEM 4 — itemized lines (additive; legacy returns without lines stay valid). */
  lines?: PurchaseReturnLine[];
  isTest?: boolean;
}

export type InventoryMovementType = 
  | 'purchase_receipt'
  | 'purchase_return'
  | 'warehouse_transfer'
  | 'production_consumption'
  | 'production_issue'
  | 'production_return'
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
  /**
   * F-WH: for customer receipts settled against a domestic sales invoice that
   * carried a withholding-at-source preview, this is the ACTUAL EGP amount
   * withheld and documented at the time of collection. It is recorded SEPARATELY
   * from the cash/bank received and posted to the withholding tax receivable
   * asset account when documented. Absent or zero means no withholding was
   * documented on this receipt.
   */
  withholdingAmountEGP?: number;
  /** F-WH: certificate/reference number of the withholding document (Arabic/optional). */
  withholdingCertificateNo?: string;
  /** F-WH: date of the withholding document (ISO). */
  withholdingDocumentDate?: string;
  /**
   * F-WH fix: the original sales invoice this documented withholding settles.
   * Required to reverse the withholding when goods are returned; a receipt with
   * one open withholding invoice is linked automatically, otherwise the caller
   * must pass it explicitly. Undefined = no automatic reversal (documented).
   */
  withholdingInvoiceId?: string;
  /** F-WH fix: cumulative EGP already reversed by sales returns (prevents double reversal). */
  withholdingReversedAmountEGP?: number;
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
  /**
   * The DOCUMENTED EGP-per-unit rate this cheque's trade balance was recognized
   * at (PATH A stamps the payment's rate; PATH B requires it for USD). Every
   * downstream transition journal (collection, payout, bounce) must reuse THIS
   * rate so GL 1104/1105/1106/2101/2102/bank reverse exactly what was posted.
   * Legacy USD cheques created before this field may have no rate — transitions
   * then fall back to the company rate at posting time and say so in the line.
   * NEVER a silent rate of 1 for USD (that was the F-CHQ-FX defect).
   */
  exchangeRate?: number;
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
  /** ITEM 5 — unit the forecast was entered in (defaults to the item base unit). */
  unitId?: string;
  /** ITEM 5 — who entered/last edited the forecast and when. */
  updatedByUserId?: string;
  updatedByName?: string;
  updatedAt?: string;
  notes?: string;
  isTest?: boolean;
}

/**
 * ITEM 3 — one posted monthly payroll/cost distribution over production orders.
 * The distributable amount is split proportionally to each order's produced
 * quantity in the period; the sum of allocations equals the amount EXACTLY.
 * One record per (period, costType) — re-posting the same period+type is blocked
 * so the expense is never recognized twice.
 */
export interface ProductionPayrollDistribution {
  id: string;
  distributionNumber: string;
  /** "YYYY-MM" month the cost belongs to. */
  period: string;
  costType: 'direct_labor' | 'supervision';
  costTypeNameAr: string;
  totalAmount: number;
  /** Free text describing where the amount came from (payroll sheet no., etc.). */
  sourceDescription: string;
  allocations: Array<{
    productionOrderId: string;
    productionOrderNumber: string;
    /** Produced quantity used as the allocation basis (item base unit). */
    basisQuantity: number;
    ratio: number;
    allocatedAmount: number;
    /** Journal posted for this order's share (feeds calculateCostBreakdown). */
    journalEntryId: string;
  }>;
  status: 'posted' | 'reversed';
  reversedAt?: string;
  postedAt: string;
  userId: string;
  userName: string;
  isTest?: boolean;
}

/**
 * ITEM 12 — internal scrap-sale document (NOT a normal sales invoice).
 * VAT-exempt by explicit user decision; revenue goes to 4104; stock leaves
 * wh-scrap through the FIFO engine; cancellation is a reversal, never a delete.
 */
export interface ScrapSaleDocument {
  id: string;
  docNumber: string; // SCRAP-SALE-YYYY-00001
  date: string;
  itemId: string;
  quantity: number;
  unitId: string;
  unitPrice: number;
  unitCost: number; // book value credited out of 1112 (0 when the scrap carries none)
  totalValue: number; // quantity * unitPrice (VAT exempt)
  bookValue: number; // quantity * unitCost
  buyerName: string;
  paymentMethod: 'cash' | 'credit';
  warehouseId: string; // always wh-scrap
  status: 'posted' | 'cancelled';
  /** Revenue entry: Dr cash/receivable | Cr 4104. */
  journalEntryId?: string;
  /** Cost entry (only when bookValue > 0): Dr variance | Cr 1112. */
  costJournalEntryId?: string;
  reversalJournalEntryIds?: string[];
  notes?: string;
  createdByUserId: string;
  createdByName: string;
  createdAt: string;
  isTest?: boolean;
}

/** ITEM 13 — application settings stored in the database schema. */
export type InvoiceAlignment = 'right' | 'center' | 'left';

/**
 * Printable invoice design (stored with the company settings in the database).
 * Every field here is presentation-only: totals, VAT, withholding and all
 * accounting/inventory logic remain untouched by the template.
 */
export interface InvoiceTemplateSettings {
  showLogo: boolean;
  logoDataUrl?: string;
  headerTextAr: string;
  headerTextEn: string;
  footerText: string;
  showTaxNumber: boolean;
  showAddress: boolean;
  showPhone: boolean;
  showEmail: boolean;
  showCustomerTax: boolean;
  showWarehouse: boolean;
  showWithholding: boolean;
  /** Highlight the net amount due after taxes and documented deductions. */
  showNetDue: boolean;
  netDueLabel: string;
  accentColor: string;
  textColor: string;
  titleFontSize: number;
  bodyFontSize: number;
  tableFontSize: number;
  alignment: InvoiceAlignment;
  showAccentBar: boolean;
}

export interface AppSettings {
  /** Days-before-expiry threshold for the "near expiry" bucket (default 10). */
  expiryWarningDays: number;
  /** Printable invoice design (optional for legacy databases; defaults apply). */
  invoiceTemplate?: InvoiceTemplateSettings;
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
