// Isolated reproduction + regression for the export "1 + 1 + 1" accounting defect.
// Non-destructive: scratch in-memory DB only, restored at the end.
import { erpDb, createEmptyDatabase, applyMasterDataMigration, applyUomMigration } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { WorkflowService } from '../src/services/workflows';
import { InventoryEngine } from '../src/services/inventory';

const snap = () => erpDb.getSnapshot();
const TODAY = new Date().toISOString().split('T')[0];
const ADMIN = { userId: 'usr-admin', userName: 'QA' };
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

const PRISTINE = JSON.parse(JSON.stringify(applyUomMigration(applyMasterDataMigration(createEmptyDatabase()))));

function acc(code: string) {
  return snap().accounts.find(a => a.code === code)?.currentBalance || 0;
}

function fresh() {
  erpDb.restore(JSON.parse(JSON.stringify(PRISTINE)));
  const sup = MasterDataService.createSupplier({ code: `EXP-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: 'مورد تصدير', isTest: true, ...ADMIN } as never)!.supplier!;
  const cust = MasterDataService.createCustomer({
    code: `EXPC-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    name: 'عميل تصدير',
    customerType: 'export',
    channel: 'export',
    currency: 'USD',
    isTest: true,
    ...ADMIN,
  } as never)!.customer!;
  const fp = snap().items.find(i => i.code === 'FP-DUO-01' && i.itemType === 'finished_product')!;
  // ensure a real FIFO cost on the export FG item for the stock we will receive
  erpDb.mutate(draft => {
    const it = draft.items.find(i => i.id === fp.id);
    if (it) { it.standardCost = 40; it.actualCost = 40; }
  });
  return { sup: sup.id, cust: cust.id, item: fp.id };
}

const lines1 = (itemId: string, qty: number, unitPrice: number) => [
  { itemId, quantity: qty, unitPrice, vatRate: 0 }
];

console.log('=== export 1 + 1 + 1 reproduction ===');
{
  const { sup, cust, item } = fresh();
  const fx = 50;

  const inv1 = WorkflowService.createSalesInvoice({
    customerId: cust,
    channel: 'export',
    warehouseId: 'wh-export',
    paymentMethod: 'credit',
    currency: 'USD',
    exchangeRate: fx,
    date: TODAY,
    lines: lines1(item, 1, 1),
    taxTreatment: 'exempt',
    isTest: true,
    ...ADMIN,
  } as never);
  console.log('inv1 success:', inv1.success, 'totalAmount:', inv1.invoice?.totalAmount, 'cogsTotal:', inv1.invoice?.cogsTotal);
  console.log('inv1 4103:', acc('4103'), '1106:', acc('1106'), '5102:', acc('5102'), '1110:', acc('1110'));
  console.log('inv1 wh-export qty:', InventoryEngine.getItemBalance(item, 'wh-export'));
}

{
  const { sup, cust, item } = fresh();
  const fx = 50;

  const inv1 = WorkflowService.createSalesInvoice({
    customerId: cust,
    channel: 'export',
    warehouseId: 'wh-export',
    paymentMethod: 'credit',
    currency: 'USD',
    exchangeRate: fx,
    date: TODAY,
    lines: lines1(item, 1, 1),
    taxTreatment: 'exempt',
    isTest: true,
    ...ADMIN,
  } as never);
  const inv2 = WorkflowService.createSalesInvoice({
    customerId: cust,
    channel: 'export',
    warehouseId: 'wh-export',
    paymentMethod: 'credit',
    currency: 'USD',
    exchangeRate: fx,
    date: TODAY,
    lines: lines1(item, 1, 1),
    taxTreatment: 'exempt',
    isTest: true,
    ...ADMIN,
  } as never);
  console.log('inv1+inv2 success:', inv1.success, inv2.success);
  console.log('inv1+inv2 4103:', acc('4103'), '1106:', acc('1106'), '5102:', acc('5102'), '1110:', acc('1110'));
  console.log('inv1+inv2 wh-export qty:', InventoryEngine.getItemBalance(item, 'wh-export'));
}

{
  const { sup, cust, item } = fresh();
  const fx = 50;

  const po = WorkflowService.createPurchaseInvoice({
    supplierId: sup,
    warehouseId: 'wh-export',
    paymentMethod: 'credit',
    currency: 'EGP',
    exchangeRate: 1,
    reference: `EXPPRE-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    date: TODAY,
    lines: [
      {
        itemId: item,
        quantity: 1000,
        unitId: 'unit-piece',
        unitPrice: 40,
        batchNumber: `EXPB-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        productionDate: TODAY,
        expiryDate: '2027-06-01',
        vatRate: 0,
      },
    ],
    isTest: true,
    ...ADMIN,
  } as never);
  if (!po.success) throw new Error(po.error ?? 'purchase stock failed');

  const inv1 = WorkflowService.createSalesInvoice({
    customerId: cust,
    channel: 'export',
    warehouseId: 'wh-export',
    paymentMethod: 'credit',
    currency: 'USD',
    exchangeRate: fx,
    date: TODAY,
    lines: lines1(item, 1, 1),
    taxTreatment: 'exempt',
    isTest: true,
    ...ADMIN,
  } as never);
  const inv2 = WorkflowService.createSalesInvoice({
    customerId: cust,
    channel: 'export',
    warehouseId: 'wh-export',
    paymentMethod: 'credit',
    currency: 'USD',
    exchangeRate: fx,
    date: TODAY,
    lines: lines1(item, 1, 1),
    taxTreatment: 'exempt',
    isTest: true,
    ...ADMIN,
  } as never);
  const inv3 = WorkflowService.createSalesInvoice({
    customerId: cust,
    channel: 'export',
    warehouseId: 'wh-export',
    paymentMethod: 'credit',
    currency: 'USD',
    exchangeRate: fx,
    date: TODAY,
    lines: lines1(item, 1, 1),
    taxTreatment: 'exempt',
    isTest: true,
    ...ADMIN,
  } as never);

  console.log('=== 1 + 1 + 1 END-TO-END ===');
  console.log('inv1 success:', inv1.success, 'totalAmount:', inv1.invoice?.totalAmount, 'cogsTotal:', inv1.invoice?.cogsTotal);
  console.log('inv2 success:', inv2.success, 'totalAmount:', inv2.invoice?.totalAmount, 'cogsTotal:', inv2.invoice?.cogsTotal);
  console.log('inv3 success:', inv3.success, 'totalAmount:', inv3.invoice?.totalAmount, 'cogsTotal:', inv3.invoice?.cogsTotal);
  console.log('4103:', acc('4103'), '1106:', acc('1106'), '5102:', acc('5102'), '1110:', acc('1110'));
  console.log('wh-export qty:', InventoryEngine.getItemBalance(item, 'wh-export'));
  console.log('wh-export batch value:', snap().batches.filter(b => b.itemId === item && b.warehouseId === 'wh-export').reduce((s, b) => s + b.quantity * (b.unitCost || 0), 0));

  // journal balance check across all export-related entries
  const je = snap().journalEntries;
  const exportJe = je.filter(j => j.lines.some(l => l.accountId === snap().accounts.find(a => a.code === '4103')?.id || l.accountId === snap().accounts.find(a => a.code === '1106')?.id || l.accountId === snap().accounts.find(a => a.code === '5102')?.id || l.accountId === snap().accounts.find(a => a.code === '1110')?.id));
  let dr = 0, cr = 0;
  for (const j of exportJe) {
    for (const l of j.lines) {
      dr += l.debit || 0;
      cr += l.credit || 0;
    }
  }
  console.log('export-je DR:', dr, 'CR:', cr, 'balanced:', near(dr, cr));
  console.log('all-je DR:', je.reduce((s, j) => s + j.lines.reduce((x, l) => x + (l.debit || 0), 0), 0));
  console.log('all-je CR:', je.reduce((s, j) => s + j.lines.reduce((x, l) => x + (l.credit || 0), 0), 0));
}
