// Quality inspections (TEST only).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createCloudQualityInspection,
  listCloudProductionOrders,
  listCloudQualityInspections,
  type CloudProductionOrder,
  type CloudQualityInspection,
} from '../../../services/cloudManufacturing';
import { readCoreMaster, type CoreMasterRecord } from '../../../services/coreMasterRead';
import { CloudRpcPanel } from './CloudRpcPanel';

export function CloudQualityPanel() {
  const today = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  type DraftLine = {
    itemId: string;
    lotNumber: string;
    quantity: number;
    result: 'passed' | 'rejected' | 'conditional' | 'pending';
    comment: string;
  };

  type DraftState = {
    header: {
      productionOrderId: string;
      date: string;
      destinationWarehouseId: string;
      result: 'passed' | 'rejected' | 'conditional' | 'pending';
      notes: string;
    };
    lines: DraftLine[];
  };

  const [draft, setDraft] = useState<DraftState>({
    header: {
      productionOrderId: '',
      date: today(),
      destinationWarehouseId: '',
      result: 'pending',
      notes: '',
    },
    lines: [],
  });

  const [orders, setOrders] = useState<CloudProductionOrder[]>([]);
  const [inspections, setInspections] = useState<CloudQualityInspection[]>([]);
  const [filters, setFilters] = useState({ result: null as string | null });
  const [items, setItems] = useState<CoreMasterRecord[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSubmitting(false);
    setSuccess(null);
    const loadOrders = listCloudProductionOrders(null, null, null).then(r => r.ok ? r.data : []);
    const loadInspections = listCloudQualityInspections(null, null, filters.result).then(r => r.ok ? r.data : []);
    const loadItems = readCoreMaster('items').then(r => (r.ok ? r.data : []));
    const all = Promise.all([loadOrders, loadInspections, loadItems]);
    void all.then(([o, i, m]) => {
      if (!cancelled) {
        setOrders(o as CloudProductionOrder[]);
        setInspections(i as CloudQualityInspection[]);
        setItems(m);
      }
    });
    return () => { cancelled = true; };
  }, [filters.result]);

  const addLine = useCallback(() => {
    setDraft(d => ({
      ...d,
      lines: [...d.lines, { itemId: '', lotNumber: '', quantity: 1, result: 'pending', comment: '' }],
    }));
  }, []);

  const updateLine = useCallback((index: number, key: keyof DraftLine, value: string | number) => {
    setDraft(d => {
      const lines = [...d.lines];
      if (index < 0 || index >= lines.length) return d;
      lines[index] = { ...lines[index], [key]: value };
      return { ...d, lines };
    });
  }, []);

  const removeLine = useCallback((index: number) => {
    setDraft(d => ({
      ...d,
      lines: d.lines.filter((_, i) => i !== index),
    }));
  }, []);

  const handleCreate = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const { header, lines } = draft;
    if (!header.productionOrderId) {
      setError('الرجاء اختيار أمر الإنتاج.');
      return;
    }
    if (lines.length === 0) {
      setError('الرجاء إضافة بند واحد على الأقل.');
      return;
    }
    setSubmitting(true);
    try {
      for (const line of lines) {
        const input = {
          productionOrderId: header.productionOrderId,
          itemId: line.itemId,
          quantity: line.quantity,
          date: header.date,
          result: line.result as 'passed' | 'rejected' | 'conditional' | 'pending',
          destinationWarehouseId: header.destinationWarehouseId || null,
          notes: header.notes,
        };
        const result = await createCloudQualityInspection(input as Parameters<typeof createCloudQualityInspection>[0]);
        if (!result.ok) {
          setError(result.messageAr);
          return;
        }
      }
      setSuccess('تم إنشاء فحوصات الجودة.');
      setDraft({
        header: {
          productionOrderId: '',
          date: today(),
          destinationWarehouseId: '',
          result: 'pending',
          notes: '',
        },
        lines: [],
      });
      const freshInspections = await listCloudQualityInspections(null, null, filters.result);
      if (freshInspections.ok) setInspections(freshInspections.data);
    } catch (err) {
      setError(`تعذّر إنشاء فحوصات الجودة: ${String((err as Error).message ?? err).slice(0, 300)}`);
    } finally {
      setSubmitting(false);
    }
  }, [draft, filters.result, today]);

  const pendingInspections = inspections.filter((ins) => ins.result === 'pending');
  const passedInspections = inspections.filter((ins) => ins.result === 'passed');
  const rejectedInspections = inspections.filter((ins) => ins.result === 'rejected');
  const conditionalInspections = inspections.filter((ins) => ins.result === 'conditional');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-black text-slate-900">فحوصات الجودة</h2>
          <p className="text-xs text-slate-500 mt-1">
            {inspections.length === 0
              ? 'لا توجد فحوصات جودة بعد.'
              : `${inspections.length} فحص جودة — قراءة وعمل سحابيان`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate((prev) => !prev)}
          className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 disabled:opacity-40"
        >
          {showCreate ? 'إلغاء' : 'إنشاء فحص'}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="space-y-4 bg-white rounded-2xl border border-slate-200 p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="space-y-1">
              <span className="text-xs font-bold text-slate-600">أمر الإنتاج</span>
              <select
                value={draft.header.productionOrderId}
                onChange={(e) => setDraft(d => ({ ...d, header: { ...d.header, productionOrderId: e.target.value } }))}
                className="w-full rounded-lg border-slate-300 bg-white text-xs py-2 px-3"
              >
                <option value="">— اختر أمر الإنتاج —</option>
                {orders.map((o) => (
                  <option key={o.orderId} value={o.orderId}>
                    {o.orderNumber} — {o.orderId}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-bold text-slate-600">تاريخ الفحص</span>
              <input
                type="date"
                value={draft.header.date}
                onChange={(e) => setDraft(d => ({ ...d, header: { ...d.header, date: e.target.value } }))}
                className="w-full rounded-lg border-slate-300 bg-white text-xs py-2 px-3"
              />
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="space-y-1">
              <span className="text-xs font-bold text-slate-600">مستودع التوجيه</span>
              <select
                value={draft.header.destinationWarehouseId}
                onChange={(e) => setDraft(d => ({ ...d, header: { ...d.header, destinationWarehouseId: e.target.value } }))}
                className="w-full rounded-lg border-slate-300 bg-white text-xs py-2 px-3"
              >
                <option value="">— اختر المستودع —</option>
                <option value="azm-zkh-01">azm-zkh-01 — احتياطي</option>
                <option value="azm-zkh-02">azm-zkh-02 — صادر</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-bold text-slate-600">حالة الفحص</span>
              <select
                value={draft.header.result}
                onChange={(e) => setDraft(d => ({ ...d, header: { ...d.header, result: e.target.value as DraftState['header']['result'] } }))}
                className="w-full rounded-lg border-slate-300 bg-white text-xs py-2 px-3"
              >
                <option value="pending">معلقة</option>
                <option value="passed">مقبولة</option>
                <option value="rejected">مرفوضة</option>
                <option value="conditional">مقبولة بشرط</option>
              </select>
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="space-y-1">
              <span className="text-xs font-bold text-slate-600">ملاحظات</span>
              <input
                type="text"
                value={draft.header.notes}
                onChange={(e) => setDraft(d => ({ ...d, header: { ...d.header, notes: e.target.value } }))}
                className="w-full rounded-lg border-slate-300 bg-white text-xs py-2 px-3"
              />
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-600">النسجات</span>
              <button
                type="button"
                onClick={addLine}
                className="px-2 py-1 rounded-lg bg-slate-100 text-slate-700 text-xs font-bold hover:bg-slate-200"
              >
                + إضافة بند
              </button>
            </div>
            {draft.lines.map((line, idx) => (
              <div key={idx} className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                <select
                  value={line.itemId}
                  onChange={(e) => updateLine(idx, 'itemId', e.target.value)}
                  className="rounded-lg border-slate-300 bg-white text-xs py-1.5 px-2"
                >
                  <option value="">الصنف</option>
                  {items
                    .filter((i) => i.active)
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.nameAr}
                      </option>
                    ))}
                </select>
                <input
                  type="text"
                  value={line.lotNumber}
                  onChange={(e) => updateLine(idx, 'lotNumber', e.target.value)}
                  placeholder="دفعة / رقم دفعة"
                  className="rounded-lg border-slate-300 bg-white text-xs py-1.5 px-2"
                />
                <input
                  type="number"
                  min={0}
                  step="1"
                  value={line.quantity}
                  onChange={(e) => updateLine(idx, 'quantity', Number(e.target.value))}
                  className="rounded-lg border-slate-300 bg-white text-xs py-1.5 px-2"
                />
                <select
                  value={line.result}
                  onChange={(e) => updateLine(idx, 'result', e.target.value as DraftLine['result'])}
                  className="rounded-lg border-slate-300 bg-white text-xs py-1.5 px-2"
                >
                  <option value="pending">معلقة</option>
                  <option value="passed">مقبولة</option>
                  <option value="rejected">مرفوضة</option>
                  <option value="conditional">مقبولة بشرط</option>
                </select>
                <input
                  type="text"
                  value={line.comment}
                  onChange={(e) => updateLine(idx, 'comment', e.target.value)}
                  placeholder="ملاحظة"
                  className="rounded-lg border-slate-300 bg-white text-xs py-1.5 px-2"
                />
              </div>
            ))}
          </div>

          {draft.lines.length >= 1 && (
            <button
              type="button"
              onClick={() => removeLine(draft.lines.length - 1)}
              className="px-2 py-1 rounded-lg bg-rose-100 text-rose-700 text-xs font-bold hover:bg-rose-200"
            >
              إزالة آخر بند
            </button>
          )}

          {error && (
            <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 text-xs text-rose-800">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="submit"
              disabled={submitting}
              className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 disabled:opacity-40"
            >
              {submitting ? 'جارٍ الإنشاء…' : 'إنشاء فحص الجودة'}
            </button>
          </div>
        </form>
      )}

      {(pendingInspections.length > 0 || passedInspections.length > 0 || rejectedInspections.length > 0 || conditionalInspections.length > 0) && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white rounded-xl border border-slate-200 p-3">
            <p className="text-xs text-slate-500">معلقة</p>
            <p className="text-lg font-black text-slate-900">{pendingInspections.length}</p>
          </div>
          <div className="bg-white rounded-xl border border-emerald-200 p-3">
            <p className="text-xs text-emerald-700">مقبولة</p>
            <p className="text-lg font-black text-emerald-800">{passedInspections.length}</p>
          </div>
          <div className="bg-white rounded-xl border border-rose-200 p-3">
            <p className="text-xs text-rose-700">مرفوضة</p>
            <p className="text-lg font-black text-rose-800">{rejectedInspections.length}</p>
          </div>
          <div className="bg-white rounded-xl border border-amber-200 p-3">
            <p className="text-xs text-amber-700">مقيدة</p>
            <p className="text-lg font-black text-amber-800">{conditionalInspections.length}</p>
          </div>
        </div>
      )}

      <CloudRpcPanel
        title="فحوصات الجودة (السحابة)"
        sourceLabel="production.quality_inspections (list_cloud_quality_inspections)"
        rpc="list_cloud_quality_inspections"
        params={{ p_from: null, p_to: null, p_result: filters.result, p_limit: 200, p_offset: 0 }}
        searchKeys={['inspection_id', 'production_order_id', 'item_name_ar', 'destination_code', 'result']}
        columns={[
          { key: 'inspectionId', labelAr: 'رقم الفحص' },
          { key: 'productionOrderId', labelAr: 'أمر الإنتاج' },
          { key: 'itemNameAr', labelAr: 'المنتج' },
          { key: 'inspectionDate', labelAr: 'تاريخ الفحص', kind: 'date' },
          { key: 'destinationCode', labelAr: 'مستودع التوجيه' },
          { key: 'result', labelAr: 'الحالة' },
          { key: 'notes', labelAr: 'ملاحظات', kind: 'text' },
        ]}
        footerNote="فحوصات الجودة — قراءة سحابية فقط عبر list_cloud_quality_inspections."
      />
    </div>
  );
}
