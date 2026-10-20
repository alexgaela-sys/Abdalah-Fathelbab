// Invoice design: header/footer/logo/visible fields/font sizes/colors/alignment
// with a live preview before saving. Presentation only — no totals are computed
// differently here; the preview uses sample values.
import React, { useRef, useState } from 'react';
import { Eye, FileText, ImageUp, Save, Trash2 } from 'lucide-react';
import { erpDb } from '../../../services/db';
import { CompanySettingsService, computeInvoiceNetDue } from '../../../services/companySettings';
import { InvoiceAlignment, InvoiceTemplateSettings } from '../../../types/erp';
import { InvoiceFooter, InvoiceHeader, NetDueHighlight, InvoiceDocStyle } from '../../invoiceTemplate';
import { SectionCard } from '../../ui';

const MAX_LOGO_BYTES = 300 * 1024;
const fmt = (v: number) => (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const InvoiceDesignSection: React.FC = () => {
  const company = erpDb.getSnapshot().company;
  const [tpl, setTpl] = useState<InvoiceTemplateSettings>(() => CompanySettingsService.getInvoiceTemplate());
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = <K extends keyof InvoiceTemplateSettings>(key: K, value: InvoiceTemplateSettings[K]) =>
    setTpl(prev => ({ ...prev, [key]: value }));

  const handleLogo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { setMessage({ tone: 'error', text: 'الملف المختار ليس صورة' }); return; }
    if (file.size > MAX_LOGO_BYTES) { setMessage({ tone: 'error', text: 'حجم الشعار أكبر من 300 كيلوبايت' }); return; }
    const reader = new FileReader();
    reader.onload = () => set('logoDataUrl', String(reader.result || ''));
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleSave = () => {
    const res = CompanySettingsService.updateInvoiceTemplate(tpl);
    setMessage(res.success
      ? { tone: 'ok', text: 'تم حفظ تصميم الفاتورة — يُطبَّق فورًا على معاينة وطباعة الفواتير الجديدة والسابقة.' }
      : { tone: 'error', text: res.error || 'تعذر حفظ تصميم الفاتورة' });
  };

  const input = 'w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold focus:outline-none focus:ring-2 focus:ring-slate-300';
  const sampleTotal = 11400;
  const sampleWithholding = 100;
  const sampleNet = computeInvoiceNetDue(sampleTotal, sampleWithholding);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-5 gap-5">
      <div className="xl:col-span-3">
        <SectionCard
          title="تصميم الفاتورة"
          hint="الرأس والتذييل والشعار والحقول الظاهرة وأحجام الخطوط والألوان والمحاذاة"
          icon={FileText}
          headerAction={
            <button onClick={handleSave} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs cursor-pointer">
              <Save className="w-3.5 h-3.5" /> حفظ التصميم
            </button>
          }
        >
          {message && (
            <div className={`mb-4 p-3 rounded-xl text-xs font-bold border ${message.tone === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>
              {message.text}
            </div>
          )}

          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">نص رأس الفاتورة (عربي)</label>
                <textarea className={input} rows={2} value={tpl.headerTextAr} onChange={e => set('headerTextAr', e.target.value)} />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Header text (English)</label>
                <textarea className={input} rows={2} dir="ltr" value={tpl.headerTextEn} onChange={e => set('headerTextEn', e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[11px] font-bold text-slate-700 mb-1">نص التذييل</label>
                <textarea className={input} rows={2} value={tpl.footerText} onChange={e => set('footerText', e.target.value)} />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">عنوان صافي المستحق</label>
                <input className={input} value={tpl.netDueLabel} onChange={e => set('netDueLabel', e.target.value)} />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">المحاذاة</label>
                <select className={input} value={tpl.alignment} onChange={e => set('alignment', e.target.value as InvoiceAlignment)}>
                  <option value="right">يمين</option>
                  <option value="center">وسط</option>
                  <option value="left">يسار</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">حجم العنوان</label>
                <input className={input} type="number" min={10} max={40} value={tpl.titleFontSize} onChange={e => set('titleFontSize', Number(e.target.value))} />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">حجم النص</label>
                <input className={input} type="number" min={8} max={24} value={tpl.bodyFontSize} onChange={e => set('bodyFontSize', Number(e.target.value))} />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">حجم الجدول</label>
                <input className={input} type="number" min={8} max={24} value={tpl.tableFontSize} onChange={e => set('tableFontSize', Number(e.target.value))} />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">الشريط اللوني</label>
                <label className="flex items-center gap-2 p-2 rounded-xl bg-slate-50 border border-slate-300 text-[11px] font-bold cursor-pointer">
                  <input type="checkbox" checked={tpl.showAccentBar} onChange={e => set('showAccentBar', e.target.checked)} />
                  إظهار
                </label>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">اللون الأساسي</label>
                <input className="w-full h-9 rounded-xl border border-slate-300 bg-white cursor-pointer" type="color" value={tpl.accentColor} onChange={e => set('accentColor', e.target.value)} />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">لون النص</label>
                <input className="w-full h-9 rounded-xl border border-slate-300 bg-white cursor-pointer" type="color" value={tpl.textColor} onChange={e => set('textColor', e.target.value)} />
              </div>
              <div className="col-span-2">
                <label className="block text-[11px] font-bold text-slate-700 mb-1">الشعار</label>
                <div className="flex items-center gap-2">
                  <button onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-slate-100 border border-slate-300 text-slate-700 text-[11px] font-bold cursor-pointer">
                    <ImageUp className="w-3.5 h-3.5" /> صورة
                  </button>
                  {tpl.logoDataUrl && (
                    <button onClick={() => set('logoDataUrl', '')} className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-[11px] font-bold cursor-pointer">
                      <Trash2 className="w-3.5 h-3.5" /> إزالة
                    </button>
                  )}
                  <label className="flex items-center gap-1 text-[11px] font-bold text-slate-600">
                    <input type="checkbox" checked={tpl.showLogo} onChange={e => set('showLogo', e.target.checked)} /> إظهار الشعار
                  </label>
                  <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleLogo} />
                </div>
              </div>
            </div>

            <div>
              <div className="text-[11px] font-bold text-slate-700 mb-2">الحقول الظاهرة في الفاتورة</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px] font-bold text-slate-700">
                {([
                  ['showTaxNumber', 'الرقم الضريبي'],
                  ['showAddress', 'العنوان'],
                  ['showPhone', 'الهاتف'],
                  ['showEmail', 'البريد الإلكتروني'],
                  ['showCustomerTax', 'الرقم الضريبي للعميل'],
                  ['showWarehouse', 'المستودع'],
                  ['showWithholding', 'الخصم من المنبع'],
                  ['showNetDue', 'صافي المستحق'],
                ] as Array<[keyof InvoiceTemplateSettings, string]>).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 p-2 rounded-xl bg-slate-50 border border-slate-200 cursor-pointer">
                    <input type="checkbox" checked={Boolean(tpl[key])} onChange={e => (set as (k: keyof InvoiceTemplateSettings, v: unknown) => void)(key, e.target.checked)} />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            <p className="text-[11px] text-slate-500 leading-relaxed">
              لا يُطبع اسم النظام أو رابط التطبيق داخل المستند. حقول الأرقام والإجماليات تُطبع كما حُسبت في الفاتورة،
              وصافي المستحق المعروض = إجمالي الفاتورة − الاستقطاع الموثق (تقديري حتى توثيق الشهادة).
            </p>
          </div>
        </SectionCard>
      </div>

      <div className="xl:col-span-2">
        <div className="sticky top-4">
          <div className="flex items-center gap-2 mb-2 text-xs font-black text-slate-700">
            <Eye className="w-4 h-4" /> معاينة قبل الحفظ (بيانات تجريبية للعرض فقط)
          </div>
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 invoice-tpl" style={InvoiceDocStyle(tpl)} dir="rtl">
            <InvoiceHeader company={company} template={tpl} />

            <div className="flex justify-between items-end py-3 border-b border-slate-300" style={{ fontSize: Math.max(10, tpl.bodyFontSize - 1) }}>
              <div style={{ fontWeight: 900, fontSize: tpl.bodyFontSize + 3 }}>فاتورة مبيعات — تجزئة</div>
              <div>رقم المستند: SINV-2026-00001</div>
            </div>

            <div className="grid grid-cols-2 gap-2 py-2" style={{ fontSize: tpl.bodyFontSize }}>
              <div>العميل: <b>عميل تجريبي</b></div>
              <div>التاريخ: <b>{new Date().toISOString().split('T')[0]}</b></div>
              {tpl.showCustomerTax && <div>الرقم الضريبي للعميل: 000-000-000</div>}
              <div>طريقة الدفع: <b>آجل</b> · العملة: <b>EGP</b></div>
              {tpl.showWarehouse && <div>المستودع: <b>مستودع المنتج التام المحلي</b></div>}
            </div>

            <table className="w-full border-collapse" style={{ fontSize: tpl.tableFontSize }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${tpl.accentColor}` }}>
                  <th className="py-1 text-right">الصنف</th>
                  <th className="py-1 text-center">الكمية</th>
                  <th className="py-1 text-right">سعر الوحدة</th>
                  <th className="py-1 text-right">الإجمالي</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                  <td className="py-1">سناكس سِنجل — جبنة</td>
                  <td className="py-1 text-center font-mono">10</td>
                  <td className="py-1 text-right font-mono">{fmt(1000)}</td>
                  <td className="py-1 text-right font-mono">{fmt(10000)}</td>
                </tr>
              </tbody>
            </table>

            <div className="mt-3 space-y-1" style={{ fontSize: tpl.bodyFontSize }}>
              <div>الإجمالي قبل الضريبة: <b>{fmt(10000)}</b> EGP</div>
              <div>ضريبة القيمة المضافة (14%): {fmt(1400)} EGP</div>
              {tpl.showWithholding && (
                <div>خصم تحت حساب ضريبة الدخل (1%): <b>{fmt(sampleWithholding)}</b> EGP (تقديري)</div>
              )}
              <div style={{ fontWeight: 900 }}>الإجمالي النهائي: {fmt(sampleTotal)} EGP</div>
            </div>

            <NetDueHighlight template={tpl} totalAmount={sampleTotal} withholdingAmount={sampleWithholding} currency="EGP" format={fmt} />
            <div className="mt-2 text-[10px] text-slate-500">صافي المستحق في المعاينة: {fmt(sampleNet)} EGP</div>

            <InvoiceFooter company={company} template={tpl} />
          </div>
        </div>
      </div>
    </div>
  );
};
