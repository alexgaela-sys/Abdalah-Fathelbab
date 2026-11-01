# SnakDip ERP — cloud readiness notes (TEST only)

Scope: evidence extracted from the local code (`src/services/db.ts`,
`src/services/workflows.ts`, `src/services/permissions.ts`), from the TEST
schema, and from the policies/grants actually present in TEST.
**Nothing in this document has been applied to TEST.** No RLS was changed, no
grant was given, no account mapping was created, no historical row was touched.

---

## A. Proposed account mapping (proposal only — nothing created)

### A.1 Required keys, by channel and payment method

Taken from `fin.post_sales_invoice` (`supabase/98_post_sales_invoice.sql`,
`req_*_mapping_key` declarations and the lookup block) and from the companion
`public.post_sales_inventory_issue` (`supabase/114_sales_inventory_fifo_issue.sql`).

| Mapping key | Local default (id · code · name) | Needed for | Evidence |
|---|---|---|---|
| `sales_vat_output` | `acc-2103` · **2103** · ضريبة القيمة المضافة - مخرجات ومبيعات | every channel, always | `db.ts` mapping table; `98` `req_vat_mapping_key` |
| `customer_receivable_local` | `acc-1105` · **1105** · عملاء تجاريون - محلي | retail + wholesale | `db.ts`; `98` `req_ar_local_mapping_key`; `ledger.ts:188` |
| `customer_receivable_export` | `acc-1106` · **1106** · عملاء تجاريون - تصدير (USD) | export | `db.ts`; `98` `req_ar_export_mapping_key`; `ledger.ts:188` |
| `sales_retail_revenue` | `acc-4101` · **4101** · إيراد مبيعات التجزئة المحلية | channel = retail | `db.ts`; `workflows.ts:528` |
| `sales_wholesale_revenue` | `acc-4102` · **4102** · إيراد مبيعات الجملة المحلية | channel = wholesale | `db.ts`; `workflows.ts:529`; `98:431` |
| `sales_export_revenue` | `acc-4103` · **4103** · إيراد مبيعات التصدير (USD) | channel = export | `db.ts`; `workflows.ts:530`; `98:433` |
| `cash_treasury` | `acc-1101` · **1101** · الخزينة الرئيسية النقدية | payment = cash | `db.ts`; `workflows.ts:148,533`; `ledger.ts:598` |
| `bank_egp` | `acc-1102` · **1102** · بنك مصر - حساب جاري بالجنيه | payment = bank_transfer | `db.ts`; `workflows.ts:149,534` |
| `cogs_local` | `acc-5101` · **5101** · تكلفة البضاعة المباعة - محلي | COGS, non-export | `db.ts`; `workflows.ts:537` |
| `cogs_export` | `acc-5102` · **5102** · تكلفة البضاعة المباعة - تصدير | COGS, export | `db.ts`; `workflows.ts:537` |
| `inventory_finished_local` | `acc-1109` · **1109** · مخزون الإنتاج التام - محلي | credit side, non-export | `db.ts`; `workflows.ts:543` |
| `inventory_finished_export` | `acc-1110` · **1110** · مخزون الإنتاج التام - تصدير | credit side, export | `db.ts`; `workflows.ts:541` |
| `rep_custody` | `acc-1107` · **1107** · عهد مناديب المبيعات | rep-custody invoices only | `db.ts`; `workflows.ts:542` |

`rep_custody` is listed for completeness only: the integrated wrapper refuses
rep-custody invoices by design (`116_sales_invoice_integrated_POST.sql`).

### A.2 What TEST actually holds today

`core.accounts` = **5 rows, all QA-labelled**: `qa-e2e-acc-1105` (code `1105 QA`),
`qa-e2e-acc-2103` (`2103 QA`), `qa-e2e-acc-4101` (`4101 QA`), `qa-fifo-acc-cogs`
(`5101`), `qa-fifo-acc-fg` (`1109`). There is **no real chart of accounts in TEST**.

`core.account_mappings` = **7 rows**:

| key | → account | verdict |
|---|---|---|
| `sales_vat_output` | `qa-e2e-acc-2103` | ✅ correct key/shape |
| `sales_retail_revenue` | `qa-e2e-acc-4101` | ✅ correct key/shape |
| `customer_receivable_local` | `qa-e2e-acc-1105` | ✅ correct key/shape |
| `cash_treasury` | `qa-e2e-acc-1105` (الذمم) | ❌ **wrong**: must point at 1101 الخزينة, never at the receivables account |
| `qa-e2e-*` prefixed duplicates (3) | — | test scaffolding, not a mapping source |

Missing keys: `sales_wholesale_revenue`, `sales_export_revenue`,
`customer_receivable_export`, `bank_egp`, `cogs_local`, `inventory_finished_local`,
`cogs_export`, `inventory_finished_export`.

> Note: `cogs_local` / `inventory_finished_local` were **not** persisted — the
> `qa_integrated_sales_posting` run creates them inside its transaction and
> rolls back. A real posting today would fail with the companion's
> NO-MAPPING guard, which is the intended behaviour.

**No mapping row was created or edited by this work.** Applying the table in
A.1 needs the real chart of accounts loaded into TEST first (source and scope
are your decision), then a single reviewed mapping pass.

---

## B. Access model as it exists (no change made)

### B.1 What the client can actually reach (measured, `scripts/qa_client_privileges.sql`)

Measured in a simulated PostgREST session (`SET ROLE authenticated` +
`request.jwt.claims`), rolled back afterwards:

| Action as the client role | Result |
|---|---|
| `SELECT sales.invoices` directly | **allowed** (RLS read policy) |
| `SELECT core.app_profiles` directly | **denied** `permission denied for table app_profiles` → role must come from `current_erp_role()` |
| `INSERT inventory.batches` directly | **allowed when the RLS policy passes** (`WITH CHECK can_write_inventory()`), denied otherwise |
| `INSERT fin.rpc_idempotency` (RLS disabled) | **denied** — pure ACL, no grant exists |
| call `post_inventory_transfer` | **executes** (gate → FIFO → value guard → idempotency) |
| `anon` on any of the 45 `public` functions | **denied** (0 EXECUTE), no USAGE on the ERP schemas |

Reading `has_table_privilege('authenticated', …)` returns `false` everywhere,
yet inserts on RLS-enabled tables reach the policy layer and succeed when the
policy allows — so **the RLS policy, not the ACL, is the effective barrier on
every ERP table**. Practical consequences:

* `inventory.batches` / `inventory.transactions` are writable **directly** by
  any role passing `can_write_inventory()` — there is no document linkage in the
  policy, so a warehouse role can insert stock rows without going through a
  document function. Tightening this to function-only is a recommended change
  (needs your approval; not made).
* `fin.rpc_idempotency` (RLS off) proves ACLs are enforced there — writing
  idempotency keys is only possible through the guarded functions.

### B.2 Role gates on the write functions

| Function | Gate | Effective roles |
|---|---|---|
| `fin.post_sales_invoice` (+ `public.` alias) | `role ∈ (Super Admin, Chief Accountant)` | Super Admin, Chief Accountant |
| `fin.post_journal` (+ `public.` alias) | `role ∈ (Super Admin, Chief Accountant)` | Super Admin, Chief Accountant |
| `public.post_sales_inventory_issue` | `role ∈ (Super Admin, Chief Accountant)` **AND** `can_write_inventory()` | **Super Admin only** |
| `public.post_sales_invoice_integrated` | same as above | **Super Admin only** |
| `can_write_master_data()` | Super Admin, General Manager, Chief Accountant, Sales Manager, Purchasing Manager, Warehouse Manager | — |
| `can_write_inventory()` | Super Admin, Warehouse Manager, Warehouse Employee, Production Manager | — |
| `can_read_module(module)` | includes **Viewer** for every module | read only |

`Viewer`: read-only confirmed end-to-end — REST probe returns
`unauthorized: ERP role for this user may not post sales journals`, and no gate
grants it write. Nothing was granted to Viewer.

### B.3 Least-privilege proposal (decisions, not applied)

1. **Keep integrated posting at Super Admin only.** It is the honest
   intersection: local `Chief Accountant` has `sales` without `post` and
   `inventory` = view/export only (`permissions.ts` MATRIX), so widening
   `can_write_inventory()` to them would *grant* inventory movement the local
   model denies. If the business wants Chief Accountant to post invoices
   end-to-end, that is a deliberate grant requiring your approval.
2. **Sales Manager** can post sales locally (`sales: ALL_ACTIONS`) but has no
   cloud posting path (no `accounting:post`, no inventory write). Decide whether
   that stays or changes; it is a product decision, not a technical one.
3. **Do not widen table grants.** Reads stay on the existing read RPCs; the
   dormant RLS policies should be either removed or backed by a deliberate
   grant in a later, reviewed migration.
4. **Defence in depth (optional):** `authenticated` holds EXECUTE on all 45
   functions, including the low-level `fin.post_*` ones; the only barrier is the
   in-function role gate (which passed every probe). Revoking EXECUTE on the
   `fin.*`/`public.post_sales_invoice` duplicates and keeping a single guarded
   entry point per document would shrink the surface.

---

## C. COGS journal ↔ invoice linkage (inspected, not modified)

### C.1 Behaviour today

* Sale journal: `fin.post_sales_invoice` inserts it with
  `source_document_type='sales_invoice'`, then sets
  `journal_entries.source_document_id = invoice id` **and**
  `invoices.journal_entry_id = sale JV id`.
* COGS journal: `public.post_sales_inventory_issue` posts it through
  `fin.post_journal`, which always inserts `source_document_id = NULL`; the
  companion then **overwrites** `invoices.journal_entry_id` with the COGS JV id.
* Net: the COGS entry is discoverable only by
  `reference = invoice_number AND source_document_id IS NULL`, and the invoice
  column ends up pointing at the *second* journal.

### C.2 Structural differences vs the local engine

| # | Local (`workflows.ts`) | Cloud (TEST) |
|---|---|---|
| 1 | **one** journal per invoice containing revenue + receivable/cash + VAT + COGS (`jvResult.entry`) | **two** journals: sale JV (570/570) + COGS JV (60/60) |
| 2 | `invoice.journalEntryId` = that single JV | `invoice.journal_entry_id` = COGS JV (sale JV loses the pointer) |
| 3 | every JV carries `sourceDocumentId` | COGS JV has `source_document_id = NULL` |
| 4 | balance is verified per JV by the app | verified per JV too — **parity holds on amounts**, differs on linkage |

Both journals balance and totals agree with local (proven by the 23/23 run);
the difference is **linkage, not amounts**. No historical row was changed.

### C.3 Compatible patch (ready, deliberately NOT applied)

```sql
-- inside public.post_sales_inventory_issue, right after the COGS journal posts
UPDATE fin.journal_entries
   SET source_document_id = v_inv.id
 WHERE id = v_journal_id;

UPDATE sales.invoices i
   SET journal_entry_id = (
         SELECT e.id FROM fin.journal_entries e
          WHERE e.source_document_id = v_inv.id   -- the sale JV, set by fin.post_sales_invoice
            AND e.id <> v_journal_id
          ORDER BY e.created_at
          LIMIT 1)
 WHERE i.id = v_inv.id
   AND EXISTS (SELECT 1 FROM fin.journal_entries e
                WHERE e.source_document_id = v_inv.id AND e.id <> v_journal_id);
```

Both columns already exist and the sale JV already carries
`source_document_id = invoice id`, so this is schema-compatible and touches only
future rows. It is **not applied** because it changes the function that the
accepted `23/23` run of `scripts/qa_integrated_sales_posting.sql` exercised —
applying it would require re-running that cycle, which you asked to keep frozen
until a new error appears.

---

## D. What is wired right now

| Screen | Source | Read | Write |
|---|---|---|---|
| items / customers / suppliers / warehouses / units | `erp_core_master_read`, `erp_master_cas`, `erp_warehouse_cas` | ✅ | ✅ CAS (master data only) |
| sales invoices + returns | `list_sales_invoices`, `list_sales_returns` | ✅ | ❌ |
| accounting (journals, trial balance) | `list_journal_entries`, `list_journal_lines`, `trial_balance` | ✅ | ❌ |
| inventory (batches, movements, on hand) | `list_inventory_batches`, `list_inventory_transactions`, `stock_on_hand` | ✅ | ❌ |
| purchasing | `list_purchasing_invoices`, `list_purchase_returns`, `list_purchasing_invoice_lines` | ✅ | ❌ |
| production | `list_production_orders` | ✅ | ❌ |
| representative custody | `list_representative_custodies`, `list_custody_movements` | ✅ | ❌ |
| treasury payments | `list_payments`, `list_treasury_transactions` | ✅ | ❌ |
| **banks** (this pass) | `list_bank_accounts`, `list_bank_transactions` | ✅ | ❌ |
| **cheques** (this pass) | `list_cheques` | ✅ | ❌ |
| **expenses** (this pass) | `list_expenses` | ❌→✅ | ❌ |
| **export shipments** (this pass) | `list_export_shipments` | ✅ | ❌ |
| dashboard, quality, costing, reports, users, audit | no read RPC exists | ❌ explicit "not available in cloud mode" | ❌ |
| sales posting (integrated) | `post_sales_invoice_integrated` | — | server-side verified (23/23), **not reachable from the UI** |

Cloud login: `src/services/cloudAuthGate.ts` is now a real, opt-in gate
(`VITE_ENABLE_SUPABASE_AUTH=true`), reading the role from `current_erp_role()`
(verified callable: returns `Viewer` for the QA account; `app_profiles` stays
denied) and failing closed. Posting stays unreachable from the UI until auth,
permissions, account mapping and a browser test are all done.
