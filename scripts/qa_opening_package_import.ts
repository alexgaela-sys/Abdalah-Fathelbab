// Regression: an opening-balance package merges into an EMPTY live system without touching users/settings,
// and is refused on a system that already has postings.
import { readFileSync } from 'fs';
import { erpDb, createEmptyDatabase, applyMasterDataMigration, applyUomMigration, applyWithholdingAccountMigration } from '../src/services/db';
import { OpeningBalanceService } from '../src/services/openingBalances';
import { InventoryEngine } from '../src/services/inventory';

const pkgPath = process.argv[2];
if (!pkgPath) { console.log('usage: bun scripts/qa_opening_package_import.ts <package.json>'); process.exit(2); }
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
let failed = 0;
const check = (n: string, ok: boolean, x = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} - ${n} ${x}`); if (!ok) failed++; };
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
const fresh = () => erpDb.restore(JSON.parse(JSON.stringify(applyWithholdingAccountMigration(applyUomMigration(applyMasterDataMigration(createEmptyDatabase()))))));

fresh();
erpDb.mutate(d => { d.users.push({ id: 'usr-owner', username: 'owner', name: 'المالك', role: 'Super Admin', email: 'owner@example.com', active: true } as never); d.company.currentUsdExchangeRate = 55; });
const before = erpDb.getSnapshot();
const r = OpeningBalanceService.importPackage(pkg, { userId: 'usr-admin', userName: 'QA' });
check('package imports', r.success, r.error || r.summary || '');
const s = erpDb.getSnapshot();
check('users untouched (owner still there)', s.users.length === before.users.length && s.users.some(u => u.id === 'usr-owner'));
check('company settings untouched', s.company.currentUsdExchangeRate === 55);
check('journals balance', near(s.journalEntries.reduce((t, j) => t + j.totalDebit - j.totalCredit, 0), 0));
check('cash 257,135', near(s.accounts.find(a => a.id === 'acc-1101')!.currentBalance, 257135));
check('suppliers 2,776,470.89', near(Math.abs(s.accounts.find(a => a.id === 'acc-2101')!.currentBalance), 2776470.89));
check('stock present', InventoryEngine.getItemBalance('item-fp-d3', 'wh-local') === 2012);
check('bank register balance 71,705', near(s.bankAccounts.find(b => b.id === 'bank-1')!.currentBalance, 71705));
const again = OpeningBalanceService.importPackage(pkg, { userId: 'usr-admin', userName: 'QA' });
check('second import is refused', !again.success);
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL PACKAGE IMPORT CHECKS PASSED');
process.exit(failed ? 1 : 0);
