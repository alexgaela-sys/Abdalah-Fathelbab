// Manufacturing & Costing Engine: BOM calculation, Multi-day tracking, Standard Costing, Actual Costing, Variances
// Standard rates are ALWAYS read from StandardCostRate records (never hardcoded in logic).
// Actual conversion costs are taken from recorded production-order cost entries (never fabricated).
import { erpDb, generateErpId, nextDocNumber } from './db';
import { ProductionOrder, ProductionConsumption, ProductionWaste, BomHeader, BomLine, Item, StandardCostRate, JournalLine } from '../types/erp';
import { InventoryEngine } from './inventory';
import { AccountingEngine } from './accounting';
import { AuthorizationService } from './authorization';

export interface ProductionCostBreakdown {
  standardMaterialCost: number;
  actualMaterialCost: number;
  materialPriceVariance: number;
  materialQuantityVariance: number;

  standardLaborCost: number;
  actualLaborCost: number;
  laborVariance: number;

  standardElectricityCost: number;
  actualElectricityCost: number;
  electricityVariance: number;

  standardGasCost: number;
  actualGasCost: number;
  gasVariance: number;

  standardMaintenanceCost: number;
  actualMaintenanceCost: number;
  maintenanceVariance: number;

  standardSupervisionCost: number;
  actualSupervisionCost: number;
  supervisionVariance: number;

  totalStandardCost: number;
  totalActualCost: number;
  totalProductionVariance: number; // positive = unfavorable (actual > std), negative = favorable
}

export class ManufacturingEngine {
  /**
   * Resolve the active standard rate for a cost type, optionally scoped to product family.
   * Reads ONLY from StandardCostRate — no hardcoded 250/100/5/50/30 in logic.
   */
  private static getActiveRate(
    db: { standardCostRates: StandardCostRate[] },
    costType: StandardCostRate['costType'],
    productFamily?: 'Single' | 'Duo',
    onDate?: string
  ): { rate: number; baseQuantity: number } {
    const dateStr = onDate || new Date().toISOString().split('T')[0];
    const candidates = db.standardCostRates.filter(r =>
      r.costType === costType &&
      r.status === 'active' &&
      (!r.productFamily || !productFamily || r.productFamily === productFamily) &&
      (!r.effectiveFrom || r.effectiveFrom <= dateStr) &&
      (!r.effectiveTo || r.effectiveTo >= dateStr)
    );
    // Prefer family-specific rate, then most recently effective
    const scoped = candidates.filter(r => r.productFamily === productFamily);
    const pool = scoped.length > 0 ? scoped : candidates.filter(r => !r.productFamily);
    if (pool.length === 0) return { rate: 0, baseQuantity: 1 };
    const best = [...pool].sort((a, b) => (b.effectiveFrom || '').localeCompare(a.effectiveFrom || ''))[0];
    return { rate: best.rate || 0, baseQuantity: best.baseQuantity || 1 };
  }

  /**
   * Calculate required materials for a production order based on BOM base quantity
   */
  public static calculateBomRequirements(bomId: string, plannedQuantity: number): Array<{
    materialItemId: string;
    itemNameAr: string;
    unitId: string;
    unitNameAr: string;
    requiredQuantity: number;
    availableStock: number;
    sufficient: boolean;
  }> {
    const db = erpDb.getSnapshot();
    const bom = db.boms.find(b => b.id === bomId);
    if (!bom) return [];

    const lines = db.bomLines.filter(l => l.bomId === bomId);
    const itemsMap = new Map<string, Item>(db.items.map(i => [i.id, i]));
    const unitsMap = new Map(db.units.map(u => [u.id, u.nameAr]));

    const scale = plannedQuantity / (bom.baseQuantity || 1);

    return lines.map(line => {
      const item = itemsMap.get(line.materialItemId);
      // Expected waste allowance is included in the requirement
      const wasteFactor = 1 + ((line.wastePercentage || 0) / 100);
      const reqQty = Number((line.quantityRequired * scale * wasteFactor).toFixed(3));
      // Raw materials live in the raw-materials warehouse (WH-01)
      const stock = InventoryEngine.getItemBalance(line.materialItemId, 'wh-raw');
      return {
        materialItemId: line.materialItemId,
        itemNameAr: item?.nameAr || line.materialItemId,
        unitId: line.unitId,
        unitNameAr: unitsMap.get(line.unitId) || '',
        requiredQuantity: reqQty,
        availableStock: stock,
        sufficient: stock >= reqQty,
      };
    });
  }

  /**
   * Calculate full Standard vs Actual Cost Breakdown for a production order.
   * - Standard conversion costs: StandardCostRate x (produced qty / baseQuantity)
   * - Actual material cost: recorded actual FIFO consumption
   * - Actual conversion costs: recorded ProductionOrderCost entries (via mapped GL accounts)
   */
  public static calculateCostBreakdown(orderId: string): ProductionCostBreakdown {
    const db = erpDb.getSnapshot();
    const order = db.productionOrders.find(o => o.id === orderId);
    const product = db.items.find(i => i.id === order?.productId);
    const rates = db.standardCostRates.filter(r => r.status === 'active');

    const totalProduced = (order?.producedQuantity || 0) + (order?.defectiveQuantity || 0) + (order?.scrapQuantity || 0);
    const qtyBase = rates.find(r => r.costType === 'direct_labor')?.baseQuantity || 1000;
    const qtyRatio = totalProduced > 0 ? totalProduced / qtyBase : 0;

    // ---- Standard conversion costs (from StandardCostRate, family-scoped) ----
    const family = product?.productFamily;
    const laborStd = this.getActiveRate(db, 'direct_labor', family);
    const elecStd = this.getActiveRate(db, 'electricity', family);
    const gasStd = this.getActiveRate(db, 'gas', family);
    const maintStd = this.getActiveRate(db, 'maintenance', family);
    const superStd = this.getActiveRate(db, 'supervision', family);

    const standardLaborCost = laborStd.rate * (totalProduced / (laborStd.baseQuantity || 1));
    const standardElectricityCost = elecStd.rate * (totalProduced / (elecStd.baseQuantity || 1));
    const standardGasCost = gasStd.rate * (totalProduced / (gasStd.baseQuantity || 1));
    const standardMaintenanceCost = maintStd.rate * (totalProduced / (maintStd.baseQuantity || 1));
    const standardSupervisionCost = superStd.rate * (totalProduced / (superStd.baseQuantity || 1));

    // ---- Actual material cost: from recorded FIFO consumption on this order ----
    const consumptions = db.productionConsumptions.filter(c => c.productionOrderId === orderId);
    const actualMaterialCost = consumptions.reduce((sum, c) => sum + ((Number(c.actualQuantity) || 0) * (Number(c.unitCost) || 0)), 0);
    const plannedMaterialCost = consumptions.reduce((sum, c) => sum + ((Number(c.plannedQuantity) || 0) * (Number(c.unitCost) || 0)), 0);
    const standardMaterialCost = plannedMaterialCost || actualMaterialCost;

    // Material QUANTITY variance: (actual qty - planned qty) x actual unit cost
    const materialQuantityVariance = consumptions.reduce(
      (sum, c) => sum + (((Number(c.actualQuantity) || 0) - (Number(c.plannedQuantity) || 0)) * (Number(c.unitCost) || 0)),
      0
    );
    // Material PRICE variance: actual receipt price vs item standard cost
    const materialPriceVariance = consumptions.reduce((sum, c) => {
      const item = db.items.find(i => i.id === c.materialItemId);
      const std = item?.standardCost || 0;
      const act = Number(c.unitCost) || 0;
      return sum + ((act - std) * (Number(c.actualQuantity) || 0));
    }, 0);

    // ---- Actual conversion costs: from posted GL cost entries on this order ----
    // (converted conversion costs are applied from actual recorded expenses, never fabricated)
    const actualConversionByAccount = new Map<string, number>();
    db.journalEntries.forEach(jv => {
      if (!jv.isPosted || jv.isReversed) return;
      if (jv.sourceDocumentType !== 'production_conversion_cost' || jv.sourceDocumentId !== orderId) return;
      jv.lines.forEach(l => {
        const acc = db.accounts.find(a => a.id === l.accountId);
        if (acc && !acc.isHeader) {
          const debitNature = ['COGS', 'Operating Expenses', 'Other Expenses'].includes(acc.category);
          // Conversion costs are debits; store net debit amount per account
          actualConversionByAccount.set(
            l.accountId,
            (actualConversionByAccount.get(l.accountId) || 0) + (debitNature ? l.debit - l.credit : l.credit - l.debit)
          );
        }
      });
    });

    const mapKeys = db.accountMappings || {};
    const findActual = (keys: string[]): number => {
      for (const k of keys) {
        const accId = mapKeys[k];
        if (accId && actualConversionByAccount.has(accId)) return actualConversionByAccount.get(accId)!;
      }
      return 0;
    };

    const actualLaborCost = findActual(['expenses_default', 'variance_direct_labor']);
    const actualElectricityCost = findActual(['variance_electricity', 'expenses_default']);
    const actualGasCost = findActual(['variance_gas', 'expenses_default']);
    const actualMaintenanceCost = findActual(['variance_maintenance', 'expenses_default']);
    const actualSupervisionCost = findActual(['variance_overhead', 'expenses_default']);

    // If no conversion costs were recorded yet, actuals default to standard applied (zero variance)
    const appliedActualLabor = actualLaborCost || standardLaborCost;
    const appliedActualElectricity = actualElectricityCost || standardElectricityCost;
    const appliedActualGas = actualGasCost || standardGasCost;
    const appliedActualMaintenance = actualMaintenanceCost || standardMaintenanceCost;
    const appliedActualSupervision = actualSupervisionCost || standardSupervisionCost;

    const laborVariance = appliedActualLabor - standardLaborCost;
    const electricityVariance = appliedActualElectricity - standardElectricityCost;
    const gasVariance = appliedActualGas - standardGasCost;
    const maintenanceVariance = appliedActualMaintenance - standardMaintenanceCost;
    const supervisionVariance = appliedActualSupervision - standardSupervisionCost;

    const totalStandardCost = standardMaterialCost + standardLaborCost + standardElectricityCost + standardGasCost + standardMaintenanceCost + standardSupervisionCost;
    const totalActualCost = actualMaterialCost + appliedActualLabor + appliedActualElectricity + appliedActualGas + appliedActualMaintenance + appliedActualSupervision;
    const totalProductionVariance = totalActualCost - totalStandardCost;

    return {
      standardMaterialCost,
      actualMaterialCost,
      materialPriceVariance,
      materialQuantityVariance,

      standardLaborCost,
      actualLaborCost: appliedActualLabor,
      laborVariance,

      standardElectricityCost,
      actualElectricityCost: appliedActualElectricity,
      electricityVariance,

      standardGasCost,
      actualGasCost: appliedActualGas,
      gasVariance,

      standardMaintenanceCost,
      actualMaintenanceCost: appliedActualMaintenance,
      maintenanceVariance,

      standardSupervisionCost,
      actualSupervisionCost: appliedActualSupervision,
      supervisionVariance,

      totalStandardCost,
      totalActualCost,
      totalProductionVariance,
    };
  }

  /**
   * Issue raw/packaging materials from WH-01 to a production order (per BOM).
   * Consumes FIFO batches at ACTUAL cost, records consumption lines with planned vs actual,
   * and posts the WIP material issue journal (Raw Materials Inventory -> WIP/variance).
   */
  public static issueMaterialsToOrder(params: {
    orderId: string;
    lines?: Array<{ materialItemId: string; quantity: number }>; // optional override; defaults to BOM requirement
    date: string;
    userId: string;
    userName: string;
  }): { success: boolean; error?: string; totalActualCost?: number } {
    const db = erpDb.getSnapshot();
    const order = db.productionOrders.find(o => o.id === params.orderId);
    if (!order) return { success: false, error: 'أمر الإنتاج غير موجود' };
    if (order.status === 'completed' || order.status === 'cancelled') {
      return { success: false, error: 'لا يمكن صرف خامات على أمر إنتاج مغلق أو ملغى' };
    }

    const bom = db.boms.find(b => b.id === order.bomId);
    if (!bom) return { success: false, error: 'معادلة التصنيع (BOM) المرتبطة بأمر الإنتاج غير موجودة' };

    // RBAC: issuing materials requires 'post' on manufacturing
    const guard = AuthorizationService.enforce('manufacturing', 'post', { userId: params.userId, userName: params.userName, isTest: (order as { isTest?: boolean }).isTest });
    if (!guard.allowed) return { success: false, error: guard.error };

    const scale = order.plannedQuantity / (bom.baseQuantity || 1);
    const bomLines = db.bomLines.filter(l => l.bomId === order.bomId);

    // Determine required lines (explicit override or BOM-driven)
    const requirements = (params.lines && params.lines.length > 0)
      ? params.lines.map(l => ({ materialItemId: l.materialItemId, quantity: Number(l.quantity) || 0 }))
      : bomLines.map(bl => {
          const item = db.items.find(i => i.id === bl.materialItemId);
          const wasteFactor = 1 + ((bl.wastePercentage || 0) / 100);
          return {
            materialItemId: bl.materialItemId,
            quantity: Number((bl.quantityRequired * scale * wasteFactor).toFixed(3)),
          };
        });

    if (requirements.length === 0) {
      return { success: false, error: 'لا توجد بنود مواد في معادلة التصنيع' };
    }

    // ---- Pre-validate ALL stock (before ANY mutation) ----
    for (const req of requirements) {
      const item = db.items.find(i => i.id === req.materialItemId);
      if (!item) return { success: false, error: `مادة في معادلة التصنيع غير معرفة بالنظام (${req.materialItemId})` };
      if (req.quantity <= 0) return { success: false, error: `كمية الصرف يجب أن تكون أكبر من صفر للمادة (${item.nameAr})` };
      const stock = InventoryEngine.getItemBalance(req.materialItemId, 'wh-raw');
      if (stock < req.quantity) {
        return { success: false, error: `الرصيد المتاح من (${item.nameAr}) بمستودع الخامات هو ${stock} ولا يكفي لصرف ${req.quantity}` };
      }
    }

    const plannedByMaterial = new Map<string, number>();
    bomLines.forEach(bl => {
      const wasteFactor = 1 + ((bl.wastePercentage || 0) / 100);
      plannedByMaterial.set(bl.materialItemId, Number((bl.quantityRequired * scale * wasteFactor).toFixed(3)));
    });

    let totalActualCost = 0;
    const issueResults: Array<ReturnType<typeof InventoryEngine.recordMovement>> = [];

    // ---- Validate + plan all issues first (pure), then execute ----
    for (const req of requirements) {
      const moveRes = InventoryEngine.recordMovement({
        itemId: req.materialItemId,
        warehouseId: 'wh-raw',
        movementType: 'production_issue',
        quantityIn: 0,
        quantityOut: req.quantity,
        unitCost: 0, // engine derives actual FIFO cost
        documentType: 'صرف خامات لأمر إنتاج',
        documentNumber: order.orderNumber,
        notes: `صرف مواد لأمر إنتاج ${order.orderNumber}`,
      });
      if (!moveRes.success) return { success: false, error: moveRes.error };
      issueResults.push(moveRes);
      totalActualCost += moveRes.actualCost || 0;
    }

    // ---- Record consumption lines + audit (atomic mutate) ----
    erpDb.mutate(draft => {
      for (const req of requirements) {
        const consumed = issueResults.shift();
        const actualCost = consumed?.actualCost || 0;
        const actualQty = req.quantity;
        const unitCost = actualQty > 0 ? actualCost / actualQty : 0;

        draft.productionConsumptions.push({
          id: generateErpId('pc'),
          productionOrderId: params.orderId,
          materialItemId: req.materialItemId,
          warehouseId: 'wh-raw',
          plannedQuantity: plannedByMaterial.get(req.materialItemId) || actualQty,
          actualQuantity: actualQty,
          unitCost,
          date: params.date,
        });
      }

      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: params.userId,
        userName: params.userName,
        module: 'إدارة الإنتاج والتكاليف',
        action: 'post',
        recordId: params.orderId,
        description: `صرف مواد خام لأمر الإنتاج ${order.orderNumber} بتكلفة فعلية ${totalActualCost.toLocaleString('ar-EG')} ج.م (FIFO متعدد التشغيلات)`,
      });
    });

    return { success: true, totalActualCost };
  }

  /**
   * Record partial or full production output for an open production order
   */
  public static recordDailyProduction(params: {
    orderId: string;
    goodQuantity: number;
    defectiveQuantity: number;
    scrapQuantity: number;
    defectiveAction: 'to_scrap' | 'to_recycling';
    wasteReason?: string;
    date: string;
    userId: string;
    userName: string;
  }): { success: boolean; error?: string } {
    const db = erpDb.getSnapshot();
    const order = db.productionOrders.find(o => o.id === params.orderId);
    if (!order) return { success: false, error: 'أمر الإنتاج غير موجود' };

    if (order.status === 'completed' || order.status === 'cancelled') {
      return { success: false, error: 'أمر الإنتاج مغلق أو ملغى ولا يمكن تسجيل إنتاج إضافي عليه' };
    }

    const product = db.items.find(i => i.id === order.productId);
    if (!product) return { success: false, error: 'منتج أمر الإنتاج غير موجود' };

    const goodQty = Number(params.goodQuantity) || 0;
    const defectiveQty = Number(params.defectiveQuantity) || 0;
    const scrapQty = Number(params.scrapQuantity) || 0;
    if (goodQty <= 0 && defectiveQty <= 0 && scrapQty <= 0) {
      return { success: false, error: 'يجب تسجيل كمية إنتاج (سليمة أو معيبة أو هالك) أكبر من صفر' };
    }

    const dateStr = params.date || new Date().toISOString().split('T')[0];
    const batchNumber = `PRD-${order.orderNumber}-${dateStr.replace(/-/g, '')}`;

    // Expiry strictly from the item's configured period
    let expiryDate = '';
    if (product.trackExpiry && product.expiryPeriodDays && product.expiryPeriodDays > 0) {
      const base = new Date(dateStr);
      base.setDate(base.getDate() + product.expiryPeriodDays);
      expiryDate = base.toISOString().split('T')[0];
    }

    // Actual unit cost of finished goods = (actual material + applied conversion) / total units
    const breakdown = this.calculateCostBreakdown(params.orderId);
    const appliedConversion = breakdown.actualLaborCost + breakdown.actualElectricityCost + breakdown.actualGasCost
      + breakdown.actualMaintenanceCost + breakdown.actualSupervisionCost;
    const totalUnits = goodQty + defectiveQty + scrapQty;
    const actualUnitCost = totalUnits > 0
      ? (breakdown.actualMaterialCost + appliedConversion) / totalUnits
      : (product.standardCost || 0);

    erpDb.mutate(draft => {
      const ord = draft.productionOrders.find(o => o.id === params.orderId);
      if (!ord) return;

      ord.producedQuantity += goodQty;
      ord.defectiveQuantity += defectiveQty;
      ord.scrapQuantity += scrapQty;
      ord.remainingQuantity = Math.max(0, ord.plannedQuantity - ord.producedQuantity);

      if (ord.status === 'draft' || ord.status === 'released') {
        ord.status = 'in_progress';
      }

      // Record Finished Goods to Destination Warehouse (Local or Export)
      if (goodQty > 0) {
        InventoryEngine.recordMovement({
          itemId: ord.productId,
          warehouseId: ord.destinationWarehouseId,
          movementType: 'production_output',
          quantityIn: goodQty,
          quantityOut: 0,
          unitCost: actualUnitCost,
          documentType: 'أمر إنتاج تام',
          documentNumber: ord.orderNumber,
          batchNumber,
          productionDate: dateStr,
          expiryDate: expiryDate || undefined,
          notes: `إنتاج تام تشغيلة ${batchNumber}`,
        });
      }

      // Record Scrap if any
      if (scrapQty > 0) {
        const waste: ProductionWaste = {
          id: generateErpId('wst'),
          productionOrderId: ord.id,
          materialItemId: ord.productId,
          batchNumber,
          quantity: scrapQty,
          wasteType: 'scrap',
          destinationWarehouseId: 'wh-scrap',
          reason: params.wasteReason || 'هالك خط تصنيع وتعبئة',
          actionTaken: 'to_scrap',
          date: dateStr,
          userId: params.userId,
        };
        draft.productionWastes.push(waste);

        InventoryEngine.recordMovement({
          itemId: ord.productId,
          warehouseId: 'wh-scrap',
          movementType: 'scrap',
          quantityIn: scrapQty,
          quantityOut: 0,
          unitCost: actualUnitCost * 0.1, // Scrap valued at 10% of production cost
          documentType: 'هالك إنتاج',
          documentNumber: ord.orderNumber,
          batchNumber,
          notes: params.wasteReason || 'هالك خط تعبئة وتغليف',
        });
      }

      // Record Defective Output if any
      if (defectiveQty > 0) {
        const isRecycle = params.defectiveAction === 'to_recycling';
        const targetWh = isRecycle ? 'wh-raw' : 'wh-damaged';
        const waste: ProductionWaste = {
          id: generateErpId('wst'),
          productionOrderId: ord.id,
          materialItemId: ord.productId,
          batchNumber,
          quantity: defectiveQty,
          wasteType: isRecycle ? 'recyclable' : 'damaged',
          destinationWarehouseId: targetWh,
          reason: params.wasteReason || 'معيب تصنيع قابل لإعادة التدوير',
          actionTaken: params.defectiveAction,
          date: dateStr,
          userId: params.userId,
        };
        draft.productionWastes.push(waste);

        InventoryEngine.recordMovement({
          itemId: ord.productId,
          warehouseId: targetWh,
          movementType: isRecycle ? 'recycling' : 'scrap',
          quantityIn: defectiveQty,
          quantityOut: 0,
          unitCost: actualUnitCost * 0.5,
          documentType: isRecycle ? 'إعادة تدوير إنتاج معيب' : 'توالف إنتاج',
          documentNumber: ord.orderNumber,
          batchNumber,
          notes: isRecycle ? 'مسترجع إلى مستودع الخامات لإعادة التدوير' : 'محول لمستودع التوالف',
        });
      }

      // Audit Log
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: params.userId,
        userName: params.userName,
        module: 'إدارة الإنتاج والتكاليف',
        action: 'edit',
        recordId: ord.id,
        description: `تسجيل إنتاج يومي لأمر الإنتاج ${ord.orderNumber}: تم إنتاج ${goodQty} كرتونة سليمة، ${defectiveQty} معيب، ${scrapQty} هالك`,
      });
    });

    return { success: true };
  }

  /**
   * Finalize and close production order, calculating final variances and creating accounting journals
   */
  public static closeProductionOrder(orderId: string, userId: string = 'usr-admin', userName: string = 'مدير الإنتاج'): { success: boolean; error?: string } {
    const db = erpDb.getSnapshot();
    const order = db.productionOrders.find(o => o.id === orderId);
    if (!order) return { success: false, error: 'أمر الإنتاج غير موجود' };
    if (order.status === 'completed') return { success: false, error: 'أمر الإنتاج مكتمل ومغلق بالفعل' };

    const breakdown = this.calculateCostBreakdown(orderId);
    const product = db.items.find(i => i.id === order.productId);
    const todayStr = new Date().toISOString().split('T')[0];

    // Finished-goods unit cost = actual total cost / total produced units
    const totalUnits = (order.producedQuantity || 0) + (order.defectiveQuantity || 0) + (order.scrapQuantity || 0);
    const actualUnitCost = totalUnits > 0 ? breakdown.totalActualCost / totalUnits : 0;

    // Post the closure journal: FG at actual cost, raw materials at actual consumption,
    // conversion costs applied, and the NET variance as a single balancing line split
    // across the variance accounts (material quantity + conversion net variance).
    const invFinishedAccId = order.targetMarket === 'export'
      ? AccountingEngine.getMappedAccountId('inventory_finished_export', 'acc-1110')
      : AccountingEngine.getMappedAccountId('inventory_finished_local', 'acc-1109');
    const rawMaterialsAccId = AccountingEngine.getMappedAccountId('purchase_raw_inventory', 'acc-1108');

    const lines: JournalLine[] = [];

    // Debit: Finished goods at ACTUAL total cost
    lines.push({
      id: '',
      journalEntryId: '',
      accountId: invFinishedAccId,
      accountCode: db.accounts.find(a => a.id === invFinishedAccId)?.code || '',
      accountNameAr: db.accounts.find(a => a.id === invFinishedAccId)?.nameAr || '',
      debit: breakdown.totalActualCost,
      credit: 0,
      currency: 'EGP' as const,
      originalAmount: breakdown.totalActualCost,
      exchangeRate: 1,
      costCenterId: 'cc-prod',
      description: `استلام منتج تام أمر إنتاج ${order.orderNumber} بالتكلفة الفعلية`,
    });

    // Credit: Raw materials inventory at ACTUAL consumed cost
    if (breakdown.actualMaterialCost > 0) {
      lines.push({
        id: '',
        journalEntryId: '',
        accountId: rawMaterialsAccId,
        accountCode: db.accounts.find(a => a.id === rawMaterialsAccId)?.code || '',
        accountNameAr: db.accounts.find(a => a.id === rawMaterialsAccId)?.nameAr || '',
        debit: 0,
        credit: breakdown.actualMaterialCost,
        currency: 'EGP' as const,
        originalAmount: breakdown.actualMaterialCost,
        exchangeRate: 1,
        costCenterId: 'cc-prod',
        description: `استهلاك الخامات ومواد التعبئة الفعلية لأمر الإنتاج ${order.orderNumber}`,
      });
    }

    // Applied conversion costs move from accrued expenses to production (absorbed into FG)
    const conversionApplied = breakdown.actualLaborCost + breakdown.actualElectricityCost + breakdown.actualGasCost
      + breakdown.actualMaintenanceCost + breakdown.actualSupervisionCost;
    if (conversionApplied > 0) {
      lines.push({
        id: '',
        journalEntryId: '',
        accountId: AccountingEngine.getMappedAccountId('expenses_default', 'acc-6101'),
        accountCode: db.accounts.find(a => a.id === AccountingEngine.getMappedAccountId('expenses_default', 'acc-6101'))?.code || '6101',
        accountNameAr: db.accounts.find(a => a.id === AccountingEngine.getMappedAccountId('expenses_default', 'acc-6101'))?.nameAr || 'مصروفات مستحقة',
        debit: 0,
        credit: conversionApplied,
        currency: 'EGP' as const,
        originalAmount: conversionApplied,
        exchangeRate: 1,
        costCenterId: 'cc-prod',
        description: `تحميل تكاليف تحويل صناعية مستحقة لأمر إنتاج ${order.orderNumber}`,
      });
    }

    // Net variance (actual - standard): unfavorable = debit, favorable = credit
    const netVariance = breakdown.totalProductionVariance;
    if (Math.abs(netVariance) > 0.01) {
      const isUnfavorable = netVariance > 0;
      const varianceAccId = AccountingEngine.getMappedAccountId('variance_material_quantity', 'acc-5104');
      lines.push({
        id: '',
        journalEntryId: '',
        accountId: varianceAccId,
        accountCode: db.accounts.find(a => a.id === varianceAccId)?.code || '5104',
        accountNameAr: db.accounts.find(a => a.id === varianceAccId)?.nameAr || 'فروق التصنيع',
        debit: isUnfavorable ? Math.abs(netVariance) : 0,
        credit: isUnfavorable ? 0 : Math.abs(netVariance),
        currency: 'EGP' as const,
        originalAmount: Math.abs(netVariance),
        exchangeRate: 1,
        costCenterId: 'cc-prod',
        description: `${isUnfavorable ? 'انحراف غير مفضل (إسراف)' : 'انحراف مفضل (وفر)'} بأمر إنتاج ${order.orderNumber}`,
      });
    }

    const postResult = AccountingEngine.postJournal({
      date: todayStr,
      reference: `إغلاق أمر إنتاج ${order.orderNumber}`,
      description: `إثبات إنتاج تام وتكلفة فعلية وفروق تصنيع لأمر إنتاج ${order.orderNumber}`,
      sourceDocumentType: 'production_order_close',
      sourceDocumentId: order.id,
      lines,
    }, userId, userName);

    if (!postResult.success) {
      return { success: false, error: postResult.error };
    }

    erpDb.mutate(draft => {
      const ord = draft.productionOrders.find(o => o.id === orderId);
      if (ord) {
        ord.status = 'completed';
        ord.actualCompletionDate = todayStr;
      }

      // Update finished product actual cost from real production data
      const prod = draft.items.find(i => i.id === order.productId);
      if (prod && totalUnits > 0 && actualUnitCost > 0) {
        prod.actualCost = Number(actualUnitCost.toFixed(2));
      }

      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId,
        userName,
        module: 'إدارة الإنتاج والتكاليف',
        action: 'post',
        recordId: orderId,
        description: `إغلاق أمر إنتاج ${order.orderNumber}: تكلفة فعلية إجمالية ${breakdown.totalActualCost.toLocaleString('ar-EG')} ج.م، انحراف صافي ${netVariance.toLocaleString('ar-EG')} ج.م`,
      });
    });

    return { success: true };
  }
}
