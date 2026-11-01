// Cloud panels for production orders, representative custody and treasury.
//
// Production carries the full cycle: draft → released → in_progress, then
// FIFO material issue (BOM requirements + waste), finished-goods receipt, and
// an atomic close that posts one balanced journal (Dr finished goods,
// Cr raw materials at actual FIFO cost, Cr accrued conversion) and links the
// journal to the order. All of it is one server call per step, gated by the ERP
// role and inventory rights, and idempotent on a stable submission key.
//
// Custody and treasury stay read-only: their writes would need mappings that
// TEST does not have.

import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Factory,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { CloudRpcPanel } from './CloudRpcPanel';
import {
  createCloudProductionOrder,
  listCloudProductionOrders,
  setCloudProductionOrderStatus,
  type CloudProductionOrder,
} from '../../../services/cloudManufacturing';
import { readCoreMaster, type CoreMasterRecord } from '../../../services/coreMasterRead';
import { cloudCan } from '../../../services/cloudUsers';
import {
  closeProductionOrder,
  issueProductionConsumption,
  listProductionBom,
  planBomRequirements,
  recordProductionOutput,
  type ProductionBomLine,
  type ProductionRequirement,
} from '../../../services/cloudManufacturingLifecycle';

const STATUS_LABELS: Record<string, string> = {
  draft: 'مسودة',
  released: 'مُصدر',
  in_progress: 'قيد التنفيذ',
  completed: 'مكتمل',
  cancelled: 'ملغى',
};

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700',
  released: 'bg-sky-50 text-sky-700',
  in_progress: 'bg-amber-50 text-amber-800',
  completed: 'bg-emerald-50 text-emerald-700',
  cancelled: 'bg-rose-50 text-rose-700',
};

const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

type Banner = { tone: 'ok' | 'error' | 'info'; text: string } | null;

export function CloudProductionPanel() {
  const [orders, setOrders] = useState<CloudProductionOrder[]>([]);
  const [items, setItems] = useState<CoreMasterRecord[]>([]);
  const [warehouses, setWarehouses] = useState<CoreMasterRecord[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [itemId, setItemId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [plannedQuantity, setPlannedQuantity] = useState('100');
  const [startDate, setStartDate] = useState(today());
  const [expectedDate, setExpectedDate] = useState('');
  const [market, setMarket] = useState<'local' | 'export'>('local');
  const [notes, setNotes] = useState('');

  // ---- lifecycle (issue → output → close) ----
  const [activeOrder, setActiveOrder] = useState<CloudProductionOrder | null>(null);
  const [bom, setBom] = useState<ProductionBomLine[]>([]);
  const [bomMessage, setBomMessage] = useState<string | null>(null);
  const [goodQty, setGoodQty] = useState('0');
  const [defectiveQty, setDefectiveQty] = useState('0');
  const [scrapQty, setScrapQty] = useState('0');
  const [lifeBusy, setLifeBusy] = useState<string | null>(null);
  const [closeResult, setCloseResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    setError(null);
    const [ord, it, wh, createPerm, editPerm] = await Promise.all([
      listCloudProductionOrders(null, null, null),
      readCoreMaster('items'),
      readCoreMaster('warehouses'),
      cloudCan('manufacturing', 'create'),
      cloudCan('manufacturing', 'edit'),
    ]);
    if (!ord.ok) {
      setPhase('error');
      setError(ord.messageAr);
      return;
    }
    setOrders(ord.data);
    setItems(it.ok ? it.data.filter(i => i.active) : []);
    setWarehouses(wh.ok ? wh.data.filter(w => w.active) : []);
    setCanCreate(createPerm.ok ? createPerm.data : false);
    setCanEdit(editPerm.ok ? editPerm.data : false);
    setPhase('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createOrder = async () => {
    setBusy('new');
    setBanner(null);
    const res = await createCloudProductionOrder({
      itemId,
      warehouseId,
      destinationWarehouseId: destinationId || null,
      plannedQuantity: Number(plannedQuantity),
      startDate,
      expectedCompletionDate: expectedDate || null,
      targetMarket: market,
      notes,
    });
    setBusy(null);
    if (!res.ok) {
      setBanner({ tone: 'error', text: res.messageAr });
      return;
    }
    setBanner({ tone: 'ok', text: `أُنشئ أمر الإنتاج ${res.data.id ?? ''} كمسودة (بلا حركة مخزون).`.trim() });
    setNotes('');
    await load();
  };

  const changeStatus = async (
    order: CloudProductionOrder,
    status: 'released' | 'in_progress' | 'cancelled',
  ) => {
    setBusy(order.orderId);
    setBanner(null);
    const res = await setCloudProductionOrderStatus(order.orderId, status);
    setBusy(null);
    if (!res.ok) {
      setBanner({ tone: 'error', text: `${order.orderNumber}: ${res.messageAr}` });
      return;
    }
    setBanner({ tone: 'ok', text: `${order.orderNumber} → ${STATUS_LABELS[status] ?? status}` });
    await load();
  };

  const openLifecycle = async (order: CloudProductionOrder) => {
    setActiveOrder(order);
    setBom([]);
    setBomMessage(null);
    setCloseResult(null);
    setDefectiveQty('0');
    setScrapQty('0');
    setGoodQty(String(Math.max(order.plannedQuantity - order.producedQuantity, 0)));
    const res = await listProductionBom(order.orderId);
    if (!res.ok) {
      setBomMessage(res.messageAr);
      return;
    }
    setBom(res.data);
    setBomMessage(res.data.length === 0 ? 'لا يوجد BOM معتمد لهذا المنتج في السحابة — استيراد BOM مطلوب قبل الصرف التلقائي.' : null);
  };

  const requirements: ProductionRequirement[] = activeOrder
    ? planBomRequirements(bom, Number(goodQty) || 0)
    : [];

  const issueMaterials = async () => {
    if (!activeOrder) return;
    if (requirements.length === 0) {
      setBanner({ tone: 'error', text: 'لا يمكن الصرف: لا توجد مكوّنات BOM محمّلة لهذا الأمر.' });
      return;
    }
    setLifeBusy('issue');
    setBanner(null);
    const res = await issueProductionConsumption(
      activeOrder.orderId,
      requirements.map(r => ({
        materialItemId: r.materialItemId,
        quantity: r.requiredQuantity,
        unitId: r.unitId || undefined,
        warehouseId: activeOrder.warehouseId,
      })),
    );
    setLifeBusy(null);
    if (!res.ok) {
      setBanner({ tone: 'error', text: res.messageAr });
      return;
    }
    const total = res.consumed.reduce((sum, c) => sum + c.quantity, 0);
    setBanner({ tone: 'ok', text: `صُرفت ${res.consumed.length} مادة (${total}) بـFIFO من ${activeOrder.warehouseId}.` });
    await load();
  };

  const recordOutput = async () => {
    if (!activeOrder) return;
    setLifeBusy('output');
    setBanner(null);
    const res = await recordProductionOutput(
      activeOrder.orderId,
      Number(goodQty) || 0,
      Number(defectiveQty) || 0,
      Number(scrapQty) || 0,
    );
    setLifeBusy(null);
    if (!res.ok) {
      setBanner({ tone: 'error', text: res.messageAr });
      return;
    }
    setBanner({ tone: 'ok', text: `استُلم المنتج التام في دفعة ${res.batchId ?? '—'}.` });
    await load();
  };

  const closeOrder = async () => {
    if (!activeOrder) return;
    setLifeBusy('close');
    setBanner(null);
    setCloseResult(null);
    const res = await closeProductionOrder(activeOrder.orderId);
    setLifeBusy(null);
    if (!res.ok) {
      setBanner({ tone: 'error', text: res.messageAr });
      return;
    }
    setCloseResult(
      `${res.status === 'existing' ? 'إعادة إرسال — نفس القيد' : res.status === 'already_completed' ? 'مكتمل مسبقًا' : 'اكتمل'}` +
        ` · قيد ${res.journalEntryId ?? '—'} · مواد ${res.materialCost} + تحويل ${res.conversionCost} = ${res.totalCost}`,
    );
    setBanner({ tone: 'ok', text: `${activeOrder.orderNumber}: أُقفل الأمر ورُحّل القيد المتوازن.` });
    await load();
    setActiveOrder(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-slate-900 flex items-center gap-2">
            <Factory className="w-5 h-5 text-sky-600" /> أوامر الإنتاج
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            المصدر: <span className="font-mono">production.orders</span>. الإنشاء مسودة والإصدار والبدء والإلغاء
            لا تُحرّك مخزونًا ولا تُرحّل قيودًا. لدورات التنفيذ: <b>صرف مواد BOM بالهالك</b> بـFIFO، ثم
            <b> استلام المنتج التام</b>، ثم <b>إقفال ذري</b> يرسمل التكلفة الفعلية في قيد واحد متوازن.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-bold"
        >
          <RefreshCw className="w-3.5 h-3.5" /> تحديث
        </button>
      </div>

      {banner && (
        <div
          className={`rounded-2xl px-4 py-2.5 text-[11px] font-bold flex items-start gap-2 border ${
            banner.tone === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : banner.tone === 'error'
                ? 'border-rose-200 bg-rose-50 text-rose-800'
                : 'border-slate-200 bg-slate-50 text-slate-700'
          }`}
        >
          {banner.tone === 'ok' ? (
            <Check className="w-3.5 h-3.5 mt-0.5" />
          ) : banner.tone === 'error' ? (
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5" />
          ) : null}
          <span>{banner.text}</span>
        </div>
      )}

      {canCreate && phase === 'ready' && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="p-3 border-b border-slate-200">
            <h3 className="text-sm font-black text-slate-900">أمر إنتاج جديد (مسودة)</h3>
          </div>
          <div className="p-3 grid grid-cols-1 sm:grid-cols-4 gap-3">
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600 block">المنتج</span>
              <select
                value={itemId}
                onChange={e => setItemId(e.target.value)}
                className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px]"
              >
                <option value="">— اختر —</option>
                {items.map(i => (
                  <option key={i.id} value={i.id}>{i.code} · {i.nameAr}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600 block">مستودع الصرف</span>
              <select
                value={warehouseId}
                onChange={e => setWarehouseId(e.target.value)}
                className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px]"
              >
                <option value="">— اختر —</option>
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>{w.code} · {w.nameAr}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600 block">مستودع الاستلام</span>
              <select
                value={destinationId}
                onChange={e => setDestinationId(e.target.value)}
                className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px]"
              >
                <option value="">— نفس المستودع —</option>
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>{w.code} · {w.nameAr}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600 block">الكمية المخططة</span>
              <input
                inputMode="decimal"
                value={plannedQuantity}
                onChange={e => setPlannedQuantity(e.target.value)}
                className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600 block">تاريخ البدء</span>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600 block">الانتهاء المتوقع</span>
              <input
                type="date"
                value={expectedDate}
                onChange={e => setExpectedDate(e.target.value)}
                className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600 block">السوق</span>
              <select
                value={market}
                onChange={e => setMarket(e.target.value as 'local' | 'export')}
                className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px]"
              >
                <option value="local">محلي</option>
                <option value="export">تصدير</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-bold text-slate-600 block">ملاحظات</span>
              <input
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px]"
              />
            </label>
          </div>
          <div className="px-3 pb-3 flex justify-end">
            <button
              onClick={() => void createOrder()}
              disabled={busy === 'new' || !itemId || !warehouseId}
              className="flex items-center gap-1 px-3 py-2 rounded-lg bg-slate-900 text-white text-[11px] font-black disabled:opacity-40"
            >
              {busy === 'new' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              إنشاء مسودة
            </button>
          </div>
        </div>
      )}

      {phase === 'loading' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 flex items-center gap-2 text-xs text-slate-600">
          <Loader2 className="w-4 h-4 animate-spin" /> جارٍ تحميل أوامر الإنتاج…
        </div>
      )}

      {phase === 'error' && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 space-y-2">
          <p className="text-xs font-black text-rose-800 flex items-center gap-1.5">
            <XCircle className="w-4 h-4" /> تعذّر تحميل أوامر الإنتاج — لا بديل محلي.
          </p>
          <p className="text-[11px] text-rose-700">{error}</p>
        </div>
      )}

      {phase === 'ready' && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="p-3 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-black text-slate-900">الأوامر</h3>
            <span className="text-[10px] font-mono text-slate-500">rows={orders.length}</span>
          </div>
          {orders.length === 0 ? (
            <p className="p-5 text-center text-[11px] text-slate-500">لا أوامر إنتاج بعد.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-[11px]">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                  <tr>
                    <th className="p-2.5">رقم الأمر</th>
                    <th className="p-2.5">الصنف</th>
                    <th className="p-2.5">الحالة</th>
                    <th className="p-2.5">مخطط</th>
                    <th className="p-2.5">مُنتج</th>
                    <th className="p-2.5">البداية</th>
                    <th className="p-2.5">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {orders.map(o => (
                    <tr key={o.orderId} className="hover:bg-slate-50">
                      <td className="p-2.5 font-mono text-slate-700">{o.orderNumber}</td>
                      <td className="p-2.5 font-mono text-[10px] text-slate-500">{o.itemId}</td>
                      <td className="p-2.5">
                        <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold ${STATUS_STYLES[o.status] ?? 'bg-slate-100 text-slate-700'}`}>
                          {STATUS_LABELS[o.status] ?? o.status}
                        </span>
                      </td>
                      <td className="p-2.5 font-mono">{o.plannedQuantity}</td>
                      <td className="p-2.5 font-mono">{o.producedQuantity}</td>
                      <td className="p-2.5 font-mono text-slate-500">{o.startDate || '—'}</td>
                      <td className="p-2.5">
                        <div className="flex flex-wrap gap-1">
                          {canEdit && o.status === 'draft' && (
                            <button
                              onClick={() => void changeStatus(o, 'released')}
                              disabled={busy === o.orderId}
                              className="px-2 py-1 rounded-lg bg-sky-50 text-sky-700 text-[10px] font-bold disabled:opacity-40"
                            >
                              إصدار
                            </button>
                          )}
                          {canEdit && o.status === 'released' && (
                            <button
                              onClick={() => void changeStatus(o, 'in_progress')}
                              disabled={busy === o.orderId}
                              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-50 text-amber-800 text-[10px] font-bold disabled:opacity-40"
                            >
                              <Play className="w-3 h-3" /> بدء
                            </button>
                          )}
                          {canEdit && (o.status === 'draft' || o.status === 'released') && (
                            <button
                              onClick={() => void changeStatus(o, 'cancelled')}
                              disabled={busy === o.orderId}
                              className="px-2 py-1 rounded-lg bg-rose-50 text-rose-700 text-[10px] font-bold disabled:opacity-40"
                            >
                              إلغاء
                            </button>
                          )}
                          {canEdit && o.status === 'in_progress' && (
                            <button
                              onClick={() => void openLifecycle(o)}
                              className="px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700 text-[10px] font-bold"
                            >
                              دورة الإنتاج
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {activeOrder && (
        <div className="bg-white rounded-2xl border border-emerald-200 overflow-hidden">
          <div className="p-3 border-b border-emerald-100 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-black text-slate-900">
              دورة تنفيذ {activeOrder.orderNumber}
              <span className="ms-2 text-[10px] font-mono text-slate-500">
                {activeOrder.itemId} · مخطط {activeOrder.plannedQuantity} · مُنتج {activeOrder.producedQuantity}
              </span>
            </h3>
            <button
              onClick={() => setActiveOrder(null)}
              className="px-2 py-1 rounded-lg bg-slate-100 text-slate-600 text-[10px] font-bold"
            >
              إغلاق اللوحة
            </button>
          </div>

          <div className="p-3 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="space-y-1">
                <span className="text-[11px] font-bold text-slate-600 block">كمية سليمة</span>
                <input
                  inputMode="decimal"
                  value={goodQty}
                  onChange={e => setGoodQty(e.target.value)}
                  className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] font-bold text-slate-600 block">كمية معيبة</span>
                <input
                  inputMode="decimal"
                  value={defectiveQty}
                  onChange={e => setDefectiveQty(e.target.value)}
                  className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] font-bold text-slate-600 block">كمية هالك</span>
                <input
                  inputMode="decimal"
                  value={scrapQty}
                  onChange={e => setScrapQty(e.target.value)}
                  className="w-full p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono"
                />
              </label>
            </div>

            <div className="rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-[11px] font-black text-slate-700">
                احتياجات المواد من BOM (مع الهالك)
              </div>
              {bomMessage && (
                <p className="px-3 py-2 text-[10px] text-amber-800 bg-amber-50 border-b border-amber-100">{bomMessage}</p>
              )}
              {requirements.length > 0 && (
                <table className="w-full text-right text-[10px]">
                  <thead className="text-slate-500 border-b border-slate-100">
                    <tr>
                      <th className="p-2">المادة</th>
                      <th className="p-2">لكل دفعة</th>
                      <th className="p-2">صافي</th>
                      <th className="p-2">هالك %</th>
                      <th className="p-2">مطلوب</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {requirements.map(r => (
                      <tr key={r.materialItemId}>
                        <td className="p-2 font-mono">{r.materialCode} · {r.materialNameAr}</td>
                        <td className="p-2 font-mono">{r.quantityRequired} / {r.baseQuantity}</td>
                        <td className="p-2 font-mono">{r.netQuantity}</td>
                        <td className="p-2 font-mono">{r.wastePercentage}%</td>
                        <td className="p-2 font-mono font-bold">{r.requiredQuantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex flex-wrap gap-2 justify-end">
              <button
                onClick={() => void issueMaterials()}
                disabled={lifeBusy !== null || requirements.length === 0}
                className="flex items-center gap-1 px-3 py-2 rounded-lg bg-sky-600 text-white text-[11px] font-black disabled:opacity-40"
              >
                {lifeBusy === 'issue' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                صرف المواد (FIFO)
              </button>
              <button
                onClick={() => void recordOutput()}
                disabled={lifeBusy !== null}
                className="flex items-center gap-1 px-3 py-2 rounded-lg bg-amber-600 text-white text-[11px] font-black disabled:opacity-40"
              >
                {lifeBusy === 'output' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                استلام المنتج التام
              </button>
              <button
                onClick={() => void closeOrder()}
                disabled={lifeBusy !== null}
                className="flex items-center gap-1 px-3 py-2 rounded-lg bg-emerald-600 text-white text-[11px] font-black disabled:opacity-40"
              >
                {lifeBusy === 'close' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                إقفال وترحيل القيد
              </button>
            </div>

            {closeResult && (
              <p className="text-[10px] font-mono text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2">
                {closeResult}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function CloudCustodyPanel() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-black text-slate-900">عهد المندوبين</h2>
        <p className="text-xs text-slate-500 mt-1">
          قراءة فقط من مخطط core في Supabase TEST. تحميل/إرجاع البضاعة وتسوية العهدة يحتاج قيودًا وحسابات
          (عهد، مخزون، ذمم) غير موجودة في TEST، فيبقى عبر دوال الخادم بعد اعتماد التعيينات.
        </p>
      </div>

      <CloudRpcPanel
        title="العهد"
        sourceLabel="core.representative_custodies (list_representative_custodies)"
        rpc="list_representative_custodies"
        params={{ p_status: null, p_limit: 200, p_offset: 0 }}
        searchKeys={['custody_number', 'rep_name_ar', 'status']}
        columns={[
          { key: 'custody_number', labelAr: 'رقم العهدة' },
          { key: 'rep_name_ar', labelAr: 'المندوب' },
          { key: 'warehouse_id', labelAr: 'المستودع' },
          { key: 'status', labelAr: 'الحالة' },
          { key: 'open_date', labelAr: 'الفتح', kind: 'date' },
          { key: 'settle_date', labelAr: 'التسوية', kind: 'date' },
          { key: 'close_date', labelAr: 'الإقفال', kind: 'date' },
        ]}
      />

      <CloudRpcPanel
        title="حركات العهدة"
        sourceLabel="core.custody_movements (list_custody_movements)"
        rpc="list_custody_movements"
        params={{ p_custody_id: null }}
        searchKeys={['item_id', 'movement_type', 'custody_id']}
        columns={[
          { key: 'movement_date', labelAr: 'التاريخ', kind: 'date' },
          { key: 'movement_type', labelAr: 'نوع الحركة' },
          { key: 'custody_id', labelAr: 'العهدة' },
          { key: 'item_id', labelAr: 'الصنف' },
          { key: 'quantity', labelAr: 'الكمية', kind: 'number' },
          { key: 'unit_cost', labelAr: 'التكلفة', kind: 'money' },
        ]}
      />
    </div>
  );
}

export function CloudPaymentsPanel() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-black text-slate-900">الخزينة والمدفوعات</h2>
        <p className="text-xs text-slate-500 mt-1">
          قراءة فقط من مخطط fin في Supabase TEST. تسجيل التحصيل والصرف يحتاج تعيينات حسابات (خزينة/بنك مقابل
          ذمم) لم تُعتمد بعد في TEST.
        </p>
      </div>

      <CloudRpcPanel
        title="المدفوعات والتحصيلات"
        sourceLabel="fin.payments (list_payments)"
        rpc="list_payments"
        params={{ p_from: null, p_to: null, p_type: null, p_limit: 200, p_offset: 0 }}
        searchKeys={['payment_number', 'payment_type', 'party_id', 'reference']}
        columns={[
          { key: 'payment_number', labelAr: 'رقم السند' },
          { key: 'payment_type', labelAr: 'النوع' },
          { key: 'party_id', labelAr: 'الطرف' },
          { key: 'payment_date', labelAr: 'التاريخ', kind: 'date' },
          { key: 'payment_method', labelAr: 'طريقة الدفع' },
          { key: 'amount', labelAr: 'المبلغ', kind: 'money' },
          { key: 'currency', labelAr: 'العملة' },
          { key: 'amount_egp', labelAr: 'بالجنيه', kind: 'money' },
          { key: 'allocation_count', labelAr: 'التخصيصات', kind: 'number' },
        ]}
      />

      <CloudRpcPanel
        title="الشيكات"
        sourceLabel="fin.cheques (list_cheques)"
        rpc="list_cheques"
        params={{ p_status: null, p_limit: 200, p_offset: 0 }}
        searchKeys={['cheque_number', 'party_id', 'bank_name', 'status']}
        columns={[
          { key: 'cheque_number', labelAr: 'رقم الشيك' },
          { key: 'cheque_type', labelAr: 'النوع' },
          { key: 'party_id', labelAr: 'الطرف' },
          { key: 'bank_name', labelAr: 'البنك' },
          { key: 'amount', labelAr: 'المبلغ', kind: 'money' },
          { key: 'currency', labelAr: 'العملة' },
          { key: 'due_date', labelAr: 'الاستحقاق', kind: 'date' },
          { key: 'status', labelAr: 'الحالة' },
        ]}
      />
    </div>
  );
}
