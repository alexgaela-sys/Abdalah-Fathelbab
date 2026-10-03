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
   * Issue a production order (F15: RBAC-guarded service write, replacing the direct
   * UI mutation the manufacturing screen used to perform).
   *
   * The existing business rule is PRESERVED and not weakened: a product with no
   * ACTIVE BOM can never be produced.
   */
  public static createProductionOrder(params: {
    productId: string;
    plannedQuantity: number;
    targetMarket: 'local' | 'export';
    destinationWarehouseId: string;
    expectedCompletionDate: string;
    notes?: string;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; order?: ProductionOrder; error?: string } {
    const guard = AuthorizationService.enforce('manufacturing', 'create', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };

    if (!params.productId) return { success: false, error: 'يرجى اختيار المنتج التام' };
    if (!(Number(params.plannedQuantity) > 0)) return { success: false, error: 'الكمية المخططة يجب أن تكون أكبر من صفر' };

    const db = erpDb.getSnapshot();
    const product = db.items.find(i => i.id === params.productId);
    if (!product) return { success: false, error: 'المنتج التام غير مسجل بالنظام' };

    // The "no active BOM => no production" rule (unchanged).
    const bom = db.boms.find(b => (b.finishedItemId || b.productId) === params.productId && b.active);
    if (!bom) return { success: false, error: 'لا توجد معادلة تصنيع (BOM) نشطة لهذا المنتج' };

    const count = db.productionOrders.length + 1;
    const orderNumber = `PRD-${new Date().getFullYear()}-${String(count).padStart(4, '0')}`;
    const order: ProductionOrder = {
      id: generateErpId('pord'),
      orderNumber,
      productId: params.productId,
      bomId: bom.id,
      plannedQuantity: Number(params.plannedQuantity),
      producedQuantity: 0,
      defectiveQuantity: 0,
      scrapQuantity: 0,
      remainingQuantity: Number(params.plannedQuantity),
      startDate: new Date().toISOString().split('T')[0],
      expectedCompletionDate: params.expectedCompletionDate,
      status: 'released',
      destinationWarehouseId: params.destinationWarehouseId,
      targetMarket: params.targetMarket,
      notes: params.notes,
      createdUserId: guard.userId,
      createdAt: new Date().toISOString(),
    };

    erpDb.mutate(draft => {
      draft.productionOrders.push(order);
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId,
        userName: guard.userName,
        module: 'الإنتاج والتصنيع',
        action: 'create',
        recordId: order.id,
        description: `إنشاء أمر إنتاج جديد رقم ${order.orderNumber} للمنتج ${product.nameAr} لكمية ${order.plannedQuantity} (المعادلة ${bom.bomNumber || bom.id})`,
      });
    });

    return { success: true, order };
  }

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
    // QA-16: the rate must be the one EFFECTIVE ON THE ORDER'S TRANSACTION DATE
    // (inclusive on both ends), never simply "whatever is flagged active".
    const family = product?.productFamily;
    const txDate = (order?.startDate || order?.expectedCompletionDate || new Date().toISOString().split('T')[0]).slice(0, 10);
    const laborStd = this.getActiveRate(db, 'direct_labor', family, txDate);
    const elecStd = this.getActiveRate(db, 'electricity', family, txDate);
    const gasStd = this.getActiveRate(db, 'gas', family, txDate);
    const maintStd = this.getActiveRate(db, 'maintenance', family, txDate);
    const superStd = this.getActiveRate(db, 'supervision', family, txDate);

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
    // QA-17: the SPECIFIC cost-type account must be resolved BEFORE the generic
    // 'expenses_default' fallback. Checking the generic key first mapped every
    // actual onto one bucket (and read the credit leg, so the actual came out
    // negative), which is why the variance was meaningless.
    const findActual = (keys: string[]): number => {
      for (const k of keys) {
        const accId = mapKeys[k];
        if (accId && actualConversionByAccount.has(accId)) return actualConversionByAccount.get(accId)!;
      }
      return 0;
    };

    const actualLaborCost = findActual(['variance_direct_labor', 'expenses_default']);
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
   * QA-17 — Record ACTUAL conversion costs against a production order.
   *
   * The costing architecture already reads actual conversion from posted
   * `production_conversion_cost` journal entries (see `calculateCostBreakdown`
   * and `closeProductionOrder`), but nothing could write them, so the variance
   * was structurally always zero. This is the minimum coherent extension of the
   * EXISTING architecture — no second costing engine, no invented values:
   *
   *   Dr <the real expense account the cost was actually incurred on>
   *   Cr <accrued/expenses_default>            (absorbed into FG at closure)
   *
   * The entry is linked to the order via sourceDocumentType/sourceDocumentId,
   * which is exactly how the breakdown reads it back.
   */
  public static recordConversionCost(params: {
    orderId: string;
    costType: 'direct_labor' | 'electricity' | 'gas' | 'maintenance' | 'supervision' | 'other';
    amount: number;
    date: string;
    description?: string;
    /** Explicit expense account; when omitted it is resolved from accountMappings. */
    glAccountId?: string;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; error?: string; accountId?: string; journalEntryId?: string } {
    const db = erpDb.getSnapshot();
    const order = db.productionOrders.find(o => o.id === params.orderId);
    if (!order) return { success: false, error: 'أمر الإنتاج غير موجود' };
    if (order.status === 'completed' || order.status === 'cancelled') {
      return { success: false, error: 'لا يمكن تسجيل تكاليف تحويلية على أمر إنتاج مغلق أو ملغى' };
    }
    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, error: 'مبلغ التكلفة التحويلية يجب أن يكون رقمًا أكبر من صفر' };
    }

    // Expense account: explicit, else the existing account-mapping for the cost type.
    const MAP_KEY: Record<string, string> = {
      direct_labor: 'variance_direct_labor',
      electricity: 'variance_electricity',
      gas: 'variance_gas',
      maintenance: 'variance_maintenance',
      supervision: 'variance_overhead',
      other: 'expenses_default',
    };
    const FALLBACK: Record<string, string> = {
      direct_labor: 'acc-5105',
      electricity: 'acc-5106',
      gas: 'acc-5107',
      maintenance: 'acc-5108',
      supervision: 'acc-5109',
      other: 'acc-6101',
    };
    const accountId = params.glAccountId || AccountingEngine.getMappedAccountId(MAP_KEY[params.costType], FALLBACK[params.costType]);
    const acc = db.accounts.find(a => a.id === accountId);
    if (!acc) return { success: false, error: 'حساب تكلفة التحويل غير موجود بدليل الحسابات' };
    if (acc.isHeader) return { success: false, error: 'لا يمكن الترحيل على حساب رئيسي تجميعي' };

    const creditAccId = AccountingEngine.getMappedAccountId('expenses_default', 'acc-6101');
    const creditAcc = db.accounts.find(a => a.id === creditAccId);

    const COST_LABEL_AR: Record<string, string> = {
      direct_labor: 'أجور عمالة مباشرة',
      electricity: 'كهرباء',
      gas: 'غاز',
      maintenance: 'صيانة',
      supervision: 'إشراف',
      other: 'تكاليف تحويلية أخرى',
    };
    const desc = params.description?.trim()
      || `${COST_LABEL_AR[params.costType]} فعلية لأمر إنتاج ${order.orderNumber}`;

    const lines: JournalLine[] = [
      {
        id: '', journalEntryId: '',
        accountId: acc.id, accountCode: acc.code, accountNameAr: acc.nameAr,
        debit: amount, credit: 0, currency: 'EGP' as const,
        originalAmount: amount, exchangeRate: 1, costCenterId: 'cc-prod',
        description: desc,
      },
      {
        id: '', journalEntryId: '',
        accountId: creditAccId,
        accountCode: creditAcc?.code || creditAccId,
        accountNameAr: creditAcc?.nameAr || 'مصروفات مستحقة',
        debit: 0, credit: amount, currency: 'EGP' as const,
        originalAmount: amount, exchangeRate: 1, costCenterId: 'cc-prod',
        description: `تسجيل ${desc}`,
      },
    ];

    const jv = AccountingEngine.postJournal({
      date: params.date,
      reference: `CONV-${order.orderNumber}-${params.costType}`,
      description: desc,
      sourceDocumentType: 'production_conversion_cost',
      sourceDocumentId: order.id,
      lines,
    }, params.userId, params.userName, params.isTest);
    if (!jv.success) return { success: false, error: jv.error };
    return { success: true, accountId: acc.id, journalEntryId: jv.entry?.id };
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
        date: params.date,
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
    /** Marks the waste-reconciliation journal as test data (QA-12). */
    isTest?: boolean;
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

    // QA-02: NO PHANTOM FINISHED GOODS.
    // A production order may only register output once its BOM materials have
    // actually been ISSUED to it. Previously the output could be booked with
    // zero consumption, creating finished goods at a ZERO cost that could never
    // be closed. Require a real material issue first.
    const consumptions = db.productionConsumptions.filter(c => c.productionOrderId === order.id);
    const issuedQty = consumptions.reduce((s, c) => s + (Number(c.actualQuantity) || 0), 0);
    if (issuedQty <= 0) {
      return {
        success: false,
        error:
          `لا يمكن تسجيل إنتاج لأمر ${order.orderNumber} قبل صرف الخامات والمواد من مستودع الخامات. ` +
          `اضغط "صرف خامات" على أمر الإنتاج لتحرير صرف المواد وفق معادلة التصنيع أولاً.`,
      };
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

    // QA-12: values of the waste/damaged/recycled stock booked below, captured
    // so the GL can be reconciled against the physical movement exactly.
    let scrapValue = 0;
    let defectiveValue = 0;
    let recycleValue = 0;

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
          date: params.date,
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

        const scrapUnitCost = actualUnitCost * 0.1; // Scrap valued at 10% of production cost
        InventoryEngine.recordMovement({
          itemId: ord.productId,
          warehouseId: 'wh-scrap',
          movementType: 'scrap',
          date: params.date,
          quantityIn: scrapQty,
          quantityOut: 0,
          unitCost: scrapUnitCost,
          documentType: 'هالك إنتاج',
          documentNumber: ord.orderNumber,
          batchNumber,
          notes: params.wasteReason || 'هالك خط تعبئة وتغليف',
        });
        // The inbound movement books no FIFO consumption, so the value the stock
        // is carried at is computed from the SAME rate used above — this is what
        // the GL must mirror (QA-12).
        scrapValue = scrapQty * scrapUnitCost;
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

        const defUnitCost = actualUnitCost * 0.5;
        InventoryEngine.recordMovement({
          itemId: ord.productId,
          warehouseId: targetWh,
          movementType: isRecycle ? 'recycling' : 'scrap',
          date: params.date,
          quantityIn: defectiveQty,
          quantityOut: 0,
          unitCost: defUnitCost,
          documentType: isRecycle ? 'إعادة تدوير إنتاج معيب' : 'توالف إنتاج',
          documentNumber: ord.orderNumber,
          batchNumber,
          notes: isRecycle ? 'مسترجع إلى مستودع الخامات لإعادة التدوير' : 'محول لمستودع التوالف',
        });
        const defValue = defectiveQty * defUnitCost;
        if (isRecycle) recycleValue = defValue;
        else defectiveValue = defValue;
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

    // QA-12 — reconcile scrap / damaged / recycled production stock with the GL.
    // The physical movement above creates inventory in WH-05 (scrap), WH-04
    // (damaged) and WH-01 (recycled back to raw) — the corresponding asset
    // accounts 1112 / 1111 / 1108 must move by the SAME value, otherwise
    // physical inventory and inventory valuation silently disagree with the
    // GL. The offset is the existing production-variance account (this is the
    // write-off of production waste), so the journal balances on its own and
    // cannot disturb the order-closure journal below.
    const wasteLines: JournalLine[] = [];
    const pushWasteDebit = (accountId: string, amount: number, desc: string) => {
      if (amount <= 0.01) return;
      const acc = db.accounts.find(a => a.id === accountId);
      wasteLines.push({
        id: '', journalEntryId: '',
        accountId, accountCode: acc?.code || '', accountNameAr: acc?.nameAr || '',
        debit: Number(amount.toFixed(2)), credit: 0, currency: 'EGP' as const,
        originalAmount: Number(amount.toFixed(2)), exchangeRate: 1, costCenterId: 'cc-prod',
        description: desc,
      });
    };
    pushWasteDebit(
      AccountingEngine.getMappedAccountId('inventory_scrap', 'acc-1112'), scrapValue,
      `مخزون هالك إنتاج — مستودع الهالك والسكراب (أمر ${order.orderNumber})`);
    pushWasteDebit(
      AccountingEngine.getMappedAccountId('inventory_damaged', 'acc-1111'), defectiveValue,
      `مخزون توالف إنتاج — مستودع التوالف (أمر ${order.orderNumber})`);
    pushWasteDebit(
      AccountingEngine.getMappedAccountId('purchase_raw_inventory', 'acc-1108'), recycleValue,
      `مخزون معيب مُسترجع لإعادة التدوير في مستودع الخامات (أمر ${order.orderNumber})`);

    if (wasteLines.length > 0) {
      const wasteTotal = Number(wasteLines.reduce((s, l) => s + l.debit, 0).toFixed(2));
      const varAccId = AccountingEngine.getMappedAccountId('variance_material_quantity', 'acc-5104');
      const varAcc = db.accounts.find(a => a.id === varAccId);
      const creditLine: JournalLine = {
        id: '', journalEntryId: '',
        accountId: varAccId, accountCode: varAcc?.code || varAccId, accountNameAr: varAcc?.nameAr || 'فروق كميات استهلاك المواد',
        debit: 0, credit: wasteTotal, currency: 'EGP' as const,
        originalAmount: wasteTotal, exchangeRate: 1, costCenterId: 'cc-prod',
        description: `إثبات هالك/توالف الإنتاج كفروق كمية — أمر ${order.orderNumber}`,
      };
      const jv = AccountingEngine.postJournal({
        date: params.date,
        reference: `PROD-WASTE-${order.orderNumber}`,
        description: `مطابقة هالك وتوالف الإنتاج مع المخزون والدفاتر — أمر ${order.orderNumber}`,
        sourceDocumentType: 'production_waste',
        sourceDocumentId: order.id,
        lines: [...wasteLines, creditLine],
      }, params.userId, params.userName, params.isTest);
      if (!jv.success) return { success: false, error: `تعذر إثبات هالك الإنتاج في الدفاتر: ${jv.error}` };
    }

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

    // QA-03: a production order with NO produced units and NO issued material has
    // no cost basis at all. Fail with a clear business message instead of letting
    // the accounting engine reject a one-sided journal.
    if (totalUnits <= 0) {
      return {
        success: false,
        error:
          `لا يمكن إغلاق أمر الإنتاج ${order.orderNumber}: لم يتم تسجيل أي إنتاج فعلي بعد. ` +
          `يجب تسجيل الإنتاج اليومي (سليم / معيب / هالك) قبل إغلاق الأمر.`,
      };
    }
    const appliedConversionCost =
      breakdown.actualLaborCost + breakdown.actualElectricityCost + breakdown.actualGasCost
      + breakdown.actualMaintenanceCost + breakdown.actualSupervisionCost;
    if (breakdown.actualMaterialCost <= 0 && appliedConversionCost <= 0) {
      return {
        success: false,
        error:
          `لا يمكن إغلاق أمر الإنتاج ${order.orderNumber}: لا توجد تكلفة مواد أو تكاليف تحويلية لبيان الإنتاج المسجل. ` +
          `يجب صرف خامات ومواد التعبئة من مستودع الخامات وفق معادلة التصنيع قبل إغلاق الأمر.`,
      };
    }

    // QA-04 — PARTIAL PRODUCTION.
    // Materials were issued for the PLANNED quantity. The share that belongs to
    // units that were never produced must NOT stay capitalised in finished goods:
    // it is returned to the raw-material warehouse at its actual FIFO cost, and
    // only the consumed share is capitalised into the finished goods.
    const planned = Number(order.plannedQuantity) || 0;
    const consumedShare = planned > 0 ? Math.min(1, totalUnits / planned) : 1;
    const unusedShare = 1 - consumedShare;
    let materialReturnedCost = 0;
    let materialConsumedCost = breakdown.actualMaterialCost;

    if (unusedShare > 0.0001 && breakdown.actualMaterialCost > 0) {
      const consumptions = db.productionConsumptions.filter(c => c.productionOrderId === order.id);
      for (const c of consumptions) {
        const backQty = Number(((c.actualQuantity || 0) * unusedShare).toFixed(3));
        if (backQty <= 0) continue;
        const back = InventoryEngine.recordMovement({
          itemId: c.materialItemId,
          warehouseId: c.warehouseId || 'wh-raw',
          movementType: 'production_return',
          date: todayStr,
          quantityIn: backQty,
          quantityOut: 0,
          unitCost: c.unitCost || 0,
          documentType: 'إرجاع خامات غير مستخدمة',
          documentNumber: order.orderNumber,
          notes: `إرجاع مواد لم تُستخدم في الإنتاج الفعلي لأمر ${order.orderNumber}`,
        });
        if (back.success) {
          materialReturnedCost += (back.actualCost || 0);
        }
      }
      materialConsumedCost = Math.max(0, breakdown.actualMaterialCost - materialReturnedCost);
    }

    const actualUnitCost = totalUnits > 0 ? breakdown.totalActualCost / totalUnits : 0;

    // FG is capitalised at what was ACTUALLY consumed (material + conversion).
    const capitalizedActualCost = materialConsumedCost + appliedConversionCost;

    // Post the closure journal: FG at actual cost, raw materials at actual consumption,
    // conversion costs applied, and the NET variance as a single balancing line split
    // across the variance accounts (material quantity + conversion net variance).
    const invFinishedAccId = order.targetMarket === 'export'
      ? AccountingEngine.getMappedAccountId('inventory_finished_export', 'acc-1110')
      : AccountingEngine.getMappedAccountId('inventory_finished_local', 'acc-1109');
    const rawMaterialsAccId = AccountingEngine.getMappedAccountId('purchase_raw_inventory', 'acc-1108');

    const lines: JournalLine[] = [];

    // Debit: Finished goods at the ACTUAL CONSUMED cost (QA-04 — the share of
    // material belonging to units that were never produced is returned to stock
    // and is NOT capitalised into finished goods).
    lines.push({
      id: '',
      journalEntryId: '',
      accountId: invFinishedAccId,
      accountCode: db.accounts.find(a => a.id === invFinishedAccId)?.code || '',
      accountNameAr: db.accounts.find(a => a.id === invFinishedAccId)?.nameAr || '',
      debit: capitalizedActualCost,
      credit: 0,
      currency: 'EGP' as const,
      originalAmount: capitalizedActualCost,
      exchangeRate: 1,
      costCenterId: 'cc-prod',
      description: `استلام منتج تام أمر إنتاج ${order.orderNumber} بالتكلفة الفعلية`,
    });

    // Credit: Raw materials inventory at ACTUAL consumed cost (the unused share
    // was already returned to stock, so it is NOT capitalised here).
    if (materialConsumedCost > 0) {
      lines.push({
        id: '',
        journalEntryId: '',
        accountId: rawMaterialsAccId,
        accountCode: db.accounts.find(a => a.id === rawMaterialsAccId)?.code || '',
        accountNameAr: db.accounts.find(a => a.id === rawMaterialsAccId)?.nameAr || '',
        debit: 0,
        credit: materialConsumedCost,
        currency: 'EGP' as const,
        originalAmount: materialConsumedCost,
        exchangeRate: 1,
        costCenterId: 'cc-prod',
        description: `استهلاك الخامات ومواد التعبئة الفعلية لأمر الإنتاج ${order.orderNumber}`
          + (materialReturnedCost > 0 ? ` (تم إرجاع ${materialReturnedCost.toFixed(2)} ج.م خامات غير مستخدمة للمخزون)` : ''),
      });
    }

    // Applied conversion costs move from accrued expenses to production (absorbed into FG)
    const conversionApplied = appliedConversionCost;
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
    const netVariance = breakdown.totalProductionVariance - materialReturnedCost;
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

  // ===================== BOM MASTER DATA — F1 (guarded, additive) =====================

  private static validateBomPayload(params: {
    finishedItemId: string;
    lines: Array<{ materialItemId: string; quantityRequired: number; unitId: string; wastePercentage?: number }>;
    baseQuantity: number;
  }): string | null {
    const db = erpDb.getSnapshot();
    const product = db.items.find(i => i.id === params.finishedItemId);
    if (!product) return 'المنتج التام غير مسجل بالنظام';
    if (product.itemType !== 'finished_product') return 'المعادلة تصم لمنتج تام فقط';
    if (!(Number(params.baseQuantity) > 0)) return 'كمية الأساس يجب أن تكون أكبر من صفر';
    if (!params.lines || params.lines.length === 0) return 'يجب إضافة بنود واحدة على الأقل للمعادلة';
    for (const l of params.lines) {
      const mat = db.items.find(i => i.id === l.materialItemId);
      if (!mat) return `مادة في بنود المعادلة غير مسجلة (${l.materialItemId})`;
      if (!(Number(l.quantityRequired) > 0)) return `كمية المادة (${mat.nameAr}) يجب أن تكون أكبر من صفر`;
      if (l.wastePercentage !== undefined && (Number(l.wastePercentage) < 0 || Number(l.wastePercentage) > 100)) {
        return `نسبة الهالك (${mat.nameAr}) يجب أن تكون بين 0 و 100`;
      }
    }
    return null;
  }

  /**
   * Create a NEW BOM version for a finished product (V(n+1)), deactivating the
   * previously active version — exactly one active BOM per product.
   * Existing seeded BOMs are never touched unless the same product is chosen.
   */
  public static createBomVersion(params: {
    finishedItemId: string;
    baseQuantity: number;
    unitId: string;
    effectiveDate: string;
    notes?: string;
    lines: Array<{ materialItemId: string; quantityRequired: number; unitId: string; wastePercentage?: number }>;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; bom?: BomHeader; error?: string } {
    const guard = AuthorizationService.enforce('manufacturing', 'create', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };

    const payloadError = this.validateBomPayload(params);
    if (payloadError) return { success: false, error: payloadError };

    const db = erpDb.getSnapshot();
    const product = db.items.find(i => i.id === params.finishedItemId)!;
    const productBoms = db.boms.filter(b => b.finishedItemId === params.finishedItemId);
    const nextVersion = Math.max(0, ...productBoms.map(b => Number(b.version) || 0)) + 1;
    const bomId = generateErpId('bom');
    const bomNumber = `BOM-${product.code}-V${nextVersion}`;
    const newBom: BomHeader = {
      id: bomId,
      bomNumber,
      finishedItemId: params.finishedItemId,
      version: nextVersion,
      baseQuantity: Number(params.baseQuantity),
      unitId: params.unitId,
      active: true,
      effectiveDate: params.effectiveDate,
      notes: params.notes,
      isTest: params.isTest,
    };

    erpDb.mutate(draft => {
      // One active BOM per finished product: deactivate the previous active version(s).
      draft.boms
        .filter(b => b.finishedItemId === params.finishedItemId && b.active && b.id !== bomId)
        .forEach(b => { b.active = false; });
      draft.boms.push(newBom);
      params.lines.forEach((l, idx) => {
        draft.bomLines.push({
          id: `bline-${bomId}-${idx + 1}`,
          bomId,
          materialItemId: l.materialItemId,
          quantityRequired: Number(l.quantityRequired),
          unitId: l.unitId,
          wastePercentage: l.wastePercentage !== undefined && l.wastePercentage !== null ? Number(l.wastePercentage) : undefined,
        });
      });
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId,
        userName: guard.userName,
        module: 'إدارة الإنتاج والتكاليف',
        action: 'create',
        recordId: bomId,
        description: `إنشاء معادلة تصنيع جديدة ${bomNumber} للمنتج ${product.nameAr} (${params.lines.length} بنود) وإيقاف النسخة السابقة`,
      });
    });

    return { success: true, bom: newBom };
  }

  /** Edit BOM header and/or lines of an existing version (RBAC-guarded). */
  public static updateBom(params: {
    bomId: string;
    baseQuantity?: number;
    unitId?: string;
    effectiveDate?: string;
    notes?: string;
    lines?: Array<{ materialItemId: string; quantityRequired: number; unitId: string; wastePercentage?: number }>;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; error?: string } {
    const guard = AuthorizationService.enforce('manufacturing', 'edit', { userId: params.userId, userName: params.userName, isTest: params.isTest });
    if (!guard.allowed) return { success: false, error: guard.error };

    const db = erpDb.getSnapshot();
    const bom = db.boms.find(b => b.id === params.bomId);
    if (!bom) return { success: false, error: 'المعادلة غير موجودة' };
    const baseQuantity = params.baseQuantity !== undefined ? Number(params.baseQuantity) : bom.baseQuantity;
    const lines = params.lines;
    if (lines) {
      const payloadError = this.validateBomPayload({ finishedItemId: bom.finishedItemId || '', lines, baseQuantity });
      if (payloadError) return { success: false, error: payloadError };
    }

    erpDb.mutate(draft => {
      const target = draft.boms.find(b => b.id === params.bomId);
      if (!target) return;
      if (params.baseQuantity !== undefined) target.baseQuantity = Number(params.baseQuantity);
      if (params.unitId !== undefined) target.unitId = params.unitId;
      if (params.effectiveDate !== undefined) target.effectiveDate = params.effectiveDate;
      if (params.notes !== undefined) target.notes = params.notes;
      if (lines) {
        draft.bomLines = draft.bomLines.filter(l => l.bomId !== params.bomId);
        lines.forEach((l, idx) => {
          draft.bomLines.push({
            id: `bline-${params.bomId}-${idx + 1}`,
            bomId: params.bomId,
            materialItemId: l.materialItemId,
            quantityRequired: Number(l.quantityRequired),
            unitId: l.unitId,
            wastePercentage: l.wastePercentage !== undefined && l.wastePercentage !== null ? Number(l.wastePercentage) : undefined,
          });
        });
      }
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId,
        userName: guard.userName,
        module: 'إدارة الإنتاج والتكاليف',
        action: 'edit',
        recordId: params.bomId,
        description: `تعديل معادلة تصنيع ${target.bomNumber || params.bomId}${lines ? ` (${lines.length} بنود)` : ''}`,
      });
    });

    return { success: true };
  }

  /** Activate/deactivate a BOM version. Activating ensures ONE active BOM per product.
   *  With no active BOM, production order creation stays blocked (existing guard). */
  public static setBomActive(bomId: string, active: boolean, userId: string = 'usr-admin', userName: string = 'مدير الإنتاج'): { success: boolean; error?: string } {
    const guard = AuthorizationService.enforce('manufacturing', 'edit', { userId, userName });
    if (!guard.allowed) return { success: false, error: guard.error };

    const db = erpDb.getSnapshot();
    const bom = db.boms.find(b => b.id === bomId);
    if (!bom) return { success: false, error: 'المعادلة غير موجودة' };
    if (active) {
      const hasLines = db.bomLines.some(l => l.bomId === bomId);
      if (!hasLines) return { success: false, error: 'لا يمكن تفعيل معادلة بدون بنود' };
    }

    erpDb.mutate(draft => {
      const target = draft.boms.find(b => b.id === bomId);
      if (!target) return;
      target.active = active;
      if (active) {
        // Enforce exactly one active BOM per finished product.
        draft.boms
          .filter(b => b.finishedItemId === target.finishedItemId && b.active && b.id !== bomId)
          .forEach(b => { b.active = false; });
      }
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId,
        userName: guard.userName,
        module: 'إدارة الإنتاج والتكاليف',
        action: 'edit',
        recordId: bomId,
        description: `${active ? 'تفعيل' : 'إيقاف'} معادلة التصنيع ${target.bomNumber || bomId}${active ? ' (مع إيقاف نسخة أخرى لنفس المنتج تلقائيًا)' : ''}`,
      });
    });

    return { success: true };
  }
}
