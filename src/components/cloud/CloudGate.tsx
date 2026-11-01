// Start-up gate for the cloud build (VITE_ERP_STORAGE=supabase).
//
//   not configured -> explains what is missing
//   sign in        -> Supabase email + password (accounts you created; approved in erp_members)
//   connecting     -> loads the company's records from the cloud
//   first-time     -> the cloud store is empty: import this browser's old data, a backup file,
//                     or start with the default master data. Done once for the whole company.
//   ready          -> the normal ERP (App) runs on top, with a save indicator
//
// The ERP itself (screens, accounting logic, its own user login) is untouched.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  createEmptyDatabase,
  ERPDatabaseSchema,
  normalizeStoredDatabase,
  readLegacyLocalDatabase,
} from '../../services/db';
import { RemoteRejectedError } from '../../services/cloud/remoteStore';
import { getCloudRuntime } from './cloudRuntime';
import { SyncBadge } from './SyncBadge';

type Phase = 'config' | 'signin' | 'connecting' | 'setup' | 'importing' | 'ready' | 'fatal';

const card = 'w-full max-w-md bg-white rounded-2xl border border-cream-300 shadow-lg p-6 space-y-4 text-right';
const input =
  'w-full rounded-lg border border-cream-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-400';
const primary =
  'w-full py-2.5 rounded-lg bg-brand-500 text-white font-bold text-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
const secondary = 'w-full py-2.5 rounded-lg border border-cream-300 font-bold text-sm cursor-pointer hover:bg-cream-100';

const Shell: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="min-h-screen bg-cream-100 flex items-center justify-center p-4 font-sans text-ink-900" dir="rtl">
    <div className={card}>
      <div className="text-center space-y-1">
        <h1 className="text-2xl font-black">
          SnakDip <span className="text-brand-600">ERP</span>
        </h1>
        <p className="text-sm font-bold text-cream-800">{title}</p>
      </div>
      {children}
    </div>
  </div>
);

interface SignInProps {
  onSignedIn: () => void;
  defaultEmail?: string;
}

const SignInForm: React.FC<SignInProps> = ({ onSignedIn, defaultEmail }) => {
  const rt = getCloudRuntime()!;
  const [email, setEmail] = useState(defaultEmail || '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await rt.auth.signIn(email, password);
      onSignedIn();
    } catch (err) {
      setError((err as Error).message || 'تعذّر تسجيل الدخول');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <input className={input} type="email" autoComplete="username" placeholder="البريد الإلكتروني" value={email} onChange={e => setEmail(e.target.value)} dir="ltr" required />
      <input className={input} type="password" autoComplete="current-password" placeholder="كلمة المرور" value={password} onChange={e => setPassword(e.target.value)} dir="ltr" required />
      {error && <p className="text-sm text-red-700 font-bold">{error}</p>}
      <button className={primary} disabled={busy} type="submit">
        {busy ? 'جاري الدخول…' : 'دخول'}
      </button>
    </form>
  );
};

interface Source {
  label: string;
  db: ERPDatabaseSchema;
}

const summarize = (db: ERPDatabaseSchema) =>
  [
    `${db.items.length} صنف`,
    `${db.customers.length} عميل`,
    `${db.suppliers.length} مورد`,
    `${db.salesInvoices.length} فاتورة بيع`,
    `${db.purchaseInvoices.length} فاتورة شراء`,
    `${db.journalEntries.length} قيد يومية`,
  ].join(' · ');

interface SetupProps {
  onImport: (s: Source) => void;
  error: string;
}

const FirstTimeSetup: React.FC<SetupProps> = ({ onImport, error }) => {
  const [local] = useState<ERPDatabaseSchema | null>(() => readLegacyLocalDatabase());
  const [fileError, setFileError] = useState('');

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileError('');
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(String(ev.target?.result));
        if (!(parsed && parsed.company && parsed.accounts && parsed.items)) {
          setFileError('ملف النسخة الاحتياطية غير صالح');
          return;
        }
        onImport({ label: `ملف النسخة الاحتياطية (${file.name})`, db: normalizeStoredDatabase(parsed) });
      } catch {
        setFileError('حدث خطأ في قراءة ملف النسخة الاحتياطية');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <Shell title="الإعداد لأول مرة">
      <p className="text-sm leading-6">
        قاعدة البيانات السحابية فارغة. اختر مصدر البيانات الذي سيُرفع <b>مرة واحدة</b> ليصبح النسخة الأساسية لكل الأجهزة.
        يُفضّل أخذ نسخة احتياطية من النسخة القديمة قبل البدء.
      </p>

      {local && (
        <div className="rounded-xl border border-cream-300 p-3 space-y-2">
          <p className="text-sm font-bold">بيانات هذا المتصفح (النسخة القديمة)</p>
          <p className="text-xs text-cream-800 leading-5">{summarize(local)}</p>
          <button className={primary} onClick={() => onImport({ label: 'بيانات هذا المتصفح', db: local })}>
            رفع بيانات هذا المتصفح للسحابة
          </button>
        </div>
      )}

      <div className="rounded-xl border border-cream-300 p-3 space-y-2">
        <p className="text-sm font-bold">ملف نسخة احتياطية (.json)</p>
        <p className="text-xs text-cream-800">من الإعدادات في النسخة القديمة: تصدير نسخة احتياطية.</p>
        <input type="file" accept=".json,application/json" onChange={onFile} className="text-xs" />
        {fileError && <p className="text-xs text-red-700 font-bold">{fileError}</p>}
      </div>

      <div className="rounded-xl border border-cream-300 p-3 space-y-2">
        <p className="text-sm font-bold">البدء ببيانات أساسية جديدة</p>
        <p className="text-xs text-cream-800">دليل الحسابات والأصناف والمخازن الافتراضية فقط، بدون أي حركات.</p>
        <button className={secondary} onClick={() => onImport({ label: 'البيانات الأساسية الافتراضية', db: createEmptyDatabase() })}>
          بدء نظام جديد
        </button>
      </div>

      {error && <p className="text-sm text-red-700 font-bold">{error}</p>}
    </Shell>
  );
};

export const CloudGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const rt = getCloudRuntime();
  const [phase, setPhase] = useState<Phase>(rt ? (rt.auth.getSession() ? 'connecting' : 'signin') : 'config');
  const [message, setMessage] = useState('');
  const [setupError, setSetupError] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [relogin, setRelogin] = useState(false);
  const started = useRef(false);

  const finish = useCallback(() => {
    if (!rt) return;
    rt.sync.startPolling();
    setPhase('ready');
  }, [rt]);

  const connect = useCallback(async () => {
    if (!rt) return;
    setPhase('connecting');
    setMessage('');
    try {
      const { empty } = await rt.sync.connect();
      if (empty) setPhase('setup');
      else finish();
    } catch (e) {
      if (e instanceof RemoteRejectedError && e.code === 'auth') {
        setPhase('signin');
        return;
      }
      setMessage((e as Error).message || 'تعذّر الاتصال بالخادم');
      setPhase('fatal');
    }
  }, [rt, finish]);

  useEffect(() => {
    if (!rt || started.current) return;
    started.current = true;
    if (rt.auth.getSession()) void connect();
  }, [rt, connect]);

  // come back to the tab -> catch up immediately; connection returns -> save what is waiting
  useEffect(() => {
    if (!rt || phase !== 'ready') return;
    const onVisible = () => {
      if (!document.hidden) void rt.sync.pollOnce();
    };
    const onOnline = () => void rt.sync.flushNow();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [rt, phase]);

  const doImport = async (source: Source) => {
    if (!rt) return;
    const ok = window.confirm(
      `سيتم رفع «${source.label}» إلى قاعدة البيانات السحابية ليصبح النسخة الأساسية لكل الأجهزة.\n\n${summarize(source.db)}\n\nهل تريد المتابعة؟`,
    );
    if (!ok) return;
    setSetupError('');
    setProgress({ done: 0, total: 0 });
    setPhase('importing');
    try {
      await rt.sync.importAll(source.db as unknown as Record<string, any>, (done, total) => setProgress({ done, total }));
      const { empty } = await rt.sync.connect();
      if (empty) throw new Error('لم تُحفظ أي بيانات على الخادم');
      finish();
    } catch (e) {
      setSetupError((e as Error).message || 'فشل رفع البيانات');
      setPhase('setup');
    }
  };

  const signOut = async () => {
    if (rt) {
      rt.sync.stop();
      await rt.auth.signOut();
    }
    window.location.reload();
  };

  if (!rt || phase === 'config') {
    return (
      <Shell title="النسخة السحابية غير مضبوطة">
        <p className="text-sm leading-6">
          لم يتم تحديد بيانات الاتصال بـ Supabase. أضف المتغيرين <code dir="ltr">VITE_SUPABASE_URL</code> و{' '}
          <code dir="ltr">VITE_SUPABASE_ANON_KEY</code> ثم أعد بناء التطبيق. الخطوات في ملف{' '}
          <code dir="ltr">docs/CLOUD_SETUP_AR.md</code>.
        </p>
      </Shell>
    );
  }

  if (phase === 'signin') {
    return (
      <Shell title="تسجيل الدخول إلى النظام السحابي">
        <SignInForm onSignedIn={() => void connect()} />
      </Shell>
    );
  }

  if (phase === 'connecting') {
    return (
      <Shell title="جاري تحميل بيانات الشركة…">
        <p className="text-sm text-center text-cream-800">لحظات من فضلك</p>
      </Shell>
    );
  }

  if (phase === 'importing') {
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <Shell title="جاري رفع البيانات للسحابة…">
        <div className="h-3 rounded-full bg-cream-200 overflow-hidden">
          <div className="h-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-center text-cream-800">
          {progress.done} / {progress.total} — لا تغلق الصفحة
        </p>
      </Shell>
    );
  }

  if (phase === 'setup') {
    return <FirstTimeSetup onImport={source => void doImport(source)} error={setupError} />;
  }

  if (phase === 'fatal') {
    return (
      <Shell title="تعذّر فتح النظام السحابي">
        <p className="text-sm leading-6 text-red-800 font-bold">{message}</p>
        <button className={primary} onClick={() => void connect()}>
          إعادة المحاولة
        </button>
        <button className={secondary} onClick={() => void signOut()}>
          تسجيل الخروج
        </button>
      </Shell>
    );
  }

  return (
    <>
      {children}
      <SyncBadge sync={rt.sync} email={rt.auth.getSession()?.email} onSignOut={() => void signOut()} onRelogin={() => setRelogin(true)} />
      {relogin && (
        <div className="fixed inset-0 z-[110] bg-black/40 flex items-center justify-center p-4">
          <div className={card} dir="rtl">
            <p className="text-sm font-bold text-center">انتهت جلسة الدخول — سجّل الدخول لحفظ تغييراتك</p>
            <SignInForm
              defaultEmail={rt.auth.getSession()?.email}
              onSignedIn={() => {
                setRelogin(false);
                rt.sync.dismissNotice();
                void rt.sync.flushNow();
              }}
            />
          </div>
        </div>
      )}
    </>
  );
};
