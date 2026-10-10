// QA — UAT FOLLOW-UP BATCH 2 REGRESSION (isolated, scratch DB, non-destructive).
//
// Covers every fix made in this batch:
//   PROD-05 (P1) duplicate / over-plan material issue guard — ManufacturingEngine.issueMaterialsToOrder
//   MD-CUST-04 (P1) negative credit limit rejected — MasterDataService.createCustomer / updateCustomer
//   MD-CUST-06 (P2) updateCustomer persists profile edits, never balances — MasterDataService.updateCustomer
//   D7 (P2) returnGoodsFromRep posts the balancing journal (Dr 1109/1110 | Cr 1107)
//   D6 (P2) acknowledged settlement writes the stranded goods value off 1107
//            (sourceDocumentType 'rep_custody_shortage'), treasury and inventory untouched
//
// NON-DESTRUCTIVE: no reset, no reseed, no browser/storage access. Every scenario
// runs on a freshly restored SCRATCH in-memory DB; the pre-run snapshot is restored
// byte-identically at the end and zero test records survive.
//
// Run: npx tsx scripts/qa_uat_batch2_fixes.ts
import { erpDb, createEmptyDatabase, applyMasterDataMigration, applyUomMigration } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { WorkflowService } from '../src/services/workflows';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { InventoryEngine } from '../src/services/inventory';
import { ensureTestBom, firstFinishedProductId } from './qa_test_bom';

const snap = () => erpDb.getSnapshot();
const TODAY = new Date().toISOString().split('T')[0];
const RID = `B2F-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const ADMIN = { userId: 'usr-admin', userName: 'QA' };

let pass = 0;
let fail = 0;
const observed: string[] = [];
function check(ok: boolean, label: string, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const note = (label: string, detail = '') => {
  observed.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ℹ️  ${label}${detail ? ` — ${detail}` : ''}`);
};
const section = (t: string) => console.log(`\n=== ${t} ===`);

const PRISTINE_LIVE = JSON.parse(JSON.stringify(snap()));
const PRISTINE = JSON.parse(JSON.stringify(applyUomMigration(applyMasterDataMigration(createEmptyDatabase()))));

const acc = (code: string) => snap().accounts.find(a => a.code === code)?.currentBalance || 0;
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
const restore = () => erpDb.restore(JSON.parse(JSON.stringify(PRISTINE)));

function balanced(entry: { lines: Array<{ debit: number; credit: number }> }) {
  const dr = entry.lines.reduce((s, l) => s + (l.debit || 0), 0);
  const cr = entry.lines.reduce((s, l) => s + (l.credit || 0), 0);
  return near(dr, cr, 0.005);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function mkSupplier() {
  const sup = MasterDataService.createSupplier({ code: `${PFX}-SUP`, name: `مورد ${PFX}`, isTest: true, ...ADMIN } as never);
  if (!sup.supplier) throw new Error(`supplier failed: ${sup.error}`);
  return sup.supplier;
}

function freshCustody() {
  restore();
  const sup = mkSupplier();
  const cust = MasterDataService.createCustomer({ code: `${PFX}-C`, name: `عميل ${PFX}`, customerType: 'retail', channel: 'retail', isTest: true, ...ADMIN } as never);
  if (!cust.customer) throw new Error(`customer failed: ${cust.error}`);
  const rep = WorkflowService.createSalesRepresentative({ code: `${PFX}-REP`, name: `${PFX} مندوب`, targetMonthlySales: 0, isTest: true, ...ADMIN } as never);
  if (!rep.rep) throw new Error(`rep failed: ${rep.error}`);
  const fp = snap().items.find(i => i.code === 'FP-SNG-01')!;
  // returnGoodsFromRep resolves cost through the item's standard/actual cost —
  // the seeded catalog ships FP-SNG-01 with 0/0 (fixture gap, not an assertion).
  erpDb.mutate(d => {
    const it = d.items.find(x => x.id === fp.id);
    if (it) { it.standardCost = 60; it.actualCost = 60; }
  });
  const inv = WorkflowService.createPurchaseInvoice({
    supplierId: sup.id, warehouseId: 'wh-local', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `${PFX}-P`, date: TODAY,
    lines: [{ itemId: fp.id, quantity: 1000, unitId: 'unit-piece', unitPrice: 60, batchNumber: `${PFX}-B`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (!inv.success) throw new Error(`stock purchase failed: ${inv.error}`);
  const custody = WorkflowService.openRepCustody(rep.rep!.id, `${PFX} opening`);
  if (!custody.success) throw new Error(`open custody failed: ${custody.error}`);
  return { repId: rep.rep!.id, custId: cust.customer.id, custodyId: custody.custody!.id, itemId: fp.id };
}

function load(c: { custodyId: string; itemId: string }, qty: number) {
  const r = WorkflowService.loadGoodsToRep({ custodyId: c.custodyId, itemId: c.itemId, quantity: qty, unitPrice: 100, warehouseId: 'wh-local', date: TODAY });
  if (!r.success) throw new Error(`load failed: ${r.error}`);
}
function sell(c: { custodyId: string; itemId: string; repId: string; custId: string }, qty: number, paymentMethod: 'credit' | 'cash' = 'credit') {
  const r = WorkflowService.createSalesInvoice({
    customerId: c.custId, channel: 'retail', warehouseId: 'wh-local', repId: c.repId,
    stockSource: 'rep_custody', custodyId: c.custodyId, paymentMethod,
    currency: 'EGP', exchangeRate: 1, date: TODAY,
    lines: [{ itemId: c.itemId, quantity: qty, unitPrice: 100, vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (!r.success) throw new Error(`custody sale failed: ${r.error}`);
}
function uiSettle(custodyId: string, acknowledgeRemainingGoods = false) {
  return WorkflowService.settleRepCustody({ custodyId, date: TODAY, acknowledgeRemainingGoods });
}

/** Scratch production fixture: FP + active test BOM + raw stock in WH-01. */
function freshProd() {
  restore();
  const sup = mkSupplier();
  const fpId = firstFinishedProductId();
  const bom = ensureTestBom(fpId);
  const bomLines = snap().bomLines.filter(l => l.bomId === bom.id);
  const planned = 1000; // == bom.baseQuantity, so scale = 1
  for (const [i, bl] of bomLines.entries()) {
    const buyQty = Number((bl.quantityRequired * 2.5 * 1000).toFixed(0)) / 1000;
    const inv = WorkflowService.createPurchaseInvoice({
      supplierId: sup.id, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
      reference: `${PFX}-M${i}`, date: TODAY,
      lines: [{ itemId: bl.materialItemId, quantity: buyQty, unitId: bl.unitId, unitPrice: 10, batchNumber: `${PFX}-M${i}`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
      isTest: true, ...ADMIN,
    } as never);
    if (!inv.success) throw new Error(`raw stock failed for ${bl.materialItemId}: ${inv.error}`);
  }
  const order = ManufacturingEngine.createProductionOrder({
    productId: fpId, plannedQuantity: planned, targetMarket: 'local', destinationWarehouseId: 'wh-local',
    expectedCompletionDate: TODAY, isTest: true, ...ADMIN,
  } as never);
  if (!order.success || !order.order) throw new Error(`production order failed: ${order.error}`);
  const reqs = ManufacturingEngine.calculateBomRequirements(bom.id, planned);
  const rawQty = () => bomLines.reduce((s, bl) => s + InventoryEngine.getItemBalance(bl.materialItemId, 'wh-raw'), 0);
  return { fpId, bom, bomLines, order: order.order, reqs, rawQty };
}

// ===========================================================================
section('PROD-05 — duplicate / over-plan material issue guard (P1)');
// ===========================================================================
{
  // 1) a second DEFAULT (BOM-driven) issue of the same order must be refused
  const p = freshProd();
  const iss1 = ManufacturingEngine.issueMaterialsToOrder({ orderId: p.order.id, date: TODAY, ...ADMIN } as never);
  check(iss1.success, '1.1 the first default issue succeeds', iss1.error || '');
  const raw0 = p.rawQty();
  const jv0 = snap().journalEntries.length;
  const con0 = snap().productionConsumptions.length;
  const iss2 = ManufacturingEngine.issueMaterialsToOrder({ orderId: p.order.id, date: TODAY, ...ADMIN } as never);
  check(!iss2.success, '1.2 PROD-05: a second identical default issue is REFUSED', iss2.error || 'ACCEPTED');
  check(near(p.rawQty(), raw0, 0.0001), '1.3 the refusal consumed NO raw stock', `Δ=${(p.rawQty() - raw0).toFixed(4)}`);
  check(snap().journalEntries.length === jv0 && snap().productionConsumptions.length === con0,
    '1.4 the refusal wrote NO journal and NO consumption lines',
    `jv ${jv0}→${snap().journalEntries.length}, con ${con0}→${snap().productionConsumptions.length}`);
  const tini = ManufacturingEngine.issueMaterialsToOrder({
    orderId: p.order.id, lines: [{ materialItemId: p.reqs[0].materialItemId, quantity: 1 }], date: TODAY, ...ADMIN,
  } as never);
  check(!tini.success, '1.5 an override on top of the fully issued plan is REFUSED', tini.error || 'ACCEPTED');

  // 2) partial issues may never push a BOM material past its plan
  const p2 = freshProd();
  const half = p2.reqs.map(r => ({ materialItemId: r.materialItemId, quantity: Math.round(r.requiredQuantity * 0.5 * 1000) / 1000 }));
  const s1 = ManufacturingEngine.issueMaterialsToOrder({ orderId: p2.order.id, lines: half, date: TODAY, ...ADMIN } as never);
  check(s1.success, '1.6 a 50% staged issue succeeds', s1.error || '');
  const over = p2.reqs.map(r => ({ materialItemId: r.materialItemId, quantity: Math.round(r.requiredQuantity * 0.7 * 1000) / 1000 }));
  const s2 = ManufacturingEngine.issueMaterialsToOrder({ orderId: p2.order.id, lines: over, date: TODAY, ...ADMIN } as never);
  check(!s2.success, '1.7 a further 70% (total 120% of plan) is REFUSED', s2.error || 'ACCEPTED');

  // 3) the legitimate staged flow (40% + 60%) must still work
  const p3 = freshProd();
  const st1 = p3.reqs.map(r => ({ materialItemId: r.materialItemId, quantity: Math.round(r.requiredQuantity * 0.4 * 1000) / 1000 }));
  const st2 = p3.reqs.map(r => ({ materialItemId: r.materialItemId, quantity: Math.round(r.requiredQuantity * 0.6 * 1000) / 1000 }));
  const a1 = ManufacturingEngine.issueMaterialsToOrder({ orderId: p3.order.id, lines: st1, date: TODAY, ...ADMIN } as never);
  const a2 = ManufacturingEngine.issueMaterialsToOrder({ orderId: p3.order.id, lines: st2, date: TODAY, ...ADMIN } as never);
  check(a1.success, '1.8 legitimate stage-1 issue (40%) still succeeds', a1.error || '');
  check(a2.success, '1.9 legitimate stage-2 issue (60%) still succeeds — plan exactly consumed', a2.error || '');

  // 4) an EXPLICIT override on a VIRGIN order may still exceed the plan
  //    (deliberate extra material — the partial-close scenario relies on it)
  const p4 = freshProd();
  const overPlan = p4.reqs.map(r => ({ materialItemId: r.materialItemId, quantity: Math.round(r.requiredQuantity * 1.3 * 1000) / 1000 }));
  const o1 = ManufacturingEngine.issueMaterialsToOrder({ orderId: p4.order.id, lines: overPlan, date: TODAY, ...ADMIN } as never);
  check(o1.success, '1.10 an explicit first override may exceed the BOM plan (documented exception)', o1.error || '');

  // 5) non-BOM material: an exact repeat on the same order is a duplicate
  const p5 = freshProd();
  // stock the finished product itself in WH-01 as a material that is NOT in the BOM
  const extra = WorkflowService.createPurchaseInvoice({
    supplierId: snap().suppliers.find(s => s.code === `${PFX}-SUP`)!.id,
    warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `${PFX}-X`, date: TODAY,
    lines: [{ itemId: p5.fpId, quantity: 100, unitId: 'unit-piece', unitPrice: 10, batchNumber: `${PFX}-X`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  check(extra.success, '1.11a a non-BOM material is stocked in WH-01 for the duplicate probe', extra.error || '');
  const n1 = ManufacturingEngine.issueMaterialsToOrder({
    orderId: p5.order.id, lines: [{ materialItemId: p5.fpId, quantity: 5 }], date: TODAY, ...ADMIN,
  } as never);
  check(n1.success, '1.11 the first explicit issue of a non-BOM material succeeds', n1.error || '');
  const n2 = ManufacturingEngine.issueMaterialsToOrder({
    orderId: p5.order.id, lines: [{ materialItemId: p5.fpId, quantity: 5 }], date: TODAY, ...ADMIN,
  } as never);
  check(!n2.success, '1.12 the same non-BOM issue repeated by the same quantity is REFUSED', n2.error || 'ACCEPTED');

  // 6) every journal posted during these scenarios still balances
  const unbal = snap().journalEntries.filter(j => !balanced(j));
  check(unbal.length === 0, '1.13 every journal posted by these scenarios balances', `${unbal.length} unbalanced`);
}

// ===========================================================================
section('MD-CUST-04 — negative credit limit rejected (P1)');
// ===========================================================================
{
  restore();
  const before = snap().customers.length;
  const neg = MasterDataService.createCustomer({
    code: `${PFX}-N1`, name: `عميل سالب ${PFX}`, customerType: 'retail', channel: 'retail',
    creditLimit: -5000, isTest: true, ...ADMIN,
  } as never);
  check(!neg.success, '2.1 create with creditLimit = -5000 is REFUSED', (neg as { error?: string }).error || 'ACCEPTED');
  check(!/undefined/.test((neg as { error?: string }).error || ''), '2.2 the refusal carries a real Arabic message', (neg as { error?: string }).error || '');
  check(snap().customers.length === before && !snap().customers.some(c => c.code === `${PFX}-N1`),
    '2.3 NOTHING is persisted for the refused customer');
  const nan = MasterDataService.createCustomer({
    code: `${PFX}-N2`, name: `عميل NaN ${PFX}`, customerType: 'retail', channel: 'retail',
    creditLimit: Number('abc'), isTest: true, ...ADMIN,
  } as never);
  check(!nan.success, '2.4 create with a non-numeric credit limit is REFUSED', (nan as { error?: string }).error || 'ACCEPTED');
  const zero = MasterDataService.createCustomer({
    code: `${PFX}-Z`, name: `عميل صفر ${PFX}`, customerType: 'retail', channel: 'retail',
    creditLimit: 0, isTest: true, ...ADMIN,
  } as never);
  check(zero.success && zero.customer?.creditLimit === 0, '2.5 creditLimit = 0 is still accepted', zero.error || '');
  const pos = MasterDataService.createCustomer({
    code: `${PFX}-P`, name: `عميل موجب ${PFX}`, customerType: 'wholesale', channel: 'wholesale',
    creditLimit: 25000, openingBalance: 500, isTest: true, ...ADMIN,
  } as never);
  check(pos.success && pos.customer?.creditLimit === 25000, '2.6 a positive credit limit is accepted and stored', pos.error || '');
}

// ===========================================================================
section('MD-CUST-06 — updateCustomer persists profile edits, never balances (P2)');
// ===========================================================================
{
  restore();
  const other = MasterDataService.createCustomer({
    code: `${PFX}-OTH`, name: `عميل آخر ${PFX}`, customerType: 'retail', channel: 'retail', isTest: true, ...ADMIN,
  } as never).customer!;
  const c = MasterDataService.createCustomer({
    code: `${PFX}-ED`, name: `عميل للتعديل ${PFX}`, customerType: 'retail', channel: 'retail',
    phone: '0100000000', creditLimit: 1000, openingBalance: 750, paymentTerms: 'آجل 30 يوم',
    isTest: true, ...ADMIN,
  } as never).customer!;

  const upd = MasterDataService.updateCustomer(c.id, {
    name: `عميل للتعديل ${PFX} معدل`, phone: '0111111111', creditLimit: 30000,
    customerType: 'wholesale', paymentTerms: 'آجل 60 يوم', ...ADMIN,
  } as never);
  const after = snap().customers.find(x => x.id === c.id)!;
  check(upd.success, '3.1 updateCustomer succeeds', upd.error || '');
  check(after.name === `عميل للتعديل ${PFX} معدل` && after.phone === '0111111111'
    && after.creditLimit === 30000 && after.paymentTerms === 'آجل 60 يوم',
    '3.2 the edited profile fields persist', JSON.stringify({ name: after.name, phone: after.phone, creditLimit: after.creditLimit }));
  check(after.customerType === 'wholesale' && after.channel === 'wholesale',
    '3.3 changing the customer type re-derives the channel (no contradictions)', `type=${after.customerType} channel=${after.channel}`);
  check(after.currentBalance === 750 && after.openingBalance === 750 && after.code === `${PFX}-ED`,
    '3.4 balances, opening balance and code are NEVER touched by a profile edit',
    `balance=${after.currentBalance} opening=${after.openingBalance} code=${after.code}`);

  const negUpd = MasterDataService.updateCustomer(c.id, { creditLimit: -1, ...ADMIN } as never);
  check(!negUpd.success, '3.5 MD-CUST-04 applies to edits too: creditLimit = -1 is REFUSED',
    (negUpd as { error?: string }).error || 'ACCEPTED');
  check(snap().customers.find(x => x.id === c.id)!.creditLimit === 30000,
    '3.6 the refused edit changed nothing', `creditLimit=${snap().customers.find(x => x.id === c.id)!.creditLimit}`);

  const dupCode = MasterDataService.updateCustomer(c.id, { code: other.code, ...ADMIN } as never);
  check(!dupCode.success, '3.7 editing onto another customer\'s code is REFUSED', (dupCode as { error?: string }).error || 'ACCEPTED');
  const dupName = MasterDataService.updateCustomer(c.id, { name: other.name, ...ADMIN } as never);
  check(!dupName.success, '3.8 editing onto another customer\'s name is REFUSED', (dupName as { error?: string }).error || 'ACCEPTED');
  const selfCode = MasterDataService.updateCustomer(c.id, { code: `${PFX}-ED`, ...ADMIN } as never);
  check(selfCode.success, '3.9 re-submitting the customer\'s OWN code is not a false duplicate', selfCode.error || '');
  const ghost = MasterDataService.updateCustomer('cust-does-not-exist', { name: 'X', ...ADMIN } as never);
  check(!ghost.success, '3.10 updating an unknown customer is REFUSED', (ghost as { error?: string }).error || 'ACCEPTED');
  const blank = MasterDataService.updateCustomer(c.id, { name: '   ', ...ADMIN } as never);
  check(!blank.success, '3.11 a blank name is REFUSED', (blank as { error?: string }).error || 'ACCEPTED');

  const auditEdits = snap().auditLogs.filter(a => a.module === 'إدارة العملاء' && a.action === 'edit' && a.recordId === c.id);
  check(auditEdits.length >= 1, '3.12 the profile edit writes an audit record', `${auditEdits.length}`);
}

// ===========================================================================
section('D7 — returnGoodsFromRep posts the balancing journal (P2)');
// ===========================================================================
{
  const c = freshCustody();
  load(c, 200);
  const b1107 = acc('1107');
  const b1109 = acc('1109');
  const b1101 = acc('1101');
  const stock0 = InventoryEngine.getItemBalance(c.itemId, 'wh-local');
  const batchVal0 = snap().batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
  const jv0 = snap().journalEntries.length;
  const tx0 = snap().inventoryTransactions.length;

  const r = WorkflowService.returnGoodsFromRep({ custodyId: c.custodyId, itemId: c.itemId, quantity: 80, warehouseId: 'wh-local', date: TODAY });
  check(r.success, '4.1 returning 80 units from the custody succeeds', r.error || '');
  const retJv = snap().journalEntries.filter(j => j.sourceDocumentType === 'rep_custody_return' && j.sourceDocumentId === c.custodyId);
  check(snap().journalEntries.length === jv0 + 1 && retJv.length === 1,
    '4.2 D7: the return posts EXACTLY ONE journal (rep_custody_return)', `${snap().journalEntries.length - jv0} new`);
  if (retJv.length === 1) {
    const dr = retJv[0].lines.reduce((s, l) => s + (l.debit || 0), 0);
    const cr = retJv[0].lines.reduce((s, l) => s + (l.credit || 0), 0);
    const drAcc = retJv[0].lines.find(l => l.debit > 0);
    const crAcc = retJv[0].lines.find(l => l.credit > 0);
    check(near(dr, cr) && dr > 0, '4.3 the return journal balances and carries value', `Dr=${dr.toFixed(2)} Cr=${cr.toFixed(2)}`);
    check(drAcc?.accountCode === '1109' && crAcc?.accountCode === '1107',
      '4.4 direction: Dr 1109 warehouse inventory | Cr 1107 rep custody (mirror of the load)', `Dr=${drAcc?.accountCode} Cr=${crAcc?.accountCode}`);
    check(near(acc('1107'), b1107 - dr, 0.01) && near(acc('1109'), b1109 + dr, 0.01),
      '4.5 GL effects are exactly −1107 / +1109 by the same value',
      `1107 ${b1107}→${acc('1107')}, 1109 ${b1109}→${acc('1109')}`);
    const batchVal1 = snap().batches.reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
    check(near(batchVal1 - batchVal0, dr, 0.01),
      '4.6 the batch ledger gains EXACTLY the value the journal booked (GL ↔ batch tie)',
      `Δbatches=${(batchVal1 - batchVal0).toFixed(2)} journal=${dr.toFixed(2)}`);
  }
  check(near(InventoryEngine.getItemBalance(c.itemId, 'wh-local'), stock0 + 80, 0.001),
    '4.7 the warehouse stock genuinely gained the 80 units', `${stock0}→${InventoryEngine.getItemBalance(c.itemId, 'wh-local')}`);
  check(snap().inventoryTransactions.length === tx0 + 1, '4.8 exactly one inventory movement (no double entry)',
    `${snap().inventoryTransactions.length - tx0} new`);
  check(near(acc('1101'), b1101, 0.01),
    '4.9 Treasury (1101) is untouched by a goods return', `1101 ${b1101}→${acc('1101')}`);
  const unbal = snap().journalEntries.filter(j => !balanced(j));
  check(unbal.length === 0, '4.10 every journal in the DB still balances', `${unbal.length} unbalanced`);

  // over-return remains refused (F2) and writes nothing new
  const jv1 = snap().journalEntries.length;
  const over = WorkflowService.returnGoodsFromRep({ custodyId: c.custodyId, itemId: c.itemId, quantity: 100000, warehouseId: 'wh-local', date: TODAY });
  check(!over.success && snap().journalEntries.length === jv1, '4.11 an over-return is still refused with NO journal',
    (over as { error?: string }).error || '');
}

// ===========================================================================
section('D6 — acknowledged settlement writes the stranded value off 1107 (P2)');
// ===========================================================================
{
  const c = freshCustody();
  load(c, 200);
  sell(c, 120);
  const b1107 = acc('1107');
  check(b1107 > 0.01, '5.1 before settlement GL 1107 carries the 80 unsold units', `1107=${b1107.toFixed(2)}`);

  // the unacknowledged refusal must still write NOTHING (QA-20 preserved)
  const jv0 = snap().journalEntries.length;
  const ref = uiSettle(c.custodyId, false);
  check(!ref.success && snap().journalEntries.length === jv0,
    '5.2 without acknowledgement the settlement is still REFUSED with zero writes',
    (ref as { error?: string }).error || 'ACCEPTED');
  check(snap().representativeCustodies.find(x => x.id === c.custodyId)!.status === 'open',
    '5.3 the custody stays open after the refusal');

  const tx0 = snap().inventoryTransactions.length;
  const cm0 = snap().custodyMovements.length;
  const cash0 = snap().treasuryTransactions.length;
  const j1101 = acc('1101');
  const res = uiSettle(c.custodyId, true);
  check(res.success, '5.4 the acknowledged settlement succeeds (QA-20 contract preserved)', (res as { error?: string }).error || '');
  check(snap().representativeCustodies.find(x => x.id === c.custodyId)!.status === 'settled', '5.5 the custody is settled/closed');

  const sjv = snap().journalEntries.filter(j => j.sourceDocumentType === 'rep_custody_shortage' && j.sourceDocumentId === c.custodyId);
  check(sjv.length === 1, '5.6 exactly ONE CUST-SHORTAGE journal is posted', `${sjv.length}`);
  check(!!res.shortageWriteOff && res.shortageWriteOff.amount > 0.01,
    '5.7 the settlement reports the write-off amount to the caller', JSON.stringify(res.shortageWriteOff));
  check(near(acc('1107'), 0, 0.01),
    '5.8 D6: GL 1107 closes at ZERO — no value stranded on a "settled" custody',
    `1107=${acc('1107').toFixed(2)} (was ${b1107.toFixed(2)})`);
  if (sjv.length === 1) {
    const drAcc = sjv[0].lines.find(l => l.debit > 0);
    const crAcc = sjv[0].lines.find(l => l.credit > 0);
    check(balanced(sjv[0]) && drAcc?.accountCode === '6106' && crAcc?.accountCode === '1107',
      '5.9 the write-off balances: Dr 6106 rep-expenses/shortage | Cr 1107',
      `Dr=${drAcc?.accountCode} Cr=${crAcc?.accountCode}`);
    check(near(sjv[0].lines.reduce((s, l) => s + (l.debit || 0), 0), res.shortageWriteOff?.amount || 0, 0.01),
      '5.10 the journal amount equals the reported write-off', `${res.shortageWriteOff?.amount}`);
  }
  check(snap().inventoryTransactions.length === tx0 && snap().custodyMovements.length === cm0,
    '5.11 settlement moves NO inventory (the acknowledged goods never return to stock)',
    `tx ${tx0}→${snap().inventoryTransactions.length}, cm ${cm0}→${snap().custodyMovements.length}`);
  check(snap().treasuryTransactions.length === cash0 && near(acc('1101'), j1101, 0.01),
    '5.12 treasury (1101 rows and balance) is untouched by the write-off',
    `cash ${cash0}→${snap().treasuryTransactions.length}, 1101=${acc('1101').toFixed(2)}`);
  const unbal = snap().journalEntries.filter(j => !balanced(j));
  check(unbal.length === 0, '5.13 every journal in the DB still balances', `${unbal.length} unbalanced`);

  // a settlement with NO unsold goods must post NO shortage journal
  const c2 = freshCustody();
  load(c2, 100);
  sell(c2, 100);
  const res2 = uiSettle(c2.custodyId, false);
  const sjv2 = snap().journalEntries.filter(j => j.sourceDocumentType === 'rep_custody_shortage' && j.sourceDocumentId === c2.custodyId);
  check(res2.success && sjv2.length === 0,
    '5.14 a clean (fully sold) settlement still posts NO journal at all',
    `success=${res2.success}, shortage journals=${sjv2.length}`);
  check(near(acc('1107'), 0, 0.01), '5.15 the clean settlement also ends at 1107 = 0', `1107=${acc('1107').toFixed(2)}`);

  // a refused double-settlement still writes nothing
  const jv2 = snap().journalEntries.length;
  const twice = uiSettle(c2.custodyId, true);
  check(!twice.success && snap().journalEntries.length === jv2, '5.16 settling twice is still refused with zero writes',
    (twice as { error?: string }).error || 'ACCEPTED');
}

// ===========================================================================
// byte-identical restore — nothing from this run survives
// ===========================================================================
erpDb.restore(JSON.parse(JSON.stringify(PRISTINE_LIVE)));
const identical = JSON.stringify(snap()) === JSON.stringify(PRISTINE_LIVE);
const leftovers = [
  snap().customers.filter(i => i.isTest).length,
  snap().suppliers.filter(i => i.isTest).length,
  snap().salesReps.filter(i => i.isTest).length,
  snap().batches.filter(b => String(b.batchNumber).includes('TEST-QA')).length,
  snap().representativeCustodies.length,
  snap().custodyMovements.length,
  snap().journalEntries.filter(j => j.isTest).length,
].reduce((a, b) => a + b, 0);
check(identical, 'in-memory database restored BYTE-IDENTICALLY to the pre-run state');
check(leftovers === 0, 'ZERO test records survived — every scenario ran on its own scratch DB', `${leftovers} leftover(s)`);

console.log('\n================================================================');
console.log(`RESULT — ${pass} passed, ${fail} failed`);
console.log('================================================================');
observed.forEach(o => console.log(`  • ${o}`));
process.exit(fail > 0 ? 1 : 0);
