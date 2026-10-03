// F19 — DEDICATED printable invoice template (browser print / "Save as PDF").
//
// This is a real document layout, NOT a dump of the application page:
//   company name / info / tax number · invoice number · date · customer +
//   customer tax number · sales channel · warehouse or stock source · items ·
//   quantity · unit · unit price · BONUS (بونص مجاني, zero price) · discount ·
//   VAT · subtotal · total · currency (EGP / USD).
//
// Only the `.print-area` below reaches the printer (see printDocument() and the
// @media print block in src/index.css) — the sidebar, header and every button in
// the application are hidden.
import React from 'react';
import { erpDb } from '../../services/db';
import { printDocument } from '../printUtils';
import { SalesInvoice, SalesInvoiceLine, PurchaseInvoice, PurchaseInvoiceLine } from '../../types/erp';
import { Printer, X } from 'lucide-react';

const CHANNEL_AR: Record<string, string> = {
  retail: 'تجزئة', wholesale: 'جملة', export: 'تصدير',
};
const PAYMENT_AR: Record<string, string> = {
  cash: 'نقدي', credit: 'آجل', bank_transfer: 'تحويل بنكي', cheque: 'شيك',
};

const InvoicePrint: React.FC<{
  invoiceId?: string;
  /** For a purchase invoice, the related purchase doc id. Optional; if absent we
   *  search sales invoices. Used to disambiguate the print target. */
  purchaseInvoiceId?: string;
  onClose: () => void;
}> = ({ invoiceId, purchaseInvoiceId, onClose }) => {
  const db = erpDb.getSnapshot();

  const sales = db.salesInvoices.find((i) => i.id === invoiceId) || null;
  const purchase = purchaseInvoiceId
    ? db.purchaseInvoices.find((p) => p.id === purchaseInvoiceId) || null
    : null;
  const isPurchase = !sales && Boolean(purchase);
  const inv = (sales || purchase) as SalesInvoice | PurchaseInvoice | null;

  // Screen: a full-screen preview overlay. Print: only `.print-area` survives.
  const wrap = (children: React.ReactNode) => (
    <div className="print-area fixed inset-0 z-[60] overflow-y-auto bg-slate-100 p-4">
      {/* ---------- DOCUMENT ---------- */}
      <div className="print-doc max-w-3xl mx-auto bg-white p-6 shadow-xl border border-slate-200">
        <div className="text-center border-b-4 border-slate-900 pb-3">
          <div className="text-2xl font-black">{db.company.nameAr}</div>
          <div className="text-sm">{db.company.nameEn}</div>
          <div className="text-xs mt-1">
            {db.company.address}
            {db.company.phone ? ` · هاتف: ${db.company.phone}` : ''}
          </div>
          <div className="text-xs">
            الرقم الضريبي: {db.company.taxNumber || '—'}
            {db.company.commercialRegister ? ` · السجل التجاري: ${db.company.commercialRegister}` : ''}
          </div>
        </div>

        <div className="flex justify-between items-end py-3 border-b border-slate-400">
          <div className="text-lg font-black">
            {isPurchase ? 'فاتورة مشتريات' : 'فاتورة مبيعات'}
            {sales?.channel ? ` — ${CHANNEL_AR[sales.channel] || ''}` : ''}
          </div>
          <div className="text-sm font-bold">
            رقم المستند: {sales?.invoiceNumber || (purchase as PurchaseInvoice)?.invoiceNumber || '—'}
          </div>
        </div>

        {children}
      </div>

      {/* ---------- SCREEN CHROME (never printed) ---------- */}
      <div className="flex items-center justify-between bg-slate-900 text-slate-100 px-4 py-2 text-xs mt-3 print:hidden">
        <span className="flex items-center gap-2">
          <Printer className="w-4 h-4" />
          {isPurchase ? 'فاتورة مشتريات — معاينة الطباعة' : 'فاتورة مبيعات — معاينة الطباعة'}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={printDocument}
            className="px-3 py-1 rounded-lg bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs"
          >
            طباعة / حفظ PDF
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold inline-flex items-center gap-1"
          >
            <X className="w-3 h-3" /> إغلاق
          </button>
        </div>
      </div>
    </div>
  );

  if (!inv) {
    return wrap(<div className="py-10 text-center">لا توجد فاتورة لطباعتها</div>);
  }

  const fmt = (v: number) => (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  if (isPurchase && purchase) {
    const pLines = db.purchaseInvoiceLines.filter(l => l.purchaseInvoiceId === purchase.id);
    const supplier = db.suppliers.find(s => s.id === purchase.supplierId);
    return wrap(
      <>
        <div className="grid grid-cols-2 gap-2 text-xs py-2">
          <div>المورد: <b>{supplier?.name || '—'}</b></div>
          <div>التاريخ: <b>{purchase.date}</b></div>
          <div>الرقم الضريبي للمورد: {supplier?.taxNumber || '—'}</div>
          <div>المستودع: {db.warehouses.find(w => w.id === purchase.warehouseId)?.nameAr || purchase.warehouseId}</div>
          <div>طريقة الدفع: {PAYMENT_AR[purchase.paymentMethod] || purchase.paymentMethod}</div>
          <div>العملة: {purchase.currency}</div>
        </div>
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b-2 border-slate-800">
              <th className="py-1.5 text-right">الصنف</th>
              <th className="py-1.5 text-center">الكمية</th>
              <th className="py-1.5 text-center">الوحدة</th>
              <th className="py-1.5 text-right">سعر الوحدة</th>
              <th className="py-1.5 text-right">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {pLines.map(l => (
              <tr key={l.id} className="border-b border-slate-300">
                <td className="py-1.5">{db.items.find(i => i.id === l.itemId)?.nameAr || l.itemId}</td>
                <td className="py-1.5 text-center">{l.quantity}</td>
                <td className="py-1.5 text-center">{db.units.find(u => u.id === l.unitId)?.nameAr || ''}</td>
                <td className="py-1.5 text-right font-mono">{fmt(l.unitPrice)}</td>
                <td className="py-1.5 text-right font-mono">{fmt(l.netTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 text-xs space-y-1">
          <div>الإجمالي قبل الضريبة: {fmt(purchase.subtotal)} {purchase.currency}</div>
          <div>ضريبة القيمة المضافة: {fmt(purchase.vatAmount)} {purchase.currency}</div>
          <div className="text-base font-black">الإجمالي النهائي: {fmt(purchase.totalAmount)} {purchase.currency}</div>
        </div>
      </>
    );
  }

  // ---- SALES INVOICE ----
  const s = inv as SalesInvoice;
  const sLines = db.salesInvoiceLines.filter(l => l.invoiceId === s.id) as SalesInvoiceLine[];
  const customer = db.customers.find(c => c.id === s.customerId);
  const warehouse = db.warehouses.find(w => w.id === s.warehouseId);
  const custody = s.custodyId ? db.representativeCustodies.find(c => c.id === s.custodyId) : undefined;
  const rep = custody ? db.salesReps.find(r => r.id === custody!.repId) : (s.repId ? db.salesReps.find(r => r.id === s.repId) : undefined);
  const bonusTotal = sLines.reduce((sum, l) => sum + (l.freeQuantity || 0), 0);
  // QA-29: the promotional bonus is issued at ZERO price. Multiplying it by the
  // paid unit price produced the contradictory wording "free bonus ... worth
  // 150.00" — the printed value is always 0.00, in the document currency.
  const bonusValue = 0;
  const bonusUnitAr = sLines.length
    ? (db.units.find(u => u.id === db.items.find(i => i.id === sLines[0].itemId)?.baseUnitId)?.nameAr || 'PCS')
    : 'PCS';

  return wrap(
    <>
      <div className="grid grid-cols-2 gap-2 text-xs py-2">
        <div>العميل: <b>{customer?.name || '—'}</b></div>
        <div>تاريخ الفاتورة: <b>{s.date}</b></div>
        <div>الرقم الضريبي للعميل: {customer?.taxNumber || '—'}</div>
        <div>القناة البيعية: <b>{CHANNEL_AR[s.channel] || s.channel}</b></div>
        <div>
          مصدر الصرف: <b>{s.stockSource === 'rep_custody' ? `عهدة مندوب${rep ? ` (${rep.name})` : ''}${custody ? ` — ${custody.custodyNumber}` : ''}` : `مستودع — ${warehouse?.nameAr || s.warehouseId}`}</b>
        </div>
        <div>طريقة الدفع: <b>{PAYMENT_AR[s.paymentMethod] || s.paymentMethod}</b> · العملة: <b>{s.currency}</b></div>
      </div>

      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b-2 border-slate-800">
            <th className="py-1.5 text-right">الصنف</th>
            <th className="py-1.5 text-center">الكمية</th>
            <th className="py-1.5 text-center">بونص مجاني</th>
            <th className="py-1.5 text-center">الوحدة</th>
            <th className="py-1.5 text-right">سعر الوحدة</th>
            <th className="py-1.5 text-right">الخصم %</th>
            <th className="py-1.5 text-right">ضريبة %</th>
            <th className="py-1.5 text-right">الإجمالي</th>
          </tr>
        </thead>
        <tbody>
          {sLines.map((l) => {
            const item = db.items.find(i => i.id === l.itemId);
            return (
              <tr key={l.id} className="border-b border-slate-300 align-top">
                <td className="py-1.5">{item?.nameAr || l.itemId}</td>
                <td className="py-1.5 text-center font-mono">{l.quantity}</td>
                <td className="py-1.5 text-center font-mono">
                  {l.freeQuantity ? (
                    <span>
                      {l.freeQuantity}
                      <span className="block text-[10px]">بونص مجاني</span>
                    </span>
                  ) : '—'}
                </td>
                <td className="py-1.5 text-center">{db.units.find(u => u.id === item?.baseUnitId)?.nameAr || ''}</td>
                <td className="py-1.5 text-right font-mono">{fmt(l.unitPrice)}</td>
                <td className="py-1.5 text-right font-mono">{l.discount || 0}</td>
                <td className="py-1.5 text-right font-mono">{Math.round((l.vatRate || 0) * 100)}%</td>
                <td className="py-1.5 text-right font-mono font-bold">{fmt(l.totalBeforeVat)}</td>
              </tr>
            );
          })}
          {/* F17: the bonus is shown explicitly with a zero price and zero value. */}
          {bonusTotal > 0 && (
            <tr className="border-b-2 border-slate-800">
              <td className="py-1.5 font-bold">إجمالي البونص المجاني</td>
              <td className="py-1.5 text-center font-mono">{bonusTotal}</td>
              <td className="py-1.5 text-center font-bold">بونص مجاني</td>
              <td className="py-1.5 text-center">{bonusUnitAr}</td>
              <td className="py-1.5 text-right font-mono font-bold">0.00</td>
              <td />
              <td className="py-1.5 text-right font-mono">0%</td>
              <td className="py-1.5 text-right font-mono font-bold">0.00</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="mt-3 text-xs space-y-1">
        <div>الإجمالي قبل الضريبة: <b>{fmt(s.subtotal)}</b> {s.currency}</div>
        <div>بونص مجاني — {bonusTotal} {bonusUnitAr} — {fmt(bonusValue)} {s.currency === 'USD' ? 'USD' : 'EGP'} (قيمة صفر — لا يضاف للإيراد)</div>
        <div>الخصم: {fmt(s.discountAmount || 0)} {s.currency}</div>
        <div>ضريبة القيمة المضافة ({Math.round((s.vatAmount && s.subtotal ? (s.vatAmount / s.subtotal) * 100 : 0))}%): {fmt(s.vatAmount)} {s.currency}</div>
        {s.currency === 'USD' && (
          <div>سعر الصرف: {s.exchangeRate} · الإجمالي بالجنيه: {fmt(s.totalAmountEGP)} ج.م</div>
        )}
        <div className="text-base font-black">الإجمالي النهائي: {fmt(s.totalAmount)} {s.currency === 'USD' ? 'USD' : 'EGP'}</div>
        {s.notes ? <div className="pt-1">ملاحظات: {s.notes}</div> : null}
      </div>
    </>
  );
};

export default InvoicePrint;
