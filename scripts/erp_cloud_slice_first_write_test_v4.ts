// =====================================================================
// erp_cloud_slice_first_write_test_v4.ts
// =====================================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function envValue(name: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_ANON_KEY'): string {
  const env = process.env as unknown as Record<string, string | undefined>;
  return (env[name] || '').trim();
}

function configured(): boolean {
  return envValue('VITE_SUPABASE_URL').length > 0 && envValue('VITE_SUPABASE_ANON_KEY').length > 0;
}

const client: SupabaseClient = createClient(
  envValue('VITE_SUPABASE_URL'),
  envValue('VITE_SUPABASE_ANON_KEY'),
  {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: 'public' },
  },
);

const TEST_TABLE = 'erp_cloud_first_slice_tests_v4';
const TEST_RECORD_ID = `erp_slice_01_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const REPORT_PATH = join(process.cwd(), 'tmp', 'erp_cloud_slice_first_write_test_v4.json');

type TestCaseRow = {
  id: string;
  run_at: string;
  status: 'written' | 'read_back' | 'verified' | 'deleted';
  note: string;
};

async function createTestTableIfMissing(): Promise<boolean> {
  const { error: createError } = await client.rpc('erp_cloud_create_test_table', {
    p_table_name: TEST_TABLE,
  });
  if (createError) {
    throw new Error(`فشل إنشاء جدول الاختبار: ${createError.message}`);
  }
  return true;
}

async function insertTestRow(row: TestCaseRow): Promise<void> {
  const { error } = await client.from(TEST_TABLE).insert(row);
  if (error) {
    throw new Error(`فشل الإدراج في جدول الاختبار: ${error.message}`);
  }
}

async function readTestRow(id: string): Promise<TestCaseRow | null> {
  const { data, error } = await client.from(TEST_TABLE).select('*').eq('id', id).single();
  if (error && error.code !== 'PGRST116') {
    throw new Error(`فشل القراءة من جدول الاختبار: ${error.message}`);
  }
  return (data as TestCaseRow) ?? null;
}

async function deleteTestRow(id: string): Promise<void> {
  const { error } = await client.from(TEST_TABLE).delete().eq('id', id);
  if (error) {
    throw new Error(`فشل الحذف من جدول الاختبار: ${error.message}`);
  }
}

let report: {
  prepared: boolean;
  configured: boolean;
  table_available: boolean | null;
  inserted: boolean;
  read_back: boolean;
  verified: boolean;
  deleted: boolean;
  detail: string;
  records: TestCaseRow[];
} = {
  prepared: true,
  configured: configured(),
  table_available: null,
  inserted: false,
  read_back: false,
  verified: false,
  deleted: false,
  detail: '',
  records: [],
};

async function run(): Promise<void> {
  if (!report.configured) {
    report.detail = 'بيئة TEST غير مُثبتة: VITE_SUPABASE_URL أو VITE_SUPABASE_ANON_KEY غير مُضبَطين. لا يتم إنشاء أي كتابة.';
    return;
  }

  mkdirSync(join(process.cwd(), 'tmp'), { recursive: true });

  try {
    await createTestTableIfMissing();
    report.table_available = true;
  } catch (err) {
    report.table_available = false;
    report.detail = `مانع حقيقي: لا يمكن إنشاء جدول الاختبار أو الوصول إليه: ${(err as Error).message}`;
    return;
  }

  const row: TestCaseRow = {
    id: TEST_RECORD_ID,
    run_at: new Date().toISOString(),
    status: 'written',
    note: 'سجل اختبار First Cloud Slice — ERP Cloud PoC',
  };

  try {
    await insertTestRow(row);
    report.inserted = true;
    report.records.push(row);
  } catch (err) {
    report.detail = `فشل الإدراج: ${(err as Error).message}`;
    return;
  }

  const readBack = await readTestRow(TEST_RECORD_ID);
  if (!readBack) {
    report.detail = 'فشل القراءة: لم يُعثر على السجل الذي أُدرج حديثًا.';
    return;
  }
  report.read_back = true;
  report.records.push(readBack);

  if (readBack.id !== TEST_RECORD_ID) {
    report.detail = 'فشل التحقق: المعرّف ليس مطابقًا.';
    return;
  }
  if (readBack.status !== 'written') {
    report.detail = 'فشل التحقق: الحالة غير متوقعة.';
    return;
  }
  report.verified = true;
  report.records.push({ ...readBack, status: 'verified', note: 'تم التحقق من القراءة والكتابة والمعرف والبيانات.' });

  try {
    await deleteTestRow(TEST_RECORD_ID);
    report.deleted = true;
    report.records.push({ id: TEST_RECORD_ID, run_at: readBack.run_at, status: 'deleted', note: 'تم حذف سجل الاختبار الذي أنشأه الاختبار فقط.' });
  } catch (err) {
    report.detail = `فشل الحذف: ${(err as Error).message}`;
    return;
  }

  report.detail = 'الاختبار نجح: تم الكتابة والقراءة والتحقق والحذف داخل نفس حدود الاختبار، دون لمس accounts أو journal أو inventory أو بيانات QA.';
}

run()
  .then(() => {
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
    console.log(JSON.stringify(report, null, 2));
  })
  .catch((err) => {
    report.detail = `فشل غير متوقع: ${(err as Error).message}`;
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  });
