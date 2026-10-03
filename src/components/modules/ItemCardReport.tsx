// F18 — ITEM CARD / كارت الصنف.
//
// A read-only projection of the EXISTING inventory movement ledger
// (InventoryEngine.getItemCard) — there is no second inventory engine here.
// Opening balance, every movement type, running balance, unit cost and value,
// with an explicit reconciliation against the real on-hand quantity.
import React, { useMemo, useState } from 'react';
import { erpDb } from '../../services/db';
import { InventoryEngine } from '../../services/inventory';
import { printDocument } from '../printUtils';
import { Printer, AlertTriangle, FileText } from 'lucide-react';

const fmtQty = (v: number) => (Number(v) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
const fmtMoney = (v: number) => (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ItemCardReport: React.FC = () => {
  const db = erpDb.getSnapshot();
  const today = new Date().toISOString().split('T')[0];
  const [itemId, setItemId] = useState(db.items[0]?.id || '');
  const [warehouseId, setWarehouseId] = useState('all');
  const [fromDate, setFromDate] = useState(`${new Date().getFullYear()}-01-01`);
  const [toDate, setToDate] = useState(today);
  const [openDoc, setOpenDoc] = useState<string | null>(null);

  const card = useMemo(
    () => (itemId ? InventoryEngine.getItemCard({ itemId, warehouseId, fromDate, toDate }) : null),
    [itemId, warehouseId, fromDate, toDate, db]
  );

  if (!card) return null;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">الصنف</label>
          <select
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
            className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
          >
            {db.items.map(i => (
              <option key={i.id} value={i.id}>{i.code} — {i.nameAr}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">المستودع</label>
          <select
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
          >
            <option value="all">كافة المستودعات</option>
            {db.warehouses.map(w => (
              <option key={w.id} value={w.id}>{w.code} — {w.nameAr}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">من تاريخ</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
            className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs" />
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">إلى تاريخ</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
            className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs" />
        </div>
        <div className="flex items-end">
          <button
            onClick={printDocument}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-slate-900 text-white font-bold text-xs"
          >
            <Printer className="w-4 h-4" /> طباعة الكارت
          </button>
        </div>
      </div>

      {/* Reconciliation banner — never hide a mismatch (F18). */}
      {Math.abs(card.mismatch) > 0.000001 && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-rose-50 border border-rose-300 text-rose-800 text-xs font-bold">
          <AlertTriangle className="w-4 h-4" />
          <span>
            فرق جرد حقيقي: رصيد الكارت الختامي {fmtQty(card.closingBalance)} {card.unitNameAr} مقابل الرصيد الفعلي بالمخزون
            {' '}{fmtQty(card.actualBalance)} {card.unitNameAr} — الفرق {fmtQty(card.mismatch)} {card.unitNameAr}
          </span>
        </div>
      )}

      {/* Printable card */}
      <div className="print-area bg-white rounded-2xl border border-slate-200 shadow-xs p-4 overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3 print:hidden">
          <h3 className="text-sm font-black text-slate-900">
            كارت صنف: {card.itemNameAr} ({card.itemCode})
          </h3>
          <span className="text-[11px] text-slate-500">
            {card.warehouseNameAr} · من {card.fromDate} إلى {card.toDate}
          </span>
        </div>

        <div className="print-doc">
          <div className="text-center border-b-2 border-slate-900 pb-2 mb-3">
            <div className="text-base font-black">{db.company.nameAr}</div>
            <div className="text-xs">كارت صنف (Item Card) — الرقم الضريبي: {db.company.taxNumber || '—'}</div>
          </div>

          <div className="flex flex-wrap justify-between gap-2 text-xs font-bold mb-2">
            <span>الصنف: {card.itemNameAr} ({card.itemCode})</span>
            <span>المستودع: {card.warehouseNameAr}</span>
            <span>الوحدة: {card.unitNameAr}</span>
            <span>الفترة: من {card.fromDate} إلى {card.toDate}</span>
          </div>

          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b-2 border-slate-800 text-slate-700">
                <th className="py-1.5 px-1 text-right">التاريخ</th>
                <th className="py-1.5 px-1 text-right">رقم المستند</th>
                <th className="py-1.5 px-1 text-right">نوع الحركة</th>
                <th className="py-1.5 px-1 text-right">المستودع</th>
                <th className="py-1.5 px-1 text-center">وارد</th>
                <th className="py-1.5 px-1 text-center">منصرف</th>
                <th className="py-1.5 px-1 text-center">الرصيد</th>
                <th className="py-1.5 px-1 text-center">تكلفة الوحدة</th>
                <th className="py-1.5 px-1 text-left">القيمة</th>
                <th className="py-1.5 px-1 text-center print:hidden">المستند</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-slate-300 bg-slate-50 font-bold">
                <td className="py-1.5 px-1" colSpan={4}>رصيد افتتاحي</td>
                <td className="py-1.5 px-1 text-center">—</td>
                <td className="py-1.5 px-1 text-center">—</td>
                <td className="py-1.5 px-1 text-center">{fmtQty(card.openingBalance)}</td>
                <td className="py-1.5 px-1 text-center">—</td>
                <td className="py-1.5 px-1 text-left">—</td>
                <td className="print:hidden" />
              </tr>
              {card.rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-6 text-center text-slate-400">لا توجد حركات مخزنية في الفترة المحددة</td>
                </tr>
              )}
              {card.rows.map(r => (
                <tr key={r.transactionId} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="py-1.5 px-1">{r.date}</td>
                  <td className="py-1.5 px-1 font-mono">{r.documentNumber}</td>
                  <td className="py-1.5 px-1">{r.movementLabelAr}</td>
                  <td className="py-1.5 px-1">{r.warehouseNameAr}</td>
                  <td className="py-1.5 px-1 text-center font-mono text-emerald-700">{r.quantityIn ? fmtQty(r.quantityIn) : '—'}</td>
                  <td className="py-1.5 px-1 text-center font-mono text-rose-700">{r.quantityOut ? fmtQty(r.quantityOut) : '—'}</td>
                  <td className="py-1.5 px-1 text-center font-mono font-bold">{fmtQty(r.runningBalance)}</td>
                  <td className="py-1.5 px-1 text-center font-mono">{fmtMoney(r.unitCost)}</td>
                  <td className="py-1.5 px-1 text-left font-mono">{fmtMoney(r.value)}</td>
                  <td className="py-1.5 px-1 text-center print:hidden">
                    {r.link && (
                      <button
                        onClick={() => setOpenDoc(r.documentNumber)}
                        title="فتح المستند المصدر"
                        className="text-indigo-600 hover:text-indigo-800"
                      >
                        <FileText className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-slate-800 font-black">
                <td className="py-1.5 px-1" colSpan={4}>الإجمالي / الرصيد الختامي</td>
                <td className="py-1.5 px-1 text-center">{fmtQty(card.totalIn)}</td>
                <td className="py-1.5 px-1 text-center">{fmtQty(card.totalOut)}</td>
                <td className="py-1.5 px-1 text-center">{fmtQty(card.closingBalance)}</td>
                <td className="py-1.5 px-1 text-center">—</td>
                <td className="py-1.5 px-1 text-left">{fmtMoney(card.closingValue)}</td>
                <td className="print:hidden" />
              </tr>
            </tbody>
          </table>

          <div className="mt-2 text-[11px] font-bold">
            الرصيد الفعلي بالمخزون (التشغيلات): {fmtQty(card.actualBalance)} {card.unitNameAr} ·
            قيمة المخزون الحالية: {fmtMoney(card.closingValue)} ج.م ·
            {Math.abs(card.mismatch) > 0.000001
              ? ` فرق غير مغطى: ${fmtQty(card.mismatch)} ${card.unitNameAr}`
              : ' المطابقة سليمة (الرصيد الختامي = الرصيد الفعلي)'}
          </div>
        </div>
      </div>

      {openDoc && (
        <div className="text-[11px] text-slate-600 bg-slate-100 rounded-xl p-3">
          رقم المستند المصدر: <b className="font-mono">{openDoc}</b> — يتم فتح المستند من الشاشة المقابلة
          (المبيعات / المشتريات / الإنتاج / المخازن).
          <button onClick={() => setOpenDoc(null)} className="mr-2 text-slate-400 hover:text-slate-700">✕</button>
        </div>
      )}
    </div>
  );
};

export default ItemCardReport;
