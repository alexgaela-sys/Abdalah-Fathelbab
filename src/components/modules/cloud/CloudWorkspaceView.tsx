// Explicit cloud workspace (?cloud=1) — the separated cloud run path.
//
// It loads cloud data BEFORE rendering any table (loading → ready | error), shows
// explicit error/conflict states, and never falls back to the local store:
//   * no erpDb import, no localStorage read/write,
//   * resolveDataMode() stays 'local'; the local app keeps running unchanged,
//   * READ-ONLY in this phase: no cloud create/update/delete is exposed here.
//     The CAS services still exist for the next phase, but this surface only reads.

import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Database,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import {
  MASTER_ENTITIES,
  loadCloudMasterWorkspace,
  type CloudWorkspaceSnapshot,
} from '../../../services/masterDataCloudSlice';
import { listCloudWarehouses, type CloudWarehouse } from '../../../services/cloudWarehouseSlice';
import {
  CORE_ENTITIES,
  loadCoreMasterSnapshot,
  type CoreSnapshot,
} from '../../../services/coreMasterRead';
import {
  currentSupabaseTestUser,
  signInSupabaseTest,
  signOutSupabaseTest,
} from '../../../services/supabaseTestClient';

type Phase = 'signed-out' | 'loading' | 'ready' | 'error';
type Banner = { tone: 'ok' | 'error' | 'info'; text: string } | null;

export const CloudWorkspaceView: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('signed-out');
  const [snapshot, setSnapshot] = useState<CloudWorkspaceSnapshot | null>(null);
  const [warehouses, setWarehouses] = useState<CloudWarehouse[]>([]);
  const [core, setCore] = useState<CoreSnapshot | null>(null);
  const [banner, setBanner] = useState<Banner>({
    tone: 'info',
    text: 'مسار تشغيل سحابي معزول للقراءة فقط (TEST). النسخة المحلية هي الافتراضية ولم يُقرأ منها ولا يُكتب فيها أي شيء.',
  });
  const [busy, setBusy] = useState(false);

  const loadAll = async () => {
    setPhase('loading');
    setSnapshot(null);
    const master = await loadCloudMasterWorkspace();
    if (!master.ok) {
      setPhase('error');
      setBanner({ tone: 'error', text: `${master.messageAr} — لم يُعرَض أي جدول سحابي ولم يُستخدم أي بديل محلي.` });
      return;
    }
    const wh = await listCloudWarehouses();
    if (!wh.ok) {
      setPhase('error');
      setBanner({ tone: 'error', text: `${wh.messageAr} — أُوقف العرض بالكامل بدل عرض بيانات جزئية.` });
      return;
    }
    const coreSnapshot = await loadCoreMasterSnapshot();
    if (!coreSnapshot.ok) {
      setPhase('error');
      setBanner({ tone: 'error', text: `${coreSnapshot.messageAr} — أُوقف العرض بالكامل (لا بيانات جزئية ولا بديل محلي).` });
      return;
    }
    setSnapshot(master.data);
    setWarehouses(wh.data);
    setCore(coreSnapshot.data);
    setPhase('ready');
    setBanner({
      tone: 'ok',
      text: `حُمّلت ${coreSnapshot.data.total} سجلًا من core و${master.data.total} سجلًا من طبقة الاختبار و${wh.data.length} مستودعًا من TEST في ${new Date(master.data.loadedAt).toLocaleTimeString('ar-EG')}.`,
    });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const user = await currentSupabaseTestUser();
      if (!cancelled) setSessionEmail(user);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSignIn = async () => {
    setBusy(true);
    const res = await signInSupabaseTest(email.trim(), password);
    setBusy(false);
    if (!res.ok) {
      setBanner({ tone: 'error', text: res.message });
      return;
    }
    setPassword('');
    setSessionEmail(res.email);
    setPhase('loading');
    await loadAll();
  };

  const handleSignOut = async () => {
    await signOutSupabaseTest();
    setSessionEmail(null);
    setSnapshot(null);
    setWarehouses([]);
    setCore(null);
    setPhase('signed-out');
    setBanner({ tone: 'info', text: 'أُنهيت الجلسة السحابية. النسخة المحلية لم تتأثر.' });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-8" dir="rtl">
      <div className="max-w-6xl mx-auto space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-sky-500/15 text-sky-400 flex items-center justify-center">
              <Cloud className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-lg font-black">مساحة العمل السحابية — Supabase TEST</h1>
              <p className="text-[11px] text-slate-400">
                مسار تشغيل منفصل. الوضع المحلي (localStorage) هو الافتراضي ولا يُقرأ أو يُرفع أو يُدمج مع هذا المسار.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-400">
            <span className={`w-2 h-2 rounded-full ${phase === 'ready' ? 'bg-emerald-400' : phase === 'error' ? 'bg-rose-400' : 'bg-slate-500'}`} />
            <span>phase={phase}</span>
            <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700">
              source={phase === 'ready' ? 'supabase:test' : 'none'}
            </span>
            {sessionEmail && <span>· {sessionEmail}</span>}
          </div>
        </header>

        {banner && (
          <div
            className={`rounded-2xl px-4 py-3 text-xs font-bold flex items-start gap-2 border ${
              banner.tone === 'ok'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                : banner.tone === 'error'
                  ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                  : 'border-slate-700 bg-slate-900 text-slate-300'
            }`}
          >
            {banner.tone === 'ok' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            ) : banner.tone === 'error' ? (
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            ) : (
              <Database className="w-4 h-4 shrink-0 mt-0.5" />
            )}
            <span>{banner.text}</span>
          </div>
        )}

        {!sessionEmail && (
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4 space-y-3">
            <h2 className="text-sm font-black text-slate-200">دخول TEST لإتاحة المسار السحابي</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="QA test email"
                dir="ltr"
                className="p-2 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="QA test password"
                dir="ltr"
                className="p-2 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono"
              />
            </div>
            <button
              onClick={handleSignIn}
              disabled={busy || !email || !password}
              className="px-3 py-1.5 rounded-lg bg-sky-500 text-slate-950 text-xs font-black disabled:opacity-40"
            >
              دخول وتحميل بيانات TEST
            </button>
          </section>
        )}

        {sessionEmail && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={loadAll}
              disabled={busy || phase === 'loading'}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-100 text-xs font-bold disabled:opacity-40"
            >
              <RefreshCw className="w-3.5 h-3.5" /> إعادة التحميل
            </button>
            <button
              onClick={handleSignOut}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-xs font-bold"
            >
              <RotateCcw className="w-3.5 h-3.5" /> خروج
            </button>
            {snapshot && (
              <span className="text-[11px] font-mono text-slate-400">
                masterRows={snapshot.total} · warehouseRows={warehouses.length}
              </span>
            )}
          </div>
        )}

        {phase === 'loading' && sessionEmail && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 space-y-3 animate-pulse">
            <p className="text-xs font-bold text-slate-300">جارٍ تحميل بيانات TEST قبل عرض أي جدول…</p>
            <p className="text-[10px] text-slate-500">
              لا تُعرض أثناء التحميل أي صفوف من التخزين المحلي ولا يُستخدم أي بديل محلي.
            </p>
            {[0, 1, 2].map(i => (
              <div key={i} className="h-3 rounded bg-slate-800" style={{ width: `${90 - i * 20}%` }} />
            ))}
          </div>
        )}

        {phase === 'error' && (
          <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 p-4 space-y-2">
            <p className="text-xs font-bold text-rose-200 flex items-center gap-2">
              <XCircle className="w-4 h-4" /> فشل تحميل المسار السحابي بالكامل — source=none: لا يُعرض أي جدول، ولا تُعرض بيانات
              محلية باعتبارها سحابية، ولا يوجد fallback.
            </p>
            <button
              onClick={loadAll}
              className="px-3 py-1.5 rounded-lg bg-rose-500 text-slate-950 text-xs font-black"
            >
              إعادة المحاولة
            </button>
          </div>
        )}

        {phase === 'ready' && snapshot && (
          <div className="space-y-4">
            <section className="rounded-2xl border border-sky-800 bg-sky-950/40">
              <header className="p-3 border-b border-sky-800">
                <h2 className="text-sm font-black text-sky-100">
                  البيانات الحقيقية من مخطط ERP المُوحَّد <span className="text-[11px] font-mono text-sky-400">(core.* · قراءة فقط)</span>
                </h2>
                <p className="text-[10px] text-sky-200/70">
                  تُقرأ عبر جسر <span className="font-mono">erp_core_master_read</span> المحدود بقائمة السماح — لا تُمنح أي صلاحية مباشرة على جداول core، ولا يوجد أي مسار كتابة من العميل إليها.
                </p>
              </header>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3">
                {CORE_ENTITIES.map(({ key, labelAr, schemaTable }) => {
                  const rows = core?.byEntity[key] ?? [];
                  return (
                    <div key={key} className="rounded-xl border border-sky-800 bg-slate-950/60 p-2">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] font-bold text-sky-100">{labelAr}</span>
                        <span className="text-[10px] font-mono text-sky-400">{schemaTable} · {rows.length}</span>
                      </div>
                      {rows.length === 0 ? (
                        <p className="text-[10px] text-slate-500">لا صفوف.</p>
                      ) : (
                        <table className="w-full text-[10px]" dir="ltr">
                          <tbody className="font-mono text-slate-300">
                            {rows.slice(0, 5).map(r => (
                              <tr key={r.id}>{""}
                                <td className="py-0.5 pr-1">{r.code}</td>
                                <td className="py-0.5 text-slate-400">{r.nameAr}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            <div className="rounded-2xl border border-amber-700/50 bg-amber-500/10 px-4 py-2 text-[11px] font-bold text-amber-200">
              الطبقة التالية هي طبقة اختبار متوازية (‏public.erp_master_records) — <span className="underline">ليست مصدرًا</span> لبيانات ERP
              ولم تعد تُكتب من الواجهة. المصدر المرجعي هو core.* أعلاه، وهذه الجداول مرشحة للتنظيف لاحقًا.
            </div>

            {MASTER_ENTITIES.map(({ key, labelAr }) => {
              const rows = snapshot.byEntity[key] ?? [];
              return (
                <section key={key} className="rounded-2xl border border-slate-800 bg-slate-900">
                  <header className="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-slate-800">
                    <h2 className="text-sm font-black text-slate-200">
                      {labelAr} <span className="text-[11px] font-mono text-slate-500">({key}) · {rows.length}</span>
                    </h2>
                    <span className="px-2 py-1 rounded-lg bg-slate-950 border border-slate-700 text-[10px] font-bold text-slate-400">
                      قراءة فقط
                    </span>
                  </header>
                  {rows.length === 0 ? (
                    <p className="p-3 text-[11px] text-slate-500">لا صفوف سحابية لهذا الكيان.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px]" dir="ltr">
                        <thead className="bg-slate-950 text-slate-400">
                          <tr>
                            <th className="p-2 text-left">id</th>
                            <th className="p-2 text-left">code</th>
                            <th className="p-2 text-left">nameAr</th>
                            <th className="p-2 text-left">v</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800 font-mono text-slate-300">
                          {rows.map(rec => (
                            <tr key={rec.id}>
                              <td className="p-2 max-w-[180px] truncate">{rec.id}</td>
                              <td className="p-2">{rec.code}</td>
                              <td className="p-2">{rec.nameAr}</td>
                              <td className="p-2">{rec.version}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              );
            })}

            <section className="rounded-2xl border border-slate-800 bg-slate-900">
              <header className="p-3 border-b border-slate-800">
                <h2 className="text-sm font-black text-slate-200">
                  المستودعات <span className="text-[11px] font-mono text-slate-500">(erp_warehouses) · {warehouses.length}</span>
                </h2>
                <p className="text-[10px] text-slate-500">
                  للقراءة هنا فقط؛ تعديل المستودعات السحابية يتم من «الإعدادات ← المستودعات ← وضع اختبار سحابي».
                </p>
              </header>
              {warehouses.length === 0 ? (
                <p className="p-3 text-[11px] text-slate-500">لا صفوف سحابية للمستودعات.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]" dir="ltr">
                    <thead className="bg-slate-950 text-slate-400">
                      <tr>
                        <th className="p-2 text-left">code</th>
                        <th className="p-2 text-left">nameAr</th>
                        <th className="p-2 text-left">location</th>
                        <th className="p-2 text-left">v</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 font-mono text-slate-300">
                      {warehouses.map(wh => (
                        <tr key={wh.id}>
                          <td className="p-2">{wh.code}</td>
                          <td className="p-2">{wh.nameAr}</td>
                          <td className="p-2">{wh.location}</td>
                          <td className="p-2">{wh.version}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}

        <p className="text-[11px] text-slate-500">
          لا تُنفَّذ هنا أي معاملة محاسبية أو حركة مخزون؛ هذه الطبقة للبيانات الرئيسية فقط. معاملات الفواتير/القيود/المخزون
          الذرية موجودة كمُخطَّط تصميم غير مُفعَّل بانتظار اختبارات التكافؤ.
        </p>
      </div>
    </div>
  );
};
