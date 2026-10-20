// F-WH — shared presentation block for the withholding income tax preview.
//
// One component is used by BOTH the saved-invoice details screen (after saving)
// and the print/preview template, so the rate, the pre-VAT base and the amount
// can never drift between what was saved and what is printed.
//
// Presentation only: no calculation and no posting. The amount is informational
// and is NOT part of totalAmount, VAT or revenue — the note below says so on the
// document itself so a reader never assumes it was added to the invoice total.
import React from 'react';

const fmt = (value: number) =>
  (Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const WithholdingSummary: React.FC<{
  /** Fraction stored on the invoice (0.01 = 1%). */
  rate?: number;
  /** Preview amount stored on the invoice; 0/absent means not applicable. */
  amount?: number;
  /** Subtotal BEFORE VAT — the base the percentage is applied to. */
  base?: number;
  currency?: string;
  reason?: string;
  className?: string;
}> = ({ rate, amount, base, currency = 'EGP', reason, className = '' }) => {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return null;

  const rateValue = Number(rate);
  const rateLabel = Number.isFinite(rateValue) && rateValue > 0 ? `${(rateValue * 100).toFixed(2)}%` : '—';
  const baseValue = Number(base);
  const hasBase = Number.isFinite(baseValue) && baseValue > 0;

  return (
    <div className={`rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 ${className}`}>
      <div className="font-black">
        خصم تحت حساب ضريبة الدخل (خصم من المنبع) — {reason || 'تقديري'}
      </div>
      <div className="mt-1 grid grid-cols-1 sm:grid-cols-3 gap-x-3 gap-y-1 font-mono">
        <div>النسبة: <b>{rateLabel}</b></div>
        <div>وعاء الحساب قبل ض.ق.م: <b>{hasBase ? fmt(baseValue) : '—'} {currency}</b></div>
        <div>قيمة الخصم: <b>{fmt(value)} {currency}</b></div>
      </div>
      <div className="mt-1 text-[11px] leading-relaxed">
        لا يُضاف إلى إجمالي المبيعات، ولا يغيّر ضريبة القيمة المضافة أو إجمالي الفاتورة — يُوثَّق بشهادة عند التحصيل.
      </div>
    </div>
  );
};
