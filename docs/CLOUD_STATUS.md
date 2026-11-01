# SnakDip ERP — cloud conversion status (one list, every screen)

Legend:

* ✅ **مكتمل سحابيًا** — reads AND writes go to Supabase TEST, tested.
* 🟦 **قراءة فقط** — reads from Supabase TEST; the write RPC exists but no UI
  calls it yet (or it is blocked on missing master data).
* 🟨 **غير متاح في السحابة** — no read RPC exists yet; cloud mode shows an explicit
  "not available" panel instead of local data.
* 🟪 **محلّي** — the normal (default) mode: reads/writes `localStorage`, untouched.

Switches: `VITE_DATA_MODE=cloud` selects the cloud source (default `local`),
`VITE_ENABLE_SUPABASE_AUTH=true` makes Supabase Auth the only login (default
local login). Both default to the local behaviour, so the running app is
unchanged until you flip them. The isolated routes work today regardless:
`?cloud=1&screen=<items|customers|suppliers|sales|warehouses|units|accounting|inventory|purchasing|manufacturing|quality|costing|representatives|treasury|banks|cheques|expenses|export|reports|users|audit|settings>`
(شريط تنقّل بين الشاشات السحابية أُضيف أعلى كل شاشة؛ المسار `/` ما زال محليًا)
(each one now opens behind a **sign-in gate** — `CloudSessionGate` — because the
cloud RPCs need a session; the session stays in memory and never touches
localStorage).

## 0.0 Manual trial entry (current build)

| Entry | What it opens |
|---|---|
| `/` | **the cloud system** (`CloudApp`): one sign-in, grouped sidebar, every module switched in-page so the in-memory session survives navigation |
| `?local=1` | the untouched local ERP (localStorage) — same code as before |
| `?cloud=1&screen=<module>` | the same cloud shell opened on that module (deep link) |
| `?poc=1` | low-level JSON document POC |

The shell never imports `services/db`, so a cloud session cannot read or write
localStorage, and no local balance or historical movement is migrated.

### Credential wiring found and fixed in this pass

* `VITE_SUPABASE_ANON_KEY` in the workspace holds the literal placeholder
  (`len=11`) — every call failed with `Invalid API key`.
* The real **public** anon/publishable key for the TEST project
  (`xrqksgjtqzddzqcwfnaj`) is present as `SUPABASE_ANON_KEY` (health check 200).
* Vite only exposes `VITE_*` to the browser, so `vite.config.ts` now injects the
  first usable public value as `__ERP_SUPABASE_URL__` /
  `__ERP_SUPABASE_ANON_KEY__` (define **and** a textual transform, because the
  dev server did not substitute the bare identifiers inside a `typeof` guard).
  Only public browser values are injected — no service key, DB URL or password.
* The client ignores placeholder-length keys (`< 20` chars) and the QA identity
  helpers now read `SUPABASE_TEST_USER_*`, `QA_CLOUD_TEST_*` or `QA_E2E_*`.

Diagnostics (no secret printed): `node scripts/qa_env_diag.mjs`,
`node scripts/qa_cloud_surface_probe.mjs` (RPC surface),
`node scripts/qa_cloud_lifecycle_probe.mjs` (are the production RPCs deployed on
TEST?), `bun scripts/qa_ui_ops_modules.ts`.

### Production completion — current, measured state

`node scripts/qa_cloud_lifecycle_probe.mjs` (run against TEST) reports
`absent` for `list_production_bom`, `can_complete_production`,
`create_production_consumption`, `record_production_output`,
`close_production_order` and `list_production_orders`, while `trial_balance` is
reported as `deployed (role-gated)` — i.e. the probe distinguishes the two, so
the five production RPCs are genuinely not on TEST yet.

`supabase/migrations/173_cloud_production_completion_safe.sql` was executed on a
throwaway local PostgreSQL by `bash scripts/verify_migrations_local.sh`
(`supabase/tests/production_completion_selftest.sql`). That run found and fixed
a real defect: the FIFO loops read `materialItemId` / `unitId` / `warehouseId`
with unquoted (lower-cased) column names, so every line arrived with a NULL
material id and every issue was refused as `invalid_material`. After the fix the
cycle passes 9/9 checks: BOM requirements, insufficient-stock refusal with no
partial movement, FIFO across two cost layers (10×5 + 2×7 = 64), idempotent
re-issue, FG receipt into `FG-<order>`, one balanced close journal
(Dr FG 64 / Cr raw materials 64), no second journal on retry, and stock
reconciliation (raw 20→8, FG 0→12).

That is a **local** proof on real PostgreSQL. It does not replace a hosted run.

### What still needs the operator

1. **Sign-in password.** The stored QA password is refused by Supabase
   (`Invalid login credentials`) although the email is the documented TEST
   account. The trial screen prefills the email: type the current password
   (or update `QA_CLOUD_TEST_PASSWORD` in Settings → Environment).
2. **A DDL channel for TEST.** Applying a migration needs either
   `TEST_DATABASE_URL` (a TEST pooler URI; the key exists but is currently
   blank, and `scripts/apply_test_migrations.sh` refuses anything that does not
   prove the TEST ref) or the migration being pasted into the Supabase SQL
   editor. With the public publishable key alone there is no way to run DDL.
   Once applied, re-run `node scripts/qa_cloud_lifecycle_probe.mjs` — it must
   stop reporting `absent` — then the hosted cycle can be driven from the UI.

`173` seeds the approved chart and mappings from the local chart (1108 raw
inventory, 1109 finished goods, 1113 VAT input, 2101 supplier payable,
2104 accrued conversion cost, 4102 wholesale revenue, 4103 export revenue) and
adds `list_production_bom`, `can_complete_production`,
`create_production_consumption`, `record_production_output`,
`close_production_order`. Until it runs, the production cycle keeps refusing
completion (by design) instead of half-posting.

## 0. TEST identity and test data

| Item | Value |
|---|---|
| Account | `elhandsiagroup10@gmail.com` (auth uid `cd8ae590-5f86-4f01-87df-fb5a5b640383`) |
| ERP role | **Super Admin** (`core.app_profiles`, active, `is_test = true`) |
| Linked by | `supabase/162_link_test_write_role.sql` (idempotent, TEST only) |
| Master data | `supabase/164_test_operations_master_data.sql` |

`Super Admin` rather than `Chief Accountant` because the integrated sales path
needs BOTH gates: `post_sales_invoice_integrated` / `post_sales_inventory_issue`
require the role to be in (`Super Admin`, `Chief Accountant`) **and**
`public.can_write_inventory()` to be true, and that second function accepts only
(`Super Admin`, `Warehouse Manager`, `Warehouse Employee`, `Production Manager`).

Provisioned test data (all `is_test = true`):

| Entity | Rows |
|---|---|
| Warehouses | `qa-e2e-wh-01` (QA-WHS-01) و`qa-e2e-wh-02` (QA-WHS-02، منتج تام محلي) |
| Suppliers | `qa-sup-01` (مورد تعبئة)، `qa-sup-02` (مورد مواد خام) |
| Items | `qa-item-01` شيبس ملح، `qa-item-02` شيبس جبنة (بتتبّع دفعات وصلاحية)، `qa-item-rm-01` بطاطس خام |
| Opening stock | دفعات `qa-bat-01-a/b`, `qa-bat-02-a`, `qa-bat-rm-01` + حركات استلام `QA-OPENING` (الرصيد في السجل = الرصيد في الدفعات) |
| Receivables | حساب `qa-acc-ar-1101` «ذمم العملاء — QA» مربوط بمفتاح `customer_receivable_local` (بدل حساب النقد السابق) |

## 1. Module status

| # | Screen (tab) | Cloud surface | Read source | Write source | Status |
|---|---|---|---|---|---|
| 1 | لوحة المعلومات `dashboard` | — | — | — | 🟨 / 🟪 |
| 2 | الأصناف `items` | `CloudItemsPanel` / `CloudMasterReadPanel` | `erp_core_master_read` | `erp_master_cas` (service only) | 🟦 قراءة |
| 3 | المبيعات `sales` | `CloudSalesReadPanel` + **`CloudSalesWritePanel`** | `list_sales_invoices`, `list_sales_returns` | **`post_sales_invoice_integrated` — موصول بالواجهة** | ✅ **قراءة + إصدار فاتورة** (لا إلغاء/تعديل) |
| 4 | المشتريات `purchasing` | `CloudPurchasingPanel` | `list_purchasing_invoices`, `list_purchase_returns` | `post_purchase_invoice` (blocked: حسابات مشتريات مفقودة) | 🟦 قراءة فقط |
| 5 | المخزون `inventory` | `CloudInventoryPanel` | `list_inventory_transactions`, `list_inventory_batches`, `stock_on_hand` | **`post_inventory_transfer` — موصول ويعمل بمستودعين** | ✅ **قراءة + تحويل داخلي** |
| 6 | الإنتاج `manufacturing` | **`CloudProductionPanel`** | `list_production_orders` | **`create_production_order` (مسودة) + `set_production_order_status` (إصدار/بدء/إلغاء)**؛ الإقفال مرفوض صراحةً | ✅ **إنشاء + حالات غير مالية** (لا إقفال) |
| 7 | الجودة `quality` | **`CloudQualityPanel`** | **`list_quality_inspections`** | **`create_quality_inspection`** (سجل فقط، بلا حركة مخزون) | ✅ **قراءة + تسجيل فحص** |
| 8 | التكاليف `costing` | **`CloudCostingPanel`** | **`list_standard_cost_rates`** | **`create_standard_cost_rate` / `expire_standard_cost_rate`** | ✅ **قراءة + إدارة معدلات** |
| 9 | العملاء `customers` | `CloudCustomersPanel` | `erp_core_master_read` | `erp_master_cas` (service) | 🟦 قراءة فقط |
| 10 | الموردون `suppliers` | `CloudSuppliersPanel` | `erp_core_master_read` | `erp_master_cas` (service) | 🟦 قراءة فقط |
| 11 | المناديب `representatives` | `CloudCustodyPanel` | `list_representative_custodies`, `list_custody_movements` | يحتاج حسابات عهد ومخزون للتحميل/الإرجاع | 🟦 قراءة فقط |
| 12 | التصدير `export` | `CloudExportPanel` | `list_export_shipments` | — | 🟦 قراءة فقط |
| 13 | الخزينة `treasury` | `CloudPaymentsPanel` | `list_payments` | لا دالة قبض/دفع: تحتاج تعيينات (خزينة/بنك مقابل ذمم) غير موجودة | 🟦 قراءة فقط |
| 14 | البنوك `banks` | `CloudBanksPanel` | `list_bank_accounts`, `list_bank_transactions` | يحتاج تعيين حساب بنكي + مصاريف بنكية | 🟦 قراءة فقط |
| 15 | الشيكات `cheques` | `CloudChequesPanel` | `list_cheques` | يحتاج حسابات شيكات (تحت التحصيل/محتجز) | 🟦 قراءة فقط |
| 16 | المصروفات `expenses` | `CloudExpensesPanel` | `list_expenses` | يحتاج حسابات مصروفات/ضريبة مدخلات | 🟦 قراءة فقط |
| 17 | المحاسبة `accounting` | `CloudLedgerPanel` + **`CloudJournalPostForm`** | `list_journal_entries`, `trial_balance`, **`list_posting_accounts`** | **`post_journal` — موصول بالواجهة** (دور المحاسب + فترة مفتوحة + بلا حسابات رئيسية + توازن) | ✅ **قراءة + قيد يدوي مُرحَّل** |
| 18 | التقارير `reports` | **`CloudReportsPanel`** | **`profit_and_loss`**, `trial_balance`, **`inventory_movement_report`** | — | 🟦 **قراءة (كل الأرقام من الخادم)** |
| 19 | المستخدمون `users` | **`CloudUsersPanel`** | **`list_app_profiles`** + `current_erp_role`, `erp_user_can` | **`set_profile_role` / `set_profile_permissions` / `set_profile_active`** | ✅ **قراءة + إدارة أدوار وصلاحيات** |
| 20 | الإعدادات `settings` | **`CloudSettingsPanel`** + المستودعات | **`get_cloud_settings`**, `erp_core_master_read` | `erp_warehouse_cas` (service) — تعديل الشركة/الفاتورة غير مُفعَّل | 🟦 قراءة |
| 21 | سجل التدقيق `audit` | **`CloudAuditPanel`** | **`list_audit_log`** (بتصفية وحدة/عملية/تاريخ) | لا كتابة من العميل (append-only من دوال الخادم) | ✅ **قراءة كاملة** |

Standalone surfaces (never import `db.ts`/localStorage): `?cloud=1` cloud
workspace, `?poc=1` JSON document POC.

### الاثنان 증시에ً المحلي السحابي — فصل واضح حتى مع وجود نتيجة واحدة

المهمة طلبت إنهاء كلا البرهنتين قبل الاعتبار، وهذا ما زال التسليم الفعلي:
- **المنطق المحلي للتصنيع** (BOM, احتياجات المواد, الهالك/الهالك المحسوب, وحدات التحويل, FIFO, التكلفة الفعلية والاختلافات) مُثبَّت ومُفحَّص فعليًا عبر وحدة المحرك المحلي `src/services/manufacturing.ts` + `src/services/inventory.ts` وعقود الاختبار الخاصة بها.
- **دورة التصنيع السحابية الكاملة** (نفس الخطوات ولكن عبر Supabase TEST) **لم تُنفَّذ بعد**؛ الواجهة السحابية الحالية `src/services/cloudManufacturing.ts` تمسك بالقراءات ودفاتر الحالة وسجل الإنشاء والفحص فقط، ولا تمرر خطوات الاستهلاك/الإصدار/الإقفال إلى Supabase. السبب operative الحالي هو أن أي عمليات كتابة سحابية تحتاج جلسة TEST حقيقية (بيانات اعتماد مُثبَّتة)، وهذا هو الحاجز الخارجي لليوم.

سأفصل النتيجة لاحقًا إلى نقطتين عندما يُسمح بتشغيل الاختبارات الحية: (أ) اختبار منطق التصنيع المحلي، (ب) اختبار الدورة الكاملة على Supabase TEST.

### Cloud RPCs added in this pass (`supabase/migrations/166_cloud_reports_users_settings.sql`)

| Function | Type | Gate |
|---|---|---|
| `public.profit_and_loss(from,to)` | read (SECURITY INVOKER, RLS applies) | posted journal lines only; every subtotal (`gross_profit`, `net_profit`, …) computed in SQL. RLS still applies, so the caller also needs accounting read access (Super Admin / General Manager / Chief Accountant / Viewer في المصفوفة الحالية) — وإلا فالناتج فارغ ولا يتسرّب شيء |
| `public.inventory_movement_report(from,to)` | read (RLS applies) | opening / in / out / closing per item+warehouse from `inventory.transactions` (يحتاج صلاحية قراءة المخزون) |
| `public.erp_user_can(module,action)` | read (DEFINER) | exposes only the boolean of `core.user_can` — the profile table stays closed |
| `public.list_app_profiles()` | read (DEFINER) | `auth.uid()` + `core.user_can('users','view')`; projects chosen columns only |
| `public.set_profile_role(id,role)` | write (DEFINER) | `users.edit`, role must exist in `core.role_matrix()`, no self-change, last active Super Admin protected, audited |
| `public.set_profile_permissions(id,jsonb)` | write (DEFINER) | same + module/action whitelist, Super Admin overrides refused, audited |
| `public.set_profile_active(id,bool)` | write (DEFINER) | same + no self-lockout / last Super Admin protected, audited |
| `public.get_cloud_settings()` | read (DEFINER) | `settings.view`; company + app_settings, logo replaced by a flag |

`supabase/167_test_company_settings_seed.sql` seeds the missing company identity and
the system settings (expiry threshold 10 days + the default invoice template); TEST only.

### Cloud RPCs added for the operational modules (`supabase/migrations/168_…sql`)

| Function | Type | Gate / behaviour |
|---|---|---|
| `public.list_audit_log(module,action,from,to,limit,offset)` | read (DEFINER) | `audit.view`; filters + paging, newest first |
| `public.list_posting_accounts()` | read (DEFINER) | `accounting.view`; every account with its `is_header` flag |
| `public.create_production_order(...)` | write (DEFINER) | `manufacturing.create`; draft only, `PRD-YYYY-NNNNN` numbering, idempotency, audited |
| `public.set_production_order_status(order,status)` | write (DEFINER) | `manufacturing.edit`; only draft→released, released→in_progress, *→cancelled. `completed` دائما مرفوض |
| `public.list_quality_inspections(from,to,result,limit,offset)` | read (DEFINER) | `quality.view` |
| `public.create_quality_inspection(...)` | write (DEFINER) | `quality.create`; record only, audited, idempotency |
| `public.list_standard_cost_rates(status,limit,offset)` | read (DEFINER) | `costing.view` |
| `public.create_standard_cost_rate(...)` | write (DEFINER) | `costing.create`; enum-validated, audited |
| `public.expire_standard_cost_rate(id,effective_to)` | write (DEFINER) | `costing.edit`; active→expired once, audited |
| `public.erp_write_audit(...)` | internal | **revoked from anon/authenticated** — cannot be used to forge audit rows |

### Manufacturing cloud surface — what is wired vs what is still blocked

The cloud UI reaches `src/services/cloudManufacturing.ts`, which calls the TEST RPCs
`create_production_order`, `set_production_order_status`, `list_production_orders`,
`list_quality_inspections`, `create_quality_inspection`.

**NOW wired and provable as a cloud surface (UI → RPC → server gate):**
- create a production order as a draft (`PRD-YYYY-NNNNN`, no stock movement, no journal),
- move it through non-financial states (`released`, `in_progress`, `cancelled`),
- refuse illegal transitions and invalid inputs,
- record a quality inspection as a row only (no stock movement).

**NOT yet wired as a cloud manufacturing cycle, and not claimed done:**
- BOM → requirement calc → issue → FIFO consumption → output receipt → completion/WIP/variance posting.

The maps are intentionally thin: `cloudManufacturing.ts` exposes the read/write RPCs but **does not
call `calculateBomRequirements` / `issueMaterialsToOrder` / `recordDailyProduction` / `closeProductionOrder` / `calculateCostBreakdown` over Supabase**, because those steps need the TEST inventory + production + accounting tables (batches/transactions/consumptions/fifo, journal mappings, open period) wired through a server path that does not exist as a cloud RPC today. They still run only in the **local** engine (`src/services/manufacturing.ts` + `src/services/inventory.ts`) against the local store.

**Two proofs are still separate, by design:**
1. Local manufacturing logic — proven against the local engine (see UAT_REPORT / regression runs).
2. Full cloud manufacturing cycle end-to-end — NOT yet executed; blocked until the write path has a real TEST session (see blocker 1 below).

**Schema defect fixed here**: `core.standard_cost_rates` carried the
`trg_standard_cost_rates_touch` trigger (BEFORE UPDATE → `core.touch_updated_at`)
but had no `updated_at` column, so *any* update aborted with
`record "new" has no field "updated_at"` — an active rate could never be expired.
The migration adds the additive column (matching every other core table).

## 2. What changed in this pass

| Change | File |
|---|---|
| Cloud sales write service: role gate, pickers, integrated posting with a fresh idempotency key per submit | `src/services/cloudSalesWrite.ts` |
| Sales invoice form (role-gated, line editor، معاينة إجمالي، نتيجة الخادم) مدمجة في شاشة المبيعات | `src/components/modules/cloud/CloudSalesWritePanel.tsx`, `CloudSalesReadPanel.tsx` |
| Session gate for every `?cloud=1&screen=…` route (كانت تُفتح بلا جلسة فترفضها كل الدوال) | `src/components/modules/cloud/CloudSessionGate.tsx`, `src/main.tsx` |
| TEST master data: مستودع ثانٍ، حساب ذمم عملاء + تعيينه، موردان، ثلاثة أصناف وأرصدة افتتاحية بحركات استلام | `supabase/164_test_operations_master_data.sql` |
| JWT gate: صار ``if coalesce(current_setting('request.jwt.claims', true), '') <> ''`` في كل دوال الكتابة — اتصال مُجمَّع (pooled) كان يترك القيمة `''` فتُرفض جلسة قاعدة بيانات موثوقة بـ«no auth session» | `supabase/114_…sql`, `supabase/116_…sql`, `supabase/migrations/165_harden_jwt_gate.sql` |
| تقارير سحابية: P&L + ميزان مراجعة + حركة مخزون بفترة قابلة للاختيار وطباعة، بأرقام مجمَّعة على الخادم | `src/services/cloudReports.ts`, `src/components/modules/cloud/CloudReportsPanel.tsx` |
| إدارة مستخدمين وأدوار وصلاحيات شاشات فوق `core.app_profiles` + Supabase Auth (كل تعديل مُدقَّق ومرفوض للحساب نفسه) | `src/services/cloudUsers.ts`, `src/components/modules/cloud/CloudUsersPanel.tsx` |
| شاشة إعدادات الشركة/النظام (قراءة) + شريط تنقّل بين الشاشات السحابية + مسارات `reports/users/settings` | `src/components/modules/cloud/CloudSettingsPanel.tsx`, `src/main.tsx` |
| دوال التقارير والمستخدمين والإعدادات + بذر هوية الشركة وإعداداتها في TEST | `supabase/migrations/166_cloud_reports_users_settings.sql`, `supabase/167_test_company_settings_seed.sql` |
| Earlier this session: دور الكتابة، SECURITY DEFINER لدالة التحويل، رسالة الفترة المغلقة | `supabase/162_…sql`, `supabase/migrations/163_secure_write_rpcs.sql`, `116_…sql` |

## 3. Tests checkpoint — reviewed state today

| Test | Kind | Result |
|---|---|---|
| `scripts/qa_ui_sales_write.ts` | **الواجهة نفسها** (`src/services/cloudSalesWrite.ts`) عبر جلسة REST حقيقية | **6/6**: تسجيل الدخول، الدور Super Admin، خيارات (عميلان/مستودعان/5 أصناف)، إصدار `SINV-2026-00138` (COGS 20 = 2×10، قيد `JV-2026-00131`)، مشاركة ثانية = فاتورة جديدة `SINV-2026-00139`، وكمية 999,999 مرفوضة برسالة الخادم |
| `scripts/qa_ui_transfer.ts` | **الواجهة نفسها** (`src/services/cloudInventoryWrite.ts`) | **8/8**: مستودعان ظاهران، تحويل `TRF-20261027-000005` (5 وحدات)، الرصيد `qa-e2e-wh-01` 97→92 و`qa-e2e-wh-02` 0→5، رفض مصدر = وجهة، ورفض كمية مستحيلة |
| تحقق محاسبي على TEST | SQL read-only | `SINV-2026-00138`: مدين 1101 QA 68.40 / دائن 4101 QA 60.00 / دائن 2103 QA 8.40 (متوازن)؛ COGS `JV-2026-00131`: مدين 5101 20 / دائن 1109 20؛ صرف FIFO من الدفعة `QA-B01-A` بتكلفة 10 |
| `scripts/qa_cloud_write_paths.sql` | PostgREST محاكى، rolled back | 12/12 |
| `scripts/qa_rpc_sales_integrated_e2e.sql` | rolled back | 5/5 (وصار مستقلًا عن ترتيب التشغيل بعد إصلاح 165) |
| `scripts/qa_rest_full_cycle.mjs` + `qa_rest_full_cycle_verify.sql` | REST حقيقي + تحقق خادمي | 12/12 + VERIFY OK |
| `scripts/qa_cloud_session_probe.mjs` | REST حقيقي | 13/13 |
| `scripts/qa_ui_reports_users.ts` | **الواجهة نفسها** (`cloudReports.ts` + `cloudUsers.ts`) عبر جلسة REST حقيقية | **25/25**: توازن الميزان (18,431.60 = 18,431.60)، مجمل/صافي الربح = 16,256 = إيراد 16,340 − تكلفة 84، إيراد P&L = إيراد الميزان، رصيد حركة المخزون = `stock_on_hand` لكل مستودع (630 / 5)، دليل المستخدمين والمستخدم الحالي، رفض تغيير الدور الذاتي، رفض دور وهمي، رفض وحدة غير معروفة، تطبيق تجاوز صلاحيات (بما فيها وحدة `users` غير الموجودة في صف Viewer — أُصلح فحص القائمة البيضاء لذلك) ثم إرجاعه، تعديل الدور ثم استعادته، تفعيل/تعطيل ثم استعادته، إعدادات الشركة، ورفض anon للثلاث دوال |
| `scripts/qa_ui_full_scenario.ts` | سيناريو متكامل عبر خدمات الواجهة | **12/12**: إصدار `SINV-2026-00157` (قيد بيع `JV-2026-00158` 68.40 متوازن + FIFO + قيد COGS `JV-2026-00159` 20)، الإيراد +60، التكلفة +20، الرصيد 92→90، مجمل الربح 16,296، الميزان متوازن 18,520، ثم دليل المستخدمين وإعدادات الشركة |
| `scripts/qa_ui_ops_modules.ts` | **الواجهة نفسها** (`cloudAudit` + `cloudJournal` + `cloudManufacturing` + `cloudCosting`) | **34/34**: قراءة سجل العمليات وتصفيته، رفض الفترة المغلقة (سبتمبر) والقيد غير المتزن، ترحيل `JV-2026-00160` وظهوره في الدفتر، توازن الميزان 18,545، إعادة المحاولة بنفس المفتاح ترجع نفس القيد (`JV-2026-00161`)، مسودة `PRD-2026-00003` وإصدارها وبدؤها، رفض الرجوع للخلف، **رفض الإقفال**، إلغاء مسودة، رفض سوق غير صالح، فحص جودة مرتبط بالأمر بلا أي حركة مخزون، معدل تكلفة ثم إنهاء سريانه ورفض الإنهاء المزدوج، وظهور create/edit في سجل التدقيق، ورفض anon للدوال الخمس |
| `bun tsc -b --noEmit` | typecheck | exit 0 |
| Vite dev transform للوحدات الجديدة | `curl` على dev server | 200 لكل من `CloudReportsPanel.tsx`, `CloudUsersPanel.tsx`, `CloudSettingsPanel.tsx`, `cloudReports.ts`, `cloudUsers.ts`, و`/` و`?cloud=1&screen=reports` |

Not tested: لم يتم النقر داخل متصفح (لا توجد أداة متصفح هنا). النماذج نفسها
مُتحقَّق منها بالـtypecheck + بتحويل Vite + بتشغيل **نفس دوال الخدمة** التي
تستدعيها، لكن تجربة النقر/الطباعة على الشاشة لم تُجرَّب.

## 4. Data written to TEST by the proofs

All marked `is_test = true` where the table supports it:

* fixtures العميل `rpc-rest-cust`، الصنف `rpc-rest-item`، الدفعتان `rpc-rest-b1/b2`، حركتا `rpc-rest-rx-1/2`،
* الفاتورة `SINV-2026-00125` (مع `JV-2026-00113` و`JV-2026-00114`),
* فاتورتا اختبار الواجهة `SINV-2026-00138` و`SINV-2026-00139` (مع `JV-2026-00130..00133`),
* التحويل `TRF-20261027-000005` (حركتا صرف/إضافة بقيمة 50),
* فاتورة السيناريو `SINV-2026-00157` (مع `JV-2026-00158` و`JV-2026-00159`),
* بيانات 164 (مستودع، موردان، 3 أصناف، 4 دفعات، 4 حركات استلام),
* سجل الشركة `qa-company-01` وإعدادات `qa-settings-01` (167),
* قيود يدوية اختبارية `JV-2026-00160..00163` (مرجع `QA-MANUAL-*` / `QA-IDEM-*` بقيم 25 و3 — ليست عمليات تجارية),
* أوامر إنتاج `PRD-2026-00003..00006` (in_progress / cancelled، بلا استهلاك ولا قيود)،
* فحصا جودة بلا حركة مخزون، ومعدلا تكلفة معيارية منتهيا السريان.

القيد المرحّل وحركة المخزون غير قابلين للحذف بحارس محاسبي، لذلك تُركت هذه
المستندات بدل تعطيل الحارس. كل الاختبارات السلبية تراجعت بالكامل.

## 5. Remaining blockers

1. **المشتريات لا تُرحّل**: `post_purchase_invoice` يحتاج حسابات مشتريات
   (مخزون مواد خام، ضريبة مدخلات، ذمم موردين) غير موجودة في TEST، والموردون
   صاروا موجودين. إنشاء الحسابات وربطها قرار محاسبي.
2. **لا إلغاء/تعديل/مرتجع من الشاشة السحابية**: الإصدار والتحويل فقط.
3. **إقفال أوامر الإنتاج غير مُفعَّل** (مقصود): يحتاج استهلاك مواد بـFIFO + قيد WIP +
   تكلفة تحويل + رسملة منتج تام. الحسابات/التعيينات المطلوبة غير موجودة في TEST،
   والخادم يرفض `completed` صراحةً بدل ترحيل نصف حقيقة.
4. **كتابة الخزينة/البنوك/الشيكات/المصروفات/العهد غير مُفعَّلة**: تحتاج قبل أي كود
   تعيينات محاسبية لم تُعتمد بعد (ذمم دائنة للموردين، حسابات مصروفات، حساب بنكي،
   شيكات تحت التحصيل، عهد/مخزون العهدة). هذه قرارات محاسبية لا تُخترع.
5. **`fin.post_journal`, `fin.post_sales_invoice`, `fin.post_purchase_invoice`,
   `fin.post_inventory_count` موجودة في TEST فقط** بلا ملف مصدر في المستودع، لذلك
   لا يمكن إعادة بناء قاعدة جديدة من الـmigrations وترحيل قيود عليها.
6. **متجر Supabase pooler**: قيمة `request.jwt.claims` قد تبقى `''` بعد جلسة
   استخدمت `set_config(..., true)`؛ عولجت في الدوال أعلاه لكن أي دالة جديدة يجب
   أن تستخدم نفس النمط (`coalesce(..., '') <> ''`).
7. **قنوات البيع `wholesale` و`export` لا تُرحّل**: لا يوجد تعيين
   `sales_wholesale_revenue` / `sales_export_revenue` في TEST، فالخادم يرفض الفاتورة
   ويلغيها بالكامل (لا فاتورة ولا قيد). إضافة الحسابات وتعيينها قرار محاسبي.
8. **تعديل إعدادات الشركة/الفاتورة من السحابة غير مُفعَّل** (قراءة فقط): تغيير هوية
   الشركة أو تصميم الفاتورة أو عتبة التنبيه قرار إداري يحتاج قاعدة معتمدة.
9. **إنشاء حسابات Supabase Auth جديدة غير متاح من الواجهة**: يتطلب `service_role`
   الذي لا يُحزَم أبدًا في المتصفح؛ إنشاء المستخدم يبقى في لوحة Supabase، ثم تظهر
   صفوف `core.app_profiles` هنا لإدارة الدور والصلاحيات والتعطيل.

### الحاجز الخارجي اليوم (محدَّث بعد فحص المفاتيح)

لم يعد الحاجز هو المفتاح العام: تشخيص `scripts/qa_env_diag.mjs` أثبت أن
`SUPABASE_ANON_KEY` صالح (فحص الصحة 200) بينما `VITE_SUPABASE_ANON_KEY` كان
placeholder، وأن الواجهة السحابية الآن تحقن المفتاح العام الصالح وقت البناء.

الحاجزان المتبقيان، وكلاهما يحتاج صلاحية لوحة Supabase وليس كودًا:

1. **كلمة مرور حساب TEST** الموجودة في البيئة مرفوضة من Supabase
   (`Invalid login credentials`) مع أن البريد هو الحساب الموثَّق. أي كتابة حية
   تحتاج إدخال كلمة المرور الصحيحة من شاشة الدخول أو تحديثها في المتغيرات.
2. **ترحيل 173 غير مُطبَّق على TEST** (لا يوجد `TEST_DATABASE_URL` في البيئة)،
   لذلك دوال دورة التصنيع الكاملة (`create_production_consumption`,
   `record_production_output`, `close_production_order`, `list_production_bom`,
   `can_complete_production`) غير موجودة على الخادم بعد، والخادم يرفض الإقفال
   بدل ترحيل نصف حقيقة.
