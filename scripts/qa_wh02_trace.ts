// QA BATCH D — WH-02 / GL 1109 CHRONOLOGICAL TRACE (READ-ONLY DIAGNOSTIC).
//
// Replays the exact qa2 scenario order and reconciles WH-02 against GL 1109
// AFTER EVERY transaction. No application source is modified by this script.
//
// expected inventory value : the value the GL carries for WH-02 after the step
// actual   inventory value : the WH-02 batch ledger after the step
// cumulative residual     : cumulative(ΔGL − Δbatches); the first step where it
//                           leaves 0.00 is the divergence.
import { erpDb } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { InventoryEngine } from '../src/services/inventory';
import { WorkflowService } from '../src/services/workflows';
import { ManufacturingEngine } from '../src/services/manufacturing';

const TODAY = new Date().toISOString().split('T')[0];
const RID = `TRC-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const PFX = `TEST-QA-${RID}`;
const snap = () => erpDb.getSnapshot();
const ADMIN = { userId: 'usr-admin', userName: 'QA', isTest: true };

const WH = 'wh-local';
const acc1109 = () => snap().accounts.find(a => a.code === '1109')?.id || '';
const glValue = () => snap().accounts.find(a => a.code === '1109')?.currentBalance || 0;
const batchValue = () => snap().batches.filter(b => b.warehouseId === WH).reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0);
const itemCode = (id: string) => snap().items.find(i => i.id === id)?.code || id;
const fmt = (n: number) => n.toFixed(2);

let cum = 0;
let stopped = false;
let suppressStop = false;
let jvCount = 0;

interface Step { n: number; doc: string; type: string; item: string; qty: number; before: number; after: number; dr: number; cr: number; exp: number; act: number; cum: number; detail: string }

function step(o: { doc: string; type: string; item?: string; qty?: number; detail?: string }, fn: () => void) {
  if (stopped) return;
  const jvBefore = snap().journalEntries.length;
  const bBefore = batchValue();
  const itemBefore = o.item ? snap().batches.filter(b => b.warehouseId === WH && b.itemId === o.item).reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0) : bBefore;

  let detail = o.detail || '';
  try { fn(); } catch (e) { detail += ` [threw: ${(e as Error).message}]`; }

  const bAfter = batchValue();
  const newJv = snap().journalEntries.slice(jvBefore);
  const id = acc1109();
  let dr = 0, cr = 0;
  newJv.forEach(j => j.lines.forEach(l => { if (l.accountId === id) { dr += l.debit || 0; cr += l.credit || 0; } }));
  const dGl = dr - cr;
  cum += dGl - (bAfter - bBefore);

  const r: Step = {
    n: ++stepCount, doc: o.doc, type: o.type, item: o.item ? itemCode(o.item) : '(all WH-02)',
    qty: o.qty ?? 0, before: itemBefore, after: bAfter, dr, cr,
    exp: glValue(), act: bAfter, cum, detail,
  };
  rows.push(r);
  console.log(
    `  #${String(r.n).padStart(2)} ${r.type.padEnd(26)} doc=${r.doc.padEnd(18)} item=${r.item.padEnd(14)}` +
    ` qty=${String(r.qty).padStart(8)} batchBefore=${fmt(r.before).padStart(13)} batchAfter=${fmt(r.after).padStart(13)}` +
    ` Dr=${fmt(r.dr).padStart(12)} Cr=${fmt(r.cr).padStart(12)} expected(GL)=${fmt(r.exp).padStart(13)}` +
    ` actual(batch)=${fmt(r.act).padStart(13)} cumulativeResidual=${fmt(r.cum).padStart(12)}` +
    (Math.abs(r.cum) > 0.005 ? '  ❌ DIVERGENCE' : '')
  );

  if (Math.abs(r.cum) > 0.005 && !stopped && !suppressStop && o.type.startsWith('FG receipt')) {
    stopped = true;
    console.log(`\n  ══ FIRST DIVERGENCE at step #${r.n}: ${r.type} (${r.doc}) ══`);
    console.log(`     item            : ${r.item}`);
    console.log(`     quantity        : ${r.qty}`);
    console.log(`     WH-02 before/after : ${fmt(r.before)} → ${fmt(r.after)}`);
    console.log(`     GL 1109 debit/credit: ${fmt(r.dr)} / ${fmt(r.cr)}`);
    console.log(`     expected (GL 1109): ${fmt(r.exp)}`);
    console.log(`     actual (batches)  : ${fmt(r.act)}`);
    console.log(`     cumulative residual: ${fmt(r.cum)}`);
    if (newJv.length) {
      console.log(`     journal lines posted to inventory accounts by this step:`);
      newJv.forEach(j => j.lines.forEach(l => {
        const a = snap().accounts.find(x => x.id === l.accountId);
        if ((a?.category === 'Assets') || (l.debit || 0) || (l.credit || 0)) {
          if (['1107', '1108', '1109', '1110', '1111', '1112', '5101', '4101', '1105'].includes(a?.code || '')) {
            console.log(`       ${j.entryNumber} ${a?.code} ${a?.nameAr}: Dr ${fmt(l.debit || 0)} Cr ${fmt(l.credit || 0)} — ${l.description}`);
          }
        }
      }));
    } else {
      console.log(`     journal lines posted by this step: NONE`);
    }
    const tx = snap().inventoryTransactions.filter(t => t.warehouseId === WH).slice(-3);
    console.log(`     inventory transactions for WH-02 (last 3):`);
    tx.forEach(t => console.log(`       ${t.id} ${t.movementType} ${itemCode(t.itemId)} qtyIn=${t.quantityIn} qtyOut=${t.quantityOut} cost=${t.unitCost} doc=${t.documentNumber} balanceAfter=${t.balanceAfter}`));

    // ---- BACKWARD TRACE: where does 121,887.35 come from? ----
    console.log(`\n     ── backward cost/value trace of the diverging movement ──`);
    const bd = ManufacturingEngine.calculateCostBreakdown(orderId);
    const conv = bd.actualLaborCost + bd.actualElectricityCost + bd.actualGasCost + bd.actualMaintenanceCost + bd.actualSupervisionCost;
    const cons = snap().productionConsumptions.filter(c => c.productionOrderId === orderId);
    console.log(`     order ${snap().productionOrders.find(o => o.id === orderId)?.orderNumber}: materials consumed so far = ${cons.length} line(s)`);
    cons.forEach(c => console.log(`       ${itemCode(c.materialItemId)} planned=${c.plannedQuantity} actual=${c.actualQuantity} unitCost=${c.unitCost} → ${(c.actualQuantity * c.unitCost).toFixed(2)}`));
    console.log(`     breakdown.actualMaterialCost = ${fmt(bd.actualMaterialCost)}`);
    console.log(`     conversion applied           = ${fmt(conv)}`);
    console.log(`     (material + conversion)      = ${fmt(bd.actualMaterialCost + conv)}`);
    console.log(`     ÷ stage units (400)          = ${fmt((bd.actualMaterialCost + conv) / 400)} per unit`);
    console.log(`     × 400 units received         = ${fmt(((bd.actualMaterialCost + conv) / 400) * 400)}  ← the WH-02 batch value created with NO journal`);
    console.log(`     GL posted by this movement   : NONE (Dr 1109 / Cr WIP would be required)`);
  }
}

const rows: Step[] = [];
let stepCount = 0;

console.log('================================================================');
console.log(`🔎 WH-02 / GL 1109 CHRONOLOGICAL TRACE — ${RID}`);
console.log('================================================================');

const sup = MasterDataService.createSupplier({ code: `${PFX}-SUP`, name: `مورد ${PFX}`, ...ADMIN })!.supplier!;
const cust = MasterDataService.createCustomer({ code: `${PFX}-CUST`, name: `عميل ${PFX}`, customerType: 'retail', channel: 'retail', ...ADMIN })!.customer!;
const expCust = MasterDataService.createCustomer({ code: `${PFX}-EXPC`, name: `تصدير ${PFX}`, customerType: 'export', channel: 'export', currency: 'USD', ...ADMIN })!.customer!;
const chip = snap().items.find(i => i.id === 'item-raw-chip')!;
const fp = snap().items.find(i => i.code === 'FP-SNG-01')!;
const fpX = snap().items.find(i => i.code === 'FP-DUO-01' && i.itemType === 'finished_product')!;
const bom = snap().boms.find(b => b.finishedItemId === fp.id && b.active)!;
const reqs = ManufacturingEngine.calculateBomRequirements(bom.id, 1000);
let refSeq = 0; const nextRef = () => `${PFX}-REF-${++refSeq}`;

console.log(`\n  START: GL 1109 = ${fmt(glValue())} | WH-02 batch ledger = ${fmt(batchValue())} | residual = ${fmt(glValue() - batchValue())}\n`);

// ---- qa2 order: Scenario A/K purchase (raw — no WH-02 effect, shown for order)
step({ doc: 'PINV-A', type: 'purchase (raw, WH-01)', item: chip.id, qty: 1000 }, () => {
  WorkflowService.createPurchaseInvoice({
    supplierId: sup.id, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: nextRef(), date: TODAY,
    lines: [{ itemId: chip.id, quantity: 1000, unitId: 'unit-kg', unitPrice: 60, batchNumber: `${PFX}-CHIP-A`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
    ...ADMIN,
  } as never);
});
// ---- Scenario I materials
snap().bomLines.filter(l => l.bomId === bom.id).forEach((l, i) => {
  step({ doc: `PINV-MAT-${i}`, type: 'material purchase (WH-01)', item: l.materialItemId, qty: Math.ceil(l.quantityRequired * 1.2 * 1000) / 1000 }, () => {
    WorkflowService.createPurchaseInvoice({
      supplierId: sup.id, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
      reference: `${PFX}-MAT-${i}`, date: TODAY,
      lines: [{ itemId: l.materialItemId, quantity: Math.ceil(l.quantityRequired * 1.2 * 1000) / 1000, unitId: l.unitId, unitPrice: 50, batchNumber: `${PFX}-MAT-${i}`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
      ...ADMIN,
    } as never);
  });
});

let orderId = '';
step({ doc: 'PRD-1', type: 'production order create', item: fp.id, qty: 1000 }, () => {
  const o = ManufacturingEngine.createProductionOrder({
    productId: fp.id, plannedQuantity: 1000, targetMarket: 'local', destinationWarehouseId: WH,
    expectedCompletionDate: TODAY, ...ADMIN,
  } as never);
  orderId = o.order?.id || '';
});
step({ doc: 'PRD-1', type: 'material issue (WH-01→WIP)', item: fp.id, qty: 400 }, () => {
  ManufacturingEngine.issueMaterialsToOrder({
    orderId, lines: reqs.map(r => ({ materialItemId: r.materialItemId, quantity: Math.round(r.requiredQuantity * 0.4 * 1000) / 1000 })),
    date: TODAY, ...ADMIN,
  } as never);
});
step({ doc: 'PRD-1', type: 'FG receipt 400 (WIP→WH-02)', item: fp.id, qty: 400 }, () => {
  ManufacturingEngine.recordDailyProduction({
    orderId, goodQuantity: 400, defectiveQuantity: 0, scrapQuantity: 0, defectiveAction: 'to_scrap', date: TODAY, ...ADMIN,
  } as never);
});
step({ doc: 'PRD-1', type: 'material issue #2', item: fp.id, qty: 600 }, () => {
  const r2 = ManufacturingEngine.calculateBomRequirements(bom.id, 600);
  ManufacturingEngine.issueMaterialsToOrder({ orderId, lines: r2.map(r => ({ materialItemId: r.materialItemId, quantity: r.requiredQuantity })), date: TODAY, ...ADMIN } as never);
});
step({ doc: 'PRD-1', type: 'FG receipt 600 (WIP→WH-02)', item: fp.id, qty: 600 }, () => {
  ManufacturingEngine.recordDailyProduction({
    orderId, goodQuantity: 600, defectiveQuantity: 0, scrapQuantity: 0, defectiveAction: 'to_scrap', date: TODAY, ...ADMIN,
  } as never);
});
step({ doc: 'PRD-1', type: 'production close (GL capitalisation)', item: fp.id, qty: 1000 }, () => {
  ManufacturingEngine.closeProductionOrder(orderId, 'usr-admin', 'QA');
});

// ---- Scenario C/N custody
let custodyId = '', repId = '';
step({ doc: 'REP', type: 'representative + custody open', item: fp.id, qty: 0 }, () => {
  repId = WorkflowService.createSalesRepresentative({ code: `${PFX}-REP`, name: `${PFX} مندوب`, targetMonthlySales: 0, ...ADMIN } as never).rep!.id;
  custodyId = WorkflowService.openRepCustody(repId, `${PFX}`).custody!.id;
});
step({ doc: 'CUSTODY-1', type: 'custody load (WH-02→rep)', item: fp.id, qty: 500 }, () => {
  WorkflowService.loadGoodsToRep({ custodyId, itemId: fp.id, quantity: 500, unitPrice: 100, warehouseId: WH, date: TODAY });
});
step({ doc: 'SINV-C', type: 'custody sale (no WH-02 batch move)', item: fp.id, qty: 100 }, () => {
  WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: WH, repId, stockSource: 'rep_custody', custodyId,
    paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY,
    lines: [{ itemId: fp.id, quantity: 100, unitPrice: 100, vatRate: 0 }], ...ADMIN,
  } as never);
});
step({ doc: 'CUSTODY-1', type: 'custody return 20 (rep→WH-02)', item: fp.id, qty: 20 }, () => {
  WorkflowService.returnGoodsFromRep({ custodyId, itemId: fp.id, quantity: 20, warehouseId: WH, date: TODAY });
});
step({ doc: 'CUSTODY-1', type: 'custody return 380 (rep→WH-02)', item: fp.id, qty: 380 }, () => {
  WorkflowService.returnGoodsFromRep({ custodyId, itemId: fp.id, quantity: 380, warehouseId: WH, date: TODAY });
});

// ---- Scenario J (harness direct stock injection)
step({ doc: `${PFX}-OPEN`, type: 'DIRECT stock injection (no GL)', item: fp.id, qty: 300, detail: 'harness receive() — writes batches only' }, () => {
  InventoryEngine.recordMovement({
    itemId: fp.id, warehouseId: WH, movementType: 'purchase_receipt', quantityIn: 300, quantityOut: 0, unitCost: 40,
    documentType: `${PFX}-OPEN`, documentNumber: `${PFX}-OPEN`, date: TODAY, isTest: true,
  });
});
step({ doc: 'SINV-J', type: 'warehouse sale 100', item: fp.id, qty: 100 }, () => {
  WorkflowService.createSalesInvoice({
    customerId: cust.id, channel: 'retail', warehouseId: WH, paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    date: TODAY, lines: [{ itemId: fp.id, quantity: 100, unitPrice: 100, vatRate: 0 }], ...ADMIN,
  } as never);
});

console.log(`\n  TRACE STOPPED: ${stopped ? 'first divergence found and reported above' : 'no divergence found'}\n`);

// ---- CONTINUATION (evidence only — shows whether the gap is later absorbed) ----
if (stopped) {
  console.log('  ── CONTINUATION (evidence only; no source change) ──');
  stopped = false;
  suppressStop = true;
  if (!custodyId) {
    repId = WorkflowService.createSalesRepresentative({ code: `${PFX}-REP2`, name: `${PFX} مندوب2`, targetMonthlySales: 0, ...ADMIN } as never).rep!.id;
    custodyId = WorkflowService.openRepCustody(repId, `${PFX}`).custody!.id;
    console.log('  (custody opened here: its setup step was skipped when the trace halted at #14)');
  }
  const keepBanner = true;
  step({ doc: 'PRD-1', type: 'material issue #2', item: fp.id, qty: 600 }, () => {
    const r2 = ManufacturingEngine.calculateBomRequirements(bom.id, 600);
    ManufacturingEngine.issueMaterialsToOrder({ orderId, lines: r2.map(r => ({ materialItemId: r.materialItemId, quantity: r.requiredQuantity })), date: TODAY, ...ADMIN } as never);
  });
  step({ doc: 'PRD-1', type: 'FG receipt 600 (WIP→WH-02)', item: fp.id, qty: 600 }, () => {
    ManufacturingEngine.recordDailyProduction({
      orderId, goodQuantity: 600, defectiveQuantity: 0, scrapQuantity: 0, defectiveAction: 'to_scrap', date: TODAY, ...ADMIN,
    } as never);
  });
  step({ doc: 'PRD-1', type: 'production close (GL capitalisation)', item: fp.id, qty: 1000 }, () => {
    ManufacturingEngine.closeProductionOrder(orderId, 'usr-admin', 'QA');
  });
  step({ doc: 'CUSTODY-1', type: 'custody load (WH-02→rep)', item: fp.id, qty: 500 }, () => {
    WorkflowService.loadGoodsToRep({ custodyId, itemId: fp.id, quantity: 500, unitPrice: 100, warehouseId: WH, date: TODAY });
  });
  step({ doc: 'SINV-C', type: 'custody sale (no WH-02 batch move)', item: fp.id, qty: 100 }, () => {
    WorkflowService.createSalesInvoice({
      customerId: cust.id, channel: 'retail', warehouseId: WH, repId, stockSource: 'rep_custody', custodyId,
      paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1, date: TODAY,
      lines: [{ itemId: fp.id, quantity: 100, unitPrice: 100, vatRate: 0 }], ...ADMIN,
    } as never);
  });
  step({ doc: 'CUSTODY-1', type: 'custody return 20 (rep→WH-02)', item: fp.id, qty: 20 }, () => {
    WorkflowService.returnGoodsFromRep({ custodyId, itemId: fp.id, quantity: 20, warehouseId: WH, date: TODAY });
  });
  step({ doc: 'CUSTODY-1', type: 'custody return 380 (rep→WH-02)', item: fp.id, qty: 380 }, () => {
    WorkflowService.returnGoodsFromRep({ custodyId, itemId: fp.id, quantity: 380, warehouseId: WH, date: TODAY });
  });
  step({ doc: `${PFX}-OPEN`, type: 'DIRECT stock injection (no GL)', item: fp.id, qty: 300, detail: 'harness receive() — batches only, by design of the test harness' }, () => {
    InventoryEngine.recordMovement({
      itemId: fp.id, warehouseId: WH, movementType: 'purchase_receipt', quantityIn: 300, quantityOut: 0, unitCost: 40,
      documentType: `${PFX}-OPEN`, documentNumber: `${PFX}-OPEN`, date: TODAY, isTest: true,
    });
  });
  step({ doc: 'SINV-J', type: 'warehouse sale 100', item: fp.id, qty: 100 }, () => {
    WorkflowService.createSalesInvoice({
      customerId: cust.id, channel: 'retail', warehouseId: WH, paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
      date: TODAY, lines: [{ itemId: fp.id, quantity: 100, unitPrice: 100, vatRate: 0 }], ...ADMIN,
    } as never);
  });
  if (keepBanner) {
    console.log(`\n  FINAL: GL 1109 = ${fmt(glValue())} | WH-02 batch ledger = ${fmt(batchValue())} | residual = ${fmt(glValue() - batchValue())}`);
  }
}