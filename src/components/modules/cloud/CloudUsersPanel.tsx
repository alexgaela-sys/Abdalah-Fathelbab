// Cloud users & permissions screen (TEST only).
//
// Reads public.list_app_profiles (core.app_profiles stays CLOSED to clients) and
// writes through the three audited SECURITY DEFINER RPCs from migration 166.
//
// Every control is an affordance, never the boundary: the server re-checks
// core.user_can('users','edit'), refuses self-changes, protects the last active
// Super Admin and audits each accepted change. A refusal is shown verbatim.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Users,
  XCircle,
} from 'lucide-react';
import {
  CLOUD_ROLES,
  cloudCan,
  listCloudProfiles,
  readCloudRole,
  setCloudProfileActive,
  setCloudProfilePermissions,
  setCloudProfileRole,
  type CloudProfile,
} from '../../../services/cloudUsers';
import { currentSupabaseTestUser } from '../../../services/supabaseTestClient';
import {
  ACTION_LABELS_AR,
  ALL_MODULES,
  ASSIGNABLE_ACTIONS,
  MODULE_LABELS_AR,
  type ModuleKey,
} from '../../../services/permissions';

type Banner = { tone: 'ok' | 'error' | 'info'; text: string } | null;

export function CloudUsersPanel() {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<CloudProfile[]>([]);
  const [role, setRole] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // permission editor
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string[]>>({});

  const load = useCallback(async () => {
    setPhase('loading');
    setError(null);
    const [list, roleRes, canRes, email] = await Promise.all([
      listCloudProfiles(),
      readCloudRole(),
      cloudCan('users', 'edit'),
      currentSupabaseTestUser(),
    ]);
    setSessionEmail(email);
    if (!list.ok) {
      setPhase('error');
      setError(list.messageAr);
      return;
    }
    setProfiles(list.data);
    if (roleRes.ok) setRole(roleRes.data);
    if (canRes.ok) setCanEdit(canRes.data);
    else setCanEdit(false);
    setPhase('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const editing = useMemo(
    () => profiles.find(p => p.id === editingId) ?? null,
    [profiles, editingId],
  );

  const openEditor = (profile: CloudProfile) => {
    setEditingId(profile.id);
    setDraft(Object.fromEntries(Object.entries(profile.permissions ?? {}).map(([k, v]) => [k, [...v]])));
    setBanner(null);
  };

  const toggleAction = (module: ModuleKey, action: string) => {
    setDraft(current => {
      const next = { ...current };
      const existing = next[module];
      if (existing === undefined) {
        // first touch creates an override for this module only
        next[module] = [action];
        return next;
      }
      next[module] = existing.includes(action)
        ? existing.filter(a => a !== action)
        : [...existing, action];
      return next;
    });
  };

  const inheritModule = (module: ModuleKey) => {
    setDraft(current => {
      const next = { ...current };
      delete next[module];
      return next;
    });
  };

  const savePermissions = async () => {
    if (!editing) return;
    setBusyId(editing.id);
    const res = await setCloudProfilePermissions(editing.id, draft);
    setBusyId(null);
    if (!res.ok) {
      setBanner({ tone: 'error', text: res.messageAr });
      return;
    }
    setBanner({ tone: 'ok', text: `حُفظت صلاحيات ${editing.name || editing.email || editing.id}.` });
    setEditingId(null);
    await load();
  };

  const changeRole = async (profile: CloudProfile, nextRole: string) => {
    if (nextRole === profile.role) return;
    setBusyId(profile.id);
    const res = await setCloudProfileRole(profile.id, nextRole);
    setBusyId(null);
    if (!res.ok) {
      setBanner({ tone: 'error', text: `${profile.name || profile.id}: ${res.messageAr}` });
      return;
    }
    setBanner({ tone: 'ok', text: `صار دور ${profile.name || profile.id} «${nextRole}».` });
    await load();
  };

  const toggleActive = async (profile: CloudProfile) => {
    setBusyId(profile.id);
    const res = await setCloudProfileActive(profile.id, !profile.active);
    setBusyId(null);
    if (!res.ok) {
      setBanner({ tone: 'error', text: `${profile.name || profile.id}: ${res.messageAr}` });
      return;
    }
    setBanner({
      tone: 'ok',
      text: `${profile.name || profile.id} ${profile.active ? 'مُعطَّل الآن' : 'نشط الآن'}.`,
    });
    await load();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-slate-900 flex items-center gap-2">
            <Users className="w-5 h-5 text-sky-600" /> المستخدمون والصلاحيات
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            المصدر: <span className="font-mono">core.app_profiles</span> عبر دالة الخادم{' '}
            <span className="font-mono">list_app_profiles</span> — الجدول نفسه غير مفتوح للقراءة من العميل.
            هوية الدخول هي Supabase Auth، والدور يحدد الصلاحيات.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-1 rounded-lg bg-slate-100 border border-slate-200 text-[10px] font-bold text-slate-700">
            دورك: {role ?? '—'} · {canEdit ? 'إدارة مفعّلة' : 'قراءة فقط'}
          </span>
          <button
            onClick={() => void load()}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-bold"
          >
            <RefreshCw className="w-3.5 h-3.5" /> تحديث
          </button>
        </div>
      </div>

      {banner && (
        <div
          className={`rounded-2xl px-4 py-2.5 text-[11px] font-bold flex items-start gap-2 border ${
            banner.tone === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : banner.tone === 'error'
                ? 'border-rose-200 bg-rose-50 text-rose-800'
                : 'border-slate-200 bg-slate-50 text-slate-700'
          }`}
        >
          {banner.tone === 'ok' ? (
            <Check className="w-3.5 h-3.5 mt-0.5" />
          ) : banner.tone === 'error' ? (
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5" />
          ) : (
            <ShieldCheck className="w-3.5 h-3.5 mt-0.5" />
          )}
          <span>{banner.text}</span>
        </div>
      )}

      {!canEdit && phase === 'ready' && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[11px] font-bold text-amber-900">
          دورك لا يملك <span className="font-mono">users.edit</span> — العرض للقراءة فقط، وأي محاولة تعديل يرفضها الخادم.
        </div>
      )}

      {phase === 'loading' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 flex items-center gap-2 text-xs text-slate-600">
          <Loader2 className="w-4 h-4 animate-spin" /> جارٍ تحميل دليل المستخدمين من TEST…
        </div>
      )}

      {phase === 'error' && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 space-y-2">
          <p className="text-xs font-black text-rose-800 flex items-center gap-1.5">
            <XCircle className="w-4 h-4" /> تعذّر تحميل المستخدمين — لا تُعرض أي بيانات محلية بديلة.
          </p>
          <p className="text-[11px] text-rose-700">{error}</p>
          <button
            onClick={() => void load()}
            className="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-[11px] font-bold"
          >
            إعادة المحاولة
          </button>
        </div>
      )}

      {phase === 'ready' && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-[11px]">
              <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="p-2.5">المستخدم</th>
                  <th className="p-2.5">البريد</th>
                  <th className="p-2.5">الدور</th>
                  <th className="p-2.5">الحالة</th>
                  <th className="p-2.5">تجاوزات الصلاحيات</th>
                  <th className="p-2.5">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {profiles.map(p => {
                  const isSelf = sessionEmail !== null && p.email.toLowerCase() === sessionEmail.toLowerCase();
                  const disabled = !canEdit || isSelf || busyId === p.id;
                  const overrides = Object.keys(p.permissions ?? {}).length;
                  return (
                    <tr key={p.id} className="hover:bg-slate-50 align-middle">
                      <td className="p-2.5">
                        <div className="font-bold text-slate-800">{p.name || p.username || p.id}</div>
                        <div className="font-mono text-[10px] text-slate-400">
                          {p.id}
                          {p.isTest ? ' · is_test' : ''}
                          {isSelf ? ' · أنت' : ''}
                        </div>
                      </td>
                      <td className="p-2.5 font-mono text-slate-600" dir="ltr">
                        {p.email || '—'}
                      </td>
                      <td className="p-2.5">
                        <select
                          value={p.role}
                          disabled={disabled}
                          onChange={e => void changeRole(p, e.target.value)}
                          className="p-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] disabled:opacity-50"
                        >
                          {CLOUD_ROLES.map(r => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="p-2.5">
                        <span
                          className={`px-2 py-0.5 rounded-lg text-[10px] font-bold ${
                            p.active ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
                          }`}
                        >
                          {p.active ? 'نشط' : 'معطَّل'}
                        </span>
                      </td>
                      <td className="p-2.5 font-mono text-slate-600">
                        {overrides === 0 ? '— (الدور)' : `${overrides} وحدة`}
                      </td>
                      <td className="p-2.5">
                        <div className="flex flex-wrap gap-1">
                          <button
                            onClick={() => openEditor(p)}
                            disabled={disabled}
                            className="px-2 py-1 rounded-lg bg-slate-100 text-slate-700 text-[10px] font-bold disabled:opacity-40"
                          >
                            الصلاحيات
                          </button>
                          <button
                            onClick={() => void toggleActive(p)}
                            disabled={disabled}
                            className={`px-2 py-1 rounded-lg text-[10px] font-bold disabled:opacity-40 ${
                              p.active
                                ? 'bg-rose-50 text-rose-700'
                                : 'bg-emerald-50 text-emerald-700'
                            }`}
                          >
                            {p.active ? 'تعطيل' : 'تفعيل'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-2 text-[10px] text-slate-500 border-t border-slate-100">
            لا يمكن تعديل حسابك بنفسك، ولا خفض/تعطيل آخر Super Admin نشط، وكل تغيير يُسجَّل في{' '}
            <span className="font-mono">audit.app_audit_log</span>.
          </p>
        </div>
      )}

      {editing && canEdit && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-slate-200">
            <div>
              <h3 className="text-sm font-black text-slate-900">
                صلاحيات: {editing.name || editing.email} <span className="text-[11px] font-mono text-slate-400">({editing.role})</span>
              </h3>
              <p className="text-[11px] text-slate-500">
                أي وحدة تُلمس تصبح <b>تجاوزًا</b> يستبدل صف الدور لتلك الوحدة فقط؛ «إرجاع للدور» يحذف التجاوز.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setEditingId(null)}
                className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 text-[11px] font-bold"
              >
                إلغاء
              </button>
              <button
                onClick={() => void savePermissions()}
                disabled={busyId === editing.id}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-bold disabled:opacity-40"
              >
                {busyId === editing.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                حفظ
              </button>
            </div>
          </div>

          {editing.role === 'Super Admin' ? (
            <p className="p-4 text-[11px] text-slate-600">
              Super Admin يملك كل الصلاحيات دائمًا في مصفوفة الأدوار، فلا تُخزَّن له تجاوزات (يرفضها الخادم).
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-[11px]">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                  <tr>
                    <th className="p-2">الوحدة</th>
                    {ASSIGNABLE_ACTIONS.map(a => (
                      <th key={a} className="p-2 text-center">{ACTION_LABELS_AR[a] ?? a}</th>
                    ))}
                    <th className="p-2 text-center">المصدر</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ALL_MODULES.map(m => {
                    const override = draft[m];
                    return (
                      <tr key={m} className={override ? 'bg-sky-50/40' : ''}>
                        <td className="p-2 text-slate-700">{MODULE_LABELS_AR[m] ?? m}</td>
                        {ASSIGNABLE_ACTIONS.map(a => {
                          const checked = (override ?? []).includes(a);
                          return (
                            <td key={a} className="p-2 text-center">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleAction(m, a)}
                                className="accent-slate-900"
                                aria-label={`${MODULE_LABELS_AR[m] ?? m} — ${ACTION_LABELS_AR[a] ?? a}`}
                              />
                            </td>
                          );
                        })}
                        <td className="p-2 text-center">
                          {override ? (
                            <button
                              onClick={() => inheritModule(m)}
                              className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-bold"
                            >
                              إرجاع للدور
                            </button>
                          ) : (
                            <span className="text-[10px] font-mono text-slate-400">الدور</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
