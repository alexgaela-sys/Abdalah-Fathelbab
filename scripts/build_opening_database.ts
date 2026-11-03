// Builds an ERP backup file (JSON) holding the company's opening position at 31/10/2026, loaded
// through the SAME services the Opening Balances screen uses (never against revenue/cost accounts).
// Sources: sheet "نظام محاسبة سناك دب - أكتوبر 2026" (balances), the October stock-value sheet
// (raw materials / packaging with unit prices) and the customers / suppliers ledgers.
//   bun scripts/build_opening_database.ts <out.json>
import { readFileSync, writeFileSync } from 'fs';
import { erpDb, createEmptyDatabase, applyMasterDataMigration, applyUomMigration, applyWithholdingAccountMigration } from '../src/services/db';
import { MasterDataService } from '../src/services/masterData';
import { OpeningBalanceService } from '../src/services/openingBalances';
import { installStandardBoms } from '../src/services/standardFormulas';
import { LedgerService } from '../src/services/ledger';

const OUT = process.argv[2] || 'snakdip_opening_2026-10-31.json';
const D = '2026-10-31';
const A = { userId: 'usr-admin', userName: 'المشرف العام (Admin)' };
const stock = JSON.parse(readFileSync(new URL('../data/opening_stock_2026-10-31.json', import.meta.url), 'utf8')) as {
  fg: Record<string, number>; raw: Array<{ group: string | null; name: string; qty: number; price: number; value: number }>;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const must = <T extends { success: boolean; error?: string }>(label: string, r: T): T => { if (!r.success) throw new Error(`${label}: ${r.error}`); return r; };

erpDb.restore(JSON.parse(JSON.stringify(applyWithholdingAccountMigration(applyUomMigration(applyMasterDataMigration(createEmptyDatabase()))))));
const snap = () => erpDb.getSnapshot();
const log: Array<[string, string, number]> = [];

// ---------------------------------------------------------------- raw materials & packaging
const val = (name: string) => stock.raw.find(r => r.name === name)!;
type Pool = { itemId: string; qty: number; value: number; note: string };
const pools = new Map<string, Pool>();
const add = (itemId: string, qty: number, value: number, note: string) => {
  const p = pools.get(itemId) || { itemId, qty: 0, value: 0, note: '' };
  p.qty += qty; p.value += value; p.note = p.note ? `${p.note} + ${note}` : note; pools.set(itemId, p);
};
for (const r of stock.raw) {
  const n = r.name;
  if (!(r.qty > 0) || !(r.value > 0)) continue;
  if (n.startsWith('ديو ')) add('item-pkg-box-duo', r.qty, r.value, 'علب ديو');
  else if (n.startsWith('سنجل ')) add('item-pkg-box-single', r.qty, r.value, 'علب سنجل');
  else if (n === 'صوص باربكيو') add('item-raw-flavor-honey-bbq', r.qty, r.value, n);
  else if (n === 'صوص سويت شيلي') add('item-raw-flavor-sweet-chili', r.qty, r.value, n);
  else if (n === 'صوص برجر') add('item-raw-flavor-smokey-burger', r.qty, r.value, n);
  else if (n === 'صوص سبايسي') add('item-raw-flavor-spicy-grilled', r.qty, r.value, n);
  else if (n === 'صوص مستردة') add('item-raw-flavor-honey-mustard', r.qty, r.value, n);
  else if (n.startsWith('طبق ابيض')) add('item-pkg-tray', r.qty, r.value, n);
  else if (n.startsWith('طبق اصفر') || n === 'طبق صوص سنجل') add('item-pkg-sauce-tray', r.qty, r.value, n);
  else if (n === 'جلافزات') add('item-pkg-liner', r.qty, r.value, n);
  else if (n === 'مناديل') add('item-pkg-napkin', r.qty, r.value, n);
  else if (n === 'رول سناك دب') add('item-pkg-film', r.qty, r.value, n);
  else if (n === 'كرتونة ديو' || n === 'كرتونة سنجل' || n === 'كرتون بني سادة جرادل') add('item-pkg-carton', r.qty, r.value, n);
  else if (n === 'كرتون بني سادة سنجل') add('item-pkg-kraft-single', r.qty, r.value, n);
  else if (n === 'استيكر شفاف') add('item-pkg-sticker', r.qty, r.value, n);
  else log.push(['خامة غير محمّلة (لا يوجد صنف مطابق)', n, r.value]);
}
const rawLines = [...pools.values()].map(p => ({
  itemId: p.itemId, quantity: Number(p.qty.toFixed(6)), unitCost: Number((p.value / p.qty).toFixed(6)),
  expiryDate: undefined as string | undefined,
}));
must('raw stock', OpeningBalanceService.postInventoryOpening({ warehouseId: 'wh-raw', date: D, lines: rawLines, ...A }));

// ---------------------------------------------------------------- finished goods (cost estimate: materials only)
const p = (name: string) => { const r = val(name); return r.value / r.qty; };
const sauce = { sweet: p('صوص سويت شيلي'), spicy: p('صوص سبايسي'), burger: p('صوص برجر'), bbq: p('صوص باربكيو'), mustard: p('صوص مستردة') };
const SINGLE_BASE = 4 + 1 + 0.45 + 0.35 + 0.148 + 12.5 / 15;
const DUO_BASE = 7 + 4.75 + 3.5 + 2 * 0.45 + 0.35 + 2 * 0.148 + 12.5 / 8;
const FG: Record<string, { item: string; cost: number }> = {
  'ديو فراخ سبايسي': { item: 'item-fp-d3', cost: DUO_BASE + sauce.sweet + sauce.spicy },
  'ديو فراخ باربكيو': { item: 'item-fp-d4', cost: DUO_BASE + sauce.sweet + sauce.bbq },
  'ديو لحمة مستردة': { item: 'item-fp-d2', cost: DUO_BASE + sauce.burger + sauce.mustard },
  'ديو لحمة باربكيو': { item: 'item-fp-d1', cost: DUO_BASE + sauce.burger + sauce.bbq },
  'ديو قوقعة': { item: 'item-fp-d5', cost: DUO_BASE + sauce.sweet + sauce.bbq },
  'ناتشوز سويت/فلفل': { item: 'item-fp-s4', cost: SINGLE_BASE + sauce.sweet },
  'ناتشوز برجر/جبنة': { item: 'item-fp-s5', cost: SINGLE_BASE + sauce.burger },
  'ناتشوز باربكيو/ملح': { item: 'item-fp-s3', cost: SINGLE_BASE + sauce.bbq },
  'كرنكل مستردة': { item: 'item-fp-s6', cost: SINGLE_BASE + sauce.mustard },
  'فاير فنجرز سويت': { item: 'item-fp-s1', cost: SINGLE_BASE + sauce.sweet },
  'فاير فنجرز سبايسي': { item: 'item-fp-s2', cost: SINGLE_BASE + sauce.spicy },
};
const fgLines = Object.entries(stock.fg).map(([name, qty]) => {
  const m = FG[name]; if (!m) throw new Error(`no ERP item for ${name}`);
  return { itemId: m.item, quantity: qty, unitCost: Number(m.cost.toFixed(4)) };
});
must('finished goods', OpeningBalanceService.postInventoryOpening({ warehouseId: 'wh-local', date: D, lines: fgLines, ...A }));

// ---------------------------------------------------------------- customers
const customers: Array<{ code: string; name: string; phone?: string; opening: number }> = [
  { code: 'CUS-ICONIC', name: 'ايقونيك', phone: '01111062155', opening: 135689.21 },
  { code: 'CUS-CSTORE', name: 'سي ستور', phone: '01013151240', opening: 2401 },
  { code: 'CUS-FARMAWY', name: 'احمد الفرماوي', opening: 30000 },
  { code: 'CUS-NAGM', name: 'النجم الساطع', phone: '01231213121', opening: 31500 },
  { code: 'CUS-ABOELKHEIR', name: 'احمد ابو الخير', phone: '01225138781', opening: 0 },
  { code: 'CUS-SAYAD', name: 'الصياد', opening: 0 },
  { code: 'CUS-HEGAZY', name: 'محمد حجازي', opening: 0 },
  { code: 'CUS-SHERBINY', name: 'اسلام الشربيني', opening: 0 },
  { code: 'CUS-FAMILY', name: 'فاميلي براندز', opening: 0 },
];
for (const c of customers) {
  must(`customer ${c.name}`, MasterDataService.createCustomer({
    code: c.code, name: c.name, customerType: 'wholesale', channel: 'wholesale', phone: c.phone, openingBalance: c.opening, openingDate: D, ...A,
  } as never));
}
// Export customers (USD). Booked at the provisional October rate 56.0 (the Kuwait invoice and the UAE deposit rate).
//   Kuwait owes the company $5,154;  UAE paid a $12,956 deposit (credit balance = advance).
const EXPORT_RATE = 56;
const KUWAIT_USD = 5154; const UAE_USD = -12956;
must('customer Kuwait', MasterDataService.createCustomer({
  code: 'CUS-KUWAIT', name: 'عميل الكويت (تصدير)', customerType: 'export', channel: 'export', openingBalance: KUWAIT_USD,
  openingExchangeRate: EXPORT_RATE, openingDate: D, ...A,
} as never));
must('customer UAE', MasterDataService.createCustomer({
  code: 'CUS-UAE', name: 'عميل الإمارات (تصدير)', customerType: 'export', channel: 'export', openingBalance: UAE_USD,
  openingExchangeRate: EXPORT_RATE, openingDate: D, ...A,
} as never));

// ---------------------------------------------------------------- suppliers
const suppliers: Array<[string, number]> = [
  ['SUPMARAA', 652236.38], ['SUPSHOROUQ', 1070661.28], ['SUPDUMIATY', 133091], ['SUPKHALEEJIA', 586832.01],
  ['SUPHILAL', 172382.22], ['SUPROYALCARTON', 161268],
];
for (const [code, amount] of suppliers) {
  const s = snap().suppliers.find(x => x.code === code);
  if (!s) throw new Error(`supplier ${code} missing`);
  must(`supplier ${code}`, OpeningBalanceService.postSupplierOpening({ supplierId: s.id, amount, date: D, ...A }));
}

// ---------------------------------------------------------------- cash, bank, cheques, taxes
must('general', OpeningBalanceService.postGeneralOpening({
  date: D, ...A,
  lines: [
    { accountId: 'acc-1101', side: 'debit', amount: 257135, description: 'رصيد الخزينة 31/10/2026' },
    { accountId: 'acc-1102', side: 'debit', amount: 71705, description: 'رصيد بنك مصر 31/10/2026', bankAccountId: 'bank-1' },
    { accountId: 'acc-1104', side: 'debit', amount: 159000, description: 'شيكات تحت التحصيل (صافي) 31/10/2026' },
    { accountId: 'acc-1113', side: 'debit', amount: 52815.70, description: 'ضريبة القيمة المضافة — مدخلات' },
    { accountId: 'acc-1114', side: 'debit', amount: 2513.68, description: 'ضريبة خصم من المنبع (أصل)' },
    { accountId: 'acc-2103', side: 'credit', amount: 35191.58, description: 'ضريبة القيمة المضافة — مخرجات' },
    { accountId: 'acc-2104', side: 'credit', amount: 155430, description: 'رواتب وأجور مستحقة' },
  ],
}));
log.push(['غير محمّل (لا يوجد حساب مطابق في النظام)', 'عهد وسلف الموظفين', 21350]);
log.push(['غير محمّل (لا يوجد حساب مطابق في النظام)', 'أعمال تحت التنفيذ (تجهيزات وإنشاءات)', 102300]);
log.push(['غير محمّل (لا يوجد حساب مطابق في النظام)', 'قروض وأقساط', 33500]);

must('standard BOMs', installStandardBoms({ userId: A.userId, userName: A.userName, isTest: false } as never) as never);

// ---------------------------------------------------------------- checks + export
const db = snap();
const bal = (id: string) => r2(db.accounts.find(a => a.id === id)?.currentBalance || 0);
const tb = r2(db.journalEntries.reduce((s, j) => s + j.totalDebit - j.totalCredit, 0));
const out: Record<string, number> = {
  'الخزينة 1101': bal('acc-1101'), 'البنك 1102': bal('acc-1102'), 'شيكات 1104': bal('acc-1104'),
  'عملاء محلي 1105': bal('acc-1105'), 'عملاء تصدير 1106 (ج.م)': bal('acc-1106'),
  'مخزون خامات 1108': bal('acc-1108'), 'مخزون تام محلي 1109': bal('acc-1109'),
  'ضريبة مدخلات 1113': bal('acc-1113'), 'خصم منبع 1114': bal('acc-1114'),
  'موردون 2101': bal('acc-2101'), 'ضريبة مخرجات 2103': bal('acc-2103'), 'مستحقات 2104': bal('acc-2104'),
  'أرصدة أول المدة 3103': bal('acc-3103'), 'فرق ميزان المراجعة (لازم 0)': tb,
};
for (const c of snap().customers) {
  const st = LedgerService.buildCustomerStatement({ customerId: c.id });
  if (Math.abs(st.cardDiff) > 0.01) throw new Error(`customer ${c.name}: card/statement differ by ${st.cardDiff}`);
}
if (tb !== 0) throw new Error(`journals do not balance: ${tb}`);
if (Math.abs(bal('acc-1106') - (KUWAIT_USD + UAE_USD) * EXPORT_RATE) > 0.01) throw new Error('export receivable mismatch');
if (Math.abs(bal('acc-2101') + 2776470.89) > 0.01 && Math.abs(bal('acc-2101') - 2776470.89) > 0.01) throw new Error('suppliers mismatch');

writeFileSync(OUT, JSON.stringify(snap()));
console.log(JSON.stringify({ out, notLoaded: log, fgCosts: Object.fromEntries(Object.entries(FG).map(([k, v]) => [k, Number(v.cost.toFixed(2))])),
  fgValue: r2(fgLines.reduce((s, l) => s + l.quantity * l.unitCost, 0)), rawValue: r2(rawLines.reduce((s, l) => s + l.quantity * l.unitCost, 0)) }, null, 1));
