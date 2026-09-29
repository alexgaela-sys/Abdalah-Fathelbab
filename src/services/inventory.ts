// Perpetual Inventory Engine with Batch & Expiry Tracking, Traceable Transactions, and Transfers
import { erpDb } from './db';
import { InventoryMovementType, InventoryTransaction, Batch } from '../types/erp';
import { AccountingEngine } from './accounting';

export interface StockMovementRequest {
  itemId: string;
  warehouseId: string;
  movementType: InventoryMovementType;
  quantityIn: number;
  quantityOut: number;
  unitCost: number;
  documentType: string;
  documentNumber: string;
  batchNumber?: string;
  productionDate?: string;
  expiryDate?: string;
  notes?: string;
  allowNegative?: boolean;
}

export class InventoryEngine {
  /**
   * Get current stock of an item in a specific warehouse (or across all warehouses)
   */
  public static getItemBalance(itemId: string, warehouseId?: string): number {
    const db = erpDb.getSnapshot();
    const batches = db.batches.filter(b => b.itemId === itemId && (!warehouseId || b.warehouseId === warehouseId));
    return batches.reduce((sum, b) => sum + (b.quantity || 0), 0);
  }

  /**
   * Get all active batches for an item in a specific warehouse
   */
  public static getItemBatches(itemId: string, warehouseId?: string): Batch[] {
    const db = erpDb.getSnapshot();
    return db.batches.filter(b => b.itemId === itemId && (!warehouseId || b.warehouseId === warehouseId) && b.quantity > 0);
  }

  /**
   * Check for batches expiring within N days (Default: 10 days as required by ERP specification)
   */
  public static getExpiringBatches(daysThreshold: number = 10): Array<Batch & { daysUntilExpiry: number; itemNameAr: string; warehouseNameAr: string }> {
    const db = erpDb.getSnapshot();
    const now = new Date();
    const thresholdDate = new Date();
    thresholdDate.setDate(now.getDate() + daysThreshold);

    const itemsMap = new Map(db.items.map(i => [i.id, i.nameAr]));
    const whMap = new Map(db.warehouses.map(w => [w.id, w.nameAr]));

    const result: Array<Batch & { daysUntilExpiry: number; itemNameAr: string; warehouseNameAr: string }> = [];

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
   * Record a traceable inventory transaction and update perpetual batches
   */
  public static recordMovement(req: StockMovementRequest): { success: boolean; error?: string; transaction?: InventoryTransaction } {
    const db = erpDb.getSnapshot();
    const item = db.items.find(i => i.id === req.itemId);
    const warehouse = db.warehouses.find(w => w.id === req.warehouseId);

    if (!item) return { success: false, error: 'الصنف غير معرف بنظام الأصناف' };
    if (!warehouse) return { success: false, error: 'المستودع المحدد غير موجود' };

    // Check stock if issue/outgoing
    if (req.quantityOut > 0) {
      const currentStock = this.getItemBalance(req.itemId, req.warehouseId);
      if (currentStock < req.quantityOut && !req.allowNegative) {
        return {
          success: false,
          error: `الرصيد المتاح من الصنف (${item.nameAr}) في مستودع (${warehouse.nameAr}) هو ${currentStock} ولا يكفي لصرف كمية ${req.quantityOut}`
        };
      }
    }

    let createdTx: InventoryTransaction | undefined;

    erpDb.mutate((draft) => {
      const todayStr = new Date().toISOString().split('T')[0];

      // Update or create batch
      const batchNum = req.batchNumber || `BATCH-${todayStr.replace(/-/g, '')}-${Math.floor(Math.random() * 1000)}`;
      let existingBatch = draft.batches.find(b => 
        b.itemId === req.itemId && 
        b.warehouseId === req.warehouseId && 
        b.batchNumber === batchNum
      );

      if (req.quantityIn > 0) {
        if (existingBatch) {
          existingBatch.quantity += req.quantityIn;
          existingBatch.unitCost = req.unitCost;
        } else {
          draft.batches.push({
            id: `bat-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
            batchNumber: batchNum,
            itemId: req.itemId,
            warehouseId: req.warehouseId,
            productionDate: req.productionDate || todayStr,
            expiryDate: req.expiryDate || new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            quantity: req.quantityIn,
            unitCost: req.unitCost,
          });
        }
      }

      if (req.quantityOut > 0) {
        let remainingToDeduct = req.quantityOut;
        if (existingBatch && existingBatch.quantity >= remainingToDeduct) {
          existingBatch.quantity -= remainingToDeduct;
          remainingToDeduct = 0;
        } else {
          // Deduct from available batches FIFO
          const itemBatches = draft.batches.filter(b => b.itemId === req.itemId && b.warehouseId === req.warehouseId && b.quantity > 0);
          for (const b of itemBatches) {
            if (remainingToDeduct <= 0) break;
            const take = Math.min(b.quantity, remainingToDeduct);
            b.quantity -= take;
            remainingToDeduct -= take;
          }
        }
      }

      // Calculate balance after
      const remainingBatches = draft.batches.filter(b => b.itemId === req.itemId && b.warehouseId === req.warehouseId);
      const balanceAfter = remainingBatches.reduce((sum, b) => sum + b.quantity, 0);

      const qty = req.quantityIn > 0 ? req.quantityIn : req.quantityOut;
      const totalCost = qty * req.unitCost;

      createdTx = {
        id: `itx-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        date: todayStr,
        documentType: req.documentType,
        documentNumber: req.documentNumber,
        movementType: req.movementType,
        itemId: req.itemId,
        warehouseId: req.warehouseId,
        batchNumber: batchNum,
        quantityIn: req.quantityIn,
        quantityOut: req.quantityOut,
        balanceAfter,
        unitCost: req.unitCost,
        totalCost,
        notes: req.notes,
      };

      draft.inventoryTransactions.push(createdTx);
    });

    return { success: true, transaction: createdTx };
  }

  /**
   * Transfer inventory between warehouses with traceable movements
   */
  public static transferWarehouse(
    itemId: string,
    sourceWarehouseId: string,
    targetWarehouseId: string,
    quantity: number,
    unitCost: number,
    batchNumber?: string,
    notes?: string
  ): { success: boolean; error?: string } {
    if (sourceWarehouseId === targetWarehouseId) {
      return { success: false, error: 'لا يمكن التحويل لنفس المستودع' };
    }

    const currentStock = this.getItemBalance(itemId, sourceWarehouseId);
    if (currentStock < quantity) {
      return { success: false, error: `الكمية المتاحة في المستودع المحول منه (${currentStock}) غير كافية لتحويل (${quantity})` };
    }

    const docNum = `TRF-${Date.now()}`;

    // 1. Issue from source
    const outResult = this.recordMovement({
      itemId,
      warehouseId: sourceWarehouseId,
      movementType: 'warehouse_transfer',
      quantityIn: 0,
      quantityOut: quantity,
      unitCost,
      documentType: 'تحويل مخزني داخلي',
      documentNumber: docNum,
      batchNumber,
      notes: `تحويل إلى مستودع ${targetWarehouseId}: ${notes || ''}`,
    });

    if (!outResult.success) return outResult;

    // 2. Receive into target
    const inResult = this.recordMovement({
      itemId,
      warehouseId: targetWarehouseId,
      movementType: 'warehouse_transfer',
      quantityIn: quantity,
      quantityOut: 0,
      unitCost,
      documentType: 'تحويل مخزني داخلي',
      documentNumber: docNum,
      batchNumber,
      notes: `وارد من مستودع ${sourceWarehouseId}: ${notes || ''}`,
    });

    return inResult;
  }
}
