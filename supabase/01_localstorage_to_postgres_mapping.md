# خريطة الترحيل: localStorage → PostgreSQL (Supabase TEST)

مرجع مقابل لكل كيان في النظام المحلي. المصدر: `src/services/db.ts`
(`ERPDatabaseSchema`) و`src/types/erp.ts`. كل جدول هنا منشأ فعليًا في
`supabase/migrations/` — لا تخمين.

## 1) مفاتيح localStorage

| المفتاح | المحتوى | بعد الترحيل |
|---|---|---|
| `abdullah_erp_db_v1` | الشجرة الكاملة لقاعدة بيانات ERP (`ERPDatabaseSchema`) | يُقرأ مرة واحدة للترحيل، ثم يبقى كما هو (بلا تغيير ولا حذف) |
| `abdullah_erp_auth_session` | جلسة مستخدم محلي (`src/services/auth.ts`) | تبقى للوضع المحلي؛ الوضع السحابي يستخدم Supabase Auth بجلسة في الذاكرة فقط (`persistSession: false`) |
| `snakdip_erp_active_tab` | آخر تبويب مفتوح (واجهة فقط) | لا تُرحَّل (حالة عرض) |

قواعد ثابتة: الترحيل **يقرأ فقط** من localStorage. لا حذف، لا إعادة تهيئة،
ولا كتابة فوق أسعار أو أرصدة يدوية موجودة.

## 2) خريطة الكيانات

العمود «المفتاح المحلي» = اسم المجموعة داخل `abdullah_erp_db_v1`.

| # | الكيان (TypeScript) | المفتاح المحلي | الجدول في Postgres | العلاقات الرئيسية |
|---|---|---|---|---|
| 1 | `Company` | `company` | `core.companies` | singleton |
| 2 | `Warehouse` | `warehouses` | `core.warehouses` | `manager_user_id` → `core.app_profiles.id` |
| 3 | `Unit` | `units` | `core.units` | — |
| 4 | `UnitConversion` | `unitConversions` | `core.unit_conversions` | `from/to_unit_id` → `core.units` |
| 5 | `Item` | `items` | `core.items` | `base_unit_id`, `purchase_unit_id` → `core.units` |
| 6 | `Batch` | `batches` | `inventory.batches` | `item_id` → `core.items`, `warehouse_id` → `core.warehouses` |
| 7 | `BomHeader` | `boms` | `production.boms` | `finished_item_id` → `core.items` |
| 8 | `BomLine` | `bomLines` | `production.bom_lines` | `bom_id` → `production.boms` (cascade) |
| 9 | `ProductionOrder` | `productionOrders` | `production.orders` | `product_id`, `bom_id`, `destination_warehouse_id` |
| 10 | `ProductionConsumption` | `productionConsumptions` | `production.consumptions` | `production_order_id` (cascade), `material_item_id` |
| 11 | `ProductionWaste` | `productionWastes` | `production.wastes` | `production_order_id` (cascade) |
| 12 | `QualityInspection` | `qualityInspections` | `quality.inspections` | `item_id`, `destination_warehouse_id` |
| 13 | `Customer` | `customers` | `core.customers` | `code` فريد |
| 14 | `Supplier` | `suppliers` | `core.suppliers` | `code` فريد |
| 15 | `SalesRepresentative` | `salesReps` | `core.sales_reps` | `code` فريد |
| 16 | `RepresentativeCustody` | `representativeCustodies` | `core.rep_custody` | `rep_id` → `core.sales_reps` |
| 17 | `CustodyMovement` | `custodyMovements` | `core.custody_movements` | `custody_id` → `core.rep_custody` |
| 18 | `SalesInvoice` | `salesInvoices` | `sales.invoices` | `customer_id`, `warehouse_id`, `rep_id`, `custody_id`, `journal_entry_id`, `export_shipment_id` |
| 19 | `SalesInvoiceLine` | `salesInvoiceLines` | `sales.invoice_lines` | `invoice_id` (cascade), `item_id`, `batch_id` |
| 20 | `SalesReturn` | `salesReturns` | `sales.returns` | `invoice_id`, `customer_id`, `journal_entry_id` |
| 21 | `SalesReturnLine` | `salesReturnLines` | `sales.return_lines` | `return_id` (cascade), `item_id` |
| 22 | `WithholdingAdjustment` | `withholdingAdjustments` | `sales.withholding_adjustments` | `payment_id`, `invoice_id`, `sales_return_id` |
| 23 | `ScrapSaleDocument` | `scrapSales` | `sales.scrap_sales` | `item_id`, `warehouse_id`, `journal_entry_id`, `cost_journal_entry_id` |
| 24 | `PurchaseInvoice` | `purchaseInvoices` | `purchasing.invoices` | `supplier_id`, `warehouse_id`, `journal_entry_id` |
| 25 | `PurchaseInvoiceLine` | `purchaseInvoiceLines` | `purchasing.invoice_lines` | `purchase_invoice_id` (cascade), `item_id` |
| 26 | `PurchaseReturn` | `purchaseReturns` | `purchasing.returns` | `purchase_invoice_id`, `supplier_id`, `warehouse_id` |
| 27 | `PurchaseReturnLine` | — (مدمجة داخل `PurchaseReturn.lines`) | `purchasing.return_lines` | `return_id` (cascade) |
| 28 | `InventoryTransaction` | `inventoryTransactions` | `inventory.transactions` | `item_id`, `warehouse_id`, مستند بـ`document_number` |
| 29 | `InventoryCount` | `inventoryCounts` | `inventory.counts` | `warehouse_id`, `journal_entry_id` |
| 30 | `InventoryCountLine` | `inventoryCountLines` | `inventory.count_lines` | `count_id` (cascade) |
| 31 | `Payment` | `payments` | `treasury.payments` | `party_id`, `bank_account_id`, `cheque_id`, `journal_entry_id` |
| 32 | `PaymentAllocation` | `paymentAllocations` | `treasury.payment_allocations` | `payment_id` (cascade), `invoice_id` + `invoice_type` |
| 33 | `Cheque` | `cheques` | `treasury.cheques` | `party_id`, `journal_entry_id`, `receipt_journal_id` |
| 34 | `BankAccount` | `bankAccounts` | `treasury.bank_accounts` | `gl_account_id` → `core.accounts` |
| 35 | `BankTransaction` | `bankTransactions` | `treasury.bank_transactions` | `bank_account_id`, `journal_entry_id` |
| 36 | `TreasuryTransaction` | `treasuryTransactions` | `treasury.transactions` | `gl_account_id` → `core.accounts` |
| 37 | `Expense` | `expenses` | `treasury.expenses` | `gl_account_id`, `cost_center_id`, `sales_rep_id`, `bank_account_id` |
| 38 | `CostCenter` | `costCenters` | `core.cost_centers` | `code` فريد |
| 39 | `Account` | `accounts` | `core.accounts` | `parent_id` → `core.accounts` (self) |
| 40 | `AccountMapping` | `accountMappings` (`Record<key, accountId>`) | `core.account_mappings` | `account_id` → `core.accounts` |
| 41 | `AccountingPeriod` | `accountingPeriods` | `core.accounting_periods` | لا تداخل بين الفترات (trigger) |
| 42 | `JournalEntry` | `journalEntries` | `fin.journal_entries` | `lines[]` → `fin.journal_lines`, `source_document_id` |
| 43 | `JournalLine` | مدمجة داخل `JournalEntry.lines` | `fin.journal_lines` | `journal_entry_id` (cascade), `account_id`, `cost_center_id` |
| 44 | `StandardCostRate` | `standardCostRates` | `core.standard_cost_rates` | `product_id` |
| 45 | `SalesForecast` | `forecasts` | `core.sales_forecasts` | `product_id`, `unit_id` |
| 46 | `ProductionPayrollDistribution` | `payrollDistributions` | `production.payroll_distributions` | `allocations[].productionOrderId`, `allocations[].journalEntryId` |
| 47 | `ExportShipment` | `exportShipments` | `fin.export_shipments` | `customer_id`, `sales_invoice_id` |
| 48 | `User` | `users` | `core.app_profiles` | `warehouse_ids[]`, `permissions` jsonb |
| 49 | `AuditLog` | `auditLogs` | `audit.logs` | append-only |
| 50 | `AppSettings` | `settings` | `core.app_settings` | singleton (`id = 'default'`)، `invoice_template` jsonb |

### كيانات موجودة في الكود بلا مجموعة مستقلة

| الكيان | مكانه | الجدول |
|---|---|---|
| `ChequeStatus` / `PaymentMethod` / `RoleName` … | قيم نصية | `CHECK` constraints في الجداول المقابلة |
| `ProductionOrder.materialReconciliation` / `bomSnapshot` / `quantityEditHistory` | كائنات مضمنة | أعمدة `jsonb` في `production.orders` |
| `ProductionConsumption.batchAllocations` | مضمن | `jsonb` في `production.consumptions` |
| `ProductionPayrollDistribution.allocations` | مضمن | `jsonb` في `production.payroll_distributions` |
| `InvoiceTemplateSettings` | داخل `settings` | `core.app_settings.invoice_template` |

## 3) تحويلات الأسماء والحقول

- **camelCase → snake_case** آليًا (`invoiceNumber` → `invoice_number`)،
  والاستثناءات مذكورة صريحة في الجداول أعلاه.
- **المعرّفات**: تبقى `text` كما هي (`inv-2026-00031`, `wh-raw`, …) حتى يبقى
  كل مرجع محلي صالحًا بعد الترحيل ولا يُعاد ترقيم أي مستند.
- **التواريخ**: `date` في TypeScript (`YYYY-MM-DD`) → `date` في Postgres.
  الطوابع الزمنية (`createdAt`, `closedAt`, `postingAt`) → `timestamptz`.
- **المبالغ**: `numeric(18,4)`؛ أسعار الصرف `numeric(18,6)`؛ نسب الضريبة
  `numeric(9,6)` (0.14 لا 14). لا `float` في أي مبلغ.
- **`isTest`** → `is_test` على كل جدول مستندي، لعزل بيانات الاختبار.
- **`accountMappings`** كان `Record<key, accountId>` وأصبح جدولًا بـ`key` مفتاحًا
  أساسيًا + `name_ar` + `account_id`. نفس المفاتيح (`cogs_local`,
  `inventory_finished_local`, `cogs_export`, `inventory_finished_export`, …).

## 4) القيود المُنفَّذة في قاعدة البيانات

| القيد | المكان |
|---|---|
| قيد اليومية يجب أن يتوازن (مدين = دائن) عند الترحيل | `fin.assert_entry_balanced()` — constraint trigger مؤجل |
| لا ترحيل على حساب رئيسي (header) | `fin.guard_journal_line()` |
| لا ترحيل على حساب غير موجود | `fin.guard_journal_line()` |
| منع الترحيل في فترة مغلقة | `fin.guard_closed_period()` |
| منع تداخل الفترات المحاسبية | `core.guard_period_overlap()` |
| منع المخزون السالب إلا بمفتاح مرخّص | `inventory.guard_negative_stock()` |
| صلاحية تاريخ الانتهاء من `expiry_period_days` | `inventory.guard_batch_dates()` |
| منع حذف مستند مرحّل | `fin.refuse_delete_of_posted()` |
| علاقات المستندات ببعضها (cascade / set null) | `REFERENCES` في 120–130 |
| VAT بين 0 و1، العملات `EGP`/`USD`، حالات المستندات | `CHECK` constraints |

## 5) المسارات التي لم تُصنَّف بعد (تحتاج قاعدة بيانات عاملة)

هذه ليست كيانات مفقودة، بل مسارات كتابة تحتاج إثباتًا على TEST:

1. `public.post_sales_invoice` → `sales.invoices` + `fin.journal_entries`
2. `public.post_sales_inventory_issue` → `inventory.batches` + `inventory.transactions` + قيد COGS
3. `public.post_sales_invoice_integrated` → تجميع الاثنين ذريًا
4. `public.erp_master_cas` / `erp_warehouse_cas` / `erp_doc_cas` → `public.erp_master_records`, `erp_warehouses`, `erp_json_documents`
5. مسارات الكتابة المحلية في `src/services/workflows.ts` (المصدر المرجعي للقواعد)

راجع `supabase/verify/verify_schema.sql` للتحقق من كل ما سبق **قراءةً فقط**.
