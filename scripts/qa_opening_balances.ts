// Regression: opening balances (stock / customers / suppliers) are POSTED against equity 3103,
// never against 5104 or any revenue/cost account, and cards and books agree.
import { erpDb, createEmptyDatabase, applyMasterDataMigration, applyUomMigration } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { OpeningBalanceService } from '../src/services/openingBalances';
import { WorkflowService } from '../src/services/workflows';
import { InventoryEngine } from '../src/services/inventory';
import { LedgerService } from '../src/services/ledger';

const snap = () => erpDb.getSnapshot();
const ADMIN = { userId: 'usr-admin', userName: 'QA', isTest: true };
const D = '2026-06-30';
let failed = 0;
const check = (n: string, ok: boolean, x = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} - ${n} ${x}`); if (!ok) failed++; };
const bal = (id: string) => snap().accounts.find(a => a.id === id)?.currentBalance || 0;
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

erpDb.restore(JSON.parse(JSON.stringify(applyUomMigration(applyMasterDataMigration(createEmptyDatabase())))));
const raw = snap().items.find(i => i.itemType === 'raw_material')!;

// stock
const r1 = OpeningBalanceService.postInventoryOpening({ warehouseId: 'wh-raw', date: D, lines: [{ itemId: raw.id, quantity: 100, unitCost: 12.5, expiryDate: '2027-06-30' }], ...ADMIN });
check('opening stock posts', r1.success && near(r1.totalValue || 0, 1250), r1.error || '');
check('stock quantity in the warehouse', InventoryEngine.getItemBalance(raw.id, 'wh-raw') === 100);
check('raw inventory 1108 debited 1,250', near(bal('acc-1108'), 1250), String(bal('acc-1108')));
check('equity 3103 credited 1,250 (credit-natured -> -1250 or 1250)', near(Math.abs(bal('acc-3103')), 1250), String(bal('acc-3103')));
check('5104 (variance) untouched — no fake gain', near(bal('acc-5104'), 0));
const dup = OpeningBalanceService.postInventoryOpening({ warehouseId: 'wh-raw', date: D, lines: [{ itemId: raw.id, quantity: 5, unitCost: 12.5 }], ...ADMIN });
check('second opening for the same item+warehouse is refused', !dup.success);
const nocost = OpeningBalanceService.postInventoryOpening({ warehouseId: 'wh-raw', date: D, lines: [{ itemId: snap().items.filter(i => i.itemType === 'raw_material')[1].id, quantity: 5, unitCost: 0 }], ...ADMIN });
check('opening stock without a cost is refused', !nocost.success);

// customers
const loc = MasterDataService.createCustomer({ code: 'C-OP1', name: 'عميل محلي', customerType: 'wholesale', channel: 'wholesale', openingBalance: 5000, openingDate: D, ...ADMIN } as never).customer!;
check('local customer card = 5,000', near(loc.currentBalance, 5000) && near(loc.openingBalance, 5000));
check('1105 debited 5,000 by the opening entry', near(bal('acc-1105'), 5000), String(bal('acc-1105')));
const st = LedgerService.buildCustomerStatement({ customerId: loc.id });
check('statement opening 5,000 and not double counted', near(st.openingBalance, 5000) && near(st.closingBalance, 5000), `open=${st.openingBalance} close=${st.closingBalance}`);
check('card and statement agree', near(st.cardDiff, 0));
const exp = MasterDataService.createCustomer({ code: 'C-OP2', name: 'عميل تصدير', customerType: 'export', channel: 'export', openingBalance: 1000, openingExchangeRate: 50, openingDate: D, ...ADMIN } as never).customer!;
check('export customer card = $1,000', near(exp.currentBalance, 1000));
check('1106 debited 50,000 EGP', near(bal('acc-1106'), 50000), String(bal('acc-1106')));
const noRate = MasterDataService.createCustomer({ code: 'C-OP3', name: 'تصدير بلا سعر', customerType: 'export', channel: 'export', openingBalance: 10, openingExchangeRate: 0, ...ADMIN } as never);
erpDb.mutate(d => { d.company.currentUsdExchangeRate = 0; });
const noRate2 = MasterDataService.createCustomer({ code: 'C-OP4', name: 'تصدير بلا سعر 2', customerType: 'export', channel: 'export', openingBalance: 10, ...ADMIN } as never);
check('USD opening without any rate is refused', !noRate2.success);
void noRate;
// correcting an opening posts only the difference
const fix = OpeningBalanceService.postCustomerOpening({ customerId: loc.id, amount: 4000, date: D, ...ADMIN });
check('correcting 5,000 -> 4,000 posts the 1,000 difference', fix.success && near(bal('acc-1105'), 4000) && near(snap().customers.find(c => c.id === loc.id)!.currentBalance, 4000));

// suppliers
const sup = MasterDataService.createSupplier({ code: 'S-OP1', name: 'مورد افتتاحي', openingBalance: 3000, openingDate: D, ...ADMIN } as never).supplier!;
check('supplier card = 3,000', near(sup.currentBalance, 3000));
check('2101 credited 3,000', near(Math.abs(bal('acc-2101')), 3000), String(bal('acc-2101')));

// the whole book still balances
const tb = snap().journalEntries.reduce((s, j) => s + j.totalDebit - j.totalCredit, 0);
check('all journals balance', near(tb, 0), String(tb));

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL OPENING BALANCE CHECKS PASSED');
process.exit(failed ? 1 : 0);
