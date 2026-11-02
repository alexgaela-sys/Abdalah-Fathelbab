import React, { useState } from 'react';
import { BookOpenCheck, Plus, Trash2 } from 'lucide-react';
import { erpDb } from '../../services/db';
import { OpeningBalanceService } from '../../services/openingBalances';
import { currencyForCustomerType } from '../../services/pricing';

type Tab = 'inventory' | 'customers' | 'suppliers';
type Row = { itemId: string; quantity: string; unitCost: string; batchNumber: string; expiryDate: string };
const emptyRow = (itemId = ''): Row => ({ itemId, quantity: '', unitCost: '', batchNumber: '', expiryDate: '' });
const fmt = (n: number) => n.toLocaleString('ar-EG', { maximumFractionDigits: 2 });

export const OpeningBalancesView: React.FC = () => {
  const [, setTick] = useState(0);
  const refresh = () => setTick(t => t + 1);
  const db = erpDb.getSnapshot();
  const [tab, setTab] = useState<Tab>('inventory');
  const [date, setDate] = useState('2026-06-30');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // inventory
  const [warehouseId, setWarehouseId] = useState('wh-raw');
  const warehouse = db.warehouses.find(w => w.id === warehouseId);
  const items = db.items.filter(i =>
    warehouse?.type === 'raw_materials' ? (i.itemType === 'raw_material' || i.itemType === 'packaging_material') : i.itemType === 'finished_product');
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const setRow = (idx: number, patch: Partial<Row>) => setRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const total = rows.reduce((s, r) => s + (Number(r.quantity) || 0) * (Number(r.unitCost) || 0), 0);

  const submitInventory = () => {
    const lines = rows.filter(r => r.itemId).map(r => ({
      itemId: r.itemId, quantity: Number(r.quantity), unitCost: Number(r.unitCost),
      batchNumber: r.batchNumber.trim() || undefined, expiryDate: r.expiryDate || undefined,
    }));
    const res = OpeningBalanceService.postInventoryOpening({ warehouseId, date, lines, userId: 'usr-admin', userName: 'المشرف العام (Admin)' });
    if (res.success) { setMsg({ ok: true, text: `تم ترحيل رصيد أول المدة (${fmt(res.totalValue || 0)} ج.م) — المرجع ${res.reference}` }); setRows([emptyRow()]); }
    else setMsg({ ok: false, text: res.error || 'تعذّر الترحيل' });
    refresh();
  };

  // customers / suppliers
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [rates, setRates] = useState<Record<string, string>>({});
  const defaultRate = String(db.company.currentUsdExchangeRate || '');
  const saveParty = (kind: 'customer' | 'supplier', id: string) => {
    const raw = amounts[id];
    if (raw === undefined || raw === '') return;
    const amount = Number(raw);
    const exchangeRate = Number(rates[id] || defaultRate) || undefined;
    const actor = { userId: 'usr-admin', userName: 'المشرف العام (Admin)' };
    const res = kind === 'customer'
      ? OpeningBalanceService.postCustomerOpening({ customerId: id, amount, date, exchangeRate, ...actor })
      : OpeningBalanceService.postSupplierOpening({ supplierId: id, amount, date, exchangeRate, ...actor });
    setMsg(res.success ? { ok: true, text: 'تم ترحيل الرصيد الافتتاحي' } : { ok: false, text: res.error || 'تعذّر الترحيل' });
    if (res.success) setAmounts(prev => { const n = { ...prev }; delete n[id]; return n; });
    refresh();
  };

  const importFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const pkg = JSON.parse(String(ev.target?.result));
        if (!confirm('استيراد ملف الأرصدة الافتتاحية؟ يُضاف على النظام الحالي ولا يغيّر المستخدمين أو الإعدادات، ويُسمح به على نظام فارغ فقط.')) return;
        const res = OpeningBalanceService.importPackage(pkg, { userId: 'usr-admin', userName: 'المشرف العام (Admin)' });
        setMsg(res.success ? { ok: true, text: `تم استيراد الأرصدة الافتتاحية: ${res.summary}` } : { ok: false, text: res.error || 'تعذّر الاستيراد' });
        refresh();
      } catch {
        setMsg({ ok: false, text: 'تعذّرت قراءة الملف — تأكد أنه ملف أرصدة افتتاحية بصيغة JSON' });
      }
    };
    reader.readAsText(file);
  };

  const equity = db.accounts.find(a => a.id === 'acc-3103')?.currentBalance || 0;

  const partyTable = (kind: 'customer' | 'supplier') => {
    const list = kind === 'customer' ? db.customers : db.suppliers;
    return (
      <div className="overflow-x-auto bg-white border border-slate-200 rounded-xl">
        <table className="w-full text-xs text-right">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="p-2.5">الكود</th><th className="p-2.5">الاسم</th><th className="p-2.5">العملة</th>
              <th className="p-2.5">الرصيد الافتتاحي الحالي</th><th className="p-2.5">الرصيد الافتتاحي الجديد</th>
              <th className="p-2.5">سعر الصرف</th><th className="p-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {list.map(p => {
              const ccy = kind === 'customer'
                ? currencyForCustomerType((p as typeof db.customers[number]).customerType)
                : (p as typeof db.suppliers[number]).currency;
              return (
                <tr key={p.id} className="border-t border-slate-100">
                  <td className="p-2.5 font-mono">{p.code}</td>
                  <td className="p-2.5 font-semibold">{p.name}</td>
                  <td className="p-2.5">{ccy}</td>
                  <td className="p-2.5 font-mono">{fmt(p.openingBalance || 0)}</td>
                  <td className="p-2.5">
                    <input type="number" step="0.01" value={amounts[p.id] ?? ''} onChange={e => setAmounts(prev => ({ ...prev, [p.id]: e.target.value }))}
                      className="w-32 p-1.5 rounded-lg border border-slate-300 font-mono" placeholder={kind === 'customer' ? 'مدين +' : 'دائن +'} />
                  </td>
                  <td className="p-2.5">
                    {ccy === 'USD'
                      ? <input type="number" step="0.01" value={rates[p.id] ?? defaultRate} onChange={e => setRates(prev => ({ ...prev, [p.id]: e.target.value }))} className="w-24 p-1.5 rounded-lg border border-slate-300 font-mono" />
                      : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="p-2.5">
                    <button onClick={() => saveParty(kind, p.id)} disabled={(amounts[p.id] ?? '') === ''}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold">ترحيل</button>
                  </td>
                </tr>
              );
            })}
            {list.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-400">لا توجد سجلات</td></tr>}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center gap-2">
        <BookOpenCheck className="w-5 h-5 text-indigo-600" />
        <h2 className="text-lg font-bold text-slate-900">أرصدة أول المدة</h2>
      </div>

      <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs leading-6">
        هنا فقط تُحمَّل أرصدة بداية التشغيل (مخزون، عملاء، موردون). كل رصيد يُرحَّل بقيد متوازن مقابل حساب
        <b> 3103 أرصدة أول المدة </b>(حقوق ملكية) — <b>لا يظهر ربحًا ولا خسارة</b>، وليس مشتريات ولا جردًا.
        لا تستخدم «تسوية الجرد» لتحميل رصيد افتتاحي. رصيد الحساب 3103 الحالي: <b>{fmt(equity)}</b> ج.م.
      </div>

      <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs flex flex-wrap items-center gap-3">
        <span className="font-bold text-slate-700">لديك ملف أرصدة جاهز؟</span>
        <label className="px-3 py-1.5 rounded-lg bg-white border border-slate-300 hover:bg-slate-100 cursor-pointer font-bold">
          استيراد ملف الأرصدة الافتتاحية (JSON)
          <input type="file" accept=".json,application/json" className="hidden" onChange={importFile} />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs font-bold text-slate-700">تاريخ بداية التشغيل (الرصيد في هذا التاريخ)</label>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} className="p-1.5 rounded-lg border border-slate-300 text-xs" />
        <div className="flex gap-1 mr-auto">
          {([['inventory', 'المخزون'], ['customers', 'العملاء'], ['suppliers', 'الموردون']] as Array<[Tab, string]>).map(([id, label]) => (
            <button key={id} onClick={() => { setTab(id); setMsg(null); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold ${tab === id ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>{label}</button>
          ))}
        </div>
      </div>

      {msg && <div className={`p-3 rounded-xl text-xs font-semibold border ${msg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>{msg.text}</div>}

      {tab === 'inventory' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <label className="text-xs font-bold text-slate-700">المستودع</label>
            <select value={warehouseId} onChange={e => { setWarehouseId(e.target.value); setRows([emptyRow()]); }} className="p-1.5 rounded-lg border border-slate-300 text-xs">
              {db.warehouses.map(w => <option key={w.id} value={w.id}>{w.nameAr}</option>)}
            </select>
          </div>
          <div className="overflow-x-auto bg-white border border-slate-200 rounded-xl">
            <table className="w-full text-xs text-right">
              <thead className="bg-slate-50 text-slate-600">
                <tr><th className="p-2.5">الصنف</th><th className="p-2.5">الكمية (وحدة الأساس)</th><th className="p-2.5">تكلفة الوحدة (ج.م)</th><th className="p-2.5">رقم التشغيلة</th><th className="p-2.5">تاريخ الانتهاء</th><th className="p-2.5">القيمة</th><th className="p-2.5"></th></tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => (
                  <tr key={idx} className="border-t border-slate-100">
                    <td className="p-2"><select value={r.itemId} onChange={e => setRow(idx, { itemId: e.target.value })} className="p-1.5 rounded-lg border border-slate-300 w-56">
                      <option value="">— اختر —</option>{items.map(i => <option key={i.id} value={i.id}>{i.nameAr}</option>)}</select></td>
                    <td className="p-2"><input type="number" step="0.001" value={r.quantity} onChange={e => setRow(idx, { quantity: e.target.value })} className="w-28 p-1.5 rounded-lg border border-slate-300 font-mono" /></td>
                    <td className="p-2"><input type="number" step="0.01" value={r.unitCost} onChange={e => setRow(idx, { unitCost: e.target.value })} className="w-28 p-1.5 rounded-lg border border-slate-300 font-mono" /></td>
                    <td className="p-2"><input value={r.batchNumber} onChange={e => setRow(idx, { batchNumber: e.target.value })} className="w-32 p-1.5 rounded-lg border border-slate-300 font-mono" placeholder="اختياري" /></td>
                    <td className="p-2"><input type="date" value={r.expiryDate} onChange={e => setRow(idx, { expiryDate: e.target.value })} className="p-1.5 rounded-lg border border-slate-300" /></td>
                    <td className="p-2 font-mono">{fmt((Number(r.quantity) || 0) * (Number(r.unitCost) || 0))}</td>
                    <td className="p-2"><button onClick={() => setRows(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev)} className="text-rose-600"><Trash2 className="w-3.5 h-3.5" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between">
            <button onClick={() => setRows(prev => [...prev, emptyRow()])} className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />إضافة صنف</button>
            <div className="flex items-center gap-3">
              <span className="text-xs">إجمالي القيمة: <b className="font-mono">{fmt(total)}</b> ج.م</span>
              <button onClick={submitInventory} className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs">ترحيل رصيد أول المدة</button>
            </div>
          </div>
        </div>
      )}

      {tab === 'customers' && partyTable('customer')}
      {tab === 'suppliers' && partyTable('supplier')}
    </div>
  );
};
