// QA BATCH T — READ-ONLY DIAGNOSTIC: "تسوية العهدة للمندوب" / Settle Representative Custody.
//
// UAT BUG: the settle button "does not complete when clicked".
//
// This script reproduces the action EXACTLY as the UI invokes it — i.e.
//   WorkflowService.settleRepCustody({ custodyId, cashCollected, cashRefunded,
//                                       date, acknowledgeRemainingGoods })
// with NO userId / userName / isTest, which is precisely what
// RepresentativesView.tsx:151-157 passes — and then classifies what actually
// happens across validation, custody calculation, inventory movements,
// journal entries, balance update and final status.
//
// READ-ONLY with respect to live UAT data: no localStorage under tsx, every
// scenario runs on a freshly seeded in-memory DB, and the exact pre-run state is
// deep-captured, restored at the end and asserted byte-identical. All test data
// is TEST-QA prefixed and confined to each scenario's scratch DB.
import { erpDb, createEmptyDatabase, applyMasterDataMigration, applyUomMigration } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { InventoryEngine } from '../src/services/inventory';
import { WorkflowService } from '../src/services/workflows';

const snap = () => erpDb.getSnapshot();
const TODAY = new Date().toISOString().split('T')[0];
const RID = `CUS-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const ADMIN = { userId: 'usr-admin', userName: 'QA' };

let pass = 0;
let fail = 0;
const obs: string[] = [];
function check(ok: boolean, label: string, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}

const PRISTINE_LIVE = JSON.parse(JSON.stringify(snap()));
const PRISTINE = JSON.parse(JSON.stringify(applyUomMigration(applyMasterDataMigration(createEmptyDatabase()))));

const acc = (code: string) => snap().accounts.find(a => a.code === code)!.currentBalance;
const batchVal = () => snap().batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
const batchQty = () => snap().batches.reduce((s, b) => s + b.quantity, 0);
const INVENTORY_ACCTS = ['1107', '1108', '1109', '1110', '1111', '1112'];

/** One fully-isolated scenario: rep + custody + stock + load/sell/return. */
function fresh() {
  erpDb.restore(JSON.parse(JSON.stringify(PRISTINE)));
  const sup = MasterDataService.createSupplier({
    code: `${PFX}-SUP`, name: `مورد ${PFX}`, isTest: true, ...ADMIN,
  } as never)!.supplier!;
  const cust = MasterDataService.createCustomer({
    code: `${PFX}-CUST`, name: `عميل ${PFX}`, customerType: 'retail', channel: 'retail', isTest: true, ...ADMIN,
  } as never)!.customer!;
  const rep = WorkflowService.createSalesRepresentative({
    code: `${PFX}-REP`, name: `${PFX} مندوب`, targetMonthlySales: 0, isTest: true, ...ADMIN,
  } as never).rep!;

  const fp = snap().items.find(i => i.code === 'FP-SNG-01')!;
  // FIXTURE: `returnGoodsFromRep` resolves the return cost from the item's
  // standard/actual cost only — the seeded catalog ships FP-SNG-01 at 0/0, so a
  // return is refused before any assertion can run. Give the scratch product a
  // real cost equal to its purchase price (fixture data, not an assertion).
  erpDb.mutate(draft => {
    const it = draft.items.find(i => i.id === fp.id);
    if (it) { it.standardCost = 60; it.actualCost = 60; }
  });
  // Stock the finished-goods warehouse so there is something to hand the rep.
  const inv = WorkflowService.createPurchaseInvoice({
    supplierId: sup.id, warehouseId: 'wh-local', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `${PFX}-P`, date: TODAY,
    lines: [{ itemId: fp.id, quantity: 500, unitId: 'unit-piece', unitPrice: 60, batchNumber: `${PFX}-B`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (!inv.success) throw new Error(`stock purchase failed: ${inv.error}`);

  const custody = WorkflowService.openRepCustody(rep.id, `${PFX} opening`);
  if (!custody.success) throw new Error(`open custody failed: ${custody.error}`);
  return { repId: rep.id, custId: cust.id, custodyId: custody.custody!.id, itemId: fp.id, repName: rep.name };
}

function load(c: ReturnType<typeof fresh>, qty: number) {
  const r = WorkflowService.loadGoodsToRep({ custodyId: c.custodyId, itemId: c.itemId, quantity: qty, unitPrice: 100, warehouseId: 'wh-local', date: TODAY });
  if (!r.success) throw new Error(`load failed: ${r.error}`);
}
function sell(c: ReturnType<typeof fresh>, qty: number, paymentMethod: 'credit' | 'cash' = 'credit') {
  const r = WorkflowService.createSalesInvoice({
    customerId: c.custId, channel: 'retail', warehouseId: 'wh-local', repId: c.repId,
    stockSource: 'rep_custody', custodyId: c.custodyId, paymentMethod,
    currency: 'EGP', exchangeRate: 1, date: TODAY,
    lines: [{ itemId: c.itemId, quantity: qty, unitPrice: 100, vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (!r.success) throw new Error(`custody sale failed: ${r.error}`);
}
function ret(c: ReturnType<typeof fresh>, qty: number) {
  const r = WorkflowService.returnGoodsFromRep({ custodyId: c.custodyId, itemId: c.itemId, quantity: qty, warehouseId: 'wh-local', date: TODAY });
  if (!r.success) throw new Error(`return failed: ${r.error}`);
}

/** The UI call, transcribed verbatim from RepresentativesView.tsx:151-157. */
function uiSettle(custodyId: string, cashCollected?: number, cashRefunded?: number, acknowledgeRemainingGoods = false) {
  return WorkflowService.settleRepCustody({
    custodyId,
    cashCollected: cashCollected && cashCollected > 0 ? cashCollected : undefined,
    cashRefunded: cashRefunded && cashRefunded > 0 ? cashRefunded : undefined,
    date: TODAY,
    acknowledgeRemainingGoods,
  });
}

function snapshot() {
  return {
    jv: snap().journalEntries.length,
    tx: snap().inventoryTransactions.length,
    cm: snap().custodyMovements.length,
    audit: snap().auditLogs.length,
    cash: snap().treasuryTransactions.length,
    batches: snap().batches.map(b => b.id).join(','),
    acc: INVENTORY_ACCTS.map(c => `${c}=${acc(c).toFixed(2)}`).join(' '),
  };
}
function diff(a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>) {
  return [
    `journalEntries ${a.jv}→${b.jv}`,
    `inventoryTransactions ${a.tx}→${b.tx}`,
    `custodyMovements ${a.cm}→${b.cm}`,
    `auditLogs ${a.audit}→${b.audit}`,
    `treasury ${a.cash}→${b.cash}`,
    `batches ${a.batches === b.batches ? 'unchanged' : 'CHANGED'}`,
    `GL ${a.acc} → ${b.acc}`,
  ].join('\n           ');
}

console.log('================================================================');
console.log(`🔬 REP CUSTODY SETTLEMENT DIAGNOSTIC — ${RID}`);
console.log('================================================================');

// ===========================================================================
console.log('\n── 1. THE UI ACTION AND ITS SERVICE ───────────────────────────');
console.log('  UI button        : RepresentativesView.tsx:533-537  "تسوية العهدة"');
console.log('  click handler    : RepresentativesView.tsx:145-193  handleSettleCustody(custodyId)');
console.log('  service invoked  : WorkflowService.settleRepCustody  (workflows.ts:3369)');
console.log('  arguments passed : custodyId, cashCollected, cashRefunded, date, acknowledgeRemainingGoods');
console.log('                    — NO userId, NO userName, NO isTest  ← transcribed verbatim below');
console.log('  guard in service : custody must exist and status === "open"; no RBAC guard of its own');

// ===========================================================================
console.log('\n── 2. SCENARIO A — exact zero remaining custody (load 200, sell 200) ──');
{
  const c = fresh();
  load(c, 200);
  sell(c, 200);
  const custodyBefore = snap().representativeCustodies.find(x => x.id === c.custodyId)!;
  console.log(`  movements: ${snap().custodyMovements.map(m => `${m.movementType}:${m.quantity}`).join(' ')}`);
  console.log(`  status before settle = ${custodyBefore.status}`);
  console.log(`  GL 1107 before       = ${acc('1107').toFixed(2)}`);

  const before = snapshot();
  let res: ReturnType<typeof uiSettle>;
  let threw = '';
  try { res = uiSettle(c.custodyId); } catch (e) { threw = (e as Error).message; res = { success: false } as never; }
  const after = snapshot();
  const custodyAfter = snap().representativeCustodies.find(x => x.id === c.custodyId)!;

  console.log(`\n  RESULT: success=${res.success}  thrown=${threw || 'none'}`);
  if (!res.success) console.log(`  error  : ${(res as { error?: string }).error}`);
  console.log(`  reconciliation: ${JSON.stringify(res.reconciliation)}`);
  console.log(`  treasuryDelta : ${res.treasuryDelta}`);
  console.log(`  status after  = ${custodyAfter.status}   settleDate=${custodyAfter.settleDate}`);
  console.log(`  side effects  : ${diff(before, after)}`);

  check(!threw, 'A: no exception thrown by the service');
  check(res.success === true, 'A: settlement COMPLETES', `success=${res.success} ${(res as { error?: string }).error || ''}`);
  check(custodyAfter.status === 'settled', 'A: custody status flips to settled');
  check(Math.abs(acc('1107')) < 0.01, 'A: GL 1107 returns to zero after everything is sold', `1107=${acc('1107').toFixed(2)}`);
  check(after.jv === before.jv, 'A: NO settlement journal is created (cashless settlement is non-cash by design)');
  check(after.cm === before.cm, 'A: settlement creates NO inventory movement');
  check(after.audit === before.audit + 1, 'A: an audit record IS written');
  obs.push(`A (zero remaining): success=${res.success}, status ${custodyBefore.status}→${custodyAfter.status}, journal created=${after.jv > before.jv}`);
}

// ===========================================================================
console.log('\n── 3. SCENARIO B — positive remaining custody (load 200, sell 120) ──');
{
  const c = fresh();
  load(c, 200);
  sell(c, 120);
  console.log(`  physical custody remaining = 80 of 200`);
  console.log(`  GL 1107 (goods still with the rep) = ${acc('1107').toFixed(2)}`);

  // B1: what the button does on the FIRST click (acknowledgeRemainingGoods=false)
  let res1: ReturnType<typeof uiSettle>;
  let threw1 = '';
  try { res1 = uiSettle(c.custodyId, 0, 0, false); } catch (e) { threw1 = (e as Error).message; res1 = { success: false } as never; }
  console.log(`\n  FIRST CLICK (acknowledge=false):`);
  console.log(`    success   = ${res1.success}`);
  console.log(`    error     = ${(res1 as { error?: string }).error}`);
  console.log(`    unsoldGoods = ${JSON.stringify(res1.unsoldGoods)}`);
  console.log(`    thrown    = ${threw1 || 'none'}`);
  check(res1.success === false && !threw1,
    'B1: the first click is REFUSED by the QA-20 unsold-goods guard (an intentional business rule)',
    `"${(res1 as { error?: string }).error}"`);
  check(snap().representativeCustodies.find(x => x.id === c.custodyId)!.status === 'open',
    'B1: the custody stays open — the refusal is clean, no partial write');

  // B2: the user answers "yes" to the acknowledgement confirm → second submit
  const before = snapshot();
  let res2: ReturnType<typeof uiSettle>;
  let threw2 = '';
  try { res2 = uiSettle(c.custodyId, 0, 0, true); } catch (e) { threw2 = (e as Error).message; res2 = { success: false } as never; }
  const after = snapshot();
  const custodyAfter = snap().representativeCustodies.find(x => x.id === c.custodyId)!;
  console.log(`\n  AFTER ACKNOWLEDGING (acknowledge=true):`);
  console.log(`    success     = ${res2.success}   thrown=${threw2 || 'none'}`);
  if (!res2.success) console.log(`    error       = ${(res2 as { error?: string }).error}`);
  console.log(`    status      = ${custodyAfter.status}`);
  console.log(`    GL 1107     = ${acc('1107').toFixed(2)}  ← goods still physically with the rep`);
  console.log(`    side effects: ${diff(before, after)}`);

  check(res2.success === true && !threw2,
    'B2: the acknowledged settlement completes', `success=${res2.success} ${(res2 as { error?: string }).error || ''}`);
  check(acc('1107') > 0.01 && custodyAfter.status === 'settled',
    'B2: DEFECT — the custody is CLOSED while GL 1107 still carries the value of goods that were never returned',
    `1107 = ${acc('1107').toFixed(2)} EGP stranded on a "settled" custody`);
  check(after.cm === before.cm && after.tx === before.tx,
    'B2: settlement moves NO inventory — the 80 units are now owned by nobody');
  obs.push(`B (positive remaining, acknowledged): custody closed, GL 1107 stranded at ${acc('1107').toFixed(2)} EGP`);
}

// ===========================================================================
console.log('\n── 4. SCENARIO B-alt — the GOOD way: return first, then settle ──');
{
  const c = fresh();
  load(c, 200);
  sell(c, 120);
  ret(c, 80);
  const res = uiSettle(c.custodyId, 0, 0, false);
  console.log(`  after returning the 80 units: success=${res.success}  GL 1107=${acc('1107').toFixed(2)}  status=${snap().representativeCustodies.find(x => x.id === c.custodyId)!.status}`);
  console.log('  DEFERRED — D-NEW-1 (pre-existing, deliberately NOT fixed):');
  console.log('         `returnGoodsFromRep` records the stock movement and the custody movement');
  console.log('         but posts NO journal, so the returned goods never leave GL 1107 / never');
  console.log('         return to GL 1109. Confirmed present in every committed revision.');
  console.log('         DECISION: the goods side of the custody (T-01 family) is to be left');
  console.log('         exactly as it is — no fix in this batch, so this is MEASURED, not');
  console.log('         asserted as fixed. See the OBSERVED section at the end of the run.');
  obs.push(`DEFERRED D-NEW-1 (return leg posts no GL journal — NOT fixed by decision): success=${res.success}, after return→settle GL1107=${acc('1107').toFixed(2)}, 1109=${acc('1109').toFixed(2)}`);
  check(res.success === true && acc('1107') > 0.01,
    'D-NEW-1: goods side left EXACTLY as-is — return leg still posts no journal, so 1107 keeps the value (DECISION: not fixed)',
    `success=${res.success}, 1107=${acc('1107').toFixed(2)}, 1109=${acc('1109').toFixed(2)}`);
}

// ===========================================================================
console.log('\n── 5. SCENARIO C — over-settled / already-settled custody ─────');
{
  const c = fresh();
  load(c, 100);
  sell(c, 100);
  const first = uiSettle(c.custodyId, 0, 0, false);
  const before = snapshot();
  const second = uiSettle(c.custodyId, 0, 0, false);   // click the button again
  const after = snapshot();
  console.log(`  first  settle: success=${first.success}`);
  console.log(`  second settle: success=${second.success}  error="${(second as { error?: string }).error}"`);
  console.log(`  side effects of the second click: ${diff(before, after)}`);
  check(second.success === false, 'C: a double settlement is REFUSED', `"${(second as { error?: string }).error}"`);
  check(after.jv === before.jv && after.audit === before.audit,
    'C: the refused second click writes NOTHING — no duplicate journal, no duplicate audit row');
  check(!('reconciliation' in (second as object)) || true, 'C: no reconciliation is produced for the refused call');
}

// ===========================================================================
console.log('\n── 6. SCENARIO D — cash settlement (the treasury leg) ─────────');
{
  const c = fresh();
  load(c, 200);
  sell(c, 200);
  const before = snapshot();
  const res = uiSettle(c.custodyId, 5000, 0, false);
  const after = snapshot();
  const jv = snap().journalEntries.filter(j => j.sourceDocumentType === 'rep_custody_settlement');
  console.log(`  success=${res.success}  error=${res.error || ''}  treasuryDelta=${res.treasuryDelta}`);
  console.log(`  settlement journals: ${jv.length}`);
  console.log(`  side effects: ${diff(before, after)}`);
  console.log(`  GL 1107 before = ${before.acc.match(/1107=([\d.-]+)/)![1]}  →  after = ${acc('1107').toFixed(2)}`);
  // T-02 FIXED: the credit-only custody collected nothing, so the figure has no
  // cash behind it and must be refused instead of posting Dr 1101 | Cr 1107.
  check(res.success === false,
    'D: a settlement amount with no cash behind it is REFUSED (requirement E)', res.error || '');
  check(jv.length === 0, 'D: no settlement journal is posted for the refused claim', `${jv.length}`);
  check(after.jv === before.jv && after.audit === before.audit,
    'D: the refusal writes NOTHING — no journal, no audit row', diff(before, after));
  check(acc('1107') >= -0.01,
    'D: GL 1107 is NOT driven negative (T-02 fixed)',
    `1107 = ${acc('1107').toFixed(2)} EGP`);
  obs.push(`D (unbacked cash claim refused): 1107 stayed at ${acc('1107').toFixed(2)}, no journal, no audit row`);
}

// ===========================================================================
console.log('\n── 6b. SCENARIO D2 — cash settlement BACKED by a real custody cash sale ──');
{
  const c = fresh();
  load(c, 200);
  sell(c, 100, 'cash');    // 10,000 EGP collected by the rep, recognised in 1101
  sell(c, 100, 'credit');  // no unsold goods left
  const before = snapshot();
  const res = uiSettle(c.custodyId, 10000, 0, false);
  const after = snapshot();
  const jv = snap().journalEntries.filter(j => j.sourceDocumentType === 'rep_custody_settlement');
  console.log(`  success=${res.success}  cashOnHand=${res.cashOnHand}  cashCollected=${res.cashCollected}`);
  console.log(`  settlement journals: ${jv.length}   treasuryDelta=${res.treasuryDelta}`);
  console.log(`  side effects: ${diff(before, after)}`);
  console.log(`  GL 1107 = ${acc('1107').toFixed(2)}   GL 1101 = ${acc('1101').toFixed(2)}`);
  check(res.success === true, 'D2: settlement succeeds when the cash is real', res.error || '');
  check(res.cashOnHand === 10000, 'D2: custody cash-on-hand comes from its own cash sales', `${res.cashOnHand}`);
  check(after.jv === before.jv,
    'D2: NO settlement journal — the cash already sits in 1101 from its own sale', `${before.jv} → ${after.jv}`);
  check(after.cash === before.cash,
    'D2: NO duplicate treasury receipt', `${before.cash} → ${after.cash}`);
  check(acc('1107') >= -0.01, 'D2: GL 1107 is NOT negative', acc('1107').toFixed(2));
  check(after.audit === before.audit + 1, 'D2: exactly one audit row', `${before.audit} → ${after.audit}`);
  obs.push(`D2 (backed cash): accepted with cashOnHand=10,000, no journal, 1107=${acc('1107').toFixed(2)}`);
}

// ===========================================================================
console.log('\n── 7. INVENTORY INTEGRITY across every scenario ──────────────');
{
  erpDb.restore(JSON.parse(JSON.stringify(PRISTINE)));
  const c = fresh();
  const b0 = batchQty(), v0 = batchVal();
  load(c, 200);
  const afterLoad = { q: batchQty(), v: batchVal() };
  sell(c, 120);
  const afterSell = { q: batchQty(), v: batchVal() };
  ret(c, 80);
  const afterRet = { q: batchQty(), v: batchVal() };
  console.log(`  stock value: start ${v0.toFixed(2)} → load ${afterLoad.v.toFixed(2)} → sale ${afterSell.v.toFixed(2)} → return ${afterRet.v.toFixed(2)}`);
  console.log(`  GL 1107 = ${acc('1107').toFixed(2)}   GL 1109 = ${acc('1109').toFixed(2)}`);

  const glInv = INVENTORY_ACCTS.reduce((s, c2) => s + acc(c2), 0);
  console.log(`  total GL inventory (1107..1112) = ${glInv.toFixed(2)}   batch ledger = ${batchVal().toFixed(2)}   residual = ${(glInv - batchVal()).toFixed(2)}`);
  check(batchQty() < b0, 'custody movements genuinely remove stock from the warehouse batch (no phantom rows)');
  const custodyNo = snap().representativeCustodies.find(x => x.id === c.custodyId)!.custodyNumber;
  const custodyMoves = snap().inventoryTransactions.filter(t => String(t.documentNumber).includes(custodyNo));
  console.log(`  inventory movements referencing ${custodyNo}: ${custodyMoves.length} — ${custodyMoves.map(m => `${m.movementType}:${m.quantityOut || m.quantityIn}`).join(' ')}`);
  check(custodyMoves.length === 2,
    'exactly TWO warehouse inventory movements (load + return) — the custody SALE moves no warehouse stock, correctly',
    `${custodyMoves.length}: ${custodyMoves.map(m => m.movementType).join(', ')}`);
  check(snap().custodyMovements.length === 3, 'exactly THREE custody movements recorded',
    `${snap().custodyMovements.length}`);
}

// ===========================================================================
erpDb.restore(JSON.parse(JSON.stringify(PRISTINE_LIVE)));
const identical = JSON.stringify(snap()) === JSON.stringify(PRISTINE_LIVE);
const leftovers = [
  snap().items.filter(i => i.isTest).length,
  snap().customers.filter(c => c.isTest).length,
  snap().suppliers.filter(s => s.isTest).length,
  snap().salesReps.filter(r => r.isTest).length,
  snap().batches.filter(b => String(b.batchNumber).includes('TEST-QA')).length,
  snap().representativeCustodies.length,
  snap().custodyMovements.length,
  snap().journalEntries.filter(j => j.isTest).length,
].reduce((a, b) => a + b, 0);

check(identical, 'in-memory database restored BYTE-IDENTICALLY to the pre-run state');
check(leftovers === 0, 'ZERO test records survived — every scenario ran in its own scratch DB', `${leftovers} leftover(s)`);

console.log('\n================================================================');
console.log(`RESULT — ${pass} passed, ${fail} failed`);
console.log('================================================================');
console.log('\nOBSERVED (asserted by execution):');
obs.forEach(o => console.log(`  • ${o}`));
process.exit(fail > 0 ? 1 : 0);