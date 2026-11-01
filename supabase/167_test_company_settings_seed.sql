-- =====================================================================
-- 167_test_company_settings_seed.sql — TEST company identity + settings
--
-- core.companies and core.app_settings were EMPTY in TEST, so the cloud
-- settings screen (and any document header) had nothing to read. This seeds
-- exactly one row of each, with the documented company identity and the same
-- defaults the local build ships (expiry warning = 10 days, default invoice
-- template). Presentation/config only — no accounting, inventory or business
-- document is created, and no mapping is invented.
--
-- Idempotent: inserts only when the table is empty; never updates or deletes.
-- TEST only. Never run against production.
-- =====================================================================

begin;

insert into core.companies
  (id, code, name_ar, name_en, tax_number, commercial_register, address, phone,
   base_currency, export_currency, current_usd_exchange_rate, email, website,
   contact_name, contact_phone)
select 'qa-company-01',
       'ABD-EG',
       'شركة عبد الله للصناعات الغذائية (ش.م.م)',
       'Abdullah Food Industries (S.A.E.)',
       null,
       null,
       'بيئة اختبار — TEST',
       null,
       'EGP',
       'USD',
       50,
       null,
       null,
       'QA TEST',
       null
 where not exists (select 1 from core.companies);

insert into core.app_settings (id, expiry_warning_days, invoice_template)
select 'qa-settings-01',
       10,
       '{
         "showLogo": true,
         "logoDataUrl": "",
         "headerTextAr": "",
         "headerTextEn": "",
         "footerText": "شكرًا لتعاملكم معنا — هذه الفاتورة صادرة إلكترونيًا من نظام الحسابات.",
         "showTaxNumber": true,
         "showAddress": true,
         "showPhone": true,
         "showEmail": false,
         "showCustomerTax": true,
         "showWarehouse": true,
         "showWithholding": true,
         "showNetDue": true,
         "netDueLabel": "صافي المستحق بعد الضرائب والاستقطاعات",
         "accentColor": "#0f172a",
         "textColor": "#0f172a",
         "titleFontSize": 20,
         "bodyFontSize": 12,
         "tableFontSize": 12,
         "alignment": "center",
         "showAccentBar": true
       }'::jsonb
 where not exists (select 1 from core.app_settings);

commit;
