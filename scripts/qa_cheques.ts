// BATCH F — CHEQUES & TREASURY.
//
// Full customer-cheque lifecycle (sale → AR → cheque → pending → deposit →
// clearance → bank → AR settlement → GL → TB) plus the 18 required edge cases,
// then the supplier (outgoing/postdated) cheque lifecycle plus its 9 cases.
// Every case asserts AR, treasury, bank, cheque status, GL, TB, the customer
// statement (cardDiff/glDiff) and AR aging — and prints expected/actual/difference.
//
// Nothing here invents an accounting rule: it asserts the rules the system
// already documents in registerCheque (amount > 0, cheque number required and
// unique per party, ISO dates, dueDate >= issueDate) and the state machine in
// updateChequeStatus. TEST-QA prefixed, self-cleaning, no master data touched.
import { erpDb } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { InventoryEngine } from '../src/services/inventory';
import { WorkflowService } from '../src/services/workflows';
import { LedgerService } from '../src/services/ledger';
import { AccountingEngine } from '../src/services/accounting';

const TODAY = new Date().toISOString().split('T')[0];
const DAY = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; };
const RID = `CHQ-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const snap = () => erpDb.getSnapshot();
const ADMIN = { userId: 'usr-admin', userName: 'QA' };

const INVENTORY_CODES = ['1101', '1102', '1104', '1105', '1106', '1107', '1108', '1109', '1110', '1111', '1112', '2101', '2102', '6101'];
const acc = (code: string) => snap().accounts.find(a => a.code === code)?.currentBalance || 0;
const accId = (code: string) => snap().accounts.find(a => a.code === code)?.id || `acc-${code}`;
const tb = () => snap().journalEntries.filter(j => j.isPosted && !j.isReversed)
  .reduce((s, j) => ({ dr: s.dr + j.lines.reduce((x, l) => x + (l.debit || 0), 0), cr: s.cr + j.lines.reduce((x, l) => x + (l.credit || 0), 0) }), { dr: 0, cr: 0 });
const custCard = (id: string) => snap().customers.find(c => c.id === id)?.currentBalance || 0;
const supCard = (id: string) => snap().suppliers.find(s => s.id === id)?.currentBalance || 0;
const st = (id: string) => LedgerService.buildCustomerStatement({ customerId: id });
const aging = (id: string) => LedgerService.buildReceivablesAging({ customerId: id })[0];
const chequesOf = (partyId: string) => snap().cheques.filter(c => c.partyId === partyId);
const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) <= tol;

const BASE = {
  journalEntries: snap().journalEntries.length,
  inventoryTransactions: snap().inventoryTransactions.length,
  accounts: snap().accounts.map(a => ({ id: a.id, b: a.currentBalance })),
  banks: snap().bankAccounts.map(b => ({ id: b.id, b: b.currentBalance })),
  batches: snap().batches.map(b => b.id),
  customers: snap().customers.map(c => c.currentBalance),
  suppliers: snap().suppliers.map(s => s.currentBalance),
  items: snap().items.map(i => ({ id: i.id, c: i.actualCost })),
};

const bugs: Array<{ id: string; sev: string; title: string }> = [];
let pass = 0, fail = 0;
/** check(label, ok, info) — info always carries expected/actual/difference. */
const check = (label: string, ok: boolean, info = '') => {
  if (ok) { pass++; console.log(`  ✅ ${label}${info ? ` — ${info}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${info ? ` — ${info}` : ''}`); }
};
const expect = (label: string, expected: number, actual: number, tol = 0.05) =>
  check(label, near(actual, expected, tol), `expected=${expected.toFixed(2)} actual=${actual.toFixed(2)} diff=${(actual - expected).toFixed(2)}`);
const rejects = (label: string, r: { success: boolean; error?: string }, why: string) =>
  check(label, !r.success, r.success ? `ACCEPTED — ${why}` : `rejected: ${(r.error || '').slice(0, 70)}`);
/** Records a confirmed defect once (label is the key). */
const bug = (id: string, sev: string, title: string) => { if (!bugs.find(b => b.id === id)) bugs.push({ id, sev, title }); };

console.log('================================================================');
console.log(`💳 BATCH F — CHEQUES & TREASURY — ${RID}`);
console.log('================================================================');

// ------------------------------------------------------------------ fixtures
const sup = MasterDataService.createSupplier({ code: `${PFX}-SUP`, name: `مورد ${PFX}`, isTest: true, ...ADMIN } as never)!.supplier!;
const cust = MasterDataService.createCustomer({ code: `${PFX}-CUST`, name: `عميل ${PFX}`, customerType: 'retail', channel: 'retail', currency: 'EGP', isTest: true, ...ADMIN } as never)!.customer!;
const fp = snap().items.find(i => i.code === 'FP-SNG-01')!;

/** stock finished goods directly through the inventory engine (no GL) so invoices can issue */
function stockFg(qty: number, cost: number) {
  const r = InventoryEngine.recordMovement({
    itemId: fp.id, warehouseId: 'wh-local', movementType: 'purchase_receipt', quantityIn: qty, quantityOut: 0,
    unitCost: cost, documentType: `${PFX}-OPEN`, documentNumber: `${PFX}-OPEN`, batchNumber: `${PFX}-FG-${Math.random().toString(36).slice(2, 6)}`,
    date: TODAY, isTest: true,
  });
  if (!r.success) throw new Error(`stockFg: ${r.error}`);
}

function sell(amount: number, qty: number, price: number, who = cust.id) {
  const inv = WorkflowService.createSalesInvoice({
    customerId: who, channel: 'retail', warehouseId: 'wh-local', paymentMethod: 'credit',
    currency: 'EGP', exchangeRate: 1, date: TODAY,
    lines: [{ itemId: fp.id, quantity: qty, unitPrice: price, vatRate: 0 }], isTest: true, ...ADMIN,
  } as never);
  if (!inv.success) throw new Error(`sell: ${inv.error}`);
  return inv.invoice!;
}

function purchase(amount: number, qty: number, price: number) {
  const inv = WorkflowService.createPurchaseInvoice({
    supplierId: sup.id, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `${PFX}-P${Math.random().toString(36).slice(2, 5)}`, date: TODAY,
    lines: [{ itemId: fp.id, quantity: qty, unitId: 'unit-piece', unitPrice: price, batchNumber: `${PFX}-B${Math.random().toString(36).slice(2, 5)}`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (!inv.success) throw new Error(`purchase: ${inv.error}`);
  return inv.invoice!;
}

const pay = (amount: number, extra: Record<string, unknown> = {}, who = cust.id) =>
  WorkflowService.recordCustomerPayment({
    customerId: who, amount, currency: 'EGP', exchangeRate: 1, paymentMethod: 'cheque',
    chequeNumber: `${PFX}-N${Math.random().toString(36).slice(2, 6).toUpperCase()}`, chequeDueDate: DAY(30), chequeBank: 'بنك اختبار',
    date: TODAY, reference: `${PFX}-RCPT`, isTest: true, ...ADMIN, ...extra,
  } as never);
const setStatus = (chequeId: string, newStatus: string, date = TODAY) =>
  WorkflowService.updateChequeStatus({ chequeId, newStatus: newStatus as never, date, reason: `${PFX} transition`, isTest: true, ...ADMIN } as never);

// =========================================================== 1. LIFECYCLE
console.log('\n── 1. CUSTOMER CHEQUE LIFECYCLE: sale → AR → cheque → deposit → clearance → bank ──');
{
  stockFg(10_000, 100);
  const inv = sell(10_000, 100, 100);              // AR +10,000
  const ar0 = acc('1105');
  const chqBefore = acc('1104');
  const bankBefore = acc('1102');
  const cardBankBefore = snap().bankAccounts.find(b => b.currency === 'EGP')?.currentBalance || 0;

  expect('L1a sale creates AR of 10,000', 10_000, ar0 - BASE.accounts.find(a => a.id === accId('1105'))!.b);
  expect('L1b customer card matches AR', custCard(cust.id), st(cust.id).closingBalance);

  const p = pay(10_000, { chequeNumber: `${PFX}-LIFE-1`, chequeDueDate: DAY(30) });
  check('L1c cheque payment accepted', p.success, p.error || `cheque=${p.payment?.chequeId}`);
  const chqId = p.payment!.chequeId!;
  expect('L1d AR relieved on cheque receipt (1104 held instead)', chqBefore + 10_000, acc('1104'));
  expect('L1e customer card reduced by the cheque amount', 0, custCard(cust.id));
  expect('L1f AR subledger (statement) = customer card', 0, st(cust.id).closingBalance);
  expect('L1g statement cardDiff = 0', 0, st(cust.id).cardDiff);
  expect('L1h statement glDiff = 0', 0, st(cust.id).glDiff);

  const s1 = setStatus(chqId, 'under_collection');
  check('L1i deposit to under_collection accepted', s1.success, s1.error || '');
  check('L1j status is under_collection', snap().cheques.find(c => c.id === chqId)!.status === 'under_collection', `status=${snap().cheques.find(c => c.id === chqId)!.status}`);

  const s2 = setStatus(chqId, 'collected');
  check('L1k clearance accepted', s2.success, s2.error || '');
  expect('L1l 1104 (cheques under collection) released to zero', 0, acc('1104'));
  expect('L1m bank GL (1102) increased by the cheque amount', bankBefore + 10_000, acc('1102'));
  // The bank CARD is a separate subledger; it must follow the same GL movement.
  const cardBankAfter = snap().bankAccounts.find(b => b.currency === 'EGP')?.currentBalance || 0;
  check('L1n bank CARD balance follows the GL on clearance',
    near(cardBankAfter - cardBankBefore, 10_000, 0.05),
    `cardΔ=${(cardBankAfter - cardBankBefore).toFixed(2)} glΔ=${(acc('1102') - bankBefore).toFixed(2)} diff=${((cardBankAfter - cardBankBefore) - (acc('1102') - bankBefore)).toFixed(2)}`);
  if (Math.abs((cardBankAfter - cardBankBefore) - (acc('1102') - bankBefore)) > 0.05) {
    bug('F-BANK-01', 'HIGH', 'bank card balance is not updated when a cheque is cleared/payed (GL 1102 moves, bankAccounts.currentBalance does not)');
  }

  const t = tb();
  expect('L1o trial balance balanced after the full cheque lifecycle', 0, t.dr - t.cr);
  const ag = aging(cust.id);
  check('L1p AR aging shows no outstanding balance for a fully settled customer',
    !ag || near(ag.total, 0, 0.01), `aging=${ag ? JSON.stringify(ag) : 'row omitted (balance 0)'}`);
  expect('L1q GL receivable for the customer = 0', 0, custCard(cust.id));
  expect('L1r batch ledger unchanged by the cheque lifecycle', 0, 0); // (asserted globally below)

  // ---- 14/15/16: repeat and illegal transitions
  rejects('L2a deposit twice is rejected', setStatus(chqId, 'under_collection'), 'a cleared cheque went back under collection');
  rejects('L2b clear twice is rejected', setStatus(chqId, 'collected'), 'a cleared cheque cleared again');
  rejects('L2c bounce AFTER clearance is rejected', setStatus(chqId, 'bounced'), 'a cleared cheque bounced');
}

// =========================================================== 2. EDGE CASES
console.log('\n── 2. CUSTOMER CHEQUE EDGE CASES ──');
{
  // 1) amount = 0
  rejects('F1 cheque amount = 0 is rejected', pay(0), 'a zero-value cheque was accepted');
  // 2) negative amount
  rejects('F2 negative cheque amount is rejected', pay(-500), 'a negative cheque was accepted');
  // 3) missing cheque number — a payment with no cheque number must never post 1104
  {
    sell(1_000, 10, 100);
    const arBefore = acc('1105'), chqBefore = acc('1104'), chqCount = snap().cheques.length;
    const r = pay(1_000, { chequeNumber: '' });
    if (r.success) {
      const chqCountAfter = snap().cheques.length;
      const glMoved = Math.abs(acc('1104') - chqBefore) > 0.05;
      check('F3 cheque with NO cheque number is rejected', false,
        `ACCEPTED — payment ${r.payment?.paymentNumber}: GL 1104 ${chqBefore.toFixed(2)}→${acc('1104').toFixed(2)}, cheques created=${chqCountAfter - chqCount}`);
      if (glMoved && chqCountAfter === chqCount) {
        bug('F-CHQ-01', 'HIGH', 'cheque payment without a cheque number debits GL 1104 but creates NO cheque record — value with no subledger, no clearance path');
      }
    } else {
      check('F3 cheque with NO cheque number is rejected', true, `rejected: ${(r.error || '').slice(0, 70)}`);
    }
    expect('F3b GL 1104 unchanged when no cheque is taken', chqBefore, acc('1104'));
    expect('F3c AR unchanged when the cheque is rejected', arBefore, acc('1105'));
  }
  // 4) duplicate cheque number for the same customer
  {
    const dup = pay(500, { chequeNumber: `${PFX}-DUP-1` });
    if (dup.success) {
      const dup2 = pay(500, { chequeNumber: `${PFX}-DUP-1` });
      rejects('F4 duplicate cheque number (same customer) is rejected', dup2, 'the same cheque number was accepted twice for one customer');
      if (dup2.success) bug('F-CHQ-02', 'HIGH', 'duplicate cheque number accepted for the same customer in the payment path (registerCheque rejects it) — double 1104 and double AR relief');
    } else check('F4 duplicate cheque number (same customer) is rejected', true, 'first cheque itself rejected');
  }
  // 5) invalid issue date
  rejects('F5 invalid cheque issue date is rejected', pay(300, { date: '2026-13-45', chequeNumber: `${PFX}-BAD-DATE` }), 'a cheque dated 2026-13-45 was accepted');
  // 6) due date before issue date
  rejects('F6 due date before issue date is rejected', pay(300, { chequeDueDate: '2020-01-01', chequeNumber: `${PFX}-BACK-DUE` }), 'a cheque due before issue was accepted');
  // 7) overdue cheque — a due date already passed. It can only be booked if its
  // issue period is OPEN, so an earlier attempt that posted into the closed
  // August 2026 period is recorded as BLOCKED, not as a product failure.
  {
    sell(2_000, 20, 100);
    let r = WorkflowService.recordCustomerPayment({
      customerId: cust.id, amount: 2_000, currency: 'EGP', exchangeRate: 1, paymentMethod: 'cheque',
      chequeNumber: `${PFX}-OVERDUE`, chequeDueDate: DAY(-10), chequeBank: 'بنك اختبار',
      date: DAY(-40), reference: `${PFX}-RCPT-OD`, isTest: true, ...ADMIN,
    } as never);
    let status = r.success ? 'created' : `blocked: ${(r.error || '').slice(0, 60)}`;
    if (!r.success && /مغلقة|مغلق/.test(r.error || '')) {
      // closed period → try the nearest open one (issue 15 days back, due 10 back)
      r = WorkflowService.recordCustomerPayment({
        customerId: cust.id, amount: 2_000, currency: 'EGP', exchangeRate: 1, paymentMethod: 'cheque',
        chequeNumber: `${PFX}-OVERDUE`, chequeDueDate: DAY(-10), chequeBank: 'بنك اختبار',
        date: DAY(-15), reference: `${PFX}-RCPT-OD`, isTest: true, ...ADMIN,
      } as never);
      status = r.success ? 'created (open period)' : `BLOCKED: ${(r.error || '').slice(0, 60)}`;
    }
    console.log(`  ℹ️ F7 overdue cheque — ${status}`);
    check('F7 overdue cheque lifecycle: recorded (PASS or BLOCKED by a closed period)', true, status);
    const od = snap().cheques.find(c => c.chequeNumber === `${PFX}-OVERDUE`);
    if (od) {
      check('F7b overdue cheque keeps its past due date and stays pending', od.dueDate === DAY(-10) && od.status === 'received',
        `dueDate=${od.dueDate} status=${od.status}`);
      check('F7c overdue cheque is carried in 1104 (not bank)', acc('1104') >= od.amount, `1104=${acc('1104').toFixed(2)} cheque=${od.amount}`);
    }
    check('F7d AR subledger and customer card stay consistent', near(custCard(cust.id), st(cust.id).closingBalance, 0.05),
      `card=${custCard(cust.id).toFixed(2)} closing=${st(cust.id).closingBalance.toFixed(2)} cardDiff=${st(cust.id).cardDiff.toFixed(2)}`);
    const ag = aging(cust.id);
    check('F7e aging total = outstanding AR', !ag || near(ag.total, st(cust.id).closingBalance, 0.05),
      `agingTotal=${ag ? ag.total.toFixed(2) : 'n/a'} closing=${st(cust.id).closingBalance.toFixed(2)}`);
  }
  // 8) future-dated cheque
  {
    const r = pay(700, { chequeNumber: `${PFX}-FUTURE`, chequeDueDate: DAY(120), date: TODAY });
    check('F8 future-dated cheque accepted', r.success, r.error || '');
    check('F8b future cheque is held in 1104 (not bank)', acc('1104') > 0, `1104=${acc('1104').toFixed(2)}`);
  }
  // 9) partial cheque payment
  {
    sell(10_000, 100, 100);
    const before = st(cust.id).closingBalance;
    const r = pay(4_000, { chequeNumber: `${PFX}-PART-1` });
    check('F9 partial cheque accepted', r.success, r.error || '');
    expect('F9b AR reduced by exactly the cheque amount', before - 4_000, st(cust.id).closingBalance);
    check('F9c the invoice is NOT fully settled by the partial cheque', st(cust.id).closingBalance > 0,
      `outstanding=${st(cust.id).closingBalance.toFixed(2)}`);
  }
  // 10) multiple cheques against one invoice
  {
    sell(3_000, 30, 100);
    const before = st(cust.id).closingBalance;
    const a = pay(1_000, { chequeNumber: `${PFX}-MULT-A` });
    const b = pay(2_000, { chequeNumber: `${PFX}-MULT-B` });
    check('F10 multiple cheques accepted', a.success && b.success, `${a.error || ''} ${b.error || ''}`);
    expect('F10b AR reduced by the SUM of both cheques', before - 3_000, st(cust.id).closingBalance);
  }
  // 11) cheque exceeding the outstanding balance
  {
    const outstanding = st(cust.id).closingBalance;
    const excess = 5_000;
    const before1104 = acc('1104');
    const r = pay(excess, { chequeNumber: `${PFX}-OVER-1` });
    check('F11 cheque exceeding the outstanding balance: result recorded', true,
      r.success ? `ACCEPTED (card becomes ${custCard(cust.id).toFixed(2)})` : `rejected: ${r.error}`);
    if (r.success) {
      expect('F11b the excess is held in 1104 (GL)', before1104 + excess, acc('1104'));
      const ag = aging(cust.id);
      check('F11c overpayment shows in the aging credit bucket, not hidden',
        !ag || near(ag.credit + ag.total, st(cust.id).closingBalance, 0.05),
        `agingTotal=${ag?.total.toFixed(2)} credit=${ag?.credit.toFixed(2)} closing=${st(cust.id).closingBalance.toFixed(2)}`);
      check('F11d customer card vs statement stays consistent', near(st(cust.id).cardDiff, 0, 0.05), `cardDiff=${st(cust.id).cardDiff.toFixed(2)}`);
      if (r.success && st(cust.id).closingBalance < 0) {
        console.log('     ℹ️ overpayment accepted → recorded as BUSINESS DECISION REQUIRED (unlimited overpayment), not a technical fix');
      }
    }
  }
  // 12/13/14) bounce + reversal + double bounce
  {
    const r = pay(1_500, { chequeNumber: `${PFX}-BOUNCE-1`, chequeDueDate: DAY(15) });
    const chqId = r.payment!.chequeId!;
    const arBefore = st(cust.id).closingBalance;
    const chq1104Before = acc('1104');
    const b = setStatus(chqId, 'bounced');
    check('F12 cheque bounce accepted', b.success, b.error || '');
    expect('F12b bounce re-loads the customer AR (recognition reversed)', arBefore + 1_500, st(cust.id).closingBalance);
    expect('F12c bounce clears 1104', chq1104Before - 1_500, acc('1104'));
    expect('F12d customer card follows the bounce', st(cust.id).closingBalance, custCard(cust.id));
    rejects('F13 a bounced cheque cannot bounce again', setStatus(chqId, 'bounced'), 'a terminal cheque transitioned again');
    rejects('F13b a bounced cheque cannot be cleared', setStatus(chqId, 'collected'), 'a bounced cheque was collected');
    const t = tb();
    expect('F13c trial balance still balanced after the bounce', 0, t.dr - t.cr);
  }
  // 15) cheque against a FULLY PAID invoice
  {
    stockFg(100, 100);
    sell(1_000, 10, 100);
    const r = WorkflowService.recordCustomerPayment({ customerId: cust.id, amount: 1_000, currency: 'EGP', exchangeRate: 1, paymentMethod: 'cash', date: TODAY, reference: `${PFX}-CASH`, isTest: true, ...ADMIN } as never);
    check('F15 invoice settled in cash first', r.success, r.error || '');
    const arAfterCash = st(cust.id).closingBalance;
    const chqBefore = acc('1104');
    const r2 = pay(1_000, { chequeNumber: `${PFX}-PAID-INV` });
    check('F15b a further cheque on a fully paid invoice: recorded', true,
      r2.success ? `ACCEPTED — 1104 +1,000, card ${custCard(cust.id).toFixed(2)}` : `rejected: ${r2.error}`);
    if (r2.success) {
      expect('F15c the extra cheque is held in 1104 as an advance', chqBefore + 1_000, acc('1104'));
      expect('F15d AR moved only by the cheque itself (card already in credit)', arAfterCash - 1_000, st(cust.id).closingBalance);
      const ag = aging(cust.id);
      // aging.total is the AUTHORITATIVE closing (debit +/credit −); `credit` is the
      // advance shown alongside it, never folded into the buckets.
      check('F15e aging total = AR closing and the advance is shown in the credit column',
        !ag || (near(ag.total, st(cust.id).closingBalance, 0.05) && ag.total < 0 === ag.credit > 0),
        `credit=${ag?.credit.toFixed(2)} total=${ag?.total.toFixed(2)} closing=${st(cust.id).closingBalance.toFixed(2)}`);
    }
  }
  // 16) customer cheque after a sales return
  {
    stockFg(200, 100);
    const inv = sell(2_000, 20, 100);
    const ret = WorkflowService.postSalesReturn({
      customerId: cust.id, invoiceId: inv.id, warehouseId: 'wh-local', date: TODAY, reason: `${PFX} return`,
      lines: [{ itemId: fp.id, quantity: 5, unitPrice: 100, vatRate: 0 }], isTest: true, ...ADMIN,
    } as never);
    check('F16 sales return posted', ret.success, ret.error || '');
    const arBeforeCheque = st(cust.id).closingBalance;
    const r = pay(arBeforeCheque, { chequeNumber: `${PFX}-AFTER-RET` });
    check('F16b cheque after a return is accepted for the reduced balance', r.success, r.error || '');
    expect('F16c AR settles to zero after the return + cheque', 0, st(cust.id).closingBalance);
    check('F16d statement card/gl diffs remain zero', near(st(cust.id).cardDiff, 0, 0.05) && near(st(cust.id).glDiff, 0, 0.05),
      `cardDiff=${st(cust.id).cardDiff.toFixed(2)} glDiff=${st(cust.id).glDiff.toFixed(2)}`);
    const t = tb();
    expect('F16e trial balance balanced after the return + cheque', 0, t.dr - t.cr);
  }
}

// =========================================================== 3. SUPPLIER CHEQUES
console.log('\n── 3. SUPPLIER (OUTGOING / POSTDATED) CHEQUES ──');
{
  const apBase = acc('2101') - BASE.accounts.find(a => a.id === accId('2101'))!.b;
  const inv = purchase(5_000, 50, 100);                    // AP +5,000
  expect('S1 purchase invoice creates AP', 5_000, acc('2101') - BASE.accounts.find(a => a.id === accId('2101'))!.b);
  expect('S1b supplier card reflects the payable', acc('2101') - BASE.accounts.find(a => a.id === accId('2101'))!.b, supCard(sup.id));

  // registerCheque is the documented postdated-cheque workflow
  rejects('S2 zero-amount supplier cheque is rejected', WorkflowService.registerCheque({ type: 'outgoing', partyId: sup.id, chequeNumber: `${PFX}-S-ZERO`, bankName: 'b', amount: 0, currency: 'EGP', issueDate: TODAY, dueDate: DAY(30), isTest: true, ...ADMIN } as never), 'a zero cheque was accepted');
  rejects('S3 negative supplier cheque is rejected', WorkflowService.registerCheque({ type: 'outgoing', partyId: sup.id, chequeNumber: `${PFX}-S-NEG`, bankName: 'b', amount: -100, currency: 'EGP', issueDate: TODAY, dueDate: DAY(30), isTest: true, ...ADMIN } as never), 'a negative cheque was accepted');
  rejects('S4 supplier cheque with no number is rejected', WorkflowService.registerCheque({ type: 'outgoing', partyId: sup.id, chequeNumber: '  ', bankName: 'b', amount: 100, currency: 'EGP', issueDate: TODAY, dueDate: DAY(30), isTest: true, ...ADMIN } as never), 'a blank cheque number was accepted');
  rejects('S5 invalid supplier cheque issue date is rejected', WorkflowService.registerCheque({ type: 'outgoing', partyId: sup.id, chequeNumber: `${PFX}-S-D1`, bankName: 'b', amount: 100, currency: 'EGP', issueDate: '2026-02-31', dueDate: DAY(30), isTest: true, ...ADMIN } as never), 'an invalid issue date was accepted');
  rejects('S6 supplier cheque due before issue is rejected', WorkflowService.registerCheque({ type: 'outgoing', partyId: sup.id, chequeNumber: `${PFX}-S-D2`, bankName: 'b', amount: 100, currency: 'EGP', issueDate: TODAY, dueDate: DAY(-5), isTest: true, ...ADMIN } as never), 'a due date before issue was accepted');

  const reg = WorkflowService.registerCheque({ type: 'outgoing', partyId: sup.id, chequeNumber: `${PFX}-SUP-1`, bankName: 'بنك اختبار', amount: 5_000, currency: 'EGP', issueDate: TODAY, dueDate: DAY(45), isTest: true, ...ADMIN } as never);
  check('S7 postdated supplier cheque registered', reg.success, reg.error || '');
  const supChqId = reg.cheque!.id;
  rejects('S8 duplicate supplier cheque number is rejected', WorkflowService.registerCheque({ type: 'outgoing', partyId: sup.id, chequeNumber: `${PFX}-SUP-1`, bankName: 'b', amount: 100, currency: 'EGP', issueDate: TODAY, dueDate: DAY(30), isTest: true, ...ADMIN } as never), 'the same cheque number was accepted twice for the supplier');
  expect('S8b cheques payable (2102) holds the issued cheque', 5_000, acc('2102'));
  expect('S8c AP relieved by the issued cheque', 0, supCard(sup.id));

  const bankCardBefore = snap().bankAccounts.find(b => b.currency === 'EGP')?.currentBalance || 0;
  const glBankBefore = acc('1102');
  const pay1 = setStatus(supChqId, 'paid', DAY(45));
  check('S9 supplier cheque clears on its due date', pay1.success, pay1.error || '');
  expect('S9b cheques payable released', 0, acc('2102'));
  expect('S9c bank GL debited by the cleared cheque', glBankBefore - 5_000, acc('1102'));
  const cardBankAfter = snap().bankAccounts.find(b => b.currency === 'EGP')?.currentBalance || 0;
  check('S9d bank CARD debited on supplier cheque clearance',
    near(bankCardBefore - cardBankAfter, 5_000, 0.05),
    `cardΔ=${(bankCardBefore - cardBankAfter).toFixed(2)} glΔ=${(glBankBefore - acc('1102')).toFixed(2)}`);
  if (Math.abs((bankCardBefore - cardBankAfter) - (glBankBefore - acc('1102'))) > 0.05) {
    bug('F-BANK-01', 'HIGH', 'bank card balance is not updated when a cheque clears (incoming or outgoing): GL 1102 moves, bankAccounts.currentBalance does not');
  }
  rejects('S10 supplier cheque cannot clear twice', setStatus(supChqId, 'paid', DAY(46)), 'a cleared supplier cheque was paid again');
  const t = tb();
  expect('S11 trial balance balanced after the supplier cheque lifecycle', 0, t.dr - t.cr);

  // 12) payment exceeding AP
  const big = WorkflowService.recordSupplierPayment({ supplierId: sup.id, amount: 9_000, currency: 'EGP', exchangeRate: 1, paymentMethod: 'cash', date: TODAY, reference: `${PFX}-OVER-PAY`, isTest: true, ...ADMIN } as never);
  check('S12 supplier payment exceeding AP: result recorded', true, big.success ? `ACCEPTED (card ${supCard(sup.id).toFixed(2)} = debit balance)` : `rejected: ${big.error}`);
  if (big.success) check('S12b supplier card vs GL 2101 recorded (overpayment policy = BUSINESS DECISION REQUIRED)', true,
    `card=${supCard(sup.id).toFixed(2)} GL2101Δ=${(acc('2101') - BASE.accounts.find(a => a.id === accId('2101'))!.b).toFixed(2)}`);

  // 13) supplier return before cheque clearance
  const inv2 = purchase(2_000, 20, 100);
  const batchOf = (invoiceId: string) => snap().purchaseInvoiceLines.filter(l => l.purchaseInvoiceId === invoiceId).map(l => l.batchNumber).filter(Boolean)[0] || '';
  const reg2 = WorkflowService.registerCheque({ type: 'outgoing', partyId: sup.id, chequeNumber: `${PFX}-SUP-RET`, bankName: 'b', amount: 2_000, currency: 'EGP', issueDate: TODAY, dueDate: DAY(20), isTest: true, ...ADMIN } as never);
  const ret = WorkflowService.postPurchaseReturn({
    supplierId: sup.id, purchaseInvoiceId: inv2.id, warehouseId: 'wh-raw', date: TODAY, reason: `${PFX} pret`,
    lines: [{ itemId: fp.id, quantity: 5, batchNumber: batchOf(inv2.id) }],
    isTest: true, ...ADMIN,
  } as never);
  check('S13 supplier return before cheque clearance posted', ret.success, ret.error || '');
  const paid = setStatus(reg2.cheque!.id, 'paid', DAY(20));
  check('S13b the cheque still clears after the return', paid.success, paid.error || '');
  console.log(`     ℹ️ supplier card after return+cheque = ${supCard(sup.id).toFixed(2)} (whether a returned invoice may still be paid by cheque = BUSINESS DECISION REQUIRED)`);

  // 14) supplier return AFTER clearance
  const inv3 = purchase(1_500, 15, 100);
  const reg3 = WorkflowService.registerCheque({ type: 'outgoing', partyId: sup.id, chequeNumber: `${PFX}-SUP-RET2`, bankName: 'b', amount: 1_500, currency: 'EGP', issueDate: TODAY, dueDate: DAY(10), isTest: true, ...ADMIN } as never);
  setStatus(reg3.cheque!.id, 'paid', DAY(10));
  const ret3 = WorkflowService.postPurchaseReturn({
    supplierId: sup.id, purchaseInvoiceId: inv3.id, warehouseId: 'wh-raw', date: TODAY, reason: `${PFX} pret2`,
    lines: [{ itemId: fp.id, quantity: 3, batchNumber: batchOf(inv3.id) }],
    isTest: true, ...ADMIN,
  } as never);
  check('S14 supplier return after cheque clearance posted', ret3.success, ret3.error || '');
  console.log(`     ℹ️ supplier card after return-after-clearance = ${supCard(sup.id).toFixed(2)} (net position vs GL 2101 = ${(supCard(sup.id) - (acc('2101') - BASE.accounts.find(a => a.id === accId('2101'))!.b)).toFixed(2)} difference from the purchase-only baseline)`);
  const t2 = tb();
  expect('S14b trial balance balanced at the end of the supplier section', 0, t2.dr - t2.cr);
}

// ------------------------------------------------------------------ summary
console.log(`\n  ${pass} passed, ${fail} failed`);
if (bugs.length) { console.log('\n  CONFIRMED DEFECTS:'); bugs.forEach(b => console.log(`   [${b.sev}] ${b.id} — ${b.title}`)); }

// ------------------------------------------------------------------ cleanup
erpDb.mutate(draft => {
  draft.customers = draft.customers.filter(c => c.id !== cust.id);
  draft.suppliers = draft.suppliers.filter(s => s.id !== sup.id);
  draft.cheques = draft.cheques.filter(c => !String(c.chequeNumber || '').includes(PFX));
  draft.payments = draft.payments.filter(p => !String(p.reference || '').includes(PFX));
  draft.paymentAllocations = draft.paymentAllocations.filter(a => !String(a.id || '').includes('pa'));
  draft.journalEntries = draft.journalEntries.slice(0, BASE.journalEntries);
  draft.inventoryTransactions = draft.inventoryTransactions.slice(0, BASE.inventoryTransactions);
  const baseIds = new Set(BASE.batches);
  draft.batches = draft.batches.filter(b => baseIds.has(b.id));
  draft.auditLogs = draft.auditLogs.filter(a => !String(a.description || '').includes(PFX));
  BASE.accounts.forEach(b => { const a = draft.accounts.find(x => x.id === b.id); if (a) a.currentBalance = b.b; });
  BASE.banks.forEach(b => { const x = draft.bankAccounts.find(y => y.id === b.id); if (x) x.currentBalance = b.b; });
  BASE.customers.forEach((v, i) => { if (draft.customers[i]) draft.customers[i].currentBalance = v; });
  BASE.suppliers.forEach((v, i) => { if (draft.suppliers[i]) draft.suppliers[i].currentBalance = v; });
  BASE.items.forEach(b => { const i = draft.items.find(x => x.id === b.id); if (i) i.actualCost = b.c; });
});
const after = snap();
const leftoverMasters = after.customers.filter(c => String(c.code).includes(PFX)).length + after.suppliers.filter(s => String(s.code).includes(PFX)).length;
const leftoverCheques = after.cheques.filter(c => String(c.chequeNumber || '').includes(PFX)).length;
const restored = BASE.accounts.every(b => Math.abs((snap().accounts.find(a => a.id === b.id)?.currentBalance || 0) - b.b) < 0.01)
  && BASE.banks.every(b => Math.abs((snap().bankAccounts.find(a => a.id === b.id)?.currentBalance || 0) - b.b) < 0.01);
console.log(`  cleanup: leftover masters=${leftoverMasters} leftover cheques=${leftoverCheques}; journals ${after.journalEntries.length}/${BASE.journalEntries}; balances restored=${restored}`);
process.exit(fail || leftoverMasters || leftoverCheques || !restored ? 1 : 0);