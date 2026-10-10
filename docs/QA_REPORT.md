# Abdullah ERP — MASTER QA REPORT (full break-test, Phases 1–48, Scenarios A–AG, Batches A–O)

## 1. Environment
- Runtime: Bun + `bunx tsx` (Node 22). TypeScript 7. `tsc -b --noEmit` clean.
- Storage under test: **client-side, in-memory/localStorage**. Every harness runs under
  `tsx`, which has **no `localStorage` and no DOM** → results are in-memory service behaviour only.
- Convex is not part of this repo.
- No dev server was ever started; delivery is via the Freebuff Changes panel.

## 2. Repository / branch / commit
- Repo root `/home/daytona/codebase`, branch `main`, HEAD `e62049b` (all work uncommitted).
- Modified: `src/services/{db,inventory,manufacturing,masterData,workflows}.ts`, `src/types/erp.ts`, `package.json`.
- Added harnesses: `scripts/qa_break_test.ts`, `qa_break_test2.ts`, `qa_inventory_recon.ts`,
  `qa_wh02_trace.ts`, `qa_partial_production.ts`, `qa_cheques.ts`, `qa_migration.ts`,
  `qa_reports.ts`, `qa_permissions.ts`, `qa_e2e.ts`, `qa_performance.ts`; docs: `docs/QA_REPORT.md`,
  `docs/QA_MANUAL_BROWSER_TESTS.md`.

## 3. Baseline
Clean DB: 30 items, 0 customers, 5 warehouses, 48 accounts, 12 BOMs, 5 open/closed periods,
0 journals. Every harness snapshots counts + all account balances + bank balances and restores them.

## 4. Commands executed (real exit codes, final run)
| Command | Exit |
|---|---|
| `bun tsc --noEmit` | 0 |
| `bun run verify` | 0 |
| `bun run regression` | 0 (21/21) |
| `bun run audit` | 0 (27/27) |
| `bun run uafix` | 0 (55/55) |
| `bun run masteruat` | 0 (192/192) |
| `bun run auditfix` | 0 (191/191) |
| `bun run qa1` | 0 (35/35 probes) |
| `bun run qa2` | 0 (102 probes, 102 safe — P41 resolved, see §35.1) |
| `bun run qaprvariance` (purchase-return price variance) | 0 (9/9) |
| `bun run qapartial` | 0 (15/15) |
| `bun run qa3` (cheques) | 0 (85/85) |
| `bun run qa4` (migration) | 0 (28/28) |
| `bun run qa5` (reports) | 0 (27/27) |
| `bun run qa6` (permissions) | 0 (26/26) |
| `bun run qa7` (e2e + reconciliation) | 0 (57/57) |
| `bun run qa8` (performance) | 0 (17/17) |
| `bun run qa_inventory_recon` | 0 (0/11 flows with a residual) |
| `bun run qa_wh02_trace` | 0 |
| `bun run build` | 0 |

Total new assertions this session: **404** (qa3 85, qa4 28, qa5 27, qa6 26, qa7 57, qa8 17, qapartial 15 = 255)
plus the previously existing qa1/qa2 probes.

## 5–21. Reconciliation results
| Area | Result |
|---|---|
| GL / Trial balance | Debits = credits at every checkpoint; **every posted journal individually balanced**; every account balance = sum of its journal lines (natural side) — **PASS** |
| Inventory GL vs batch ledger | **0.00** across 11 measured flows; full-lifecycle delta **0.00** — **PASS** |
| Batch ledger | Per-stage valuations tie to GL — **PASS** |
| AR subledger vs GL 1105 | **0.00** (statement `cardDiff` and `glDiff` both 0.00 in every case) — **PASS** |
| AP subledger vs GL 2101 | **0.00** — **PASS** |
| Treasury vs GL 1101 | **0.00** (ledger is derived from the cash journal, so it cannot drift) — **PASS** |
| Bank EGP cards vs GL 1102 | **0.00** after the Batch-F fix — **PASS**; USD card deliberately separate |
| Cheques vs GL 1104 / 2102 | **0.00** — **PASS** |
| Manufacturing | 400 + 600 = 1,000 single-stage cost, **residual 0.00**; QC-failure FG ties to 0.00 — **PASS** |
| QC | Defective/scrap held in 1111/1112 and reconciled — **PASS** |
| Export | FX applied **exactly once** (USD 200 × 50 = 10,000 into 1106 at invoice, cleared once at collection) — **PASS** |
| Costing | Stage unit cost 280.718375 / 280.718333 vs order average 280.718350 — **PASS** |
| Reports | GL, TB, statements, aging, treasury, valuation, movement, sales, purchase, COGS, gross profit, bank, cheques, warehouse balances, export — expected/actual/difference printed for each — **PASS** |

## 22–27. Reports, permissions, security, mobile, performance, migration
- **Reports**: 27/27 numeric reconciliations. **NOT IMPLEMENTED** (recorded, not skipped): supplier
  statement, AP aging/buckets, cheque-register overdue report.
- **Permissions**: 26/26. Full role matrix matches the documented matrix for all 13 roles; every
  unauthorized create/edit/post/payment/cheque/close/stock attempt refused; self-escalation,
  self-activation, permission-granting and role switching all refused; inactive user refused
  everywhere; Super Admin still allowed (the matrix is not "deny all").
- **Security**: 2 findings recorded without code change (see §28), no hard-coded secrets.
- **Mobile / search / filter / sort / print (Batches I, J)**: **NOT TESTED / MANUAL** — no browser
  in this environment. Full procedure written to `docs/QA_MANUAL_BROWSER_TESTS.md`.
- **Performance (Batch L)**: measured, 1,000 customers / 1,008 suppliers / 1,030 items /
  5,000 sales / 5,000 purchases / 10,000 movements / 2,000 journals (10,000 lines) / 1,000 production
  orders built in 87.9 ms, cleaned up in 6.0 ms. Slowest surface **AR aging 274.6 ms** (it replays a
  statement per customer — O(customers × documents), the first thing to optimise if customer count
  grows). GL 23.4 ms, treasury 25.2 ms, TB 1.6 ms, sales report 3.9 ms, search 0.1 ms, sorts ≤0.5 ms.
  Browser render latency **NOT TESTED / MANUAL**.
- **Migration (Batch G)**: 28/28. Synthetic legacy DB with customers, suppliers, products, raw
  materials, warehouses, accounts, BOM, invoices, a half-produced order, stock, opening balances and a
  journal. IDs, codes, names, BOM ids/versions/effective dates, stock quantities, batch costs, balances,
  journals and documents all preserved; runs 2 and 3 byte-identical (idempotent); full difference report
  printed. One gap found and fixed (see F-BATCH-G-01).

## 28–29. Bugs found / bugs fixed
**Fixed this session (technical, each with a permanent regression):**
1. **F-BATCH-D-01 — staged production costed cumulatively.** `recordDailyProduction` divided the
   order's cumulative cost by the current stage's units, re-charging stage 1 on stage 2
   (batch ledger 415,405.70 vs GL 280,718.35 → residual **+134,687.35** in this harness,
   −120,887.35 in qa2 before the fix). Fixed: each stage books only its own incremental cost via a
   running `cumulativeCapitalizedCost` on the order (additive optional field, pro-rata fallback for
   legacy orders). **400 + 600 = 1,000 in one stage, residual exactly 0.00.**
2. **F-BANK-01 — bank card never moved on cheque clearance.** GL 1102 moved by the full amount while
   `bankAccounts.currentBalance` stayed put (card Δ 0.00 vs GL Δ 10,000.00). Fixed in
   `updateChequeStatus` for both incoming (collected) and outgoing (paid).
3. **F-CHQ-01 — cheque payment without a cheque number was accepted**: GL 1104 was debited and AR
   relieved while **no cheque record existed** (value with no subledger and no clearance path). Fixed.
4. **F-CHQ-02 — duplicate cheque number accepted for the same customer** in the payment path
   (`registerCheque` already rejected it) → double 1104 and double AR relief. Fixed, customer and supplier.
5. **F-CHQ-03 — impossible cheque dates accepted** (`2026-13-45`, due date before issue date) in the
   payment path. Fixed with the same documented rules `registerCheque` uses.
6. **F-CHQ-04 — `registerCheque` accepted `2026-02-31`**: the ISO regex passed a non-existent calendar
   date. Fixed to a real round-trip date check. Side effect proven: this leak had left 100.00 stranded
   in 2102 and −100.00 on the AP card in the qa3 run.
7. **F-BATCH-G-01 — legacy chart of accounts never completed.** A legacy install missing 1107/1109/
   1111/1112 keeps every existing account, but the accounting engine rejects any journal touching a
   missing code, so production receipt, custody, QC waste and internal transfer all break on that
   install. Fixed: `applyMasterDataMigration` now adds ONLY missing canonical accounts (id-stable,
   additive, idempotent — runs 2/3 change nothing, no account renamed or re-balanced).

**Open / recorded, not fixed:**
- **K-BATCH-01 (MEDIUM)**: `InventoryEngine.recordMovement()` carries no permission guard of its own —
  it is protected only by the guard of the calling workflow. No UI exploit path exists today
  (`InventoryView` goes through `postInventoryCount`), but an engine-level guard would deny legitimate
  cross-role flows (Purchasing Manager has `purchasing:create` but only `inventory:view`), so this is
  a policy question, not a code fix.
- **K-BATCH-02 (observation)**: the seeded Super Admin `admin` has a 5-character password, below the
  6-character rule `createUser` enforces. Changing the documented credential is an ops decision.

## 30. Business decisions required (untouched, by design)
1. Fractional PCS in the canonical kraft BOM (66.667 PCS / 1000).
2. Export AR currency basis: customer card in USD vs GL 1106 in EGP (document vs base currency).
3. Custody valuation basis (GL 1107 at FIFO cost vs custody subledger at the supplied price).
4. Unlimited overpayment (cheque/cash above the outstanding balance is accepted and shown as an advance).
5. Future / back-dated posting (a closed period is correctly refused; open periods allow back-dating).
6. **FG receipt posts no journal** — there is no WIP account, and none was invented.
7. Destructive entry points `resetToClean()` / `clearTestDataOnly()` are permission-free methods on the
   database singleton, reachable from `SettingsView.tsx:134,142` and `TestRunnerModal.tsx:40,50` —
   confirmation/audit policy undecided.
8. Whether a returned supplier invoice may still be paid by cheque.
9. COGS standard-vs-actual basis (sales lines store standard cost; the GL issues at FIFO actual).

## 31–33. NOT TESTED / BLOCKED / manual
- **Browser-dependent** (search, filter, sort, pagination, print/preview, export files, RTL rendering,
  responsive 360×800 / 390×844 / 412×915): **NOT TESTED / MANUAL** — procedure in
  `docs/QA_MANUAL_BROWSER_TESTS.md`.
- Cheque deposit→clearance→**bounce after funds left the account** beyond the state machine; supplier
  cheque due-date clearing against a **real bank date** (tested with synthetic dates).
- Browser render/paint latency: NOT TESTED.
- Excel import: NOT IMPLEMENTED in the product (not a bug).

## 34. Data safety verification
No database reset, no `localStorage.clear()`, no destructive reseed, no UAT deletion, no master
price/balance overwritten. Every synthetic record is `TEST-QA-[run-id]`. Final run cleanups report:
leftover masters 0, leftover cheques 0, leftover users 0, leftover synthetic rows 0,
journals back to 0/0, account + bank balances restored = true, document counts restored = true
(in every one of the 9 harnesses).

## 35. Regression results
Full green: 21 + 27 + 55 + 192 + 191 + 35 + 15 + 85 + 28 + 27 + 26 + 57 + 17 + 0/11 recon + build.
`qa2` is **green for the first time: 102/102, exit 0**, with the P41 residual at exactly **0.00**
(−120,887.35 → +1,000.00 → 0.00 across the Batch-D fix and the fix below).

### 35.1 P41 root cause (resolved)
A read-only tracer (`bun run qa_p41_trace` — `scripts/qa_p41_trace.ts`) wraps the ERP service classes
and then runs the **unmodified** qa2, measuring ΔGL vs Δbatch ledger per warehouse for every
transaction. The residual had **two independent causes, neither of them in Scenario T**:

1. **Application defect — `WorkflowService.postPurchaseReturn`** (the first transaction to move the
   residual). It credits the supplier at the *invoice* price (100 kg × 60 = 6,000) but relieves
   inventory at the goods' *FIFO book* cost (5,000). The gap was absorbed by a clause commented
   *"Balance any rounding difference into inventory credit side"* that fired on a **material 1,000
   EGP difference**, over-crediting GL 1108 and permanently desynchronising it from the batch ledger.
   Fixed: the plug is gone and the difference is posted as a **material price variance to 5103
   `فروق أسعار شراء المواد`** — an account that already existed in the chart *and* in the account
   mapping (`variance_material_price`) but was used nowhere in the application.
2. **QA-harness defect — qa2's `injected` tracker.** It added `qty × cost` on every `receive()` but
   never removed the 2,000 of journal-less stock that Scenario T then issued straight through
   `InventoryEngine.recordMovement`. This is *not* an application defect: a direct issue correctly
   posts no journal (no WIP account exists for a raw-material issue). The tracker now follows the
   goods out as well as in, measuring the batch-ledger delta rather than assuming `qty × cost`.

−1,000 (application) + 2,000 (tracker) = the +1,000 that was reported. Both were required; fixing only
the application moved the reported residual to +2,000 because the tracker defect was then exposed.
No assertion was weakened or deleted: P41's formula and tolerance are unchanged, and the probe count
went **101 → 102** (a new assertion pins that the tracker follows goods out).

Permanent regression: `scripts/qa_purchase_return_variance.ts` (`bun run qaprvariance`, 9/9, exit 0) —
a deterministic fixture (same item, two prices 10/20, cheaper batch older so FIFO takes it, return
raised against the 20-priced invoice naming no batch). With the fix disabled it reproduces
`ΔGL −2,000.00 vs Δbatch −1,000.00 → residual −1,000.00` and exits 1; with the fix it is 0.00 and
exits 0.

## 36. OPEN UAT FINDING — partial production closure (Batch Q)

**Investigation only. Nothing was fixed. No application source was modified in this batch.**

Diagnostic: `scripts/qa_partial_closure.ts` (`bun run qapartialclose`). It executes three scenarios
through the real service layer, each in a freshly seeded database so every figure is attributable to
that scenario alone, then restores the exact in-memory database it started with.

| Scenario | Planned | Issued | Produced | Defective | Scrap | Unproduced |
|---|---|---|---|---|---|---|
| A | 1,000 | 1,000 (296,283.35) | 700 | 0 | 0 | 300 |
| B | 1,000 | 1,000 (296,283.35) | 700 | 15 | 5 | 300 (285 counted as output) |
| C | 1,000 | **1,400** (414,796.70) | 700 | 0 | 0 | 300 |

### Observed classification: **E** — the order closes while the unproduced quantity is unexplained

- `closeProductionOrder` **succeeds** on all three partial orders. Status goes `in_progress → completed`.
- `remainingQuantity` stays at **300 on a completed order**. The 300 unproduced units are never
  resolved, never written off, never carried as WIP, and never reported to the user.
- Partial behaviour **A** (auto-return) does exist and does fire: `closeProductionOrder` returns
  `unusedShare = 1 − produced/planned` of every issued line to WH-01 through
  `InventoryEngine.recordMovement(movementType: 'production_return')`. Scenario A returned 88,885.00
  of 296,283.35 — physically correct, and the batch ledger shows it.

So the honest answer is **E with a partial A**: materials are silently returned, but nothing tells
the user that, nothing records why 300 units vanished, and nothing reconciles the return in the GL.

### Findings

**Q-01 — DEFECT. A partial order closes with the unproduced quantity unexplained.**
`remainingQuantity = 300` survives into `status: 'completed'`. There is no prompt, no confirmation,
no blocking rule, and no audit entry describing the disposition of the unproduced quantity. Any
figure reporting "planned" against a closed order is silently wrong by 300.

**Q-02 — DEFECT. The auto-return is never credited back in the GL.** Measured on scenario A:
```
Δ GL inventory (1107..1112) =        +304.50
Δ batch-ledger value       =     +88,885.00
RESIDUAL (ΔGL − Δbatches)  =     −88,580.50
```
Decomposition, exactly: `+304.50` conversion credited from 6101 into FG (real value, no batch)
`− 88,885.00` returned raw material sitting in WH-01 **with no GL credit**. `recordMovement` posts
no journal, and `closeProductionOrder` credits GL 1108 with the FULL issued cost (296,283.35)
rather than the consumed cost, so the returned 88,885.00 is debited out of raw inventory but never
credited back. **GL 1108 understates the warehouse by 88,885.00 EGP.** The diagnostic asserts the
residual equals this exact figure (it does), which pins the cause.

**Q-03 — the returned material lands in NEW auto-numbered batches**
(`BATCH-20261004-EW-02R`, …) rather than the original issue batches. Lot number, production date and
expiry of returned stock are lost, so FIFO and expiry reporting on re-issued material are wrong.

**Q-04 — DEFECT. Over-issue is never reconciled.** Scenario C issued 1.4× the plan (8,295.934 units),
produced 700, consumed 4,147.967, returned 2,488.780 — and **1,659.187 units stayed charged to the
order**. The return is a flat 30% of the ISSUED quantity (`1 − produced/planned`), not of what was
consumed, so over-issued material is silently capitalised into finished goods. The same 700 units are
booked at **593.00 EGP/unit instead of 423.70** — a 40% unit-cost inflation.

**Q-05 — the same GL/batch break of −90,884.94 occurs when the partial order also books defective and
scrap output**, confirming the defect is in the close path, not specific to the all-good case.

### No WIP mechanism exists
Measured, not inferred: **0** accounts mention WIP / "تحت التشغيل", **0** `accountMappings` keys
mention WIP, **0** warehouses could hold production custody. Account 1107 is
`عهد مناديب المبيعات` (sales-rep custody) and is unrelated to production. There is no WIP account,
no WIP mapping and no production-custody location. Issued material therefore has **nowhere** to sit
between issue and consumption — it is either in WH-01 or gone. This is the same root cause already
recorded as an open business decision ("FG receipt posts no journal because no WIP account exists").

### Status: **FAIL** — DEFECT / OPEN UAT FINDING

Closing a partial production order is **not safe**. It succeeds, it returns the right quantity of
material to the warehouse, but it (a) closes with an unexplained 300 units, (b) leaves GL 1108
88,885.00 EGP adrift from the physical ledger, (c) destroys batch traceability on the return, and
(d) inflates finished-goods unit cost under over-issue.

**Note on existing coverage:** `qa_inventory_recon` flow #2 ("production LIFECYCLE") ties at 0.00 only
because it produces 1,000 of 1,000 planned. It never exercises the partial case, which is why this
defect survived a green reconciliation suite.

### Recommended fix — **NOT IMPLEMENTED**
1. **Block or confirm the close.** `closeProductionOrder` must refuse (or require an explicit,
   recorded disposition) while `remainingQuantity > 0`. Introduce an explicit close mode —
   `complete` (produced = planned) vs `close_short` — and on `close_short` force the user to state
   the reason for the unproduced quantity, persist it on the order and write it to the audit log.
2. **Credit the return in the GL.** Add a raw-inventory credit leg for `materialReturnedCost` to the
   closing journal (or a separate `production_return` journal), so GL 1108 nets to the consumed
   share only. This alone closes the −88,580.50 residual.
3. **Return to the original batches.** Pass the consumed batches back on `production_return` instead
   of letting `recordMovement` mint a new batch number, preserving lot/expiry/production date.
4. **Reconcile against actual consumption, not the planned ratio.** Base the return on
   `Σ actualQuantity consumed` rather than `1 − produced/planned`, and surface any residual
   (issued − consumed − returned) as an explicit variance line rather than capitalising it into FG.
5. **Decide the WIP question.** Either add a WIP account + mapping so issued-but-unconsumed material
   has a real home, or document formally that the product does not support WIP and that any
   in-between state is unrepresentable.

## 37. OPEN UAT FINDING — physical inventory count lists 0 items (Batch R)

**Status: diagnostic only. NO application source was modified. Fix NOT implemented.**

### 37.1 The reported symptom
`محضر جرد فعلي وتسوية الفروق المخزنية` → every stocked warehouse renders
`الجرد يشمل أصناف المستودع المختار فقط (0 صنف)` with an empty item table.

### 37.2 Data path (traced, not inferred)
| Step | Location |
|---|---|
| View | `src/components/modules/InventoryView.tsx` (modal title :461, count label :478) |
| Open handler | `InventoryView.tsx:105-124` `handleOpenPhysicalCount` |
| Warehouse change | `InventoryView.tsx:126-131` `handleCountWarehouseChange` |
| Warehouse → logic | `countWarehouseId` state (:31); `<select value={countWarehouseId}>` (:467-476) |
| Row builder | `items.map(itm => getItemBalance(itm.id, wh)).filter(x => x.systemQty !== 0)` (:112-119, :128-130) |
| Balance source | `InventoryEngine.getItemBalance` — `src/services/inventory.ts:128-133` |
| **Sole source data** | **`db.batches`** (`b.itemId`, `b.warehouseId`, `b.quantity`) |

### 37.3 What was proven by execution (`scripts/qa_inventory_count_items.ts`)
- The builder is **correct**. With real batches it returns rows and agrees with the
  `أرصدة المستودعات الحالية` tab on all 5 warehouses: WH-01=2, WH-02=1, WH-03=1, WH-04=0, WH-05=0.
- `getItemBalance` is correct; batch ledger and movement ledger agree exactly.
- Every `batch.warehouseId` resolves to a warehouse master record (0 orphans); the `<select>` uses
  `w.id` (never `w.code`), so **B (id/code mismatch) is ruled out**.
- No inactive-item filter, no `quantity > 0` filter, no item-type/UOM filter, no negative-balance
  filter in the count path — **D, E and F are ruled out**.
- The count builder and the balances tab use the same source through two different expressions and
  **can never disagree** → a stocked warehouse that renders rows on the balances tab cannot render 0
  in the count. **A (UI-only rendering) is ruled out.**

### 37.4 Root cause — G: the count document reads the BATCH LEDGER ONLY
The item list has **no fallback to the GL inventory accounts and no fallback to stock documents**.
Reproduced twice in the harness:

1. **Empty batch ledger** → all 5 warehouses report `(0 صنف)`.
2. **GL-only stock** — a posted opening-balance journal of 370,000 EGP on 1108/1109 with
   `batches.length === 0` → GL reports 370,000 EGP of inventory, and **every warehouse still
   reports `(0 صنف)`**.

`createEmptyDatabase()` ships `batches: []` (`db.ts:1161`) and `load()` merges a legacy store with
`...parsed` (`db.ts:1502-1515`), so a database saved before the batch ledger existed — or any store
whose stock was established as an accounting opening balance rather than as a receipt — carries
inventory in GL with nothing in `batches`. The count document is then structurally empty.

### 37.5 Secondary defect (independent, reproduced)
`unitCost` is hard-coded to `0` on every count line (`InventoryView.tsx:120`, `:131`), so
`diffCost = diff * line.unitCost` (`:496`) is **always `0.00`**. The `فارق التكلفة` column is dead
even when items do load — one of the fields the UAT note lists as expected.

### 37.6 Scope
**All warehouses. All item types. All UOMs.** The `!== 0` filter operates on an empty ledger, so the
zero is warehouse-independent, item-independent and UOM-independent. It is NOT specific to WH-01,
WH-02, batch-tracked warehouses, or the browser build.

### 37.7 Is the data safe?
Yes. Nothing in this diagnostic writes to `src/`, and the harness asserts the in-memory database is
restored byte-identical with 0 `TEST-QA` records left. **No fix was implemented, so no accounting or
valuation behaviour was altered.** Note the live PC store is browser localStorage
(`abdullah_erp_db_v1`) and is untouched by this batch.

### 37.8 Minimal proposed fix (DESCRIPTION ONLY — not implemented)
1. Populate the count line's `unitCost` from `InventoryEngine.getItemValue(itemId, wh) / systemQty`
   (the actual FIFO batch cost) instead of the literal `0`, so `فارق التكلفة` becomes meaningful.
2. Decide the source-of-truth question: either (a) seed an opening batch layer per item/warehouse when
   an opening-balance journal is posted, so GL and the batch ledger agree; or (b) add an explicit
   "no batch layer for this item — enter the physical quantity only" mode so the document is usable
   instead of silently empty.
3. Optional hardening: surface a warning in the modal when a warehouse has GL inventory but no batch
   layer, instead of rendering `(0 صنف)` as if the warehouse were genuinely empty.

**Accounting impact of the fix:** adding the batch layer (2a) *increases* inventory in the batch
ledger to match GL — it does not move value between accounts, so it must be proven to leave
`qa_inventory_recon` at residual 0.00. The cost-variance fix (37.5/37.1) is display-only and posts
nothing.

### 37.9 Permanent regression test proposal
Add `scripts/qa_inventory_count_gate.ts` (read-only, TEST-QA prefixed) asserting:
1. for every warehouse with `Σ batches > 0`, the transcribed count builder returns a row per stocked
   item, and the count equals the balances-tab count;
2. every returned row's `systemQty` equals `InventoryEngine.getItemBalance(itemId, wh)` and is non-zero;
3. a warehouse whose stock exists only as a GL opening balance is **flagged**, not silently empty;
4. no row is emitted for an item with zero balance in the selected warehouse;
5. `unitCost` is non-zero for every row whose balance value is non-zero.

### 37.10 Verification run
| Command | Exit |
|---|---|
| `bunx tsc --noEmit` | **0** |
| `bun run qacountitems` (new) | **0** — 11/11 |
| `bun run qa_inventory_recon` | **0** — 0/11 flows with a residual |
| `bun run qa7` | **0** — 57/57 |
| `bun run qaprvariance` | **0** |
| `src/` mtimes | unchanged (newest `db.ts` 10-04 06:49, predates this batch) |

## 38. OPEN UAT FINDING — UOM conversion between Purchase → Inventory → BOM → Production (Batch S)

**Status: diagnostic only. NO application source, BOM, item master or conversion was modified. Fix NOT implemented.**

### 38.1 Reported symptom
Item `RM-CHIP-01` base unit = KG. Purchased 10 (no separate purchase unit) → stock = 10 KG.
BOM expresses the requirement in GRAM. Production Requirements then shows
`المطلوبة 70 جرام · المتاح بالمستودع 10 جرام · غير كافٍ` — although 10 KG = 10,000 GRAM,
i.e. ≈142 producible units.

### 38.2 Root cause
**`db.unitConversions` has ZERO consumers in the business logic.**
`grep -c unitConversions src/services/{manufacturing,inventory,workflows}.ts` = **0 / 0 / 0**.
The table is seeded (`db.ts:180-187`) and migrated (`db.ts:1290`, `1423-1450`) and never read again.
Both directions exist and are correct (`gram→kg = 0.001`, `kg→gram = 1000`) — they are simply never applied.

Consequence: **a quantity is always interpreted in the item's BASE unit, no matter what unit the BOM line
is written in.** `ManufacturingEngine.calculateBomRequirements` (`manufacturing.ts:142-179`) returns
`requiredQuantity` computed in `line.unitId` and `availableStock` read as a raw base-unit number, then
labels both with `unitsMap.get(line.unitId)`. Nothing checks that `line.unitId !== item.baseUnitId`,
and `validateBomPayload` (`manufacturing.ts:1094-1112`) contains **no unit-consistency rule**.

### 38.3 Expected vs Actual — the reported case (base KG, BOM 70 GRAM)

| Quantity | EXPECTED | ACTUAL (measured) |
|---|---|---|
| المطلوب | 70 جرام (= 0.070 KG) | 70 جرام — correct |
| المتاح | 10,000 جرام (= 10 KG) | `10 جرام` — the raw base-unit number relabelled |
| كافٍ؟ | نعم | `false` |
| Units producible | 10,000 / 70 = **142.857** | engine reports a shortfall |

### 38.4 Observed behaviour (all asserted by execution, `scripts/qa_uom_conversion.ts`)

| # | Scenario | Observed |
|---|---|---|
| A | base KG, bought 10 KG, BOM 70 GRAM | prints `المطلوبة 70 جرام` / `المتاح 10 جرام` / `كافٍ=false`. Ground truth 10 KG = **10,000 GRAM** = **142.857 units** |
| B | base KG, 100 KG stock, BOM 70 GRAM | issue **ALLOWED**, batch 100 → 30 — **70 KG removed for a 70 GRAM requirement (1000× over-consumption)** |
| C | base KG, 1 KG stock, BOM **5 GRAM** | **BLOCKED** — `الرصيد المتاح ... هو 1 ولا يكفي لصرف 5` |
| D | base KG, 1 KG stock, BOM **0.005 KG** | **ALLOWED** |
| E | base **GRAM**, 10,000 GRAM stock, BOM 0.07 KG | prints `المتاح 10000 كيلوجرام` (really 10 KG); issue deducts **0.07 GRAM instead of 70 GRAM** |
| F | full lifecycle | material cost **4,200.00 EGP instead of 4.20**; FG unit cost **4,200.44 instead of 4.20** |

**C vs D is the decisive proof:** 5 GRAM and 0.005 KG are the *same physical requirement*, yet one is
blocked and the other is allowed, against the identical 1 KG stock.

### 38.5 Blast radius — NOT display-only
| Layer | Impact | Evidence |
|---|---|---|
| Requirements screen | wrong unit label + wrong sufficiency verdict | A |
| **Material issue** | **physical over/under-consumption of the batch** | B, E |
| **Production consumption** | `actualQuantity` stored in base unit, `ProductionConsumption` has **no unit field** — 70 and 0.07 are indistinguishable in the record | B, E |
| **Batch quantities** | FIFO batches decremented by the wrong amount | B, E |
| **Inventory valuation** | FG batch carries 4,200.44 EGP instead of 4.20 | F |
| **Production costing** | `actualMaterialCost` = 4,200.00 instead of 4.20 (1000×) | F |
| **GL / balance sheet** | 1108 credited **−4,200.00** (correct ≈ −4.20); 1109 debited **+4,200.44** | F |

The corruption is **silent**: `production_issue` posts no journal (ΔGL = 0.00), and every journal that
is posted balances correctly, because the wrong quantity really was removed and really was valued at FIFO.
No ledger check catches it.

### 38.6 Exact files / functions responsible
| File | Function / line | Role |
|---|---|---|
| `src/services/manufacturing.ts` | `calculateBomRequirements` **:142-179** | compares `requiredQuantity` (BOM unit) against `availableStock` (base unit) — **primary defect** |
| `src/services/manufacturing.ts` | `issueMaterialsToOrder` **:429-...** | `stock < req.quantity` pre-check and `quantityOut: req.quantity` — no conversion |
| `src/services/manufacturing.ts` | `validateBomPayload` **:1094-1112** | no rule forbidding `line.unitId !== material.baseUnitId` |
| `src/services/manufacturing.ts` | `recordDailyProduction` **:546** | consumes `actualQuantity` from the uncorrected ledger |
| `src/services/inventory.ts` | `getItemBalance` **:128-133** | returns a base-unit number with no unit awareness |
| `src/services/inventory.ts` | `recordMovement` **:345** | applies `quantityOut` verbatim to base-unit batches |
| `src/components/modules/ManufacturingView.tsx` | **:1127, :1138-1139** | prints `req.requiredQuantity` and `req.availableStock` under `req.unitNameAr` |
| `src/types/erp.ts` | `ProductionConsumption` | **no `unitId` field** — a mis-stored quantity cannot be audited |
| `src/services/db.ts` | `INITIAL_UNIT_CONVERSIONS` **:180-187** | correct factors, zero consumers |

### 38.7 Severity: **BLOCKER**
Not cosmetic. A wrong quantity silently becomes a wrong *cost*: one finished unit was capitalised at
**4,200.44 EGP instead of 4.20 EGP**, and GL 1108/1109 carry the same 1000× misstatement. Every
downstream COGS, margin, stock valuation and financial statement built on FG inherits it. It also
**blocks legitimate production** (scenario C) — so it is simultaneously a false-negative availability
and a false-positive posting.

### 38.8 Is the existing data safe?
This batch changed nothing: `src/` mtimes unchanged (`db.ts` 10-04 06:49, `manufacturing.ts` 10-03 19:12
— all predate this batch), no BOM / item / conversion was edited, no reset or reseed was run, and the
diagnostic restores the in-memory DB **byte-identical** with **0 TEST-QA records** surviving
(each scenario runs in its own scratch DB).

**However — the risk to live UAT data is real and must be stated plainly:** because the seeded
`ensureTestBom` fixture writes chips/oil/sauce BOM lines in `unit-kg` and the seeded items are KG-based,
the standard fixture path is unaffected. But **any** BOM line whose `unitId` differs from its material's
`baseUnitId` — in live UAT data or in a hand-built BOM — silently corrupts costing.

### 38.9 Proposed permanent regression test (NOT implemented)
`scripts/qa_uom_gate.ts`, asserting:
1. **Unit consistency invariant** — for every `bomLine`, `line.unitId === item.baseUnitId`; any violation fails.
2. **Conversion round-trip** — `convert(q, gram→kg) * 1000 === q` and the inverse, for every pair in `db.unitConversions`.
3. **Equivalence** — a requirement of 5 GRAM and one of 0.005 KG against the same stock must produce the same
   `sufficient` verdict and the same physical deduction.
4. **Symmetry** — the GRAM-base / KG-BOM case must behave identically to the KG-base / GRAM-BOM case.
5. **Cost guard** — material cost for a BOM line must equal `qty × FIFO unit cost` **after** conversion to the base unit;
   a 1000× deviation must fail.
6. **Consumption auditability** — `ProductionConsumption` must carry the unit it was recorded in.

### 38.10 Can Manual UAT continue?
**Not safely — this must be fixed before the UAT continues.** The blocker is not the screen: it is that
production **can post** on a silently mis-stated quantity and capitalise FG at 1000×. Every FG valuation,
COGS and margin figure produced during UAT is suspect if any BOM line mixes units with its material.
A safe interim rule for the UAT team (no code change): **express every BOM line in the material's own base unit.**

### 38.11 Verification run
| Command | Exit |
|---|---|
| `bunx tsc --noEmit` | **0** |
| `bun run qauom` (new) | **0** — 23/23 |
| `bun run qa1` / `qa2` / `qa7` | **0** |
| `bun run qa_inventory_recon` | **0** — 0/11 flows with a residual |
| `bun run qaprvariance` / `qacountitems` | **0** |

## 39. OPEN UAT FINDING — Settle Representative Custody (Batch T)

**Status: read-only diagnostic. NO application source was modified. Fix NOT implemented.**

### 39.1 The UI action and its service
| Step | Location |
|---|---|
| Button `تسوية العهدة` | `src/components/modules/RepresentativesView.tsx:533-537` (rendered only while `cust.status === 'open'`) |
| Click handler | `RepresentativesView.tsx:145-193` `handleSettleCustody(custodyId)` |
| Service called | `WorkflowService.settleRepCustody` — `src/services/workflows.ts:3369` |
| Arguments passed by the UI | `custodyId, cashCollected, cashRefunded, date, acknowledgeRemainingGoods` — **no `userId`, no `userName`, no `isTest`** (`:151-157`) |
| Service guards | custody must exist; `status !== 'open'` → `العهدة تمت تسويتها بالفعل`; QA-20 unsold-goods guard (`:3408-3416`); cash must be non-negative |

### 39.2 EXPECTED vs ACTUAL

| # | Scenario | EXPECTED | ACTUAL (measured) |
|---|---|---|---|
| **A** | load 200, sell 200 → settle | completes, 1107 = 0 | ✅ `success=true`, status `open→settled`, 1107 = 0.00, audit row written |
| **B1** | load 200, sell 120 → settle | blocked, custody stays open | ✅ `success=false`, `العهدة CUST-2026-0001 ما زالت تحتوي على بضاعة غير مباعة (سنجل فاير سويت: 80)...`, `unsoldGoods=[{remaining:80}]`, no partial write |
| **B2** | B1 then acknowledge = true | the 80 unsold units must be resolved before closing | ❌ **DEFECT T-01** — settlement completes, custody → `settled`, but **GL 1107 keeps 4,800.00 EGP** and **no inventory movement returns the 80 units** |
| **C** | settle twice | second refused, zero writes | ✅ `success=false`, `العهدة تمت تسويتها بالفعل`, 0 journal / 0 audit rows written |
| **D** | settle with 5,000 cash collected | 1107 credit matched by a custody-cash debit | ❌ **DEFECT T-02** — journal `Dr 1101 / Cr 1107` is **balanced (5,000 = 5,000)** but **1107 goes 0.00 → −5,000.00** |

### 39.3 Reproduction steps (isolated, TEST-QA, `bun run qacustodysettle`)
```
1. Create rep + customer + TEST-QA supplier; buy 500 PCS of FP-SNG-01 into wh-local @60
2. openRepCustody(rep)                         → CUST-2026-0001 (open)
3. loadGoodsToRep(custody, 200)                → Dr 1107 / Cr 1109
4. createSalesInvoice(stockSource='rep_custody', 120, credit)
   B2: click تسوية العهدة → prompt 0/0 → service refuses → confirm "موافق"
       ⇒ success=true, status=settled, GL 1107 = 4,800.00 with 80 units still at the rep
   D : step 3 with 200, sell 200, click تسوية العهدة → prompt 5000
       ⇒ journal CUST-SETTLE-CUST-2026-0001 balanced, but GL 1107 = -5,000.00
```

### 39.4 Classification of the "button does not complete" symptom
**A real, intentional business-rule validation — not a defect.**
`RepresentativesView.tsx:161-176` already handles the QA-20 refusal: it shows the unsold items and asks the
user to confirm acknowledgement, then re-submits. Nothing is swallowed — there is **no exception, no service
error and no UI wiring fault** in this path. The action "not completing" is the guard working as designed
and asking the user to either return the goods or acknowledge them.

### 39.5 DEFECTS found (reported, NOT fixed)

**T-01 — MEDIUM/HIGH — acknowledged settlement orphans the unsold goods.**
`workflows.ts:3408-3416` lets the caller push past the unsold-goods guard, then `:3462` flips the custody to
`settled` with **no inventory movement and no GL adjustment** for the remaining goods.
Measured: `success=true`, `status=settled`, **GL 1107 = 4,800.00 EGP stranded on a closed custody**, 80 units
physically with the rep and owned by no document. The returned `warning` field carries the text, but nothing
posts it. Correct behaviour (proven in scenario B-alt): returning the goods first gives `success=true` and
**1107 = 0.00**.

**T-02 — HIGH — settling the rep's collected cash drives account 1107 NEGATIVE.**
`workflows.ts:3440-3441` posts `Dr 1101 cash / Cr 1107 custody`. But the rep's cash was **never debited into
1107** — the custody sale credits revenue to AR (1105) and debits 1107 only for the *goods* cost. So the
settlement credits an account that holds nothing. Measured: **1107 = 0.00 → −5,000.00 EGP**, a negative asset
balance with no asset behind it. The journal itself is balanced and the treasury ledger row is correct, so
the error is silent. `cashRefunded` (`:3444`) has the mirror problem on the other leg.

### 39.6 Accounting verification
- Settlement journals **balance** in every case (D: Dr 5,000.00 = Cr 5,000.00).
- Account **1107 is used**, and 1101 for treasury — the mapping is right; the *direction* is not (T-02).
- The settlement amount is **not validated against the outstanding custody**: any positive cash figure is
  accepted, and it is never compared with what the rep actually owes.
- GL 1107/1109 signs go negative in the load→sell→return lifecycle (1109 = −12,000.00 after loading to a rep),
  which is consistent with value living in 1107, but it means **1107's sign is the only signal** — and T-02
  breaks exactly that signal.

### 39.7 Inventory verification
- Load, sale and return produce exactly **2 warehouse inventory movements** (`rep_loading`, `rep_return`) and
  **3 custody movements** — **no duplicates, no phantom rows**. The custody sale correctly moves no warehouse stock.
- After load → sell → return the total GL inventory (1107…1112) = **22,800.00** and the batch ledger =
  **22,800.00**, **residual 0.00**. Inventory is internally consistent.
- **But T-01 leaves 80 units outside both the batch ledger and any document** once the custody is closed.

### 39.8 Audit trail
`workflows.ts:3500-3509` writes an `auditLogs` row on every successful settlement (module `المناديب - تسوية العهد`,
action `approve`, record id = custody id) including the unsold count and the treasury net — measured 8→9 in
scenarios A and B2. **The refused first click writes nothing** (measured: journals 3→3, audit 9→9), so a
refusal leaves no trace — acceptable, but worth knowing when reconstructing history.

### 39.9 Severity
- **T-01 — MEDIUM/HIGH.** Silent loss of custody of goods plus a stranded GL balance. Detectable only by
  comparing GL 1107 against open custodies.
- **T-02 — HIGH.** Produces a negative asset account through a perfectly balanced journal. Every rep-custody
  settlement that carries cash does this.

Overall the **action itself is not broken** — the failure the UAT team saw is the QA-20 guard behaving
correctly. The two defects are in what happens *after* the user gets past it.

### 39.10 Proposed permanent regression test (NOT implemented)
`scripts/qa_custody_settle_gate.ts`, read-only and TEST-QA isolated:
1. zero-remaining settle → `success=true`, `status='settled'`, GL 1107 = 0, exactly one audit row;
2. unsold settle without acknowledgement → `success=false`, `unsoldGoods` populated, **zero writes of any kind**;
3. acknowledged settle with unsold goods → **must NOT leave GL 1107 ≠ 0** on a `settled` custody (fails today — T-01);
4. cash settle → **1107 must not go negative** and the cash amount must be reconciled against what the rep
   collected (fails today — T-02);
5. double settle → `success=false` and zero duplicate journals/audit rows;
6. every settlement journal balances, and the load→sell→return cycle leaves ΔGL(inventory) = Δbatch ledger = 0.

### 39.11 No live UAT data was changed
- `src/` mtimes unchanged (`workflows.ts` 10-03 21:13 predates this batch) — **0 application-source changes**.
- The diagnostic restores the in-memory database **byte-identically** to its pre-run state (asserted, `true`)
  and leaves **0 test records** (`TEST-QA` items/customers/suppliers/reps, batches, custodies, custody
  movements, journals) because every scenario runs in its own freshly seeded scratch DB.
- No browser `localStorage` was opened, no reset/reseed/clear was run, no accounting rule, mapping, item, BOM
  or transaction was changed. Nothing committed, nothing pushed (HEAD unchanged, index empty).

### 39.12 Verification run
| Command | Exit |
|---|---|
| `bunx tsc --noEmit` | **0** |
| `bun run qacustodysettle` (new) | **0** — 26/26 |
| `bun run qa_inventory_recon` | **0** — 0/11 flows with a residual |
| `bun run qa1` | **0** |
| `bun run qa2` | **0** |
| `bun run qa7` | **0** |
| `bun run qaprvariance` | **0** |
| `bun run qauom` | **0** |
| `bun run qacountitems` | **0** |
| `bun run qapartial` | **0** — 15/15 |

`bun run qapartialclose` was **not** re-run for this batch; it exits 1 by design, its failures being the
Batch-Q findings reported in §36.

## 40. Final limitations
- All conclusions are about the **service layer in Node**. No claim is made about the browser build.
- Two harnesses assert against numbers produced by the same engine they test (self-consistency), which
  is why the per-flow residual probe and the full-lifecycle matrix both exist independently.
- Performance numbers are single-run in-memory measurements, not browser frame/render timings.
- The 2,000-unit FIFO/journal-less harness movement inside qa2 used to be the one place where a residual
  is provably caused by the test harness rather than the product. That tracker defect is now fixed
  (§35.1); the journal-less nature of the operation itself is unchanged and is reported as such rather than
  closed.