# MANUAL BROWSER TEST PROCEDURE — Batch I (search/filter/sort/print) and Batch J (mobile/responsive)

**STATUS: NOT TESTED / MANUAL / BLOCKED in this environment.**

Why: every harness in this project runs the services under `bunx tsx`, which has no
`localStorage`, no DOM and no rendering. Search, filter, sort, pagination, print
preview and responsive layout live in React components (`src/components/**`) and can
only be verified in a real browser. Nothing in this document is claimed as passing.

How to run these: `bun run dev` (or the managed preview), open the app, sign in as
`admin`. Every step below is written so it can be executed and signed off by a human.

---

## BATCH I — SEARCH / FILTER / SORT / PRINT

For each module repeat the steps with the module's own data. Record PASS/FAIL with
the expected vs actual rows.

### I-1 Customers (`CustomersView`)
1. Open Customers.
2. Search: type a partial Arabic name (e.g. `عميل`). Expected: only matching rows.
3. Filter: status = active / inactive. Expected: counts match the row list.
4. Sort: click code, name, balance headers in turn. Expected: monotonic order, no row loss.
5. Pagination: set page size to the smallest option, jump to the last page.
   Expected: total count is unchanged; no duplicated or missing row.
6. Print/preview: use the print action. Expected: printed rows = on-screen rows.

### I-2 Sales invoices (`SalesView`)
- Combinations to test (all of them):
  - customer + date range + status
  - warehouse + item + date
  - channel (retail / export) + payment method + status
- Sort by date, number, total. Expected: order correct, totals unchanged.

### I-3 Purchasing (`PurchasingView`)
- supplier + invoice status + date range; sort by due date; filter overdue only.

### I-4 Inventory (`InventoryView`)
- warehouse + item + batch; search by batch number; sort by quantity / value.
- Confirm the inventory count screen lists only the chosen warehouse.

### I-5 Production (`ProductionView`)
- production status (draft / released / in_progress / completed) + product filter.
- Sort by order date and by produced quantity.

### I-6 Treasury / cheques / banks
- cheque status filter (received / under_collection / collected / bounced / returned).
- date range on the treasury ledger. Expected: opening + in − out = closing shown.

### I-7 Representatives
- representative filter + date range on custody movements.

### I-8 Export
- export/local filter; date range; expected revenue/collection totals unchanged.

### I-9 Reports
- customer statement, AR aging, trial balance, inventory valuation.
- For each: change the date range and confirm the totals move consistently with the
  underlying documents (this is the same identity the automated Batch H harness
  asserts numerically).

### I-10 Export / download of every list
- Export each list to the supported format and confirm: row count equals the on-screen
  count, Arabic text is not mojibake, RTL column order is preserved, numbers keep their
  decimals and dates are ISO or clearly formatted.

---

## BATCH J — MOBILE / RESPONSIVE

Test at exactly **360×800**, **390×844**, **412×915** (Chrome DevTools device toolbar,
or a real phone). For each size visit every module and check the list below.

Modules: Dashboard · Sidebar · Items/Products · Raw materials · Customers · Suppliers ·
Purchasing · Sales · Inventory · Production · Quality · Treasury · Cheques ·
Representatives · Reports · Settings.

At each module check:

| # | Check | How | Expected |
|---|---|---|---|
| J1 | Horizontal overflow | scroll right; check `document.documentElement.scrollWidth` vs `clientWidth` | no page-level horizontal scroll |
| J2 | Hidden buttons | open each action menu | every action reachable, nothing clipped |
| J3 | Unreachable controls | open each modal / drawer | close button and footer buttons reachable without a zoom-out |
| J4 | Modal overflow | open a long list modal | list scrolls inside the modal, header/footer stay visible |
| J5 | Table overflow | open each table | either responsive cards or an intentional horizontal scroll — no content cut off |
| J6 | Arabic RTL | read every screen right-to-left | correct RTL, numbers and IDs still LTR |
| J7 | Text clipping | long item/customer names | truncated with ellipsis or wrapped, never cut mid-glyph |
| J8 | Dropdown positioning | open every dropdown near the bottom edge | menu opens upward or stays on screen |
| J9 | Keyboard obstruction | focus the last input, open the on-screen keyboard | the focused field is not hidden |
| J10 | Sticky headers | scroll a long list | header stays, rows scroll under it |
| J11 | Sidebar behaviour | open/close the drawer, rotate the device, go back a route | drawer opens, closes, and does not trap the user |
| J12 | Touch targets | measure every tappable control | ≥ 44×44 px recommended; flag anything smaller |
| J13 | Forms on mobile | submit each form (item, customer, invoice, payment, cheque) | numeric/keyboard types are right, submit is reachable, no keyboard-cover |

### Sign-off template

| Size | Module | Check that failed | Expected | Actual | PASS/FAIL |
|---|---|---|---|---|---|

---

## Notes for the tester

- Do not use `resetToClean()` or `clearTestDataOnly()` on a database that holds real
  entries; both destructive entry points are still flagged
  **BUSINESS DECISION REQUIRED** (see the QA report, Batch K item K20).
- When a screen looks wrong, capture the exact filter combination and the row count
  before and after the action — that is what turns a visual bug into a reproducible one.