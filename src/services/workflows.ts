// End-to-End Operational Workflows for Purchasing, Sales, Custody, Payments, Cheques, Export, Quality & Physical Counts
import { erpDb } from './db';
import { 
  PurchaseInvoice, PurchaseInvoiceLine, SalesInvoice, SalesInvoiceLine, 
  Payment, Cheque, QualityInspection, InventoryCount, InventoryCountLine, 
  ExportShipment, Expense, Customer, Supplier, SalesRepresentative, 
  RepresentativeCustody, CustodyMovement, SalesReturn, SalesReturnLine
} from '../types/erp';
import { InventoryEngine } from './inventory';
import { AccountingEngine } from './accounting';

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
  }): { success: boolean; invoice?: PurchaseInvoice; error?: string } {
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

    const invCount = db.purchaseInvoices.length + 1;
    const invoiceNumber = `PINV-${new Date().getFullYear()}-${String(invCount).padStart(5, '0')}`;
    const invoiceId = `pinv-${Date.now()}`;

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
      // Update supplier balance if credit
      if (params.paymentMethod === 'credit') {
        const sup = draft.suppliers.find(s => s.id === params.supplierId);
        if (sup) sup.currentBalance = (sup.currentBalance || 0) + totalAmount;
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
        id: `aud-${Date.now()}`,
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
    paymentMethod: 'cash' | 'credit' | 'bank_transfer' | 'cheque';
    currency: 'EGP' | 'USD';
    exchangeRate: number;
    date: string;
    notes?: string;
    exportShipmentId?: string;
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
  }): { success: boolean; invoice?: SalesInvoice; creditWarning?: string; error?: string } {
    const db = erpDb.getSnapshot();
    const customer = db.customers.find(c => c.id === params.customerId);
    if (!customer) return { success: false, error: 'العميل غير مسجل بالنظام' };

    const warehouse = db.warehouses.find(w => w.id === params.warehouseId);
    if (!warehouse) return { success: false, error: 'المستودع غير صالح' };

    if (!params.lines || params.lines.length === 0) {
      return { success: false, error: 'يجب إضافة أصناف لفاتورة المبيعات' };
    }

    // Check stock for all lines (including free quantities)
    for (const line of params.lines) {
      const totalQtyToIssue = line.quantity + (line.freeQuantity || 0);
      const stock = InventoryEngine.getItemBalance(line.itemId, params.warehouseId);
      const item = db.items.find(i => i.id === line.itemId);
      if (stock < totalQtyToIssue) {
        return {
          success: false,
          error: `رصيد الصنف (${item?.nameAr}) في المستودع المختار هو ${stock} ولا يكفي لصرف كمية ${totalQtyToIssue} (تشمل البونص المجاني)`
        };
      }
    }

    // Calculations
    let subtotal = 0;
    let vatAmount = 0;
    let cogsTotal = 0;

    const itemsMap = new Map(db.items.map(i => [i.id, i]));

    params.lines.forEach(l => {
      const item = itemsMap.get(l.itemId);
      const lineSub = l.quantity * l.unitPrice * (1 - ((l.discount || 0) / 100));
      const lineVat = lineSub * (l.vatRate || 0);
      subtotal += lineSub;
      vatAmount += lineVat;

      // Free quantity price = 0, but included in COGS
      const totalUnits = l.quantity + (l.freeQuantity || 0);
      const unitCost = item?.standardCost || 50;
      cogsTotal += totalUnits * unitCost;
    });

    const totalAmount = subtotal + vatAmount;
    const totalAmountEGP = totalAmount * (params.currency === 'USD' ? params.exchangeRate : 1);
    const cogsTotalEGP = cogsTotal * (params.currency === 'USD' ? params.exchangeRate : 1);

    // Credit limit warning check (DO NOT BLOCK SALE)
    let creditWarning: string | undefined;
    if (params.paymentMethod === 'credit' && customer.creditLimit > 0) {
      const newExpectedBalance = (customer.currentBalance || 0) + totalAmount;
      if (newExpectedBalance > customer.creditLimit) {
        creditWarning = `تنبيه ائتماني: العميل تجاوز الحد الائتماني المسموح به (${customer.creditLimit.toLocaleString('ar-EG')} ج.م) وسيصبح رصيده (${newExpectedBalance.toLocaleString('ar-EG')} ج.م). تم السماح بالبيع وفق سياسة النظام.`;
      }
    }

    const invCount = db.salesInvoices.length + 1;
    const invoiceNumber = `SINV-${new Date().getFullYear()}-${String(invCount).padStart(5, '0')}`;
    const invoiceId = `sinv-${Date.now()}`;

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
    const finishedInvAcc = AccountingEngine.getMappedAccountId(params.channel === 'export' ? 'inventory_finished_export' : 'inventory_finished_local', 'acc-1109');

    const subtotalEGP = subtotal * (params.currency === 'USD' ? params.exchangeRate : 1);
    const vatEGP = vatAmount * (params.currency === 'USD' ? params.exchangeRate : 1);

    const journalLines = [
      // 1. Revenue side
      {
        id: '',
        journalEntryId: '',
        accountId: debitAcc,
        accountCode: debitAcc === 'acc-1101' ? '1101' : debitAcc === 'acc-1102' ? '1102' : '1105',
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
        accountCode: params.channel === 'export' ? '1110' : '1109',
        accountNameAr: params.channel === 'export' ? 'مخزون الإنتاج التام - تصدير' : 'مخزون الإنتاج التام - محلي',
        debit: 0,
        credit: cogsTotalEGP,
        currency: 'EGP' as const,
        originalAmount: cogsTotalEGP,
        exchangeRate: 1,
        costCenterId: params.channel === 'export' ? 'cc-export' : 'cc-sales',
        description: `صرف مخزون إنتاج تام لفاتورة ${invoiceNumber}`,
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

    // Perpetual Stock Deduction
    params.lines.forEach(line => {
      const item = itemsMap.get(line.itemId);
      const totalQty = line.quantity + (line.freeQuantity || 0);
      InventoryEngine.recordMovement({
        itemId: line.itemId,
        warehouseId: params.warehouseId,
        movementType: 'sales',
        quantityIn: 0,
        quantityOut: totalQty,
        unitCost: item?.standardCost || 50,
        documentType: 'فاتورة مبيعات',
        documentNumber: invoiceNumber,
        notes: `مبيعات للعميل ${customer.name}${line.freeQuantity ? ` (منها ${line.freeQuantity} بونص مجاني)` : ''}`,
      });
    });

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
        repId: params.repId,
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
      };

      draft.salesInvoices.push(createdInvoice);

      // Lines
      params.lines.forEach((l, idx) => {
        const item = itemsMap.get(l.itemId);
        const lSub = l.quantity * l.unitPrice * (1 - ((l.discount || 0) / 100));
        const lVat = lSub * (l.vatRate || 0);

        draft.salesInvoiceLines.push({
          id: `sinvl-${invoiceId}-${idx + 1}`,
          invoiceId,
          itemId: l.itemId,
          batchId: l.batchId,
          quantity: l.quantity,
          freeQuantity: l.freeQuantity || 0,
          unitPrice: l.unitPrice,
          unitCost: item?.standardCost || 50,
          discount: l.discount || 0,
          vatRate: l.vatRate,
          vatAmount: lVat,
          totalBeforeVat: lSub,
          netTotal: lSub + lVat,
        });
      });

      // Audit Log
      draft.auditLogs.push({
        id: `aud-${Date.now()}`,
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
  }): { success: boolean; payment?: Payment; error?: string } {
    const db = erpDb.getSnapshot();
    const customer = db.customers.find(c => c.id === params.customerId);
    if (!customer) return { success: false, error: 'العميل غير مسجل' };

    const paymentCount = db.payments.length + 1;
    const paymentNumber = `RCPT-${new Date().getFullYear()}-${String(paymentCount).padStart(5, '0')}`;
    const paymentId = `pmt-${Date.now()}`;
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
        chqId = `chq-${Date.now()}`;
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

      // Allocations
      if (params.allocatedInvoiceIds) {
        params.allocatedInvoiceIds.forEach(invId => {
          draft.paymentAllocations.push({
            id: `pa-${Date.now()}-${invId}`,
            paymentId,
            invoiceId: invId,
            invoiceType: 'sales',
            allocatedAmount: params.amount / params.allocatedInvoiceIds!.length,
          });
        });
      }

      // Audit Log
      draft.auditLogs.push({
        id: `aud-${Date.now()}`,
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
  }): { success: boolean; payment?: Payment; error?: string } {
    const db = erpDb.getSnapshot();
    const supplier = db.suppliers.find(s => s.id === params.supplierId);
    if (!supplier) return { success: false, error: 'المورد غير مسجل' };

    const paymentCount = db.payments.length + 1;
    const paymentNumber = `VMT-${new Date().getFullYear()}-${String(paymentCount).padStart(5, '0')}`;
    const paymentId = `pmt-${Date.now()}`;
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
        chqId = `chq-${Date.now()}`;
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

      // Audit Log
      draft.auditLogs.push({
        id: `aud-${Date.now()}`,
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

    const count = db.representativeCustodies.length + 1;
    const custodyNumber = `CUST-${new Date().getFullYear()}-${String(count).padStart(4, '0')}`;
    const newCustody: RepresentativeCustody = {
      id: `cst-${Date.now()}`,
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
      quantityIn: 0,
      quantityOut: params.quantity,
      unitCost: item?.standardCost || 50,
      documentType: 'تحميل عهدة مندوب',
      documentNumber: custody.custodyNumber,
      notes: `تحميل بضاعة لعهدة ${custody.custodyNumber}`,
    });

    if (!moveRes.success) return moveRes;

    erpDb.mutate(draft => {
      draft.custodyMovements.push({
        id: `cstm-${Date.now()}`,
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

    InventoryEngine.recordMovement({
      itemId: params.itemId,
      warehouseId: params.warehouseId,
      movementType: 'rep_return',
      quantityIn: params.quantity,
      quantityOut: 0,
      unitCost: item?.standardCost || 50,
      documentType: 'مرتجع عهدة مندوب',
      documentNumber: custody.custodyNumber,
      notes: `مرتجع بضاعة من عهدة ${custody.custodyNumber}`,
    });

    erpDb.mutate(draft => {
      draft.custodyMovements.push({
        id: `cstm-${Date.now()}`,
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

    const inspId = `qi-${Date.now()}`;
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
        id: `aud-${Date.now()}`,
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
}
