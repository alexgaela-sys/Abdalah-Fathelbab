import React, { useState } from 'react';
import { 
  Settings, Building2, Boxes, Package, 
  Layers, RefreshCw, Download, Upload, Check, Plus,
  Trash2, Sparkles, ShieldCheck, AlertTriangle
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { Item, ProductFamily, Warehouse } from '../../types/erp';

interface SettingsViewProps {
  openTestRunner?: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ openTestRunner }) => {
  const db = erpDb.getSnapshot();
  const [activeTab, setActiveTab] = useState<'products' | 'company' | 'warehouses' | 'mappings' | 'data'>('products');
  const [showAddProductModal, setShowAddProductModal] = useState(false);
  const [dataMessage, setDataMessage] = useState<string | null>(null);

  // Company state
  const [companyNameAr, setCompanyNameAr] = useState(db.company.nameAr);
  const [taxNumber, setTaxNumber] = useState(db.company.taxNumber);
  const [usdRate, setUsdRate] = useState(db.company.currentUsdExchangeRate);

  // New Product form state (Product Master for Administrator)
  const [prodCode, setProdCode] = useState(`SNK-00${db.items.filter(i => i.itemType === 'finished_product').length + 1}`);
  const [prodNameAr, setProdNameAr] = useState('');
  const [prodNameEn, setProdNameEn] = useState('');
  const [family, setFamily] = useState<ProductFamily>('Single');
  const [flavor, setFlavor] = useState('جبنة متبلة');
  const [stdCost, setStdCost] = useState(0);
  const [priceRetail, setPriceRetail] = useState(0);
  const [priceWholesale, setPriceWholesale] = useState(0);
  const [priceExportUsd, setPriceExportUsd] = useState(0);
  const [vatRate, setVatRate] = useState(0.14);

  const finishedProducts = db.items.filter(i => i.itemType === 'finished_product');

  const handleSaveCompany = () => {
    erpDb.mutate(draft => {
      draft.company.nameAr = companyNameAr;
      draft.company.taxNumber = taxNumber;
      draft.company.currentUsdExchangeRate = Number(usdRate);
    });
    alert('تم حفظ إعدادات الشركة وسعر الصرف بنجاح');
  };

  const handleSaveProduct = () => {
    if (!prodNameAr.trim()) {
      alert('يرجى كتابة اسم المنتج');
      return;
    }

    const newProd: Item = {
      id: `item-fp-${Date.now()}`,
      code: prodCode,
      nameAr: prodNameAr,
      nameEn: prodNameEn,
      itemType: 'finished_product',
      productFamily: family,
      flavor,
      baseUnitId: 'unit-carton',
      vatRate: Number(vatRate),
      vatCategory: 'standard',
      trackBatch: true,
      trackExpiry: true,
      standardCost: Number(stdCost),
      actualCost: Number(stdCost),
      sellingPriceRetail: Number(priceRetail),
      sellingPriceWholesale: Number(priceWholesale),
      sellingPriceExportUSD: Number(priceExportUsd),
      active: true,
      minStockLevel: 0,
    };

    erpDb.mutate(draft => {
      draft.items.push(newProd);

      // Auto create BOM V1 for this finished snack
      const bomId = `bom-${newProd.id}`;
      draft.boms.push({
        id: bomId,
        bomNumber: `BOM-${newProd.code}-V1`,
        finishedItemId: newProd.id,
        version: 1,
        baseQuantity: 1000,
        unitId: 'unit-carton',
        active: true,
        effectiveDate: new Date().toISOString().split('T')[0],
        notes: `معادلة تصنيع 1000 كرتونة من ${newProd.nameAr}`,
      });

      draft.bomLines.push(
        { id: `bline-${bomId}-1`, bomId, materialItemId: 'item-raw-corn', quantityRequired: 800, unitId: 'unit-kg' },
        { id: `bline-${bomId}-2`, bomId, materialItemId: 'item-raw-oil', quantityRequired: 180, unitId: 'unit-kg' },
        { id: `bline-${bomId}-3`, bomId, materialItemId: 'item-pkg-carton', quantityRequired: 1000, unitId: 'unit-piece' }
      );

      draft.auditLogs.push({
        id: `aud-${Date.now()}`,
        timestamp: new Date().toISOString(),
        userId: 'usr-admin',
        userName: 'المشرف العام (Admin)',
        module: 'إعدادات المنتجات',
        action: 'create',
        recordId: newProd.id,
        description: `إنشاء منتج تام جديد: ${newProd.code} - ${newProd.nameAr}`,
      });
    });

    setShowAddProductModal(false);
    setProdNameAr('');
    setProdNameEn('');
  };

  const handleExportBackup = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(db, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `abdullah_erp_backup_${new Date().toISOString().split('T')[0]}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleImportBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        if (parsed.company && parsed.accounts && parsed.items) {
          if (confirm('تأكيد استعادة النسخة الاحتياطية؟ سيتم تحديث قاعدة البيانات الحالية.')) {
            erpDb.restore(parsed);
            setDataMessage('تمت استعادة النسخة الاحتياطية بنجاح.');
            setTimeout(() => setDataMessage(null), 4000);
          }
        } else {
          alert('ملف النسخة الاحتياطية غير صالح');
        }
      } catch (err) {
        alert('حدث خطأ في قراءة ملف النسخة الاحتياطية');
      }
    };
    reader.readAsText(file);
  };

  // Requirement 11: Clear test data only
  const handleClearTestDataOnly = () => {
    if (confirm('تأكيد مسح بيانات الاختبار: هل أنت متأكد من حذف الحركات والمعاملات التجريبية فقط؟\n\nلن يتم حذف المستخدمين أو المنتجات الـ 11 أو دليل الحسابات أو المستودعات إطلاقاً.')) {
      erpDb.clearTestDataOnly();
      setDataMessage('تم مسح بيانات الاختبار بنجاح مع الحفاظ التام على الأصناف والمستخدمين وشجرة الحسابات والمستودعات.');
      setTimeout(() => setDataMessage(null), 4000);
    }
  };

  const handleResetToClean = () => {
    if (confirm('تحذير: هل أنت متأكد من الرغبة في إعادة الضبط النظيف للنظام؟')) {
      erpDb.resetToClean();
      setDataMessage('تمت إعادة ضبط النظام إلى الحالة النظيفة المعتمدة.');
      setTimeout(() => setDataMessage(null), 4000);
    }
  };

  return (
    <div className="space-y-6 text-right">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">إعدادات النظام والبيانات الأساسية (Master Data & Config)</h2>
          <p className="text-xs text-slate-500 mt-1">
            سجل المنتجات الـ 11 (سناكس عائلات Single و Duo)، بيانات الشركة، المستودعات، ربط الحسابات، وإدارة بيانات الاختبار
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleExportBackup}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs border border-slate-300 transition cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>تصدير نسخة احتياطية (JSON)</span>
          </button>
        </div>
      </div>

      {dataMessage && (
        <div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold flex items-center gap-2 shadow-xs">
          <Check className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{dataMessage}</span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setActiveTab('products')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'products' ? 'bg-slate-900 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          سجل المنتجات التامة الـ 11 ({finishedProducts.length})
        </button>
        <button
          onClick={() => setActiveTab('company')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'company' ? 'bg-slate-900 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          بيانات الشركة والعملات
        </button>
        <button
          onClick={() => setActiveTab('warehouses')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'warehouses' ? 'bg-slate-900 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          المستودعات الخمسة المعتمدة
        </button>
        <button
          onClick={() => setActiveTab('mappings')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'mappings' ? 'bg-slate-900 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          ربط وتوجيه الحسابات (Account Mappings)
        </button>
        {/* Requirement 11: System & Test Data Tab */}
        <button
          onClick={() => setActiveTab('data')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'data' ? 'bg-slate-900 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          إدارة بيانات الاختبار والنسخ الاحتياطي
        </button>
      </div>

      {/* 1. Products Master */}
      {activeTab === 'products' && (
        <div className="space-y-4">
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex justify-between items-center">
            <div>
              <h3 className="font-bold text-xs text-slate-800">
                سجل الأصناف التامة المصنعة (سناكس) - المسجل حالياً: {finishedProducts.length} من أصل 11
              </h3>
              <p className="text-[11px] text-slate-500">
                تنقسم المنتجات إلى عائلتين رئيسيتين: (Single و Duo) وتتميز بالنكهات وأسعار التجزئة والجملة والتصدير
              </p>
            </div>
            <button
              onClick={() => {
                setProdCode(`SNK-00${finishedProducts.length + 1}`);
                setShowAddProductModal(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-xs cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>إضافة منتج تام جديد</span>
            </button>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-100 text-slate-700 font-bold border-b border-slate-200">
                <tr>
                  <th className="p-3.5">الكود</th>
                  <th className="p-3.5">اسم المنتج العربي</th>
                  <th className="p-3.5">العائلة</th>
                  <th className="p-3.5">النكهة</th>
                  <th className="p-3.5 text-center">التكلفة المعيارية</th>
                  <th className="p-3.5 text-center">سعر التجزئة</th>
                  <th className="p-3.5 text-center">سعر الجملة</th>
                  <th className="p-3.5 text-center">سعر التصدير ($)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {finishedProducts.map(p => (
                  <tr key={p.id} className="hover:bg-slate-50 transition">
                    <td className="p-3.5 font-mono font-bold text-slate-900">{p.code}</td>
                    <td className="p-3.5 font-bold text-slate-800">{p.nameAr}</td>
                    <td className="p-3.5">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                        p.productFamily === 'Single' ? 'bg-amber-100 text-amber-900' : 'bg-indigo-100 text-indigo-900'
                      }`}>
                        عائلة {p.productFamily}
                      </span>
                    </td>
                    <td className="p-3.5 text-slate-600">{p.flavor}</td>
                    <td className="p-3.5 text-center font-mono font-bold text-slate-700">
                      {p.standardCost ? `${p.standardCost} ج.م` : '0'}
                    </td>
                    <td className="p-3.5 text-center font-mono font-bold text-emerald-700">
                      {p.sellingPriceRetail ? `${p.sellingPriceRetail} ج.م` : '0'}
                    </td>
                    <td className="p-3.5 text-center font-mono font-bold text-blue-700">
                      {p.sellingPriceWholesale ? `${p.sellingPriceWholesale} ج.م` : '0'}
                    </td>
                    <td className="p-3.5 text-center font-mono font-bold text-purple-700">
                      {p.sellingPriceExportUSD ? `$${p.sellingPriceExportUSD}` : '0'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 2. Company Settings */}
      {activeTab === 'company' && (
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs max-w-2xl space-y-4">
          <h3 className="font-bold text-sm text-slate-900 pb-2 border-b border-slate-100">
            بيانات المنشأة والعملات وأسعار الصرف
          </h3>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">اسم الشركة القانوني</label>
              <input
                type="text"
                value={companyNameAr}
                onChange={(e) => setCompanyNameAr(e.target.value)}
                className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">الرقم الضريبي للمنشأة</label>
                <input
                  type="text"
                  value={taxNumber}
                  onChange={(e) => setTaxNumber(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">سعر صرف الدولار المعتمد (ج.م / $)</label>
                <input
                  type="number"
                  step="0.1"
                  value={usdRate}
                  onChange={(e) => setUsdRate(Number(e.target.value))}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono font-bold"
                />
              </div>
            </div>
          </div>

          <div className="pt-2">
            <button
              onClick={handleSaveCompany}
              className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md cursor-pointer"
            >
              حفظ التعديلات
            </button>
          </div>
        </div>
      )}

      {/* 3. Warehouses */}
      {activeTab === 'warehouses' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200">
            <h3 className="font-bold text-xs text-slate-800">المستودعات الخمسة المعتمدة في النظام</h3>
            <p className="text-[11px] text-slate-500">فصل محكم بين مستودعات الخامات، الإنتاج التام، التصدير، التوالف، والهالك</p>
          </div>

          <table className="w-full text-right text-xs">
            <thead className="bg-slate-100 text-slate-700 font-bold">
              <tr>
                <th className="p-3.5">الكود</th>
                <th className="p-3.5">اسم المستودع</th>
                <th className="p-3.5">النوع والتخصص</th>
                <th className="p-3.5">الموقع والعنبر</th>
                <th className="p-3.5">أمين المستودع</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {db.warehouses.map(wh => (
                <tr key={wh.id} className="hover:bg-slate-50">
                  <td className="p-3.5 font-mono font-bold text-slate-900">{wh.code}</td>
                  <td className="p-3.5 font-bold text-slate-800">{wh.nameAr}</td>
                  <td className="p-3.5 text-slate-600 font-mono text-[11px]">{wh.type}</td>
                  <td className="p-3.5 text-slate-600">{wh.location}</td>
                  <td className="p-3.5 text-slate-800 font-semibold">{wh.managerName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 4. Account Mappings */}
      {activeTab === 'mappings' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200">
            <h3 className="font-bold text-xs text-slate-800">ربط وتوجيه الحسابات الآلية (Account Mappings)</h3>
            <p className="text-[11px] text-slate-500">عدم تثبيت أكواد الحسابات في الكود وإمكانية توجيه القيود الآلية لأي حساب بدليل الحسابات</p>
          </div>

          <table className="w-full text-right text-xs">
            <thead className="bg-slate-100 text-slate-700 font-bold">
              <tr>
                <th className="p-3.5">مفتاح الربط (Mapping Key)</th>
                <th className="p-3.5">الحساب المربوط حالياً</th>
                <th className="p-3.5 text-center">كود الحساب</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {Object.entries(db.accountMappings).map(([key, accId]) => {
                const acc = db.accounts.find(a => a.id === accId);
                return (
                  <tr key={key} className="hover:bg-slate-50">
                    <td className="p-3.5 font-mono font-bold text-slate-700">{key}</td>
                    <td className="p-3.5 font-bold text-slate-900">{acc?.nameAr || accId}</td>
                    <td className="p-3.5 text-center font-mono font-black text-amber-700">{acc?.code || '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 5. Requirement 11: Test Data & System Backup Management */}
      {activeTab === 'data' && (
        <div className="space-y-5 max-w-3xl">
          {/* Clear Test Data Card */}
          <div className="bg-white p-6 rounded-2xl border border-amber-200 shadow-xs space-y-3">
            <div className="flex items-center gap-3 pb-3 border-b border-slate-100">
              <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center font-bold">
                <Trash2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-slate-900">مسح بيانات الاختبار فقط (Clear Test Transactions Only)</h3>
                <p className="text-xs text-slate-500">حذف الحركات والمعاملات التجريبية الناتجة عن وضع الاختبار دون لمس البيانات الأساسية</p>
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-amber-50/70 border border-amber-200 text-xs text-amber-900 leading-relaxed">
              <strong>قاعدة الأمان:</strong> هذا الإجراء يقوم بحذف فواتير الاختبار، وسندات الاختبار، وأوامر التشغيل، والقيود المحاسبية التجريبية فقط. 
              <strong> لا يتم إطلاقاً حذف:</strong> المستخدمين، المنتجات الـ 11، شجرة الحسابات، المستودعات، أو إعدادات الشركة.
            </div>

            <div className="pt-2 flex items-center gap-3">
              <button
                onClick={handleClearTestDataOnly}
                className="px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs shadow-md transition cursor-pointer flex items-center gap-2"
              >
                <Trash2 className="w-4 h-4" />
                <span>مسح بيانات الاختبار الآن</span>
              </button>

              {openTestRunner && (
                <button
                  onClick={openTestRunner}
                  className="px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs transition cursor-pointer flex items-center gap-2"
                >
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  <span>فتح وضع الاختبار (Test Runner)</span>
                </button>
              )}
            </div>
          </div>

          {/* Backup & Restore Card */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs space-y-4">
            <div className="flex items-center gap-3 pb-3 border-b border-slate-100">
              <div className="w-10 h-10 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center font-bold">
                <Download className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-slate-900">النسخ الاحتياطي والاستعادة الكاملة (Backup & Restore)</h3>
                <p className="text-xs text-slate-500">تصدير قاعدة بيانات النظام بالكامل كملف JSON واستعادتها في أي وقت</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                <span className="font-bold text-xs text-slate-800 block">تصدير نسخة احتياطية</span>
                <p className="text-[11px] text-slate-500">حفظ ملف JSON يحتوي على كافة الجداول والبيانات الحالية</p>
                <button
                  onClick={handleExportBackup}
                  className="w-full mt-2 py-2 px-3 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs rounded-xl shadow-xs transition cursor-pointer flex items-center justify-center gap-2"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>تحميل النسخة الاحتياطية</span>
                </button>
              </div>

              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                <span className="font-bold text-xs text-slate-800 block">استعادة من ملف JSON</span>
                <p className="text-[11px] text-slate-500">رفع ملف نسخة احتياطية واستبدال البيانات الحالية بها</p>
                <label className="w-full mt-2 py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl shadow-xs transition cursor-pointer flex items-center justify-center gap-2">
                  <Upload className="w-3.5 h-3.5" />
                  <span>اختيار ملف والاستعادة</span>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleImportBackup}
                    className="hidden"
                  />
                </label>
              </div>
            </div>
          </div>

          {/* Reset System to Clean */}
          <div className="bg-white p-6 rounded-2xl border border-rose-200 shadow-xs space-y-3">
            <div className="flex items-center gap-2 text-rose-700 font-bold text-xs">
              <AlertTriangle className="w-4 h-4" />
              <span>إعادة ضبط المصنع (Reset to Clean Initial)</span>
            </div>
            <p className="text-xs text-slate-600">
              إفراغ كافة المعاملات والبدء بنظام نظيف تماماً يحتوي فقط على الأصناف الـ 11 والمستخدم الإداري الافتراضي والمستودعات وشجرة الحسابات.
            </p>
            <button
              onClick={handleResetToClean}
              className="px-4 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold text-xs border border-rose-300 transition cursor-pointer"
            >
              إعادة الضبط للحالة النظيفة
            </button>
          </div>
        </div>
      )}

      {/* Add Product Master Modal */}
      {showAddProductModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg p-6 text-right space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-base text-slate-900">تعريف منتج تام سناكس جديد</h3>
              <button onClick={() => setShowAddProductModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">كود المنتج</label>
                  <input
                    type="text"
                    value={prodCode}
                    onChange={(e) => setProdCode(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">عائلة المنتج</label>
                  <select
                    value={family}
                    onChange={(e) => setFamily(e.target.value as ProductFamily)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold"
                  >
                    <option value="Single">عائلة سِنجل (Single)</option>
                    <option value="Duo">عائلة ديو (Duo)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">الاسم العربي للمنتج</label>
                <input
                  type="text"
                  placeholder="اسم المنتج بالعربية..."
                  value={prodNameAr}
                  onChange={(e) => setProdNameAr(e.target.value)}
                  className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">النكهة / المتغير</label>
                  <input
                    type="text"
                    placeholder="النكهة والصوص..."
                    value={flavor}
                    onChange={(e) => setFlavor(e.target.value)}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">التكلفة المعيارية (ج.م / كرتونة)</label>
                  <input
                    type="number"
                    value={stdCost}
                    onChange={(e) => setStdCost(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">سعر التجزئة (ج.م)</label>
                  <input
                    type="number"
                    value={priceRetail}
                    onChange={(e) => setPriceRetail(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">سعر الجملة (ج.م)</label>
                  <input
                    type="number"
                    value={priceWholesale}
                    onChange={(e) => setPriceWholesale(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">سعر التصدير ($)</label>
                  <input
                    type="number"
                    step="0.05"
                    value={priceExportUsd}
                    onChange={(e) => setPriceExportUsd(Number(e.target.value))}
                    className="w-full p-2 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setShowAddProductModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs cursor-pointer"
              >
                إلغاء
              </button>
              <button
                onClick={handleSaveProduct}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md cursor-pointer"
              >
                حفظ المنتج وإنشاء معادلة BOM
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
