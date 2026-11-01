// Read-only cloud view for warehouses inside the ORIGINAL warehouses screen.
//
// Boundaries:
//   * reads public.erp_warehouses for a signed-in TEST account (Viewer is enough),
//   * READ-ONLY in this phase: no create/update/delete buttons and no write calls,
//   * never imports erpDb, never reads or writes localStorage,
//   * never uploads, replaces or merges the local warehouses; the two lists stay
//     in separate containers with separate headers,
//   * no silent fallback: a failure shows as an error and nothing local is shown
//     in its place.

import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, Cloud, CloudOff, RefreshCw, ShieldCheck } from 'lucide-react';
import { readCoreMaster, type CoreMasterRecord } from '../../../services/coreMasterRead';
import {
  currentSupabaseTestUser,
  signInSupabaseTest,
  signOutSupabaseTest,
} from '../../../services/supabaseTestClient';

type Banner = { tone: 'ok' | 'error' | 'info'; text: string } | null;

export const WarehousesCloudTestPanel: React.FC<{ localCount: number }> = ({ localCount }) => {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [rows, setRows] = useState<CoreMasterRecord[]>([]);
  const [banner, setBanner] = useState<Banner>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const handleSignIn = () => run(async () => {
    const res = await signInSupabaseTest(email.trim(), password);
    if (!res.ok) {
      setBanner({ tone: 'error', text: res.message });
      return;
    }
    setPassword('');
    setSessionEmail(res.email);
    setBanner({ tone: 'ok', text: `جلسة TEST جاهزة: ${res.email ?? ''} (في الذاكرة فقط).` });
  });

  const handleSignOut = () => run(async () => {
    await signOutSupabaseTest();
    setSessionEmail(null);
    setRows([]);
    setLoaded(false);
    setBanner({ tone: 'info', text: 'أُنهيت الجلسة السحابية. الوضع المحلي لم يتأثر.' });
  });

  const handleRefreshSession = () => run(async () => {
    setSessionEmail(await currentSupabaseTestUser());
  });

  const handleLoad = () => run(async () => {
    const res = await readCoreMaster('warehouses');
    if (!res.ok) {
      setRows([]);
      setLoaded(false);
      setBanner({ tone: 'error', text: `${res.messageAr} — لا تُعرض أي بيانات محلية بدلًا منها.` });
      return;
    }
    setRows(res.data);
    setLoaded(true);
    setBanner({
      tone: 'ok',
      text: `تم تحميل ${res.data.length} صفًا من core.warehouses في TEST (قراءة فقط). القائمة المحلية (${localCount}) لم تتغيّر.`,
    });
  });

  return (
    <div className="mt-4 border-2 border-dashed border-sky-300 rounded-2xl bg-sky-50/40">
      <div className="flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="flex items-center gap-2">
          <Cloud className="w-4 h-4 text-sky-700" />
          <div>
            <h4 className="text-xs font-black text-sky-900">عرض سحابي للقراءة فقط (TEST) — منفصل عن الوضع المحلي</h4>
            <p className="text-[10px] text-sky-800/80">
              يقرأ <span className="font-mono">core.warehouses</span> في Supabase TEST فقط. لا يرفع المستودعات المحلية ({localCount}) ولا يستبدلها ولا يدمجها، ولا يكتب في السحابة.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-1 rounded-lg bg-white border border-sky-200 text-[10px] font-bold text-sky-800 flex items-center gap-1">
            <ShieldCheck className="w-3 h-3" /> قراءة فقط
          </span>
          <button
            onClick={() => setOpen(o => !o)}
            className="px-3 py-1.5 rounded-lg bg-sky-700 text-white text-[11px] font-bold hover:bg-sky-800"
          >
            {open ? 'إغلاق العرض السحابي' : 'فتح العرض السحابي'}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-sky-200 p-3 space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[160px]">
              <label className="block text-[10px] font-bold text-slate-600 mb-1">بريد حساب QA</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                dir="ltr"
                className="w-full p-2 rounded-xl bg-white border border-slate-300 text-xs font-mono"
              />
            </div>
            <div className="flex-1 min-w-[160px]">
              <label className="block text-[10px] font-bold text-slate-600 mb-1">كلمة مرور QA</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                dir="ltr"
                className="w-full p-2 rounded-xl bg-white border border-slate-300 text-xs font-mono"
              />
            </div>
            <button
              onClick={handleSignIn}
              disabled={busy || !email || !password}
              className="px-3 py-2 rounded-lg bg-slate-900 text-white text-[11px] font-bold disabled:opacity-40"
            >
              دخول TEST
            </button>
            <button
              onClick={handleSignOut}
              disabled={busy}
              className="px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-700 text-[11px] font-bold disabled:opacity-40"
            >
              خروج
            </button>
            <button
              onClick={handleRefreshSession}
              disabled={busy}
              className="px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-700 text-[11px] font-bold disabled:opacity-40"
            >
              قراءة الجلسة
            </button>
            <span className="text-[10px] font-mono text-slate-500">
              {sessionEmail ? `TEST: ${sessionEmail}` : 'TEST: signed-out'}
            </span>
          </div>

          {banner && (
            <div
              className={`p-2.5 rounded-xl text-[11px] font-bold flex items-start gap-2 border ${
                banner.tone === 'ok'
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                  : banner.tone === 'error'
                    ? 'bg-rose-50 text-rose-800 border-rose-200'
                    : 'bg-white text-slate-700 border-slate-200'
              }`}
            >
              {banner.tone === 'ok' ? (
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              ) : banner.tone === 'error' ? (
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              ) : (
                <CloudOff className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              )}
              <span>{banner.text}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleLoad}
              disabled={busy}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-sky-700 text-white text-[11px] font-bold disabled:opacity-40"
            >
              <RefreshCw className="w-3.5 h-3.5" /> تحميل المستودعات السحابية
            </button>
            <span className="text-[10px] font-mono text-slate-500">cloudRows={rows.length}</span>
            <span className="text-[10px] font-mono text-slate-500">localRows={localCount}</span>
          </div>

          {loaded && rows.length === 0 && (
            <p className="text-[11px] text-slate-500">لا صفوف سحابية في TEST.</p>
          )}

          {rows.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-sky-200 bg-white">
              <table className="w-full text-[11px]" dir="ltr">
                <thead className="bg-sky-100 text-sky-900">
                  <tr>
                    <th className="p-2 text-left">code</th>
                    <th className="p-2 text-left">nameAr</th>
                    <th className="p-2 text-left">location</th>
                    <th className="p-2 text-left">type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-sky-100 font-mono text-slate-700">
                  {rows.map(row => (
                    <tr key={row.id}>
                      <td className="p-2">{row.code}</td>
                      <td className="p-2">{row.nameAr}</td>
                      <td className="p-2">{String(row.payload.location ?? '—')}</td>
                      <td className="p-2">{String(row.payload.type ?? '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-[10px] text-slate-500">
            لا توجد أزرار كتابة في هذه المرحلة، وأي فشل اتصال أو صلاحية يظهر هنا فقط دون أي كتابة في المتجر المحلي.
          </p>
        </div>
      )}
    </div>
  );
};
