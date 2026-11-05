// Purchase return WITHOUT an invoice for an opening-balance item: returned at actual stock cost,
// supplier payable reduced by the same value, no price variance, no VAT.
import { readFileSync } from 'fs';
import { erpDb, createEmptyDatabase, applyMasterDataMigration, applyUomMigration, applyWithholdingAccountMigration, applyEmployeeCipLoanAccountsMigration } from '../src/services/db';
import { OpeningBalanceService } from '../src/services/openingBalances';
import { WorkflowService } from '../src/services/workflows';
import { InventoryEngine } from '../src/services/inventory';

const pkg = JSON.parse(readFileSync(process.argv[2] || 'data/snakdip_opening_package_2026-10-31.json', 'utf8'));
let failed = 0;
const check = (n: string, ok: boolean, x = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} - ${n} ${x}`); if (!ok) failed++; };
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
erpDb.restore(JSON.parse(JSON.stringify(applyEmployeeCipLoanAccountsMigration(applyWithholdingAccountMigration(applyUomMigration(applyMasterDataMigration(createEmptyDatabase())))))));
check('import', OpeningBalanceService.importPackage(pkg, { userId: 'usr-admin', userName: 'QA' }).success);
const bal = (id: string) => erpDb.getSnapshot().accounts.find(a => a.id === id)!.currentBalance;
const sup = 'sup-shorouq';
const supBefore = erpDb.getSnapshot().suppliers.find(s => s.id === sup)!.currentBalance;
const b = erpDb.getSnapshot().batches.find(x => x.warehouseId === 'wh-raw' && x.itemId === 'item-pkg-box-duo')!;
const qty0 = InventoryEngine.getItemBalance('item-pkg-box-duo', 'wh-raw');
const inv0 = bal('acc-1108'), pay0 = bal('acc-2101'), var0 = bal('acc-5103');
const r = WorkflowService.postPurchaseReturn({ supplierId: sup, warehouseId: 'wh-raw', date: '2026-11-05', reason: 'اختبار مرتجع بدون فاتورة', lines: [{ itemId: 'item-pkg-box-duo', quantity: 100 }] });
check('return posts without invoice', r.success, r.error || '');
const cost = 100 * b.unitCost;
check('stock reduced by 100', InventoryEngine.getItemBalance('item-pkg-box-duo', 'wh-raw') === qty0 - 100);
check(`inventory 1108 reduced by cost ${cost}`, near(inv0 - bal('acc-1108'), cost), `${inv0 - bal('acc-1108')}`);
check('payable 2101 reduced by the same value', near(Math.abs(pay0) - Math.abs(bal('acc-2101')), cost), `${Math.abs(pay0) - Math.abs(bal('acc-2101'))}`);
check('no price variance booked (5103 unchanged)', near(bal('acc-5103'), var0));
check('supplier card reduced', near(supBefore - erpDb.getSnapshot().suppliers.find(s => s.id === sup)!.currentBalance, cost));
check('journals balance', near(erpDb.getSnapshot().journalEntries.reduce((t, j) => t + j.totalDebit - j.totalCredit, 0), 0));
const over = WorkflowService.postPurchaseReturn({ supplierId: sup, warehouseId: 'wh-raw', date: '2026-11-05', reason: 'x', lines: [{ itemId: 'item-pkg-box-duo', quantity: 99999999 }] });
check('over-return refused', !over.success, over.error || '');
console.log(failed ? `\n${failed} FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
