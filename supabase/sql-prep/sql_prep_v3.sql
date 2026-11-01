-- =====================================================================
-- sql_prep_v3.sql
-- خطة تنفيذ واحدة لترحيل دليل الحسابات الأصلي (من src/services/db.ts)
-- إلى Supabase TEST فقط. مكتملة وذاتية وآمنة عند الفشل.
--
-- قرارات ثابتة:
--   - الحفاظ على أكواد وIDs الحسابات الأصلية قدر الإمكان.
--   - عدم حذف أو تعديل الحسابات الخمسة QA أو الخرائط السبعة الحالية.
--   - عدم لمس Production أو localStorage.
--   - cash_treasury должна أن تشير في المسار التشغيلي الأصلي إلى acc-1101.
--
-- الفصل المختار:
--   الحسابات والخرائط الأصلية تُضاف فقط إذا لم تكن هناك صفوف QA أو
--   خرائط QA تستخدم نفس code أو نفس key. هذا يحافظ علىQA ويعزل مسارها
--   الاختباري عن المسار الأصلي دون الحاجة لتعديل بنيوي في قاعدة البيانات.
--
-- السلامة:
--   - المعاملة ذرية BEGIN..COMMIT.
--   - كشف التعارضات داخل المعاملة قبل أي كتابة.
--   - cash_treasury الحالي يجب ألا يشير إلى حساب QA (خطأ صريح وإلا).
--   - إذا وُجد تعارض code أو key، السكريبت يُرجع خطأ ولا يكتب.
--   - كل صف original يُكتب فقط إذا لم يكن متحัดّدًا مع QA.
--
-- تنفيذي: لا تشغّل إلا بعد الموافقة ومراجعة verify_v3.sql.
-- =====================================================================

BEGIN;

-- ------------------------------------------------------------------------
-- إنشاء جدول مؤقت لتسجيل التعارضات التي يجب تجنبها
-- ------------------------------------------------------------------------
CREATE TEMP TABLE IF NOT EXISTS _prep_conflict (
  kind TEXT NOT NULL CHECK (kind IN ('account_code', 'mapping_key')),
  proposed TEXT NOT NULL,
  existing_id TEXT,
  existing_code TEXT,
  existing_key TEXT
);

TRUNCATE _prep_conflict;

-- ------------------------------------------------------------------------
-- 1) كشف تعارض code للحسابات (لا نكتب إذا كان code متعارضًا مع QA)
-- ------------------------------------------------------------------------
INSERT INTO _prep_conflict (kind, proposed, existing_id, existing_code)
SELECT 'account_code', ac.code, qa.id, qa.code
FROM (VALUES
  ('acc-1','1'), ('acc-11','11'),
  ('acc-1101','1101'), ('acc-1102','1102'), ('acc-1103','1103'),
  ('acc-1104','1104'), ('acc-1105','1105'), ('acc-1106','1106'),
  ('acc-1107','1107'), ('acc-1108','1108'), ('acc-1109','1109'),
  ('acc-1110','1110'), ('acc-1111','1111'), ('acc-1112','1112'),
  ('acc-1113','1113'), ('acc-1114','1114'),
  ('acc-2','2'), ('acc-21','21'),
  ('acc-2101','2101'), ('acc-2102','2102'), ('acc-2103','2103'),
  ('acc-2104','2104'),
  ('acc-3','3'), ('acc-3101','3101'), ('acc-3102','3102'),
  ('acc-4','4'),
  ('acc-4101','4101'), ('acc-4102','4102'), ('acc-4103','4103'),
  ('acc-4104','4104'), ('acc-4105','4105'),
  ('acc-5','5'),
  ('acc-5101','5101'), ('acc-5102','5102'), ('acc-5103','5103'),
  ('acc-5104','5104'), ('acc-5105','5105'), ('acc-5106','5106'),
  ('acc-5107','5107'), ('acc-5108','5108'), ('acc-5109','5109'),
  ('acc-6','6'),
  ('acc-6101','6101'), ('acc-6102','6102'), ('acc-6103','6103'),
  ('acc-6104','6104'), ('acc-6105','6105'), ('acc-6106','6106'),
  ('acc-6107','6107'), ('acc-6108','6108'), ('acc-6109','6109'),
  ('acc-7','7'), ('acc-7101','7101')
) AS ac(id, code)
JOIN core.accounts qa ON qa.code = ac.code AND qa.id LIKE 'qa-%'
LIMIT 1;

-- ------------------------------------------------------------------------
-- 2) كشف تعارض key للخرائط (لا نكتب إذا كان key متعارضًا مع QA)
-- ------------------------------------------------------------------------
INSERT INTO _prep_conflict (kind, proposed, existing_id, existing_key)
SELECT 'mapping_key', m.key, qa.id, qa.key
FROM (VALUES
  ('purchase_raw_inventory'), ('purchase_vat_input'), ('supplier_payable'),
  ('sales_retail_revenue'), ('sales_wholesale_revenue'), ('sales_export_revenue'),
  ('sales_vat_output'), ('customer_receivable_local'), ('customer_receivable_export'),
  ('cogs_local'), ('cogs_export'), ('inventory_finished_local'), ('inventory_finished_export'),
  ('rep_custody'), ('rep_custody_shortage'),
  ('cash_treasury'), ('bank_egp'), ('bank_usd'), ('cheques_under_collection'),
  ('cheques_payable'),
  ('withholding_tax_receivable'),
  ('inventory_damaged'), ('inventory_scrap'), ('scrap_sales_revenue'),
  ('variance_material_price'), ('variance_material_quantity'), ('variance_direct_labor'),
  ('variance_electricity'), ('variance_gas'), ('variance_maintenance'), ('variance_overhead'),
  ('fx_gain'), ('fx_loss'),
  ('expenses_default'), ('conversion_cost_payable'), ('rep_expense'),
  ('export_costs'), ('bank_fees'), ('export_costs_payable')
) AS m(key)
JOIN core.account_mappings qa ON qa.key = m.key AND (qa.id LIKE 'qa-%' OR qa.key LIKE 'qa_%' OR qa.key = 'qa_cogs')
LIMIT 1;

-- ------------------------------------------------------------------------
-- 3)_cash_treasury الحالي لا يجوز أن يشير إلى حساب QA
-- ------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM core.account_mappings
    WHERE key = 'cash_treasury'
      AND account_id IN (SELECT id FROM core.accounts WHERE id LIKE 'qa-%')
  ) THEN
    RAISE EXCEPTION 'cash_treasury الحالي يشير إلى حساب QA (%): يجب تعديله صراحةً قبل التنفيذ',
      (SELECT account_id FROM core.account_mappings WHERE key='cash_treasury' LIMIT 1);
  END IF;
END $$;

-- ------------------------------------------------------------------------
-- 4) إذا تعذّر الفصل (تعارضات موجودة)، نوقف التنفيذ بخطأ صريح
-- ------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM _prep_conflict WHERE kind = 'account_code') THEN
    RAISE EXCEPTION 'توجد حسابات أصلية تتعارضコード مع QA (%): يُرجى حل التعارض قبل التنفيذ',
      (SELECT string_agg(DISTINCT proposed, ', ') FROM _prep_conflict WHERE kind = 'account_code');
  END IF;
  IF EXISTS (SELECT 1 FROM _prep_conflict WHERE kind = 'mapping_key') THEN
    RAISE EXCEPTION 'توجد خرائط أصلية تتعارض key مع QA (%): يُرجى حل التعارض قبل التنفيذ',
      (SELECT string_agg(DISTINCT proposed, ', ') FROM _prep_conflict WHERE kind = 'mapping_key');
  END IF;
END $$;

-- ------------------------------------------------------------------------
-- 5) إدراج الحسابات الأصلية (فقط غير المتعارضة)
-- ------------------------------------------------------------------------
INSERT INTO core.accounts
  (id, code, name_ar, name_en, category, is_header, parent_id, level, current_balance)
SELECT v.id, v.code, v.name_ar, v.name_en, v.category, v.is_header, v.parent_id, v.level, v.current_balance
FROM (VALUES
  -- 1 الأصول
  ('acc-1','1','الأصول','Assets','Assets',true,NULL,1,0),
  ('acc-11','11','الأصول المتداولة','Current Assets','Assets',true,'acc-1',2,0),
  ('acc-1101','1101','الخزينة الرئيسية النقدية','Main Cash Treasury','Assets',false,'acc-11',3,0),
  ('acc-1102','1102','بنك مصر - حساب جاري بالجنيه','Banque Misr - EGP','Assets',false,'acc-11',3,0),
  ('acc-1103','1103','البنك التجاري الدولي CIB - دولار','CIB - USD Account','Assets',false,'acc-11',3,0),
  ('acc-1104','1104','أوراق قبض (شيكات تحت التحصيل)','Cheques Under Collection','Assets',false,'acc-11',3,0),
  ('acc-1105','1105','عملاء تجاريون - محلي','Trade Receivables - Local','Assets',false,'acc-11',3,0),
  ('acc-1106','1106','عملاء تجاريون - تصدير (USD)','Trade Receivables - Export','Assets',false,'acc-11',3,0),
  ('acc-1107','1107','عهد مناديب المبيعات (بضائع ونقدية)','Sales Reps Custody','Assets',false,'acc-11',3,0),
  ('acc-1108','1108','مخزون المواد الخام ومواد التعبئة','Raw & Packaging Materials Inventory','Assets',false,'acc-11',3,0),
  ('acc-1109','1109','مخزون الإنتاج التام - محلي','Finished Goods Inventory - Local','Assets',false,'acc-11',3,0),
  ('acc-1110','1110','مخزون الإنتاج التام - تصدير','Finished Goods Inventory - Export','Assets',false,'acc-11',3,0),
  ('acc-1111','1111','مخزون التوالف والمعيب','Damaged Goods Inventory','Assets',false,'acc-11',3,0),
  ('acc-1112','1112','مخزون الهالك والسكراب','Scrap Inventory','Assets',false,'acc-11',3,0),
  ('acc-1113','1113','ضريبة القيمة المضافة - مدخلات ومشتريات','VAT Input Tax','Assets',false,'acc-11',3,0),
  ('acc-1114','1114','أصل ضريبة الخصم والتحصيل من المنبع','Withholding Tax Receivable','Assets',false,'acc-11',3,0),
  -- 2 الخصوم
  ('acc-2','2','الالتزامات والخصوم','Liabilities','Liabilities',true,NULL,1,0),
  ('acc-21','21','الالتزامات المتداولة','Current Liabilities','Liabilities',true,'acc-2',2,0),
  ('acc-2101','2101','موردو الخامات والتعبئة - محلي','Trade Payables - Local','Liabilities',false,'acc-21',3,0),
  ('acc-2102','2102','أوراق دفع (شيكات صادرة للدفع)','Cheques Payable','Liabilities',false,'acc-21',3,0),
  ('acc-2103','2103','ضريبة القيمة المضافة - مخرجات ومبيعات','VAT Output Tax','Liabilities',false,'acc-21',3,0),
  ('acc-2104','2104','مصروفات مستحقة ومخصصات','Accrued Expenses','Liabilities',false,'acc-21',3,0),
  -- 3 حقوق الملكية
  ('acc-3','3','حقوق الملكية','Equity','Equity',true,NULL,1,0),
  ('acc-3101','3101','رأس المال المصدر والمدفوع','Paid-in Capital','Equity',false,'acc-3',2,0),
  ('acc-3102','3102','الأرباح / الخسائر المرحلة','Retained Earnings','Equity',false,'acc-3',2,0),
  -- 4 الإيرادات
  ('acc-4','4','الإيرادات والمبيعات','Revenue','Revenue',true,NULL,1,0),
  ('acc-4101','4101','إيراد مبيعات التجزئة المحلية','Retail Sales Revenue','Revenue',false,'acc-4',2,0),
  ('acc-4102','4102','إيراد مبيعات الجملة المحلية','Wholesale Sales Revenue','Revenue',false,'acc-4',2,0),
  ('acc-4103','4103','إيراد مبيعات التصدير (USD)','Export Sales Revenue','Revenue',false,'acc-4',2,0),
  ('acc-4104','4104','إيرادات بيع الهالك والسكراب','Scrap Sales Revenue','Revenue',false,'acc-4',2,0),
  ('acc-4105','4105','أرباح فروق أسعار العملات الأجنبية','Foreign Exchange Gain','Revenue',false,'acc-4',2,0),
  -- 5 تكلفة المبيعات والتصنيع
  ('acc-5','5','تكلفة المبيعات وفروق التصنيع','Cost of Goods Sold','COGS',true,NULL,1,0),
  ('acc-5101','5101','تكلفة البضاعة المباعة - محلي','COGS - Local Market','COGS',false,'acc-5',2,0),
  ('acc-5102','5102','تكلفة البضاعة المباعة - تصدير','COGS - Export Market','COGS',false,'acc-5',2,0),
  ('acc-5103','5103','فروق أسعار شراء المواد (Price Variance)','Material Price Variance','COGS',false,'acc-5',2,0),
  ('acc-5104','5104','فروق كميات استهلاك المواد (Quantity Variance)','Material Quantity Variance','COGS',false,'acc-5',2,0),
  ('acc-5105','5105','فروق تكلفة العمالة المباشرة','Direct Labor Variance','COGS',false,'acc-5',2,0),
  ('acc-5106','5106','فروق تكلفة استهلاك الكهرباء','Electricity Variance','COGS',false,'acc-5',2,0),
  ('acc-5107','5107','فروق تكلفة استهلاك الغاز الطبيعي','Gas Variance','COGS',false,'acc-5',2,0),
  ('acc-5108','5108','فروق تكاليف الصيانة وقطع الغيار','Maintenance Variance','COGS',false,'acc-5',2,0),
  ('acc-5109','5109','فروق التكاليف الصناعية الإضافية','Manufacturing Overhead Variance','COGS',false,'acc-5',2,0),
  -- 6 المصروفات التشغيلية والبيعية
  ('acc-6','6','المصروفات التشغيلية والعمومية','Operating Expenses','Operating Expenses',true,NULL,1,0),
  ('acc-6101','6101','مصروفات الرواتب والأجور','Salaries and Wages','Operating Expenses',false,'acc-6',2,0),
  ('acc-6102','6102','مصروفات كهرباء ومياه المرافق العامة','Office Utilities','Operating Expenses',false,'acc-6',2,0),
  ('acc-6103','6103','مصروفات النقل والشحن والتوزيع الداخلي','Local Distribution & Freight','Operating Expenses',false,'acc-6',2,0),
  ('acc-6104','6104','مصروفات نولون وتخليص وموانئ التصدير','Export Shipping, Port & Customs','Operating Expenses',false,'acc-6',2,0),
  ('acc-6105','6105','مصروفات الدعاية والإعلان والترويج','Marketing & Promotion','Operating Expenses',false,'acc-6',2,0),
  ('acc-6106','6106','عمولات ومصروفات مناديب المبيعات الميدانية','Sales Rep Expenses & Commissions','Operating Expenses',false,'acc-6',2,0),
  ('acc-6107','6107','مصروفات الصيانة العامة للمقرات والمعدات','General Maintenance','Operating Expenses',false,'acc-6',2,0),
  ('acc-6108','6108','إيجار المقرات والمستودعات','Facility Rent','Operating Expenses',false,'acc-6',2,0),
  ('acc-6109','6109','مصاريف وعمولات بنكية','Bank Charges & Fees','Operating Expenses',false,'acc-6',2,0),
  -- 7 بنود أخرى
  ('acc-7','7','المصروفات والخسائر الأخرى','Other Expenses','Other Expenses',true,NULL,1,0),
  ('acc-7101','7101','خسائر فروق تقييم العملة الأجنبية','Foreign Exchange Loss','Other Expenses',false,'acc-7',2,0)
) AS v(id, code, name_ar, name_en, category, is_header, parent_id, level, current_balance)
WHERE NOT EXISTS (SELECT 1 FROM _prep_conflict c WHERE c.kind = 'account_code' AND c.proposed = v.code);

-- ------------------------------------------------------------------------
-- 6) إدراج mappings الأصلية (فقط غير المتعارضة)
-- ------------------------------------------------------------------------
INSERT INTO core.account_mappings
  (id, key, name_ar, account_id)
SELECT v.id, v.key, v.name_ar, v.account_id
FROM (VALUES
  ('map-purchase_raw_inventory','purchase_raw_inventory','مخزون المواد الخام ومواد التعبئة','acc-1108'),
  ('map-purchase_vat_input','purchase_vat_input','ضريبة القيمة المضافة - مدخلات ومشتريات','acc-1113'),
  ('map-supplier_payable','supplier_payable','موردو الخامات والتعبئة - محلي','acc-2101'),
  ('map-sales_retail_revenue','sales_retail_revenue','إيراد مبيعات التجزئة المحلية','acc-4101'),
  ('map-sales_wholesale_revenue','sales_wholesale_revenue','إيراد مبيعات الجملة المحلية','acc-4102'),
  ('map-sales_export_revenue','sales_export_revenue','إيراد مبيعات التصدير (USD)','acc-4103'),
  ('map-sales_vat_output','sales_vat_output','ضريبة القيمة المضافة - مخرجات ومبيعات','acc-2103'),
  ('map-customer_receivable_local','customer_receivable_local','عملاء تجاريون - محلي','acc-1105'),
  ('map-customer_receivable_export','customer_receivable_export','عملاء تجاريون - تصدير (USD)','acc-1106'),
  ('map-cogs_local','cogs_local','تكلفة البضاعة المباعة - محلي','acc-5101'),
  ('map-cogs_export','cogs_export','تكلفة البضاعة المباعة - تصدير','acc-5102'),
  ('map-inventory_finished_local','inventory_finished_local','مخزون الإنتاج التام - محلي','acc-1109'),
  ('map-inventory_finished_export','inventory_finished_export','مخزون الإنتاج التام - تصدير','acc-1110'),
  ('map-rep_custody','rep_custody','عهد مناديب المبيعات (بضائع ونقدية)','acc-1107'),
  ('map-rep_custody_shortage','rep_custody_shortage','عمولات ومصروفات مناديب المبيعات الميدانية','acc-6106'),
  ('map-cash_treasury','cash_treasury','الخزينة الرئيسية النقدية','acc-1101'),
  ('map-bank_egp','bank_egp','بنك مصر - حساب جاري بالجنيه','acc-1102'),
  ('map-bank_usd','bank_usd','البنك التجاري الدولي CIB - دولار','acc-1103'),
  ('map-cheques_under_collection','cheques_under_collection','أوراق قبض (شيكات تحت التحصيل)','acc-1104'),
  ('map-cheques_payable','cheques_payable','أوراق دفع (شيكات صادرة للدفع)','acc-2102'),
  ('map-withholding_tax_receivable','withholding_tax_receivable','أصل ضريبة الخصم والتحصيل من المنبع','acc-1114'),
  ('map-inventory_damaged','inventory_damaged','مخزون التوالف والمعيب','acc-1111'),
  ('map-inventory_scrap','inventory_scrap','مخزون الهالك والسكراب','acc-1112'),
  ('map-scrap_sales_revenue','scrap_sales_revenue','إيرادات بيع الهالك والسكراب','acc-4104'),
  ('map-variance_material_price','variance_material_price','فروق أسعار شراء المواد (Price Variance)','acc-5103'),
  ('map-variance_material_quantity','variance_material_quantity','فروق كميات استهلاك المواد (Quantity Variance)','acc-5104'),
  ('map-variance_direct_labor','variance_direct_labor','فروق تكلفة العمالة المباشرة','acc-5105'),
  ('map-variance_electricity','variance_electricity','فروق تكلفة استهلاك الكهرباء','acc-5106'),
  ('map-variance_gas','variance_gas','فروق تكلفة استهلاك الغاز الطبيعي','acc-5107'),
  ('map-variance_maintenance','variance_maintenance','فروق تكاليف الصيانة وقطع الغيار','acc-5108'),
  ('map-variance_overhead','variance_overhead','فروق التكاليف الصناعية الإضافية','acc-5109'),
  ('map-fx_gain','fx_gain','أرباح فروق أسعار العملات الأجنبية','acc-4105'),
  ('map-fx_loss','fx_loss','خسائر فروق تقييم العملة الأجنبية','acc-7101'),
  ('map-expenses_default','expenses_default','مصروفات الرواتب والأجور','acc-6101'),
  ('map-conversion_cost_payable','conversion_cost_payable','مصروفات مستحقة ومخصصات','acc-2104'),
  ('map-rep_expense','rep_expense','عمولات ومصروفات مناديب المبيعات الميدانية','acc-6106'),
  ('map-export_costs','export_costs','مصروفات نولون وتخليص وموانئ التصدير','acc-6104'),
  ('map-bank_fees','bank_fees','مصاريف وعمولات بنكية','acc-6109'),
  ('map-export_costs_payable','export_costs_payable','مصروفات مستحقة ومخصصات','acc-2104')
) AS v(id, key, name_ar, account_id)
WHERE NOT EXISTS (SELECT 1 FROM _prep_conflict c WHERE c.kind = 'mapping_key' AND c.proposed = v.key);

COMMIT;

-- ------------------------------------------------------------------------
-- التوثيع النهائي (قراءة فقط بعد التنفيذ المحتمل)
-- ------------------------------------------------------------------------
-- SELECT
--   (SELECT count(*) FROM core.accounts) AS accounts_after,
--   (SELECT count(*) FROM core.account_mappings) AS mappings_after,
--   (SELECT account_id FROM core.account_mappings WHERE key='cash_treasury' LIMIT 1) AS cash_treasury_account_id_after,
--   (SELECT array_agg(id ORDER BY id) FROM core.accounts WHERE id LIKE 'qa-%' OR code LIKE '%QA%') AS qa_accounts_after,
--   (SELECT array_agg(id ORDER BY id) FROM core.account_mappings WHERE id LIKE 'qa-%' OR key LIKE 'qa_%' OR key='qa_cogs') AS qa_mappings_after;
