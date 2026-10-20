// F-WH — details of a SAVED sales invoice (read back from the store, not from
// the creation form state). Rendered in the "view invoice" modal so the
// withholding preview (1% rate, pre-VAT base, amount) is visible after saving
// and is not limited to the create/preview screen.
import React from 'react';
import { erpDb } from '../services/db';
import { WithholdingSummary } from './withholdingSummary';

const fmt = (value: number) =>
  (Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Resolve an invoice line item's configured base-unit display name. */
function itemUnitLabel(db: ReturnType<typeof erpDb.getSnapshot>, itemId?: string): string {
  if (itemId) {
    const itm = db.items.find((i) => i.id === itemId);
    if (itm?.baseUnitId) {
      const u = db.units.find((u) => u.id === itm.baseUnitId);
      if (u?.nameAr) return u.nameAr;
    }
  }
  return 'قطعة';
}

export const SalesInvoiceDetails: React.FC<{ invoiceId: string }> = ({ invoiceId }) => {
  const db = erpDb.getSnapshot();
  const invoice = db.salesInvoices.find((i) => i.id === invoiceId);
  if (!invoice) {
    return <div className="py-6 text-center text-xs font-bold text-slate-500">لا توجد فاتورة محفوظة بهذا الرقم</div>;
  }

  const lines = db.salesInvoiceLines.filter((l) => l.invoiceId === invoice.id);
  const customer = db.customers.find((c) => c.id === invoice.customerId);
  const currency = invoice.currency;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-slate-50 p-3 rounded-xl border border-slate-200">
        <div>
          <span className="text-slate-400 block">التاريخ:</span>
          <span className="font-bold text-slate-800">{invoice.date}</span>
        </div>
        <div>
          <span className="text-slate-400 block">العميل:</span>
          <span className="font-bold text-slate-800">{customer?.name || invoice.customerId}</span>
        </div>
        <div>
          <span className="text-slate-400 block">القناة:</span>
          <span className="font-bold text-slate-800">{invoice.channel}</span>
        </div>
        <div>
          <span className="text-slate-400 block">القيمة الإجمالية:</span>
          <span className="font-black text-slate-900 font-mono">
            {invoice.totalAmount.toLocaleString('ar-EG')} {currency}
          </span>
        </div>
      </div>

      <div className="border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-right text-xs">
          <thead className="bg-slate-100 text-slate-700">
            <tr>
              <th className="p-2">الصنف</th>
              <th className="p-2 text-center">الكمية المباعة</th>
              <th className="p-2 text-center">بونص مجاني</th>
              <th className="p-2 text-center">سعر الوحدة</th>
              <th className="p-2 text-left">الإجمالي</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map((line) => {
              const itm = db.items.find((i) => i.id === line.itemId);
              return (
                <tr key={line.id}>
                  <td className="p-2 font-bold">{itm?.nameAr || line.itemId}</td>
                  <td className="p-2 text-center font-mono">{line.quantity} {itemUnitLabel(db, line.itemId)}</td>
                  <td className="p-2 text-center font-mono text-emerald-700 font-bold">{line.freeQuantity || 0}</td>
                  <td className="p-2 text-center font-mono">{line.unitPrice}</td>
                  <td className="p-2 text-left font-mono font-black">{line.netTotal.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* VAT and total come from the saved invoice: the withholding preview is
          displayed below them and never changes either figure. */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-600">الإجمالي قبل الضريبة (وعاء ض.ق.م):</span>
          <b className="font-mono">{fmt(invoice.subtotal)} {currency}</b>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-600">ضريبة القيمة المضافة:</span>
          <b className="font-mono">{fmt(invoice.vatAmount)} {currency}</b>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-600">إجمالي الفاتورة (بدون خصم المنبع):</span>
          <b className="font-mono text-sm">{fmt(invoice.totalAmount)} {currency}</b>
        </div>
      </div>

      <WithholdingSummary
        rate={invoice.withholdingRate}
        amount={invoice.withholdingAmount}
        base={Number(invoice.withholdingBase) || invoice.subtotal}
        currency={currency}
        reason={invoice.withholdingReason}
      />
    </>
  );
};
