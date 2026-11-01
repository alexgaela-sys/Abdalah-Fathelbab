// Read-only cloud purchasing screen (فواتير المشتريات + مرتجعاتها).
// Reads the existing TEST RPCs list_purchasing_invoices and list_purchase_returns.
// Creating a purchase invoice stays behind fin.post_purchase_invoice, which is
// NOT called from this screen.

import React from 'react';
import { CloudRpcPanel } from './CloudRpcPanel';

export function CloudPurchasingPanel() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-black text-slate-900">المشتريات والموردون</h2>
        <p className="text-xs text-slate-500 mt-1">
          قراءة فقط من مخطط purchasing في Supabase TEST. الإدخال المخزني للمشتريات يتم على الخادم داخل
          fin.post_purchase_invoice بعد اختبارات التكافؤ.
        </p>
      </div>

      <CloudRpcPanel
        title="فواتير المشتريات"
        sourceLabel="purchasing.invoices (list_purchasing_invoices)"
        rpc="list_purchasing_invoices"
        params={{ p_from: null, p_to: null, p_status: null, p_limit: 200, p_offset: 0 }}
        searchKeys={['invoice_number', 'supplier_id', 'warehouse_id', 'status']}
        columns={[
          { key: 'invoice_number', labelAr: 'رقم الفاتورة' },
          { key: 'invoice_date', labelAr: 'التاريخ', kind: 'date' },
          { key: 'supplier_id', labelAr: 'المورد' },
          { key: 'warehouse_id', labelAr: 'المستودع' },
          { key: 'currency', labelAr: 'العملة' },
          { key: 'subtotal', labelAr: 'قبل الضريبة', kind: 'money' },
          { key: 'vat_amount', labelAr: 'الضريبة', kind: 'money' },
          { key: 'total_amount', labelAr: 'الإجمالي', kind: 'money' },
          { key: 'total_amount_egp', labelAr: 'بالجنيه', kind: 'money' },
          { key: 'line_count', labelAr: 'عدد البنود', kind: 'number' },
          { key: 'status', labelAr: 'الحالة' },
        ]}
      />

      <CloudRpcPanel
        title="مرتجعات المشتريات"
        sourceLabel="purchasing.returns (list_purchase_returns)"
        rpc="list_purchase_returns"
        params={{ p_from: null, p_to: null, p_limit: 200, p_offset: 0 }}
        searchKeys={['return_number', 'supplier_id', 'status']}
        columns={[
          { key: 'return_number', labelAr: 'رقم المرتجع' },
          { key: 'return_date', labelAr: 'التاريخ', kind: 'date' },
          { key: 'supplier_id', labelAr: 'المورد' },
          { key: 'warehouse_id', labelAr: 'المستودع' },
          { key: 'total_amount', labelAr: 'الإجمالي', kind: 'money' },
          { key: 'status', labelAr: 'الحالة' },
        ]}
        footerNote="قراءة فقط؛ لا تُنشأ مرتجعات من هذه الشاشة."
      />
    </div>
  );
}
