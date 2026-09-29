import React, { useState } from 'react';
import { 
  Sparkles, CheckCircle2, XCircle, Play, 
  RotateCcw, ShieldCheck, Database, Check, Trash2
} from 'lucide-react';
import { TestDataService, TestResultItem } from '../../services/seedTestData';
import { erpDb } from '../../services/db';

interface TestRunnerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const TestRunnerModal: React.FC<TestRunnerModalProps> = ({ isOpen, onClose }) => {
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<TestResultItem[]>([]);
  const [hasRun, setHasRun] = useState(false);
  const [clearMessage, setClearMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleRunTests = async () => {
    setIsRunning(true);
    setClearMessage(null);
    setResults([]);
    try {
      const res = await TestDataService.runAll27EndToEndTests();
      setResults(res);
      setHasRun(true);
    } catch (e) {
      console.error(e);
    } finally {
      setIsRunning(false);
    }
  };

  // Requirement 11: Clear test data ONLY, strictly preserving users, products, chart of accounts, warehouses, system config
  const handleClearTestDataOnly = () => {
    if (confirm('تأكيد: هل ترغب في مسح كافة الحركات والمعاملات التجريبية فقط؟ (سيتم الحفاظ بالكامل على المستخدمين، المنتجات الـ 11، شجرة الحسابات، المستودعات، وإعدادات النظام)')) {
      erpDb.clearTestDataOnly();
      setResults([]);
      setHasRun(false);
      setClearMessage('تم مسح كافة المعاملات التجريبية بنجاح، مع بقاء كافة الأصناف والمستخدمين والحسابات والمستودعات سليمة كما هي.');
      setTimeout(() => setClearMessage(null), 4000);
    }
  };

  const handleResetToClean = () => {
    if (confirm('تحذير: هل ترغب في تهيئة النظام بالكامل وإعادة ضبط المصنع؟')) {
      erpDb.resetToClean();
      setResults([]);
      setHasRun(false);
      onClose();
    }
  };

  const passedCount = results.filter(r => r.status === 'passed').length;
  const failedCount = results.filter(r => r.status === 'failed').length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-xs p-4 animate-fade-in" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[90vh] flex flex-col text-right overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-slate-900 to-slate-800 text-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center">
              <Sparkles className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h2 className="text-base font-bold">مدقق الفحص الشامل للنظام (27 سيناريو E2E - System Test & Audit)</h2>
              <p className="text-xs text-slate-300">اختبار كافة دورات النظام المحاسبية والمخزنية والتصنيعية والرقابية والأمان مع إمكانية مسح بيانات الاختبار فقط</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition cursor-pointer"
          >
            ✕
          </button>
        </div>

        {/* Action Bar */}
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              onClick={handleRunTests}
              disabled={isRunning}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-md transition disabled:opacity-50 cursor-pointer"
            >
              <Play className="w-4 h-4 fill-white" />
              <span>{isRunning ? 'جاري الفحص المباشر...' : 'تشغيل فحص كافة السيناريوهات الآن'}</span>
            </button>

            {/* Requirement 11: Clear Test Data Only button */}
            <button
              onClick={handleClearTestDataOnly}
              disabled={isRunning}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-900 font-bold text-xs border border-amber-300 transition disabled:opacity-50 cursor-pointer"
              title="حذف الحركات التجريبية فقط مع الحفاظ التام على الأصناف والمستخدمين وشجرة الحسابات والمستودعات"
            >
              <Trash2 className="w-3.5 h-3.5 text-amber-700" />
              <span>مسح بيانات الاختبار</span>
            </button>
          </div>

          <div className="flex items-center gap-3">
            {hasRun && (
              <div className="flex items-center gap-3 text-xs font-bold">
                <span className="text-emerald-700 flex items-center gap-1">
                  <CheckCircle2 className="w-4 h-4" />
                  نجح: {passedCount}
                </span>
                {failedCount > 0 && (
                  <span className="text-rose-700 flex items-center gap-1">
                    <XCircle className="w-4 h-4" />
                    فشل: {failedCount}
                  </span>
                )}
              </div>
            )}

            <button
              onClick={handleResetToClean}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 font-semibold text-xs border border-rose-200 transition cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>تهيئة نظيفة شاملة</span>
            </button>
          </div>
        </div>

        {clearMessage && (
          <div className="p-3 bg-emerald-50 border-b border-emerald-200 text-emerald-800 text-xs font-bold flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{clearMessage}</span>
          </div>
        )}

        {/* Content / Test List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {!hasRun && !isRunning && (
            <div className="py-12 text-center text-slate-500 space-y-3">
              <ShieldCheck className="w-12 h-12 text-emerald-600 mx-auto opacity-70" />
              <p className="text-sm font-semibold text-slate-700">اضغط على "تشغيل فحص كافة السيناريوهات الآن" للتحقق من سلامة كافة دورات النظام الـ 20</p>
              <p className="text-xs text-slate-400 max-w-lg mx-auto">
                يشمل ذلك: المشتريات الآجلة، دورة التصنيع، BOM، المبيعات والبونص الترويجي، عهد المناديب، التحصيل الجزئي، تنبيهات الائتمان، الصلاحية، العملة الأجنبية USD، الشيكات، ومنع القيود غير المتزنة والمغلقة.
              </p>
              <div className="pt-2">
                <span className="text-[11px] px-3 py-1 rounded-full bg-slate-100 text-slate-600 font-medium">
                  المعاملات التي يتم إنشاؤها أثناء الاختبار تحمل علامة [اختبار] مميزة ويمكن مسحها بضغطة زر
                </span>
              </div>
            </div>
          )}

          {isRunning && (
            <div className="py-16 text-center text-slate-600 space-y-3">
              <div className="w-8 h-8 border-3 border-emerald-600 border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="text-xs font-bold">جاري تنفيذ القيود المحاسبية، وتحديثات المخزون Perpetual، ومعادلات التصنيع...</p>
            </div>
          )}

          {results.map((r) => (
            <div 
              key={r.scenarioNumber}
              className={`p-3.5 rounded-xl border transition ${
                r.status === 'passed' 
                  ? 'bg-emerald-50/50 border-emerald-200' 
                  : 'bg-rose-50/50 border-rose-200'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className={`w-6 h-6 rounded-lg text-xs font-bold flex items-center justify-center ${
                    r.status === 'passed' ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'
                  }`}>
                    {r.scenarioNumber}
                  </span>
                  <span className="font-bold text-xs text-slate-900">{r.titleAr}</span>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                  r.status === 'passed' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                }`}>
                  {r.status === 'passed' ? 'تم بنجاح ✓' : 'فشل ✕'}
                </span>
              </div>
              <p className="text-[11px] text-slate-600 mt-2 mr-8 leading-relaxed font-sans">{r.detailsAr}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
