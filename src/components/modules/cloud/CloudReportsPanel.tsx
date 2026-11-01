// Cloud reports screen: قائمة الدخل (P&L) / ميزان المراجعة / حركة المخزون.
//
// Every number comes from a server aggregate over POSTED journal lines and the
// perpetual inventory ledger — nothing is summed in the browser and nothing is
// read from localStorage. A failed load shows an explicit error, never local
// figures.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Cloud, FileBarChart, Printer, RefreshCw, XCircle } from 'lucide-react';
import {
  loadInventoryMovement,
  loadProfitAndLoss,
  loadTrialBalance,
  monthRange,
  type InventoryMovementLine,
  type ProfitLossLine,
  type TrialBalanceLine,
} from '../../../services/cloudReports';

type Tab = 'pl' | 'tb' | 'movement';

type Snapshot = {
  pl: ProfitLossLine[];
  tb: TrialBalanceLine[];
  movement: InventoryMovementLine[];
  loadedAt: string;
};

const money = (v: number): string =>
  v === 0 ? '—' : v.toLocaleString('ar-EG', { maximumFractionDigits: 2 });

const qty = (v: number): string =>
  v === 0 ? '—' : v.toLocaleString('ar-EG', { maximumFractionDigits: 3 });

const SECTION_LABELS: Record<string, string> = {
  revenue: 'الإيرادات',
  cogs: 'تكلفة المبيعات',
  expense: 'المصروفات التشغيلية',
  other_income: 'إيرادات أخرى',
  other_expense: 'مصروفات أخرى',
};

/** Section -> the server subtotal row that covers it (none = no total row). */
const SECTION_SUBTOTALS: Record<string, string | undefined> = {
  revenue: 'revenue_total',
  cogs: 'cogs_total',
  expense: 'opex_total',
};

const TABS: Array<{ key: Tab; labelAr: string }> = [
  { key: 'pl', labelAr: 'الأرباح والخسائر' },
  { key: 'tb', labelAr: 'ميزان المراجعة' },
  { key: 'movement', labelAr: 'حركة المخزون' },
];

export function CloudReportsPanel() {
  const initial = useMemo(() => monthRange(), []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [tab, setTab] = useState<Tab>('pl');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    setError(null);
    const [pl, tb, movement] = await Promise.all([
      loadProfitAndLoss(from || null, to || null),
      loadTrialBalance(from || null, to || null),
      loadInventoryMovement(from || null, to || null),
    ]);
    if (!pl.ok) {
      setPhase('error');
      setError(pl.messageAr);
      return;
    }
    if (!tb.ok) {
      setPhase('error');
      setError(tb.messageAr);
      return;
    }
    if (!movement.ok) {
      setPhase('error');
      setError(movement.messageAr);
      return;
    }
    setSnapshot({
      pl: pl.data,
      tb: tb.data,
      movement: movement.data,
      loadedAt: new Date().toISOString(),
    });
    setPhase('ready');
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const subtotal = (key: string): number =>
    snapshot?.pl.find(l => l.lineType === 'subtotal' && l.section === key)?.amount ?? 0;

  const tbTotals = useMemo(() => {
    const rows = snapshot?.tb ?? [];
    return {
      debit: rows.reduce((s, r) => s + r.debit, 0),
      credit: rows.reduce((s, r) => s + r.credit, 0),
    };
  }, [snapshot]);

  const plSections = useMemo(() => {
    const rows = snapshot?.pl ?? [];
    const order = ['revenue', 'cogs', 'expense', 'other_income', 'other_expense'];
    return order
      .map(section => ({ section, rows: rows.filter(r => r.lineType === 'account' && r.section === section) }))
      .filter(s => s.rows.length > 0);
  }, [snapshot]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-slate-900 flex items-center gap-2">
            <FileBarChart className="w-5 h-5 text-sky-600" /> التقارير المالية والإدارية
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            الأرقام تُجمَّع على الخادم من القيود <b>المُرحَّلة</b> ومن دفتر حركة المخزون في Supabase TEST.
            لا تُقرأ أي بيانات من التخزين المحلي، والإجماليات ومجمل/صافي الربح تأتي من الخادم
            (إجمالي الميزان أعلاه للتحقق البصري من التوازن فقط).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-1 rounded-lg bg-sky-50 border border-sky-200 text-[10px] font-bold text-sky-800 flex items-center gap-1">
            <Cloud className="w-3 h-3" /> Supabase TEST
          </span>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 text-[11px] font-bold"
          >
            <Printer className="w-3.5 h-3.5" /> طباعة
          </button>
          <button
            onClick={() => void load()}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-bold"
          >
            <RefreshCw className="w-3.5 h-3.5" /> تحديث
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="text-[11px] font-bold text-slate-600 block">من تاريخ</span>
          <input
            type="date"
            value={from}
            onChange={e => setFrom(e.target.value)}
            className="p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono"
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] font-bold text-slate-600 block">إلى تاريخ</span>
          <input
            type="date"
            value={to}
            onChange={e => setTo(e.target.value)}
            className="p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono"
          />
        </label>
        <span className="text-[10px] font-mono text-slate-500">
          {phase === 'ready' && snapshot
            ? `source=supabase:test · ${new Date(snapshot.loadedAt).toLocaleTimeString('ar-EG')}`
            : 'source=none'}
        </span>
        <div className="flex-1" />
        <div className="flex flex-wrap gap-1">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-bold ${
                tab === t.key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {t.labelAr}
            </button>
          ))}
        </div>
      </div>

      {phase === 'loading' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-2 animate-pulse">
          <p className="text-xs font-bold text-slate-600">جارٍ تحميل التقارير من Supabase TEST…</p>
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="h-3 rounded bg-slate-100" style={{ width: `${92 - i * 16}%` }} />
          ))}
        </div>
      )}

      {phase === 'error' && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 space-y-2">
          <p className="text-xs font-black text-rose-800 flex items-center gap-1.5">
            <XCircle className="w-4 h-4" /> تعذّر تحميل التقارير — لا تُعرض أي أرقام محلية بديلة.
          </p>
          <p className="text-[11px] text-rose-700 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> {error}
          </p>
          <button
            onClick={() => void load()}
            className="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-[11px] font-bold"
          >
            إعادة المحاولة
          </button>
        </div>
      )}

      {phase === 'ready' && snapshot && tab === 'pl' && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="p-3 border-b border-slate-200">
            <h3 className="text-sm font-black text-slate-900">قائمة الدخل (الأرباح والخسائر)</h3>
            <p className="text-[11px] text-slate-500">
              المصدر: <span className="font-mono font-bold text-sky-700">fin.journal_lines (profit_and_loss)</span> —
              القيود المُرحَّلة فقط خلال الفترة.
            </p>
          </div>

          {plSections.length === 0 ? (
            <p className="p-5 text-center text-[11px] text-slate-500">
              لا توجد قيود مُرحَّلة على حسابات الإيرادات/التكلفة/المصروفات في هذه الفترة.
            </p>
          ) : (
            <table className="w-full text-right text-[11px]">
              <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="p-2.5">الحساب</th>
                  <th className="p-2.5">الكود</th>
                  <th className="p-2.5">المبلغ (ج.م)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {plSections.map(({ section, rows }) => (
                  <React.Fragment key={section}>
                    <tr className="bg-slate-50/60">
                      <td colSpan={3} className="p-2 text-[11px] font-black text-slate-700">
                        {SECTION_LABELS[section] ?? section}
                      </td>
                    </tr>
                    {rows.map(r => (
                      <tr key={`${section}-${r.accountCode}`}>
                        <td className="p-2.5 text-slate-700">{r.labelAr}</td>
                        <td className="p-2.5 font-mono text-slate-500">{r.accountCode}</td>
                        <td className="p-2.5 font-mono text-slate-800">{money(r.amount)}</td>
                      </tr>
                    ))}
                    {SECTION_SUBTOTALS[section] && (
                      <tr>
                        <td className="p-2.5 font-bold text-slate-600">
                          إجمالي {SECTION_LABELS[section] ?? section}
                        </td>
                        <td />
                        <td className="p-2.5 font-mono font-bold text-slate-800">
                          {money(subtotal(SECTION_SUBTOTALS[section]))}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
              <tfoot className="bg-slate-900 text-white">
                <tr>
                  <td className="p-2.5 font-black" colSpan={2}>مجمل الربح</td>
                  <td className="p-2.5 font-mono font-black">{money(subtotal('gross_profit'))}</td>
                </tr>
                <tr>
                  <td className="p-2.5 font-black" colSpan={2}>صافي الربح</td>
                  <td className="p-2.5 font-mono font-black">{money(subtotal('net_profit'))}</td>
                </tr>
              </tfoot>
            </table>
          )}
          <p className="px-4 py-2 text-[10px] text-slate-500 border-t border-slate-100">
            الإجماليات ومجمل/صافي الربح محسوبة داخل قاعدة البيانات، لا في المتصفح.
          </p>
        </div>
      )}

      {phase === 'ready' && snapshot && tab === 'tb' && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="p-3 border-b border-slate-200">
            <h3 className="text-sm font-black text-slate-900">ميزان المراجعة بالمجاميع والأرصدة</h3>
            <p className="text-[11px] text-slate-500">
              المصدر: <span className="font-mono font-bold text-sky-700">fin.journal_lines (trial_balance)</span>
            </p>
          </div>
          {snapshot.tb.length === 0 ? (
            <p className="p-5 text-center text-[11px] text-slate-500">لا توجد حركات مُرحَّلة في هذه الفترة.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-[11px]">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                  <tr>
                    <th className="p-2.5">الكود</th>
                    <th className="p-2.5">الحساب</th>
                    <th className="p-2.5">التصنيف</th>
                    <th className="p-2.5">مدين</th>
                    <th className="p-2.5">دائن</th>
                    <th className="p-2.5">الصافي</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {snapshot.tb.map(r => (
                    <tr key={r.accountId} className="hover:bg-slate-50">
                      <td className="p-2.5 font-mono text-slate-500">{r.accountCode}</td>
                      <td className="p-2.5 text-slate-700">{r.accountNameAr}</td>
                      <td className="p-2.5 text-slate-500">{r.category}</td>
                      <td className="p-2.5 font-mono">{money(r.debit)}</td>
                      <td className="p-2.5 font-mono">{money(r.credit)}</td>
                      <td className="p-2.5 font-mono text-slate-800">{money(r.netDebit)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className={tbTotals.debit === tbTotals.credit ? 'bg-emerald-50' : 'bg-rose-50'}>
                  <tr>
                    <td className="p-2.5 font-black" colSpan={3}>
                      الإجمالي العام {tbTotals.debit === tbTotals.credit ? '— متوازن ✓' : '— غير متوازن ✗'}
                    </td>
                    <td className="p-2.5 font-mono font-black">{money(tbTotals.debit)}</td>
                    <td className="p-2.5 font-mono font-black">{money(tbTotals.credit)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {phase === 'ready' && snapshot && tab === 'movement' && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="p-3 border-b border-slate-200">
            <h3 className="text-sm font-black text-slate-900">حركة المخزون (افتتاحي / وارد / صادر / رصيد)</h3>
            <p className="text-[11px] text-slate-500">
              المصدر:{' '}
              <span className="font-mono font-bold text-sky-700">inventory.transactions (inventory_movement_report)</span>{' '}
              — الرصيد الافتتاحي هو كل ما قبل تاريخ البداية، والختامي = افتتاحي + وارد − صادر.
            </p>
          </div>
          {snapshot.movement.length === 0 ? (
            <p className="p-5 text-center text-[11px] text-slate-500">لا حركات مخزون في هذه الفترة.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-[11px]">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                  <tr>
                    <th className="p-2.5">الصنف</th>
                    <th className="p-2.5">المستودع</th>
                    <th className="p-2.5">افتتاحي</th>
                    <th className="p-2.5">وارد</th>
                    <th className="p-2.5">صادر</th>
                    <th className="p-2.5">الرصيد</th>
                    <th className="p-2.5">قيمة الحركة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {snapshot.movement.map(r => (
                    <tr key={`${r.itemId}-${r.warehouseId}`} className="hover:bg-slate-50">
                      <td className="p-2.5 text-slate-700">
                        <span className="font-mono text-[10px] text-slate-500">{r.itemCode}</span> · {r.itemNameAr}
                      </td>
                      <td className="p-2.5 font-mono text-slate-600">{r.warehouseCode}</td>
                      <td className="p-2.5 font-mono">{qty(r.openingQty)}</td>
                      <td className="p-2.5 font-mono text-emerald-700">{qty(r.qtyIn)}</td>
                      <td className="p-2.5 font-mono text-rose-700">{qty(r.qtyOut)}</td>
                      <td className="p-2.5 font-mono font-bold text-slate-800">{qty(r.closingQty)}</td>
                      <td className="p-2.5 font-mono">{money(r.movementValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="px-4 py-2 text-[10px] text-slate-500 border-t border-slate-100">
            الأرصدة مأخوذة من دفتر الحركة الدائم (perpetual) وليست من رصيد مُخزَّن يمكن أن ينحرف.
          </p>
        </div>
      )}
    </div>
  );
}
