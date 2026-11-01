// Small always-visible indicator of the cloud connection, plus the notices the
// user must see: a refused save (another device changed the same data first),
// an expired session, or a lost connection with unsaved edits.

import React, { useEffect, useState } from 'react';
import { CloudSync, SyncStatus } from '../../services/cloud/syncEngine';

const REASON_AR: Record<string, string> = {
  stale: 'تم تعديله من جهاز آخر',
  deleted: 'تم حذفه من جهاز آخر',
  exists: 'موجود بالفعل',
  duplicate_number: 'رقم المستند استُخدم بالفعل من جهاز آخر',
};

function useSyncStatus(sync: CloudSync): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>(sync.getStatus());
  useEffect(() => {
    setStatus(sync.getStatus());
    return sync.subscribe(setStatus);
  }, [sync]);
  return status;
}

interface Props {
  sync: CloudSync;
  email?: string;
  onSignOut: () => void;
  onRelogin: () => void;
}

export const SyncBadge: React.FC<Props> = ({ sync, email, onSignOut, onRelogin }) => {
  const status = useSyncStatus(sync);
  const [open, setOpen] = useState(false);

  // warn before closing the tab while edits are not saved yet
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (sync.getStatus().pending) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [sync]);

  let tone = 'bg-emerald-50 border-emerald-200 text-emerald-800';
  let label = 'تم الحفظ';
  if (status.state === 'saving' || (status.pending && status.state === 'idle')) {
    tone = 'bg-sky-50 border-sky-200 text-sky-800';
    label = 'جاري الحفظ…';
  } else if (status.state === 'offline') {
    tone = 'bg-amber-50 border-amber-300 text-amber-900';
    label = 'لا يوجد اتصال — لم تُحفظ آخر التغييرات';
  } else if (status.state === 'error') {
    tone = 'bg-red-50 border-red-300 text-red-800';
    label = 'تعذّر الحفظ';
  }

  const notice = status.notice;

  return (
    <>
      {notice && (
        <div className="fixed top-3 inset-x-3 z-[100] mx-auto max-w-xl rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-lg text-right" dir="rtl" role="alert">
          <p className="font-bold text-amber-900 text-sm mb-1">تنبيه: لم تُحفظ العملية الأخيرة</p>
          <p className="text-amber-900 text-sm leading-6">{notice.message}</p>
          {notice.conflicts.length > 0 && (
            <ul className="mt-2 text-xs text-amber-800 list-disc pr-5 space-y-0.5">
              {notice.conflicts.slice(0, 5).map((c, i) => (
                <li key={i}>
                  {c.collection === '__singletons' ? c.id : c.collection} — {REASON_AR[c.reason] || c.reason}
                  {c.number ? ` (${c.number})` : ''}
                </li>
              ))}
            </ul>
          )}
          <button
            onClick={() => sync.dismissNotice()}
            className="mt-3 px-4 py-1.5 rounded-lg bg-amber-600 text-white text-sm font-bold cursor-pointer"
          >
            فهمت
          </button>
        </div>
      )}

      <div className="fixed bottom-3 left-3 z-[90] text-right" dir="rtl">
        <button
          onClick={() => setOpen(o => !o)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-bold shadow-sm cursor-pointer ${tone}`}
          title="حالة الاتصال بالسحابة"
        >
          <span className="inline-block w-2 h-2 rounded-full bg-current opacity-80" />
          {label}
        </button>

        {open && (
          <div className="mt-2 w-72 rounded-xl border border-cream-300 bg-white p-3 shadow-lg text-xs text-ink-800 space-y-2">
            {email && <p className="font-bold break-all">{email}</p>}
            {status.message && <p className="leading-5">{status.message}</p>}
            {status.lastSavedAt && (
              <p className="text-cream-700">آخر حفظ: {new Date(status.lastSavedAt).toLocaleTimeString('ar-EG')}</p>
            )}
            {status.code === 'auth' && (
              <button onClick={onRelogin} className="w-full py-1.5 rounded-lg bg-brand-500 text-white font-bold cursor-pointer">
                تسجيل الدخول من جديد
              </button>
            )}
            {status.state === 'error' && status.code !== 'auth' && (
              <button onClick={() => sync.flushNow()} className="w-full py-1.5 rounded-lg bg-brand-500 text-white font-bold cursor-pointer">
                إعادة المحاولة
              </button>
            )}
            <button onClick={onSignOut} className="w-full py-1.5 rounded-lg border border-cream-300 font-bold cursor-pointer">
              تسجيل الخروج من السحابة
            </button>
          </div>
        )}
      </div>
    </>
  );
};
