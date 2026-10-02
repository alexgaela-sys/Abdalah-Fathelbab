// F7 — Printable invoice document (browser print / PDF via window.print()).
// Reusable for both sales and purchase invoices. Read-only projection over erpDb.
// The application shell is hidden during print via the @media print block in
// src/index.css (a .print-hidden wrapper on the app chrome is hidden, while the
// .print-only document is the only thing that lands on the page).
import React from 'react';
import { erpDb } from '../../services/db';
import { SalesInvoice, SalesInvoiceLine, PurchaseInvoice, PurchaseInvoiceLine } from '../../types/erp';
import { Printer } from 'lucide-react';

const InvoicePrint: React.FC<{
  invoiceId?: string;
  /** For a purchase invoice, the related purchase doc id. Optional; if absent we
   *  search sales invoices. Used to disambiguate the print target. */
  purchaseInvoiceId?: string;
  onClose: () => void;
}> = ({ invoiceId, purchaseInvoiceId, onClose }) => {
  const db = erpDb.getSnapshot();

  // Prefer a sales invoice by id, then a purchase invoice by id, then fall back to
  // the first pending/posted invoice if no explicit id was supplied (print modal).
  const sales = db.salesInvoices.find((i) => i.id === invoiceId) || null;
  const purchase = purchaseInvoiceId
    ? db.purchaseInvoices.find((p) => p.id === purchaseInvoiceId) || null
    : null;

  // If an explicit purchase id was given, print the purchase invoice.
  const printInvoice = (purchase?.id ? purchase : sales) as
    | (SalesInvoice & { lines: SalesInvoiceLine[] })
    | (PurchaseInvoice & { lines: PurchaseInvoiceLine[] })
    | null;

  const isPurchase = Boolean(printInvoice && !sales);
  const company = db.company;

  /** Narrow printInvoice to SalesInvoice or PurchaseInvoice. */
  function isSales(inv: (SalesInvoice & { lines: SalesInvoiceLine[] })
    | (PurchaseInvoice & { lines: PurchaseInvoiceLine[] })): inv is SalesInvoice & { lines: SalesInvoiceLine[] } {
    return 'invoiceNumber' in inv;
  }

  const fmt = (v: number) =>
    v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Return early if no document
  if (!printInvoice) {
    return (
      <div className="print-area">
        <div className="print-only">
          <div className="h-screen flex items-center justify-center text-center">
            <Printer className="w-12 h-12 text-slate-300 mx-auto" />
            <p className="mt-4 text-slate-400">لا توجد فاتورة لطباعتها</p>
          </div>
        </div>
      </div>
    );
  }

  // Collect lines
  const lines = isPurchase
    ? (printInvoice as PurchaseInvoice & { lines: PurchaseInvoiceLine[] }).lines || []
    : (printInvoice as SalesInvoice & { lines: SalesInvoiceLine[] }).lines || [];

  return (
    <div className="print-area">
      {/* Print-only document body (visible only during print) */}
      <div className="print-only">
        <div className="h-screen flex flex-col">
          {/* Left: document contents */}
          <div className="w-96 ml-8 flex flex-col">
            {/* Company / sender header */}
            <div className="border-b-2 border-slate-800 pb-3 mb-4 space-y-1">
              <div className="text-xs text-slate-500 uppercase tracking-widest">
                شركة عبد الله للصناعات الغذائية (ش.م.م)
              </div>
              <div className="text-lg font-black text-slate-900">{company.nameAr}</div>
              <div className="text-xs text-slate-600">
                {company.address} · {company.phone}
              </div>
              {company.taxNumber && (
                <div className="text-xs text-slate-500">
                  الرقم الضريبي: {company.taxNumber}
                </div>
              )}
              {company.commercialRegister && (
                <div className="text-xs text-slate-500">
                  السجل التجاري: {company.commercialRegister}
                </div>
              )}
            </div>

            {/* Invoice meta */}
            <div className="border-b-2 border-slate-800 pb-3 mb-4">
              <div className="flex justify-between items-baseline">
                <span className="text-xs text-slate-500 uppercase">
                  {isPurchase ? 'فاتورة شراء' : 'فاتورة مبيعات'}
                </span>
                <span className="font-mono text-sm font-bold text-slate-800">
                  {isSales(printInvoice) ? printInvoice.invoiceNumber : printInvoice.invoiceNumber}
                </span>
              </div>
              <div className="flex justify-between text-xs text-slate-600 mt-1">
                <span>{printInvoice.date}</span>
                <span>
                  {isPurchase ? 'المورد' : 'العميل'}:
                  {isPurchase
                    ? (db.suppliers.find(
                        (s) => s.id === (printInvoice as PurchaseInvoice).supplierId
                      ) ||
                        db.customers.find(
                          (c) => c.id === (printInvoice as PurchaseInvoice).supplierId
                        ))?.name
                    : db.customers.find(
                        (c) => c.id === (printInvoice as SalesInvoice).customerId
                      )?.name}
                </span>
              </div>
              {isPurchase && (
                <div className="flex justify-between text-xs text-slate-600 mt-1">
                  <span>
                    الرقم الضريبي للمورد:{' '}
                    {(db.suppliers.find(
                      (s) => s.id === (printInvoice as PurchaseInvoice).supplierId
                    ) ?? {}).taxNumber}
                  </span>
                  <span>صرف: {printInvoice.currency}</span>
                </div>
              )}
              {!isPurchase && (
                <div className="flex justify-between text-xs text-slate-600 mt-1">
                  <span>
                    {isSales(printInvoice)
                      ? ((printInvoice as SalesInvoice).channel === 'retail'
                          ? 'تجارة'
                          : (printInvoice as SalesInvoice).channel === 'wholesale'
                          ? 'جملة'
                          : 'تصدير')
                      : ''}{' '}
                  </span>
                  <span>الدفع: {printInvoice.paymentMethod}</span>
                </div>
              )}
            </div>

            {/* Lines */}
            <table className="w-full text-xs text-right border-collapse">
              <thead>
                <tr className="text-slate-500 border-b-2 border-slate-700">
                  <th className="py-2 pr-3 font-bold">الصنف</th>
                  {!isPurchase ? (
                    <th className="py-2 text-center pr-3 font-bold">الكمية</th>
                  ) : (
                    <th className="py-2 text-center pr-3 font-bold">الكمية المستلمة</th>
                  )}
                  <th className="py-2 text-right pr-3 font-bold">سعر الوحدة</th>
                  <th className="py-2 text-right font-bold">الإجمالي</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => {
                  const isPurchaseLine = isPurchase;
                  const lineData = (isPurchaseLine ? (line as any) : (line as any)) as
                    | PurchaseInvoiceLine
                    | SalesInvoiceLine;
                  const ld = isPurchaseLine ? (lineData as PurchaseInvoiceLine) : (lineData as SalesInvoiceLine);
                  const displayItem = (line as any).itemName || (line as any).itemId;
                  const displayQuantity = isPurchaseLine
                    ? ld.quantity
                    : ld.quantity;
                  const displayFree = isPurchaseLine
                    ? (ld as any).freeQuantity
                    : (ld as SalesInvoiceLine).freeQuantity;
                  const displayTotal = isPurchaseLine
                    ? fmt(ld.netTotal)
                    : fmt((ld as SalesInvoiceLine).totalBeforeVat);
                  return (
                    <tr key={i} className="border-b border-slate-200">
                      <td className="py-2 pr-3 font-medium">{displayItem}</td>
                      <td className="py-2 text-center">
                        {displayQuantity}
                        {displayFree ? ` (×${displayFree} مجاناً)` : ''}
                      </td>
                      <td className="py-2 text-right font-mono">{fmt(ld.unitPrice)}</td>
                      <td className="py-2 text-right font-mono font-black">{displayTotal}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Totals */}
            <div className="flex justify-end mt-4 space-x-4">
              {isPurchase ? (
                <>
                  <div className="text-right text-xs text-slate-500">
                    الإجمالي قبل الضريبة
                  </div>
                  <div className="text-right font-mono font-bold text-base">
                    {fmt((printInvoice as PurchaseInvoice).subtotal)} {printInvoice.currency}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-right text-xs text-slate-500">
                    الإجمالي قبل الضريبة
                  </div>
                  <div className="text-right font-mono font-bold text-base">
                    {fmt((printInvoice as SalesInvoice).subtotal)} {printInvoice.currency}
                  </div>
                </>
              )}
              {!isPurchase && (
                <>
                  <div className="text-right text-xs text-slate-500">
                    الضريبة {printInvoice.currency}
                  </div>
                  <div className="text-right font-mono font-bold text-base">
                    {fmt((printInvoice as SalesInvoice).vatAmount)} {printInvoice.currency}
                  </div>
                </>
              )}
              <div className="border-t-2 border-slate-800 pt-2 text-right">
                <div className="text-xs text-slate-500 uppercase">
                  الإجمالي النهائي
                </div>
                <div className="text-xl font-black text-slate-900">
                  {fmt((printInvoice as any).totalAmount)} {printInvoice.currency}
                </div>
              </div>
            </div>

            {/* Terms / payment */}
            <div className="mt-4 text-xs text-slate-500 space-y-1">
              <p>الدفع: {isSales(printInvoice) ? (printInvoice as SalesInvoice).paymentMethod : ''}</p>
              {!isSales(printInvoice) && (printInvoice as PurchaseInvoice).paymentTerms && (
                <p>شروط السداد: {(printInvoice as PurchaseInvoice).paymentTerms}</p>
              )}
              {isSales(printInvoice) && (printInvoice as SalesInvoice).notes && (
                <p>ملاحظات: {(printInvoice as SalesInvoice).notes}</p>
              )}
            </div>
          </div>

          {/* Right: decorative/footer mark */}
          <div className="w-96 mr-8 flex flex-col justify-center">
            <div className="border-2 border-slate-800 rounded-xl p-6 text-center space-y-2">
              <Printer className="w-10 h-10 text-slate-300 mx-auto" />
              <div className="text-xs text-slate-500 uppercase">إمبراطورية ضريبي</div>
              <div className="text-sm font-black text-slate-700">نظام إدارة</div>
              <div className="text-xs text-slate-400">شركة عبد الله للمصانع</div>
              <div className="text-xs text-slate-400">مصارف مصر</div>
            </div>
          </div>
        </div>
      </div>

      {/* Application chrome (hidden during print) */}
      <div className="print:hidden flex items-center justify-between bg-slate-950/50 text-slate-500 px-4 py-2 text-xs">
        <span className="flex items-center gap-2">
          <Printer className="w-4 h-4" />
          {isPurchase ? 'فاتورة شراء — طباعة' : 'فاتورة مبيعات — طباعة'}
        </span>
        <button
          onClick={onClose}
          className="px-3 py-1 rounded-lg bg-slate-800 text-white hover:bg-slate-700 text-xs font-bold"
        >
          إغلاق
        </button>
      </div>
    </div>
  );
};

export default InvoicePrint;
