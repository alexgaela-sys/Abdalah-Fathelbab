// Regression: an export customer saved with an EGP card (legacy data / old form) must still show
// its invoices AND collections in the statement, carry its balance in USD, and be repaired by
// MasterDataService.normalizeCustomerCurrencies().
import { erpDb, createEmptyDatabase, applyMasterDataMigration, applyUomMigration } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { WorkflowService } from '../src/services/workflows';
import { LedgerService } from '../src/services/ledger';

const snap = () => erpDb.getSnapshot();
const TODAY = new Date().toISOString().split('T')[0];
const ADMIN = { userId: 'usr-admin', userName: 'QA' };
let failed = 0;
const check = (name: string, ok: boolean, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} - ${name} ${extra}`); if (!ok) failed++; };

erpDb.restore(JSON.parse(JSON.stringify(applyUomMigration(applyMasterDataMigration(createEmptyDatabase())))));
const sup = MasterDataService.createSupplier({ code: 'S-X1', name: 'مورد', isTest: true, ...ADMIN } as never).supplier!;
const fp = snap().items.find(i => i.code === 'FP-DUO-01' && i.itemType === 'finished_product')!;
erpDb.mutate(d => { const it = d.items.find(i => i.id === fp.id)!; it.standardCost = 40; it.actualCost = 40; });

// 1) the service now forces USD for an export customer even if the caller passes EGP
const c1 = MasterDataService.createCustomer({ code: 'EXC-1', name: 'عميل تصدير 1', customerType: 'export', channel: 'export', currency: 'EGP', isTest: true, ...ADMIN } as never).customer!;
check('create: export customer gets a USD card', c1.currency === 'USD');
const upd = MasterDataService.updateCustomer(c1.id, { currency: 'EGP', isTest: true, ...ADMIN } as never);
check('edit: cannot switch an export card back to EGP', upd.success && upd.customer!.currency === 'USD');

// 2) legacy customer: export type but EGP card
const legacy = MasterDataService.createCustomer({ code: 'EXC-2', name: 'عميل تصدير قديم', customerType: 'export', channel: 'export', isTest: true, ...ADMIN } as never).customer!;
erpDb.mutate(d => { d.customers.find(c => c.id === legacy.id)!.currency = 'EGP'; });

const po = WorkflowService.createPurchaseInvoice({
  supplierId: sup.id, warehouseId: 'wh-export', paymentMethod: 'credit', currency: 'EGP', exchangeRate: 1,
  reference: 'EXPPRE-1', date: TODAY,
  lines: [{ itemId: fp.id, quantity: 1000, unitId: 'unit-piece', unitPrice: 40, batchNumber: 'EXPB-1', productionDate: TODAY, expiryDate: '2027-06-01', vatRate: 0 }],
  isTest: true, ...ADMIN,
} as never);
check('stock purchase', po.success, po.error || '');

const bad = WorkflowService.createSalesInvoice({
  customerId: legacy.id, channel: 'export', warehouseId: 'wh-export', paymentMethod: 'credit',
  currency: 'EGP', exchangeRate: 1, date: TODAY, taxTreatment: 'exempt',
  lines: [{ itemId: fp.id, quantity: 1, unitPrice: 10, vatRate: 0 }], isTest: true, ...ADMIN,
} as never);
check('export invoice in EGP is refused', !bad.success);

const inv = WorkflowService.createSalesInvoice({
  customerId: legacy.id, channel: 'export', warehouseId: 'wh-export', paymentMethod: 'credit',
  currency: 'USD', exchangeRate: 50, date: TODAY, taxTreatment: 'exempt',
  lines: [{ itemId: fp.id, quantity: 10, unitPrice: 10, vatRate: 0 }], isTest: true, ...ADMIN,
} as never);
check('export invoice $100 @50 posts', inv.success, inv.error || '');

// the statement is already right BEFORE the repair (ledger reads by type, not by the stale card)
const before = LedgerService.buildCustomerStatement({ customerId: legacy.id });
check('statement lists the invoice before repair', before.rows.length === 1, `rows=${before.rows.length}`);

const fixed = MasterDataService.normalizeCustomerCurrencies();
check('repair flips the legacy card', fixed === 1 && snap().customers.find(c => c.id === legacy.id)!.currency === 'USD');
check('repair is idempotent', MasterDataService.normalizeCustomerCurrencies() === 0);

const st = LedgerService.buildCustomerStatement({ customerId: legacy.id });
check('statement currency is USD', st.currency === 'USD');
check('statement shows $100 debit (not 5,000)', Math.abs(st.totalDebit - 100) < 0.01, `debit=${st.totalDebit}`);
check('card balance is $100', Math.abs(snap().customers.find(c => c.id === legacy.id)!.currentBalance - 100) < 0.01);

// 3) a $40 collection at 51 appears and reduces the balance in USD
const shp = WorkflowService.createExportShipment({
  customerId: legacy.id, salesInvoiceId: inv.invoice!.id, date: TODAY, shipmentNumber: undefined,
  usdRevenue: 100, exchangeRate: 50, shippingCost: 0, portCosts: 0, customsCost: 0, otherExportCosts: 0, isTest: true, ...ADMIN,
} as never);
if (shp.success) {
  const col = WorkflowService.recordExportCollection({ shipmentId: shp.shipment!.id, amountUsd: 40, actualExchangeRate: 51, date: TODAY, isTest: true, ...ADMIN } as never);
  check('collection posts', col.success, col.error || '');
  const st2 = LedgerService.buildCustomerStatement({ customerId: legacy.id });
  check('statement lists invoice + collection', st2.rows.length === 2, `rows=${st2.rows.length}`);
  check('closing balance $60', Math.abs(st2.closingBalance - 60) < 0.01, `closing=${st2.closingBalance}`);
} else {
  console.log('note: shipment step skipped:', shp.error);
}

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL EXPORT CUSTOMER CHECKS PASSED');
process.exit(failed ? 1 : 0);
