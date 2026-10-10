// ITEM 5 — Sales forecasts: manual monthly entry per item with the ACTUAL
// derived from POSTED sales invoices for the same period and item (seed data is
// never treated as an actual). One row per (period, product) — updating is an
// explicit upsert, never a silent duplicate.
import { erpDb, generateErpId, getUnitConversion } from './db';
import { SalesForecast } from '../types/erp';
import { AuthorizationService } from './authorization';

const PERIOD_RE = /^\d{4}-\d{2}$/;

export class ForecastService {
  /**
   * Reporting policy for "actual sales" (documented, applied consistently):
   *   • posted sales invoices in the period: shipped units = quantity + freeQuantity
   *     (a bonus still leaves inventory, so it counts as a shipped unit);
   *   • cancelled invoices are ignored (status !== 'posted');
   *   • posted sales returns in the period are deducted in full.
   * All quantities are in the item's BASE inventory unit.
   */
  public static computeActualQuantity(period: string, productId: string): number {
    const db = erpDb.getSnapshot();
    const lineIds = new Set(
      db.salesInvoices
        .filter(inv => inv.status === 'posted' && String(inv.date || '').startsWith(period))
        .map(inv => inv.id)
    );
    let actual = 0;
    for (const line of db.salesInvoiceLines) {
      if (!lineIds.has(line.invoiceId)) continue;
      if (line.itemId !== productId) continue;
      actual += (Number(line.quantity) || 0) + (Number(line.freeQuantity) || 0);
    }
    const returnIds = new Set(
      db.salesReturns
        .filter(r => r.status === 'posted' && String(r.date || '').startsWith(period))
        .map(r => r.id)
    );
    for (const line of db.salesReturnLines) {
      if (!returnIds.has(line.returnId)) continue;
      if (line.itemId !== productId) continue;
      actual -= Number(line.quantity) || 0;
    }
    return actual;
  }

  /** Accuracy of a forecast against its actual: 100 − |variance|/forecast, floor 0. */
  public static computeAccuracy(forecastQuantity: number, actualQuantity: number): number {
    if (forecastQuantity > 0) {
      const accuracy = 100 - (Math.abs(actualQuantity - forecastQuantity) / forecastQuantity) * 100;
      return Math.max(0, Math.round(accuracy));
    }
    return actualQuantity === 0 ? 100 : 0;
  }

  /**
   * Create or UPDATE the forecast of one (period, item). The quantity is
   * normalized into the item's BASE unit so forecast, actual, variance and
   * accuracy stay comparable; the user, timestamp and notes are persisted.
   */
  public static upsertForecast(params: {
    period: string; // YYYY-MM
    productId: string;
    forecastQuantity: number;
    /** Optional unit the quantity was typed in; converted to the item base unit. */
    unitId?: string;
    notes?: string;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; forecast?: SalesForecast; error?: string; created?: boolean } {
    const db = erpDb.getSnapshot();
    const item = db.items.find(i => i.id === params.productId);
    if (!item) return { success: false, error: 'الصنف غير مسجل بالنظام' };
    if (!PERIOD_RE.test(params.period || '')) {
      return { success: false, error: 'الفترة يجب أن تكون بصيغة YYYY-MM (مثال: 2026-10)' };
    }
    const qty = Number(params.forecastQuantity);
    if (!Number.isFinite(qty) || qty < 0) {
      return { success: false, error: 'كمية التوقع يجب أن تكون رقمًا أكبر من أو يساوي صفر' };
    }

    const existing = db.forecasts.find(f => f.period === params.period && f.productId === params.productId);
    const guard = AuthorizationService.enforce('sales', existing ? 'edit' : 'create', {
      userId: params.userId, userName: params.userName, isTest: params.isTest,
    });
    if (!guard.allowed) return { success: false, error: guard.error };

    // Normalize the entered quantity into the item's base unit.
    let qtyBase = qty;
    let unitId = item.baseUnitId;
    if (params.unitId && params.unitId !== item.baseUnitId) {
      try {
        qtyBase = qty * getUnitConversion(db, params.unitId, item.baseUnitId);
      } catch (e) {
        return { success: false, error: `لا يوجد معامل تحويل وحدة للتوقع (${item.nameAr}): ${(e as Error).message}` };
      }
    }
    qtyBase = Number(qtyBase.toFixed(6));

    const actual = this.computeActualQuantity(params.period, params.productId);
    const variance = Number((actual - qtyBase).toFixed(6));

    let saved: SalesForecast | undefined;
    const now = new Date().toISOString();
    erpDb.mutate(draft => {
      let row = draft.forecasts.find(f => f.period === params.period && f.productId === params.productId);
      if (row) {
        row.forecastQuantity = qtyBase;
        row.unitId = unitId;
        row.actualQuantity = actual;
        row.varianceQuantity = variance;
        row.accuracyPercentage = this.computeAccuracy(qtyBase, actual);
        row.updatedByUserId = guard.userId;
        row.updatedByName = guard.userName;
        row.updatedAt = now;
        if (params.notes !== undefined) row.notes = params.notes;
        saved = row;
      } else {
        row = {
          id: generateErpId('fc'),
          period: params.period,
          productId: params.productId,
          forecastQuantity: qtyBase,
          actualQuantity: actual,
          varianceQuantity: variance,
          accuracyPercentage: this.computeAccuracy(qtyBase, actual),
          unitId,
          updatedByUserId: guard.userId,
          updatedByName: guard.userName,
          updatedAt: now,
          notes: params.notes,
          isTest: params.isTest,
        };
        draft.forecasts.push(row);
        saved = row;
      }
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: now,
        userId: guard.userId,
        userName: guard.userName,
        module: 'التقارير - توقعات المبيعات',
        action: existing ? 'edit' : 'create',
        recordId: saved.id,
        description: `${existing ? 'تعديل' : 'إنشاء'} توقع مبيعات للفترة ${params.period} والصنف ${item.nameAr}: الكمية ${qtyBase} ${unitId} — الفعلي ${actual} — الفرق ${variance}`,
      });
    });

    return { success: true, forecast: saved, created: !existing };
  }

  /**
   * Recompute actual / variance / accuracy for every forecast of a period from
   * the posted invoices of that period (never from seed data). Returns how many
   * rows were refreshed.
   */
  public static recalculatePeriod(period: string): { success: boolean; updated?: number; error?: string } {
    if (!PERIOD_RE.test(period || '')) {
      return { success: false, error: 'الفترة يجب أن تكون بصيغة YYYY-MM (مثال: 2026-10)' };
    }
    const db = erpDb.getSnapshot();
    const targets = db.forecasts.filter(f => f.period === period);
    let updated = 0;
    erpDb.mutate(draft => {
      for (const row of draft.forecasts) {
        if (row.period !== period) continue;
        const actual = this.computeActualQuantity(period, row.productId);
        const variance = Number((actual - row.forecastQuantity).toFixed(6));
        if (row.actualQuantity !== actual || row.varianceQuantity !== variance) updated++;
        row.actualQuantity = actual;
        row.varianceQuantity = variance;
        row.accuracyPercentage = this.computeAccuracy(row.forecastQuantity, actual);
        row.updatedAt = new Date().toISOString();
      }
    });
    return { success: true, updated };
  }
}
