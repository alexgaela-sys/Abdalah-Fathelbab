// Read-only cloud panels for four ORIGINAL screens that previously had no
// cloud path: banks, cheques, expenses and export shipments.
//
// Every panel reads ONE existing TEST read RPC (no new SQL, no duplicate
// function, no write path) through the shared CloudRpcPanel, which prints the
// exact source, shows explicit loading/error states and never falls back to the
// localStorage snapshot.

import React from 'react';
import { CloudRpcPanel } from './CloudRpcPanel';

const pageIntro = (text: string) => (
  <div>
    <h2 className="text-xl font-black text-slate-900">{text}</h2>
    <p className="text-xs text-slate-500 mt-1">
      قراءة فقط من Supabase TEST. الإضافة والتحصيل والترحيل تبقى عبر دوال الخادم بعد اختبارات
      التكافؤ واعتماد الصلاحيات ومفاتيح الحسابات.
    </p>
  </div>
);

export function CloudBanksPanel() {
  return (
    <div className="space-y-4">
      {pageIntro('البنوك')}
      <CloudRpcPanel
        title="الحسابات البنكية"
        sourceLabel="core.bank_accounts (list_bank_accounts)"
        rpc="list_bank_accounts"
        params={{}}
        searchKeys={['bank_name', 'account_number', 'currency']}
        columns={[
          { key: 'bank_name', labelAr: 'البنك' },
          { key: 'account_number', labelAr: 'رقم الحساب' },
          { key: 'branch', labelAr: 'الفرع' },
          { key: 'currency', labelAr: 'العملة' },
          { key: 'current_balance', labelAr: 'الرصيد', kind: 'money' },
          { key: 'gl_account_id', labelAr: 'حساب الأستاذ' },
          { key: 'active', labelAr: 'فعّال' },
        ]}
      />
      <CloudRpcPanel
        title="حركة الحسابات البنكية"
        sourceLabel="fin.bank_transactions (list_bank_transactions)"
        rpc="list_bank_transactions"
        params={{ p_from: null, p_to: null, p_bank_account_id: null, p_limit: 200, p_offset: 0 }}
        searchKeys={['transaction_number', 'transaction_type', 'reference']}
        columns={[
          { key: 'transaction_number', labelAr: 'رقم الحركة' },
          { key: 'transaction_date', labelAr: 'التاريخ', kind: 'date' },
          { key: 'transaction_type', labelAr: 'النوع' },
          { key: 'amount', labelAr: 'المبلغ', kind: 'money' },
          { key: 'currency', labelAr: 'العملة' },
          { key: 'reference', labelAr: 'المرجع' },
        ]}
      />
    </div>
  );
}

export function CloudChequesPanel() {
  return (
    <div className="space-y-4">
      {pageIntro('الشيكات')}
      <CloudRpcPanel
        title="الشيكات"
        sourceLabel="fin.cheques (list_cheques)"
        rpc="list_cheques"
        params={{ p_status: null, p_limit: 200, p_offset: 0 }}
        searchKeys={['cheque_number', 'bank_name', 'status', 'cheque_type']}
        columns={[
          { key: 'cheque_number', labelAr: 'رقم الشيك' },
          { key: 'cheque_type', labelAr: 'النوع' },
          { key: 'party_type', labelAr: 'الطرف' },
          { key: 'bank_name', labelAr: 'البنك' },
          { key: 'amount', labelAr: 'المبلغ', kind: 'money' },
          { key: 'currency', labelAr: 'العملة' },
          { key: 'issue_date', labelAr: 'تاريخ الإصدار', kind: 'date' },
          { key: 'due_date', labelAr: 'تاريخ الاستحقاق', kind: 'date' },
          { key: 'status', labelAr: 'الحالة' },
        ]}
      />
    </div>
  );
}

export function CloudExpensesPanel() {
  return (
    <div className="space-y-4">
      {pageIntro('المصروفات')}
      <CloudRpcPanel
        title="المصروفات"
        sourceLabel="fin.expenses (list_expenses)"
        rpc="list_expenses"
        params={{ p_from: null, p_to: null, p_limit: 200, p_offset: 0 }}
        searchKeys={['expense_number', 'category', 'description']}
        columns={[
          { key: 'expense_number', labelAr: 'رقم المصروف' },
          { key: 'expense_date', labelAr: 'التاريخ', kind: 'date' },
          { key: 'category', labelAr: 'التصنيف' },
          { key: 'amount', labelAr: 'المبلغ', kind: 'money' },
          { key: 'vat_amount', labelAr: 'ض.ق.م', kind: 'money' },
          { key: 'total_amount', labelAr: 'الإجمالي', kind: 'money' },
          { key: 'description', labelAr: 'البيان' },
        ]}
      />
    </div>
  );
}

export function CloudExportPanel() {
  return (
    <div className="space-y-4">
      {pageIntro('التصدير')}
      <CloudRpcPanel
        title="شحنات التصدير"
        sourceLabel="sales.export_shipments (list_export_shipments)"
        rpc="list_export_shipments"
        params={{ p_from: null, p_to: null, p_limit: 200, p_offset: 0 }}
        searchKeys={['shipment_number', 'destination_port', 'status', 'collection_status']}
        columns={[
          { key: 'shipment_number', labelAr: 'رقم الشحنة' },
          { key: 'shipment_date', labelAr: 'التاريخ', kind: 'date' },
          { key: 'destination_port', labelAr: 'الميناء' },
          { key: 'usd_revenue', labelAr: 'الإيراد $', kind: 'money' },
          { key: 'egp_value', labelAr: 'القيمة ج.م', kind: 'money' },
          { key: 'total_costs', labelAr: 'التكاليف', kind: 'money' },
          { key: 'net_profit_egp', labelAr: 'صافي الربح', kind: 'money' },
          { key: 'collection_status', labelAr: 'التحصيل' },
          { key: 'status', labelAr: 'الحالة' },
        ]}
        hint="قراءة فقط: إنشاء شحنة أو ربطها بفاتورة تصدير يبقى عبر دوال الخادم بعد التكافؤ."
      />
    </div>
  );
}
