// Session gate for the standalone cloud screens (?cloud=1&screen=...).
//
// Those routes render a single cloud panel without the local app shell, so
// nothing signed the user in and every RPC answered "not authenticated" —
// which made the write screens impossible to use outside `VITE_DATA_MODE=cloud`.
// This gate signs in with Supabase Auth (TEST project only) and renders the
// panel afterwards.
//
// It never touches localStorage: the session lives in memory inside
// supabaseTestClient (persistSession: false), so closing the tab signs out.

import React, { useEffect, useState } from 'react';
import { KeyRound, Loader2, LogOut, ShieldCheck, XCircle } from 'lucide-react';
import {
  signInSupabaseTest,
  signOutSupabaseTest,
  supabaseTestClient,
  supabaseTestConfigured,
} from '../../../services/supabaseTestClient';

type Phase = 'checking' | 'signed-out' | 'signed-in';

export const CloudSessionGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [phase, setPhase] = useState<Phase>('checking');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const readSession = async () => {
    const client = supabaseTestClient();
    if (!client) {
      setPhase('signed-out');
      return;
    }
    const { data } = await client.auth.getSession();
    if (!data.session) {
      setPhase('signed-out');
      return;
    }
    const { data: roleData } = await client.rpc('current_erp_role');
    setSessionEmail(data.session.user.email ?? null);
    setRole(typeof roleData === 'string' ? roleData : null);
    setPhase('signed-in');
  };

  useEffect(() => {
    void readSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFailure(null);
    const res = await signInSupabaseTest(email.trim(), password);
    setBusy(false);
    if (!res.ok) {
      setFailure(res.message);
      return;
    }
    setPassword('');
    await readSession();
  };

  const signOut = async () => {
    await signOutSupabaseTest();
    setPhase('signed-out');
    setSessionEmail(null);
    setRole(null);
  };

  if (!supabaseTestConfigured()) {
    return (
      <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4">
        <p className="text-xs font-black text-rose-800 flex items-center gap-2">
          <XCircle className="w-4 h-4" /> لم تُضبط VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
        </p>
        <p className="text-[11px] text-rose-700 mt-1">
          الشاشات السحابية تحتاج مفاتيح مشروع TEST في بيئة التطوير. لا يُستخدم أي بديل محلي.
        </p>
      </div>
    );
  }

  if (phase === 'checking') {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-6 flex items-center gap-2 text-xs text-slate-600">
        <Loader2 className="w-4 h-4 animate-spin" /> جارٍ التحقق من الجلسة السحابية…
      </div>
    );
  }

  if (phase === 'signed-out') {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden max-w-md mx-auto">
        <div className="p-4 border-b border-slate-200 bg-slate-50">
          <h2 className="text-sm font-black text-slate-900 flex items-center gap-2">
            <KeyRound className="w-4 h-4" /> دخول سحابي (TEST)
          </h2>
          <p className="text-[11px] text-slate-500 mt-1">
            الشاشة السحابية تقرأ وتكتب على Supabase TEST فقط — وليس على التخزين المحلي.
          </p>
        </div>
        <form onSubmit={submit} className="p-4 space-y-3">
          <label className="space-y-1 block">
            <span className="text-[11px] font-bold text-slate-600">البريد</span>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs"
              autoComplete="username"
              required
            />
          </label>
          <label className="space-y-1 block">
            <span className="text-[11px] font-bold text-slate-600">كلمة المرور</span>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs"
              autoComplete="current-password"
              required
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 text-white text-[11px] font-black disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            تسجيل الدخول
          </button>
          {failure && (
            <p className="text-[11px] bg-rose-50 border border-rose-200 text-rose-800 rounded-lg p-2">{failure}</p>
          )}
          <p className="text-[10px] text-slate-400">
            الجلسة في الذاكرة فقط ولا تُحفظ في localStorage؛ إغلاق التبويب يُنهيها.
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2">
        <p className="text-[11px] text-slate-600">
          الجلسة: <b>{sessionEmail}</b>
          {role ? <> · الدور <b>{role}</b></> : null}
        </p>
        <button
          onClick={() => void signOut()}
          className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-100 text-slate-700 text-[11px] font-bold"
        >
          <LogOut className="w-3.5 h-3.5" /> خروج
        </button>
      </div>
      {children}
    </div>
  );
};
