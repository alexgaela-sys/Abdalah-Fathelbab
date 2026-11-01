-- =====================================================================
-- verify_v3.sql
-- تحقق صريح من التعارضات وcash_treasury وجميع mappings قبل التنفيذ الفعلي.
-- متسقة مع sql_prep_v3.sql. لا يُنفّذ أي INSERT/UPDATE/DELETE.
-- =====================================================================

BEGIN;
CREATE TEMP TABLE IF NOT EXISTS _verify_checks (
  check_name TEXT PRIMARY KEY,
  passed BOOLEAN NOT NULL,
  detail TEXT
);
TRUNCATE _verify_checks;

-- 1) الحسابات QA الخمسة موجودة ولا تُعدَّل (قبل التنفيذ)
INSERT INTO _verify_checks
SELECT 'qa_accounts_preserved',
  (SELECT count(*) FROM core.accounts WHERE id LIKE 'qa-%' OR code LIKE '%QA%') = 5,
  'الحسابات QA الخمسة يجب أن تكون موجودة وغير متغيرة';

-- 2) مappings QA السبعة موجودة ولا تُعدَّل (قبل التنفيذ)
INSERT INTO _verify_checks
SELECT 'qa_mappings_preserved',
  (SELECT count(*) FROM core.account_mappings WHERE id LIKE 'qa-%' OR key LIKE 'qa_%' OR key='qa_cogs') = 7,
  'الخرائط QA السبعة يجب أن تكون موجودة وغير متغيرة';

-- 3) cash_treasury الحالي لا يشير إلى حساب QA (مرفوض في المسار الأصلي)
INSERT INTO _verify_checks
SELECT 'cash_treasury_target_safe',
  NOT EXISTS (
    SELECT 1 FROM core.account_mappings
    WHERE key='cash_treasury'
      AND account_id IN (SELECT id FROM core.accounts WHERE id LIKE 'qa-%')
  ),
  'cash_treasury يجب ألا يشير إلى حساب QA';

-- 4) لا توجد حسابات غير QA تتعارض code مع QA
INSERT INTO _verify_checks
SELECT 'no_code_conflict_non_qa',
  NOT EXISTS (
    SELECT 1 FROM core.accounts a
    WHERE a.id NOT LIKE 'qa-%'
      AND a.code IN (
        SELECT code FROM core.accounts qa WHERE qa.id LIKE 'qa-%'
      )
  ),
  'لا يجوز أن يكون هناك حساب غير QA بنفس code مع QA';

-- 5) لا توجد خرائط غير QA تتعارض key مع QA
INSERT INTO _verify_checks
SELECT 'no_key_conflict_non_qa',
  NOT EXISTS (
    SELECT 1 FROM core.account_mappings m
    WHERE m.id NOT LIKE 'qa-%'
      AND m.key IN (
        SELECT key FROM core.account_mappings qa
        WHERE qa.id LIKE 'qa-%' OR qa.key LIKE 'qa_%' OR qa.key='qa_cogs'
      )
  ),
  'لا يجوز أن تكون هناك خريطة غير QA بنفس key مع QA';

-- 6) الكودف المقترحة فريدة داخليًا ( dentro من القائمة الأصلية)
INSERT INTO _verify_checks
SELECT 'proposed_codes_unique',
  CASE WHEN EXISTS (
    SELECT 1 FROM (
      VALUES
        ('1'),('11'),('1101'),('1102'),('1103'),('1104'),('1105'),('1106'),
        ('1107'),('1108'),('1109'),('1110'),('1111'),('1112'),('1113'),('1114'),
        ('2'),('21'),('2101'),('2102'),('2103'),('2104'),
        ('3'),('3101'),('3102'),
        ('4'),('4101'),('4102'),('4103'),('4104'),('4105'),
        ('5'),('5101'),('5102'),('5103'),('5104'),('5105'),('5106'),('5107'),
        ('5108'),('5109'),
        ('6'),('6101'),('6102'),('6103'),('6104'),('6105'),('6106'),('6107'),
        ('6108'),('6109'),
        ('7'),('7101')
    ) AS v(code)
    GROUP BY v.code HAVING count(*) > 1
  ) THEN FALSE ELSE TRUE END,
  'كل الكودف المقترحة فريدة داخليًا';

-- 7) المفاتيح المقترحة فريدة داخليًا (داخل القائمة الأصلية)
INSERT INTO _verify_checks
SELECT 'proposed_keys_unique',
  CASE WHEN EXISTS (
    SELECT 1 FROM (
      VALUES
        ('purchase_raw_inventory'),('purchase_vat_input'),('supplier_payable'),
        ('sales_retail_revenue'),('sales_wholesale_revenue'),('sales_export_revenue'),
        ('sales_vat_output'),('customer_receivable_local'),('customer_receivable_export'),
        ('cogs_local'),('cogs_export'),('inventory_finished_local'),('inventory_finished_export'),
        ('rep_custody'),('rep_custody_shortage'),
        ('cash_treasury'),('bank_egp'),('bank_usd'),('cheques_under_collection'),
        ('cheques_payable'),
        ('withholding_tax_receivable'),
        ('inventory_damaged'),('inventory_scrap'),('scrap_sales_revenue'),
        ('variance_material_price'),('variance_material_quantity'),('variance_direct_labor'),
        ('variance_electricity'),('variance_gas'),('variance_maintenance'),('variance_overhead'),
        ('fx_gain'),('fx_loss'),
        ('expenses_default'),('conversion_cost_payable'),('rep_expense'),
        ('export_costs'),('bank_fees'),('export_costs_payable')
    ) AS v(key)
    GROUP BY v.key HAVING count(*) > 1
  ) THEN FALSE ELSE TRUE END,
  'كل المفاتيح المقترحة فريدة داخليًا';

COMMIT;

SELECT check_name, passed, detail
FROM _verify_checks
ORDER BY check_name;

ROLLBACK;
