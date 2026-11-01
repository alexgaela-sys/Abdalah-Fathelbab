-- =====================================================================
-- Migration SQL واحدة: جدول اختبار ثابت وآمن على Supabase TEST فقط
-- الهدف: Supabase project ref = xrqksgjtqzddzqcwfnaj
-- الاختبار: scripts/erp_cloud_slice_first_write_test.ts
-- لا تنفذها الآن. لا تغيّر Production أو localStorage أو جداول ERP.
-- =====================================================================

-- =====================================================================
-- 0) متطلبات التنفيذ الآمن
-- =====================================================================
-- 1) تُطبق migration هذه على Supabase TEST فقط.
-- 2) يجب إنشاء مستخدم مصادقة اختباري مخصص (غير anon فقط) واستخدامه
--    في الاختبار: SUPABASE_TEST_USER_EMAIL / SUPABASE_TEST_USER_PASSWORD.
-- 3) لا تُستخدم service_role/secret API keys في الاختبار أو أي VITE_ vars.
-- 4) يُفحَص project ref targets قبل التنفيذ خارج SQL (عبر بيئة التنفيذ
--    أو يدويًا)، دون إدخال أسرار أو مشروع ref سري داخل هذا الملف.
-- 5) يفترض هذا الملف أن المُنفِّذ يمتلك صلاحيات إنشاء جدول وRLS والسياسات
--    على public في TEST. لا يُشغّل إلا إذا كان الهدف فعلاً TEST.

-- =====================================================================
-- 1) جدول الاختبار الثابت
-- =====================================================================
-- جدول مخصص للاختبار فقط، ولا يمس accounts / journal / inventory / ERP.
CREATE TABLE IF NOT EXISTS public.erp_cloud_first_slice_tests (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id),
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('written', 'read_back', 'verified', 'deleted')),
  note TEXT
);

-- =====================================================================
-- 2) RLS مفعل للجدول
-- =====================================================================
ALTER TABLE public.erp_cloud_first_slice_tests
  ENABLE ROW LEVEL SECURITY;

-- =====================================================================
-- 3) إدارة الصلاحيات والسياسات بشكل صريح ومتكرر
-- =====================================================================
-- أولاً: إغلاق الوصول العام الافتراضي
REVOKE ALL ON public.erp_cloud_first_slice_tests FROM PUBLIC;
REVOKE ALL ON public.erp_cloud_first_slice_tests FROM anon;

-- ثانياً: منح الصلاحيات المطلوبة للدور authenticated فقط
GRANT SELECT, INSERT, DELETE ON public.erp_cloud_first_slice_tests TO authenticated;
--允许 authenticated reading/inserting/deleting only, not updates/ownership changes

-- ثالثاً: السياسات المبنية على auth.uid()، بنفس الشرط في USING و WITH CHECK
-- حذف أي سياسة سابقة لنفس الاسم أولاً لضمان عدم التكرار عند إعادة التشغيل
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'erp_cloud_first_slice_tests'
      AND policyname = 'erp_cloud_first_slice_tests_owner_only'
  ) THEN
    EXECUTE 'DROP POLICY erp_cloud_first_slice_tests_owner_only ON public.erp_cloud_first_slice_tests';
  END IF;
END $$;

CREATE POLICY erp_cloud_first_slice_tests_owner_only
  ON public.erp_cloud_first_slice_tests
  FOR ALL
  TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- =====================================================================
-- 4) ملاحظات غير تنفيذية لضمان الأمان والصلاحيات الصحيحة
-- =====================================================================
-- 1) الاختبار يتوقع أن الإدراج يحتوي على owner_id صريح، وهو owner_id =
--    auth.uid() القادم من JWT المستخدم.
-- 2) السياسة تمنع الاخت투자자문 إلا لـ owner_id الخاص بالمصادق.
-- 3) لا توجد سياسة anon مفتوحة ولا منح PUBLIC.
-- 4) لا يُغيّر هذا الملف جداول ERP، ولا صلاحيات جداول ERP، ولا يفتح
--    الوصول العام إلى أي جدول اختبار خارج السياسة المكتوبة هنا.
-- 5) إذا اكتشف الاختبار أن الجدول غير موجود أو أن RLS/السياسات غير
--    مُطبّقة، يجب ألا يجرّب الإدراج، وأن يُبلّغ عن مانع حقيقي.

-- =====================================================================
-- 5) فحوص ما بعد التطبيق (يُشغّل محليًا بعد migration على TEST)
-- =====================================================================
-- بعد التطبيق، يُشغّل فحص محلي صريح للتأكد:
--   * أن الجدول public.erp_cloud_first_slice_tests موجود.
--   * أن RLS مفعل.
--   * أن السياسة erp_cloud_first_slice_tests_owner_only موجودة.
--   * أن PUBLIC و anon ممنوعان، و authenticated مُخوّل SELECT/INSERT/DELETE.
--   * أن لا جدول ERP قد تغيّر.
-- الفحص يُجرى على TEST فقط، ويُثبت project ref الهدف قبل التشغيل.
-- =====================================================================

-- =====================================================================
-- 6) ملاحظة تنفيذية قصيرة
-- =====================================================================
-- migration جاهزة للتطبيق على TEST فقط، ولا تُنفذ تلقائيًا.
-- الاختبار لن يكمل إلا بعد:
--   * تطبيق migration على TEST تحت صلاحيات مناسبة،
--   * إنشاء مستخدم مصادقة اختباري مخصص (ليس anon)،
--   * ضبط متغيرات البيئة المطلوبة (VITE_SUPABASE_URL و anon key
--    مقابل التوقيع، بالإضافة إلى SUPABASE_TEST_USER_EMAIL و
--    SUPABASE_TEST_USER_PASSWORD للاختبار)،
--   * التأكد أن الاختبار يوقّع دخولًا بنجاح قبل أي عمليات على الجدول.
-- =====================================================================
