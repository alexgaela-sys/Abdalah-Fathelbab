// TEST-ONLY POC panel. Rendered only when the URL has ?poc=1 (see src/main.tsx),
// so no ERP screen is touched or replaced in normal use.
//
// It proves: write-once creation, JSON read-back, stale-version rejection and
// concurrent-update conflict handling against Supabase TEST, using synthetic
// JSON only. No localStorage, no erpDb, no production data.

import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, Cloud, RefreshCw, Save, XCircle } from 'lucide-react';
import {
  POC_DOC_KEY,
  POC_SCOPE,
  currentPocUser,
  loadPocDoc,
  makeSyntheticDoc,
  pocConfigured,
  savePocDoc,
  signInPoc,
  signOutPoc,
  type PocDocument,
} from '../../../services/jsonDocPoc';
import {
  listCloudWarehouses,
  makeSyntheticWarehouse,
  saveCloudWarehouse,
  type CloudWarehouse,
} from '../../../services/cloudWarehouseSlice';

type Banner = { tone: 'ok' | 'error' | 'info'; text: string } | null;

// This phase is READ-ONLY for cloud data. The POC's write actions stay in the
// codebase for the next phase but are hard-disabled here, with a clear message.
const CLOUD_WRITES_ENABLED = false;
const WRITES_DISABLED_MESSAGE = 'الكتابة السحابية معطّلة في مرحلة القراءة فقط — لا إنشاء/تعديل/حذف.';

export const JsonDocPocPanel: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [doc, setDoc] = useState<PocDocument | null>(null);
  const [banner, setBanner] = useState<Banner>({
    tone: 'info',
    text: 'لوحة POC تجريبية — تكتب في مشروع Supabase TEST فقط، ولا تقرأ أو ترفع بيانات ERP المحلية.',
  });
  const [busy, setBusy] = useState(false);

  // ---- Slice 1: warehouses master data (cloud, TEST only) ----
  const [warehouses, setWarehouses] = useState<CloudWarehouse[]>([]);
  const [whBanner, setWhBanner] = useState<Banner>(null);
  const [whBusy, setWhBusy] = useState(false);

  const handleWhLoad = async () => {
    setWhBusy(true);
    const res = await listCloudWarehouses();
    setWhBusy(false);
    if (!res.ok) {
      setWhBanner({ tone: 'error', text: res.messageAr });
      return;
    }
    setWarehouses(res.data);
    setWhBanner({ tone: 'ok', text: `تم تحميل ${res.data.length} مستودعًا من TEST.` });
  };

  const handleWhCreate = async () => {
    if (!CLOUD_WRITES_ENABLED) {
      setWhBanner({ tone: 'error', text: WRITES_DISABLED_MESSAGE });
      return;
    }
    setWhBusy(true);
    const draft = makeSyntheticWarehouse();
    const res = await saveCloudWarehouse(draft, 0);
    setWhBusy(false);
    if (!res.ok) {
      setWhBanner({ tone: 'error', text: res.messageAr });
      return;
    }
    setWhBanner({ tone: 'ok', text: `أُنشئ مستودع سحابي ${draft.code} (النسخة ${res.data.version}).` });
    await handleWhLoad();
  };

  const handleWhRename = async (wh: CloudWarehouse) => {
    if (!CLOUD_WRITES_ENABLED) {
      setWhBanner({ tone: 'error', text: WRITES_DISABLED_MESSAGE });
      return;
    }
    setWhBusy(true);
    const res = await saveCloudWarehouse(
      { ...wh, managerName: wh.managerName, location: `${wh.location} (محدّث)` },
      wh.version,
    );
    setWhBusy(false);
    if (!res.ok) {
      setWhBanner({ tone: 'error', text: `${res.messageAr}${res.currentVersion ? ` (النسخة الحالية: ${res.currentVersion})` : ''}` });
      return;
    }
    setWhBanner({ tone: 'ok', text: `تم تحديث ${wh.code} إلى النسخة ${res.data.version}.` });
    await handleWhLoad();
  };

  const handleWhStale = async (wh: CloudWarehouse) => {
    if (!CLOUD_WRITES_ENABLED) {
      setWhBanner({ tone: 'error', text: WRITES_DISABLED_MESSAGE });
      return;
    }
    setWhBusy(true);
    const res = await saveCloudWarehouse({ ...wh, location: 'محاولة بنسخة قديمة' }, Math.max(0, wh.version - 1));
    setWhBusy(false);
    if (res.ok) {
      setWhBanner({ tone: 'error', text: 'غير متوقع: قُبلت كتابة بنسخة قديمة.' });
      return;
    }
    setWhBanner({ tone: 'ok', text: `رُفضت الكتابة بنسخة قديمة كما هو مطلوب: ${res.kind}` });
  };

  const handleSignIn = async () => {
    setBusy(true);
    const res = await signInPoc(email.trim(), password);
    setBusy(false);
    if (!res.ok) {
      setBanner({ tone: 'error', text: res.messageAr });
      return;
    }
    setPassword('');
    setSessionEmail(res.data.email);
    setBanner({ tone: 'ok', text: `تم تسجيل الدخول بحساب الاختبار: ${res.data.email ?? ''}` });
  };

  const handleSignOut = async () => {
    await signOutPoc();
    setSessionEmail(null);
    setDoc(null);
    setBanner({ tone: 'info', text: 'تم إنهاء الجلسة السحابية (لا تأثير على جلسة ERP المحلية).' });
  };

  const handleRefreshUser = async () => {
    setSessionEmail(await currentPocUser());
  };

  const handleLoad = async () => {
    setBusy(true);
    const res = await loadPocDoc();
    setBusy(false);
    if (!res.ok) {
      setDoc(null);
      setBanner({ tone: 'error', text: res.messageAr });
      return;
    }
    setDoc(res.data);
    setBanner({
      tone: 'ok',
      text: res.data
        ? `تم تحميل المستند — النسخة ${res.data.version}.`
        : 'لا يوجد مستند بعد (النسخة المتوقعة للإنشاء الأول = 0).',
    });
  };

  const handleSave = async (expectedVersion: number) => {
    if (!CLOUD_WRITES_ENABLED) {
      setBanner({ tone: 'error', text: WRITES_DISABLED_MESSAGE });
      return;
    }
    setBusy(true);
    const payload = makeSyntheticDoc();
    const res = await savePocDoc(expectedVersion, payload);
    setBusy(false);
    if (!res.ok) {
      setBanner({
        tone: 'error',
        text: `${res.messageAr}${res.currentVersion ? ` (النسخة الحالية على الخادم: ${res.currentVersion})` : ''}`,
      });
      return;
    }
    setDoc({
      scope: POC_SCOPE,
      docKey: POC_DOC_KEY,
      version: res.data.version ?? expectedVersion,
      payload,
      updatedAt: new Date().toISOString(),
    });
    setBanner({
      tone: 'ok',
      text: res.data.status === 'created'
        ? `تم إنشاء المستند (النسخة ${res.data.version}).`
        : `تم التحديث إلى النسخة ${res.data.version}.`,
    });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-8" dir="rtl">
      <div className="max-w-4xl mx-auto space-y-5">
        <header className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-amber-500/15 text-amber-400 flex items-center justify-center">
            <Cloud className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-lg font-black">Supabase JSON Document — POC (TEST فقط)</h1>
            <p className="text-xs text-slate-400">
              النطاق <span className="font-mono">{POC_SCOPE}</span> · المستند{' '}
              <span className="font-mono">{POC_DOC_KEY}</span> · anon key + RLS + CAS على الخادم
            </p>
          </div>
        </header>

        {!pocConfigured() && (
          <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs font-bold text-rose-200 flex items-center gap-2">
            <XCircle className="w-4 h-4" /> متغيرات البيئة VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY غير مضبوطة.
          </div>
        )}

        {banner && (
          <div
            className={`rounded-2xl px-4 py-3 text-xs font-bold flex items-center gap-2 border ${
              banner.tone === 'ok'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                : banner.tone === 'error'
                  ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                  : 'border-slate-600 bg-slate-900 text-slate-300'
            }`}
          >
            {banner.tone === 'ok' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : banner.tone === 'error' ? (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            ) : (
              <Cloud className="w-4 h-4 shrink-0" />
            )}
            <span>{banner.text}</span>
          </div>
        )}

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4 space-y-3">
          <h2 className="text-sm font-black text-slate-200">1) جلسة حساب الاختبار</h2>
          <p className="text-[11px] text-slate-400">
            تُستخدم بيانات حساب QA الموجودة. لا تُخزَّن في localStorage ولا تُطبع في السجلات، والجلسة في الذاكرة فقط.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="QA test email"
              className="p-2 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono"
              dir="ltr"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="QA test password"
              className="p-2 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono"
              dir="ltr"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleSignIn}
              disabled={busy || !email || !password}
              className="px-3 py-1.5 rounded-lg bg-amber-500 text-slate-950 text-xs font-black disabled:opacity-40"
            >
              تسجيل الدخول
            </button>
            <button
              onClick={handleSignOut}
              className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 text-xs font-bold"
            >
              إنهاء الجلسة
            </button>
            <button
              onClick={handleRefreshUser}
              className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 text-xs font-bold flex items-center gap-1"
            >
              <RefreshCw className="w-3.5 h-3.5" /> قراءة الجلسة الحالية
            </button>
            <span className="text-[11px] text-slate-400 font-mono">
              {sessionEmail ? `signed-in: ${sessionEmail}` : 'signed-out'}
            </span>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4 space-y-3">
          <h2 className="text-sm font-black text-slate-200">2) المستند</h2>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleLoad}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-100 text-xs font-bold flex items-center gap-1 disabled:opacity-40"
            >
              <RefreshCw className="w-3.5 h-3.5" /> تحميل
            </button>
            <button
              onClick={() => handleSave(doc?.version ?? 0)}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-emerald-500 text-slate-950 text-xs font-black flex items-center gap-1 disabled:opacity-40"
            >
              <Save className="w-3.5 h-3.5" /> حفظ بالنسخة {doc?.version ?? 0}
            </button>
            <button
              onClick={() => handleSave(0)}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-rose-500/20 text-rose-200 text-xs font-bold disabled:opacity-40"
            >
              محاولة حفظ بنسخة قديمة (0)
            </button>
            <span className="text-[11px] text-slate-400 font-mono">
              version={doc ? doc.version : '—'} · updatedAt={doc?.updatedAt ?? '—'}
            </span>
          </div>
          <pre
            dir="ltr"
            className="text-[11px] leading-relaxed bg-slate-950 border border-slate-800 rounded-xl p-3 max-h-72 overflow-auto font-mono text-slate-300"
          >
            {doc ? JSON.stringify(doc.payload, null, 2) : 'لا مستند محمّل بعد.'}
          </pre>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4 space-y-3">
          <h2 className="text-sm font-black text-slate-200">3) الشريحة الأولى: المستودعات (بيانات رئيسية)</h2>
          <p className="text-[11px] text-slate-400">
            جدول <span className="font-mono">erp_warehouses</span> + دالة CAS ذرية. الشاشات المحلية لم تُمسّ، ولا يُقرأ أو يُرفع أي مستودع من localStorage.
          </p>
          {whBanner && (
            <div
              className={`rounded-xl px-3 py-2 text-[11px] font-bold border ${
                whBanner.tone === 'ok'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                  : whBanner.tone === 'error'
                    ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                    : 'border-slate-700 bg-slate-950 text-slate-300'
              }`}
            >
              {whBanner.text}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleWhLoad}
              disabled={whBusy}
              className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-100 text-xs font-bold disabled:opacity-40"
            >
              تحميل المستودعات السحابية
            </button>
            <button
              onClick={handleWhCreate}
              disabled={whBusy}
              className="px-3 py-1.5 rounded-lg bg-emerald-500 text-slate-950 text-xs font-black disabled:opacity-40"
            >
              إنشاء مستودع تجريبي
            </button>
            <span className="text-[11px] text-slate-400 font-mono">count={warehouses.length}</span>
          </div>
          {warehouses.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-[11px]" dir="ltr">
                <thead className="bg-slate-950 text-slate-400">
                  <tr>
                    <th className="p-2 text-left">code</th>
                    <th className="p-2 text-left">nameAr</th>
                    <th className="p-2 text-left">type</th>
                    <th className="p-2 text-left">location</th>
                    <th className="p-2 text-left">v</th>
                    <th className="p-2 text-left">actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 font-mono text-slate-300">
                  {warehouses.map(wh => (
                    <tr key={wh.id}>
                      <td className="p-2">{wh.code}</td>
                      <td className="p-2">{wh.nameAr}</td>
                      <td className="p-2">{wh.type}</td>
                      <td className="p-2">{wh.location}</td>
                      <td className="p-2">{wh.version}</td>
                      <td className="p-2 space-x-1">
                        <button
                          onClick={() => handleWhRename(wh)}
                          disabled={whBusy}
                          className="px-2 py-0.5 rounded bg-slate-800 text-slate-100 disabled:opacity-40"
                        >
                          update
                        </button>
                        <button
                          onClick={() => handleWhStale(wh)}
                          disabled={whBusy || wh.version < 1}
                          className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-200 disabled:opacity-40"
                        >
                          stale
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] font-bold text-amber-200">
          المرحلة الحالية للقراءة فقط: أزرار الكتابة السحابية هنا معطّلة، وأي محاولة كتابة تُظهر رسالة رفض صريحة.
        </div>

        <p className="text-[11px] text-slate-500">
          ملاحظة: هذه اللوحة لا تستدعي أي خدمة ERP محلية ولا تكتب في localStorage ولا ترفع abdullah_erp_db_v1.
          للعودة إلى التطبيق المحلي أزل <span className="font-mono">?poc=1</span> من العنوان.
        </p>
      </div>
    </div>
  );
};
