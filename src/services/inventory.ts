// Perpetual Inventory Engine with Batch & Expiry Tracking, Traceable Transactions, Transfers,
// and TRUE FIFO Multi-Batch Costing (actual issued cost is computed from the batches consumed).
import { erpDb, generateErpId } from './db';
import { InventoryMovementType, InventoryTransaction, Batch, Item, Warehouse } from '../types/erp';

export interface StockMovementRequest {
  itemId: string;
  warehouseId: string;
  movementType: InventoryMovementType;
  quantityIn: number;
  quantityOut: number;
  /** Requested cost. For issues (quantityOut>0) the engine IGNORES this and derives
   *  the actual cost from the FIFO batches consumed. For receipts it is the landed cost. */
  unitCost: number;
  documentType: string;
  documentNumber: string;
  batchNumber?: string;
  productionDate?: string;
  expiryDate?: string;
  notes?: string;
  allowNegative?: boolean;
  isTest?: boolean;
  /**
   * F18: business date of the movement (YYYY-MM-DD). Defaults to today.
   * The item card filters by this date, so a back-dated document must record
   * ITS OWN date rather than the posting day.
   */
  date?: string;
  /** Output: actual cost of goods issued, computed from consumed batches */
  _actualCost?: number;
}

export interface StockIssueResult {
  success: boolean;
  error?: string;
  transaction?: InventoryTransaction;
  /** Actual total cost of the issued quantity (sum over FIFO consumed batches). */
  actualCost?: number;
  /** Weighted average unit cost actually applied (actualCost / issuedQty). */
  actualUnitCost?: number;
  consumedBatches?: Array<{ batchNumber: string; quantity: number; unitCost: number; totalCost: number }>;
}

/** Result of a FIFO consumption plan (pure calculation, no mutation) */
export interface ConsumptionPlan {
  consumes: Array<{ batchNumber: string; quantity: number; unitCost: number; totalCost: number }>;
  actualCost: number;
  shortfall: number; // >0 when available stock is insufficient
}

export interface ItemCardRow {
  transactionId: string;
  date: string;
  documentNumber: string;
  documentType: string;
  movementType: InventoryMovementType;
  movementLabelAr: string;
  warehouseId: string;
  warehouseNameAr: string;
  quantityIn: number;
  quantityOut: number;
  runningBalance: number;
  unitCost: number;
  value: number;
  /** Link target for "open the source document" (nav tab + document id). */
  link?: { tab: string; recordId: string };
}

export interface ItemCardResult {
  itemId: string;
  itemNameAr: string;
  itemCode: string;
  baseUnitId: string;
  unitNameAr: string;
  warehouseId: string; // '' = all warehouses
  warehouseNameAr: string;
  fromDate: string;
  toDate: string;
  openingBalance: number;
  rows: ItemCardRow[];
  closingBalance: number;
  /** Actual on-hand quantity (batches) for the same selection — the truth to reconcile against. */
  actualBalance: number;
  /** closingBalance - actualBalance; any non-zero value is a REAL mismatch and is shown as such. */
  mismatch: number;
  totalIn: number;
  totalOut: number;
  closingValue: number;
}

const MOVEMENT_LABELS_AR: Record<string, string> = {
  purchase_receipt: 'إشعار استلام مشتريات',
  purchase_return: 'مرتجع مشتريات',
  warehouse_transfer: 'تحويل مخزني',
  production_consumption: 'صرف مواد إنتاج',
  production_issue: 'صرف مواد إنتاج',
  production_output: 'وارد إنتاج تام',
  sales: 'فاتورة مبيعات',
  sales_return: 'مرتجع مبيعات',
  rep_loading: 'تحميل عهد مندوب',
  rep_return: 'إرجاع من عهد مندوب',
  scrap: 'هالك / سكراب',
  recycling: 'إعادة تدوير',
  inventory_adjustment: 'تسوية جرد',
  physical_inventory: 'جرد فعلي',
};

/** Where a movement row links to, per movement type (F18: "open the source document"). */
function movementLink(movementType: string, docNumber: string): ItemCardRow['link'] {
  switch (movementType) {
    case 'sales': return { tab: 'sales', recordId: docNumber };
    case 'sales_return': return { tab: 'sales', recordId: docNumber };
    case 'purchase_receipt': return { tab: 'purchasing', recordId: docNumber };
    case 'purchase_return': return { tab: 'purchasing', recordId: docNumber };
    case 'warehouse_transfer': return { tab: 'inventory', recordId: docNumber };
    case 'production_output':
    case 'production_issue':
    case 'production_consumption': return { tab: 'manufacturing', recordId: docNumber };
    default: return { tab: 'inventory', recordId: docNumber };
  }
}

export class InventoryEngine {
  /**
   * Get current stock of an item in a specific warehouse (or across all warehouses)
   */
  public static getItemBalance(itemId: string, warehouseId?: string): number {
    const db = erpDb.getSnapshot();
    return db.batches
      .filter(b => b.itemId === itemId && (!warehouseId || b.warehouseId === warehouseId))
      .reduce((sum, b) => sum + (b.quantity || 0), 0);
  }

  /**
   * Get inventory VALUE of an item (qty x batch unitCost) in a warehouse or company-wide.
   * Valuation uses the actual batch costs (FIFO layers), never a stale standard cost.
   */
  public static getItemValue(itemId: string, warehouseId?: string): number {
    const db = erpDb.getSnapshot();
    return db.batches
      .filter(b => b.itemId === itemId && (!warehouseId || b.warehouseId === warehouseId))
      .reduce((sum, b) => sum + (b.quantity || 0) * (b.unitCost || 0), 0);
  }

  /**
   * Get all active batches for an item in a specific warehouse (FIFO order: production date, then receipt)
   */
  public static getItemBatches(itemId: string, warehouseId?: string): Batch[] {
    const db = erpDb.getSnapshot();
    return db.batches
      .filter(b => b.itemId === itemId && (!warehouseId || b.warehouseId === warehouseId) && b.quantity > 0)
      .sort((a, b) => {
        const d = (a.productionDate || '').localeCompare(b.productionDate || '');
        if (d !== 0) return d;
        return (a.batchNumber || '').localeCompare(b.batchNumber || '');
      });
  }

  /**
   * Check for batches expiring within N days (Default: 10 days as required by ERP specification)
   */
  public static getExpiringBatches(daysThreshold: number = 10): Array<Batch & { daysUntilExpiry: number; itemNameAr: string; warehouseNameAr: string }> {
    const db = erpDb.getSnapshot();
    const now = new Date();
    const itemsMap = new Map(db.items.map(i => [i.id, i.nameAr]));
    const whMap = new Map(db.warehouses.map(w => [w.id, w.nameAr]));

    const result: Array<Batch & { daysUntilExpiry: number; itemsNameAr?: string; itemNameAr: string; warehouseNameAr: string }> = [];

    db.batches.forEach(b => {
      if (b.quantity <= 0 || !b.expiryDate) return;
      const expiry = new Date(b.expiryDate);
      const diffTime = expiry.getTime() - now.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays <= daysThreshold) {
        result.push({
          ...b,
          daysUntilExpiry: diffDays,
          itemNameAr: itemsMap.get(b.itemId) || b.itemId,
          warehouseNameAr: whMap.get(b.warehouseId) || b.warehouseId,
        });
      }
    });

    return result.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
  }

  /**
   * PURE calculation: plan a FIFO consumption of `quantity` of an item in a warehouse.
   * If batchNumber is given, consume that batch first and validate its available quantity.
   * Returns the exact per-batch consumption so cost can be computed from real layers.
   */
  private static planFifoConsumption(
    db: { batches: Batch[] },
    itemId: string,
    warehouseId: string,
    quantity: number,
    specificBatchNumber?: string
  ): ConsumptionPlan {
    const allWhBatches = db.batches.filter(b => b.itemId === itemId && b.warehouseId === warehouseId && b.quantity > 0);

    // FIFO ordering: production/receipt date ascending, then batch number as deterministic tiebreak
    const fifoOrdered = [...allWhBatches].sort((a, b) => {
      const d = (a.productionDate || '').localeCompare(b.productionDate || '');
      if (d !== 0) return d;
      return (a.batchNumber || '').localeCompare(b.batchNumber || '');
    });

    let consumptionOrder: Batch[];
    if (specificBatchNumber) {
      // Specified batch is consumed FIRST, then FIFO for the remainder
      const specific = fifoOrdered.filter(b => b.batchNumber === specificBatchNumber);
      const rest = fifoOrdered.filter(b => b.batchNumber !== specificBatchNumber);
      consumptionOrder = [...specific, ...rest];
    } else {
      consumptionOrder = fifoOrdered;
    }

    let remaining = quantity;
    const consumes: ConsumptionPlan['consumes'] = [];
    let actualCost = 0;
    let shortfall = quantity;

    for (const b of consumptionOrder) {
      if (remaining <= 0) break;
      const take = Math.min(b.quantity, remaining);
      if (take <= 0) continue;
      const layerCost = take * (b.unitCost || 0);
      consumes.push({ batchNumber: b.batchNumber, quantity: take, unitCost: b.unitCost || 0, totalCost: layerCost });
      actualCost += layerCost;
      remaining -= take;
      shortfall -= take;
    }

    return { consumes, actualCost, shortfall };
  }

  /**
   * Compute default expiry date from the ITEM configuration (never a hardcoded 180 days).
   * Uses Item.expiryPeriodDays when the item tracks expiry; otherwise no expiry is set.
   */
  private static computeExpiryDate(item: Item, productionDate: string, providedExpiry?: string): string {
    if (providedExpiry && providedExpiry.trim()) return providedExpiry;
    if (!item.trackExpiry) return '';
    const period = item.expiryPeriodDays;
    if (!period || period <= 0) return '';
    const base = new Date(productionDate || new Date().toISOString().split('T')[0]);
    base.setDate(base.getDate() + period);
    return base.toISOString().split('T')[0];
  }

  /**
   * PURE (no mutation): estimate the actual FIFO cost of issuing `quantity` from a warehouse.
   * Used by document flows (sales, transfers) to book accounting entries with the exact
   * cost that recordMovement will consume immediately afterwards (deterministic, single-threaded).
   */
  public static estimateIssueCost(
    itemId: string,
    warehouseId: string,
    quantity: number,
    specificBatchNumber?: string
  ): ConsumptionPlan & { available: number; actualUnitCost?: number } {
    const db = erpDb.getSnapshot();
    const plan = this.planFifoConsumption(db, itemId, warehouseId, quantity, specificBatchNumber);
    const available = db.batches
      .filter(b => b.itemId === itemId && b.warehouseId === warehouseId)
      .reduce((s, b) => s + (b.quantity || 0), 0);
    return {
      ...plan,
      available,
      actualUnitCost: quantity > 0 ? plan.actualCost / quantity : undefined,
    };
  }

  /**
   * THE SINGLE SOURCE OF COST RESOLUTION for costed postings (QA-01 / QA-22 / QA-27).
   *
   * Priority order — no invented values, no silent fallbacks:
   *   1. the FIFO / actual cost of the stock that is actually being issued
   *      (this is what leaves inventory and therefore what must hit COGS);
   *   2. a LEGITIMATELY CONFIGURED standard cost (`item.standardCost > 0`) —
   *      the existing configured mechanism, used only when no stock exists yet;
   *   3. otherwise FAIL, so the caller can show a clear Arabic business message.
   *
   * A zero cost is NEVER silently replaced by an arbitrary number.
   */
  public static resolveActualUnitCost(
    itemId: string,
    warehouseId: string,
    quantity: number
  ): { ok: true; unitCost: number; totalCost: number; source: 'fifo' | 'standard' } | { ok: false; error: string } {
    const db = erpDb.getSnapshot();
    const item = db.items.find(i => i.id === itemId);
    if (!item) return { ok: false, error: 'الصنف غير معرف بنظام الأصناف' };

    if (quantity > 0) {
      const plan = this.planFifoConsumption(db, itemId, warehouseId, quantity, undefined);
      if (plan.shortfall === 0 && plan.actualCost > 0) {
        return {
          ok: true,
          unitCost: plan.actualCost / quantity,
          totalCost: plan.actualCost,
          source: 'fifo',
        };
      }
      // Stock exists but is valued at zero (never purchased / never costed).
      if (plan.shortfall === 0 && (item.standardCost || 0) > 0) {
        return {
          ok: true,
          unitCost: item.standardCost,
          totalCost: item.standardCost * quantity,
          source: 'standard',
        };
      }
      const available = this.getItemBalance(itemId, warehouseId);
      return {
        ok: false,
        error:
          plan.shortfall > 0
            ? `الرصيد المتاح من الصنف (${item.nameAr}) في المستودع المحدد هو ${available} ولا يكفي للكمية المطلوبة (${quantity}).`
            : `لا توجد تكلفة فعلية معرَّفة للصنف (${item.nameAr}) في المستودع المحدد. ` +
              `يجب إدخال تكلفة الصنف في بطاقة الصنف أو استلامه من مورد بسعر فعلي قبل الترحيل المحاسبي.`,
      };
    }

    if ((item.standardCost || 0) > 0) {
      return { ok: true, unitCost: item.standardCost, totalCost: 0, source: 'standard' };
    }
    return {
      ok: false,
      error: `لا توجد تكلفة معيارية معرَّفة للصنف (${item.nameAr}). يجب ضبط تكلفة الصنف قبل الترحيل المحاسبي.`,
    };
  }

  /**
   * Record a traceable inventory transaction and update perpetual batches — ATOMIC.
   * Everything (batch updates + transaction record) happens inside ONE erpDb.mutate;
   * all validation happens BEFORE any mutation, so a failed operation leaves zero trace.
   *
   * For issues (quantityOut > 0) the actual issued cost is calculated from the FIFO
   * batches actually consumed (multi-batch aware) — never from the request's unitCost.
   */
  public static recordMovement(req: StockMovementRequest): StockIssueResult {
    const db = erpDb.getSnapshot();

    // ---- Referential integrity (FK-style validation) ----
    const item = db.items.find(i => i.id === req.itemId);
    if (!item) return { success: false, error: 'الصنف غير معرف بنظام الأصناف' };
    const warehouse = db.warehouses.find(w => w.id === req.warehouseId);
    if (!warehouse) return { success: false, error: 'المستودع المحدد غير موجود' };

    const qtyIn = Number(req.quantityIn) || 0;
    const qtyOut = Number(req.quantityOut) || 0;
    if (qtyIn < 0 || qtyOut < 0) return { success: false, error: 'لا يجوز إدخال كميات سالبة' };
    if (qtyIn > 0 && qtyOut > 0) return { success: false, error: 'لا يمكن أن تكون الحركة إضافة وصرفًا في نفس الوقت' };
    if (qtyIn === 0 && qtyOut === 0) return { success: false, error: 'يجب تحديد كمية واردة أو منصرفة' };

    // Batch integrity: a named batch must belong to this item
    if (req.batchNumber) {
      const batchExists = db.batches.some(b => b.batchNumber === req.batchNumber && b.itemId === req.itemId);
      if (!batchExists && qtyOut > 0) {
        return { success: false, error: `التشغيلة (${req.batchNumber}) غير موجودة لهذا الصنف ولا يمكن الصرف منها` };
      }
    }

    // ---- FIFO planning (pure, pre-mutation) ----
    const plan = this.planFifoConsumption(db, req.itemId, req.warehouseId, qtyOut, req.batchNumber);
    if (plan.shortfall > 0 && !req.allowNegative) {
      const currentStock = this.getItemBalance(req.itemId, req.warehouseId);
      return {
        success: false,
        error: `الرصيد المتاح من الصنف (${item.nameAr}) في مستودع (${warehouse.nameAr}) هو ${currentStock} ولا يكفي لصرف كمية ${qtyOut} (نقص ${plan.shortfall})`
      };
    }
    // Cost of consumed layers (0 for pure receipts); may grow in the negative-stock path
    let actualCost = plan.actualCost;

    let createdTx: InventoryTransaction | undefined;

    erpDb.mutate((draft) => {
      const dateStr = req.date || new Date().toISOString().split('T')[0];
      const batchNum = req.batchNumber || `BATCH-${dateStr.replace(/-/g, '')}-${generateErpId('bn').slice(-6).toUpperCase()}`;

      const findBatch = (): Batch | undefined =>
        draft.batches.find(b => b.itemId === req.itemId && b.warehouseId === req.warehouseId && b.batchNumber === batchNum);

      // ---- RECEIPT: create or top-up batch, preserving production/expiry/cost ----
      if (qtyIn > 0) {
        const existing = findBatch();
        if (existing) {
          existing.quantity += qtyIn;
          // Weighted-average the batch cost when topping up an existing batch layer
          const totalQty = existing.quantity;
          if (totalQty > 0 && existing.unitCost !== req.unitCost) {
            existing.unitCost = ((existing.unitCost * (totalQty - qtyIn)) + (req.unitCost * qtyIn)) / totalQty;
          }
          if (req.productionDate) existing.productionDate = existing.productionDate || req.productionDate;
          if (!existing.expiryDate) existing.expiryDate = this.computeExpiryDate(item, existing.productionDate, req.expiryDate);
        } else {
          draft.batches.push({
            id: generateErpId('bat'),
            batchNumber: batchNum,
            itemId: req.itemId,
            warehouseId: req.warehouseId,
            productionDate: req.productionDate || dateStr,
            expiryDate: this.computeExpiryDate(item, req.productionDate || dateStr, req.expiryDate),
            quantity: qtyIn,
            unitCost: req.unitCost,
            isTest: req.isTest,
          });
        }
      }

    // Issue: consume planned FIFO layers, actual cost from the batches actually consumed
    if (qtyOut > 0) {
        for (const c of plan.consumes) {
          const draftBatch = draft.batches.find(
            b => b.itemId === req.itemId && b.warehouseId === req.warehouseId && b.batchNumber === c.batchNumber
          );
          if (draftBatch) {
            draftBatch.quantity -= c.quantity;
            if (draftBatch.quantity < 0) draftBatch.quantity = 0; // only possible with allowNegative
          }
        }
        // Negative-stock path: shortfall consumed at the requested cost
        if (plan.shortfall > 0 && req.allowNegative) {
          actualCost += plan.shortfall * req.unitCost;
        }
      }

      const balanceAfter = draft.batches
        .filter(b => b.itemId === req.itemId && b.warehouseId === req.warehouseId)
        .reduce((sum, b) => sum + b.quantity, 0);

      const qty = qtyIn > 0 ? qtyIn : qtyOut;
      const txTotalCost = qtyIn > 0 ? qtyIn * req.unitCost : actualCost;

      createdTx = {
        id: generateErpId('itx'),
        date: dateStr,
        documentType: req.documentType,
        documentNumber: req.documentNumber,
        movementType: req.movementType,
        itemId: req.itemId,
        warehouseId: req.warehouseId,
        batchNumber: qtyOut > 0 && plan.consumes.length > 0 ? plan.consumes[0].batchNumber : batchNum,
        quantityIn: qtyIn,
        quantityOut: qtyOut,
        balanceAfter,
        unitCost: qtyIn > 0 ? req.unitCost : (qtyOut > 0 && qty > 0 ? actualCost / qty : 0),
        totalCost: txTotalCost,
        notes: req.notes,
        isTest: req.isTest,
      };

      draft.inventoryTransactions.push(createdTx);
    });

    return {
      success: true,
      transaction: createdTx,
      actualCost,
      actualUnitCost: qtyOut > 0 && qtyOut > 0 ? actualCost / qtyOut : undefined,
      consumedBatches: plan.consumes,
    };
  }

  /**
   * Transfer inventory between warehouses — ATOMIC, value-preserving, batch-preserving.
   * 1. Validates both warehouses and available stock BEFORE any mutation.
   * 2. Consumes FIFO (or the specified batch) from the source at ACTUAL batch cost.
   * 3. Creates/merges the exact same batch number in the target with the SAME unit cost.
   * 4. Records two traceable movements (out / in) with the SAME document number.
   * 5. Total company inventory VALUE is unchanged (out at cost X, in at cost X).
   */
  public static transferWarehouse(
    itemId: string,
    sourceWarehouseId: string,
    targetWarehouseId: string,
    quantity: number,
    unitCostHint?: number,
    batchNumber?: string,
    notes?: string,
    /** F18: business date of the transfer (defaults to today). */
    date?: string
  ): { success: boolean; error?: string; outTransaction?: InventoryTransaction; inTransaction?: InventoryTransaction; actualCost?: number } {
    if (sourceWarehouseId === targetWarehouseId) {
      return { success: false, error: 'لا يمكن التحويل لنفس المستودع' };
    }

    const db = erpDb.getSnapshot();
    const item = db.items.find(i => i.id === itemId);
    if (!item) return { success: false, error: 'الصنف غير معرف بنظام الأصناف' };

    const source = db.warehouses.find(w => w.id === sourceWarehouseId);
    const target = db.warehouses.find(w => w.id === targetWarehouseId);
    if (!source) return { success: false, error: 'مستودع المصدر غير موجود' };
    if (!target) return { success: false, error: 'مستودع الوجهة غير موجود' };

    const qty = Number(quantity) || 0;
    if (qty <= 0) return { success: false, error: 'كمية التحويل يجب أن تكون أكبر من صفر' };

    const available = this.getItemBalance(itemId, sourceWarehouseId);
    if (available < qty) {
      return { success: false, error: `الكمية المتاحة في المستودع المحول منه (${available}) غير كافية لتحويل (${qty})` };
    }

    // Plan FIFO consumption from source (pure) so cost is known before mutating
    const plan = this.planFifoConsumption(db, itemId, sourceWarehouseId, qty, batchNumber);
    if (plan.shortfall > 0) {
      return { success: false, error: `لا توجد كمية كافية بالتشغيلات لتحويل ${qty} (نقص ${plan.shortfall})` };
    }

    const actualCost = plan.actualCost;
    const actualUnitCost = qty > 0 ? actualCost / qty : 0;
    const docNum = `TRF-${new Date().toISOString().split('T')[0].replace(/-/g, '')}-${generateErpId('trf').slice(-6).toUpperCase()}`;

    // Build primary batch number for the receipt side (the specific batch, or first consumed)
    const primaryBatch = batchNumber || (plan.consumes.length > 0 ? plan.consumes[0].batchNumber : undefined);

    let outTx: InventoryTransaction | undefined;
    let inTx: InventoryTransaction | undefined;
    let postCheck: { outBalance: number; inBalance: number; totalValueBefore: number } | null = null;

    // ---- SINGLE ATOMIC MUTATION for BOTH sides ----
    erpDb.mutate((draft) => {
      const dateStr = date || new Date().toISOString().split('T')[0];
      const valueBefore = draft.batches.reduce((s, b) => s + (b.quantity || 0) * (b.unitCost || 0), 0);

      // 1) Deduct consumed layers from source batches (exact per-layer amounts)
      for (const c of plan.consumes) {
        const srcBatch = draft.batches.find(
          b => b.itemId === itemId && b.warehouseId === sourceWarehouseId && b.batchNumber === c.batchNumber
        );
        if (srcBatch) srcBatch.quantity -= c.quantity;
      }

      // 2) Add to target — the destination mirrors the SOURCE LAYERS EXACTLY.
      //    One target batch per consumed source layer, carrying that layer's own
      //    batch number and unit cost. This guarantees:
      //      total target quantity increase == source quantity decrease,
      //      and total inventory value is preserved (QA-05 / QA-06).
      //    (Previously the first layer received the whole transfer quantity AND
    //     the secondary layers were added again, duplicating stock.)
      const layers = plan.consumes.length > 0
        ? plan.consumes
        : [{ batchNumber: primaryBatch || `${docNum}-L1`, quantity: qty, unitCost: actualUnitCost }];
      for (const c of layers) {
        const layerBatchNumber = c.batchNumber || primaryBatch || `${docNum}-L1`;
        const srcBatch = draft.batches.find(
          b => b.itemId === itemId && b.warehouseId === sourceWarehouseId && b.batchNumber === layerBatchNumber
        );
        const layerQty = c.quantity > 0 ? c.quantity : qty;
        const layerCost = c.unitCost != null && c.unitCost > 0 ? c.unitCost : actualUnitCost;
        const tExisting = draft.batches.find(
          b => b.itemId === itemId && b.warehouseId === targetWarehouseId && b.batchNumber === layerBatchNumber
        );
        if (tExisting) {
          const preQty = tExisting.quantity;
          tExisting.quantity += layerQty;
          // Weighted average to keep batch cost faithful when merging layers
          tExisting.unitCost = ((tExisting.unitCost || 0) * preQty + layerCost * layerQty) / (tExisting.quantity || 1);
          if (!tExisting.expiryDate && item.trackExpiry && item.expiryPeriodDays && item.expiryPeriodDays > 0) {
            const base = new Date(tExisting.productionDate || dateStr);
            base.setDate(base.getDate() + item.expiryPeriodDays);
            tExisting.expiryDate = base.toISOString().split('T')[0];
          }
        } else {
          draft.batches.push({
            id: generateErpId('bat'),
            batchNumber: layerBatchNumber,
            itemId,
            warehouseId: targetWarehouseId,
            productionDate: srcBatch?.productionDate || dateStr,
            expiryDate: srcBatch?.expiryDate || '',
            quantity: layerQty,
            unitCost: layerCost,
          });
        }
      }

      const balanceSrcAfter = draft.batches
        .filter(b => b.itemId === itemId && b.warehouseId === sourceWarehouseId)
        .reduce((s, b) => s + b.quantity, 0);
      const balanceTgtAfter = draft.batches
        .filter(b => b.itemId === itemId && b.warehouseId === targetWarehouseId)
        .reduce((s, b) => s + b.quantity, 0);

      outTx = {
        id: generateErpId('itx'),
        date: dateStr,
        documentType: 'تحويل مخزني داخلي',
        documentNumber: docNum,
        movementType: 'warehouse_transfer',
        itemId,
        warehouseId: sourceWarehouseId,
        batchNumber: primaryBatch,
        quantityIn: 0,
        quantityOut: qty,
        balanceAfter: balanceSrcAfter,
        unitCost: actualUnitCost,
        totalCost: actualCost,
        notes: `تحويل إلى مستودع (${target.code} - ${target.nameAr}): ${notes || ''}`,
      };
      inTx = {
        id: generateErpId('itx'),
        date: dateStr,
        documentType: 'تحويل مخزني داخلي',
        documentNumber: docNum,
        movementType: 'warehouse_transfer',
        itemId,
        warehouseId: targetWarehouseId,
        batchNumber: primaryBatch,
        quantityIn: qty,
        quantityOut: 0,
        balanceAfter: balanceTgtAfter,
        unitCost: actualUnitCost,
        totalCost: actualCost,
        notes: `وارد من مستودع (${source.code} - ${source.nameAr}): ${notes || ''}`,
      };

      draft.inventoryTransactions.push(outTx!, inTx!);

      // Integrity post-check (inside the same mutation): total company inventory value unchanged
      const valueAfter = draft.batches.reduce((s, b) => s + (b.quantity || 0) * (b.unitCost || 0), 0);
      if (Math.abs(valueAfter - valueBefore) > 0.01) {
        console.error('INVENTORY TRANSFER VALUE GUARD BREACH', { valueBefore, valueAfter });
      }
    });

    return { success: true, outTransaction: outTx, inTransaction: inTx, actualCost };
  }

  /**
   * F18 — ITEM CARD / كارت صنف.
   *
   * Built strictly from the EXISTING `inventoryTransactions` ledger (one engine,
   * one source of truth) plus the batch layers for the opening balance. Nothing
   * is written. The ending balance is reconciled against the real on-hand batch
   * quantity and any difference is returned explicitly (`mismatch`) so the UI
   * can show it instead of hiding it.
   */
  public static getItemCard(params: {
    itemId: string;
    warehouseId?: string; // '' or undefined = all warehouses
    fromDate?: string;
    toDate?: string;
  }): ItemCardResult {
    const db = erpDb.getSnapshot();
    const item = db.items.find(i => i.id === params.itemId);
    const unitNameAr = db.units.find(u => u.id === item?.baseUnitId)?.nameAr || '';
    const warehouseId = params.warehouseId && params.warehouseId !== 'all' ? params.warehouseId : '';
    const warehouseNameAr = warehouseId
      ? (db.warehouses.find(w => w.id === warehouseId)?.nameAr || warehouseId)
      : 'كافة المستودعات';
    const fromDate = params.fromDate || '0000-01-01';
    const toDate = params.toDate || '9999-12-31';

    const inScope = (t: InventoryTransaction) =>
      t.itemId === params.itemId && (!warehouseId || t.warehouseId === warehouseId);

    const movements = db.inventoryTransactions.filter(inScope);
    // QA-18: preserve the LEDGER'S OWN posting order as the tiebreaker for
    // movements that share a date. Sorting by warehouse/document instead made
    // a transfer's "in" leg appear before its "out" leg, so the running balance
    // transiently displayed a quantity that never existed.
    const ledgerOrder = new Map<string, number>();
    db.inventoryTransactions.forEach((t, idx) => ledgerOrder.set(t.id, idx));

    // Opening balance = every movement strictly before the from date.
    const openingBalance = movements
      .filter(t => t.date < fromDate)
      .reduce((s, t) => s + (t.quantityIn || 0) - (t.quantityOut || 0), 0);

    const rows: ItemCardRow[] = movements
      .filter(t => t.date >= fromDate && t.date <= toDate)
      .sort((a, b) => {
        const byDate = (a.date || '').localeCompare(b.date || '');
        if (byDate !== 0) return byDate;
        // stable secondary ordering: the ledger's own posting sequence
        const seqA = ledgerOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const seqB = ledgerOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        if (seqA !== seqB) return seqA - seqB;
        return (a.id || '').localeCompare(b.id || '');
      })
      .map(t => ({
        transactionId: t.id,
        date: t.date,
        documentNumber: t.documentNumber,
        documentType: t.documentType,
        movementType: t.movementType,
        movementLabelAr: MOVEMENT_LABELS_AR[t.movementType] || t.movementType,
        warehouseId: t.warehouseId,
        warehouseNameAr: db.warehouses.find(w => w.id === t.warehouseId)?.nameAr || t.warehouseId,
        quantityIn: t.quantityIn || 0,
        quantityOut: t.quantityOut || 0,
        runningBalance: 0,
        unitCost: t.unitCost || 0,
        value: (t.quantityIn || 0) > 0 ? (t.quantityIn || 0) * (t.unitCost || 0) : -(t.totalCost || 0),
        link: movementLink(t.movementType, t.documentNumber),
      }));

    let running = openingBalance;
    for (const r of rows) {
      running += r.quantityIn - r.quantityOut;
      r.runningBalance = running;
    }

    const closingBalance = running;
    const actualBalance = this.getItemBalance(params.itemId, warehouseId || undefined);
    const closingValue = this.getItemValue(params.itemId, warehouseId || undefined);

    return {
      itemId: params.itemId,
      itemNameAr: item?.nameAr || params.itemId,
      itemCode: item?.code || '',
      baseUnitId: item?.baseUnitId || '',
      unitNameAr,
      warehouseId,
      warehouseNameAr,
      fromDate,
      toDate,
      openingBalance,
      rows,
      closingBalance,
      actualBalance,
      mismatch: Number((closingBalance - actualBalance).toFixed(6)),
      totalIn: rows.reduce((s, r) => s + r.quantityIn, 0),
      totalOut: rows.reduce((s, r) => s + r.quantityOut, 0),
      closingValue,
    };
  }
}
