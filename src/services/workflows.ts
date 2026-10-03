// End-to-End Operational Workflows for Purchasing, Sales, Custody, Payments, Cheques, Export, Quality & Physical Counts
// Every workflow is atomic: all validation happens BEFORE any mutation, and each posted
// document produces balanced accounting via AccountingEngine (AccountMapping-driven).
import { erpDb, generateErpId, nextDocNumber } from './db';
import { 
  PurchaseInvoice, PurchaseInvoiceLine, SalesInvoice, SalesInvoiceLine, 
  Payment, Cheque, ChequeStatus, QualityInspection, InventoryCount, InventoryCountLine, 
  ExportShipment, Expense, Customer, Supplier, SalesRepresentative, 
  RepresentativeCustody, CustodyMovement, SalesReturn, SalesReturnLine,
  PurchaseReturn, TreasuryTransaction, BankTransaction, isDebitNatureCategory
} from '../types/erp';
import { InventoryEngine } from './inventory';
import { AccountingEngine } from './accounting';
import { AuthorizationService } from './authorization';
import { isChannelCustomerMismatch } from './pricing';

interface JLine {
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

/** Build a journal line pulling code/name from the chart of accounts (no hardcoded labels). */
function jl(
  accountId: string,
  debit: number,
  credit: number,
  originalAmount: number,
  exchangeRate: number,
  currency: 'EGP' | 'USD',
  description: string,
  costCenterId?: string
): JLine {
  const db = erpDb.getSnapshot();
  const acc = db.accounts.find(a => a.id === accountId);
  return {
    id: '',
    journalEntryId: '',
    accountId,
    accountCode: acc?.code || '',
    accountNameAr: acc?.nameAr || '',
    debit,
    credit,
    currency,
    originalAmount,
    exchangeRate,
    costCenterId,
    description,
  };
}

/** Map a quality destination to the warehouse + inventory account that receives the goods. */
function qualityDestinationRouting(destination: string): { warehouseId: string; inventoryMappingKey: string; fallbackAccId: string; label: string } {
  switch (destination) {
    case 'raw_materials':
    case 'recycling':
      return { warehouseId: 'wh-raw', inventoryMappingKey: 'purchase_raw_inventory', fallbackAccId: 'acc-1108', label: 'مستودع الخامات (إعادة تدوير)' };
    case 'damaged':
      return { warehouseId: 'wh-damaged', inventoryMappingKey: 'inventory_damaged', fallbackAccId: 'acc-1111', label: 'مستودع التوالف والمعيب' };
    case 'scrap':
      return { warehouseId: 'wh-scrap', inventoryMappingKey: 'inventory_scrap', fallbackAccId: 'acc-1112', label: 'مستودع الهالك والسكراب' };
    default:
      return { warehouseId: 'wh-local', inventoryMappingKey: 'inventory_finished_local', fallbackAccId: 'acc-1109', label: 'مستودع المنتج التام المحلي' };
  }
}

export class WorkflowService {
  /**
   * 1. Create and Post Purchase Invoice (Material Receipt)
   */
  public static createPurchaseInvoice(params: {
    supplierId: string;
    warehouseId: string;
    paymentMethod: 'cash' | 'credit' | 'bank_transfer' | 'cheque';
    currency: 'EGP' | 'USD';
    exchangeRate: number;
    reference: string;
    date: string;
    notes?: string;
    lines: Array<{
      itemId: string;
      quantity: number;
      unitId: string;
      unitPrice: number;
      batchNumber: string;
      productionDate: string;
      expiryDate: string;
      vatRate: number;
    }>;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; invoice?: PurchaseInvoice; error?: string } {
    // RBAC: creating purchase invoices requires 'create' on purchasing
    const guard = AuthorizationService.enforce('purchasing', 'create', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };
    params = { ...params, userId: guard.userId, userName: guard.userName };

    const db = erpDb.getSnapshot();
    const supplier = db.suppliers.find(s => s.id === params.supplierId);
    if (!supplier) return { success: false, error: 'المورد غير مسجل بالنظام' };

    const warehouse = db.warehouses.find(w => w.id === params.warehouseId);
    if (!warehouse) return { success: false, error: 'المستودع غير صالح' };

    if (!params.lines || params.lines.length === 0) {
      return { success: false, error: 'يجب إدخال أصناف بالفاتورة' };
    }

    const subtotal = params.lines.reduce((s, l) => s + (l.quantity * l.unitPrice), 0);
    const vatAmount = params.lines.reduce((s, l) => s + (l.quantity * l.unitPrice * (l.vatRate || 0)), 0);
    const totalAmount = subtotal + vatAmount;
    const totalAmountEGP = totalAmount * (params.currency === 'USD' ? params.exchangeRate : 1);

    const invoiceNumber = nextDocNumber(db as unknown as Record<string, unknown>, 'purchaseInvoices', 'PINV', 5, 'invoiceNumber');
    const invoiceId = generateErpId('pinv');

    // 1. Prepare and Post Balanced Double-Entry Accounting Journal
    // Debit: Raw/Packaging Inventory
    // Debit: VAT Input
    // Credit: Trade Payables (Credit) or Cash/Bank
    const rawInvAcc = AccountingEngine.getMappedAccountId('purchase_raw_inventory', 'acc-1108');
    const vatInputAcc = AccountingEngine.getMappedAccountId('purchase_vat_input', 'acc-1113');
    
    let creditAcc = AccountingEngine.getMappedAccountId('supplier_payable', 'acc-2101');
    if (params.paymentMethod === 'cash') creditAcc = AccountingEngine.getMappedAccountId('cash_treasury', 'acc-1101');
    if (params.paymentMethod === 'bank_transfer') creditAcc = AccountingEngine.getMappedAccountId('bank_egp', 'acc-1102');

    const subtotalEGP = subtotal * (params.currency === 'USD' ? params.exchangeRate : 1);
    const vatEGP = vatAmount * (params.currency === 'USD' ? params.exchangeRate : 1);

    const journalLines = [
      {
        id: '',
        journalEntryId: '',
        accountId: rawInvAcc,
        accountCode: '1108',
        accountNameAr: 'مخزون المواد الخام ومواد التعبئة',
        debit: subtotalEGP,
        credit: 0,
        currency: params.currency,
        originalAmount: subtotal,
        exchangeRate: params.exchangeRate,
        costCenterId: 'cc-prod',
        description: `توريد خامات فاتورة مشتريات ${invoiceNumber}`,
      },
      ...(vatEGP > 0 ? [{
        id: '',
        journalEntryId: '',
        accountId: vatInputAcc,
        accountCode: '1113',
        accountNameAr: 'ضريبة القيمة المضافة - مدخلات ومشتريات',
        debit: vatEGP,
        credit: 0,
        currency: params.currency,
        originalAmount: vatAmount,
        exchangeRate: params.exchangeRate,
        description: `ضريبة مدخلات فاتورة ${invoiceNumber}`,
      }] : []),
      {
        id: '',
        journalEntryId: '',
        accountId: creditAcc,
        accountCode: creditAcc === 'acc-1101' ? '1101' : creditAcc === 'acc-1102' ? '1102' : '2101',
        accountNameAr: creditAcc === 'acc-1101' ? 'الخزينة الرئيسية' : creditAcc === 'acc-1102' ? 'البنك' : `المورد: ${supplier.name}`,
        debit: 0,
        credit: totalAmountEGP,
        currency: params.currency,
        originalAmount: totalAmount,
        exchangeRate: params.exchangeRate,
        description: `استحقاق فاتورة مشتريات ${invoiceNumber} - مورد: ${supplier.name}`,
      }
    ];

    const jvResult = AccountingEngine.postJournal({
      date: params.date,
      reference: params.reference || invoiceNumber,
      description: `فاتورة مشتريات خامات ومواد تعبئة ${invoiceNumber} من المورد ${supplier.name}`,
      sourceDocumentType: 'purchase_invoice',
      sourceDocumentId: invoiceId,
      lines: journalLines,
    }, params.userId, params.userName);

    if (!jvResult.success) {
      return { success: false, error: jvResult.error };
    }

    // 2. Perpetual Inventory Movements
    for (const line of params.lines) {
      InventoryEngine.recordMovement({
        itemId: line.itemId,
        warehouseId: params.warehouseId,
        movementType: 'purchase_receipt',
        date: params.date,
        quantityIn: line.quantity,
        quantityOut: 0,
        unitCost: line.unitPrice * (params.currency === 'USD' ? params.exchangeRate : 1),
        documentType: 'فاتورة مشتريات',
        documentNumber: invoiceNumber,
        batchNumber: line.batchNumber,
        productionDate: line.productionDate,
        expiryDate: line.expiryDate,
        notes: `مشتريات من ${supplier.name}`,
      });
    }

    let createdInvoice: PurchaseInvoice | undefined;

    erpDb.mutate(draft => {
      // Update supplier balance if credit.
      // QA-24: the supplier ledger is maintained in the BASE currency (EGP),
      // because GL 2101 is posted with totalAmountEGP. Mixing the foreign
      // document amount with the EGP ledger breaks the supplier/GL reconciliation.
      if (params.paymentMethod === 'credit') {
        const sup = draft.suppliers.find(s => s.id === params.supplierId);
        if (sup) sup.currentBalance = (sup.currentBalance || 0) + totalAmountEGP;
      }

      // QA-13: a cash purchase moves real money, so it must produce a treasury
      // document exactly like every other cash movement — otherwise the
      // Treasury document list and GL 1101 diverge by the purchase amount.
      if (params.paymentMethod === 'cash' && totalAmountEGP > 0) {
        const cashAccId = AccountingEngine.getMappedAccountId('cash_treasury', 'acc-1101');
        const supplierName = supplier.name;
        draft.treasuryTransactions.push({
          id: generateErpId('ctx'),
          receiptNumber: `TRE-${invoiceNumber}`,
          type: 'cash_payment',
          amount: totalAmountEGP,
          partyName: supplierName,
          date: params.date,
          description: `سداد نقدي لفاتورة مشتريات ${invoiceNumber} - المورد: ${supplierName}`,
          glAccountId: cashAccId,
          documentType: 'purchase_invoice',
          journalEntryId: jvResult.entry?.id,
          isTest: params.isTest,
        } as TreasuryTransaction);
      }

      createdInvoice = {
        id: invoiceId,
        invoiceNumber,
        date: params.date,
        supplierId: params.supplierId,
        warehouseId: params.warehouseId,
        paymentTerms: supplier.paymentTerms || 'آجل',
        paymentMethod: params.paymentMethod,
        currency: params.currency,
        exchangeRate: params.exchangeRate,
        reference: params.reference,
        subtotal,
        vatAmount,
        totalAmount,
        totalAmountEGP,
        status: 'posted',
        journalEntryId: jvResult.entry?.id,
        notes: params.notes,
      };

      draft.purchaseInvoices.push(createdInvoice);

      // Lines
      params.lines.forEach((l, idx) => {
        draft.purchaseInvoiceLines.push({
          id: `pinvl-${invoiceId}-${idx + 1}`,
          purchaseInvoiceId: invoiceId,
          itemId: l.itemId,
          quantity: l.quantity,
          unitId: l.unitId,
          unitPrice: l.unitPrice,
          batchNumber: l.batchNumber,
          productionDate: l.productionDate,
          expiryDate: l.expiryDate,
          vatRate: l.vatRate,
          vatAmount: l.quantity * l.unitPrice * l.vatRate,
          netTotal: l.quantity * l.unitPrice * (1 + l.vatRate),
        });
      });

      // Audit Log
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: params.userId || 'usr-admin',
        userName: params.userName || 'مدير المشتريات',
        module: 'المشتريات',
        action: 'create',
        recordId: invoiceId,
        description: `إنشاء وترحيل فاتورة مشتريات رقم ${invoiceNumber} بمبلغ ${totalAmount.toLocaleString('ar-EG')} ${params.currency} من المورد ${supplier.name}`,
      });
    });

    return { success: true, invoice: createdInvoice };
  }

  /**
   * 2. Create and Post Sales Invoice (Local / Export, Retail / Wholesale)
   * Supports Promotions: Buy 10 get 1 free (free quantity with price = 0, reduces stock, included in COGS)
   * Credit Limit Warning Only: does NOT block sale
   */
  public static createSalesInvoice(params: {
    customerId: string;
    channel: 'retail' | 'wholesale' | 'export';
    warehouseId: string;
    repId?: string;
    /** F20: where the goods are issued from. Absent = 'warehouse' (legacy behavior). */
    stockSource?: 'warehouse' | 'rep_custody';
    /** F20: required when stockSource === 'rep_custody'. */
    custodyId?: string;
    paymentMethod: 'cash' | 'credit' | 'bank_transfer' | 'cheque';
    currency: 'EGP' | 'USD';
    exchangeRate: number;
    date: string;
    notes?: string;
    exportShipmentId?: string;
    /** Invoice-level tax treatment. Absent = current behavior (per-line vatRate governs). */
    taxTreatment?: 'taxable' | 'exempt';
    lines: Array<{
      itemId: string;
      quantity: number;
      freeQuantity?: number; // Free promotional cartons
      unitPrice: number; // Before VAT
      discount?: number;
      vatRate: number;
      batchId?: string;
    }>;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; invoice?: SalesInvoice; creditWarning?: string; error?: string } {
    // RBAC: creating sales invoices requires 'create' on sales
    const guard = AuthorizationService.enforce('sales', 'create', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };
    params = { ...params, userId: guard.userId, userName: guard.userName };

    const db = erpDb.getSnapshot();
    const customer = db.customers.find(c => c.id === params.customerId);
    if (!customer) return { success: false, error: 'العميل غير مسجل بالنظام' };

    // F3 service-level validation: the export boundary (currency/warehouse/VAT/revenue
    // account) must never disagree with the customer master type. Retail↔wholesale
    // overrides remain allowed (pricing only — not dangerous).
    if (isChannelCustomerMismatch(customer.customerType, params.channel)) {
      return {
        success: false,
        error: params.channel === 'export'
          ? `قناة التصدير تتطلب عميل تصدير مسجل: العميل (${customer.name}) من نوع ${customer.customerType}`
          : `العميل (${customer.name}) مسجل كعميل تصدير ويجب اختيار قناة التصدير (USD / مستودع WH-03)`
      };
    }

    const warehouse = db.warehouses.find(w => w.id === params.warehouseId);
    if (!warehouse) return { success: false, error: 'المستودع غير صالح' };

    if (!params.lines || params.lines.length === 0) {
      return { success: false, error: 'يجب إضافة أصناف لفاتورة المبيعات' };
    }

    // ---- F20: stock source — warehouse OR representative custody ----
    const stockSource = params.stockSource === 'rep_custody' ? 'rep_custody' : 'warehouse';
    let custody: RepresentativeCustody | undefined;
    let custodyRepId: string | undefined = params.repId;
    if (stockSource === 'rep_custody') {
      if (!params.custodyId) return { success: false, error: 'يجب اختيار عهدة المندوب كمصدر صرف' };
      custody = db.representativeCustodies.find(c => c.id === params.custodyId && c.status === 'open');
      if (!custody) return { success: false, error: 'عهدة المندوب غير موجودة أو تم تسويتها' };
      custodyRepId = custody.repId;
      // Custody may only serve its own representative.
      if (params.repId && params.repId !== custody.repId) {
        return { success: false, error: 'العهدة المختارة لا تخص المندوب المحدد' };
      }
    }

    /** F20/F21: available quantity in the selected source for an item. */
    const custodyAvailable = (itemId: string): number => {
      if (!custody) return 0;
      const ms = db.custodyMovements.filter(m => m.custodyId === custody!.id && m.itemId === itemId);
      const loaded = ms.filter(m => m.movementType === 'loaded').reduce((s, m) => s + m.quantity, 0);
      const sold = ms.filter(m => m.movementType === 'sold').reduce((s, m) => s + m.quantity, 0);
      const returned = ms.filter(m => m.movementType === 'returned').reduce((s, m) => s + m.quantity, 0);
      return loaded - sold - returned;
    };

    // Check stock for all lines (including free quantities) in the SELECTED source
    for (const line of params.lines) {
      const totalQtyToIssue = line.quantity + (line.freeQuantity || 0);
      if (!(totalQtyToIssue > 0)) continue;
      const item = db.items.find(i => i.id === line.itemId);
      if (stockSource === 'rep_custody') {
        const available = custodyAvailable(line.itemId);
        if (available < totalQtyToIssue) {
          return {
            success: false,
            error: `الكمية المتاحة بعهدة المندوب من الصنف (${item?.nameAr}) هي ${available} ولا تكفي لصرف ${totalQtyToIssue} (تشمل البونص المجاني)`
          };
        }
      } else {
        const stock = InventoryEngine.getItemBalance(line.itemId, params.warehouseId);
        if (stock < totalQtyToIssue) {
          return {
            success: false,
            error: `رصيد الصنف (${item?.nameAr}) في المستودع المختار هو ${stock} ولا يكفي لصرف كمية ${totalQtyToIssue} (تشمل البونص المجاني)`
          };
        }
      }
    }

    // Calculations
    let subtotal = 0;
    let vatAmount = 0;
    let cogsTotal = 0;

    const itemsMap = new Map(db.items.map(i => [i.id, i]));

    let bonusQuantity = 0;
    // QA-01: resolve each line's cost from the ACTUAL stock that leaves the
    // warehouse (FIFO), falling back only to a legitimately configured
    // standard cost. The previous hard-coded `standardCost || 50` is gone —
    // a cost is never invented. Resolve everything BEFORE posting so a missing
    // cost aborts the whole invoice with a clear business message.
    const lineCosts = new Map<number, { totalUnits: number; unitCost: number; source: 'fifo' | 'standard' }>();
    params.lines.forEach((l, idx) => {
      const totalUnits = (Number(l.quantity) || 0) + (Number(l.freeQuantity) || 0);
      if (totalUnits <= 0) return;
      // The stock source decides which cost pool is relieved.
      const costWarehouseId = stockSource === 'rep_custody' ? 'wh-local' : params.warehouseId;
      const resolved = InventoryEngine.resolveActualUnitCost(l.itemId, costWarehouseId, totalUnits);
      if (!resolved.ok) {
        lineCosts.set(idx, { totalUnits, unitCost: Number.NaN, source: 'fifo' });
        return;
      }
      lineCosts.set(idx, { totalUnits, unitCost: resolved.unitCost, source: resolved.source });
    });
    for (const [, c] of lineCosts) {
      if (!Number.isFinite(c.unitCost)) {
        const idx = [...lineCosts.entries()].find(([, v]) => v === c)?.[0] ?? 0;
        const item = itemsMap.get(params.lines[idx]?.itemId);
        return {
          success: false,
          error:
            `لا توجد تكلفة فعلية معرَّفة للصنف (${item?.nameAr || params.lines[idx]?.itemId}) في المستودع المحدد. ` +
            `يجب إدخال تكلفة الصنف في بطاقة الصنف أو استلامه من مورد بسعر فعلي قبل الترحيل المحاسبي.`,
        };
      }
    }

    params.lines.forEach((l, idx) => {
      // F17: the BONUS quantity is never priced — it is a separate zero-value
      // quantity that still leaves inventory and still hits COGS.
      const lineSub = l.quantity * l.unitPrice * (1 - ((l.discount || 0) / 100));
      // F5: invoice-level 'exempt' forces zero-rated lines regardless of item rate;
      // absent/ taxable keeps the passed (item-derived or user-overridden) rates.
      const effectiveRate = params.taxTreatment === 'exempt' ? 0 : (l.vatRate || 0);
      const lineVat = lineSub * effectiveRate;
      subtotal += lineSub;
      vatAmount += lineVat;
      bonusQuantity += Number(l.freeQuantity) || 0;

      // Free quantity price = 0, but included in COGS at the real stock cost.
      const cost = lineCosts.get(idx);
      if (cost) cogsTotal += cost.totalUnits * cost.unitCost;
    });

    const totalAmount = subtotal + vatAmount;
    const totalAmountEGP = totalAmount * (params.currency === 'USD' ? params.exchangeRate : 1);
    // QA-01 / AI — FIFO batch costs are stored in the EGP BASE currency (purchases
    // are converted at their own historical rate when they are booked). Applying
    // the invoice exchange rate again multiplied export COGS by the rate a second
    // time (e.g. 10 x 40 EGP became 20,000). COGS is therefore taken at its real
    // EGP inventory value; the invoice exchange rate only converts REVENUE.
    const cogsTotalEGP = cogsTotal;

    // Credit limit warning check (DO NOT BLOCK SALE)
    let creditWarning: string | undefined;
    if (params.paymentMethod === 'credit' && customer.creditLimit > 0) {
      const newExpectedBalance = (customer.currentBalance || 0) + totalAmount;
      if (newExpectedBalance > customer.creditLimit) {
        creditWarning = `تنبيه ائتماني: العميل تجاوز الحد الائتماني المسموح به (${customer.creditLimit.toLocaleString('ar-EG')} ج.م) وسيصبح رصيده (${newExpectedBalance.toLocaleString('ar-EG')} ج.م). تم السماح بالبيع وفق سياسة النظام.`;
      }
    }

    const invoiceNumber = nextDocNumber(db as unknown as Record<string, unknown>, 'salesInvoices', 'SINV', 5, 'invoiceNumber');
    const invoiceId = generateErpId('sinv');

    // Double Entry Accounting:
    // 1. Revenue & Receivable
    // Debit: Customer Receivable (or Cash / Bank)
    // Credit: Sales Revenue (Retail / Wholesale / Export)
    // Credit: VAT Output Tax
    // 2. COGS & Finished Inventory
    // Debit: COGS
    // Credit: Finished Goods Inventory
    let revAcc = AccountingEngine.getMappedAccountId('sales_retail_revenue', 'acc-4101');
    if (params.channel === 'wholesale') revAcc = AccountingEngine.getMappedAccountId('sales_wholesale_revenue', 'acc-4102');
    if (params.channel === 'export') revAcc = AccountingEngine.getMappedAccountId('sales_export_revenue', 'acc-4103');

    let debitAcc = AccountingEngine.getMappedAccountId(params.channel === 'export' ? 'customer_receivable_export' : 'customer_receivable_local', 'acc-1105');
    if (params.paymentMethod === 'cash') debitAcc = AccountingEngine.getMappedAccountId('cash_treasury', 'acc-1101');
    if (params.paymentMethod === 'bank_transfer') debitAcc = AccountingEngine.getMappedAccountId('bank_egp', 'acc-1102');

    const vatOutputAcc = AccountingEngine.getMappedAccountId('sales_vat_output', 'acc-2103');
    const cogsAcc = AccountingEngine.getMappedAccountId(params.channel === 'export' ? 'cogs_export' : 'cogs_local', 'acc-5101');
    // F20: goods issued from a representative custody relieve the custody account
    // (1107) — the finished-goods warehouse stock was already relieved when the
    // goods were LOADED to the representative, so it must NOT be relieved twice.
    const finishedInvAcc = stockSource === 'rep_custody'
      ? AccountingEngine.getMappedAccountId('rep_custody', 'acc-1107')
      : AccountingEngine.getMappedAccountId(params.channel === 'export' ? 'inventory_finished_export' : 'inventory_finished_local', 'acc-1109');

    const subtotalEGP = subtotal * (params.currency === 'USD' ? params.exchangeRate : 1);
    const vatEGP = vatAmount * (params.currency === 'USD' ? params.exchangeRate : 1);

    const journalLines = [
      // 1. Revenue side
      {
        id: '',
        journalEntryId: '',
        accountId: debitAcc,
        accountCode: debitAcc === 'acc-1101' ? '1101' : debitAcc === 'acc-1102' ? '1102' : debitAcc === 'acc-1106' ? '1106' : '1105',
        accountNameAr: debitAcc === 'acc-1101' ? 'الخزينة' : debitAcc === 'acc-1102' ? 'البنك' : `حساب العميل: ${customer.name}`,
        debit: totalAmountEGP,
        credit: 0,
        currency: params.currency,
        originalAmount: totalAmount,
        exchangeRate: params.exchangeRate,
        costCenterId: params.channel === 'export' ? 'cc-export' : 'cc-sales',
        description: `مبيعات فاتورة ${invoiceNumber} - عميل: ${customer.name}`,
      },
      {
        id: '',
        journalEntryId: '',
        accountId: revAcc,
        accountCode: revAcc === 'acc-4101' ? '4101' : revAcc === 'acc-4102' ? '4102' : '4103',
        accountNameAr: revAcc === 'acc-4101' ? 'إيراد مبيعات تجزئة' : revAcc === 'acc-4102' ? 'إيراد مبيعات جملة' : 'إيراد مبيعات تصدير',
        debit: 0,
        credit: subtotalEGP,
        currency: params.currency,
        originalAmount: subtotal,
        exchangeRate: params.exchangeRate,
        costCenterId: params.channel === 'export' ? 'cc-export' : 'cc-sales',
        description: `إيراد فاتورة مبيعات ${invoiceNumber}`,
      },
      ...(vatEGP > 0 ? [{
        id: '',
        journalEntryId: '',
        accountId: vatOutputAcc,
        accountCode: '2103',
        accountNameAr: 'ضريبة القيمة المضافة - مخرجات ومبيعات',
        debit: 0,
        credit: vatEGP,
        currency: params.currency,
        originalAmount: vatAmount,
        exchangeRate: params.exchangeRate,
        description: `ضريبة مخرجات فاتورة ${invoiceNumber}`,
      }] : []),

      // 2. COGS side
      {
        id: '',
        journalEntryId: '',
        accountId: cogsAcc,
        accountCode: params.channel === 'export' ? '5102' : '5101',
        accountNameAr: params.channel === 'export' ? 'تكلفة البضاعة المباعة - تصدير' : 'تكلفة البضاعة المباعة - محلي',
        debit: cogsTotalEGP,
        credit: 0,
        currency: 'EGP' as const,
        originalAmount: cogsTotalEGP,
        exchangeRate: 1,
        costCenterId: params.channel === 'export' ? 'cc-export' : 'cc-sales',
        description: `تكلفة البضاعة المباعة لفاتورة ${invoiceNumber} (تشمل البونص الترويجي)`,
      },
      {
        id: '',
        journalEntryId: '',
        accountId: finishedInvAcc,
        accountCode: stockSource === 'rep_custody' ? '1107' : (params.channel === 'export' ? '1110' : '1109'),
        accountNameAr: stockSource === 'rep_custody' ? 'عهد مناديب المبيعات (بضائع ونقدية)' : (params.channel === 'export' ? 'مخزون الإنتاج التام - تصدير' : 'مخزون الإنتاج التام - محلي'),
        debit: 0,
        credit: cogsTotalEGP,
        currency: 'EGP' as const,
        originalAmount: cogsTotalEGP,
        exchangeRate: 1,
        costCenterId: params.channel === 'export' ? 'cc-export' : 'cc-sales',
        description: stockSource === 'rep_custody'
          ? `صرف من عهدة المندوب لفاتورة ${invoiceNumber}`
          : `صرف مخزون إنتاج تام لفاتورة ${invoiceNumber}`,
      }
    ];

    const jvResult = AccountingEngine.postJournal({
      date: params.date,
      reference: invoiceNumber,
      description: `فاتورة مبيعات ${params.channel === 'export' ? 'تصدير' : 'محلية'} رقم ${invoiceNumber} للعميل ${customer.name}`,
      sourceDocumentType: 'sales_invoice',
      sourceDocumentId: invoiceId,
      lines: journalLines,
    }, params.userId, params.userName);

    if (!jvResult.success) {
      return { success: false, error: jvResult.error };
    }

    // Perpetual Stock Deduction — F20: only when the goods come from a warehouse.
    // Custody issues are tracked on custodyMovements (loaded - sold - returned).
    if (stockSource === 'warehouse') {
      params.lines.forEach(line => {
        const item = itemsMap.get(line.itemId);
        const totalQty = line.quantity + (line.freeQuantity || 0);
        InventoryEngine.recordMovement({
          itemId: line.itemId,
          warehouseId: params.warehouseId,
          movementType: 'sales',
          quantityIn: 0,
          quantityOut: totalQty,
          unitCost: item?.standardCost ?? 0,
          documentType: 'فاتورة مبيعات',
          documentNumber: invoiceNumber,
          notes: `مبيعات للعميل ${customer.name}${line.freeQuantity ? ` (منها ${line.freeQuantity} بونص مجاني)` : ''}`,
          date: params.date,
        });
      });
    }

    // F20: custody issue movements (invoice -> rep -> custody -> item -> qty -> cost)
    const custodyMovements: CustodyMovement[] = [];
    if (stockSource === 'rep_custody' && custody) {
      for (const line of params.lines) {
        const totalQty = line.quantity + (line.freeQuantity || 0);
        custodyMovements.push({
          id: generateErpId('cstm'),
          custodyId: custody!.id,
          itemId: line.itemId,
          movementType: 'sold',
          quantity: totalQty,
          unitPrice: line.unitPrice,
          date: params.date,
          referenceDoc: invoiceNumber,
        });
      }
    }

    let createdInvoice: SalesInvoice | undefined;

    erpDb.mutate(draft => {
      // Update customer balance if credit
      if (params.paymentMethod === 'credit') {
        const cust = draft.customers.find(c => c.id === params.customerId);
        if (cust) cust.currentBalance = (cust.currentBalance || 0) + totalAmount;
      }

      createdInvoice = {
        id: invoiceId,
        invoiceNumber,
        date: params.date,
        customerId: params.customerId,
        channel: params.channel,
        warehouseId: params.warehouseId,
        repId: custodyRepId,
        paymentMethod: params.paymentMethod,
        currency: params.currency,
        exchangeRate: params.exchangeRate,
        subtotal,
        discountAmount: 0,
        vatAmount,
        totalAmount,
        totalAmountEGP,
        cogsTotal: cogsTotalEGP,
        status: 'posted',
        journalEntryId: jvResult.entry?.id,
        notes: params.notes,
        exportShipmentId: params.exportShipmentId,
        taxTreatment: params.taxTreatment,
        stockSource,
        custodyId: custody?.id,
        bonusQuantity,
        cashAmount: params.paymentMethod === 'cash' ? totalAmountEGP : 0,
      };

      draft.salesInvoices.push(createdInvoice);

      // F25/F29: a cash sale MUST also exist in the treasury transaction ledger
      // (the GL cash line is posted above; this is its treasury document).
      if (params.paymentMethod === 'cash' && totalAmountEGP > 0) {
        draft.treasuryTransactions.push({
          id: generateErpId('ctx'),
          receiptNumber: nextDocNumber(draft as unknown as Record<string, unknown>, 'treasuryTransactions', 'CSH', 4, 'receiptNumber'),
          type: 'cash_receipt',
          amount: totalAmountEGP,
          partyName: customer.name,
          date: params.date,
          description: `مبيعات نقدية - فاتورة ${invoiceNumber}${bonusQuantity ? ` (تشمل ${bonusQuantity} بونص مجاني بقيمة صفر)` : ''}`,
          glAccountId: debitAcc,
          documentType: 'sales_invoice',
          journalEntryId: jvResult.entry?.id,
          isTest: params.isTest,
        });
      }

      // F20: custody movements for this invoice
      custodyMovements.forEach(m => draft.custodyMovements.push(m));

      // Lines
      params.lines.forEach((l, idx) => {
        const item = itemsMap.get(l.itemId);
        const lSub = l.quantity * l.unitPrice * (1 - ((l.discount || 0) / 100));
        const lVat = lSub * (params.taxTreatment === 'exempt' ? 0 : (l.vatRate || 0));

        draft.salesInvoiceLines.push({
          id: `sinvl-${invoiceId}-${idx + 1}`,
          invoiceId,
          itemId: l.itemId,
          batchId: l.batchId,
          quantity: l.quantity,
          freeQuantity: l.freeQuantity || 0,
          unitPrice: l.unitPrice,
          unitCost: lineCosts.get(idx)?.unitCost ?? 0,
          discount: l.discount || 0,
          vatRate: params.taxTreatment === 'exempt' ? 0 : l.vatRate,
          vatAmount: lVat,
          totalBeforeVat: lSub,
          netTotal: lSub + lVat,
        });
      });

      // Audit Log
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: params.userId || 'usr-admin',
        userName: params.userName || 'مدير المبيعات',
        module: 'المبيعات',
        action: 'create',
        recordId: invoiceId,
        description: `إنشاء وترحيل فاتورة مبيعات ${invoiceNumber} بمبلغ ${totalAmount.toLocaleString('ar-EG')} ${params.currency} للعميل ${customer.name}`,
      });
    });

    return { success: true, invoice: createdInvoice, creditWarning };
  }

  /**
   * 3. Customer Payments & Manual Invoice Allocations
   */
  public static recordCustomerPayment(params: {
    customerId: string;
    amount: number;
    currency: 'EGP' | 'USD';
    exchangeRate: number;
    paymentMethod: 'cash' | 'bank' | 'cheque';
    bankAccountId?: string;
    chequeNumber?: string;
    chequeDueDate?: string;
    chequeBank?: string;
    date: string;
    reference: string;
    notes?: string;
    allocatedInvoiceIds?: string[];
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; payment?: Payment; error?: string } {
    // RBAC: recording customer receipts requires 'create' on customers (AR)
    const guard = AuthorizationService.enforce('customers', 'create', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };
    params = { ...params, userId: guard.userId, userName: guard.userName };

    const db = erpDb.getSnapshot();
    const customer = db.customers.find(c => c.id === params.customerId);
    if (!customer) return { success: false, error: 'العميل غير مسجل' };

    const paymentNumber = nextDocNumber(db as unknown as Record<string, unknown>, 'payments', 'RCPT', 5, 'paymentNumber');
    const paymentId = generateErpId('pmt');
    const amountEGP = params.amount * (params.currency === 'USD' ? params.exchangeRate : 1);

    // Double Entry:
    // Debit: Cash / Bank / Cheques Under Collection
    // Credit: Customer Receivable
    let debitAcc = 'acc-1101'; // cash
    if (params.paymentMethod === 'bank') debitAcc = 'acc-1102';
    if (params.paymentMethod === 'cheque') debitAcc = 'acc-1104';

    const creditAcc = customer.currency === 'USD' ? 'acc-1106' : 'acc-1105';

    const journalLines = [
      {
        id: '',
        journalEntryId: '',
        accountId: debitAcc,
        accountCode: debitAcc === 'acc-1101' ? '1101' : debitAcc === 'acc-1102' ? '1102' : '1104',
        accountNameAr: debitAcc === 'acc-1101' ? 'الخزينة الرئيسية' : debitAcc === 'acc-1102' ? 'البنك' : 'شيكات تحت التحصيل',
        debit: amountEGP,
        credit: 0,
        currency: params.currency,
        originalAmount: params.amount,
        exchangeRate: params.exchangeRate,
        description: `سند تحصيل ${paymentNumber} من العميل ${customer.name}`,
      },
      {
        id: '',
        journalEntryId: '',
        accountId: creditAcc,
        accountCode: customer.currency === 'USD' ? '1106' : '1105',
        accountNameAr: `العميل: ${customer.name}`,
        debit: 0,
        credit: amountEGP,
        currency: params.currency,
        originalAmount: params.amount,
        exchangeRate: params.exchangeRate,
        description: `سداد جزئي/كلي لحساب العميل ${customer.name}`,
      }
    ];

    const jvResult = AccountingEngine.postJournal({
      date: params.date,
      reference: params.reference || paymentNumber,
      description: `سند قبض نقدي/بنكي/شيك رقم ${paymentNumber} من العميل ${customer.name}`,
      sourceDocumentType: 'customer_payment',
      sourceDocumentId: paymentId,
      lines: journalLines,
    }, params.userId, params.userName);

    if (!jvResult.success) return { success: false, error: jvResult.error };

    let createdPayment: Payment | undefined;

    erpDb.mutate(draft => {
      // Update customer balance
      const cust = draft.customers.find(c => c.id === params.customerId);
      if (cust) cust.currentBalance = (cust.currentBalance || 0) - params.amount;

      // If bank payment, update bank account
      if (params.paymentMethod === 'bank' && params.bankAccountId) {
        const bank = draft.bankAccounts.find(b => b.id === params.bankAccountId);
        if (bank) bank.currentBalance += params.amount;
      }

      // If cheque payment, create Cheque record
      let chqId: string | undefined;
      if (params.paymentMethod === 'cheque' && params.chequeNumber) {
        chqId = generateErpId('chq');
        draft.cheques.push({
          id: chqId,
          chequeNumber: params.chequeNumber,
          type: 'incoming',
          partyType: 'customer',
          partyId: params.customerId,
          bankName: params.chequeBank || 'بنك العميل',
          amount: params.amount,
          currency: params.currency,
          issueDate: params.date,
          dueDate: params.chequeDueDate || params.date,
          status: 'received',
          statusDate: params.date,
          relatedTransactionId: paymentId,
          // F8: the payment journal IS the recognition of this cheque (Dr 1104 | Cr receivable
          // + customer balance already updated above) — never post it again downstream.
          receiptJournalId: jvResult.entry?.id,
        });
      }

      createdPayment = {
        id: paymentId,
        paymentNumber,
        paymentType: 'customer_receipt',
        partyId: params.customerId,
        date: params.date,
        paymentMethod: params.paymentMethod,
        bankAccountId: params.bankAccountId,
        chequeId: chqId,
        amount: params.amount,
        currency: params.currency,
        exchangeRate: params.exchangeRate,
        amountEGP,
        reference: params.reference,
        notes: params.notes,
        journalEntryId: jvResult.entry?.id,
      };

      draft.payments.push(createdPayment);

      // F29: the cash leg of a customer receipt belongs in the treasury ledger too
      // (the journal above already moved GL 1101/1102).
      if (params.paymentMethod === 'cash' && amountEGP > 0) {
        draft.treasuryTransactions.push({
          id: generateErpId('ctx'),
          receiptNumber: nextDocNumber(draft as unknown as Record<string, unknown>, 'treasuryTransactions', 'CSH', 4, 'receiptNumber'),
          type: 'cash_receipt',
          amount: amountEGP,
          partyName: customer.name,
          date: params.date,
          description: `تحصيل نقدي من العميل - سند ${paymentNumber}`,
          glAccountId: debitAcc,
          documentType: 'customer_payment',
          journalEntryId: jvResult.entry?.id,
          isTest: params.isTest,
        });
      }
      if (params.allocatedInvoiceIds) {
        params.allocatedInvoiceIds.forEach(invId => {
          draft.paymentAllocations.push({
            id: `${generateErpId('pa')}-${invId}`,
            paymentId,
            invoiceId: invId,
            invoiceType: 'sales',
            allocatedAmount: params.amount / params.allocatedInvoiceIds!.length,
          });
        });
      }

      // Audit Log
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: params.userId || 'usr-admin',
        userName: params.userName || 'محاسب الخزينة',
        module: 'الخزينة والمقبوضات',
        action: 'create',
        recordId: paymentId,
        description: `تسجيل سند تحصيل ${paymentNumber} بقيمة ${params.amount.toLocaleString('ar-EG')} ${params.currency} من ${customer.name}`,
      });
    });

    return { success: true, payment: createdPayment };
  }

  /**
   * 4. Supplier Payments
   */
  public static recordSupplierPayment(params: {
    supplierId: string;
    amount: number;
    currency: 'EGP' | 'USD';
    exchangeRate: number;
    paymentMethod: 'cash' | 'bank' | 'cheque';
    bankAccountId?: string;
    chequeNumber?: string;
    chequeDueDate?: string;
    chequeBank?: string;
    date: string;
    reference: string;
    notes?: string;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; payment?: Payment; error?: string } {
    // RBAC: supplier payments require 'create' on suppliers (AP)
    const guard = AuthorizationService.enforce('suppliers', 'create', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };
    params = { ...params, userId: guard.userId, userName: guard.userName };

    const db = erpDb.getSnapshot();
    const supplier = db.suppliers.find(s => s.id === params.supplierId);
    if (!supplier) return { success: false, error: 'المورد غير مسجل' };

    const paymentNumber = nextDocNumber(db as unknown as Record<string, unknown>, 'payments', 'VMT', 5, 'paymentNumber');
    const paymentId = generateErpId('pmt');
    const amountEGP = params.amount * (params.currency === 'USD' ? params.exchangeRate : 1);

    // Double Entry:
    // Debit: Trade Payables (Supplier)
    // Credit: Cash / Bank / Cheques Payable
    const debitAcc = 'acc-2101'; // supplier
    let creditAcc = 'acc-1101'; // cash
    if (params.paymentMethod === 'bank') creditAcc = 'acc-1102';
    if (params.paymentMethod === 'cheque') creditAcc = 'acc-2102'; // issued cheque

    const journalLines = [
      {
        id: '',
        journalEntryId: '',
        accountId: debitAcc,
        accountCode: '2101',
        accountNameAr: `المورد: ${supplier.name}`,
        debit: amountEGP,
        credit: 0,
        currency: params.currency,
        originalAmount: params.amount,
        exchangeRate: params.exchangeRate,
        description: `سداد مستحقات المورد ${supplier.name}`,
      },
      {
        id: '',
        journalEntryId: '',
        accountId: creditAcc,
        accountCode: creditAcc === 'acc-1101' ? '1101' : creditAcc === 'acc-1102' ? '1102' : '2102',
        accountNameAr: creditAcc === 'acc-1101' ? 'الخزينة الرئيسية' : creditAcc === 'acc-1102' ? 'البنك' : 'أوراق دفع (شيكات صادرة)',
        debit: 0,
        credit: amountEGP,
        currency: params.currency,
        originalAmount: params.amount,
        exchangeRate: params.exchangeRate,
        description: `سند صرف ${paymentNumber} للمورد ${supplier.name}`,
      }
    ];

    const jvResult = AccountingEngine.postJournal({
      date: params.date,
      reference: params.reference || paymentNumber,
      description: `سند صرف للمورد ${supplier.name} رقم ${paymentNumber}`,
      sourceDocumentType: 'supplier_payment',
      sourceDocumentId: paymentId,
      lines: journalLines,
    }, params.userId, params.userName);

    if (!jvResult.success) return { success: false, error: jvResult.error };

    let createdPayment: Payment | undefined;

    erpDb.mutate(draft => {
      // Update supplier balance
      const sup = draft.suppliers.find(s => s.id === params.supplierId);
      if (sup) sup.currentBalance = (sup.currentBalance || 0) - params.amount;

      // Update bank balance if bank
      if (params.paymentMethod === 'bank' && params.bankAccountId) {
        const bank = draft.bankAccounts.find(b => b.id === params.bankAccountId);
        if (bank) bank.currentBalance -= params.amount;
      }

      // Outgoing Cheque
      let chqId: string | undefined;
      if (params.paymentMethod === 'cheque' && params.chequeNumber) {
        chqId = generateErpId('chq');
        draft.cheques.push({
          id: chqId,
          chequeNumber: params.chequeNumber,
          type: 'outgoing',
          partyType: 'supplier',
          partyId: params.supplierId,
          bankName: params.chequeBank || 'بنك مصر',
          amount: params.amount,
          currency: params.currency,
          issueDate: params.date,
          dueDate: params.chequeDueDate || params.date,
          status: 'issued',
          statusDate: params.date,
          relatedTransactionId: paymentId,
          // F8: the payment journal IS the recognition of this cheque (Dr 2101 | Cr 2102
          // + supplier balance already updated above) — never post it again downstream.
          receiptJournalId: jvResult.entry?.id,
        });
      }

      createdPayment = {
        id: paymentId,
        paymentNumber,
        paymentType: 'supplier_payment',
        partyId: params.supplierId,
        date: params.date,
        paymentMethod: params.paymentMethod,
        bankAccountId: params.bankAccountId,
        chequeId: chqId,
        amount: params.amount,
        currency: params.currency,
        exchangeRate: params.exchangeRate,
        amountEGP,
        reference: params.reference,
        notes: params.notes,
        journalEntryId: jvResult.entry?.id,
      };

      draft.payments.push(createdPayment);

      // F29: cash paid to a supplier is a treasury movement (GL 1101 was debited above).
      if (params.paymentMethod === 'cash' && amountEGP > 0) {
        draft.treasuryTransactions.push({
          id: generateErpId('ctx'),
          receiptNumber: nextDocNumber(draft as unknown as Record<string, unknown>, 'treasuryTransactions', 'CSH', 4, 'receiptNumber'),
          type: 'cash_payment',
          amount: amountEGP,
          partyName: supplier.name,
          date: params.date,
          description: `سداد نقدي للمورد - سند ${paymentNumber}`,
          glAccountId: creditAcc,
          documentType: 'supplier_payment',
          journalEntryId: jvResult.entry?.id,
          isTest: params.isTest,
        });
      }

      // Audit Log
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: params.userId || 'usr-admin',
        userName: params.userName || 'محاسب الخزينة',
        module: 'المدفوعات والموردين',
        action: 'create',
        recordId: paymentId,
        description: `تسجيل سند صرف ${paymentNumber} بقيمة ${params.amount.toLocaleString('ar-EG')} ${params.currency} للمورد ${supplier.name}`,
      });
    });

    return { success: true, payment: createdPayment };
  }

  /**
   * 5. Sales Representative Loading, Returns & Custody Reconciliation
   */
  public static openRepCustody(repId: string, notes?: string): { success: boolean; custody?: RepresentativeCustody; error?: string } {
    const db = erpDb.getSnapshot();
    const rep = db.salesReps.find(r => r.id === repId);
    if (!rep) return { success: false, error: 'المندوب غير مسجل' };

    // Check if open custody already exists
    const existing = db.representativeCustodies.find(c => c.repId === repId && c.status === 'open');
    if (existing) {
      return { success: false, error: `المندوب (${rep.name}) لديه عهدة مفتوحة بالفعل برقم (${existing.custodyNumber})، يجب تسويتها أولاً` };
    }

    const custodyNumber = nextDocNumber(db as unknown as Record<string, unknown>, 'representativeCustodies', 'CUST', 4, 'custodyNumber');
    const newCustody: RepresentativeCustody = {
      id: generateErpId('cst'),
      custodyNumber,
      repId,
      status: 'open',
      openDate: new Date().toISOString().split('T')[0],
      notes,
    };

    erpDb.mutate(draft => {
      draft.representativeCustodies.push(newCustody);
    });

    return { success: true, custody: newCustody };
  }

  public static loadGoodsToRep(params: {
    custodyId: string;
    itemId: string;
    quantity: number;
    unitPrice: number;
    warehouseId: string; // e.g. wh-local
    date: string;
  }): { success: boolean; error?: string } {
    const db = erpDb.getSnapshot();
    const custody = db.representativeCustodies.find(c => c.id === params.custodyId && c.status === 'open');
    if (!custody) return { success: false, error: 'العهدة غير موجودة أو تم تسويتها' };

    const stock = InventoryEngine.getItemBalance(params.itemId, params.warehouseId);
    if (stock < params.quantity) {
      return { success: false, error: `الرصيد المتاح بالمستودع (${stock}) لا يكفي لتحميل (${params.quantity}) إلى المندوب` };
    }

    const item = db.items.find(i => i.id === params.itemId);

    // Issue from warehouse
    const moveRes = InventoryEngine.recordMovement({
      itemId: params.itemId,
      warehouseId: params.warehouseId,
      movementType: 'rep_loading',
      date: params.date,
      quantityIn: 0,
      quantityOut: params.quantity,
      unitCost: item?.standardCost ?? 0,
      documentType: 'تحميل عهدة مندوب',
      documentNumber: custody.custodyNumber,
      notes: `تحميل بضاعة لعهدة ${custody.custodyNumber}`,
    });

    if (!moveRes.success) return moveRes;

    // QA-07: loading goods to a representative moves inventory from the
    // warehouse to the CUSTODY. Without this journal the custody inventory
    // account 1107 stays at zero and the later custody sale / settlement
    // credits it into a NEGATIVE balance.
    //   Dr 1107 Representative Custody Inventory  (goods now with the rep)
    //   Cr 1109/1110 Finished Goods Warehouse        (goods left the warehouse)
    const loadCost = moveRes.actualCost || 0;
    const finishedAccId = params.warehouseId === 'wh-export'
      ? AccountingEngine.getMappedAccountId('inventory_finished_export', 'acc-1110')
      : AccountingEngine.getMappedAccountId('inventory_finished_local', 'acc-1109');
    const custodyAccId = AccountingEngine.getMappedAccountId('rep_custody', 'acc-1107');
    const finishedAccCode = params.warehouseId === 'wh-export' ? '1110' : '1109';

    if (loadCost > 0) {
      const jv = AccountingEngine.postJournal({
        date: params.date,
        reference: `CUSTODY-LOAD-${custody.custodyNumber}`,
        description: `تحميل بضاعة مندوب بعهدة ${custody.custodyNumber} - صنف ${item?.nameAr || params.itemId}`,
        sourceDocumentType: 'rep_custody_load',
        sourceDocumentId: custody.id,
        lines: [
          {
            id: '', journalEntryId: '', accountId: custodyAccId, accountCode: '1107',
            accountNameAr: 'عهد مناديب المبيعات (بضائع ونقدية)',
            debit: loadCost, credit: 0, currency: 'EGP' as const,
            originalAmount: loadCost, exchangeRate: 1, costCenterId: 'cc-sales',
            description: `بضاعة في عهدة المندوب ${custody.custodyNumber}`,
          },
          {
            id: '', journalEntryId: '', accountId: finishedAccId, accountCode: finishedAccCode,
            accountNameAr: 'مخزون الإنتاج التام',
            debit: 0, credit: loadCost, currency: 'EGP' as const,
            originalAmount: loadCost, exchangeRate: 1, costCenterId: 'cc-sales',
            description: `صرف من مستودع المنتج التام بعهدة ${custody.custodyNumber}`,
          },
        ],
      }, 'usr-admin', 'مدير المبيعات');
      if (!jv.success) return { success: false, error: jv.error || 'تعذر ترحيل قيد تحميل العهدة' };
    }

    erpDb.mutate(draft => {
      draft.custodyMovements.push({
        id: generateErpId('cstm'),
        custodyId: params.custodyId,
        itemId: params.itemId,
        movementType: 'loaded',
        quantity: params.quantity,
        unitPrice: params.unitPrice,
        date: params.date,
        referenceDoc: custody.custodyNumber,
      });
    });

    return { success: true };
  }

  public static returnGoodsFromRep(params: {
    custodyId: string;
    itemId: string;
    quantity: number;
    warehouseId: string;
    date: string;
  }): { success: boolean; error?: string } {
    const db = erpDb.getSnapshot();
    const custody = db.representativeCustodies.find(c => c.id === params.custodyId && c.status === 'open');
    if (!custody) return { success: false, error: 'العهدة غير صالحة' };

    const item = db.items.find(i => i.id === params.itemId);

    // QA-27: goods coming BACK from a custody must re-enter stock at a real
    // cost. A zero cost here would create a zero-value batch that later blocks
    // costed postings and breaks inventory valuation.
    let returnUnitCost = 0;
    const prodCost = InventoryEngine.resolveActualUnitCost(params.itemId, params.warehouseId, 0);
    if (prodCost.ok) returnUnitCost = prodCost.unitCost;
    if (!(returnUnitCost > 0) && (item && item.actualCost > 0)) returnUnitCost = item.actualCost;
    if (!(returnUnitCost > 0)) {
      return {
        success: false,
        error: `لا يمكن إرجاع بضاعة العهدة للصنف (${item ? item.nameAr : params.itemId}): لا توجد تكلفة معرَّفة. يجب ضبط تكلفة الصنف قبل الإرجاع.`,
      };
    }

    InventoryEngine.recordMovement({
      itemId: params.itemId,
      warehouseId: params.warehouseId,
      movementType: 'rep_return',
      date: params.date,
      quantityIn: params.quantity,
      quantityOut: 0,
      unitCost: returnUnitCost,
      documentType: 'مرتجع عهدة مندوب',
      documentNumber: custody.custodyNumber,
      notes: `مرتجع بضاعة من عهدة ${custody.custodyNumber}`,
    });

    erpDb.mutate(draft => {
      draft.custodyMovements.push({
        id: generateErpId('cstm'),
        custodyId: params.custodyId,
        itemId: params.itemId,
        movementType: 'returned',
        quantity: params.quantity,
        unitPrice: item?.sellingPriceRetail || 0,
        date: params.date,
        referenceDoc: custody.custodyNumber,
      });
    });

    return { success: true };
  }

  /**
   * 6. Quality Inspections & Routing to Destination Warehouses
   */
  public static recordQualityInspection(params: {
    documentType: 'purchase_receipt' | 'production_output' | 'sales_return';
    documentNumber: string;
    itemId: string;
    batchNumber: string;
    inspectedQuantity: number;
    date: string;
    inspectorName: string;
    result: 'passed' | 'rejected' | 'conditional';
    destination: 'saleable' | 'raw_materials' | 'damaged' | 'scrap' | 'recycling';
    reason?: string;
    notes?: string;
  }): { success: boolean; inspection?: QualityInspection; error?: string } {
    const db = erpDb.getSnapshot();
    const item = db.items.find(i => i.id === params.itemId);
    if (!item) return { success: false, error: 'الصنف غير معرف' };

    // Determine target warehouse based on destination chosen by quality personnel
    let targetWh = 'wh-local';
    if (params.destination === 'raw_materials' || params.destination === 'recycling') targetWh = 'wh-raw';
    if (params.destination === 'damaged') targetWh = 'wh-damaged';
    if (params.destination === 'scrap') targetWh = 'wh-scrap';
    if (params.destination === 'saleable') targetWh = 'wh-local';

    const inspId = generateErpId('qi');
    const insp: QualityInspection = {
      id: inspId,
      documentType: params.documentType,
      documentNumber: params.documentNumber,
      itemId: params.itemId,
      batchNumber: params.batchNumber,
      inspectedQuantity: params.inspectedQuantity,
      date: params.date,
      inspectorName: params.inspectorName,
      result: params.result,
      reason: params.reason,
      destination: params.destination,
      destinationWarehouseId: targetWh,
      notes: params.notes,
    };

    erpDb.mutate(draft => {
      draft.qualityInspections.push(insp);

      // Audit Log
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: 'usr-admin',
        userName: params.inspectorName,
        module: 'مراقبة الجودة',
        action: 'create',
        recordId: inspId,
        description: `فحص جودة ${params.documentNumber} للصنف ${item.nameAr}: النتيجة (${params.result}) والتوجيه إلى (${params.destination})`,
      });
    });

    return { success: true, inspection: insp };
  }

  /**
   * 7. Post a Sales Return: receive goods, route via quality, reverse revenue/VAT/receivable.
   * Reversal entry: Dr Sales Revenue (net), Dr VAT Output, Cr Customer Receivable.
   * Returned goods re-enter inventory at their ORIGINAL COGS (cost is not re-earned).
   */
  public static postSalesReturn(params: {
    customerId: string;
    invoiceId?: string;
    warehouseId?: string; // goods first land in this warehouse before inspection routing
    date: string;
    reason: string;
    lines: Array<{
      itemId: string;
      quantity: number;
      unitPrice: number; // original selling price (before VAT) to reverse
      vatRate: number;
      batchNumber?: string;
    }>;
    /** Optional per-item quality destination override (defaults to saleable restock) */
    inspectionOverrides?: Record<string, QualityInspection['destination']>;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; salesReturn?: SalesReturn; error?: string } {
    const db = erpDb.getSnapshot();
    const customer = db.customers.find(c => c.id === params.customerId);
    if (!customer) return { success: false, error: 'العميل غير مسجل بالنظام' };
    if (!params.lines || params.lines.length === 0) return { success: false, error: 'يجب إدخال أصناف المرتجع' };

    for (const l of params.lines) {
      if (!db.items.find(i => i.id === l.itemId)) return { success: false, error: 'صنف في المرتجع غير معرف بالنظام' };
      if (!db.customers.find(c => c.id === params.customerId)) return { success: false, error: 'العميل غير موجود' };
      if (Number(l.quantity) <= 0) return { success: false, error: 'كمية المرتجع يجب أن تكون أكبر من صفر' };
    }

    const channel = customer.customerType === 'export' ? 'export' : (customer.customerType === 'wholesale' ? 'wholesale' : 'retail');
    const exchangeRate = params.invoiceId ? (db.salesInvoices.find(i => i.id === params.invoiceId)?.exchangeRate || 1) : 1;

    // Financial reversal amounts (net revenue + VAT at original selling prices)
    // F5: when the return references the original invoice, inherit the ACTUAL posted
    // VAT rate of that sale (taxable stays taxable, exempt/zero-rated stays zero).
    const originalInvoiceLines = params.invoiceId
      ? db.salesInvoiceLines.filter(sl => sl.invoiceId === params.invoiceId)
      : [];
    let revenueNet = 0;
    let vatTotal = 0;
    // F17 + F22: the return inherits BOTH the tax treatment AND the zero-value
    // bonus nature of the original line. Any quantity beyond the originally
    // invoiced (paid) quantity, up to the original bonus quantity, is reversed
    // at price 0.00 and carries no VAT — a bonus can never create revenue or VAT.
    const lineEconomics = params.lines.map(l => {
      const origLine = originalInvoiceLines.find(sl => sl.itemId === l.itemId);
      const effectiveVatRate = origLine ? (origLine.vatRate || 0) : (l.vatRate || 0);
      const bonusQty = origLine
        ? Math.min(l.quantity, Number(origLine.freeQuantity) || 0)
        : Math.min(l.quantity, Number((l as { freeQuantity?: number }).freeQuantity) || 0);
      const paidQty = Math.max(0, l.quantity - bonusQty);
      const lineNet = paidQty * l.unitPrice;
      revenueNet += lineNet;
      vatTotal += lineNet * effectiveVatRate;
      return { line: l, origLine, bonusQty, paidQty, effectiveVatRate, lineNet };
    });
    const totalAmount = revenueNet + vatTotal;

    // COGS value of returned goods.
    // QA-09: the return must reverse the ECONOMIC effect of the original sale.
    // The original sales line already carries the real FIFO cost that was
    // charged to COGS, so THAT is the basis for restoring inventory. Only when
    // the return is not linked to an invoice line do we fall back to the FIFO
    // cost of the stock in the return warehouse, then to a configured standard
    // cost. If none exists the return is blocked with a clear message — a zero
    // or invented cost is never posted.
    let restockCost = 0;
    const receiptLines: Array<{ itemId: string; quantity: number; unitCost: number; routing: ReturnType<typeof qualityDestinationRouting> }> = [];
    for (const [idx, l] of params.lines.entries()) {
      const item = db.items.find(i => i.id === l.itemId);
      const routing = qualityDestinationRouting(params.inspectionOverrides?.[l.itemId] || 'saleable');
      const origLine = lineEconomics[idx]?.origLine;
      let unitCost = Number(origLine?.unitCost) || 0;
      if (unitCost <= 0) {
        const resolved = InventoryEngine.resolveActualUnitCost(l.itemId, routing.warehouseId, l.quantity);
        if (resolved.ok) unitCost = resolved.unitCost;
      }
      if (!(unitCost > 0) && ((item && item.standardCost) || 0) > 0) unitCost = item ? item.standardCost : 0;
      if (!(unitCost > 0)) {
        return {
          success: false,
          error:
            `لا يمكن ترحيل مرتجع الصنف (${(item && item.nameAr) || l.itemId}): لا توجد تكلفة مرجعية معرَّافة. ` +
            `اربط المرتجع بفاتورة البيع الأصلية لاسترجاع تكلفتها المعتمدة.`,
        };
      }
      restockCost += l.quantity * unitCost;
      receiptLines.push({ itemId: l.itemId, quantity: l.quantity, unitCost, routing });
    }

    const returnId = generateErpId('sret');
    const returnNumber = nextDocNumber(erpDb.getSnapshot() as unknown as Record<string, unknown>, 'salesReturns', 'SRET', 5, 'returnNumber');

    // Reversal journal: Dr Revenue (net) + Dr VAT Output | Cr Receivable
    const revAcc = AccountingEngine.getMappedAccountId(
      channel === 'export' ? 'sales_export_revenue' : channel === 'wholesale' ? 'sales_wholesale_revenue' : 'sales_retail_revenue',
      channel === 'export' ? 'acc-4103' : channel === 'wholesale' ? 'acc-4102' : 'acc-4101'
    );
    const vatAcc = AccountingEngine.getMappedAccountId('sales_vat_output', 'acc-2103');
    const recvAcc = AccountingEngine.getMappedAccountId(
      channel === 'export' ? 'customer_receivable_export' : 'customer_receivable_local',
      channel === 'export' ? 'acc-1106' : 'acc-1105'
    );

    const revLines: JLine[] = [
      ...(revenueNet > 0 ? [jl(revAcc, revenueNet, 0, revenueNet, exchangeRate, 'EGP', `مرتجع مبيعات ${returnNumber} - إلغاء إيراد`)] : []),
      ...(vatTotal > 0 ? [jl(vatAcc, vatTotal, 0, vatTotal, exchangeRate, 'EGP', `مرتجع مبيعات ${returnNumber} - عكس ضريبة مخرجات`)] : []),
      ...(totalAmount > 0 ? [jl(recvAcc, 0, totalAmount, totalAmount, exchangeRate, 'EGP', `مرتجع مبيعات ${returnNumber} - تخفيض مديونية العميل ${customer.name}`)] : []),
    ];

    // F17: returning a purely bonus (zero-value) line has NO revenue and NO VAT
    // to reverse — an empty journal is never posted (it would be unbalanced).
    let revJvId: string | undefined;
    if (revLines.length >= 2) {
      const revJv = AccountingEngine.postJournal({
        date: params.date,
        reference: returnNumber,
        description: `مرتجع مبيعات رقم ${returnNumber} للعميل ${customer.name} - السبب: ${params.reason}`,
        sourceDocumentType: 'sales_return',
        sourceDocumentId: returnId,
        lines: revLines,
      }, params.userId, params.userName, params.isTest);
      if (!revJv.success) return { success: false, error: revJv.error };
      revJvId = revJv.entry?.id;
    }

    // COGS reversal: Dr Inventory | Cr COGS (restores inventory value).
    // QA-21: the debit must go to the account that matches where the returned
    // goods actually landed. Goods routed to WH-04 (damaged) or WH-05 (scrap)
    // must NOT be added back to the saleable finished-goods account.
    const cogsAcc = AccountingEngine.getMappedAccountId(channel === 'export' ? 'cogs_export' : 'cogs_local', channel === 'export' ? 'acc-5102' : 'acc-5101');
    const inventoryAccountForRouting = (routingWarehouseId: string): { id: string; code: string } => {
      if (routingWarehouseId === 'wh-damaged') return { id: AccountingEngine.getMappedAccountId('inventory_damaged', 'acc-1111'), code: '1111' };
      if (routingWarehouseId === 'wh-scrap') return { id: AccountingEngine.getMappedAccountId('inventory_scrap', 'acc-1112'), code: '1112' };
      if (routingWarehouseId === 'wh-raw') return { id: AccountingEngine.getMappedAccountId('purchase_raw_inventory', 'acc-1108'), code: '1108' };
      return {
        id: AccountingEngine.getMappedAccountId(channel === 'export' ? 'inventory_finished_export' : 'inventory_finished_local', channel === 'export' ? 'acc-1110' : 'acc-1109'),
        code: channel === 'export' ? '1110' : '1109',
      };
    };
    const cogsLines: JLine[] = [];
    receiptLines.forEach((r, idx) => {
      const amt = r.quantity * r.unitCost;
      if (!(amt > 0)) return;
      const acc = inventoryAccountForRouting(r.routing.warehouseId);
      cogsLines.push(
        jl(acc.id, amt, 0, amt, 1, 'EGP', `مرتجع مبيعات ${returnNumber} - إعادة تقييم مخزون مرتجع إلى ${acc.code} (${r.routing.label})`),
        jl(cogsAcc, 0, amt, amt, 1, 'EGP', `مرتجع مبيعات ${returnNumber} - عكس تكلفة البضاعة المباعة`),
      );
    });
    const cogsJv = AccountingEngine.postJournal({
      date: params.date,
      reference: returnNumber,
      description: `مرتجع مبيعات ${returnNumber} - إعادة تكلفة البضاعة المرتجعة للمخزون`,
      sourceDocumentType: 'sales_return_cogs',
      sourceDocumentId: returnId,
      lines: cogsLines,
    }, params.userId, params.userName, params.isTest);
    if (!cogsJv.success) return { success: false, error: cogsJv.error };

    // Receive returned goods into their quality-routed warehouses at restored cost
    for (const r of receiptLines) {
      const mv = InventoryEngine.recordMovement({
        itemId: r.itemId,
        warehouseId: r.routing.warehouseId,
        movementType: 'sales_return',
        date: params.date,
        quantityIn: r.quantity,
        quantityOut: 0,
        unitCost: r.unitCost,
        documentType: 'مرتجع مبيعات',
        documentNumber: returnNumber,
        batchNumber: params.lines.find(l => l.itemId === r.itemId)?.batchNumber || undefined,
        notes: `مرتجع من ${customer.name} - توجيه: ${r.routing.label}`,
        isTest: params.isTest,
      });
      if (!mv.success) return { success: false, error: `فشل استلام مرتجع المبيعات: ${mv.error}` };
    }

    let created: SalesReturn | undefined;
    erpDb.mutate(draft => {
      created = {
        id: returnId,
        returnNumber,
        invoiceId: params.invoiceId,
        customerId: params.customerId,
        date: params.date,
        reason: params.reason,
        totalAmount,
        totalVat: vatTotal,
        status: 'posted',
        journalEntryId: revJvId || cogsJv.entry?.id,
        isTest: params.isTest,
      };
      draft.salesReturns.push(created);

      params.lines.forEach((l, idx) => {
        const routing = receiptLines[idx].routing;
        const econ = lineEconomics[idx];
        draft.salesReturnLines.push({
          id: `sretl-${returnId}-${idx + 1}`,
          returnId,
          itemId: l.itemId,
          quantity: l.quantity,
          // F17: a returned bonus piece stays at zero value.
          unitPrice: econ.bonusQty >= l.quantity ? 0 : l.unitPrice,
          batchNumber: l.batchNumber || '',
          freeQuantity: econ.bonusQty,
          vatRate: econ.effectiveVatRate,
          qualityDestination: (params.inspectionOverrides?.[l.itemId] as SalesReturnLine['qualityDestination']) || 'saleable',
          destinationWarehouseId: routing.warehouseId,
        });
      });

      // Reduce customer balance (they owe less)
      const cust = draft.customers.find(c => c.id === params.customerId);
      if (cust) cust.currentBalance = (cust.currentBalance || 0) - totalAmount;

      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: params.userId || 'usr-admin',
        userName: params.userName || 'مدير المبيعات',
        module: 'المبيعات - المرتجعات',
        action: 'post',
        recordId: returnId,
        description: `ترحيل مرتجع مبيعات ${returnNumber} بمبلغ ${totalAmount.toLocaleString('ar-EG')} ج.م للعميل ${customer.name}، التكلفة المعادة للمخزون ${restockCost.toLocaleString('ar-EG')} ج.م`,
      });
    });

    return { success: true, salesReturn: created };
  }

  /**
   * 8. Post a Purchase Return: issue goods back to supplier at their receipt cost,
   * reduce supplier payable, reverse inventory value and input VAT.
   */
  public static postPurchaseReturn(params: {
    supplierId: string;
    purchaseInvoiceId?: string;
    warehouseId: string;
    date: string;
    reason: string;
    lines: Array<{ itemId: string; quantity: number; batchNumber?: string }>;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; purchaseReturn?: PurchaseReturn; error?: string } {
    const db = erpDb.getSnapshot();
    const supplier = db.suppliers.find(s => s.id === params.supplierId);
    if (!supplier) return { success: false, error: 'المورد غير مسجل بالنظام' };
    if (!params.lines || params.lines.length === 0) return { success: false, error: 'يجب إدخال أصناف المرتجع' };

    const returnId = generateErpId('pret');
    const returnNumber = nextDocNumber(erpDb.getSnapshot() as unknown as Record<string, unknown>, 'purchaseReturns', 'PRET', 5, 'returnNumber');

    // Determine actual cost per line from the original purchase invoice when available,
    // otherwise from the current batch cost in the warehouse.
    const sourceInvoice = params.purchaseInvoiceId ? db.purchaseInvoices.find(i => i.id === params.purchaseInvoiceId) : undefined;
    const costLines: Array<{ itemId: string; quantity: number; unitCost: number; batchNumber?: string; vatRate: number }> = [];

    for (const l of params.lines) {
      const item = db.items.find(i => i.id === l.itemId);
      if (!item) return { success: false, error: 'صنف في مرتجع المشتريات غير معرف بالنظام' };
      if (Number(l.quantity) <= 0) return { success: false, error: `كمية المرتجع يجب أن تكون أكبر من صفر (${item.nameAr})` };

      let unitCost = 0;
      let vatRate = 0;
      if (sourceInvoice) {
        const invLine = db.purchaseInvoiceLines.find(pl => pl.purchaseInvoiceId === sourceInvoice.id && pl.itemId === l.itemId);
        if (invLine) {
          unitCost = invLine.unitPrice;
          vatRate = invLine.vatRate || 0;
        }
      }
      if (unitCost === 0) {
        const est = InventoryEngine.estimateIssueCost(l.itemId, params.warehouseId, l.quantity, l.batchNumber);
        unitCost = est.actualUnitCost || item.standardCost || 0;
      }
      costLines.push({ itemId: l.itemId, quantity: l.quantity, unitCost, batchNumber: l.batchNumber, vatRate });
    }

    const invSubtotal = costLines.reduce((s, l) => s + l.quantity * l.unitCost, 0);
    const invVat = costLines.reduce((s, l) => s + l.quantity * l.unitCost * l.vatRate, 0);
    const totalAmount = invSubtotal + invVat;

    // Issue goods from warehouse first (validates stock, computes actual FIFO cost)
    const issueResults: Array<ReturnType<typeof InventoryEngine.recordMovement>> = [];
    for (const l of costLines) {
      const mv = InventoryEngine.recordMovement({
        itemId: l.itemId,
        warehouseId: params.warehouseId,
        movementType: 'purchase_return',
        date: params.date,
        quantityIn: 0,
        quantityOut: l.quantity,
        unitCost: 0,
        documentType: 'مرتجع مشتريات',
        documentNumber: returnNumber,
        batchNumber: l.batchNumber,
        notes: `إرجاع للمورد ${supplier.name} - السبب: ${params.reason}`,
        isTest: params.isTest,
      });
      if (!mv.success) return { success: false, error: `فشل صرف مرتجع المشتريات: ${mv.error}` };
      issueResults.push(mv);
    }

    // Journal: Dr Supplier Payable (subtotal + VAT) | Cr Inventory (actual issued cost) + Cr VAT Input
    const supAcc = AccountingEngine.getMappedAccountId('supplier_payable', 'acc-2101');
    const rawAcc = AccountingEngine.getMappedAccountId('purchase_raw_inventory', 'acc-1108');
    const vatInAcc = AccountingEngine.getMappedAccountId('purchase_vat_input', 'acc-1113');

    const actualIssuedCost = issueResults.reduce((s, r) => s + (r.actualCost || 0), 0);
    const lines: JLine[] = [
      jl(supAcc, totalAmount, 0, totalAmount, 1, 'EGP', `مرتجع مشتريات ${returnNumber} - تخفيض مستحقات المورد ${supplier.name}`),
      jl(rawAcc, 0, actualIssuedCost, actualIssuedCost, 1, 'EGP', `مرتجع مشتريات ${returnNumber} - صرف مخزون بالتكلفة الفعلية`),
      ...(invVat > 0 ? [jl(vatInAcc, 0, invVat, invVat, 1, 'EGP', `مرتجع مشتريات ${returnNumber} - عكس ضريبة مدخلات`)] : []),
    ];

    // Balance any rounding difference into inventory credit side (never post unbalanced)
    const dr = lines.reduce((s, l) => s + l.debit, 0);
    const cr = lines.reduce((s, l) => s + l.credit, 0);
    const diff = Number((dr - cr).toFixed(2));
    if (Math.abs(diff) >= 0.01) {
      if (diff > 0) lines[1].credit += diff; else lines[0].debit -= diff;
    }

    const jv = AccountingEngine.postJournal({
      date: params.date,
      reference: returnNumber,
      description: `مرتجع مشتريات رقم ${returnNumber} للمورد ${supplier.name}`,
      sourceDocumentType: 'purchase_return',
      sourceDocumentId: returnId,
      lines,
    }, params.userId, params.userName, params.isTest);
    if (!jv.success) return { success: false, error: jv.error };

    let created: PurchaseReturn | undefined;
    erpDb.mutate(draft => {
      created = {
        id: returnId,
        returnNumber,
        purchaseInvoiceId: params.purchaseInvoiceId,
        supplierId: params.supplierId,
        warehouseId: params.warehouseId,
        date: params.date,
        reason: params.reason,
        totalAmount: invSubtotal,
        totalVat: invVat,
        status: 'posted',
        journalEntryId: jv.entry?.id,
        isTest: params.isTest,
      };
      draft.purchaseReturns.push(created);

      // Reduce supplier balance
      const sup = draft.suppliers.find(s => s.id === params.supplierId);
      if (sup) sup.currentBalance = (sup.currentBalance || 0) - totalAmount;

      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: params.userId || 'usr-admin',
        userName: params.userName || 'مدير المشتريات',
        module: 'المشتريات - المرتجعات',
        action: 'post',
        recordId: returnId,
        description: `ترحيل مرتجع مشتريات ${returnNumber} بمبلغ ${totalAmount.toLocaleString('ar-EG')} ج.م للمورد ${supplier.name}`,
      });
    });

    return { success: true, purchaseReturn: created };
  }

  /**
   * 9. Approve & post a physical inventory count: stock adjustments + balanced journal.
   * Overage: Dr Inventory | Cr Inventory Adjustment Gain (mapped variance account).
   * Shortage: Dr Inventory Adjustment Loss (mapped variance) | Cr Inventory.
   */
  public static postInventoryCount(params: {
    warehouseId: string;
    date: string;
    lines: Array<{ itemId: string; systemQuantity: number; physicalQuantity: number; unitCost?: number; batchNumber?: string }>;
    approvedBy?: string;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; count?: InventoryCount; error?: string } {
    const db = erpDb.getSnapshot();
    const warehouse = db.warehouses.find(w => w.id === params.warehouseId);
    if (!warehouse) return { success: false, error: 'المستودع غير موجود' };
    if (!params.lines || params.lines.length === 0) return { success: false, error: 'لا توجد بنود جرد' };

    const countId = generateErpId('cnt');
    const countNumber = nextDocNumber(erpDb.getSnapshot() as unknown as Record<string, unknown>, 'inventoryCounts', 'STK-CNT', 4, 'countNumber');

    const varianceAccId = AccountingEngine.getMappedAccountId('variance_material_quantity', 'acc-5104');

    const jvLines: JLine[] = [];
    const countLineRecords: InventoryCountLine[] = [];
    let hasVariance = false;

    // Pre-compute lines & validate, then execute movement + journal atomically per variance line
    const movementsToExecute: Array<{ itemId: string; qty: number; unitCost: number; direction: 'in' | 'out' }> = [];

    for (const l of params.lines) {
      const item = db.items.find(i => i.id === l.itemId);
      if (!item) return { success: false, error: `صنف الجرد غير معرف (${l.itemId})` };
      const varianceQty = l.physicalQuantity - l.systemQuantity;
      if (varianceQty === 0) continue;
      hasVariance = true;

      // QA-22: the count variance must be valued at the REAL cost of the stock in
      // the counted warehouse (FIFO), then a configured standard cost. The old
      // UI passed a hard-coded 50/unit which mis-stated every shrinkage.
      // A variance with no resolvable cost is refused, never booked at zero.
      const resolved = InventoryEngine.resolveActualUnitCost(l.itemId, params.warehouseId, Math.max(1, Math.abs(varianceQty)));
      let unitCost = 0;
      if (resolved.ok) {
        unitCost = resolved.unitCost;
      } else if (l.unitCost !== undefined && l.unitCost > 0) {
        unitCost = l.unitCost;
      } else if (item.standardCost > 0) {
        unitCost = item.standardCost;
      }
      if (!(unitCost > 0)) {
        return {
          success: false,
          error: `لا يمكن ترحيل جرد الصنف (${item.nameAr}) في ${warehouse.nameAr}: لا توجد تكلفة معرَّفة لتسوية الفروق. يجب ضبط تكلفة الصنف الفعلية أولاً.`,
        };
      }
      const varianceCost = varianceQty * unitCost;

      countLineRecords.push({
        id: `cntl-${countId}-${l.itemId}`,
        countId,
        itemId: l.itemId,
        batchNumber: l.batchNumber,
        systemQuantity: l.systemQuantity,
        physicalQuantity: l.physicalQuantity,
        varianceQuantity: varianceQty,
        unitCost,
        varianceCost,
      });

      movementsToExecute.push({
        itemId: l.itemId,
        qty: Math.abs(varianceQty),
        unitCost,
        direction: varianceQty > 0 ? 'in' : 'out',
      });

      // Journal line per variance (overage = credit variance, shortage = debit variance)
      jvLines.push(
        varianceQty > 0
          ? jl(varianceAccId, 0, Math.abs(varianceCost), Math.abs(varianceCost), 1, 'EGP', `جرد ${countNumber} - فائض ${item.nameAr}`, 'cc-admin')
          : jl(varianceAccId, Math.abs(varianceCost), 0, Math.abs(varianceCost), 1, 'EGP', `جرد ${countNumber} - عجز ${item.nameAr}`, 'cc-admin')
      );
    }

    if (!hasVariance) {
      // Record the count with no variance; no journal needed
      let createdNoVar: InventoryCount | undefined;
      erpDb.mutate(draft => {
        createdNoVar = {
          id: countId,
          countNumber,
          date: params.date,
          warehouseId: params.warehouseId,
          status: 'posted',
          approvedBy: params.approvedBy,
          isTest: params.isTest,
        };
        draft.inventoryCounts.push(createdNoVar);
      });
      return { success: true, count: createdNoVar };
    }

    // Aggregate variance journal: group total overage/shortage against inventory account of that warehouse type
    const drTotal = jvLines.filter(l => l.debit > 0).reduce((s, l) => s + l.debit, 0);
    const crTotal = jvLines.filter(l => l.credit > 0).reduce((s, l) => s + l.credit, 0);
    const netShortage = drTotal - crTotal; // >0 means net shortage (inventory decreased)

    // Inventory account mapping by warehouse type
    const invAccId = warehouse.type === 'raw_materials'
      ? AccountingEngine.getMappedAccountId('purchase_raw_inventory', 'acc-1108')
      : warehouse.type === 'damaged'
        ? AccountingEngine.getMappedAccountId('inventory_damaged', 'acc-1111')
        : warehouse.type === 'scrap'
          ? AccountingEngine.getMappedAccountId('inventory_scrap', 'acc-1112')
          : warehouse.type === 'export_finished'
            ? AccountingEngine.getMappedAccountId('inventory_finished_export', 'acc-1110')
            : AccountingEngine.getMappedAccountId('inventory_finished_local', 'acc-1109');

    const netAbs = Math.abs(netShortage);
    const finalLines: JLine[] = [
      netShortage > 0
        ? jl(varianceAccId, netAbs, 0, netAbs, 1, 'EGP', `جرد ${countNumber} - عجز صافي`, 'cc-admin')
        : jl(varianceAccId, 0, netAbs, netAbs, 1, 'EGP', `جرد ${countNumber} - فائض صافي`, 'cc-admin'),
      netShortage > 0
        ? jl(invAccId, 0, netAbs, netAbs, 1, 'EGP', `جرد ${countNumber} - تخفيض مخزون بالمستودع ${warehouse.nameAr}`)
        : jl(invAccId, netAbs, 0, netAbs, 1, 'EGP', `جرد ${countNumber} - زيادة مخزون بالمستودع ${warehouse.nameAr}`),
    ];

    // Execute stock movements FIRST (they validate stock), then journal; if journal fails, revert not needed
    // because movements already validated; but for safety, post journal before movement mutate is impossible
    // (engine is atomic per movement). We post journal first: if it fails, nothing changed.
    const jv = AccountingEngine.postJournal({
      date: params.date,
      reference: countNumber,
      description: `تسوية جرد فعلي بمستودع ${warehouse.nameAr}`,
      sourceDocumentType: 'inventory_count',
      sourceDocumentId: countId,
      lines: finalLines,
    }, params.userId, params.userName, params.isTest);
    if (!jv.success) return { success: false, error: jv.error };

    for (const m of movementsToExecute) {
      const mv = InventoryEngine.recordMovement({
        itemId: m.itemId,
        warehouseId: params.warehouseId,
        movementType: 'inventory_adjustment',
        date: params.date,
        quantityIn: m.direction === 'in' ? m.qty : 0,
        quantityOut: m.direction === 'out' ? m.qty : 0,
        unitCost: m.unitCost,
        documentType: 'تسوية جرد فعلي',
        documentNumber: countNumber,
        batchNumber: m.direction === 'in' ? undefined : undefined,
        notes: `جرد فعلي - فرق ${m.direction === 'in' ? '+' : '-'}${m.qty}`,
        isTest: params.isTest,
      });
      if (!mv.success) return { success: false, error: `فشل تعديل المخزون بعد ترحيل الجرد: ${mv.error}` };
    }

    let created: InventoryCount | undefined;
    erpDb.mutate(draft => {
      created = {
        id: countId,
        countNumber,
        date: params.date,
        warehouseId: params.warehouseId,
        status: 'posted',
        approvedBy: params.approvedBy,
        journalEntryId: jv.entry?.id,
        isTest: params.isTest,
      };
      draft.inventoryCounts.push(created);
      countLineRecords.forEach(cl => draft.inventoryCountLines.push(cl));

      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: params.userId || 'usr-admin',
        userName: params.userName || 'مدير المخازن',
        module: 'المخزون - الجرد',
        action: 'post',
        recordId: countId,
        description: `ترحيل جرد فعلي ${countNumber} بمستودع ${warehouse.nameAr} مع تسوية فروق بقيمة ${netAbs.toLocaleString('ar-EG')} ج.م`,
      });
    });

    return { success: true, count: created };
  }

  /**
   * 10. Register an export shipment with full profitability from actual values + FX accounting.
   * Creates the shipment record and posts product cost + export expenses to the GL.
   */
  public static createExportShipment(params: {
    customerId: string;
    shipmentDate: string;
    portOfOrigin: string;
    destinationPort: string;
    containerNumber?: string;
    usdRevenue: number;
    exchangeRate: number;
    /** F26: optional — when a linked invoice exists the real COGS is derived from it. */
    productCost?: number;
    shippingCost: number;
    portCosts: number;
    customsCost: number;
    otherExportCosts: number;
    /** Link to the export sales invoice (F12). When provided, revenue/FX/cost are
     *  derived from the real invoice — revenue/COGS/stock are posted ONLY by the invoice. */
    salesInvoiceId?: string;
    notes?: string;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; shipment?: ExportShipment; error?: string } {
    // RBAC: creating export shipments requires 'create' on export
    const guard = AuthorizationService.enforce('export', 'create', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };

    const db = erpDb.getSnapshot();
    const customer = db.customers.find(c => c.id === params.customerId);
    if (!customer) return { success: false, error: 'عميل التصدير غير مسجل بالنظام' };

    // F12: link to the real export sales invoice when requested.
    // Revenue (4103), receivable (1106), COGS (5102) and WH-03 stock are posted by
    // createSalesInvoice(channel='export') — the shipment NEVER re-posts them.
    let usdRevenue = Number(params.usdRevenue);
    let exchangeRate = Number(params.exchangeRate);
    let productCost = Number(params.productCost) || 0;
    let productCostDerived = false;
    let linkedInvoice: SalesInvoice | undefined;
    if (params.salesInvoiceId) {
      const inv = db.salesInvoices.find(i => i.id === params.salesInvoiceId);
      if (!inv) return { success: false, error: 'فاتورة التصدير المرتبطة غير موجودة' };
      if (inv.channel !== 'export') return { success: false, error: 'يمكن ربط الشحنة بفاتورة بيع قناة التصدير فقط' };
      if (inv.currency !== 'USD') return { success: false, error: 'فاتورة التصدير يجب أن تكون بالدولار USD' };
      if (inv.customerId !== params.customerId) return { success: false, error: 'عميل الشحنة لا يطابق عميل الفاتورة المرتبطة' };
      if (inv.exportShipmentId && inv.exportShipmentId !== undefined) {
        // already linked to a (different) shipment
        const existing = db.exportShipments.find(s => s.id === inv.exportShipmentId);
        if (existing) return { success: false, error: `الفاتورة ${inv.invoiceNumber} مرتبطة بالفعل بالشحنة ${existing.shipmentNumber}` };
      }
      if (db.exportShipments.some(s => s.salesInvoiceId === inv.id)) {
        return { success: false, error: `الفاتورة ${inv.invoiceNumber} مرتبطة بالفعل بشحنة أخرى` };
      }
      if (!inv.journalEntryId) return { success: false, error: 'فاتورة التصدير يجب أن تكون مرحلة بالدفاتر قبل ربطها بشحنة' };
      linkedInvoice = inv;
      // Derive the shipment's commercial figures from the actual invoice (F12.4).
      usdRevenue = inv.subtotal;
      exchangeRate = inv.exchangeRate;
      // F26: finished-goods cost is AUTO-DERIVED from the linked invoice's lines
      // (quantity + free quantity x the line unit cost = the COGS the invoice posted).
      // The user is never asked to re-enter a cost the system already knows.
      const linesOfInvoice = db.salesInvoiceLines.filter(l => l.invoiceId === inv.id);
      const derivedFromLines = linesOfInvoice.reduce(
        (s, l) => s + ((l.quantity + (l.freeQuantity || 0)) * (l.unitCost || 0)),
        0
      );
      // The line unit cost is the EGP inventory/FIFO cost — the same value the
      // invoice booked as COGS. Converting it by the invoice exchange rate a
      // second time inflated the shipment cost (10 x 70 EGP became 35,000).
      productCost = derivedFromLines > 0 ? derivedFromLines : inv.cogsTotal;
      productCostDerived = true;
    }

    if (!productCostDerived && !(productCost > 0)) {
      return { success: false, error: 'تكلفة المنتج غير محددة — اربط الشحنة بفاتورة التصدير ليتم اشتقاق التكلفة تلقائيًا من تكلفة المبيعات الفعلية' };
    }

    if (exchangeRate <= 0) return { success: false, error: 'سعر الصرف يجب أن يكون أكبر من صفر' };
    if (usdRevenue <= 0) return { success: false, error: 'إيراد التصدير بالدولار يجب أن يكون أكبر من صفر' };

    const shipmentId = generateErpId('shp');
    const shipmentNumber = nextDocNumber(erpDb.getSnapshot() as unknown as Record<string, unknown>, 'exportShipments', 'EXP-SHP', 3, 'shipmentNumber');

    const egpValue = usdRevenue * exchangeRate;
    const totalCosts = productCost + params.shippingCost + params.portCosts + params.customsCost + params.otherExportCosts;
    const netProfitEGP = egpValue - totalCosts;
    const profitMarginPercent = egpValue > 0 ? (netProfitEGP / egpValue) * 100 : 0;

    // Logistics cost journal: Dr Export Costs 6104 | Cr Accrued Expenses 2104.
    // (F12.1: NEVER credits 6101 Salaries & Wages — fixed mapping key export_costs_payable.)
    let jvId: string | undefined;
    const costTotal = params.shippingCost + params.portCosts + params.customsCost + params.otherExportCosts;
    if (costTotal > 0) {
      const exportCostAcc = AccountingEngine.getMappedAccountId('export_costs', 'acc-6104');
      const accruedAcc = AccountingEngine.getMappedAccountId('export_costs_payable', 'acc-2104');
      const jv = AccountingEngine.postJournal({
        date: params.shipmentDate,
        reference: shipmentNumber,
        description: `تكاليف شحنة تصدير ${shipmentNumber} إلى ${params.destinationPort}`,
        sourceDocumentType: 'export_shipment_costs',
        sourceDocumentId: shipmentId,
        lines: [
          jl(exportCostAcc, costTotal, 0, costTotal, 1, 'EGP', `تكاليف شحن ونولون وتخليص شحنة ${shipmentNumber}`, 'cc-export'),
          jl(accruedAcc, 0, costTotal, costTotal, 1, 'EGP', `استحقاق تكاليف شحنة تصدير ${shipmentNumber}`, 'cc-export'),
        ],
      }, guard.userId, guard.userName, params.isTest);
      if (!jv.success) return { success: false, error: jv.error };
      jvId = jv.entry?.id;
    }

    let created: ExportShipment | undefined;
    erpDb.mutate(draft => {
      created = {
        id: shipmentId,
        shipmentNumber,
        customerId: params.customerId,
        shipmentDate: params.shipmentDate,
        portOfOrigin: params.portOfOrigin,
        destinationPort: params.destinationPort,
        containerNumber: params.containerNumber,
        usdRevenue,
        exchangeRate,
        egpValue,
        productCost,
        shippingCost: params.shippingCost,
        portCosts: params.portCosts,
        customsCost: params.customsCost,
        otherExportCosts: params.otherExportCosts,
        totalCosts,
        netProfitEGP,
        profitMarginPercent,
        collectionStatus: 'pending',
        collectedUsd: 0,
        status: 'shipped',
        salesInvoiceId: params.salesInvoiceId,
        notes: params.notes,
        isTest: params.isTest,
      };
      draft.exportShipments.push(created);

      // Back-link on the invoice (SalesInvoice.exportShipmentId — additive field).
      if (linkedInvoice) {
        const inv = draft.salesInvoices.find(i => i.id === linkedInvoice!.id);
        if (inv) inv.exportShipmentId = shipmentId;
      }

      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId,
        userName: guard.userName,
        module: 'التصدير',
        action: 'create',
        recordId: shipmentId,
        description: `تسجيل شحنة تصدير ${shipmentNumber}${linkedInvoice ? ` مرتبطة بالفاتورة ${linkedInvoice.invoiceNumber}` : ''}: إيراد ${usdRevenue.toLocaleString('en-US')}$ بسعر صرف ${exchangeRate}، صافي ربح ${netProfitEGP.toLocaleString('ar-EG')} ج.م (هامش ${profitMarginPercent.toFixed(1)}%)`,
      });
    });

    return { success: true, shipment: created };
  }

  /**
   * 11. Record export collection (USD receipt) with FX gain/loss vs the shipment's own rate.
   * The shipment's historical exchange rate is NEVER overwritten.
   */
  public static recordExportCollection(params: {
    shipmentId: string;
    amountUsd: number;
    actualExchangeRate: number;
    bankAccountId?: string; // defaults to USD bank (bank-2)
    date: string;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; error?: string } {
    // RBAC: recording export collections requires 'create' on export
    const guard = AuthorizationService.enforce('export', 'create', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };

    const db = erpDb.getSnapshot();
    const shipment = db.exportShipments.find(s => s.id === params.shipmentId);
    if (!shipment) return { success: false, error: 'شحنة التصدير غير موجودة' };
    if (params.amountUsd <= 0) return { success: false, error: 'مبلغ التحصيل يجب أن يكون أكبر من صفر' };
    if (params.actualExchangeRate <= 0) return { success: false, error: 'سعر الصرف الفعلي يجب أن يكون أكبر من صفر' };

    const remainingUsd = shipment.usdRevenue - shipment.collectedUsd;
    if (params.amountUsd > remainingUsd + 0.0001) {
      return { success: false, error: `مبلغ التحصيل (${params.amountUsd}$) يتجاوز المتبقي على الشحنة (${remainingUsd}$)` };
    }

    const collectedEGP = params.amountUsd * params.actualExchangeRate;
    const bookedEGP = params.amountUsd * shipment.exchangeRate; // at the shipment's own historical rate
    const fxDifference = collectedEGP - bookedEGP; // positive = gain, negative = loss

    const bank = params.bankAccountId
      ? db.bankAccounts.find(b => b.id === params.bankAccountId)
      : db.bankAccounts.find(b => b.currency === 'USD');
    if (!bank) return { success: false, error: 'لا يوجد حساب بنكي بالدولار مسجل' };

    const bankAcc = bank.glAccountId;
    const recvAcc = AccountingEngine.getMappedAccountId('customer_receivable_export', 'acc-1106');

    const lines: JLine[] = [
      jl(bankAcc, collectedEGP, 0, collectedEGP, params.actualExchangeRate, 'EGP', `تحصيل شحنة ${shipment.shipmentNumber} بمبلغ ${params.amountUsd}$ بسعر ${params.actualExchangeRate}`),
      jl(recvAcc, 0, bookedEGP, bookedEGP, shipment.exchangeRate, 'EGP', `تسوية مديونية عميل التصدير بسعر الشحنة التاريخي (${shipment.exchangeRate})`),
    ];

    if (Math.abs(fxDifference) > 0.01) {
      const fxAcc = AccountingEngine.getMappedAccountId(fxDifference > 0 ? 'fx_gain' : 'fx_loss', fxDifference > 0 ? 'acc-4105' : 'acc-7101');
      lines.push(
        fxDifference > 0
          ? jl(fxAcc, 0, fxDifference, fxDifference, params.actualExchangeRate, 'EGP', `أرباح فروق صرف تحصيل ${shipment.shipmentNumber}`)
          : jl(fxAcc, Math.abs(fxDifference), 0, Math.abs(fxDifference), params.actualExchangeRate, 'EGP', `خسائر فروق صرف تحصيل ${shipment.shipmentNumber}`)
      );
    }

    const jv = AccountingEngine.postJournal({
      date: params.date,
      reference: `EXP-COL-${shipment.shipmentNumber}`,
      description: `تحصيل شحنة تصدير ${shipment.shipmentNumber} - فروق صرف ${fxDifference >= 0 ? 'ربح' : 'خسارة'} ${Math.abs(fxDifference).toFixed(2)} ج.م`,
      sourceDocumentType: 'export_collection',
      sourceDocumentId: shipment.id,
      lines,
    }, guard.userId, guard.userName, params.isTest);
    if (!jv.success) return { success: false, error: jv.error };

    erpDb.mutate(draft => {
      const shp = draft.exportShipments.find(s => s.id === params.shipmentId);
      if (shp) {
        shp.collectedUsd += params.amountUsd;
        shp.collectionStatus = shp.collectedUsd >= shp.usdRevenue - 0.0001
          ? 'collected'
          : (shp.collectedUsd > 0 ? 'partially_collected' : 'pending');
      }

      const bankAcct = draft.bankAccounts.find(b => b.id === bank.id);
      if (bankAcct) bankAcct.currentBalance += params.amountUsd; // USD balance

      // F12.6: the collection credits export receivable 1106 (booked at the shipment's
      // historical rate) — the export customer's denormalized balance must fall by the
      // same economic amount it accrued, keeping the card synchronized with the GL.
      const cust = draft.customers.find(c => c.id === shipment.customerId);
      if (cust) {
        cust.currentBalance = (cust.currentBalance || 0) - (cust.currency === 'USD' ? params.amountUsd : bookedEGP);
      }

      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId,
        userName: guard.userName,
        module: 'التصدير - التحصيلات',
        action: 'post',
        recordId: shipment.id,
        description: `تحصيل ${params.amountUsd}$ من شحنة ${shipment.shipmentNumber} بسعر ${params.actualExchangeRate} - فرق صرف ${fxDifference >= 0 ? 'ربح' : 'خسارة'} ${Math.abs(fxDifference).toFixed(2)} ج.م`,
      });
    });

    return { success: true };
  }

  /**
   * 12. Treasury cash transaction with GL posting (receipt / payment / transfer / advance custody).
   */
  public static recordTreasuryTransaction(params: {
    type: TreasuryTransaction['type'];
    amount: number;
    date: string;
    description: string;
    glAccountId: string; // counterparty GL account (revenue/expense/receivable...)
    targetGlAccountId?: string; // for cash_transfer: the second treasury/bank account
    partyName?: string;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; transaction?: TreasuryTransaction; error?: string } {
    const db = erpDb.getSnapshot();
    if (Number(params.amount) <= 0) return { success: false, error: 'المبلغ يجب أن يكون أكبر من صفر' };

    const cashAcc = AccountingEngine.getMappedAccountId('cash_treasury', 'acc-1101');
    const targetAcc = db.accounts.find(a => a.id === params.glAccountId);
    if (!targetAcc) return { success: false, error: 'الحساب المحاسبي المحدد غير موجود بدليل الحسابات' };
    if (targetAcc.isHeader) return { success: false, error: 'لا يمكن الترحيل على حساب رئيسي تجميعي' };

    const countId = generateErpId('ctx');
    const receiptNumber = nextDocNumber(erpDb.getSnapshot() as unknown as Record<string, unknown>, 'treasuryTransactions', 'CSH', 4, 'receiptNumber');

    const isReceipt = params.type === 'cash_receipt';
    const isTransfer = params.type === 'cash_transfer';
    const amt = Number(params.amount);

    // QA-30: the treasury counterparty must come from the appropriate EXISTING
    // source — never invented and never left blank. When the caller did not
    // name a party, resolve it from the mapped counterparty GL account (the
    // receivables/payables/control accounts that ARE the party), falling back
    // to the account's own Arabic name.
    let partyName = params.partyName?.trim() || '';
    if (!partyName && !isTransfer) {
      const recvIds = new Set(Object.entries(db.accountMappings || {})
        .filter(([, accId]) => ['acc-1105', 'acc-1106', 'acc-1107', 'acc-1110'].includes(accId))
        .map(([, accId]) => accId));
      if (recvIds.has(params.glAccountId)) {
        partyName = isReceipt ? 'تحصيل من عملاء (حساب تحكم)' : 'عهدة/توزيع على عملاء (حساب تحكم)';
      } else {
        partyName = targetAcc.nameAr;
      }
    } else if (!partyName && isTransfer) {
      partyName = targetAcc.nameAr;
    }

    const lines: JLine[] = [];
    if (isTransfer) {
      const targetAcc2 = params.targetGlAccountId ? db.accounts.find(a => a.id === params.targetGlAccountId) : undefined;
      if (!targetAcc2) return { success: false, error: 'الحساب الوجهة للتحويل النقدي غير موجود' };
      if (targetAcc2.isHeader) return { success: false, error: 'لا يمكن التحويل إلى حساب رئيسي تجميعي' };
      // Cash moves from source account (glAccountId) to destination (targetGlAccountId)
      lines.push(jl(params.targetGlAccountId!, amt, 0, amt, 1, 'EGP', `تحويل نقدي: ${params.description}`));
      lines.push(jl(params.glAccountId, 0, amt, amt, 1, 'EGP', `تحويل نقدي: ${params.description}`));
    } else if (isReceipt) {
      lines.push(jl(cashAcc, amt, 0, amt, 1, 'EGP', `توريد نقدية: ${params.description}`));
      lines.push(jl(params.glAccountId, 0, amt, amt, 1, 'EGP', `${params.description}${partyName ? ` (${partyName})` : ''}`));
    } else {
      // cash_payment & advance_custody: expense/asset debit, cash credit
      lines.push(jl(params.glAccountId, amt, 0, amt, 1, 'EGP', `${params.description}${partyName ? ` (${partyName})` : ''}`));
      lines.push(jl(cashAcc, 0, amt, amt, 1, 'EGP', `صرف نقدية: ${params.description}`));
    }

    const jv = AccountingEngine.postJournal({
      date: params.date,
      reference: receiptNumber,
      description: `حركة خزينة نقدية ${receiptNumber} - ${params.description}`,
      sourceDocumentType: 'treasury_transaction',
      sourceDocumentId: countId,
      lines,
    }, params.userId, params.userName, params.isTest);
    if (!jv.success) return { success: false, error: jv.error };

    let created: TreasuryTransaction | undefined;
    erpDb.mutate(draft => {
      created = {
        id: countId,
        receiptNumber,
        type: params.type,
        amount: amt,
        partyName: partyName || undefined,
        date: params.date,
        description: params.description,
        glAccountId: params.glAccountId,
        documentType: params.type,
        journalEntryId: jv.entry?.id,
        isTest: params.isTest,
      };
      draft.treasuryTransactions.push(created);

      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: params.userId || 'usr-admin',
        userName: params.userName || 'محاسب الخزينة',
        module: 'إدارة الخزينة',
        action: 'create',
        recordId: countId,
        description: `تسجيل حركة خزينة ${receiptNumber} (${params.type}) بمبلغ ${amt.toLocaleString('ar-EG')} ج.م`,
      });
    });

    return { success: true, transaction: created };
  }

  /**
   * 13. Bank transaction with GL posting against the bank's own GL account.
   */
  public static recordBankTransaction(params: {
    bankAccountId: string;
    type: BankTransaction['type'];
    amount: number;
    date: string;
    reference: string;
    description: string;
    counterGlAccountId: string; // where the money goes to / comes from
    targetBankAccountId?: string; // for transfers
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; transaction?: BankTransaction; error?: string } {
    const db = erpDb.getSnapshot();
    const bank = db.bankAccounts.find(b => b.id === params.bankAccountId);
    if (!bank) return { success: false, error: 'الحساب البنكي غير موجود' };
    const bankGl = db.accounts.find(a => a.id === bank.glAccountId);
    if (!bankGl) return { success: false, error: 'الحساب المحاسبي للبنك غير موجود بدليل الحسابات' };
    const counterAcc = db.accounts.find(a => a.id === params.counterGlAccountId);
    if (!counterAcc) return { success: false, error: 'الحساب المقابل غير موجود بدليل الحسابات' };
    if (Number(params.amount) <= 0) return { success: false, error: 'المبلغ يجب أن يكون أكبر من صفر' };

    const txId = generateErpId('btx');
    const txNumber = nextDocNumber(erpDb.getSnapshot() as unknown as Record<string, unknown>, 'bankTransactions', 'BNK', 5, 'transactionNumber');
    const amt = Number(params.amount);

    const lines: JLine[] = [];
    if (params.type === 'deposit') {
      lines.push(jl(bank.glAccountId, amt, 0, amt, 1, 'EGP', `إيداع بنكي: ${params.description}`));
      lines.push(jl(params.counterGlAccountId, 0, amt, amt, 1, 'EGP', params.description));
    } else if (params.type === 'withdrawal' || params.type === 'bank_fee') {
      lines.push(jl(params.counterGlAccountId, amt, 0, amt, 1, 'EGP', params.description));
      lines.push(jl(bank.glAccountId, 0, amt, amt, 1, 'EGP', params.type === 'bank_fee' ? `عمولة بنكية: ${params.description}` : `سحب بنكي: ${params.description}`));
    } else if (params.type === 'transfer') {
      const targetBank = params.targetBankAccountId ? db.bankAccounts.find(b => b.id === params.targetBankAccountId) : undefined;
      if (!targetBank) return { success: false, error: 'الحساب البنكي الوجهة للتحويل غير موجود' };
      lines.push(jl(targetBank.glAccountId, amt, 0, amt, 1, 'EGP', `تحويل بنكي وارد: ${params.description}`));
      lines.push(jl(bank.glAccountId, 0, amt, amt, 1, 'EGP', `تحويل بنكي صادر: ${params.description}`));
    }

    const jv = AccountingEngine.postJournal({
      date: params.date,
      reference: params.reference || txNumber,
      description: `حركة بنكية ${txNumber} - ${params.description}`,
      sourceDocumentType: 'bank_transaction',
      sourceDocumentId: txId,
      lines,
    }, params.userId, params.userName, params.isTest);
    if (!jv.success) return { success: false, error: jv.error };

    let created: BankTransaction | undefined;
    erpDb.mutate(draft => {
      created = {
        id: txId,
        transactionNumber: txNumber,
        bankAccountId: params.bankAccountId,
        type: params.type,
        amount: amt,
        currency: bank.currency,
        date: params.date,
        reference: params.reference,
        description: params.description,
        journalEntryId: jv.entry?.id,
        isTest: params.isTest,
      };
      draft.bankTransactions.push(created);

      // Update bank book balance
      const b = draft.bankAccounts.find(x => x.id === params.bankAccountId);
      if (b) {
        if (params.type === 'deposit' || params.type === 'transfer') b.currentBalance += amt;
        else b.currentBalance -= amt;
      }
      if (params.type === 'transfer' && params.targetBankAccountId) {
        const tb = draft.bankAccounts.find(x => x.id === params.targetBankAccountId);
        if (tb) tb.currentBalance += amt;
      }

      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: params.userId || 'usr-admin',
        userName: params.userName || 'محاسب البنوك',
        module: 'إدارة البنوك',
        action: 'create',
        recordId: txId,
        description: `تسجيل حركة بنكية ${txNumber} (${params.type}) بمبلغ ${amt.toLocaleString('ar-EG')} على ${bank.bankName}`,
      });
    });

    return { success: true, transaction: created };
  }

  /**
   * 14. Cheque status change — ONE coherent accounting lifecycle (F8/F9).
   * Recognition (settling the trade balance into the cheques account) happens EXACTLY
   * once per cheque and is tracked by Cheque.receiptJournalId:
   *  - incoming recognition:  Dr 1104 Cheques under collection | Cr 1105/1106 receivable
   *                           (+ customer.currentBalance -= amount)
   *      PATH A (recordCustomerPayment) posts it at payment time and stamps the id here;
   *      PATH B (registerCheque) posts it at registration; legacy cheques get it posted
   *      lazily on their first transition (ensureRecognition).
   *  - outgoing recognition:  Dr 2101 supplier payable | Cr 2102 Cheques payable
   *                           (+ supplier.currentBalance -= amount)
   * Transition journals (posted only when legal — enforced state machine):
   *  - received -> under_collection: recognition if missing, otherwise state change only
   *    (the 1104 debit already exists — never double-post the receivable).
   *  - -> collected (incoming): recognition if missing, then Dr Bank | Cr 1104.
   *  - -> paid (outgoing): recognition if missing, then Dr 2102 | Cr Bank.
   *  - -> bounced/returned: reverse ONLY the recognition that was actually posted
   *    (Dr receivable | Cr 1104 and restore customer balance; Dr 2102 | Cr 2101 and
   *    restore supplier balance). If nothing was ever recognized → status change only,
   *    so 1104/2102 can never be corrupted by a fabricated reversal.
   */
  public static updateChequeStatus(params: {
    chequeId: string;
    newStatus: ChequeStatus;
    date: string;
    reason?: string;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; error?: string } {
    // RBAC: cheque lifecycle transitions require 'post' on cheques (finance)
    const guard = AuthorizationService.enforce('cheques', 'post', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };

    const db = erpDb.getSnapshot();
    const cheque = db.cheques.find(c => c.id === params.chequeId);
    if (!cheque) return { success: false, error: 'الشيك غير موجود' };
    if (cheque.status === params.newStatus) return { success: false, error: 'الشيك موجود بهذه الحالة بالفعل' };

    // Party validation
    if (cheque.partyType === 'customer') {
      if (!db.customers.find(c => c.id === cheque.partyId)) return { success: false, error: 'عميل الشيك غير مسجل' };
    } else {
      if (!db.suppliers.find(s => s.id === cheque.partyId)) return { success: false, error: 'مورد الشيك غير مسجل' };
    }

    // F9: enforced state machine — invalid transitions are rejected up front.
    const ALLOWED_TRANSITIONS: Record<ChequeStatus, ChequeStatus[]> = {
      received: ['under_collection', 'collected', 'bounced', 'returned'],
      under_collection: ['collected', 'bounced', 'returned'],
      collected: [],
      issued: ['paid', 'bounced', 'returned'],
      due: ['paid', 'bounced', 'returned'],
      paid: [],
      bounced: [],
      returned: [],
    };
    const allowedNext = ALLOWED_TRANSITIONS[cheque.status] || [];
    if (!allowedNext.includes(params.newStatus)) {
      return {
        success: false,
        error: `انتقال غير صالح للشيك: من (${cheque.status}) إلى (${params.newStatus}). الحالات المسموحة بعد الحالة الحالية: ${allowedNext.length ? allowedNext.join('، ') : 'لا يوجد (الشيك في حالة نهائية)'}`
      };
    }

    const bank = db.bankAccounts.find(b => b.currency === 'EGP') || db.bankAccounts[0];
    const underCollAcc = AccountingEngine.getMappedAccountId('cheques_under_collection', 'acc-1104');
    const payableAcc = AccountingEngine.getMappedAccountId('cheques_payable', 'acc-2102');
    const recvAcc = AccountingEngine.getMappedAccountId(
      cheque.partyType === 'customer' && db.customers.find(c => c.id === cheque.partyId)?.currency === 'USD' ? 'customer_receivable_export' : 'customer_receivable_local',
      'acc-1105'
    );
    const supAcc = AccountingEngine.getMappedAccountId('supplier_payable', 'acc-2101');
    const bankAcc = bank?.glAccountId || AccountingEngine.getMappedAccountId('bank_egp', 'acc-1102');
    // F24: the bounce journal must IDENTIFY the exact customer (or supplier) the
    // receivable/AP effect is posted against — never a generic revenue account.
    const partyName = cheque.partyType === 'customer'
      ? (db.customers.find(c => c.id === cheque.partyId)?.name || '')
      : (db.suppliers.find(s => s.id === cheque.partyId)?.name || '');

    const isBounce = params.newStatus === 'bounced' || params.newStatus === 'returned';
    const needsRecognition = !cheque.receiptJournalId;

    // Journal plan: optional recognition first, then the transition journal (if any).
    const plan: Array<{ description: string; reference: string; lines: JLine[]; isRecognition: boolean }> = [];

    if (cheque.type === 'incoming') {
      if (isBounce) {
        if (!needsRecognition) {
          plan.push({
            description: `ارتجاع شيك وارد رقم ${cheque.chequeNumber} من العميل ${partyName} - عكس الاعتراف بالأصلية (${cheque.receiptJournalId || ''})`,
            reference: `CHQ-${params.newStatus}-${cheque.chequeNumber}`,
            isRecognition: false,
            lines: [
              jl(recvAcc, cheque.amount, 0, cheque.amount, 1, cheque.currency, `إعادة تحميل العميل ${partyName} بمديونية شيك مرتد ${cheque.chequeNumber}`),
              jl(underCollAcc, 0, cheque.amount, cheque.amount, 1, cheque.currency, `عكس أوراق قبض شيك مرتد ${cheque.chequeNumber}`),
            ],
          });
        }
        // Not recognized yet → nothing to reverse: status change only (never fabricate an adjustment).
      } else if (params.newStatus === 'under_collection') {
        if (needsRecognition) {
          plan.push({
            description: `شيك وارد تحت التحصيل رقم ${cheque.chequeNumber} - الاعتراف بالتحصيل وخصم مديونية العميل`,
            reference: `CHQ-${params.newStatus}-${cheque.chequeNumber}`,
            isRecognition: true,
            lines: [
              jl(underCollAcc, cheque.amount, 0, cheque.amount, 1, cheque.currency, `شيك وارد تحت التحصيل رقم ${cheque.chequeNumber}`),
              jl(recvAcc, 0, cheque.amount, cheque.amount, 1, cheque.currency, `تحويل مديونية العميل لشيك تحت التحصيل ${cheque.chequeNumber}`),
            ],
          });
        }
        // Already recognized at received → state change only (never double-post 1104/1105).
      } else if (params.newStatus === 'collected') {
        if (needsRecognition) {
          plan.push({
            description: `تحصيل شيك وارد رقم ${cheque.chequeNumber} - الاعتراف الأصلي وخصم مديونية العميل`,
            reference: `CHQ-REC-${cheque.chequeNumber}`,
            isRecognition: true,
            lines: [
              jl(underCollAcc, cheque.amount, 0, cheque.amount, 1, cheque.currency, `شيك وارد تحت التحصيل رقم ${cheque.chequeNumber}`),
              jl(recvAcc, 0, cheque.amount, cheque.amount, 1, cheque.currency, `تحويل مديونية العميل لشيك تحت التحصيل ${cheque.chequeNumber}`),
            ],
          });
        }
        plan.push({
          description: `تحصيل شيك وارد رقم ${cheque.chequeNumber} وإيداعه بالبنك`,
          reference: `CHQ-${params.newStatus}-${cheque.chequeNumber}`,
          isRecognition: false,
          lines: [
            jl(bankAcc, cheque.amount, 0, cheque.amount, 1, cheque.currency, `تحصيل شيك رقم ${cheque.chequeNumber} وإيداعه بالبنك`),
            jl(underCollAcc, 0, cheque.amount, cheque.amount, 1, cheque.currency, `تسوية أوراق قبض محصلة ${cheque.chequeNumber}`),
          ],
        });
      }
    } else {
      // Outgoing (payable) cheque
      if (isBounce) {
        if (!needsRecognition) {
          plan.push({
            description: `ارتجاع شيك صادر رقم ${cheque.chequeNumber} للمورد ${partyName} - عكس الاعتراف بالأصلية (${cheque.receiptJournalId || ''})`,
            reference: `CHQ-${params.newStatus}-${cheque.chequeNumber}`,
            isRecognition: false,
            lines: [
              jl(payableAcc, cheque.amount, 0, cheque.amount, 1, cheque.currency, `إلغاء ورقة دفع شيك مرتد ${cheque.chequeNumber}`),
              jl(supAcc, 0, cheque.amount, cheque.amount, 1, cheque.currency, `إعادة تحميل المورد ${partyName} بمستحقات شيك مرتد ${cheque.chequeNumber}`),
            ],
          });
        }
      } else if (params.newStatus === 'paid') {
        if (needsRecognition) {
          plan.push({
            description: `صرف شيك صادر رقم ${cheque.chequeNumber} - الاعتراف الأصلي بورقة الدفع`,
            reference: `CHQ-REC-${cheque.chequeNumber}`,
            isRecognition: true,
            lines: [
              jl(supAcc, cheque.amount, 0, cheque.amount, 1, cheque.currency, `اعتراف بورقة دفع للمورد ${cheque.chequeNumber}`),
              jl(payableAcc, 0, cheque.amount, cheque.amount, 1, cheque.currency, `تسجيل أوراق دفع شيك صادر ${cheque.chequeNumber}`),
            ],
          });
        }
        plan.push({
          description: `صرف شيك صادر رقم ${cheque.chequeNumber} من البنك`,
          reference: `CHQ-${params.newStatus}-${cheque.chequeNumber}`,
          isRecognition: false,
          lines: [
            jl(payableAcc, cheque.amount, 0, cheque.amount, 1, cheque.currency, `صرف شيك صادر رقم ${cheque.chequeNumber}`),
            jl(bankAcc, 0, cheque.amount, cheque.amount, 1, cheque.currency, `خصم شيك صادر ${cheque.chequeNumber} من البنك`),
          ],
        });
      }
    }

    // Post the plan (all-or-nothing: recognition posts first; a failure aborts before
    // any status change, and both journals share the same date/period result).
    let lastJvId: string | undefined;
    let recognitionJvId = cheque.receiptJournalId;
    let balanceDelta = 0; // applied to the party's currentBalance
    for (const step of plan) {
      const jv = AccountingEngine.postJournal({
        date: params.date,
        reference: step.reference,
        description: step.description,
        sourceDocumentType: step.isRecognition ? 'cheque_recognition' : 'cheque_status_change',
        sourceDocumentId: cheque.id,
        lines: step.lines,
      }, params.userId, params.userName, params.isTest);
      if (!jv.success) return { success: false, error: jv.error };
      lastJvId = jv.entry?.id;
      if (step.isRecognition) {
        recognitionJvId = jv.entry?.id;
        balanceDelta -= cheque.amount; // settle the trade balance exactly once
      }
      if (isBounce && !step.isRecognition) {
        balanceDelta += cheque.amount; // restore what recognition deducted
      }
    }

    erpDb.mutate(draft => {
      const c = draft.cheques.find(x => x.id === params.chequeId);
      if (c) {
        c.status = params.newStatus;
        c.statusDate = params.date;
        if (lastJvId) c.journalEntryId = lastJvId;
        if (recognitionJvId) c.receiptJournalId = recognitionJvId;
      }

      // Keep denormalized party balances synchronized with the GL (never diverge).
      if (balanceDelta !== 0) {
        if (cheque.partyType === 'customer') {
          const cust = draft.customers.find(x => x.id === cheque.partyId);
          if (cust) cust.currentBalance = (cust.currentBalance || 0) + balanceDelta;
        } else {
          const sup = draft.suppliers.find(x => x.id === cheque.partyId);
          if (sup) sup.currentBalance = (sup.currentBalance || 0) + balanceDelta;
        }
      }

      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId,
        userName: guard.userName,
        module: 'إدارة الشيكات',
        action: 'edit',
        recordId: cheque.id,
        description: `تحديث حالة الشيك ${cheque.chequeNumber} إلى: ${params.newStatus}${plan.length ? ` مع ترحيل ${plan.length} قيد محاسبي` : ' (بدون قيد - لم يسبق الاعتراف بالأصلية)'}${balanceDelta !== 0 ? ` وتحديث رصيد الطرف بـ ${balanceDelta}` : ''}`,
      });
    });

    return { success: true };
  }

  /**
   * 15. Register a standalone incoming/outgoing cheque (manual registration).
   */
  public static registerCheque(params: {
    type: 'incoming' | 'outgoing';
    partyId: string;
    chequeNumber: string;
    bankName: string;
    amount: number;
    currency: 'EGP' | 'USD';
    issueDate: string;
    dueDate: string;
    notes?: string;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; cheque?: Cheque; error?: string } {
    // F15: manual cheque registration is no longer an unguarded write —
    // registering cheques requires 'create' on the cheques module.
    const guard = AuthorizationService.enforce('cheques', 'create', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };

    const db = erpDb.getSnapshot();
    if (!params.chequeNumber?.trim()) return { success: false, error: 'يرجى إدخال رقم الشيك' };
    if (Number(params.amount) <= 0) return { success: false, error: 'مبلغ الشيك يجب أن يكون أكبر من صفر' };
    const amount = Number(params.amount);

    const chequeId = generateErpId('chq');
    const chequeNumber = params.chequeNumber.trim();

    // QA-19: cheque numbers must be unique within their natural scope. The
    // existing business model scopes an incoming cheque to the CUSTOMER and an
    // outgoing cheque to the SUPPLIER, so two different banks may legitimately
    // reuse a number across different parties — but the SAME party cannot have
    // the same cheque number twice, which would double both the cheque account
    // and the receivable/AP effect.
    const duplicate = db.cheques.find(c =>
      c.chequeNumber.toLowerCase() === chequeNumber.toLowerCase() &&
      c.partyId === params.partyId &&
      c.status !== 'bounced' && c.status !== 'returned'
    );
    if (duplicate) {
      return {
        success: false,
        error: `رقم الشيك (${chequeNumber}) مسجل بالفعل للطرف نفسه بحالة (${duplicate.status}). يجب أن يكون رقم الشيك فريدًا — يُرجى التحقق من رقم الشيك.`,
      };
    }

    // F8: registration IS the business event that settles the trade balance —
    // the same recognition PATH A posts through recordCustomerPayment/recordSupplierPayment.
    const underCollAcc = AccountingEngine.getMappedAccountId('cheques_under_collection', 'acc-1104');
    const payableAcc = AccountingEngine.getMappedAccountId('cheques_payable', 'acc-2102');
    const supAcc = AccountingEngine.getMappedAccountId('supplier_payable', 'acc-2101');

    let recognitionLines: JLine[];
    let recognitionDesc: string;
    if (params.type === 'incoming') {
      const customer = db.customers.find(c => c.id === params.partyId);
      if (!customer) return { success: false, error: 'العميل غير مسجل بالنظام' };
      const recvAcc = AccountingEngine.getMappedAccountId(
        customer.currency === 'USD' ? 'customer_receivable_export' : 'customer_receivable_local',
        'acc-1105'
      );
      recognitionLines = [
        jl(underCollAcc, amount, 0, amount, 1, params.currency, `استلام شيك وارد رقم ${chequeNumber} تحت التحصيل`),
        jl(recvAcc, 0, amount, amount, 1, params.currency, `تحويل مديونية العميل ${customer.name} إلى شيك وارد ${chequeNumber}`),
      ];
      recognitionDesc = `تسجيل شيك وارد ${chequeNumber} من العميل ${customer.name} وخصم المديونية`;
    } else {
      const supplier = db.suppliers.find(s => s.id === params.partyId);
      if (!supplier) return { success: false, error: 'المورد غير مسجل بالنظام' };
      recognitionLines = [
        jl(supAcc, amount, 0, amount, 1, params.currency, `سداد مستحقات المورد ${supplier.name} بشيك صادر ${chequeNumber}`),
        jl(payableAcc, 0, amount, amount, 1, params.currency, `تسجيل أوراق دفع شيك صادر ${chequeNumber}`),
      ];
      recognitionDesc = `تسجيل شيك صادر ${chequeNumber} للمورد ${supplier.name}`;
    }

    const jv = AccountingEngine.postJournal({
      date: params.issueDate,
      reference: `CHQ-REG-${chequeNumber}`,
      description: recognitionDesc,
      sourceDocumentType: 'cheque_registration',
      sourceDocumentId: chequeId,
      lines: recognitionLines,
    }, guard.userId, guard.userName, params.isTest);
    if (!jv.success) return { success: false, error: jv.error };

    const newCheque: Cheque = {
      id: chequeId,
      chequeNumber,
      type: params.type,
      partyType: params.type === 'incoming' ? 'customer' : 'supplier',
      partyId: params.partyId,
      bankName: params.bankName?.trim() || 'بنك غير محدد',
      amount,
      currency: params.currency,
      issueDate: params.issueDate,
      dueDate: params.dueDate,
      status: params.type === 'incoming' ? 'received' : 'issued',
      statusDate: params.issueDate,
      notes: params.notes,
      journalEntryId: jv.entry?.id,
      receiptJournalId: jv.entry?.id,
      isTest: params.isTest,
    };

    erpDb.mutate(draft => {
      draft.cheques.push(newCheque);

      // Keep the party balance synchronized with the recognition journal (F8).
      if (params.type === 'incoming') {
        const cust = draft.customers.find(c => c.id === params.partyId);
        if (cust) cust.currentBalance = (cust.currentBalance || 0) - amount;
      } else {
        const sup = draft.suppliers.find(s => s.id === params.partyId);
        if (sup) sup.currentBalance = (sup.currentBalance || 0) - amount;
      }

      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId,
        userName: guard.userName,
        module: 'إدارة الشيكات',
        action: 'create',
        recordId: chequeId,
        description: `تسجيل شيك ${params.type === 'incoming' ? 'وارد' : 'صادر'} رقم ${newCheque.chequeNumber} بمبلغ ${newCheque.amount} ${newCheque.currency} مع ترحيل قيد الاعتراف وتحديث رصيد الطرف`,
      });
    });

    return { success: true, cheque: newCheque };
  }

  /**
   * 15b. Representative master data — create (F2). Guarded by AuthorizationService.
   * No representatives are ever seeded automatically; the user registers them here.
   */
  public static createSalesRepresentative(params: {
    code: string;
    name: string;
    phone?: string;
    targetMonthlySales?: number;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; rep?: SalesRepresentative; error?: string } {
    const guard = AuthorizationService.enforce('representatives', 'create', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };

    const db = erpDb.getSnapshot();
    const code = (params.code || '').trim();
    const name = (params.name || '').trim();
    if (!code) return { success: false, error: 'كود المندوب مطلوب' };
    if (!name) return { success: false, error: 'اسم المندوب مطلوب' };
    if (db.salesReps.some(r => r.code.toLowerCase() === code.toLowerCase())) return { success: false, error: `كود المندوب (${code}) مستخدم بالفعل` };
    if (db.salesReps.some(r => r.name.trim() === name)) return { success: false, error: `المندوب (${name}) مسجل بالفعل` };

    const rep: SalesRepresentative = {
      id: generateErpId('rep'),
      code,
      name,
      phone: (params.phone || '').trim(),
      active: true,
      targetMonthlySales: Number(params.targetMonthlySales) || 0,
      isTest: params.isTest,
    };

    erpDb.mutate(draft => {
      draft.salesReps.push(rep);
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId,
        userName: guard.userName,
        module: 'المندوبون والعهد',
        action: 'create',
        recordId: rep.id,
        description: `تسجيل مندوب جديد: ${rep.code} - ${rep.name}`,
      });
    });

    return { success: true, rep };
  }

  /**
   * 15c. Representative master data — edit/deactivate (F2). Guarded by AuthorizationService.
   * Deactivation only hides the rep from NEW transaction dropdowns; historical
   * transactions referencing it remain valid.
   */
  public static updateSalesRepresentative(params: {
    repId: string;
    name?: string;
    phone?: string;
    active?: boolean;
    targetMonthlySales?: number;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; rep?: SalesRepresentative; error?: string } {
    const guard = AuthorizationService.enforce('representatives', 'edit', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };

    const db = erpDb.getSnapshot();
    const existing = db.salesReps.find(r => r.id === params.repId);
    if (!existing) return { success: false, error: 'المندوب غير موجود' };
    const name = params.name !== undefined ? params.name.trim() : existing.name;
    if (!name) return { success: false, error: 'اسم المندوب مطلوب' };
    if (db.salesReps.some(r => r.id !== existing.id && r.name.trim() === name)) return { success: false, error: `المندوب (${name}) مسجل بالفعل` };

    let updated: SalesRepresentative | undefined;
    erpDb.mutate(draft => {
      const rep = draft.salesReps.find(r => r.id === params.repId);
      if (!rep) return;
      rep.name = name;
      if (params.phone !== undefined) rep.phone = params.phone.trim();
      if (params.active !== undefined) rep.active = params.active;
      if (params.targetMonthlySales !== undefined) rep.targetMonthlySales = Number(params.targetMonthlySales) || 0;
      updated = { ...rep };
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId,
        userName: guard.userName,
        module: 'المندوبون والعهد',
        action: 'edit',
        recordId: rep.id,
        description: `تعديل المندوب ${rep.code} - ${rep.name}${params.active !== undefined ? (params.active ? ' (تفعيل)' : ' (تعطيل)') : ''}`,
      });
    });

    return { success: true, rep: updated };
  }

  /**
   * 16. Sell goods FROM a representative's custody to a customer (van sale).
   * Posts revenue + VAT + COGS against rep custody inventory account.
   */
  public static sellFromRepCustody(params: {
    custodyId: string;
    customerId: string;
    invoiceWarehouseId: string; // rep custody is accounted from wh-local
    paymentMethod: 'cash' | 'credit' | 'bank_transfer' | 'cheque';
    date: string;
    lines: Array<{ itemId: string; quantity: number; unitPrice: number; vatRate: number }>;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; invoice?: SalesInvoice; error?: string } {
    const db = erpDb.getSnapshot();
    const custody = db.representativeCustodies.find(c => c.id === params.custodyId && c.status === 'open');
    if (!custody) return { success: false, error: 'عهدة المندوب غير موجودة أو تم تسويتها' };
    const customer = db.customers.find(c => c.id === params.customerId);
    if (!customer) return { success: false, error: 'العميل غير مسجل بالنظام' };
    if (!params.lines || params.lines.length === 0) return { success: false, error: 'يجب إدخال أصناف البيع' };

    // Custody must hold enough of each item (loaded - sold - returned >= selling qty)
    for (const l of params.lines) {
      const loaded = db.custodyMovements
        .filter(m => m.custodyId === custody.id && m.itemId === l.itemId && m.movementType === 'loaded')
        .reduce((s, m) => s + m.quantity, 0);
      const sold = db.custodyMovements
        .filter(m => m.custodyId === custody.id && m.itemId === l.itemId && m.movementType === 'sold')
        .reduce((s, m) => s + m.quantity, 0);
      const returned = db.custodyMovements
        .filter(m => m.custodyId === custody.id && m.itemId === l.itemId && m.movementType === 'returned')
        .reduce((s, m) => s + m.quantity, 0);
      const available = loaded - sold - returned;
      if (l.quantity > available) {
        const item = db.items.find(i => i.id === l.itemId);
        return { success: false, error: `الكمية المتاحة بعهدة المندوب من (${item?.nameAr || l.itemId}) هي ${available} ولا تكفي لبيع ${l.quantity}` };
      }
    }

    let subtotal = 0;
    let vatTotal = 0;
    params.lines.forEach(l => {
      const lineNet = l.quantity * l.unitPrice;
      subtotal += lineNet;
      vatTotal += lineNet * (l.vatRate || 0);
    });
    const totalAmount = subtotal + vatTotal;

    const invoiceId = generateErpId('sinv');
    const invoiceNumber = nextDocNumber(erpDb.getSnapshot() as unknown as Record<string, unknown>, 'salesInvoices', 'SINV', 5, 'invoiceNumber');

    // Revenue side
    const revAcc = AccountingEngine.getMappedAccountId('sales_retail_revenue', 'acc-4101');
    const vatAcc = AccountingEngine.getMappedAccountId('sales_vat_output', 'acc-2103');
    let debitAcc: string;
    if (params.paymentMethod === 'cash') debitAcc = AccountingEngine.getMappedAccountId('cash_treasury', 'acc-1101');
    else if (params.paymentMethod === 'bank_transfer') debitAcc = AccountingEngine.getMappedAccountId('bank_egp', 'acc-1102');
    else debitAcc = AccountingEngine.getMappedAccountId('customer_receivable_local', 'acc-1105');

    const revLines: JLine[] = [
      jl(debitAcc, totalAmount, 0, totalAmount, 1, 'EGP', `بيع من عهدة مندوب ${custody.custodyNumber} - فاتورة ${invoiceNumber}`),
      jl(revAcc, 0, subtotal, subtotal, 1, 'EGP', `إيراد بيع مندوب ${invoiceNumber}`),
      ...(vatTotal > 0 ? [jl(vatAcc, 0, vatTotal, vatTotal, 1, 'EGP', `ضريبة مخرجات بيع مندوب ${invoiceNumber}`)] : []),
    ];

    const revJv = AccountingEngine.postJournal({
      date: params.date,
      reference: invoiceNumber,
      description: `بيع من عهدة المندوب ${custody.custodyNumber} - فاتورة ${invoiceNumber} للعميل ${customer.name}`,
      sourceDocumentType: 'rep_custody_sale',
      sourceDocumentId: invoiceId,
      lines: revLines,
    }, params.userId, params.userName, params.isTest);
    if (!revJv.success) return { success: false, error: revJv.error };

    // COGS side: custody inventory leaves the rep custody account
    let cogsTotal = 0;
    const cogsAcc = AccountingEngine.getMappedAccountId('cogs_local', 'acc-5101');
    const custodyAcc = AccountingEngine.getMappedAccountId('rep_custody', 'acc-1107');
    const cogsLines: JLine[] = [];

    const custMovements: CustodyMovement[] = [];
    for (const l of params.lines) {
      const est = InventoryEngine.estimateIssueCost(l.itemId, 'wh-local', l.quantity);
      const unitCost = est.actualUnitCost || 0;
      cogsTotal += l.quantity * unitCost;
      custMovements.push({
        id: generateErpId('cstm'),
        custodyId: custody.id,
        itemId: l.itemId,
        movementType: 'sold',
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        date: params.date,
        referenceDoc: invoiceNumber,
      });
    }

    if (cogsTotal > 0) {
      cogsLines.push(jl(cogsAcc, cogsTotal, 0, cogsTotal, 1, 'EGP', `تكلفة بضاعة مباعة من عهدة المندوب ${invoiceNumber}`));
      cogsLines.push(jl(custodyAcc, 0, cogsTotal, cogsTotal, 1, 'EGP', `خصم تكلفة بضاعة من عهدة المندوب ${custody.custodyNumber}`));
      const cogsJv = AccountingEngine.postJournal({
        date: params.date,
        reference: invoiceNumber,
        description: `تكلفة بيع عهدة المندوب ${custody.custodyNumber} - فاتورة ${invoiceNumber}`,
        sourceDocumentType: 'rep_custody_sale_cogs',
        sourceDocumentId: invoiceId,
        lines: cogsLines,
      }, params.userId, params.userName, params.isTest);
      if (!cogsJv.success) return { success: false, error: cogsJv.error };
    }

    let created: SalesInvoice | undefined;
    erpDb.mutate(draft => {
      created = {
        id: invoiceId,
        invoiceNumber,
        date: params.date,
        customerId: params.customerId,
        channel: customer.customerType === 'export' ? 'export' : (customer.customerType === 'wholesale' ? 'wholesale' : 'retail'),
        warehouseId: params.invoiceWarehouseId,
        repId: custody.repId,
        paymentMethod: params.paymentMethod,
        currency: 'EGP',
        exchangeRate: 1,
        subtotal,
        discountAmount: 0,
        vatAmount: vatTotal,
        totalAmount,
        totalAmountEGP: totalAmount,
        cogsTotal,
        status: 'posted',
        journalEntryId: revJv.entry?.id,
        notes: `بيع من عهدة مندوب ${custody.custodyNumber}`,
        isTest: params.isTest,
      };
      draft.salesInvoices.push(created);

      params.lines.forEach((l, idx) => {
        draft.salesInvoiceLines.push({
          id: `sinvl-${invoiceId}-${idx + 1}`,
          invoiceId,
          itemId: l.itemId,
          quantity: l.quantity,
          freeQuantity: 0,
          unitPrice: l.unitPrice,
          unitCost: cogsTotal / Math.max(1, params.lines.reduce((s, x) => s + x.quantity, 0)),
          discount: 0,
          vatRate: l.vatRate,
          vatAmount: l.quantity * l.unitPrice * (l.vatRate || 0),
          totalBeforeVat: l.quantity * l.unitPrice,
          netTotal: l.quantity * l.unitPrice * (1 + (l.vatRate || 0)),
        });
      });

      custMovements.forEach(m => draft.custodyMovements.push(m));

      if (params.paymentMethod === 'credit') {
        const cust = draft.customers.find(c => c.id === params.customerId);
        if (cust) cust.currentBalance = (cust.currentBalance || 0) + totalAmount;
      }

      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: params.userId || 'usr-admin',
        userName: params.userName || 'مندوب المبيعات',
        module: 'المبيعات - عهد المناديب',
        action: 'post',
        recordId: invoiceId,
        description: `بيع من عهدة المندوب ${custody.custodyNumber} فاتورة ${invoiceNumber} بمبلغ ${totalAmount.toLocaleString('ar-EG')} ج.م للعميل ${customer.name}`,
      });
    });

    return { success: true, invoice: created };
  }

  /**
   * 17. Settle & close a representative custody: validates reconciliation and posts cash collection.
   * Loaded - Sold - Returned = Remaining (must be zero physical remaining after settlement).
   */
  public static settleRepCustody(params: {
    custodyId: string;
    cashCollected?: number; // cash the rep hands over at settlement (treasury IN)
    cashRefunded?: number;  // cash the company refunds to the rep (treasury OUT)
    date: string;
    /** QA-20: settlement must never silently close a custody that still holds
     *  unsold goods. Return the goods to stock first (returnGoodsFromRep), or
     *  pass true to acknowledge the shortfall on the record. */
    acknowledgeRemainingGoods?: boolean;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): {
    success: boolean;
    error?: string;
    reconciliation?: Array<{ itemId: string; loaded: number; sold: number; returned: number; remaining: number }>;
    treasuryDelta?: number;
    unsoldGoods?: Array<{ itemId: string; remaining: number }>;
    warning?: string;
  } {
    const db = erpDb.getSnapshot();
    const custody = db.representativeCustodies.find(c => c.id === params.custodyId);
    if (!custody) return { success: false, error: 'العهدة غير موجودة' };
    if (custody.status !== 'open') return { success: false, error: 'العهدة تمت تسويتها بالفعل' };

    const movements = db.custodyMovements.filter(m => m.custodyId === custody.id);
    const itemIds = [...new Set(movements.map(m => m.itemId))];
    const reconciliation: Array<{ itemId: string; loaded: number; sold: number; returned: number; remaining: number }> = [];
    for (const itemId of itemIds) {
      const loaded = movements.filter(m => m.itemId === itemId && m.movementType === 'loaded').reduce((s, m) => s + m.quantity, 0);
      const sold = movements.filter(m => m.itemId === itemId && m.movementType === 'sold').reduce((s, m) => s + m.quantity, 0);
      const returned = movements.filter(m => m.itemId === itemId && m.movementType === 'returned').reduce((s, m) => s + m.quantity, 0);
      reconciliation.push({ itemId, loaded, sold, returned, remaining: loaded - sold - returned });
    }

    // QA-20: unsold goods must never disappear silently at settlement.
    const unsoldGoods = reconciliation
      .filter(r => r.remaining > 0.01)
      .map(r => ({ itemId: r.itemId, remaining: Number(r.remaining.toFixed(4)) }));
    let unsoldWarning: string | undefined;
    if (unsoldGoods.length > 0) {
      const detail = unsoldGoods.map(u => {
        const itm = db.items.find(i => i.id === u.itemId);
        return `${itm?.nameAr || u.itemId}: ${u.remaining}`;
      }).join('، ');
      unsoldWarning = `العهدة ${custody.custodyNumber} ما زالت تحتوي على بضاعة غير مباعة (${detail}). يجب إرجاعها إلى المخزون قبل التسوية.`;
      if (!params.acknowledgeRemainingGoods) {
        return { success: false, error: unsoldWarning, reconciliation, unsoldGoods };
      }
      // explicitly acknowledged — the settlement proceeds but the shortfall is
      // reported back so the caller can log it.
    }

    const cashCollected = Number(params.cashCollected) || 0;
    const cashRefunded = Number(params.cashRefunded) || 0;
    if (cashCollected < 0 || cashRefunded < 0) {
      return { success: false, error: 'مبالغ التسوية النقدية يجب أن تكون أرقامًا موجبة' };
    }

    const rep = db.salesReps.find(r => r.id === custody.repId);

    // F21: treasury moves ONLY with real cash.
    //  - cashCollected  -> Dr Cash 1101 | Cr Custody 1107  (treasury IN)
    //  - cashRefunded   -> Dr Custody 1107 | Cr Cash 1101  (treasury OUT)
    //  - neither        -> purely non-cash: NO cash movement at all.
    let jvId: string | undefined;
    if (cashCollected > 0 || cashRefunded > 0) {
      const cashAcc = AccountingEngine.getMappedAccountId('cash_treasury', 'acc-1101');
      const custodyAcc = AccountingEngine.getMappedAccountId('rep_custody', 'acc-1107');
      const lines: JLine[] = [];
      if (cashCollected > 0) {
        lines.push(jl(cashAcc, cashCollected, 0, cashCollected, 1, 'EGP', `استلام نقدي من تسوية عهدة ${custody.custodyNumber}`));
        lines.push(jl(custodyAcc, 0, cashCollected, cashCollected, 1, 'EGP', `تخفيض عهدة المندوب النقدية ${custody.custodyNumber}`));
      }
      if (cashRefunded > 0) {
        lines.push(jl(custodyAcc, cashRefunded, 0, cashRefunded, 1, 'EGP', `زيادة عهدة المندوب النقدية ${custody.custodyNumber} (استرداد)`));
        lines.push(jl(cashAcc, 0, cashRefunded, cashRefunded, 1, 'EGP', `صرف نقدي لرد تسوية عهدة ${custody.custodyNumber}`));
      }
      const jv = AccountingEngine.postJournal({
        date: params.date,
        reference: `CUST-SETTLE-${custody.custodyNumber}`,
        description: `تسوية عهدة مندوب ${custody.custodyNumber}${cashCollected > 0 ? ` - استلام نقدي ${cashCollected}` : ''}${cashRefunded > 0 ? ` - رد نقدي ${cashRefunded}` : ''}`,
        sourceDocumentType: 'rep_custody_settlement',
        sourceDocumentId: custody.id,
        lines,
      }, params.userId, params.userName, params.isTest);
      if (!jv.success) return { success: false, error: jv.error };
      jvId = jv.entry?.id;
    }

    erpDb.mutate(draft => {
      const c = draft.representativeCustodies.find(x => x.id === params.custodyId);
      if (c) {
        c.status = 'settled';
        c.settleDate = params.date;
        c.closeDate = params.date;
      }

      // F21/F29: the treasury ledger carries the same cash the GL just moved.
      const cashAcc = AccountingEngine.getMappedAccountId('cash_treasury', 'acc-1101');
      if (cashCollected > 0) {
        draft.treasuryTransactions.push({
          id: generateErpId('ctx'),
          receiptNumber: nextDocNumber(draft as unknown as Record<string, unknown>, 'treasuryTransactions', 'CSH', 4, 'receiptNumber'),
          type: 'cash_receipt',
          amount: cashCollected,
          partyName: rep?.name || custody.custodyNumber,
          date: params.date,
          description: `تحصيل نقدي من تسوية عهدة المندوب ${custody.custodyNumber}`,
          glAccountId: cashAcc,
          documentType: 'rep_custody_settlement',
          journalEntryId: jvId,
          isTest: params.isTest,
        });
      }
      if (cashRefunded > 0) {
        draft.treasuryTransactions.push({
          id: generateErpId('ctx'),
          receiptNumber: nextDocNumber(draft as unknown as Record<string, unknown>, 'treasuryTransactions', 'CSH', 4, 'receiptNumber'),
          type: 'cash_payment',
          amount: cashRefunded,
          partyName: rep?.name || custody.custodyNumber,
          date: params.date,
          description: `صرف نقدي لرد تسوية عهدة المندوب ${custody.custodyNumber}`,
          glAccountId: cashAcc,
          documentType: 'rep_custody_settlement',
          journalEntryId: jvId,
          isTest: params.isTest,
        });
      }

      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: params.userId || 'usr-admin',
        userName: params.userName || 'مدير المبيعات',
        module: 'المناديب - تسوية العهد',
        action: 'approve',
        recordId: custody.id,
        description: `تسوية وإغلاق عهدة ${custody.custodyNumber}: ${reconciliation.length} صنف، بقايا غير مباعة ${reconciliation.filter(r => r.remaining > 0).length} صنف${jvId ? ` مع ترحيل القيد المحاسبي - صافي حركة الخزينة ${cashCollected - cashRefunded}` : ' (تسوية غير نقدية - لا حركة نقدية)'}`,
      });
    });

    return {
      success: true,
      reconciliation,
      treasuryDelta: Number((cashCollected - cashRefunded).toFixed(2)),
      unsoldGoods: unsoldGoods.length ? unsoldGoods : undefined,
      warning: unsoldWarning,
    };
  }

  /**
   * 18. Record a representative-specific expense (posted to GL with rep linkage).
   */
  public static recordExpense(params: {
    date: string;
    glAccountId: string;
    costCenterId: string;
    amount: number;
    vatAmount?: number;
    paymentMethod: 'cash' | 'bank';
    bankAccountId?: string;
    salesRepId?: string;
    description: string;
    reference?: string;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; expense?: Expense; error?: string } {
    const db = erpDb.getSnapshot();
    const glAcc = db.accounts.find(a => a.id === params.glAccountId);
    if (!glAcc) return { success: false, error: 'حساب المصروف غير موجود بدليل الحسابات' };
    if (glAcc.isHeader) return { success: false, error: 'لا يمكن الترحيل على حساب رئيسي تجميعي' };
    if (!db.costCenters.find(cc => cc.id === params.costCenterId)) return { success: false, error: 'مركز التكلفة غير موجود' };
    if (params.salesRepId && !db.salesReps.find(r => r.id === params.salesRepId)) return { success: false, error: 'المندوب غير مسجل' };
    if (Number(params.amount) <= 0) return { success: false, error: 'مبلغ المصروف يجب أن يكون أكبر من صفر' };

    const expenseId = generateErpId('exp');
    const expenseNumber = nextDocNumber(erpDb.getSnapshot() as unknown as Record<string, unknown>, 'expenses', 'EXP', 5, 'expenseNumber');
    const amount = Number(params.amount);
    const vatAmount = Number(params.vatAmount) || 0;
    const totalAmount = amount + vatAmount;

    let creditAcc: string;
    if (params.paymentMethod === 'bank') {
      const bank = params.bankAccountId ? db.bankAccounts.find(b => b.id === params.bankAccountId) : undefined;
      creditAcc = bank?.glAccountId || AccountingEngine.getMappedAccountId('bank_egp', 'acc-1102');
    } else {
      creditAcc = AccountingEngine.getMappedAccountId('cash_treasury', 'acc-1101');
    }

    const lines: JLine[] = [
      jl(params.glAccountId, amount, 0, amount, 1, 'EGP', params.description, params.costCenterId),
      ...(vatAmount > 0 ? [jl(AccountingEngine.getMappedAccountId('purchase_vat_input', 'acc-1113'), vatAmount, 0, vatAmount, 1, 'EGP', `ضريبة مدخلات مصروف ${expenseNumber}`)] : []),
      jl(creditAcc, 0, totalAmount, totalAmount, 1, 'EGP', `سداد مصروف ${expenseNumber}`),
    ];

    const jv = AccountingEngine.postJournal({
      date: params.date,
      reference: params.reference || expenseNumber,
      description: `مصروف ${expenseNumber} - ${params.description}`,
      sourceDocumentType: 'expense',
      sourceDocumentId: expenseId,
      lines,
    }, params.userId, params.userName, params.isTest);
    if (!jv.success) return { success: false, error: jv.error };

    let created: Expense | undefined;
    erpDb.mutate(draft => {
      created = {
        id: expenseId,
        expenseNumber,
        date: params.date,
        glAccountId: params.glAccountId,
        costCenterId: params.costCenterId,
        salesRepId: params.salesRepId,
        amount,
        vatAmount,
        totalAmount,
        paymentMethod: params.paymentMethod,
        bankAccountId: params.paymentMethod === 'bank' ? params.bankAccountId : undefined,
        description: params.description,
        reference: params.reference || '',
        journalEntryId: jv.entry?.id,
        isTest: params.isTest,
      };
      draft.expenses.push(created);

      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: params.userId || 'usr-admin',
        userName: params.userName || 'المشرف العام (Admin)',
        module: 'إدارة المصروفات',
        action: 'create',
        recordId: expenseId,
        description: `تسجيل مصروف ${expenseNumber} بمبلغ ${totalAmount.toLocaleString('ar-EG')} ج.م - ${params.description}`,
      });
    });

    return { success: true, expense: created };
  }

  /**
   * 19. Quality inspection that PHYSICALLY MOVES rejected/conditional quantities out of
   * saleable inventory into the destination warehouse (with GL revaluation).
   * Saleable-passed goods are recorded but not moved.
   */
  public static recordQualityInspectionWithRouting(params: {
    documentType: QualityInspection['documentType'];
    documentNumber: string;
    itemId: string;
    batchNumber: string;
    inspectedQuantity: number;
    date: string;
    inspectorName: string;
    result: QualityInspection['result'];
    destination: QualityInspection['destination'];
    sourceWarehouseId?: string; // where the stock currently sits (defaults to wh-local)
    reason?: string;
    notes?: string;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; inspection?: QualityInspection; error?: string } {
    const db = erpDb.getSnapshot();
    const item = db.items.find(i => i.id === params.itemId);
    if (!item) return { success: false, error: 'الصنف غير معرف' };
    if (Number(params.inspectedQuantity) <= 0) return { success: false, error: 'الكمية المفحوصة يجب أن تكون أكبر من صفر' };

    const routing = qualityDestinationRouting(params.destination);
    const sourceWh = params.sourceWarehouseId || 'wh-local';

    const inspId = generateErpId('qi');

    // For rejected/conditional goods: physically move from source warehouse to destination
    if (params.result !== 'passed' && params.destination !== 'saleable') {
      const est = InventoryEngine.estimateIssueCost(params.itemId, sourceWh, params.inspectedQuantity, params.batchNumber);
      if (est.available < params.inspectedQuantity) {
        return { success: false, error: `الكمية المتاحة من (${item.nameAr}) بمستودع المصدر هي ${est.available} ولا تكفي لتحويل ${params.inspectedQuantity} بعد الفحص` };
      }
      const unitCost = est.actualUnitCost || item.actualCost || item.standardCost || 0;

      // Move out of source
      const outMv = InventoryEngine.recordMovement({
        itemId: params.itemId,
        warehouseId: sourceWh,
        movementType: params.destination === 'recycling' ? 'recycling' : 'scrap',
        date: params.date,
        quantityIn: 0,
        quantityOut: params.inspectedQuantity,
        unitCost: 0,
        documentType: 'فحص جودة وتوجيه',
        documentNumber: params.documentNumber,
        batchNumber: params.batchNumber,
        notes: `فحص جودة: إخراج ${params.inspectedQuantity} من ${sourceWh} (${params.result})`,
        isTest: params.isTest,
      });
      if (!outMv.success) return { success: false, error: outMv.error };

      // Receive into destination at the same cost (value-neutral reclassification)
      const inMv = InventoryEngine.recordMovement({
        itemId: params.itemId,
        warehouseId: routing.warehouseId,
        movementType: params.destination === 'recycling' ? 'recycling' : 'scrap',
        date: params.date,
        quantityIn: params.inspectedQuantity,
        quantityOut: 0,
        unitCost,
        documentType: 'فحص جودة وتوجيه',
        documentNumber: params.documentNumber,
        batchNumber: params.batchNumber,
        notes: `فحص جودة: توجيه إلى ${routing.label}`,
        isTest: params.isTest,
      });
      if (!inMv.success) return { success: false, error: inMv.error };

      // GL reclassification: inventory accounts move value between warehouse accounts
      const fromAcc = AccountingEngine.getMappedAccountId('inventory_finished_local', 'acc-1109');
      const toAcc = AccountingEngine.getMappedAccountId(routing.inventoryMappingKey, routing.fallbackAccId);
      const value = params.inspectedQuantity * unitCost;
      if (value > 0 && fromAcc !== toAcc) {
        const jv = AccountingEngine.postJournal({
          date: params.date,
          reference: `QC-${params.documentNumber}`,
          description: `إعادة تصنيف مخزون بعد فحص جودة ${params.documentNumber}: ${item.nameAr} -> ${routing.label}`,
          sourceDocumentType: 'quality_inspection_routing',
          sourceDocumentId: inspId,
          lines: [
            jl(toAcc, value, 0, value, 1, 'EGP', `استلام مخزون معاد تصنيفه: ${routing.label}`),
            jl(fromAcc, 0, value, value, 1, 'EGP', `خصم مخزون معاد تصنيفه من المخزون القابل للبيع`),
          ],
        }, params.userId, params.userName, params.isTest);
        if (!jv.success) return { success: false, error: jv.error };
      }
    }

    const insp: QualityInspection = {
      id: inspId,
      documentType: params.documentType,
      documentNumber: params.documentNumber,
      itemId: params.itemId,
      batchNumber: params.batchNumber,
      inspectedQuantity: params.inspectedQuantity,
      date: params.date,
      inspectorName: params.inspectorName,
      result: params.result,
      reason: params.reason,
      destination: params.destination,
      destinationWarehouseId: routing.warehouseId,
      notes: params.notes,
    };

    erpDb.mutate(draft => {
      draft.qualityInspections.push(insp);
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: params.userId || 'usr-admin',
        userName: params.inspectorName,
        module: 'مراقبة الجودة',
        action: 'create',
        recordId: inspId,
        description: `فحص جودة ${params.documentNumber} للصنف ${item.nameAr}: النتيجة (${params.result}) والتوجيه إلى (${routing.label})${params.result !== 'passed' ? ' مع تنفيذ الحركة المخزنية والمحاسبية' : ''}`,
      });
    });

    return { success: true, inspection: insp };
  }
}
