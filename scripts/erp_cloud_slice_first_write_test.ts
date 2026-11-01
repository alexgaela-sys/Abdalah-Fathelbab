// =====================================================================
// erp_cloud_slice_first_write_test.ts
// =====================================================================

import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// =====================================================================
// متغيرات البيئة المطلوبة
// =====================================================================

type RequiredEnv = {
  supabaseUrl: string;
  anonKey: string;
  testUserEmail: string;
  testUserPassword: string;
};

function envValue(name: string): string {
  const env = process.env as unknown as Record<string, string | undefined>;
  return (env[name] || '').trim();
}

function requiredEnv(): RequiredEnv {
  return {
    supabaseUrl: envValue('VITE_SUPABASE_URL'),
    anonKey: envValue('VITE_SUPABASE_ANON_KEY'),
    testUserEmail: envValue('SUPABASE_TEST_USER_EMAIL'),
    testUserPassword: envValue('SUPABASE_TEST_USER_PASSWORD'),
  };
}

function configured(env: RequiredEnv): boolean {
  return (
    env.supabaseUrl.length > 0 &&
    env.anonKey.length > 0 &&
    env.testUserEmail.length > 0 &&
    env.testUserPassword.length > 0
  );
}

function isTestProjectUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('supabase.co');
  } catch {
    return false;
  }
}

// =====================================================================
// عميل الاختبار
// =====================================================================

let client: SupabaseClient | null = null;
let currentUser: User | null = null;

async function createClientForTest(env: RequiredEnv): Promise<SupabaseClient> {
  const c = createClient(env.supabaseUrl, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: 'public' },
  });
  return c;
}

async function signIn(env: RequiredEnv, client_: SupabaseClient): Promise<User> {
  const res = await client_.auth.signInWithPassword({
    email: env.testUserEmail,
    password: env.testUserPassword,
  });

  if (res.error) {
    throw new Error(`فشل المصادقة: ${res.error.message?.slice(0, 120) ?? res.error?.toString?.().slice(0, 120) ?? 'no error message'}`);
  }

  if (!res.data?.user) {
    throw new Error('فشل المصادقة: لم يُعاد أي مستخدم من jwt');
  }

  return res.data.user as User;
}

// =====================================================================
// جدول الاختبار
// =====================================================================

const TEST_TABLE = 'erp_cloud_first_slice_tests';
const TEST_RECORD_ID = `erp_slice_01_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const REPORT_PATH = join(process.cwd(), 'tmp', 'erp_cloud_slice_first_write_test.json');

type TestCaseRow = {
  id: string;
  owner_id: string;
  run_at: string;
  status: 'written' | 'read_back' | 'verified' | 'deleted';
  note: string;
};

// =====================================================================
// عمليات الجدول (لا UPDATE، لا لمس جداول ERP)
// =====================================================================

async function insertTestRow(row: TestCaseRow): Promise<void> {
  const { error } = await client!.from(TEST_TABLE).insert(row);
  if (error) {
    throw new Error(`فشل الإدراج في جدول الاختبار: ${error.message?.slice(0, 200) ?? String(error)}`);
  }
}

async function readTestRow(id: string, ownerId: string): Promise<TestCaseRow | null> {
  const { data, error } = await client!.from(TEST_TABLE)
    .select('*')
    .eq('id', id)
    .eq('owner_id', ownerId)
    .single();
  if (error && error.code !== 'PGRST116') {
    throw new Error(`فشل القراءة من جدول الاختبار: ${error.message?.slice(0, 200) ?? String(error)}`);
  }
  return (data as TestCaseRow) ?? null;
}

async function deleteTestRow(id: string, ownerId: string): Promise<void> {
  const { error } = await client!.from(TEST_TABLE)
    .delete()
    .eq('id', id)
    .eq('owner_id', ownerId);
  if (error) {
    throw new Error(`فشل الحذف من جدول الاختبار: ${error.message?.slice(0, 200) ?? String(error)}`);
  }
}

// =====================================================================
// تقرير الاختبار
// =====================================================================

let report: {
  prepared: boolean;
  configured: boolean;
  isTestUrl: boolean;
  signInOk: boolean | null;
  tableAvailable: boolean | null;
  inserted: boolean;
  readBack: boolean;
  verified: boolean;
  deleted: boolean;
  detail: string;
  records: TestCaseRow[];
} = {
  prepared: true,
  configured: false,
  isTestUrl: false,
  signInOk: null,
  tableAvailable: null,
  inserted: false,
  readBack: false,
  verified: false,
  deleted: false,
  detail: '',
  records: [],
};

// =====================================================================
// تنفيذ الاختبار
// =====================================================================

async function run(): Promise<void> {
  const env = requiredEnv();
  report.configured = configured(env);

  if (!report.configured) {
    report.detail = 'بيئة TEST غير مُثبتة: يجب ضبط VITE_SUPABASE_URL و VITE_SUPABASE_ANON_KEY و SUPABASE_TEST_USER_EMAIL و SUPABASE_TEST_USER_PASSWORD. لا يتم إنشاء أي كتابة.';
    return;
  }

  if (!isTestProjectUrl(env.supabaseUrl)) {
    report.detail = 'فشل التحقق المبدئي: VITE_SUPABASE_URL لا يشير إلى مشروع supabase.co المتوقع. يُرجى التأكد من استخدام TEST project ref.';
    return;
  }

  report.isTestUrl = true;

  mkdirSync(join(process.cwd(), 'tmp'), { recursive: true });

  try {
    client = await createClientForTest(env);
  } catch (err) {
    report.detail = `فشل الإعداد: ${(err as Error).message?.slice(0, 200) ?? String(err)}`;
    return;
  }

  try {
    currentUser = await signIn(env, client);
    report.signInOk = true;
  } catch (err) {
    report.signInOk = false;
    report.detail = `فشل المصادقة: ${(err as Error).message?.slice(0, 200) ?? String(err)}`;
    return;
  }

  // preflight: التأكد من أن الجدول موجود حاليًا
  try {
    const { error } = await client!
      .from(TEST_TABLE)
      .select('id')
      .eq('owner_id', currentUser!.id)
      .limit(0);
    if (error && error.code !== 'PGRST116') {
      report.tableAvailable = false;
      report.detail = `فشل الفحص الأولي: ${error.message?.slice(0, 200) ?? String(error)}`;
      return;
    }
    report.tableAvailable = true;
  } catch (err) {
    report.tableAvailable = false;
    report.detail = `فشل الفحص الأولي: ${(err as Error).message?.slice(0, 200) ?? String(err)}`;
    return;
  }

  const row: TestCaseRow = {
    id: TEST_RECORD_ID,
    owner_id: currentUser.id,
    run_at: new Date().toISOString(),
    status: 'written',
    note: 'سجل اختبار First Cloud Slice — ERP Cloud PoC',
  };

  try {
    await insertTestRow(row);
    report.inserted = true;
    report.records.push(row);
  } catch (err) {
    report.detail = `فشل الإدراج: ${(err as Error).message?.slice(0, 200) ?? String(err)}`;
    return;
  }

  const readBack = await readTestRow(TEST_RECORD_ID, currentUser.id);
  if (!readBack) {
    report.detail = 'فشل القراءة: لم يُعثر على السجل الذي أُدرج حديثًا.';
    return;
  }
  report.readBack = true;
  report.records.push(readBack);

  if (readBack.id !== TEST_RECORD_ID) {
    report.detail = 'فشل التحقق: المعرّف ليس مطابقًا.';
    return;
  }
  if (readBack.owner_id !== currentUser!.id) {
    report.detail = 'فشل التحقق: owner_id غير متطابق مع المستخدم المصادق.';
    return;
  }
  if (readBack.status !== 'written') {
    report.detail = 'فشل التحقق: الحالة غير متوقعة.';
    return;
  }
  report.verified = true;
  report.records.push({ ...readBack, status: 'verified', note: 'تم التحقق من القراءة والكتابة والمعرف والبيانات.' });

  try {
    await deleteTestRow(TEST_RECORD_ID, currentUser.id);
    report.deleted = true;
    report.records.push({ id: TEST_RECORD_ID, owner_id: currentUser!.id, run_at: readBack.run_at, status: 'deleted', note: 'تم حذف سجل الاختبار الذي أنشأه الاختبار فقط.' });
  } catch (err) {
    report.detail = `فشل الحذف: ${(err as Error).message?.slice(0, 200) ?? String(err)}`;
    return;
  }

  report.detail = 'الاختبار نجح: تم الكتابة والقراءة والتحقق والحذف داخل نفس حدود الاختبار، دون لمس accounts أو journal أو inventory أو بيانات QA.';
}

// =====================================================================
// تشغيل وتسجيل
// =====================================================================

run()
  .then(() => {
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
    console.log(JSON.stringify(report, null, 2));
  })
  .catch((err) => {
    report.detail = `فشل غير متوقع: ${(err as Error).message?.slice(0, 200) ?? String(err)}`;
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  });
