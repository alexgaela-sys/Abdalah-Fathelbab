-- =====================================================================
-- sql_prep_v2.sql
-- مقترح نقل دليل الحسابات الأصلي (من src/services/db.ts) إلى Supabase TEST
-- تنفيذي: لا تشغّل إلا بعد الموافقة ومراجعة التعارضات.
-- لا تشغّل على Production. الحسابات والـ mappings الموجودة لا تُحذف/تُعدّل.
-- cash_treasury يرتبط بـ acc-1101 صراحةً.
-- =====================================================================

-- ------------------------------------------------------------------------
-- أولاً: لقطة قراءية قبل التنفيذ (توثيق فقط)
-- ------------------------------------------------------------------------
-- SELECT
--   (SELECT count(*) FROM core.accounts)                AS accounts_before,
--   (SELECT count(*) FROM core.account_mappings)        AS mappings_before,
--   (SELECT array_agg(id ORDER BY id) FROM core.accounts WHERE id LIKE 'qa-%' OR code LIKE '%QA%') AS qa_accounts_before,
--   (SELECT account_id FROM core.account_mappings WHERE key = 'cash_treasury' LIMIT 1)           AS cash_treasury_account_id_before,
--   (SELECT id FROM core.account_mappings WHERE key = 'cash_treasury' LIMIT 1)                     AS cash_treasury_mapping_id_before;

-- ------------------------------------------------------------------------
-- ثانياً: إضافة الحسابات الأصلية مع الحفاظ على ما existe
-- ------------------------------------------------------------------------
INSERT INTO core.accounts
  (id, code, name_ar, name_en, category, is_header, parent_id, level, current_balance)
VALUES
  -- 1 الأصول (Assets)
  ('acc-1',      '1',     'الأصول',                 'Assets',                   'Assets',             true,  NULL,          1, 0),
  ('acc-11',     '11',    'الأصول المتداولة',       'Current Assets',           'Assets',             true,  'acc-1',       2, 0),
  ('acc-1101',   '1101',  'الخزينة الرئيسية النقدية','Main Cash Treasury',       'Assets',             false, 'acc-11',      3, 0),
  ('acc-1102',   '1102',  'بنك مصر - حساب جاري بالجنيه','Banque Misr - EGP',    'Assets',             false, 'acc-11',      3, 0),
  ('acc-1103',   '1103',  'البنك التجاري الدولي CIB - دولار','CIB - USD Account', 'Assets',         false, 'acc-11',      3, 0),
  ('acc-1104',   '1104',  'أوراق قبض (شيكات تحت التحصيل)','Cheques Under Collection','Assets',     false, 'acc-11',      3, 0),
  ('acc-1105',   '1105',  'عملاء تجاريون - محلي',   'Trade Receivables - Local', 'Assets',             false, 'acc-11',      3, 0),
  ('acc-1106',   '1106',  'عملاء تجاريون - تصدير (USD)','Trade Receivables - Export','Assets',        false, 'acc-11',      3, 0),
  ('acc-1107',   '1107',  'عهد مناديب المبيعات (بضائع ونقدية)','Sales Reps Custody','Assets',      false, 'acc-11',      3, 0),
  ('acc-1108',   '1108',  'مخزون المواد الخام ومواد التعبئة','Raw & Packaging Materials Inventory','Assets', false, 'acc-11',      3, 0),
  ('acc-1109',   '1109',  'مخزون الإنتاج التام - محلي','Finished Goods Inventory - Local','Assets',   false, 'acc-11',      3, 0),
  ('acc-1110',   '1110',  'مخزون الإنتاج التام - تصدير','Finished Goods Inventory - Export','Assets', false, 'acc-11',      3, 0),
  ('acc-1111',   '1111',  'مخزون التوالف والمعيب',   'Damaged Goods Inventory',  'Assets',             false, 'acc-11',      3, 0),
  ('acc-1112',   '1112',  'مخزون الهالك والسكراب',   'Scrap Inventory',          'Assets',             false, 'acc-11',      3, 0),
  ('acc-1113',   '1113',  'ضريبة القيمة المضافة - مدخلات ومشتريات','VAT Input Tax',    'Assets',             false, 'acc-11',      3, 0),
  ('acc-1114',   '1114',  'أصل ضريبة الخصم والتحصيل من المنبع','Withholding Tax Receivable','Assets',false, 'acc-11',      3, 0),

  -- 2 الخصوم (Liabilities)
  ('acc-2',      '2',     'الالتزامات والخصوم',     'Liabilities',              'Liabilities',         true,  NULL,          1, 0),
  ('acc-21',     '21',    'الالتزامات المتداولة',   'Current Liabilities',       'Liabilities',         true,  'acc-2',       2, 0),
  ('acc-2101',   '2101',  'موردو الخامات والتعبئة - محلي','Trade Payables - Local', 'Liabilities',      false, 'acc-21',      3, 0),
  ('acc-2102',   '2102',  'أوراق دفع (شيكات صادرة للدفع)','Cheques Payable',      'Liabilities',        false, 'acc-21',      3, 0),
  ('acc-2103',   '2103',  'ضريبة القيمة المضافة - مخرجات ومبيعات','VAT Output Tax',  'Liabilities',        false, 'acc-21',      3, 0),
  ('acc-2104',   '2104',  'مصروفات مستحقة ومخصصات', 'Accrued Expenses',         'Liabilities',         false, 'acc-21',      3, 0),

  -- 3 حقوق الملكية (Equity)
  ('acc-3',      '3',     'حقوق الملكية',          'Equity',                   'Equity',              true,  NULL,          1, 0),
  ('acc-3101',   '3101',  'رأس المال المصدر والمدفوع','Paid-in Capital',         'Equity',              false, 'acc-3',       2, 0),
  ('acc-3102',   '3102',  'الأرباح / الخسائر المرحلة','Retained Earnings',       'Equity',              false, 'acc-3',       2, 0),

  -- 4 الإيرادات (Revenue)
  ('acc-4',      '4',     'الإيرادات والمبيعات',    'Revenue',                  'Revenue',             true,  NULL,          1, 0),
  ('acc-4101',   '4101',  'إيراد مبيعات التجزئة المحلية','Retail Sales Revenue',   'Revenue',             false, 'acc-4',       2, 0),
  ('acc-4102',   '4102',  'إيراد مبيعات الجملة المحلية','Wholesale Sales Revenue', 'Revenue',           false, 'acc-4',       2, 0),
  ('acc-4103',   '4103',  'إيراد مبيعات التصدير (USD)','Export Sales Revenue',    'Revenue',             false, 'acc-4',       2, 0),
  ('acc-4104',   '4104',  'إيرادات بيع الهالك والسكراب','Scrap Sales Revenue',    'Revenue',             false, 'acc-4',       2, 0),
  ('acc-4105',   '4105',  'أرباح فروق أسعار العملات الأجنبية','Foreign Exchange Gain','Revenue',           false, 'acc-4',       2, 0),

  -- 5 تكلفة المبيعات والتصنيع (COGS & Variances)
  ('acc-5',      '5',     'تكلفة المبيعات وفروق التصنيع','Cost of Goods Sold',    'COGS',                true,  NULL,          1, 0),
  ('acc-5101',   '5101',  'تكلفة البضاعة المباعة - محلي','COGS - Local Market',   'COGS',                false, 'acc-5',       2, 0),
  ('acc-5102',   '5102',  'تكلفة البضاعة المباعة - تصدير','COGS - Export Market', 'COGS',                false, 'acc-5',       2, 0),
  ('acc-5103',   '5103',  'فروق أسعار شراء المواد (Price Variance)','Material Price Variance','COGS',false,'acc-5',    2, 0),
  ('acc-5104',   '5104',  'فروق كميات استهلاك المواد (Quantity Variance)','Material Quantity Variance','COGS',false,'acc-5',2,0),
  ('acc-5105',   '5105',  'فروق تكلفة العمالة المباشرة','Direct Labor Variance',  'COGS',                false, 'acc-5',       2, 0),
  ('acc-5106',   '5106',  'فروق تكلفة استهلاك الكهرباء','Electricity Variance',  'COGS',                false, 'acc-5',       2, 0),
  ('acc-5107',   '5107',  'فروق تكلفة استهلاك الغاز الطبيعي','Gas Variance',        'COGS',                false, 'acc-5',       2, 0),
  ('acc-5108',   '5108',  'فروق تكاليف الصيانة وقطع الغيار','Maintenance Variance', 'COGS',                false, 'acc-5',       2, 0),
  ('acc-5109',   '5109',  'فروق التكاليف الصناعية الإضافية','Manufacturing Overhead Variance','COGS',false,'acc-5',2,0),

  -- 6 المصروفات التشغيلية والبيعية (Operating Expenses)
  ('acc-6',      '6',     'المصروفات التشغيلية والعمومية','Operating Expenses',    'Operating Expenses',   true, NULL,          1, 0),
  ('acc-6101',   '6101',  'مصروفات الرواتب والأجور','Salaries and Wages',        'Operating Expenses',   false, 'acc-6',       2, 0),
  ('acc-6102',   '6102',  'مصروفات كهرباء ومياه المرافق العامة','Office Utilities','Operating Expenses',  false, 'acc-6',       2, 0),
  ('acc-6103',   '6103',  'مصروفات النقل والشحن والتوزيع الداخلي','Local Distribution & Freight','Operating Expenses',false,'acc-6',     2, 0),
  ('acc-6104',   '6104',  'مصروفات نولون وتخليص وموانئ التصدير','Export Shipping, Port & Customs','Operating Expenses',false,'acc-6',2,0),
  ('acc-6105',   '6105',  'مصروفات الدعاية والإعلان والترويج','Marketing & Promotion','Operating Expenses', false, 'acc-6',       2, 0),
  ('acc-6106',   '6106',  'عمولات ومصروفات مناديب المبيعات الميدانية','Sales Rep Expenses & Commissions','Operating Expenses',false,'acc-6',2,0),
  ('acc-6107',   '6107',  'مصروفات الصيانة العامة للمقرات والمعدات','General Maintenance','Operating Expenses',false,'acc-6',    2, 0),
  ('acc-6108',   '6108',  'إيجار المقرات والمستودعات','Facility Rent',             'Operating Expenses',   false, 'acc-6',       2, 0),
  ('acc-6109',   '6109',  'مصاريف وعمولات بنكية','Bank Charges & Fees',          'Operating Expenses',   false, 'acc-6',       2, 0),

  -- 7 بنود أخرى (Other Expenses)
  ('acc-7',      '7',     'المصروفات والخسائر الأخرى','Other Expenses',           'Other Expenses',       true, NULL,          1, 0),
  ('acc-7101',   '7101',  'خسائر فروق تقييم العملة الأجنبية','Foreign Exchange Loss','Other Expenses',     false, 'acc-7',       2, 0)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------------
-- ثالثاً: إضافة مفاتيح الربط الأصلية مع الحفاظ على ما existe
-- ------------------------------------------------------------------------
INSERT INTO core.account_mappings
  (id, key, name_ar, account_id)
VALUES
  -- المشتريات والذمم الدائنة
  ('map-purchase_raw_inventory',     'purchase_raw_inventory',     'مخزون المواد الخام ومواد التعبئة',           'acc-1108'),
  ('map-purchase_vat_input',         'purchase_vat_input',         'ضريبة القيمة المضافة - مدخلات ومشتريات',    'acc-1113'),
  ('map-supplier_payable',           'supplier_payable',           'موردو الخامات والتعبئة - محلي',            'acc-2101'),

  -- المبيعات والذمم المستحقة
  ('map-sales_retail_revenue',       'sales_retail_revenue',       'إيراد مبيعات التجزئة المحلية',             'acc-4101'),
  ('map-sales_wholesale_revenue',    'sales_wholesale_revenue',    'إيراد مبيعات الجملة المحلية',               'acc-4102'),
  ('map-sales_export_revenue',       'sales_export_revenue',       'إيراد مبيعات التصدير (USD)',                'acc-4103'),
  ('map-sales_vat_output',           'sales_vat_output',           'ضريبة القيمة المضافة - مخرجات ومبيعات',    'acc-2103'),
  ('map-customer_receivable_local',  'customer_receivable_local',  'عملاء تجاريون - محلي',                       'acc-1105'),
  ('map-customer_receivable_export', 'customer_receivable_export', 'عملاء تجاريون - تصدير (USD)',               'acc-1106'),
  ('map-cogs_local',                 'cogs_local',                 'تكلفة البضاعة المباعة - محلي',             'acc-5101'),
  ('map-cogs_export',                'cogs_export',                'تكلفة البضاعة المباعة - تصدير',            'acc-5102'),
  ('map-inventory_finished_local',   'inventory_finished_local',   'مخزون الإنتاج التام - محلي',                 'acc-1109'),
  ('map-inventory_finished_export',  'inventory_finished_export',  'مخزون الإنتاج التام - تصدير',               'acc-1110'),

  -- مناديب المبيعات
  ('map-rep_custody',                'rep_custody',                'عهد مناديب المبيعات (بضائع ونقدية)',       'acc-1107'),
  ('map-rep_custody_shortage',       'rep_custody_shortage',       'عمولات ومصروفات مناديب المبيعات الميدانية','acc-6106'),

  -- النقد والبنوك والشيكات
  ('map-cash_treasury',              'cash_treasury',              'الخزينة الرئيسية النقدية',                   'acc-1101'),
  ('map-bank_egp',                   'bank_egp',                   'بنك مصر - حساب جاري بالجنيه',              'acc-1102'),
  ('map-bank_usd',                   'bank_usd',                   'البنك التجاري الدولي CIB - دولار',         'acc-1103'),
  ('map-cheques_under_collection',   'cheques_under_collection',   'أوراق قبض (شيكات تحت التحصيل)',            'acc-1104'),
  ('map-cheques_payable',            'cheques_payable',            'أوراق دفع (شيكات صادرة للدفع)',             'acc-2102'),

  -- ضريبة الخصم والتحصيل من المنبع (F-WH)
  ('map-withholding_tax_receivable', 'withholding_tax_receivable', 'أصل ضريبة الخصم والتحصيل من المنبع',      'acc-1114'),

  -- الإنتاج والمخزون الإضافي
  ('map-inventory_damaged',          'inventory_damaged',          'مخزون التوالف والمعيب',                     'acc-1111'),
  ('map-inventory_scrap',            'inventory_scrap',            'مخزون الهالك والسكراب',                     'acc-1112'),
  ('map-scrap_sales_revenue',        'scrap_sales_revenue',        'إيرادات بيع الهالك والسكراب',               'acc-4104'),

  -- الفروقات
  ('map-variance_material_price',     'variance_material_price',     'فروق أسعار شراء المواد (Price Variance)',  'acc-5103'),
  ('map-variance_material_quantity',  'variance_material_quantity',  'فروق كميات استهلاك المواد (Quantity Variance)','acc-5104'),
  ('map-variance_direct_labor',       'variance_direct_labor',       'فروق تكلفة العمالة المباشرة',              'acc-5105'),
  ('map-variance_electricity',        'variance_electricity',        'فروق تكلفة استهلاك الكهرباء',              'acc-5106'),
  ('map-variance_gas',                'variance_gas',                'فروق تكلفة استهلاك الغاز الطبيعي',        'acc-5107'),
  ('map-variance_maintenance',        'variance_maintenance',        'فروق تكاليف الصيانة وقطع الغيار',         'acc-5108'),
  ('map-variance_overhead',           'variance_overhead',           'فروق التكاليف الصناعية الإضافية',          'acc-5109'),

  -- الفروقات الأجنبية
  ('map-fx_gain',                    'fx_gain',                    'أرباح فروق أسعار العملات الأجنبية',         'acc-4105'),
  ('map-fx_loss',                    'fx_loss',                    'خسائر فروق تقييم العملة الأجنبية',         'acc-7101'),

  -- المصروفات
  ('map-expenses_default',           'expenses_default',           'مصروفات الرواتب والأجور',                   'acc-6101'),
  ('map-conversion_cost_payable',    'conversion_cost_payable',    'مصروفات مستحقة ومخصصات',                   'acc-2104'),
  ('map-rep_expense',                'rep_expense',                'عمولات ومصروفات مناديب المبيعات الميدانية','acc-6106'),
  ('map-export_costs',               'export_costs',               'مصروفات نولون وتخليص وموانئ التصدير',    'acc-6104'),
  ('map-bank_fees',                  'bank_fees',                  'مصاريف وعمولات بنكية',                     'acc-6109'),
  ('map-export_costs_payable',       'export_costs_payable',       'مصروفات مستحقة ومخصصات',                   'acc-2104')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------------
-- رابعاً: التحقق البسيط بعد التنفيذ (قراءة فقط)
-- ------------------------------------------------------------------------
-- SELECT
--   (SELECT count(*) FROM core.accounts)                AS accounts_after,
--   (SELECT count(*) FROM core.account_mappings)        AS mappings_after,
--   (SELECT account_id FROM core.account_mappings WHERE key = 'cash_treasury' LIMIT 1)           AS cash_treasury_account_id_after,
--   (SELECT id FROM core.account_mappings WHERE key = 'cash_treasury' LIMIT 1)                     AS cash_treasury_mapping_id_after,
--   (SELECT count(*) FROM core.account_mappings am LEFT JOIN core.accounts a ON a.id = am.account_id WHERE a.id IS NULL) AS orphan_mappings,
--   (SELECT count(*) FROM core.accounts WHERE id LIKE 'qa-%' OR code LIKE '%QA%')                AS qa_accounts_after;
