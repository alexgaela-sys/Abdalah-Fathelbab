// Regression: (1) a deliberate extra/replacement issue (reason + approval) is allowed and may be
// repeated; a plain repeat of the BOM issue is still refused. (2) Output above what the issued
// materials cover raises a deviation warning (never blocks).
import { erpDb } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { WorkflowService } from '../src/services/workflows';
import { ManufacturingEngine } from '../src/services/manufacturing';
import { ensureTestBom } from './qa_test_bom';

const TODAY = new Date().toISOString().split('T')[0];
const snap = () => erpDb.getSnapshot();
const ADMIN = { userId: 'usr-admin', userName: 'QA' };
let failed = 0;
const check = (n: string, ok: boolean, x = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} - ${n} ${x}`); if (!ok) failed++; };

const sup = MasterDataService.createSupplier({ code: 'TEST-QA-S', name: 'مورد', isTest: true, ...ADMIN } as never).supplier!;
const fp = snap().items.find(i => i.code === 'FP-SNG-01')!;
const bom = ensureTestBom(fp.id);
snap().bomLines.filter(l => l.bomId === bom.id).forEach((l, idx) => {
  const r = WorkflowService.createPurchaseInvoice({
    supplierId: sup.id, warehouseId: 'wh-raw', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
    reference: `TEST-QA-M-${idx}`, date: TODAY,
    lines: [{ itemId: l.materialItemId, quantity: Math.ceil(l.quantityRequired * 0.5 * 1000) / 1000 * 2 + 5, unitId: l.unitId, unitPrice: 50, batchNumber: `TEST-QA-M-${idx}`, productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
    isTest: true, ...ADMIN,
  } as never);
  if (!r.success) throw new Error(r.error);
});

const mk = (qty: number) => {
  const o = ManufacturingEngine.createProductionOrder({ productId: fp.id, plannedQuantity: qty, targetMarket: 'local', destinationWarehouseId: 'wh-local', expectedCompletionDate: TODAY, isTest: true, ...ADMIN } as never);
  if (!o.success) throw new Error(o.error);
  return o.order!;
};
const reqs = (o: { bomId?: string }, qty: number) =>
  ManufacturingEngine.calculateBomRequirements(o.bomId!, qty).map(r => ({ materialItemId: r.materialItemId, quantity: Math.round(r.requiredQuantity * 1000) / 1000 }));

// --- (1) issue rules -------------------------------------------------------------------------
const o1 = mk(100);
const first = ManufacturingEngine.issueMaterialsToOrder({ orderId: o1.id, lines: reqs(o1, 50), date: TODAY, ...ADMIN } as never);
check('first batch (50%) issues', first.success, first.error || '');
const second = ManufacturingEngine.issueMaterialsToOrder({ orderId: o1.id, lines: reqs(o1, 50), date: TODAY, ...ADMIN } as never);
check('second batch (other 50%) issues', second.success, second.error || '');
const dup = ManufacturingEngine.issueMaterialsToOrder({ orderId: o1.id, lines: reqs(o1, 50), date: TODAY, ...ADMIN } as never);
check('a plain third issue beyond the plan is still refused', !dup.success);

const box = snap().bomLines.find(l => l.bomId === bom.id && l.materialItemId === 'item-pkg-box-single')!;
const repl = ManufacturingEngine.issueMaterialsToOrder({
  orderId: o1.id, date: TODAY, ...ADMIN,
  lines: [{ materialItemId: box.materialItemId, quantity: 2, issueKind: 'additional', reason: 'استبدال علب تالفة' }],
} as never);
check('replacement of a damaged piece (extra of a BOM material, with reason) is allowed', repl.success, repl.error || '');
const repl2 = ManufacturingEngine.issueMaterialsToOrder({
  orderId: o1.id, date: TODAY, ...ADMIN,
  lines: [{ materialItemId: box.materialItemId, quantity: 2, issueKind: 'additional', reason: 'استبدال علب تالفة تاني' }],
} as never);
check('the same replacement can be issued twice', repl2.success, repl2.error || '');
const noReason = ManufacturingEngine.issueMaterialsToOrder({
  orderId: o1.id, date: TODAY, ...ADMIN,
  lines: [{ materialItemId: box.materialItemId, quantity: 1, issueKind: 'additional' }],
} as never);
check('an extra issue without a reason is refused', !noReason.success);

// --- (2) deviation warning -------------------------------------------------------------------
const ok1 = ManufacturingEngine.recordDailyProduction({ orderId: o1.id, goodQuantity: 100, defectiveQuantity: 0, scrapQuantity: 0, defectiveAction: 'to_scrap', date: TODAY, isTest: true, ...ADMIN } as never);
check('output within issued materials: no warning', ok1.success && !ok1.warning, ok1.warning || ok1.error || '');
const over = ManufacturingEngine.recordDailyProduction({ orderId: o1.id, goodQuantity: 30, defectiveQuantity: 0, scrapQuantity: 0, defectiveAction: 'to_scrap', date: TODAY, isTest: true, ...ADMIN } as never);
check('output beyond issued materials: succeeds WITH a deviation warning', over.success && !!over.warning, over.warning || over.error || '');
check('deviation is audited', snap().auditLogs.some(a => a.recordId === o1.id && String(a.description).includes('انحراف إنتاج')));

const o2 = mk(100);
ManufacturingEngine.issueMaterialsToOrder({ orderId: o2.id, lines: reqs(o2, 40), date: TODAY, ...ADMIN } as never);
const under = ManufacturingEngine.recordDailyProduction({ orderId: o2.id, goodQuantity: 70, defectiveQuantity: 0, scrapQuantity: 0, defectiveAction: 'to_scrap', date: TODAY, isTest: true, ...ADMIN } as never);
check('40% of materials but 70 produced -> warning', under.success && !!under.warning);

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL PRODUCTION CHECKS PASSED');
process.exit(failed ? 1 : 0);
