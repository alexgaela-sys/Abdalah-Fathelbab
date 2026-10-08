// QA — UAT FIX REGRESSION (isolated, TEST-QA, non-destructive).
//
// Covers the fixes made for the UAT follow-up batch:
//   P0-1  representative-custody settlement (T-02 cash model + validation).
//         NOTE: T-01 (acknowledged settlement leaving unsold goods) is a
//         deliberate BUSINESS DECISION to leave as-is — it is MEASURED and
//         reported here, never asserted as fixed.
//   P0-2  rep-custody sale invoice visible in the customer statement
//         (cash custody sales are display-only — no journal is created).
//   P1-4  custody display unit label derives from the custody's own items.
//
// NON-DESTRUCTIVE: no reset, no reseed, no storage access. Every scenario runs
// on a freshly seeded SCRATCH in-memory DB; the pre-run snapshot is captured
// and restored byte-identically at the end, and zero test records survive.
//
// Run: bunx tsx scripts/qa_uat_fixes.ts
import { erpDb, createEmptyDatabase, applyMasterDataMigration, applyUomMigration } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { WorkflowService } from '../src/services/workflows';
import { LedgerService } from '../src/services/ledger';
import { custodyUnitLabel } from '../src/components/modules/RepresentativesView';

const snap = () => erpDb.getSnapshot();
const TODAY = new Date().toISOString().split('T')[0];
const RID = `UFX-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const ADMIN = { userId: 'usr-admin', userName: 'QA' };

let pass = 0;
let fail = 0;
const deferred: string[] = [];
function check(ok: boolean, label: string, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const note = (label: string, detail = '') => {
  deferred.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ℹ️  ${label}${detail ? ` — ${detail}` : ''}`);
};
const section = (t: string) => console.log(`\n=== ${t} ===`);

const PRISTINE_LIVE = JSON.parse(JSON.stringify(snap()));
const PRISTINE = JSON.parse(JSON.stringify(applyUomMigration(applyMasterDataMigration(createEmptyDatabase()))));

const acc = (code: string) => snap().accounts.find(a => a.code === code)?.currentBalance || 0;
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

function fresh() {
  erpDb.restore(JSON.parse(JSON.stringify(PRISTINE)));
  const sup = MasterDataService.createSupplier({ code: `${PFX}-SUP`, name: `مورد ${PFX}`, isTest: true, ...ADMIN } as never)!.supplier!;
  const cust = MasterDataService.createCustomer({ code: `${PFX}-CUST`, name: `عميل ${PFX}`, customerType: 'retail', channel: 'retail', isTest: true, ...ADMIN } as never)!.customer!;
  const custB = MasterDataService.createCustomer({ code: `${PFX}-CUSTB`, name: `عميل ب ${PFX}`, customerType: 'retail', channel: 'retail', isTest: true, ...ADMIN } as never)!.customer!;
  const rep = WorkflowService.createSalesRepresentative({ code: `${PFX}-REP`, name: `${PFX} مندوب`, targetMonthlySales: 0, isTest: true, ...ADMIN } as never).rep!;
  const fp = snap().items.find(i => i.code === 'FP-SNG-01')!;
  // FIXTURE: `returnGoodsFromRep` resolves the return cost through
  // `resolveActualUnitCost(item, wh, 0)`, which only looks at the item's
  // standard/actual cost — the seeded catalog ships FP-SNG-01 with 0/0, so a
  // return is refused before any assertion can run. Give the scratch product a
  // real cost equal to its purchase price. (This is a fixture gap, not a
  // product assertion being relaxed.)
  erpDb.mutate(draft => {
    const it = draft.items.find(i => i.id === fp.id);
    if (it) { it.standardCost = 60; it.actualCost = 60; }
  });
  const inv = WorkflowService.createPurchaseInvoice({
    supplierId: sup.id, warehouseId: 'wh-local', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `${PFX}-P`, date: TODAY,
    lines: [{ itemId: fp.id, quantity: 1000, unitId: 'unit-piece', unitPrice: 60, batchNumber: `${PFX}-B`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (!inv.success) throw new Error(`stock purchase failed: ${inv.error}`);
  const custody = WorkflowService.openRepCustody(rep.id, `${PFX} opening`);
  if (!custody.success) throw new Error(`open custody failed: ${custody.error}`);
  return { repId: rep.id, custId: cust.id, custBId: custB.id, custodyId: custody.custody!.id, itemId: fp.id, supplierId: sup.id };
}

function load(c: ReturnType<typeof fresh>, qty: number, itemId = c.itemId) {
  const r = WorkflowService.loadGoodsToRep({ custodyId: c.custodyId, itemId, quantity: qty, unitPrice: 100, warehouseId: 'wh-local', date: TODAY });
  if (!r.success) throw new Error(`load failed: ${r.error}`);
}
function sell(c: ReturnType<typeof fresh>, qty: number, paymentMethod: 'credit' | 'cash' = 'credit', customerId = c.custId) {
  const r = WorkflowService.createSalesInvoice({
    customerId, channel: 'retail', warehouseId: 'wh-local', repId: c.repId,
    stockSource: 'rep_custody', custodyId: c.custodyId, paymentMethod,
    currency: 'EGP', exchangeRate: 1, date: TODAY,
    lines: [{ itemId: c.itemId, quantity: qty, unitPrice: 100, vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (!r.success) throw new Error(`custody sale failed: ${r.error}`);
  return r.invoice!;
}
function ret(c: ReturnType<typeof fresh>, qty: number, itemId = c.itemId) {
  const r = WorkflowService.returnGoodsFromRep({ custodyId: c.custodyId, itemId, quantity: qty, warehouseId: 'wh-local', date: TODAY });
  if (!r.success) throw new Error(`return failed: ${r.error}`);
}
/** The UI call, transcribed from RepresentativesView.handleSettleCustody. */
function uiSettle(custodyId: string, cashCollected?: number, cashRefunded?: number, acknowledgeRemainingGoods = false) {
  return WorkflowService.settleRepCustody({
    custodyId,
    cashCollected: cashCollected && cashCollected > 0 ? cashCollected : undefined,
    cashRefunded: cashRefunded && cashRefunded > 0 ? cashRefunded : undefined,
    date: TODAY,
    acknowledgeRemainingGoods,
  });
}

function writes() {
  const db = snap();
  return {
    jv: db.journalEntries.length,
    audit: db.auditLogs.length,
    cm: db.custodyMovements.length,
    tx: db.inventoryTransactions.length,
    cash: db.treasuryTransactions.length,
    status: db.representativeCustodies.map(x => x.status).join(','),
    acc: ['1101', '1105', '1107', '1109'].map(c => `${c}=${acc(c).toFixed(2)}`).join(' '),
  };
}
const same = (a: ReturnType<typeof writes>, b: ReturnType<typeof writes>) => JSON.stringify(a) === JSON.stringify(b);
const diff = (a: ReturnType<typeof writes>, b: ReturnType<typeof writes>) =>
  `jv ${a.jv}→${b.jv}, audit ${a.audit}→${b.audit}, cm ${a.cm}→${b.cm}, tx ${a.tx}→${b.tx}, treasury ${a.cash}→${b.cash}, GL ${a.acc} → ${b.acc}`;

function balancedJournals(): { ok: boolean; detail: string } {
  let dr = 0, cr = 0;
  for (const j of snap().journalEntries) {
    if (!j.isPosted || j.isReversed) continue;
    for (const l of j.lines) { dr += l.debit || 0; cr += l.credit || 0; }
  }
  return { ok: near(dr, cr, 0.005), detail: `Dr ${dr.toFixed(2)} = Cr ${cr.toFixed(2)}` };
}

console.log('================================================================');
console.log(`🔬 UAT FIX REGRESSION — ${RID}`);
console.log('================================================================');

// ===========================================================================
section('P0-1 / S1 — zero-remaining custody settles cleanly (no cash)');
{
  const c = fresh();
  load(c, 200);
  sell(c, 200);
  const before = writes();
  const res = uiSettle(c.custodyId);
  const after = writes();
  check(res.success === true, 'S1 settlement succeeds', res.error || '');
  check(snap().representativeCustodies.find(x => x.id === c.custodyId)!.status === 'settled', 'S1 status → settled');
  check(near(acc('1107'), 0), 'S1 GL 1107 back to zero', acc('1107').toFixed(2));
  check(after.jv === before.jv, 'S1 cashless settlement posts NO journal');
  check(after.audit === before.audit + 1, 'S1 exactly one audit row', `${before.audit} → ${after.audit}`);
  const tb = balancedJournals();
  check(tb.ok, 'S1 every posted journal balances', tb.detail);
}

// ===========================================================================
section('P0-1 / S2 — unsold goods are refused with ZERO writes');
{
  const c = fresh();
  load(c, 200);
  sell(c, 120);
  const before = writes();
  const res = uiSettle(c.custodyId, 0, 0, false);
  const after = writes();
  check(res.success === false, 'S2 first attempt refused', res.error || '');
  check((res.unsoldGoods || []).length === 1 && res.unsoldGoods![0].remaining === 80, 'S2 unsoldGoods reported (80)', JSON.stringify(res.unsoldGoods));
  check(same(before, after), 'S2 refusal writes NOTHING', diff(before, after));
  check(snap().representativeCustodies.find(x => x.id === c.custodyId)!.status === 'open', 'S2 custody stays open');
}

// ===========================================================================
section('P0-1 / S3 — T-01 acknowledged settlement (DEFERRED by business decision)');
{
  const c = fresh();
  load(c, 200);
  sell(c, 120);
  const res = uiSettle(c.custodyId, 0, 0, true);
  const st = snap().representativeCustodies.find(x => x.id === c.custodyId)!.status;
  note('T-01 is deliberately NOT fixed in this batch', 'acknowledgeRemainingGoods still closes the custody');
  note('measured behaviour (unchanged)', `success=${res.success}, status=${st}, GL1107=${acc('1107').toFixed(2)}, warning=${res.warning ? 'yes' : 'no'}`);
  check(res.success === true && st === 'settled',
    'S3 acknowledged settlement behaves EXACTLY as before the batch (no accidental change to T-01)',
    `success=${res.success} status=${st}`);
}

// ===========================================================================
section('P0-1 / S4 — return the goods first, then settle (the clean path)');
{
  const c = fresh();
  load(c, 200);
  sell(c, 120);
  ret(c, 80);
  const res = uiSettle(c.custodyId);
  check(res.success === true && snap().representativeCustodies.find(x => x.id === c.custodyId)!.status === 'settled',
    'S4 return → settle completes', `success=${res.success} 1107=${acc('1107').toFixed(2)}`);
  note('S4 measured GL 1107 after load→sell→return→settle (see report: returnGoodsFromRep posts no journal)',
    `1107=${acc('1107').toFixed(2)}, 1109=${acc('1109').toFixed(2)}`);
}

// ===========================================================================
section('P0-1 / S5 — cash collection backed by a REAL custody cash sale (T-02)');
{
  const c = fresh();
  load(c, 200);           // 200 × 60 = 12,000 → Dr 1107
  sell(c, 100, 'cash');   // 100 × 100 = 10,000 cash, recognised in 1101 at posting
  sell(c, 100, 'credit'); // remaining 100 sold on credit
  const cashOnHand = 10000;
  const gl1107Before = acc('1107');
  const before = writes();
  const res = uiSettle(c.custodyId, cashOnHand, 0, false);
  const after = writes();
  console.log(`  1107 before settlement = ${gl1107Before.toFixed(2)}  →  after = ${acc('1107').toFixed(2)}`);
  console.log(`  1101 = ${acc('1101').toFixed(2)}   cashOnHand reported = ${res.cashOnHand}`);
  check(res.success === true, 'S5 settlement succeeds when the cash is real', res.error || '');
  check(res.cashOnHand === cashOnHand, 'S5 custody cash-on-hand = the cash sales of this custody', `${res.cashOnHand}`);
  check(res.cashCollected === cashOnHand, 'S5 cashCollected accepted', `${res.cashCollected}`);
  check(after.jv === before.jv, 'S5 NO settlement journal — the cash is already in 1101 from its own sale', `${before.jv} → ${after.jv}`);
  check(after.cash === before.cash, 'S5 NO duplicate treasury receipt', `${before.cash} → ${after.cash}`);
  check(acc('1107') >= -0.01, 'S5 GL 1107 is NOT driven negative (T-02 fixed)', acc('1107').toFixed(2));
  check(after.audit === before.audit + 1, 'S5 exactly one audit row');
}

// ===========================================================================
section('P0-1 / S6 — an UNBACKED settlement amount is refused with zero writes (E)');
{
  const c = fresh();
  load(c, 200);
  sell(c, 100, 'cash');   // cash on hand = 10,000
  sell(c, 100, 'credit'); // no unsold goods left, so the CASH guard is the one under test
  const before = writes();
  const res = uiSettle(c.custodyId, 999999, 0, false);
  const after = writes();
  check(res.success === false, 'S6 over-claim refused', res.error || '');
  check((res.error || '').includes('تجاوز النقد'), 'S6 refusal names the actual cash on hand', res.error || '');
  check(same(before, after), 'S6 refusal writes NOTHING', diff(before, after));
  check(near(acc('1107'), 0) || acc('1107') >= -0.01, 'S6 GL 1107 untouched', acc('1107').toFixed(2));
}

// ===========================================================================
section('P0-1 / S7 — cash REFUND: direction Dr 1107 | Cr 1101, balanced (D)');
{
  const c = fresh();
  load(c, 200);
  sell(c, 100, 'cash');
  sell(c, 100, 'credit');
  const before = writes();
  const res = uiSettle(c.custodyId, 10000, 3000, false);
  const after = writes();
  const jv = snap().journalEntries.filter(j => j.sourceDocumentType === 'rep_custody_settlement');
  check(res.success === true, 'S7 settlement succeeds', res.error || '');
  check(jv.length === 1, 'S7 exactly ONE journal (for the refund only)', `${jv.length}`);
  const j = jv[0];
  const dr = j.lines.reduce((s, l) => s + l.debit, 0);
  const cr = j.lines.reduce((s, l) => s + l.credit, 0);
  check(near(dr, cr), 'S7 journal balances', `Dr ${dr.toFixed(2)} Cr ${cr.toFixed(2)}`);
  const custodyLine = j.lines.find(l => l.accountCode === '1107');
  const cashLine = j.lines.find(l => l.accountCode === '1101');
  check(!!custodyLine && custodyLine.debit === 3000 && custodyLine.credit === 0,
    'S7 refund DEBITS 1107 (rep accountability grows)', JSON.stringify(custodyLine && { d: custodyLine.debit, c: custodyLine.credit }));
  check(!!cashLine && cashLine.credit === 3000 && cashLine.debit === 0,
    'S7 refund CREDITS 1101 (treasury OUT)', JSON.stringify(cashLine && { d: cashLine.debit, c: cashLine.credit }));
  check(acc('1107') >= -0.01, 'S7 GL 1107 never negative', acc('1107').toFixed(2));
  check(res.treasuryDelta === -3000, 'S7 treasuryDelta = the real treasury movement', `${res.treasuryDelta}`);
  check(after.cash === before.cash + 1, 'S7 one treasury cash_payment row', `${before.cash} → ${after.cash}`);
}

// ===========================================================================
section('P0-1 / S8 — refund greater than what was handed over is refused (E)');
{
  const c = fresh();
  load(c, 200);
  sell(c, 100, 'cash');
  sell(c, 100, 'credit');
  const b1 = writes();
  const r1 = uiSettle(c.custodyId, 0, 5000, false);
  const a1 = writes();
  check(r1.success === false, 'S8 refund with nothing collected refused', r1.error || '');
  check(same(b1, a1), 'S8 refusal writes NOTHING', diff(b1, a1));

  const c2 = fresh();
  load(c2, 200);
  sell(c2, 100, 'cash');
  sell(c2, 100, 'credit');
  const b2 = writes();
  const r2 = uiSettle(c2.custodyId, 1000, 5000, false);
  const a2 = writes();
  check(r2.success === false, 'S8 refund > cashCollected refused', r2.error || '');
  check(same(b2, a2), 'S8 refusal writes NOTHING', diff(b2, a2));
}

// ===========================================================================
section('P0-1 / S9 — double settlement stays refused with no duplicate writes (F)');
{
  const c = fresh();
  load(c, 200);
  sell(c, 200);
  const first = uiSettle(c.custodyId, 0, 0, false);
  const before = writes();
  const second = uiSettle(c.custodyId, 0, 0, false);
  const after = writes();
  check(first.success === true, 'S9 first settlement succeeds');
  check(second.success === false, 'S9 second settlement refused', second.error || '');
  check(same(before, after), 'S9 refused repeat writes NOTHING (no journal, no audit)', diff(before, after));
}

// ===========================================================================
section('P0-1 / S10 — mixed goods + cash in the same custody');
{
  const c = fresh();
  load(c, 300);
  sell(c, 150, 'credit');
  sell(c, 50, 'cash');       // 5,000 cash on hand, 100 units unsold
  const refused = uiSettle(c.custodyId, 5000, 0, false);
  check(refused.success === false && (refused.unsoldGoods || []).length === 1,
    'S10 unsold goods still block the settlement first', refused.error || '');
  const before = writes();
  const res = uiSettle(c.custodyId, 5000, 0, true);
  const after = writes();
  check(res.success === true, 'S10 acknowledged settlement completes', res.error || '');
  check(after.jv === before.jv, 'S10 cash leg still posts NO journal', `${before.jv} → ${after.jv}`);
  check(acc('1107') >= -0.01, 'S10 GL 1107 not negative', acc('1107').toFixed(2));
  note('T-01 still applies here (deferred): the acknowledged custody keeps its unsold-goods value in 1107', acc('1107').toFixed(2));
}

// ===========================================================================
section('P0-1 / S11 — load → sell → return → settle is not broken (H)');
{
  const c = fresh();
  const q0 = snap().batches.reduce((s, b) => s + b.quantity, 0);
  const v0 = snap().batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
  load(c, 100);
  sell(c, 40, 'cash');
  sell(c, 30, 'credit');
  ret(c, 30);
  const res = uiSettle(c.custodyId, 4000, 0, false);
  const q1 = snap().batches.reduce((s, b) => s + b.quantity, 0);
  const v1 = snap().batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
  const inv = ['1107', '1108', '1109', '1110', '1111', '1112'].reduce((s, k) => s + acc(k), 0);
  check(res.success === true, 'S11 full cycle settles', res.error || '');
  check(q1 < q0 && v1 < v0, 'S11 stock genuinely left the warehouse', `qty ${q0}→${q1}, value ${v0.toFixed(2)}→${v1.toFixed(2)}`);
  const residual = inv - v1;
  check(near(residual, 0, 0.05), 'S11 GL inventory (1107..1112) = batch ledger after the full cycle',
    `GL ${inv.toFixed(2)} − batches ${v1.toFixed(2)} = ${residual.toFixed(2)}`);
  const tb = balancedJournals();
  check(tb.ok, 'S11 all journals balance', tb.detail);
}

// ===========================================================================
section('P0-2 / ST — rep-custody sale invoice inside the customer statement');
{
  const c = fresh();
  const beforeStmt = LedgerService.buildCustomerStatement({ customerId: c.custId });
  const jvBefore = snap().journalEntries.length;
  const gl1105Before = acc('1105');

  // (1) credit sale from the custody
  load(c, 200);
  const creditInv = sell(c, 60, 'credit');
  const st1 = LedgerService.buildCustomerStatement({ customerId: c.custId });
  const creditRows = st1.rows.filter(r => r.documentNumber === creditInv.invoiceNumber);
  check(creditRows.length === 1, 'ST1 credit custody sale appears EXACTLY once', `${creditRows.length}`);
  check(creditRows[0]?.debit === 6000 && creditRows[0]?.credit === 0, 'ST1 debit = invoice value, credit = 0',
    JSON.stringify(creditRows[0] && { d: creditRows[0].debit, c: creditRows[0].credit }));
  check(creditRows[0]?.documentType === 'sales_invoice', 'ST1 classified as فاتورة مبيعات');
  check(creditRows[0]?.date === TODAY, 'ST1 date = invoice date', creditRows[0]?.date);
  check(near(st1.closingBalance, 6000), 'ST1 closing balance = invoice value', st1.closingBalance.toFixed(2));

  // (2) cash sale from the custody — display-only, no journal
  const cashInv = sell(c, 40, 'cash');
  const jvAfterCashSale = snap().journalEntries.length;
  const gl1105AfterCashSale = acc('1105');
  const st2 = LedgerService.buildCustomerStatement({ customerId: c.custId });
  const cashRows = st2.rows.filter(r => r.documentNumber === cashInv.invoiceNumber);
  const jvAfterStatement = snap().journalEntries.length;

  check(cashRows.length === 1, 'ST2 cash custody sale appears EXACTLY once', `${cashRows.length}`);
  check(cashRows[0]?.debit === 4000 && cashRows[0]?.credit === 4000,
    'ST2 row carries the invoice debit AND its cash settlement credit (net 0)',
    JSON.stringify(cashRows[0] && { d: cashRows[0].debit, c: cashRows[0].credit }));
  check(cashRows[0]?.documentType === 'sales_invoice', 'ST2 classified as فاتورة مبيعات (survives the docType filter)');
  check(cashRows[0]?.date === TODAY, 'ST2 date = invoice date', cashRows[0]?.date);
  check(jvAfterStatement === jvAfterCashSale, 'ST2 opening the statement creates NO journal entry',
    `${jvAfterCashSale} → ${jvAfterStatement}`);
  check(near(st2.closingBalance, st1.closingBalance), 'ST2 cash sale does NOT move the customer balance',
    `${st1.closingBalance.toFixed(2)} → ${st2.closingBalance.toFixed(2)}`);
  check(near(st2.openingBalance + st2.totalDebit - st2.totalCredit, st2.closingBalance),
    'ST2 statement arithmetic holds (opening + debits − credits = closing)');
  check(near(acc('1105'), gl1105AfterCashSale, 0.005), 'ST2 GL 1105 untouched by the statement');
  check(near(st2.cardBalance, st2.closingBalance), 'ST2 card balance = statement closing balance',
    `card ${st2.cardBalance} vs stmt ${st2.closingBalance}`);
  check(new Set(st2.rows.map(r => r.id)).size === st2.rows.length, 'ST2 no duplicated row ids');
  check(jvAfterCashSale > jvBefore, 'ST2 the cash SALE itself still posts its own revenue journal (unchanged)');

  // (3) more than one invoice for the same customer
  const second = sell(c, 10, 'credit');
  const st3 = LedgerService.buildCustomerStatement({ customerId: c.custId });
  check(st3.rows.filter(r => r.documentNumber === creditInv.invoiceNumber).length === 1 &&
        st3.rows.filter(r => r.documentNumber === cashInv.invoiceNumber).length === 1 &&
        st3.rows.filter(r => r.documentNumber === second.invoiceNumber).length === 1,
    'ST3 every invoice appears once, none duplicated');
  check(near(st3.closingBalance, 7000), 'ST3 closing = 6,000 + 1,000 (the cash invoice nets to zero)', st3.closingBalance.toFixed(2));

  // (4) the document-type filter keeps the cash invoice
  const filtered = LedgerService.buildCustomerStatement({ customerId: c.custId, docType: 'sales_invoice' });
  check(filtered.rows.some(r => r.documentNumber === cashInv.invoiceNumber) &&
        filtered.rows.every(r => r.documentType === 'sales_invoice'),
    'ST4 "فواتير المبيعات فقط" filter shows both invoices and nothing else');

  // (5) other customers are untouched
  sell(c, 5, 'credit', c.custBId);
  const stB = LedgerService.buildCustomerStatement({ customerId: c.custBId });
  const stA = LedgerService.buildCustomerStatement({ customerId: c.custId });
  check(stB.rows.length === 1 && stB.rows[0].documentNumber !== creditInv.invoiceNumber,
    'ST5 customer B sees only its own invoice', stB.rows.map(r => r.documentNumber).join(','));
  check(!stA.rows.some(r => r.documentNumber === stB.rows[0]?.documentNumber),
    'ST5 customer A does not see customer B rows');
  check(near(stA.closingBalance, 7000), 'ST5 customer A balance unchanged by B', stA.closingBalance.toFixed(2));

  // (6) building statements never writes anything
  const jvEnd = snap().journalEntries.length;
  LedgerService.buildCustomerStatement({ customerId: c.custId });
  LedgerService.buildCustomerStatement({ customerId: c.custBId });
  check(snap().journalEntries.length === jvEnd, 'ST6 statements are pure reads — no writes');
  check(near(acc('1105'), gl1105Before + 7500, 0.05),
    'ST6 GL 1105 moved only by the CREDIT sales (no accidental AR movement for the cash sale)',
    `1105=${acc('1105').toFixed(2)} expected ${(gl1105Before + 7500).toFixed(2)}`);
}

// ===========================================================================
section('P1-4 / U — custody display unit label (display only, quantities untouched)');
{
  const c = fresh();
  load(c, 100);
  const beforeQty = snap().batches.reduce((s, b) => s + b.quantity, 0);
  const beforeVal = snap().batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
  const beforeGl = acc('1107');
  const beforeCm = snap().custodyMovements.length;

  const label = custodyUnitLabel(snap(), c.custodyId);
  check(label === 'قطعة', 'U1 custody holding a PCS item is labelled قطعة (was a global fallback)', label);

  const rep2 = WorkflowService.createSalesRepresentative({
    code: `${PFX}-REP2`, name: `${PFX} مندوب 2`, targetMonthlySales: 0, isTest: true, ...ADMIN,
  } as never).rep!;
  const emptyCust = WorkflowService.openRepCustody(rep2.id, `${PFX} empty`);
  check(!!emptyCust.custody && custodyUnitLabel(snap(), emptyCust.custody!.id) === 'قطعة',
    'U2 custody with no movements falls back to قطعة',
    emptyCust.custody ? custodyUnitLabel(snap(), emptyCust.custody.id) : emptyCust.error || '');

  // U4 must bracket ONLY the label computation — no stock movement in between.
  const afterQty = snap().batches.reduce((s, b) => s + b.quantity, 0);
  const afterVal = snap().batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
  check(afterQty === beforeQty && near(afterVal, beforeVal),
    'U4 the label computation changed NO quantity or value',
    `qty ${beforeQty}→${afterQty}, value ${beforeVal.toFixed(2)}→${afterVal.toFixed(2)}`);
  check(near(acc('1107'), beforeGl), 'U4 GL 1107 unchanged by the label', `${beforeGl.toFixed(2)}→${acc('1107').toFixed(2)}`);
  check(snap().custodyMovements.length === beforeCm, 'U4 custody movements unchanged by the label');

  // second item with a DIFFERENT base unit
  const kgItem = snap().items.find(i => i.id === 'item-raw-chip')!;
  const sup = snap().suppliers.find(s => s.code === `${PFX}-SUP`)!;
  const pinv = WorkflowService.createPurchaseInvoice({
    supplierId: sup.id, warehouseId: 'wh-local', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `${PFX}-KG`, date: TODAY,
    lines: [{ itemId: kgItem.id, quantity: 50, unitId: 'unit-kg', unitPrice: 50, batchNumber: `${PFX}-KG`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (pinv.success) {
    load(c, 10, kgItem.id);
    const mixed = custodyUnitLabel(snap(), c.custodyId);
    check(mixed === 'قطعة / كيلوجرام', 'U3 custody holding two units labels BOTH units', mixed);
  } else {
    check(false, 'U3 second item could not be stocked', pinv.error || '');
  }
}

// ===========================================================================
section('INTEGRITY — trial balance and clean-up');
{
  const tb = balancedJournals();
  check(tb.ok, 'every posted journal in the run balances', tb.detail);
}

erpDb.restore(JSON.parse(JSON.stringify(PRISTINE_LIVE)));
const identical = JSON.stringify(snap()) === JSON.stringify(PRISTINE_LIVE);
const leftovers = [
  snap().items.filter(i => i.isTest).length,
  snap().customers.filter(x => x.isTest).length,
  snap().suppliers.filter(x => x.isTest).length,
  snap().salesReps.filter(x => x.isTest).length,
  snap().batches.filter(b => String(b.batchNumber).includes('TEST-QA')).length,
  snap().representativeCustodies.filter(x => String(x.notes || '').includes(PFX)).length,
  snap().journalEntries.filter(j => String(j.reference || '').includes(PFX) || String(j.description || '').includes(PFX)).length,
].reduce((a, b) => a + b, 0);
check(identical, 'in-memory database restored BYTE-IDENTICALLY to the pre-run state');
check(leftovers === 0, 'ZERO test records survived the run', `${leftovers} leftover(s)`);

console.log('\n================================================================');
console.log(`RESULT — ${pass} passed, ${fail} failed`);
console.log('================================================================');
if (deferred.length) {
  console.log('\nDEFERRED (measured, deliberately not fixed in this batch):');
  deferred.forEach(d => console.log(`  • ${d}`));
}
process.exit(fail > 0 ? 1 : 0);
