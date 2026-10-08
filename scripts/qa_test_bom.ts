// Shared QA fixture — a canonical TEST BOM for production scenarios.
//
// BATCH P deleted the 11 seeded UAT BOMs from the product. Suites that exercise
// PRODUCTION need an active BOM for their finished product, so they now build
// one explicitly through this helper instead of relying on seed data.
//
// The recipe is derived from the same PRODUCTION_RATES constants the product
// uses, so requirement scaling stays honest (0.8 KG chips and 0.075 KG sauce
// per piece, 1 kraft carton per 15 SINGLE / per 8 DUO, film at 0.005 ROLL/KG).
import { erpDb, PRODUCTION_RATES, CANONICAL_FINISHED_PRODUCTS } from '../src/services/db';
import type { BomHeader } from '../src/types/erp';

const BASE = 1000;

/** Create (once) and return an active test BOM for the given finished item. */
export function ensureTestBom(finishedItemId: string): BomHeader {
  const existing = erpDb.getSnapshot().boms.find(b => b.finishedItemId === finishedItemId && b.active);
  if (existing) return existing;

  const recipe = CANONICAL_FINISHED_PRODUCTS[finishedItemId];
  const isDuo = recipe?.family === 'Duo';
  const sauces = recipe?.sauceItemIds?.length ? recipe.sauceItemIds : ['item-raw-flavor-01'];

  const chipKg = (isDuo ? PRODUCTION_RATES.CHIPS_PER_DUO : PRODUCTION_RATES.CHIPS_PER_SINGLE)
    * BASE * PRODUCTION_RATES.CHIP_KG_PER_PIECE;
  const lines: Array<[string, number, string]> = [
    ['item-raw-corn', PRODUCTION_RATES.CORN_KG_PER_1000, 'unit-kg'],
    ['item-raw-oil', PRODUCTION_RATES.OIL_KG_PER_1000, 'unit-kg'],
    ['item-raw-chip', Number(chipKg.toFixed(4)), 'unit-kg'],
    ['item-pkg-film', Number((chipKg * PRODUCTION_RATES.ROLL_PER_KG_CHIPS).toFixed(6)), 'unit-roll'],
    ...sauces.map(id => [id, PRODUCTION_RATES.SAUCE_KG_PER_PIECE * BASE, 'unit-kg'] as [string, number, string]),
    [isDuo ? 'item-pkg-box-duo' : 'item-pkg-box-single', BASE, 'unit-piece'],
    ['item-pkg-tray', BASE, 'unit-piece'],
    ...(isDuo
      ? [['item-pkg-sauce-tray', BASE, 'unit-piece'], ['item-pkg-liner', BASE, 'unit-piece']] as Array<[string, number, string]>
      : []),
    ['item-pkg-sticker', (isDuo ? 2 : 1) * BASE, 'unit-piece'],
    ['item-pkg-napkin', (isDuo ? 2 : 1) * BASE, 'unit-piece'],
    [isDuo ? 'item-pkg-kraft-duo' : 'item-pkg-kraft-single',
      Number((BASE / (isDuo ? PRODUCTION_RATES.DUO_CARTON_RATIO : PRODUCTION_RATES.SINGLE_CARTON_RATIO)).toFixed(3)),
      'unit-piece'],
  ];

  const bomId = `bom-test-${finishedItemId}`;
  erpDb.mutate(draft => {
    draft.boms.push({
      id: bomId, bomNumber: `BOM-TEST-${finishedItemId}`, finishedItemId,
      version: 1, baseQuantity: BASE, unitId: 'unit-piece', active: true,
      effectiveDate: '2026-01-01', notes: 'QA test fixture (Batch P)', isTest: true,
    } as never);
    lines.forEach(([materialItemId, quantityRequired, unitId], i) => {
      draft.bomLines.push({ id: `bline-${bomId}-${i + 1}`, bomId, materialItemId, quantityRequired, unitId } as never);
    });
  });
  return erpDb.getSnapshot().boms.find(b => b.id === bomId)!;
}

/** First finished product id in the catalog (Single family). */
export function firstFinishedProductId(): string {
  const fp = erpDb.getSnapshot().items.find(i => i.itemType === 'finished_product');
  if (!fp) throw new Error('no finished product in catalog');
  return fp.id;
}