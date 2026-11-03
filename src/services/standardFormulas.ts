// معادلات التصنيع القياسية لمنتجات سناك دب (من شيت الإنتاج + بيانات المحاسب).
// الأساس: 1000 قطعة. الشيبس جاهز من المورد بالكيلو؛ كل نكهة لها إنتاجها (قطعة/كجم) بدون هالك.
import { erpDb } from './db';
import { ManufacturingEngine } from './manufacturing';

const BASE = 1000;
const SAUCE = { sweet: 'item-raw-flavor-sweet-chili', spicy: 'item-raw-flavor-spicy-grilled', bbq: 'item-raw-flavor-honey-bbq', burger: 'item-raw-flavor-smokey-burger', mustard: 'item-raw-flavor-honey-mustard' };

/** قطعة نهائية تطلع من كل 1 كجم شيبس */
export const CHIP_YIELD: Record<string, number> = {
  'item-raw-chip-chicken': 900, 'item-raw-chip-beef-bbq': 1100, 'item-raw-chip-krinkle': 960,
  'item-raw-chip-fire-lemon': 1050, 'item-raw-chip-fire-shrimp': 825,
  'item-raw-chip-nacho-salt': 960, 'item-raw-chip-nacho-cheese': 960, 'item-raw-chip-nacho-paprika': 960, 'item-raw-chip-dibi-shells': 960,
};

interface Formula { chip: string; sauces: string[]; duo: boolean }
export const STANDARD_FORMULAS: Record<string, Formula> = {
  'item-fp-d1': { chip: 'item-raw-chip-beef-bbq', sauces: [SAUCE.burger, SAUCE.bbq], duo: true },
  'item-fp-d2': { chip: 'item-raw-chip-beef-bbq', sauces: [SAUCE.burger, SAUCE.mustard], duo: true },
  'item-fp-d3': { chip: 'item-raw-chip-chicken', sauces: [SAUCE.sweet, SAUCE.spicy], duo: true },
  'item-fp-d4': { chip: 'item-raw-chip-chicken', sauces: [SAUCE.sweet, SAUCE.bbq], duo: true },
  'item-fp-d5': { chip: 'item-raw-chip-dibi-shells', sauces: [SAUCE.sweet, SAUCE.bbq], duo: true },
  'item-fp-s1': { chip: 'item-raw-chip-fire-lemon', sauces: [SAUCE.sweet], duo: false },
  'item-fp-s2': { chip: 'item-raw-chip-fire-shrimp', sauces: [SAUCE.spicy], duo: false },
  'item-fp-s3': { chip: 'item-raw-chip-nacho-salt', sauces: [SAUCE.bbq], duo: false },
  'item-fp-s4': { chip: 'item-raw-chip-nacho-paprika', sauces: [SAUCE.sweet], duo: false },
  'item-fp-s5': { chip: 'item-raw-chip-nacho-cheese', sauces: [SAUCE.burger], duo: false },
  'item-fp-s6': { chip: 'item-raw-chip-krinkle', sauces: [SAUCE.mustard], duo: false },
};

export function formulaLines(f: Formula) {
  const portions = f.duo ? 2 : 1;
  const L = (materialItemId: string, quantityRequired: number, unitId: string) => ({ materialItemId, quantityRequired: Number(quantityRequired.toFixed(4)), unitId });
  return [
    L(f.chip, (portions * BASE) / CHIP_YIELD[f.chip], 'unit-kg'),
    L('item-pkg-film', 1, 'unit-roll'),
    ...f.sauces.map(id => L(id, BASE, 'unit-piece')),
    L(f.duo ? 'item-pkg-box-duo' : 'item-pkg-box-single', BASE, 'unit-piece'),
    ...(f.duo
      ? [L('item-pkg-tray', BASE, 'unit-piece'), L('item-pkg-sauce-tray', BASE, 'unit-piece'), L('item-pkg-liner', BASE, 'unit-piece')]
      : [L('item-pkg-sauce-tray', BASE, 'unit-piece')]),
    L('item-pkg-sticker', (f.duo ? 2 : 1) * BASE, 'unit-piece'),
    L('item-pkg-napkin', (f.duo ? 2 : 1) * BASE, 'unit-piece'),
    L(f.duo ? 'item-pkg-kraft-duo' : 'item-pkg-kraft-single', BASE / (f.duo ? 8 : 15), 'unit-piece'),
  ];
}

/** ينشئ معادلة لكل منتج تام (نسخة جديدة وتوقف القديمة). يتخطى المنتج لو معادلته الفعالة قياسية بالفعل. */
export function installStandardBoms(actor: { userId?: string; userName?: string; isTest?: boolean }, date = '2026-11-01'): { success: boolean; created: number; error?: string } {
  let created = 0;
  for (const [fpId, f] of Object.entries(STANDARD_FORMULAS)) {
    const db = erpDb.getSnapshot();
    if (!db.items.find(i => i.id === fpId)) continue;
    const existing = db.boms.find(b => b.finishedItemId === fpId && b.active && (b.notes || '').startsWith('معادلة قياسية'));
    if (existing) continue;
    const r = ManufacturingEngine.createBomVersion({
      finishedItemId: fpId, baseQuantity: BASE, unitId: 'unit-piece', effectiveDate: date,
      notes: 'معادلة قياسية — من شيت الإنتاج (شيبس جاهز بالكيلو، بدون هالك)', lines: formulaLines(f), ...actor,
    });
    if (!r.success) return { success: false, created, error: `${fpId}: ${r.error}` };
    created++;
  }
  return { success: true, created };
}
