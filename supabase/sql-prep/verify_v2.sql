BEGIN;

CREATE TEMP TABLE IF NOT EXISTS _qa_verify (probe TEXT NOT NULL PRIMARY KEY, payload JSONB NOT NULL);
TRUNCATE _qa_verify;

-- لقطة قبل
INSERT INTO _qa_verify
SELECT 'before' AS probe, jsonb_build_object(
  'accounts', (SELECT count(*) FROM core.accounts),
  'account_mappings', (SELECT count(*) FROM core.account_mappings),
  'qa_accounts', (SELECT jsonb_agg(id ORDER BY id) FROM core.accounts WHERE id LIKE 'qa-%' OR code LIKE '%QA%'),
  'cash_treasury_mapping_id', (SELECT id FROM core.account_mappings WHERE key='cash_treasury' LIMIT 1),
  'cash_treasury_account_id', (SELECT account_id FROM core.account_mappings WHERE key='cash_treasury' LIMIT 1)
);

COMMIT;

-- تنفيذ ملف تحضير الحسابات (بعد الموافقة)
\i /tmp/sql_prep_v2.sql

BEGIN;

-- لقطة بعد
INSERT INTO _qa_verify
SELECT 'after' AS probe, jsonb_build_object(
  'accounts', (SELECT count(*) FROM core.accounts),
  'account_mappings', (SELECT count(*) FROM core.account_mappings),
  'qa_accounts', (SELECT jsonb_agg(id ORDER BY id) FROM core.accounts WHERE id LIKE 'qa-%' OR code LIKE '%QA%'),
  'cash_treasury_mapping_id', (SELECT id FROM core.account_mappings WHERE key='cash_treasury' LIMIT 1),
  'cash_treasury_account_id', (SELECT account_id FROM core.account_mappings WHERE key='cash_treasury' LIMIT 1),
  'orphan_mappings', (SELECT count(*) FROM core.account_mappings am LEFT JOIN core.accounts a ON a.id = am.account_id WHERE a.id IS NULL)
);

-- إرجاع أي تغيير لضمان عدم الكتابة finals
ROLLBACK;

SELECT probe, payload FROM _qa_verify ORDER BY probe;
