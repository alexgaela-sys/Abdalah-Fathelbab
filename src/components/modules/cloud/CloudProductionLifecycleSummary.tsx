// Cloud production lifecycle status — read-only summary of the in-repo branch map.
//
// This component is intentionally lightweight and offline: it does NOT call the
// server. It mirrors the same branches that the automation file
// scripts/qa_cloud_manufacturing_lifecycle.ts documents, so the app and the
// automation stay on the same page about what is wired and what is still blocked.

import { lifecycleOutcomeSummary } from '../../../../scripts/qa_cloud_manufacturing_lifecycle';

export function CloudProductionLifecycleSummary() {
  return (
    <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-[11px] text-amber-900 leading-relaxed">
      <div className="flex items-center gap-2 mb-2">
        <span className="flex h-2.5 w-2.5 rounded-full bg-amber-500" />
        <span className="font-black text-[12px]">دورة الإنتاج السحابية — المراحل الموصلة والمرفوضة</span>
      </div>
      <pre className="whitespace-pre-wrap font-mono text-[10px] text-amber-900/90">{lifecycleOutcomeSummary()}</pre>
      <p className="mt-2 text-[10px] text-amber-800/80">
        الأسطر فوق ليست نتيجة تشغيل وهمي؛ هي الخريطة اللي الكود نتعهد بيه. الفرع اللي يلامس الخادم
        ({" "}
        <span className="font-mono">issue / output / close success</span> و
        <span className="font-mono">close retry idempotency</span>
        ) بيحتاج جلسة Supabase TEST حقيقية، وهو غير مثبت هنا.
      </p>
    </div>
  );
}
