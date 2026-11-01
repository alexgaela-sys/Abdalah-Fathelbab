# مصفوفة الصلاحيات و RLS (Supabase TEST)

المصدر الوحيد للحقيقة في الكود: `src/services/permissions.ts`.
النسخة في قاعدة البيانات: `core.role_matrix()` (في
`supabase/migrations/100_cloud_schemas_and_access.sql`) — نفس القيم حرفيًا،
و`core.user_can(module, action)` يقرأ منها.

## 1) نموذج الكتابة

| الدور | ما يستطيعه مباشرة على الجداول |
|---|---|
| `anon` | **لا شيء**: لا `USAGE` على أي schema، ولا `SELECT`، ولا سياسة |
| `authenticated` | `SELECT` فقط، ومشروطًا بسياسة الدور لكل جدول |
| `SECURITY DEFINER RPC` | القراءة والكتابة، بعد فحص الدور والفترة والتوازن |

كل كتابة تمر عبر RPC: `post_sales_invoice`, `post_sales_inventory_issue`,
`fin.post_journal`, `post_inventory_transfer`, `erp_*_cas`. لذلك
`INSERT/UPDATE/DELETE` مسحوبة من `authenticated` على كل جداول ERP
(`150_rls_and_grants.sql`). لا يوجد مسار كتابة مباشر من المتصفح.

## 2) رموز الأفعال

`V`=view, `C`=create, `E`=edit, `D`=delete, `A`=approve, `P`=post,
`X`=cancel, `Ex`=export.

## 3) المصفوفة لكل دور

| الدور | الوحدات والأفعال |
|---|---|
| Super Admin | كل الوحدات، `V C E D A P X Ex` (لا يُستثنى ولا يُقيَّد — F23) |
| General Manager | `dashboard` كاملة، `reports` كاملة، وكل الوحدات الأخرى `V Ex` |
| Chief Accountant | `costing/treasury/banks/cheques/expenses/accounting/reports` كاملة؛ `sales/purchasing/customers/suppliers` = `V C E Ex A`؛ `items/manufacturing/quality` = `V`؛ `inventory/representatives/export/audit` = `V Ex` |
| Accountant | `sales/purchasing/customers/suppliers/treasury/banks/cheques/expenses/accounting` = `V C E Ex`؛ `inventory/reports` = `V Ex`؛ `dashboard/items` = `V` |
| Cost Accountant | `costing` كاملة؛ `items/inventory/manufacturing/reports` = `V Ex`؛ `quality/sales/purchasing/accounting/dashboard` = `V` |
| Warehouse Manager | `inventory` كاملة؛ `items` = `V C E Ex A`؛ `manufacturing/quality` = `V C E Ex`؛ `reports` = `V Ex`؛ `dashboard` = `V` |
| Warehouse Employee | `inventory` = `V C E Ex`؛ `items/quality/dashboard` = `V` |
| Sales Manager | `sales` كاملة؛ `customers/representatives` = `V C E Ex A`؛ `export` = `V C E Ex`؛ `items/inventory/reports` = `V Ex`؛ `dashboard` = `V` |
| Sales Representative | `sales` = `V C`؛ `customers` = `V C`؛ `representatives` = `V C E`؛ `items/dashboard` = `V` |
| Purchasing Manager | `purchasing` كاملة؛ `items/suppliers` = `V C E Ex A`؛ `inventory/reports` = `V Ex`؛ `dashboard` = `V` |
| Production Manager | `manufacturing` كاملة؛ `inventory/quality` = `V C E Ex`؛ `items/costing/reports` = `V Ex`؛ `dashboard` = `V` |
| Treasury Accountant | `treasury/banks/cheques` كاملة؛ `expenses` = `V C E Ex`؛ `accounting` = `V`؛ `reports` = `V Ex`؛ `dashboard` = `V` |
| Viewer | كل الوحدات `V` فقط |

**تجاوز لكل مستخدم (F23):** إن وُجد مفتاح الوحدة في
`core.app_profiles.permissions` فهو **يحل مكان** صف الدور بالكامل، وليس إضافة
عليه. `User.isTest`/`active=false` = لا وصول.

## 4) جداول ومفاتيح الوحدات في RLS

| الوحدة | الجداول |
|---|---|
| `settings` | `core.companies`, `core.app_settings` |
| `items` | `core.items`, `core.units`, `core.unit_conversions` |
| `inventory` | `core.warehouses`, `inventory.batches`, `inventory.transactions`, `inventory.counts`, `inventory.count_lines` |
| `manufacturing` | `production.boms`, `production.bom_lines`, `production.orders`, `production.consumptions`, `production.wastes` |
| `costing` | `core.standard_cost_rates`, `production.payroll_distributions` |
| `quality` | `quality.inspections` |
| `sales` | `sales.invoices`, `sales.invoice_lines`, `sales.returns`, `sales.return_lines`, `sales.withholding_adjustments`, `sales.scrap_sales`, `core.sales_forecasts` |
| `purchasing` | `purchasing.invoices`, `purchasing.invoice_lines`, `purchasing.returns`, `purchasing.return_lines` |
| `customers` | `core.customers` |
| `suppliers` | `core.suppliers` |
| `representatives` | `core.sales_reps`, `core.rep_custody`, `core.custody_movements` |
| `export` | `fin.export_shipments` |
| `treasury` | `treasury.payments`, `treasury.payment_allocations`, `treasury.transactions` |
| `banks` | `treasury.bank_accounts`, `treasury.bank_transactions` |
| `cheques` | `treasury.cheques` |
| `expenses` | `treasury.expenses` |
| `accounting` | `core.accounts`, `core.account_mappings`, `core.accounting_periods`, `core.cost_centers`, `fin.journal_entries`, `fin.journal_lines` |
| `audit` | `audit.logs` |
| `users` | `core.app_profiles` |

## 5) استثناءات مقصودة

| الحالة | السياسة |
|---|---|
| `core.app_profiles` | كل مستخدم يرى **صفّه** (`user_id` أو `supabase_auth_id`) + `users:view` لبقية الصفوف |
| `core.companies`, `core.app_settings`, `core.warehouses` | متاحة لكل مستخدم ERP نشط (`core.current_role() is not null`) لأن كل شاشة طباعة تحتاج رأس الشركة والمستودعات — بلا بيانات مالية |
| `fin.rpc_idempotency` | **لا صلاحية للعميل إطلاقًا** (RLS مفعّل، صفر grants) — سجل داخلي فقط |
| `audit.logs` | قراءة بـ`audit:view`؛ الكتابة عبر RPC فقط. لا `UPDATE/DELETE` لأي دور |
| جداول لها سياسة سابقة | `150_rls_and_grants.sql` **لا يضيف** سياسة جديدة إن وُجدت واحدة لـ`SELECT`/`ALL`، ويطبع NOTICE بدلًا من توسيع الوصول بصمت |

## 6) ما لم يُثبت بعد

هذه المصفوفة مبنية على كود المستودع ومطبقة على قاعدة محلية للتحقق من الصياغة
فقط. **لم تُطبَّق على TEST**، لذلك لا يوجد دليل بعد على سلوك RLS الفعلي تحت
JWT حقيقي. الإثبات المطلوب: تنفيذ `supabase/verify/verify_rls.sql` ثم اختبار
`authenticated` بدورين مختلفين (Super Admin وViewer) على TEST.
