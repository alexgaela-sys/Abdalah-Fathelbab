// The complete cloud ERP shell (Supabase TEST only).
//
// Before this file the cloud system was a set of isolated screens reached with
// ?cloud=1&screen=… and every navigation was a full page load — which, with an
// in-memory session (persistSession: false), forced a new sign-in for every
// screen. This shell is the single surface for a real working session:
//
//   * one sign-in, then every module switches inside the same page (no reload,
//     so the session survives; nothing is written to localStorage),
//   * a pre-login health check that tells a rotated/placeholder anon key apart
//     from a wrong password, naming the env key to fix (never printing it),
//   * every panel below is the existing cloud panel for that module, so the
//     reads/writes and their server-side gates stay exactly as implemented,
//   * an explicit link back to the untouched local ERP (?local=1); this shell
//     never imports db.ts and never reads or writes localStorage.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Building2,
  CheckCircle2,
  Cloud,
  Factory,
  FileText,
  Landmark,
  LayoutDashboard,
  Loader2,
  LogOut,
  Package,
  RefreshCw,
  ShieldCheck,
  Users,
  XCircle,
} from 'lucide-react';

import {
  checkSupabaseTestHealth,
  signInSupabaseTest,
  signOutSupabaseTest,
  supabaseTestClient,
  supabaseTestProjectRef,
  supabaseTestUserEmail,
  type SupabaseTestHealth,
} from '../../../services/supabaseTestClient';
import { loadProfitAndLoss, loadTrialBalance, monthRange } from '../../../services/cloudReports';
import { listCloudProductionOrders, type CloudProductionOrder } from '../../../services/cloudManufacturing';

import { CloudItemsPanel } from './CloudItemsPanel';
import { CloudMasterReadPanel } from './CloudMasterReadPanel';
import { CloudSalesReadPanel } from './CloudSalesReadPanel';
import { CloudPurchasingPanel } from './CloudPurchasingPanel';
import { CloudInventoryPanel } from './CloudInventoryPanel';
import { CloudProductionPanel, CloudCustodyPanel, CloudPaymentsPanel } from './CloudOperationsPanels';
import { CloudQualityPanel } from './CloudQualityPanel';
import { CloudCostingPanel } from './CloudCostingPanel';
import { CloudLedgerPanel } from './CloudLedgerPanel';
import { CloudReportsPanel } from './CloudReportsPanel';
import { CloudBanksPanel, CloudChequesPanel, CloudExpensesPanel, CloudExportPanel } from './CloudFinanceReadPanels';
import { CloudUsersPanel } from './CloudUsersPanel';
import { CloudAuditPanel } from './CloudAuditPanel';
import { CloudSettingsPanel } from './CloudSettingsPanel';

type ScreenKey =
  | 'dashboard'
  | 'sales'
  | 'purchasing'
  | 'inventory'
  | 'manufacturing'
  | 'quality'
  | 'costing'
  | 'accounting'
  | 'treasury'
  | 'banks'
  | 'cheques'
  | 'expenses'
  | 'representatives'
  | 'export'
  | 'reports'
  | 'items'
  | 'customers'
  | 'suppliers'
  | 'warehouses'
  | 'units'
  | 'users'
  | 'audit'
  | 'settings';

type Group =
  | 'الرئيسية'
  | 'الدورة التشغيلية'
  | 'المالية والخزينة'
  | 'البيانات الأساسية'
  | 'التقارير والنظام';

const GROUP_ORDER: Group[] = [
  'الرئيسية',
  'الدورة التشغيلية',
  'المالية والخزينة',
  'البيانات الأساسية',
  'التقارير والنظام',
];

const SCREENS: Record<ScreenKey, { labelAr: string; group: Group; hintAr: string }> = {
  dashboard: { labelAr: 'لوحة المتابعة', group: 'الرئيسية', hintAr: 'مؤشرات الشهر من الخادم' },
  sales: { labelAr: 'المبيعات', group: 'الدورة التشغيلية', hintAr: 'الفواتير + إصدار فاتورة' },
  purchasing: { labelAr: 'المشتريات', group: 'الدورة التشغيلية', hintAr: 'فواتير ومرتجعات الموردين' },
  inventory: { labelAr: 'المخزون', group: 'الدورة التشغيلية', hintAr: 'حركات ودفعات وأرصدة + تحويل' },
  manufacturing: { labelAr: 'الإنتاج', group: 'الدورة التشغيلية', hintAr: 'أوامر + BOM + صرف + إقفال' },
  quality: { labelAr: 'الجودة', group: 'الدورة التشغيلية', hintAr: 'فحص واستلام' },
  costing: { labelAr: 'التكاليف', group: 'الدورة التشغيلية', hintAr: 'معدلات التكلفة المعيارية' },
  accounting: { labelAr: 'المحاسبة', group: 'المالية والخزينة', hintAr: 'الدفتر والقيد اليدوي' },
  treasury: { labelAr: 'الخزينة والمدفوعات', group: 'المالية والخزينة', hintAr: 'سندات القبض والصرف' },
  banks: { labelAr: 'البنوك', group: 'المالية والخزينة', hintAr: 'الحسابات والحركات البنكية' },
  cheques: { labelAr: 'الشيكات', group: 'المالية والخزينة', hintAr: 'تحت التحصيل والمحتجز' },
  expenses: { labelAr: 'المصروفات', group: 'المالية والخزينة', hintAr: 'المصروفات والضريبة' },
  representatives: { labelAr: 'العهد والمناديب', group: 'المالية والخزينة', hintAr: 'أرصدة العهد وحركاتها' },
  export: { labelAr: 'التصدير', group: 'المالية والخزينة', hintAr: 'شحنات التصدير' },
  reports: { labelAr: 'التقارير', group: 'التقارير والنظام', hintAr: 'أرباح وخسائر + ميزان + حركة مخزون' },
  items: { labelAr: 'الأصناف', group: 'البيانات الأساسية', hintAr: 'دليل الأصناف والأسعار' },
  customers: { labelAr: 'العملاء', group: 'البيانات الأساسية', hintAr: 'العملاء والأرصدة' },
  suppliers: { labelAr: 'الموردون', group: 'البيانات الأساسية', hintAr: 'الموردون والأرصدة' },
  warehouses: { labelAr: 'المستودعات', group: 'البيانات الأساسية', hintAr: 'المستودعات' },
  units: { labelAr: 'الوحدات', group: 'البيانات الأساسية', hintAr: 'وحدات القياس والتحويل' },
  users: { labelAr: 'المستخدمون والصلاحيات', group: 'التقارير والنظام', hintAr: 'الأدوار والتفعيل' },
  audit: { labelAr: 'سجل العمليات', group: 'التقارير والنظام', hintAr: 'كل عملية مُدقَّقة' },
  settings: { labelAr: 'الإعدادات', group: 'التقارير والنظام', hintAr: 'هوية الشركة وإعدادات النظام' },
};

const SCREEN_ICONS: Partial<Record<ScreenKey, React.ComponentType<{ className?: string }>>> = {
  dashboard: LayoutDashboard,
  manufacturing: Factory,
  inventory: Package,
  reports: BarChart3,
  accounting: FileText,
  treasury: Landmark,
  users: Users,
  settings: Building2,
};

const fmt = (n: number): string =>
  n.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const num = (n: number): string => n.toLocaleString('ar-EG', { maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// Dashboard — every figure comes from a server aggregate, nothing is computed
// from local data and nothing is recomputed on the client except display sums.
// ---------------------------------------------------------------------------
function CloudDashboard({ onOpen }: { onOpen: (s: ScreenKey) => void }) {
  const { from, to } = useMemo(() => monthRange(), []);
  const [pl, setPl] = useState<Awaited<ReturnType<typeof loadProfitAndLoss>> | null>(null);
  const [tb, setTb] = useState<Awaited<ReturnType<typeof loadTrialBalance>> | null>(null);
  const [orders, setOrders] = useState<CloudProductionOrder[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const [p, t, o] = await Promise.all([
      loadProfitAndLoss(from, to),
      loadTrialBalance(from, to),
      listCloudProductionOrders(null, null, null),
    ]);
    setPl(p);
    setTb(t);
    setOrders(o.ok ? o.data : []);
    setBusy(false);
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const subtotal = (section: string): number | null => {
    if (!pl || !pl.ok) return null;
    const line = pl.data.find(l => l.lineType === 'subtotal' && l.section === section);
    return line ? line.amount : null;
  };

  const tbTotals = useMemo(() => {
    if (!tb || !tb.ok) return null;
    let debit = 0;
    let credit = 0;
    for (const line of tb.data) {
      debit += line.debit;
      credit += line.credit;
    }
    return { debit, credit, balanced: Math.abs(debit - credit) < 0.01 };
  }, [tb]);

  const ordersByStatus = useMemo(() => {
    const out: Record<string, number> = {};
    for (const o of orders ?? []) out[o.status] = (out[o.status] ?? 0) + 1;
    return out;
  }, [orders]);

  const revenue = subtotal('revenue_total');
  const gross = subtotal('gross_profit');
  const net = subtotal('net_profit');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-xl font-black text-slate-900">لوحة متابعة الشهر</h2>
          <p className="text-xs text-slate-500 mt-1">
            الفترة {from} ← {to} · كل الأرقام مُجمَّعة على الخادم من القيود المرحَّلة فقط.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-bold disabled:opacity-40"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          تحديث
        </button>
      </div>

      {pl && !pl.ok && (
        <p className="text-[11px] rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">
          تعذّر تحميل قائمة الأرباح والخسائر: {pl.messageAr}
        </p>
      )}
      {tb && !tb.ok && (
        <p className="text-[11px] rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">
          تعذّر تحميل ميزان المراجعة: {tb.messageAr}
        </p>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { labelAr: 'الإيرادات', value: revenue, tone: 'text-sky-700' },
          { labelAr: 'مجمل الربح', value: gross, tone: 'text-emerald-700' },
          { labelAr: 'صافي الربح', value: net, tone: 'text-indigo-700' },
          {
            labelAr: 'توازن الميزان',
            value: tbTotals ? (tbTotals.balanced ? 1 : 0) : null,
            tone: tbTotals?.balanced ? 'text-emerald-700' : 'text-rose-700',
            text: tbTotals ? (tbTotals.balanced ? 'متوازن' : 'غير متوازن') : '—',
          },
        ].map(card => (
          <div key={card.labelAr} className="rounded-2xl border border-slate-200 bg-white p-3">
            <p className="text-[10px] font-bold text-slate-500">{card.labelAr}</p>
            <p className={`text-lg font-black mt-1 ${card.tone}`}>
              {card.text ?? (card.value === null ? '—' : fmt(card.value))}
            </p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="text-[11px] font-black text-slate-700">أوامر الإنتاج بالأرصدة</p>
          {orders === null ? (
            <p className="text-[11px] text-slate-400 mt-2">جارٍ التحميل…</p>
          ) : orders.length === 0 ? (
            <p className="text-[11px] text-slate-400 mt-2">لا أوامر إنتاج على الخادم بعد.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-[11px] text-slate-600">
              {Object.entries(ordersByStatus).map(([status, count]) => (
                <li key={status} className="flex items-center justify-between">
                  <span>{status}</span>
                  <b className="font-mono">{num(count)}</b>
                </li>
              ))}
              <li className="flex items-center justify-between border-t border-slate-100 pt-1">
                <span>الإجمالي</span>
                <b className="font-mono">{num(orders.length)}</b>
              </li>
            </ul>
          )}
          <button
            onClick={() => onOpen('manufacturing')}
            className="mt-3 text-[11px] font-bold text-sky-700 hover:underline"
          >
            فتح دورة الإنتاج →
          </button>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="text-[11px] font-black text-slate-700">ميزان المراجعة (الإجماليات)</p>
          {!tbTotals ? (
            <p className="text-[11px] text-slate-400 mt-2">جارٍ التحميل…</p>
          ) : (
            <ul className="mt-2 space-y-1 text-[11px] text-slate-600">
              <li className="flex items-center justify-between">
                <span>إجمالي المدين</span>
                <b className="font-mono">{fmt(tbTotals.debit)}</b>
              </li>
              <li className="flex items-center justify-between">
                <span>إجمالي الدائن</span>
                <b className="font-mono">{fmt(tbTotals.credit)}</b>
              </li>
              <li className="flex items-center justify-between border-t border-slate-100 pt-1">
                <span>الفرق</span>
                <b className={`font-mono ${tbTotals.balanced ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {fmt(Math.abs(tbTotals.debit - tbTotals.credit))}
                </b>
              </li>
            </ul>
          )}
          <button
            onClick={() => onOpen('accounting')}
            className="mt-3 text-[11px] font-bold text-sky-700 hover:underline"
          >
            فتح المحاسبة →
          </button>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="text-[11px] font-black text-slate-700">البدء السريع</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(['sales', 'inventory', 'purchasing', 'reports', 'audit'] as ScreenKey[]).map(key => (
              <button
                key={key}
                onClick={() => onOpen(key)}
                className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-[11px] font-bold text-slate-700"
              >
                {SCREENS[key].labelAr}
              </button>
            ))}
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-slate-500">
            كل شاشة تقرأ وتكتب عبر دوال الخادم في Supabase TEST؛ لا يوجد أي مسار بديل إلى التخزين المحلي.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen switch
// ---------------------------------------------------------------------------
function ScreenBody({ screen, onOpen }: { screen: ScreenKey; onOpen: (s: ScreenKey) => void }) {
  switch (screen) {
    case 'dashboard':
      return <CloudDashboard onOpen={onOpen} />;
    case 'sales':
      return <CloudSalesReadPanel />;
    case 'purchasing':
      return <CloudPurchasingPanel />;
    case 'inventory':
      return <CloudInventoryPanel />;
    case 'manufacturing':
      return <CloudProductionPanel />;
    case 'quality':
      return <CloudQualityPanel />;
    case 'costing':
      return <CloudCostingPanel />;
    case 'accounting':
      return <CloudLedgerPanel />;
    case 'treasury':
      return <CloudPaymentsPanel />;
    case 'banks':
      return <CloudBanksPanel />;
    case 'cheques':
      return <CloudChequesPanel />;
    case 'expenses':
      return <CloudExpensesPanel />;
    case 'representatives':
      return <CloudCustodyPanel />;
    case 'export':
      return <CloudExportPanel />;
    case 'reports':
      return <CloudReportsPanel />;
    case 'items':
      return <CloudItemsPanel />;
    case 'customers':
      return <CloudMasterReadPanel entity="customers" title="إدارة العملاء" schemaTable="core.customers" />;
    case 'suppliers':
      return <CloudMasterReadPanel entity="suppliers" title="إدارة الموردين" schemaTable="core.suppliers" />;
    case 'warehouses':
      return <CloudMasterReadPanel entity="warehouses" title="المستودعات" schemaTable="core.warehouses" />;
    case 'units':
      return <CloudMasterReadPanel entity="units" title="الوحدات" schemaTable="core.units" />;
    case 'users':
      return <CloudUsersPanel />;
    case 'audit':
      return <CloudAuditPanel />;
    case 'settings':
      return <CloudSettingsPanel />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Health banner — names the env key, never prints a value
// ---------------------------------------------------------------------------
function HealthBanner({ health, onRetry }: { health: SupabaseTestHealth | null; onRetry: () => void }) {
  if (!health) return null;
  if (health.kind === 'ok') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] font-bold text-emerald-800">
        <CheckCircle2 className="w-4 h-4" />
        الاتصال بمشروع TEST ({health.projectRef || '—'}) سليم ومفتاح المشروع صالح.
      </div>
    );
  }
  const text =
    health.kind === 'not-configured'
      ? 'لم تُضبط VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY — لا يوجد اتصال سحابي.'
      : health.kind === 'invalid-key'
        ? `مفتاح المشروع غير صالح لمشروع ${health.projectRef || 'TEST'} (رفض الخادم: Invalid API key). استبدل VITE_SUPABASE_ANON_KEY من Settings → Environment بمفتاح publishable/anon الصحيح لنفس المشروع، ثم أعد الفحص.`
        : `تعذّر الوصول إلى مشروع ${health.projectRef || 'TEST'}: ${health.message}`;
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2">
      <p className="flex items-start gap-2 text-[11px] font-bold text-amber-900">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <span>{text}</span>
      </p>
      <button
        onClick={onRetry}
        className="mt-1.5 flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-900 text-amber-50 text-[10px] font-black"
      >
        <RefreshCw className="w-3 h-3" /> إعادة فحص الاتصال
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
export function CloudApp({ initialScreen = 'dashboard' }: { initialScreen?: string }) {
  const known = (initialScreen in SCREENS ? initialScreen : 'dashboard') as ScreenKey;
  const [screen, setScreen] = useState<ScreenKey>(known);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [phase, setPhase] = useState<'checking' | 'signed-out' | 'signed-in'>('checking');
  const [health, setHealth] = useState<SupabaseTestHealth | null>(null);
  const [email, setEmail] = useState(supabaseTestUserEmail());
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const projectRef = supabaseTestProjectRef();

  const refreshHealth = useCallback(async () => {
    setHealth(null);
    const h = await checkSupabaseTestHealth();
    setHealth(h);
    return h;
  }, []);

  const readSession = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    void (async () => {
      await refreshHealth();
      await readSession();
    })();
  }, [readSession, refreshHealth]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFailure(null);
    const res = await signInSupabaseTest(email.trim(), password);
    setBusy(false);
    if (!res.ok) {
      setFailure(res.message);
      // A refused key fails before the password is even checked — re-check so the
      // banner states the real cause instead of leaving a "wrong password" feel.
      if (/invalid api key/i.test(res.message)) await refreshHealth();
      return;
    }
    setPassword('');
    await readSession();
  };

  const signOut = async () => {
    await signOutSupabaseTest();
    setSessionEmail(null);
    setRole(null);
    setPhase('signed-out');
    setScreen('dashboard');
  };

  const groups = useMemo(
    () =>
      GROUP_ORDER.map(group => ({
        group,
        items: (Object.keys(SCREENS) as ScreenKey[]).filter(k => SCREENS[k].group === group),
      })),
    [],
  );

  // ---------------------------------------------------------------- signed out
  if (phase !== 'signed-in') {
    return (
      <div dir="rtl" className="min-h-screen bg-slate-950 text-slate-100">
        <div className="max-w-6xl mx-auto px-4 py-10 sm:py-16 grid lg:grid-cols-2 gap-8 items-start">
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-sky-500/15 text-sky-400 flex items-center justify-center">
                <Cloud className="w-7 h-7" />
              </div>
              <div>
                <h1 className="text-2xl font-black">SnakDip ERP — النسخة السحابية</h1>
                <p className="text-[11px] text-slate-400 font-mono" dir="ltr">
                  Supabase TEST · {projectRef || 'no project configured'}
                </p>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-slate-300">
              نظام تشغيل كامل على السحابة: المبيعات والمشتريات والمخزون والإنتاج والجودة والتكاليف والمحاسبة
              والتقارير والمستخدمون — بصلاحيات مستخدمين حقيقية، وقيود متوازنة، ومنع تكرار الترحيل.
            </p>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-slate-300">
              {[
                'كل قراءة وكتابة عبر دوال الخادم (RPC) بصلاحيات الدور',
                'صرف خامات FIFO واستلام منتج تام وتكلفة فعلية',
                'قيود محاسبية ذرية + منع ترحيل مزدوج',
                'تقارير مُجمَّعة على الخادم + سجل عمليات',
                'جلسة في الذاكرة فقط — لا تُحفظ محليًا',
              ].map(item => (
                <li key={item} className="flex items-start gap-2 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <a
              href="?local=1"
              className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-400 hover:text-slate-200 underline"
            >
              فتح النسخة المحلية (localStorage) كما هي دون أي تغيير →
            </a>
          </div>

          <div className="w-full max-w-md bg-white text-slate-900 rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
              <h2 className="text-sm font-black flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-slate-700" /> دخول سحابي (TEST)
              </h2>
              <p className="text-[11px] text-slate-500 mt-1">
                استخدم بريدك وكلمة مرور حساب Supabase — الجلسة تبقى في الذاكرة فقط.
              </p>
            </div>
            <div className="p-4 space-y-3">
              <HealthBanner health={health} onRetry={() => void refreshHealth()} />
              {phase === 'checking' ? (
                <p className="flex items-center gap-2 text-[11px] text-slate-500">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> جارٍ التحقق من الجلسة…
                </p>
              ) : (
                <form onSubmit={submit} className="space-y-3">
                  <label className="block space-y-1">
                    <span className="text-[11px] font-bold text-slate-600">البريد</span>
                    <input
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      dir="ltr"
                      className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs font-mono"
                      autoComplete="username"
                      required
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] font-bold text-slate-600">كلمة المرور</span>
                    <input
                      type="password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      dir="ltr"
                      className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs"
                      autoComplete="current-password"
                      required
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg bg-slate-900 text-white text-xs font-black disabled:opacity-40"
                  >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                    دخول إلى النظام السحابي
                  </button>
                  {failure && (
                    <p className="text-[11px] rounded-lg bg-rose-50 border border-rose-200 text-rose-800 px-2 py-1.5">
                      {failure}
                    </p>
                  )}
                </form>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- signed in
  return (
    <div dir="rtl" className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-20 bg-slate-950 text-slate-100 border-b border-slate-800 print:hidden">
        <div className="max-w-[1600px] mx-auto px-3 sm:px-5 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              onClick={() => setNavOpen(v => !v)}
              className="lg:hidden px-2 py-1 rounded-lg bg-slate-800 text-[11px] font-bold"
            >
              القوائم
            </button>
            <div className="w-8 h-8 rounded-xl bg-sky-500/15 text-sky-400 flex items-center justify-center shrink-0">
              <Cloud className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-black truncate">SnakDip ERP — السحابة</p>
              <p className="text-[10px] text-slate-400 font-mono truncate" dir="ltr">
                {projectRef} · {sessionEmail} {role ? `· ${role}` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <a
              href="?local=1"
              className="px-2 py-1 rounded-lg bg-slate-800 text-slate-300 text-[10px] font-bold hover:bg-slate-700"
            >
              النسخة المحلية
            </a>
            <button
              onClick={() => void signOut()}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-rose-500/15 text-rose-300 text-[10px] font-bold hover:bg-rose-500/25"
            >
              <LogOut className="w-3 h-3" /> خروج
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-[1600px] mx-auto px-3 sm:px-5 py-4 flex gap-4">
        <aside
          className={`${navOpen ? 'block' : 'hidden'} lg:block w-full lg:w-60 shrink-0 print:hidden`}
        >
          <nav className="bg-white rounded-2xl border border-slate-200 p-2 space-y-3 lg:sticky lg:top-16">
            {groups.map(({ group, items }) => (
              <div key={group}>
                <p className="px-2 text-[10px] font-black text-slate-400 mb-1">{group}</p>
                <div className="space-y-0.5">
                  {items.map(key => {
                    const Icon = SCREEN_ICONS[key];
                    const active = screen === key;
                    return (
                      <button
                        key={key}
                        onClick={() => {
                          setScreen(key);
                          setNavOpen(false);
                          window.history.replaceState(null, '', `?cloud=1&screen=${key}`);
                          window.scrollTo({ top: 0 });
                        }}
                        title={SCREENS[key].hintAr}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[11px] font-bold text-right transition-colors ${
                          active
                            ? 'bg-slate-900 text-white'
                            : 'text-slate-600 hover:bg-slate-100'
                        }`}
                      >
                        {Icon ? (
                          <Icon className={`w-3.5 h-3.5 shrink-0 ${active ? 'text-sky-300' : 'text-slate-400'}`} />
                        ) : (
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${active ? 'bg-sky-300' : 'bg-slate-300'}`} />
                        )}
                        <span className="truncate">{SCREENS[key].labelAr}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <main className="flex-1 min-w-0 space-y-3">
          <div className="hidden lg:block">
            <HealthBanner health={health} onRetry={() => void refreshHealth()} />
          </div>
          <div className="bg-white rounded-2xl border border-slate-200 p-3 sm:p-4">
            <ScreenBody screen={screen} onOpen={setScreen} />
          </div>
          <p className="text-[10px] text-slate-400 leading-relaxed px-1">
            مساحة تجربة سحابية على Supabase TEST. لا تُقرأ بيانات النسخة المحلية ولا تُكتب، ولا يوجد ترحيل تلقائي
            لأي أرصدة أو حركات تاريخية.
          </p>
        </main>
      </div>
    </div>
  );
}
