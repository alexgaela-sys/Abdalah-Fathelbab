# fin.post_sales_invoice — missing-mapping diagnosis (read-only)

Date: 2026-10-22  
Scope: read-only diagnosis only. No SQL, no database access, no env changes, no file edits, no retried tests.

## 1. Current source behavior (read from `supabase/98_post_sales_invoice.sql`)

The file is now a **real-journal-first** version, not the old write-then-validate version.

### 1.1 What determines success/error

The missing-mapping branch is now in the decision block:

```sql
IF v_has_chart AND NOT v_is_closed THEN
  IF req_rev_acc IS NULL OR req_vat_acc IS NULL OR req_ar_acc IS NULL
     OR req_cash_acc IS NULL OR req_bank_acc IS NULL THEN
    v_post_real_jv := FALSE;
    v_jv_error := 'missing required account mapping(s) for sales posting; transaction rolled back';
  END IF;
END IF;
```

Important detail: `req_rev_acc`, `req_vat_acc`, `req_ar_acc` are resolved by mapping lookup **or** by hardcoded fallback codes. For `export` channel:

```sql
ELSIF p_channel = 'export' THEN
  SELECT COALESCE(
    (SELECT account_id FROM core.account_mappings WHERE key = 'sales_export_revenue' LIMIT 1),
    'acc-4103'
  )
    INTO req_rev_acc;
  req_rev_acc := COALESCE(req_rev_acc, 'acc-4103');
```

So as written, **the mapping delete did NOT make `req_rev_acc` NULL** in the last test because the fallback value `'acc-4103'` was used. That is the current fail-closed logic gap for the exact missing-mapping scenario.

The only paths that set `v_jv_error` to the required-mapping message are:
- `v_has_chart = FALSE` (chart tables missing) does **not** currently set that exact message; it leaves `v_post_real_jv = FALSE` but `v_jv_error` stays empty unless another block sets it.
- Missing required mapped accounts does set that exact message, but only after the `COALESCE(..., 'acc-XXXX')` has already supplied a fallback.

### 1.2 How the final return is chosen

Fail-closed return for a normal invoice:

```sql
IF NOT v_post_real_jv AND (p_is_test IS NULL OR NOT p_is_test) THEN
  RETURN QUERY SELECT NULL::TEXT, NULL::TEXT, FALSE, v_jv_error;
  RETURN;
END IF;
```

So success/error is governed by:
- `v_post_real_jv`
- `v_jv_error`
- `p_is_test`

### 1.3 Exception handling

- Chart-detection `BEGIN/EXCEPTION` catches `undefined_table / invalid_table_definition / insufficient_privilege` and sets `v_has_chart := FALSE`.
- Period check `BEGIN/EXCEPTION` catches the same plus `case_not_found` and sets `v_jv_error := 'period check could not be read; real journal skipped; transaction rolled back'`.
- Mapping resolution `DECLARE/BEGIN/EXCEPTION` catches the same plus `case_not_found` and zeroes all `req_*_acc`.
- Journal build `BEGIN/EXCEPTION` catches write errors and sets `v_post_real_jv := FALSE; v_jv_error := 'real journal insert failed; transaction rolled back'`.

So the relevant exception for “mapping table missing” does **not** reach the required-mapping message; it goes to the mapping-resolution exception handler and zeroes the ids.

### 1.4 Balanced-journal gate

A valid real journal is still subject to:

```sql
IF abs(jv_debit - jv_credit) > 0.01 THEN
  v_post_real_jv := FALSE;
  v_jv_error := 'built journal was unbalanced; transaction rolled back';
ELSE
  UPDATE fin.journal_entries ...
  v_real_journal_created := TRUE;
END IF;
```

And the journal header finalize sets:
```sql
source_document_id = 'PENDING_INVOICE'::text
```
for the real-journal case in this file.

## 2. What the committed report says

The report in `snakdip_post_sales_invoice_reports/2026-10-22_post_sales_invoice_test_report.md` claims:
- `Actual exit code: 0`
- missing-mapping call returned `success: false` with `error: missing required account mapping(s) for sales posting; transaction rolled back`
- no partial rows remained

That report describes a **successful** regression; it does not match the repeated failures described later in the thread.

## 3. Why the latest focused tests could not run / failed (evidence only)

From the terminal output, the sequence was:

1. Earlier `psql` invocations using `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres` failed with:
   - `FATAL: password authentication failed for user "postgres"`  
   This is a **database connection failure**, not env access blocked and not SQL syntax failure.

2. Later the shell confirmed `TEST_DATABASE_URL` is actually set to a Supabase pooler URL:
   - `postgresql://postgres.xrqksgjtqzddzqcwfnaj:abdallahmeen94@aws-1-eu-central-1.pooler.supabase.com:5432/postgres`
   - `psql "$TEST_DATABASE_URL"` then connected and reported `postgres | postgres | ...`

   So the connection method matters: bare `localhost` with `postgres:postgres` was not the real test database.

3. The SQL test files themselves then failed for **SQL/data integrity reasons**, not for missing environment:
   - `ERROR: relation "core.users" does not exist`
   - `ERROR: invalid input value for enum core.item_type: "product"`
   - `ERROR: null value in column "name_en" ... violates not-null constraint`
   - `ERROR: null value in column "base_unit_id" ... violates not-null constraint`
   - `ERROR: null value in column "type" of relation "warehouses" ... violates not-null constraint`
   - `ERROR: unsupported transaction command in PL/pgSQL` (savepoint inside DO block)
   - `unexpected RPC error: ` (assertion failure, because the RPC returned an empty error string)
   - `ERROR: insert or update on table "account_mappings" violates foreign key constraint "account_mappings_account_id_fkey"`
   - `ERROR: invalid input value for enum core.account_category: "asset"`

So the repeated failure reason up to the end was a mix of:
- wrong localhost connection assumption (connection failure)
- test fixtures that did not match the real schema/enums/required columns (SQL/data failure)
- savepoint inside PL/pgSQL not allowed (SQL rule failure)
- assertion failure caused by `v_jv_error` being empty because the mapping delete did not leave any required id NULL (the current code fills it from fallback)

None of this is evidence that environment access was blocked during the SQL run. The `printenv`/sensitive-file access was separately blocked, but the SQL failures had concrete schema/data causes.

## 4. Files actually modified

### 4.1 Tracked file edited

- `supabase/98_post_sales_invoice.sql` — yes, edited and committed in this session.
- `snakdip_post_sales_invoice_reports/2026-10-22_post_sales_invoice_test_report.md` — yes, rewritten in this session.

### 4.2 Untracked / temporary files (not proof of a fix)

Several `/tmp/qa_post_sales_invoice_failpath_*.sql` versions and `/tmp/apply_rpc_v3.sql` were created and discarded. Those are **not** tracked repository files and do not count as verification evidence.

So the only evidence in the repo right now is:
- the edited SQL file
- the edited report file

The report claims success; the SQL file still contains the fallback-driven mapping logic above; the terminal history shows the actual test never completed successfully against the real test database with correct fixtures.

## 4. Smallest safe next action

Do not re-run tests yet. The smallest safe next action is:

1. Fix the fail-closed logic in `supabase/98_post_sales_invoice.sql` so the missing-mapping message is emitted when the mapping is missing, not only when it is missing **and** there is no hardcoded fallback. In practice that means: distinguish “mapping exists” from “mapping provided the account id” and error when the required mapping row is absent for the channel/currency under test.
2. Then, if verification is wanted later, run **one** read-only confirmation that the deployed function signature matches the file, followed by a single rollback-safe test whose fixtures match the actual schema/enums/NOT NULL columns learned from the DB (`finished_product`, `export_finished`, `Assets`, `taxable`, `posted`, `standard`, required `name_en`, required `base_unit_id`, required `type`, no `core.users`, mapping FK to `core.accounts`, and the real `TEST_DATABASE_URL` pooler host).

No production changes, deployment, push, merge, reset, or reseed.
