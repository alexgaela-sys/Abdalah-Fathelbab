// Stock transfer / inventory write surface (TEST only).

import React, { useState } from 'react';
import { CloudRpcPanel } from './CloudRpcPanel';

export function CloudInventoryWritePanel() {
  const [ready] = useState(true);

  if (!ready) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-black text-slate-900">تحويل المخزون</h2>
        <p className="text-xs text-slate-500 mt-1">سطح الكتابة السحابي — يبحث عن الخدمات الفعلية أولاً.</p>
      </div>

      <CloudRpcPanel
        title="كتابة تحويل المخزون"
        sourceLabel="تُربط عند وجود دالة write سحابية متاحة"
        rpc="post_inventory_transfer"
        params={{ p_item_id: null, p_source_warehouse_id: null, p_target_warehouse_id: null, p_quantity: null }}
        searchKeys={['item_id', 'source_warehouse_id', 'target_warehouse_id', 'quantity']}
        columns={[
          { key: 'document_number', labelAr: 'رقم التحويل' },
          { key: 'item_id', labelAr: 'الصنف' },
          { key: 'source_warehouse_id', labelAr: 'مستودع المصدر' },
          { key: 'target_warehouse_id', labelAr: 'مستودع الوجهة' },
          { key: 'quantity', labelAr: 'الكمية', kind: 'number' },
          { key: 'date', labelAr: 'التاريخ', kind: 'date' },
          { key: 'notes', labelAr: 'ملاحظات', kind: 'text' },
        ]}
        footerNote="هذا السطح يُفعّل فقط عند توفر دالة التحويل السحابية المكتملة."
      />
    </div>
  );
}
