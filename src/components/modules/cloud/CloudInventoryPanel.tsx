// Cloud inventory screen: READ (حركات المخزون + الدفعات + الأرصدة) and one
// WRITE path (التحويل المخزني الداخلي).
//
// Reads use the existing TEST RPCs list_inventory_transactions,
// list_inventory_batches and stock_on_hand. The transfer form posts through
// public.post_inventory_transfer, which enforces can_write_inventory()
// server-side, plans FIFO layers, guards the stock value and is idempotent —
// so the form is only rendered when the caller's role can actually write.
// Nothing here reads or writes localStorage.

import React, { useEffect, useState } from 'react';
import { ArrowLeftRight, CloudUpload, Loader2, XCircle } from 'lucide-react';
import { CloudRpcPanel } from './CloudRpcPanel';
import {
  loadTransferOptions,
  postCloudTransfer,
  readCloudInventoryRole,
  readCloudStock,
  type CloudTransferOptions,
} from '../../../services/cloudInventoryWrite';
import type { CloudRow } from '../../../services/cloudOpsRead';

export function CloudInventoryPanel() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-black text-slate-900">المخزون والمستودعات</h2>
        <p className="text-xs text-slate-500 mt-1">
          القراءة من مخطط inventory في Supabase TEST (الأرصدة من الدفعات الفعلية FIFO وليست أرقامًا محلية)،
          والتحويل الداخلي يُكتب عبر دالة الخادم التي تفرض الصلاحية والفحص والـidempotency.
        </p>
      </div>

      <CloudTransferCard />

      <CloudRpcPanel
        title="حركات المخزون"
        sourceLabel="inventory.transactions (list_inventory_transactions)"
        rpc="list_inventory_transactions"
        params={{
          p_from: null,
          p_to: null,
          p_item_id: null,
          p_warehouse_id: null,
          p_limit: 200,
          p_offset: 0,
        }}
        searchKeys={['document_number', 'document_type', 'movement_type', 'item_id', 'warehouse_id']}
        columns={[
          { key: 'transaction_date', labelAr: 'التاريخ', kind: 'date' },
          { key: 'document_type', labelAr: 'نوع المستند' },
          { key: 'document_number', labelAr: 'رقم المستند' },
          { key: 'movement_type', labelAr: 'نوع الحركة' },
          { key: 'item_id', labelAr: 'الصنف' },
          { key: 'warehouse_id', labelAr: 'المستودع' },
          { key: 'batch_number', labelAr: 'الدفعة' },
          { key: 'quantity_in', labelAr: 'وارد', kind: 'number' },
          { key: 'quantity_out', labelAr: 'منصرف', kind: 'number' },
          { key: 'unit_cost', labelAr: 'تكلفة الوحدة', kind: 'money' },
          { key: 'total_cost', labelAr: 'إجمالي التكلفة', kind: 'money' },
        ]}
        hint="حركات فواتير البيع لا تظهر هنا إلا بعد تشغيل دالة الصرف الذرية على الخادم."
      />

      <CloudRpcPanel
        title="دفعات المخزون (FIFO layers)"
        sourceLabel="inventory.batches (list_inventory_batches)"
        rpc="list_inventory_batches"
        params={{ p_item_id: null, p_warehouse_id: null, p_limit: 200 }}
        searchKeys={['batch_number', 'item_id', 'warehouse_id']}
        columns={[
          { key: 'batch_id', labelAr: 'المعرف' },
          { key: 'item_id', labelAr: 'الصنف' },
          { key: 'warehouse_id', labelAr: 'المستودع' },
          { key: 'batch_number', labelAr: 'رقم الدفعة' },
          { key: 'production_date', labelAr: 'الإنتاج', kind: 'date' },
          { key: 'expiry_date', labelAr: 'الانتهاء', kind: 'date' },
          { key: 'quantity', labelAr: 'الكمية', kind: 'number' },
          { key: 'unit_cost', labelAr: 'التكلفة', kind: 'money' },
        ]}
      />

      <CloudRpcPanel
        title="الأرصدة المتاحة"
        sourceLabel="inventory.batches (stock_on_hand)"
        rpc="stock_on_hand"
        params={{ p_warehouse_id: null }}
        searchKeys={['item_id', 'warehouse_id']}
        columns={[
          { key: 'item_id', labelAr: 'الصنف' },
          { key: 'warehouse_id', labelAr: 'المستودع' },
          { key: 'quantity', labelAr: 'الرصيد', kind: 'number' },
        ]}
        footerNote="الرصيد محسوب على الخادم من مجموع الدفعات؛ لا يُقرأ أي رصيد من التخزين المحلي."
      />
    </div>
  );
}

type CardPhase = 'loading' | 'ready' | 'denied' | 'error';

/**
 * Transfer form. The server is the only authority: the form is rendered only
 * after public.can_write_inventory() has been read for this session, and every
 * submit goes to post_inventory_transfer (no local stock math, no fallback).
 */
function CloudTransferCard() {
  const [phase, setPhase] = useState<CardPhase>('loading');
  const [role, setRole] = useState('');
  const [opts, setOpts] = useState<CloudTransferOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stock, setStock] = useState<CloudRow[]>([]);

  const [itemId, setItemId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = async () => {
    setPhase('loading');
    setError(null);
    setResult(null);
    const r = await readCloudInventoryRole();
    if (!r.ok) {
      setPhase('error');
      setError(r.messageAr);
      return;
    }
    setRole(r.role);
    if (!r.canWriteInventory) {
      setPhase('denied');
      return;
    }
    const o = await loadTransferOptions();
    if (!o.ok) {
      setPhase('error');
      setError(o.messageAr);
      return;
    }
    setOpts(o.data);
    setPhase('ready');
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!itemId) {
      setStock([]);
      return;
    }
    let alive = true;
    void (async () => {
      const s = await readCloudStock(itemId);
      if (alive && s.ok) setStock(s.data);
    })();
    return () => {
      alive = false;
    };
  }, [itemId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    const res = await postCloudTransfer({
      itemId,
      sourceWarehouseId: sourceId,
      targetWarehouseId: targetId,
      quantity: qty,
      notes: notes.trim() || undefined,
    });
    setBusy(false);
    if (res.ok) {
      setResult({ tone: 'ok', text: `تم التحويل على الخادم — رقم المستند ${res.documentNumber}` });
      const s = await readCloudStock(itemId);
      if (s.ok) setStock(s.data);
    } else {
      setResult({ tone: 'error', text: res.messageAr });
    }
  };

  const warehouseCount = opts?.warehouses.length ?? 0;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between gap-3 p-4 border-b border-slate-200">
        <div>
          <h3 className="text-sm font-black text-slate-900 flex items-center gap-2">
            <ArrowLeftRight className="w-4 h-4" /> تحويل مخزني داخلي
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            الكتابة عبر <span className="font-mono font-bold text-sky-700">post_inventory_transfer</span> —
            الصلاحية والفIFO والفحص والـidempotency كلها على الخادم.
          </p>
        </div>
        <span className="px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 text-[10px] font-bold text-amber-800">
          كتابة
        </span>
      </div>

      {phase === 'loading' && (
        <div className="p-4 space-y-2 animate-pulse">
          <p className="text-xs font-bold text-slate-600">جارٍ قراءة دورك وبيانات النموذج…</p>
          <div className="h-3 rounded bg-slate-100 w-2/3" />
          <div className="h-3 rounded bg-slate-100 w-1/2" />
        </div>
      )}

      {phase === 'error' && (
        <div className="p-4 bg-rose-50 space-y-2">
          <p className="text-[11px] font-black text-rose-800 flex items-center gap-1.5">
            <XCircle className="w-3.5 h-3.5" /> تعذّر إتاحة التحويل السحابي — لا يُعرض أي نموذج محلي.
          </p>
          <p className="text-[11px] text-rose-700">{error}</p>
          <button
            onClick={() => void load()}
            className="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-[11px] font-bold"
          >
            إعادة المحاولة
          </button>
        </div>
      )}

      {phase === 'denied' && (
        <div className="p-4 bg-slate-50">
          <p className="text-[11px] text-slate-600">
            دورك الحالي <b>{role || 'غير معروف'}</b> لا يملك صلاحية تحريك المخزون — التحويل مرفوض من الخادم
            (<span className="font-mono">can_write_inventory()</span>)، ولذلك لا يُعرض نموذج الإدخال.
          </p>
        </div>
      )}

      {phase === 'ready' && opts && (
        <form onSubmit={submit} className="p-4 space-y-3">
          {warehouseCount < 2 && (
            <p className="text-[11px] bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-2">
              التحويل يحتاج مستودعَي مصدر ووجهة، ويوجد في TEST {warehouseCount} مستودع فقط — أضِف مستودعًا ثانيًا
              من الإعدادات قبل استخدام النموذج.
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600">الصنف</span>
              <select
                value={itemId}
                onChange={e => setItemId(e.target.value)}
                className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs"
                required
              >
                <option value="">— اختر —</option>
                {opts.items.map(i => (
                  <option key={i.id} value={i.id}>{i.code} · {i.nameAr}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600">الكمية</span>
              <input
                type="number"
                min={1}
                step={1}
                value={qty}
                onChange={e => setQty(Number(e.target.value))}
                className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs font-mono"
                required
              />
            </label>

            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600">من مستودع</span>
              <select
                value={sourceId}
                onChange={e => setSourceId(e.target.value)}
                className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs"
                required
              >
                <option value="">— اختر —</option>
                {opts.warehouses.map(w => (
                  <option key={w.id} value={w.id}>{w.code} · {w.nameAr}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600">إلى مستودع</span>
              <select
                value={targetId}
                onChange={e => setTargetId(e.target.value)}
                className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs"
                required
              >
                <option value="">— اختر —</option>
                {opts.warehouses.map(w => (
                  <option key={w.id} value={w.id}>{w.code} · {w.nameAr}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="space-y-1 block">
            <span className="text-[11px] font-bold text-slate-600">ملاحظات (اختياري)</span>
            <input
              value={notes}
              onChange={e => setNotes(e.target.value)}
              className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs"
            />
          </label>

          {stock.length > 0 && (
            <div className="text-[11px] text-slate-600 bg-slate-50 rounded-lg p-2 space-y-0.5">
              <p className="font-bold">الرصيد الحالي للصنف (من <span className="font-mono">stock_on_hand</span>):</p>
              {stock.map(s => (
                <p key={String(s.warehouse_id)} className="font-mono" dir="ltr">
                  {String(s.warehouse_id)} → {Number(s.quantity)}
                </p>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={busy || !itemId || !sourceId || !targetId || sourceId === targetId || warehouseCount < 2}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-black disabled:opacity-40"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudUpload className="w-3.5 h-3.5" />}
              تنفيذ التحويل على الخادم
            </button>
            {sourceId && sourceId === targetId && (
              <span className="text-[11px] text-rose-600">مصدر ووجهة متطابقان</span>
            )}
          </div>

          {result && (
            <p
              className={`text-[11px] font-bold rounded-lg p-2 ${
                result.tone === 'ok'
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                  : 'bg-rose-50 text-rose-800 border border-rose-200'
              }`}
            >
              {result.text}
            </p>
          )}

          <p className="text-[10px] text-slate-400">
            لا تُحفظ العملية في التخزين المحلي: رقم المستند المعروض هو ما أعاده الخادم فقط.
          </p>
        </form>
      )}
    </div>
  );
}
