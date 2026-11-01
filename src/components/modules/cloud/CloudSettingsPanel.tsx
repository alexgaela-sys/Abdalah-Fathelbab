// Cloud settings screen (TEST only): company identity + system settings.
//
// Source: public.get_cloud_settings (company row + app_settings row, logo blob
// replaced by a flag). Read-only on purpose: changing the company identity or
// the invoice design is a business decision that needs an approved rule, so no
// write path is exposed here — the screen says so instead of pretending.

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Building2, Loader2, RefreshCw, Settings, XCircle } from 'lucide-react';
import { loadCloudSettings, type CloudSettings } from '../../../services/cloudUsers';

const text = (v: unknown): string =>
  v === null || v === undefined || v === '' ? '—' : String(v);

export function CloudSettingsPanel() {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<CloudSettings | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    setError(null);
    const res = await loadCloudSettings();
    if (!res.ok) {
      setPhase('error');
      setError(res.messageAr);
      return;
    }
    setSnapshot(res.data);
    setPhase('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const company = snapshot?.company ?? {};
  const settings = snapshot?.settings ?? {};
  const template = (settings.invoice_template ?? {}) as Record<string, unknown>;

  const companyRows: Array<{ label: string; value: string }> = [
    { label: 'الاسم العربي', value: text(company.name_ar) },
    { label: 'الاسم الإنجليزي', value: text(company.name_en) },
    { label: 'الكود', value: text(company.code) },
    { label: 'الرقم الضريبي', value: text(company.tax_number) },
    { label: 'السجل التجاري', value: text(company.commercial_register) },
    { label: 'العنوان', value: text(company.address) },
    { label: 'الهاتف', value: text(company.phone) },
    { label: 'البريد', value: text(company.email) },
    { label: 'العملة الأساسية', value: text(company.base_currency) },
    { label: 'عملة التصدير', value: text(company.export_currency) },
    { label: 'سعر صرف الدولار', value: text(company.current_usd_exchange_rate) },
    { label: 'شعار محفوظ', value: company.has_logo ? 'نعم' : 'لا' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-slate-900 flex items-center gap-2">
            <Settings className="w-5 h-5 text-sky-600" /> إعدادات الشركة والنظام
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            المصدر: <span className="font-mono">core.companies</span> و{' '}
            <span className="font-mono">core.app_settings</span> عبر{' '}
            <span className="font-mono">get_cloud_settings</span> — قراءة فقط في هذه المرحلة.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-bold"
        >
          <RefreshCw className="w-3.5 h-3.5" /> تحديث
        </button>
      </div>

      {phase === 'loading' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 flex items-center gap-2 text-xs text-slate-600">
          <Loader2 className="w-4 h-4 animate-spin" /> جارٍ تحميل الإعدادات من TEST…
        </div>
      )}

      {phase === 'error' && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 space-y-2">
          <p className="text-xs font-black text-rose-800 flex items-center gap-1.5">
            <XCircle className="w-4 h-4" /> تعذّر تحميل الإعدادات — لا تُعرض أي قيم محلية بديلة.
          </p>
          <p className="text-[11px] text-rose-700">{error}</p>
        </div>
      )}

      {phase === 'ready' && snapshot && (
        <>
          {Object.keys(company).length === 0 && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[11px] font-bold text-amber-900 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5" />
              لا يوجد سجل شركة في TEST بعد — طباعة المستندات ستظهر بترويسة فارغة.
            </div>
          )}

          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="p-3 border-b border-slate-200 flex items-center gap-2">
              <Building2 className="w-4 h-4 text-slate-500" />
              <h3 className="text-sm font-black text-slate-900">بيانات الشركة</h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1 p-3">
              {companyRows.map(row => (
                <div key={row.label} className="flex items-center justify-between gap-2 py-1 border-b border-slate-100">
                  <span className="text-[11px] text-slate-500">{row.label}</span>
                  <span className="text-[11px] font-bold text-slate-800 truncate">{row.value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="p-3 border-b border-slate-200 flex items-center gap-2">
              <Settings className="w-4 h-4 text-slate-500" />
              <h3 className="text-sm font-black text-slate-900">إعدادات النظام</h3>
            </div>
            <div className="p-3 space-y-2 text-[11px]">
              <div className="flex items-center justify-between border-b border-slate-100 pb-1">
                <span className="text-slate-500">عتبة تنبيه صلاحية المخزون (يوم)</span>
                <span className="font-mono font-bold text-slate-800">
                  {text(settings.expiry_warning_days)}
                </span>
              </div>
              <div className="flex items-center justify-between border-b border-slate-100 pb-1">
                <span className="text-slate-500">قالب الفاتورة: لون التمييز</span>
                <span className="font-mono font-bold text-slate-800">{text(template.accentColor)}</span>
              </div>
              <div className="flex items-center justify-between border-b border-slate-100 pb-1">
                <span className="text-slate-500">قالب الفاتورة: إظهار الشعار / الضريبة</span>
                <span className="font-mono font-bold text-slate-800">
                  {template.showLogo === false ? 'لا' : 'نعم'} / {template.showTaxNumber === false ? 'لا' : 'نعم'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">نص تذييل الفاتورة</span>
                <span className="font-bold text-slate-800 truncate max-w-[60%]">{text(template.footerText)}</span>
              </div>
            </div>
            <p className="px-4 py-2 text-[10px] text-slate-500 border-t border-slate-100">
              التعديل من هذه الشاشة غير مُفعَّل: تغيير هوية الشركة أو تصميم الفاتورة أو عتبة التنبيه قرار إداري
              يحتاج قاعدة معتمدة، ولا يُخترع هنا.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
