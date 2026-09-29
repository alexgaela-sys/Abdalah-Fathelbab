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
      const dateStr = new Date().toISOString().split('T')[0];
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
    notes?: string
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
      const dateStr = new Date().toISOString().split('T')[0];
      const valueBefore = draft.batches.reduce((s, b) => s + (b.quantity || 0) * (b.unitCost || 0), 0);

      // 1) Deduct consumed layers from source batches (exact per-layer amounts)
      for (const c of plan.consumes) {
        const srcBatch = draft.batches.find(
          b => b.itemId === itemId && b.warehouseId === sourceWarehouseId && b.batchNumber === c.batchNumber
        );
        if (srcBatch) srcBatch.quantity -= c.quantity;
      }

      // 2) Add to target: same batch number, same cost. Merge if a same-number batch exists.
      if (primaryBatch) {
        const existing = draft.batches.find(
          b => b.itemId === itemId && b.warehouseId === targetWarehouseId && b.batchNumber === primaryBatch
        );
        if (existing) {
          const preQty = existing.quantity;
          existing.quantity += qty;
          // Weighted average to keep batch cost faithful when merging layers
          existing.unitCost = ((existing.unitCost || 0) * preQty + actualUnitCost * qty) / (existing.quantity || 1);
          if (!existing.expiryDate && item.trackExpiry && item.expiryPeriodDays && item.expiryPeriodDays > 0) {
            const base = new Date(existing.productionDate || dateStr);
            base.setDate(base.getDate() + item.expiryPeriodDays);
            existing.expiryDate = base.toISOString().split('T')[0];
          }
        } else {
          const srcRef = plan.consumes[0];
          let productionDate = dateStr;
          let expiryDate = '';
          if (srcRef) {
            const srcBatch = draft.batches.find(
              b => b.itemId === itemId && b.warehouseId === sourceWarehouseId && b.batchNumber === srcRef.batchNumber
            );
            if (srcBatch) {
              productionDate = srcBatch.productionDate || dateStr;
              expiryDate = srcBatch.expiryDate || '';
            }
          }
          draft.batches.push({
            id: generateErpId('bat'),
            batchNumber: primaryBatch,
            itemId,
            warehouseId: targetWarehouseId,
            productionDate,
            expiryDate,
            quantity: qty,
            unitCost: actualUnitCost,
          });
          // Also carry over secondary consumed layers when the transfer spans multiple batches
          if (plan.consumes.length > 1) {
            for (const c of plan.consumes.slice(1)) {
              const srcBatch = draft.batches.find(
                b => b.itemId === itemId && b.warehouseId === sourceWarehouseId && b.batchNumber === c.batchNumber
              );
              const tExisting = draft.batches.find(
                b => b.itemId === itemId && b.warehouseId === targetWarehouseId && b.batchNumber === c.batchNumber
              );
              if (tExisting) {
                const preQty = tExisting.quantity;
                tExisting.quantity += c.quantity;
                tExisting.unitCost = ((tExisting.unitCost || 0) * preQty + (c.unitCost || 0) * c.quantity) / (tExisting.quantity || 1);
              } else {
                draft.batches.push({
                  id: generateErpId('bat'),
                  batchNumber: c.batchNumber,
                  itemId,
                  warehouseId: targetWarehouseId,
                  productionDate: srcBatch?.productionDate || dateStr,
                  expiryDate: srcBatch?.expiryDate || '',
                  quantity: c.quantity,
                  unitCost: c.unitCost,
                });
              }
            }
          }
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
}
