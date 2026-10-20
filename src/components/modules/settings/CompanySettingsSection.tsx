// Company identity + contact data (settings screen, Super Admin only).
// All writes go through CompanySettingsService → validated, audited, persisted
// in the database store the app reads (browser localStorage).
import React, { useRef, useState } from 'react';
import { Building2, ImageUp, Save, Trash2 } from 'lucide-react';
import { erpDb } from '../../../services/db';
import { CompanySettingsService } from '../../../services/companySettings';
import { SectionCard } from '../../ui';

const MAX_LOGO_BYTES = 300 * 1024;

export const CompanySettingsSection: React.FC = () => {
  const company = erpDb.getSnapshot().company;
  const [form, setForm] = useState({
    nameAr: company.nameAr,
    nameEn: company.nameEn,
    taxNumber: company.taxNumber,
    commercialRegister: company.commercialRegister || '',
    address: company.address || '',
    phone: company.phone || '',
    email: company.email || '',
    website: company.website || '',
    contactName: company.contactName || '',
    contactPhone: company.contactPhone || '',
    currentUsdExchangeRate: String(company.currentUsdExchangeRate ?? ''),
    logoDataUrl: company.logoDataUrl || '',
  });
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = (key: keyof typeof form, value: string) => setForm(prev => ({ ...prev, [key]: value }));

  const handleLogo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setMessage({ tone: 'error', text: 'الملف المختار ليس صورة' });
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setMessage({ tone: 'error', text: 'حجم الشعار أكبر من 300 كيلوبايت — اختر صورة أصغر' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set('logoDataUrl', String(reader.result || ''));
    reader.onerror = () => setMessage({ tone: 'error', text: 'تعذّرت قراءة ملف الشعار' });
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleSave = () => {
    const res = CompanySettingsService.updateCompany({
      nameAr: form.nameAr,
      nameEn: form.nameEn,
      taxNumber: form.taxNumber,
      commercialRegister: form.commercialRegister,
      address: form.address,
      phone: form.phone,
      email: form.email,
      website: form.website,
      contactName: form.contactName,
      contactPhone: form.contactPhone,
      logoDataUrl: form.logoDataUrl,
      currentUsdExchangeRate: form.currentUsdExchangeRate === '' ? undefined : Number(form.currentUsdExchangeRate),
    });
    setMessage(res.success
      ? { tone: 'ok', text: 'تم حفظ بيانات الشركة في قاعدة البيانات — تظهر فورًا في الفواتير المطبوعة.' }
      : { tone: 'error', text: res.error || 'تعذر حفظ بيانات الشركة' });
  };

  const input = 'w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold focus:outline-none focus:ring-2 focus:ring-slate-300';

  return (
    <SectionCard
      title="بيانات الشركة"
      hint="الاسم القانوني، الشعار، العنوان، الهاتف، الرقم الضريبي وبيانات التواصل"
      icon={Building2}
      headerAction={
        <button onClick={handleSave} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs cursor-pointer">
          <Save className="w-3.5 h-3.5" /> حفظ البيانات
        </button>
      }
    >
      {message && (
        <div className={`mb-4 p-3 rounded-xl text-xs font-bold border ${message.tone === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="space-y-3">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center">
            <div className="text-[11px] font-bold text-slate-500 mb-2">شعار الشركة (يظهر في الفواتير)</div>
            {form.logoDataUrl ? (
              <img src={form.logoDataUrl} alt="شعار الشركة" className="mx-auto h-20 max-w-full object-contain rounded-lg bg-white p-2 border border-slate-200" />
            ) : (
              <div className="h-20 flex items-center justify-center text-[11px] text-slate-400 border border-dashed border-slate-300 rounded-lg bg-white">لا يوجد شعار محفوظ</div>
            )}
            <div className="mt-3 flex justify-center gap-2">
              <button onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white border border-slate-300 text-slate-700 text-[11px] font-bold cursor-pointer">
                <ImageUp className="w-3.5 h-3.5" /> اختيار صورة
              </button>
              {form.logoDataUrl && (
                <button onClick={() => set('logoDataUrl', '')} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-[11px] font-bold cursor-pointer">
                  <Trash2 className="w-3.5 h-3.5" /> إزالة
                </button>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" className="hidden" onChange={handleLogo} />
            <p className="text-[10px] text-slate-400 mt-2">PNG / JPG / WEBP / SVG — حتى 300 كيلوبايت</p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-[11px] leading-relaxed text-slate-600">
            <b className="text-slate-800 block mb-1">أين تُحفظ البيانات؟</b>
            تُحفظ في قاعدة بيانات التطبيق نفسها (localStorage) وتُقرأ عند كل فتح، وتظهر مباشرة في الفواتير المطبوعة.
            لا توجد مزامنة سحابية بين الأجهزة — النسخ الاحتياطي من تبويب «البيانات».
          </div>
        </div>

        <div className="lg:col-span-2 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-bold text-slate-700 mb-1">اسم الشركة العربي *</label>
              <input className={input} value={form.nameAr} onChange={e => set('nameAr', e.target.value)} />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-700 mb-1">اسم الشركة الإنجليزي *</label>
              <input className={input} dir="ltr" value={form.nameEn} onChange={e => set('nameEn', e.target.value)} />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-700 mb-1">الرقم الضريبي</label>
              <input className={input} dir="ltr" value={form.taxNumber} onChange={e => set('taxNumber', e.target.value)} />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-700 mb-1">السجل التجاري</label>
              <input className={input} value={form.commercialRegister} onChange={e => set('commercialRegister', e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[11px] font-bold text-slate-700 mb-1">العنوان</label>
              <input className={input} value={form.address} onChange={e => set('address', e.target.value)} />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-700 mb-1">الهاتف</label>
              <input className={input} dir="ltr" value={form.phone} onChange={e => set('phone', e.target.value)} />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-700 mb-1">البريد الإلكتروني</label>
              <input className={input} dir="ltr" value={form.email} onChange={e => set('email', e.target.value)} />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-700 mb-1">الموقع الإلكتروني</label>
              <input className={input} dir="ltr" placeholder="https://" value={form.website} onChange={e => set('website', e.target.value)} />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-700 mb-1">سعر صرف الدولار المعتمد</label>
              <input className={input} type="number" step="0.01" value={form.currentUsdExchangeRate} onChange={e => set('currentUsdExchangeRate', e.target.value)} />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-700 mb-1">مسؤول التواصل</label>
              <input className={input} value={form.contactName} onChange={e => set('contactName', e.target.value)} />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-700 mb-1">هاتف التواصل</label>
              <input className={input} dir="ltr" value={form.contactPhone} onChange={e => set('contactPhone', e.target.value)} />
            </div>
          </div>
        </div>
      </div>
    </SectionCard>
  );
};
