// Read-only cloud accounting screen (دفتر اليومية + ميزان المراجعة).
// Reads the existing TEST RPCs public.list_journal_entries and public.trial_balance.
// No journal may be created/edited from here — posting stays a server RPC.

import React, { useState } from 'react';
import { CloudRpcPanel } from './CloudRpcPanel';
import { CloudJournalPostForm } from './CloudJournalPostForm';

export function CloudLedgerPanel() {
  const [refreshToken, setRefreshToken] = useState(0);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-black text-slate-900">المحاسبة والقيود</h2>
        <p className="text-xs text-slate-500 mt-1">
          قراءة من مخطط fin/core في Supabase TEST، وترحيل القيود اليدوية متاح لدور المحاسب المعتمد فقط
          عبر <span className="font-mono">public.post_journal</span> (فترة مفتوحة + قيد متزن + بلا حسابات رئيسية).
        </p>
      </div>

      <CloudJournalPostForm onPosted={() => setRefreshToken(n => n + 1)} />

      <CloudRpcPanel
        title="دفتر اليومية"
        sourceLabel="fin.journal_entries (list_journal_entries)"
        rpc="list_journal_entries"
        params={{ p_from: null, p_to: null, p_limit: 200, p_offset: 0 }}
        searchKeys={['entry_number', 'reference', 'description', 'source_document_type']}
        columns={[
          { key: 'entry_number', labelAr: 'رقم القيد' },
          { key: 'entry_date', labelAr: 'التاريخ', kind: 'date' },
          { key: 'reference', labelAr: 'المرجع' },
          { key: 'description', labelAr: 'البيان' },
          { key: 'source_document_type', labelAr: 'نوع المستند' },
          { key: 'total_debit', labelAr: 'مدين', kind: 'money' },
          { key: 'total_credit', labelAr: 'دائن', kind: 'money' },
          { key: 'is_posted', labelAr: 'مُرحَّل' },
          { key: 'is_reversed', labelAr: 'معكوس' },
        ]}
        hint="تُحدَّث تلقائيًا بعد كل قيد مُرحَّل من النموذج أعلاه."
        refreshToken={refreshToken}
      />

      <CloudRpcPanel
        title="ميزان المراجعة"
        sourceLabel="fin.journal_lines (trial_balance)"
        rpc="trial_balance"
        params={{ p_from: null, p_to: null }}
        searchKeys={['account_code', 'account_name_ar', 'category']}
        columns={[
          { key: 'account_code', labelAr: 'الكود' },
          { key: 'account_name_ar', labelAr: 'الحساب' },
          { key: 'category', labelAr: 'التصنيف' },
          { key: 'debit', labelAr: 'مدين', kind: 'money' },
          { key: 'credit', labelAr: 'دائن', kind: 'money' },
          { key: 'net_debit', labelAr: 'الصافي', kind: 'money' },
        ]}
        footerNote="الميزان محسوب على الخادم من القيود المُرحَّلة فقط؛ لا تُجمَّع أي أرقام محليًا."
      />
    </div>
  );
}
