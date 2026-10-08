// Manufacturing & Costing Engine: BOM calculation, Multi-day tracking, Standard Costing, Actual Costing, Variances
// Standard rates are ALWAYS read from StandardCostRate records (never hardcoded in logic).
// Actual conversion costs are taken from recorded production-order cost entries (never fabricated).
import { erpDb, generateErpId, nextDocNumber, getUnitConversion } from './db';
import type { ERPDatabaseSchema } from './db';
import { ProductionOrder, ProductionConsumption, ProductionWaste, BomHeader, BomLine, Item, StandardCostRate, JournalLine } from '../types/erp';
import { InventoryEngine } from './inventory';
import { AccountingEngine } from './accounting';
import { AuthorizationService } from './authorization';

/** FIX 2 — reconciliation tolerance in BASE units (absorbs BOM 3-decimal rounding). */
const RECON_TOL = 1e-3;

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
   * FIX 1 + FIX 2 — THE single source of truth for production material quantities.
   *
   * For every material issued to `order`, in the item's BASE inventory unit:
   *   issued    = Σ productionConsumptions.actualQuantity   (what FIFO deducted)
   *   expected  = BOM requirement scaled to `totalUnits`     (what production used)
   *   consumed  = min(issued, expected)                      (what really went in)
   *   remainder = issued − consumed                          (must be dispositioned)
   *
   * `expected` is derived PER MATERIAL from that material's own BOM line (and
   * its own unit conversion). It is NEVER a single flat `1 − produced/planned`
   * percentage applied blindly to every issued line.
   *
   * A material with no BOM line (legacy data) has no derivable expectation, so
   * it is treated as fully consumed rather than being silently returned.
   */
  private static computeMaterialConsumption(
    db: ERPDatabaseSchema,
    order: ProductionOrder,
    totalUnits: number
  ): Array<{
    materialItemId: string;
    warehouseId: string;
    unitCost: number;
    planned: number;
    issued: number;
    expected: number;
    consumed: number;
    remainder: number;
    issuedCost: number;
    consumedCost: number;
    rows: ProductionConsumption[];
  }> {
    const rows = db.productionConsumptions.filter(c => c.productionOrderId === order.id);
    const byMaterial = new Map<string, {
      materialItemId: string; warehouseId: string; unitCost: number; planned: number;
      issued: number; expected: number; rows: ProductionConsumption[];
    }>();

    for (const c of rows) {
      let r = byMaterial.get(c.materialItemId);
      if (!r) {
        r = {
          materialItemId: c.materialItemId,
          warehouseId: c.warehouseId || 'wh-raw',
          unitCost: 0, planned: 0, issued: 0,
          // Unknown expectation ⇒ consumed = issued (never invent a return).
          expected: -1,
          rows: [],
        };
        byMaterial.set(c.materialItemId, r);
      }
      r.planned += Number(c.plannedQuantity) || 0;
      r.issued += Number(c.actualQuantity) || 0;
      r.rows.push(c);
    }

    // ---- expected consumption from the order's own BOM (per material, base unit) ----
    const bom = db.boms.find(b => b.id === order.bomId);
    if (bom) {
      const scale = totalUnits / (bom.baseQuantity || 1);
      for (const line of db.bomLines.filter(l => l.bomId === bom.id)) {
        const target = byMaterial.get(line.materialItemId);
        if (!target) continue;
        const item = db.items.find(i => i.id === line.materialItemId);
        const wasteFactor = 1 + ((line.wastePercentage || 0) / 100);
        let factor = 1;
        try {
          // BOM line unit → item base unit (KG item, GRAM line ⇒ 0.001).
          factor = getUnitConversion(db, line.unitId, item?.baseUnitId || line.unitId);
        } catch {
          // No configured conversion: the expectation cannot be derived safely,
          // so the issued quantity stays consumed (fail-safe, never assume 1:1).
          continue;
        }
        target.expected = Number((line.quantityRequired * scale * wasteFactor * factor).toFixed(6));
      }
    }

    const out: Array<{
      materialItemId: string; warehouseId: string; unitCost: number; planned: number;
      issued: number; expected: number; consumed: number; remainder: number;
      issuedCost: number; consumedCost: number; rows: ProductionConsumption[];
    }> = [];
    for (const r of byMaterial.values()) {
      const expected = r.expected < 0 ? r.issued : r.expected;
      const consumed = Math.min(r.issued, expected);
      // weighted-average FIFO cost of every issue of this material
      const unitCost = r.issued > 0
        ? r.rows.reduce((s, c) => s + (Number(c.actualQuantity) || 0) * (Number(c.unitCost) || 0), 0) / r.issued
        : 0;
      const issuedCost = r.rows.reduce((s, c) => s + (Number(c.actualQuantity) || 0) * (Number(c.unitCost) || 0), 0);

      // FIFO cost of the layers that STAY consumed. A return takes the NEWEST
      // layers first, so what remains on the order is the OLDEST part of the
      // issue — walk the recorded allocations in issue order and cost the first
      // `consumed` units. This is what keeps GL 1108 in step with the batch
      // ledger after a partial close (weighted average would drift).
      let need = consumed;
      let consumedCost = 0;
      let allocated = false;
      for (const row of r.rows) {
        if (need <= 1e-9) break;
        for (const a of row.batchAllocations || []) {
          if (need <= 1e-9) break;
          const take = Math.min(need, Number(a.quantity) || 0);
          if (take <= 0) continue;
          consumedCost += take * (Number(a.unitCost) || 0);
          need -= take;
          allocated = true;
        }
      }
      // Legacy rows (issued before batch allocations were recorded) or an
      // incomplete allocation trail: fall back to the row's own FIFO cost.
      if (!allocated || need > 1e-6) consumedCost = consumed * unitCost;

      out.push({
        materialItemId: r.materialItemId,
        warehouseId: r.warehouseId,
        unitCost,
        planned: r.planned,
        issued: r.issued,
        expected,
        consumed,
        remainder: r.issued - consumed,
        issuedCost,
        consumedCost,
        rows: r.rows,
      });
    }
    return out;
  }

  /**
   * PUBLIC, READ-ONLY view of the reconciliation a close will demand:
   * `issued = consumed + remainder` per material, so the caller can present the
   * exact return / approved-variance figures instead of guessing a percentage.
   */
  public static getMaterialReconciliation(orderId: string): Array<{
    materialItemId: string;
    itemNameAr: string;
    warehouseId: string;
    unitId: string;
    issuedQuantity: number;
    expectedQuantity: number;
    consumedQuantity: number;
    remainderQuantity: number;
    unitCost: number;
    issuedCost: number;
    consumedCost: number;
    remainderCost: number;
  }> {
    const db = erpDb.getSnapshot();
    const order = db.productionOrders.find(o => o.id === orderId);
    if (!order) return [];
    const totalUnits = (order.producedQuantity || 0) + (order.defectiveQuantity || 0) + (order.scrapQuantity || 0);
    return this.computeMaterialConsumption(db, order, totalUnits).map(r => ({
      materialItemId: r.materialItemId,
      itemNameAr: db.items.find(i => i.id === r.materialItemId)?.nameAr || r.materialItemId,
      warehouseId: r.warehouseId,
      unitId: db.items.find(i => i.id === r.materialItemId)?.baseUnitId || 'unit-kg',
      issuedQuantity: r.issued,
      expectedQuantity: r.expected,
      consumedQuantity: r.consumed,
      remainderQuantity: r.remainder,
      unitCost: r.unitCost,
      remainderCost: r.issuedCost - r.consumedCost,
      consumedCost: r.consumedCost,
      issuedCost: r.issuedCost,
    }));
  }

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
    /** FIX 1 — set when no configured conversion exists: the verdict is FAIL-SAFE. */
    conversionError?: string;
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
      // Raw materials live in the raw-materials warehouse (WH-01); their
      // quantity is denominated in the ITEM's base unit, so it must be converted
      // into the BOM line's unitId before it is compared with the requirement.
      // Otherwise a KG item (available = 10) vs a GRAM requirement (required = 70)
      // would be judged insufficient even when 10 KG = 10,000 GRAM.
      const materialBaseUnit = item?.baseUnitId || 'unit-kg';
      const stock = InventoryEngine.getItemBalance(line.materialItemId, 'wh-raw');
      let availableStockInLineUnit = 0;
      let conversionError: string | undefined;
      try {
        availableStockInLineUnit = stock * getUnitConversion(db, materialBaseUnit, line.unitId);
      } catch (e) {
        // FIX 1 / rule 12 — FAIL SAFELY: never assume 1 unit = 1 unit. The
        // requirement is reported as unsatisfiable and the reason is exposed so
        // the transaction path (which blocks) and the screen agree.
        conversionError = (e as Error).message;
      }
      return {
        materialItemId: line.materialItemId,
        itemNameAr: item?.nameAr || line.materialItemId,
        unitId: line.unitId,
        unitNameAr: unitsMap.get(line.unitId) || '',
        requiredQuantity: reqQty,
        availableStock: availableStockInLineUnit,
        sufficient: conversionError ? false : availableStockInLineUnit >= reqQty,
        conversionError,
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

    // ---- Actual material cost: the quantity CONSUMED, never merely issued ----
    // FIX 2 (rules 14/15): material that was issued for units that were never
    // produced must not be capitalised into finished goods, so the breakdown,
    // the FG valuation and the closure journal all read `consumed` here.
    const reconRows = order ? this.computeMaterialConsumption(db, order, totalProduced) : [];
    const actualMaterialCost = reconRows.reduce((sum, r) => sum + r.consumedCost, 0);
    const plannedMaterialCost = reconRows.reduce((sum, r) => sum + (r.planned * r.unitCost), 0);
    const standardMaterialCost = plannedMaterialCost || actualMaterialCost;

    // Material QUANTITY variance: (consumed qty - planned qty) x actual unit cost
    const materialQuantityVariance = reconRows.reduce(
      (sum, r) => sum + ((r.consumed - r.planned) * r.unitCost),
      0
    );
    // Material PRICE variance: actual FIFO price vs item standard cost
    const materialPriceVariance = reconRows.reduce((sum, r) => {
      const std = db.items.find(i => i.id === r.materialItemId)?.standardCost || 0;
      return sum + ((r.unitCost - std) * r.consumed);
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
    // FIX 6 — CATEGORY IDENTITY IS READ FROM THE COST TYPE'S OWN ACCOUNT ONLY.
    //
    // The generic 'expenses_default' account (6101) is the CREDIT leg of every
    // conversion journal, so consulting it returned −amount of whichever
    // category happened to have been recorded and bled into all the others
    // (labor 1000 ⇒ electricity/gas/maintenance/supervision = −1000).
    //
    // An unmapped or simply unrecorded cost yields 0. An actual is NEVER
    // substituted by the standard: standard is the benchmark, actual is what
    // was actually recorded. variance = actual − standard for every category.
    const findActual = (mappingKey: string): number => {
      const accId = mapKeys[mappingKey];
      if (!accId) return 0;
      return actualConversionByAccount.get(accId) || 0;
    };

    const actualLaborCost = findActual('variance_direct_labor');
    const actualElectricityCost = findActual('variance_electricity');
    const actualGasCost = findActual('variance_gas');
    const actualMaintenanceCost = findActual('variance_maintenance');
    const actualSupervisionCost = findActual('variance_overhead');

    // No fallback to standard (that silently turned "actual" into "standard").
    const appliedActualLabor = actualLaborCost;
    const appliedActualElectricity = actualElectricityCost;
    const appliedActualGas = actualGasCost;
    const appliedActualMaintenance = actualMaintenanceCost;
    const appliedActualSupervision = actualSupervisionCost;

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

    const creditAccId = AccountingEngine.getMappedAccountId('conversion_cost_payable', 'acc-2104');
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
            unitId: bl.unitId,
          };
        });

    if (requirements.length === 0) {
      return { success: false, error: 'لا توجد بنود مواد في معادلة التصنيع' };
    }

    // ---- FIX 1 — convert EVERY requirement into the ITEM'S BASE INVENTORY
    //      UNIT, once, then pre-validate all stock before any mutation ----
    const plannedByLineUnit = new Map<string, number>();
    bomLines.forEach(bl => {
      const wasteFactor = 1 + ((bl.wastePercentage || 0) / 100);
      plannedByLineUnit.set(bl.materialItemId, Number((bl.quantityRequired * scale * wasteFactor).toFixed(6)));
    });
    //
    // A BOM line may be expressed in any configured unit (70 GRAM) while the
    // item is stocked in its base unit (KG). The inventory/FIFO layer only ever
    // speaks the base unit, so:
    //   • availability  = stock(base) converted INTO the BOM line's unit
    //   • issue quantity = requirement(line unit) converted INTO the base unit
    // A missing or invalid conversion BLOCKS the transaction — never 1:1 by
    // default. Explicit-override requirements carry no unitId and are therefore
    // already in the item's base unit (factor 1, no unnecessary conversion).
    type IssueLine = {
      materialItemId: string; lineQuantity: number; lineUnitId: string;
      baseUnitId: string; issueQty: number; plannedBaseQty: number;
    };
    const issues: IssueLine[] = [];
    for (const req of requirements) {
      const item = db.items.find(i => i.id === req.materialItemId);
      if (!item) return { success: false, error: `مادة في معادلة التصنيع غير معرفة بالنظام (${req.materialItemId})` };
      if (req.quantity <= 0) return { success: false, error: `كمية الصرف يجب أن تكون أكبر من صفر للمادة (${item.nameAr})` };
      const lineUnitId = (req as { unitId?: string }).unitId || item.baseUnitId;
      const baseUnitId = item.baseUnitId;

      let toLineUnit: number;
      let toBaseUnit: number;
      try {
        toLineUnit = getUnitConversion(db, baseUnitId, lineUnitId);
        toBaseUnit = getUnitConversion(db, lineUnitId, baseUnitId);
      } catch (e) {
        return {
          success: false,
          error: `تعذّر صرف (${item.nameAr}) — لا توجد معامل تحويل وحدة صالح بين (${lineUnitId}) و(${baseUnitId}). ${(e as Error).message}`,
        };
      }
      if (!Number.isFinite(toLineUnit) || !Number.isFinite(toBaseUnit) || toLineUnit <= 0 || toBaseUnit <= 0) {
        return { success: false, error: `معامل تحويل الوحدة غير صالح لصرف (${item.nameAr}) بين (${lineUnitId}) و(${baseUnitId})` };
      }

      const stock = InventoryEngine.getItemBalance(req.materialItemId, 'wh-raw');
      const availableStockInIssueUnit = stock * toLineUnit;
      if (availableStockInIssueUnit < req.quantity - 1e-9) {
        return {
          success: false,
          error: `الرصيد المتاح من (${item.nameAr}) بمستودع الخامات هو ${availableStockInIssueUnit} ${lineUnitId} ولا يكفي لصرف ${req.quantity} ${lineUnitId}`,
        };
      }

      const issueQty = Number((req.quantity * toBaseUnit).toFixed(6));
      if (!Number.isFinite(issueQty) || issueQty <= 0) {
        return { success: false, error: `كمية الصرف بعد تحويل الوحدة يجب أن تكون أكبر من صفر للمادة (${item.nameAr})` };
      }
      const plannedLineQty = plannedByLineUnit.get(req.materialItemId) ?? req.quantity;
      const plannedBaseQty = Number((plannedLineQty * toBaseUnit).toFixed(6));
      issues.push({ materialItemId: req.materialItemId, lineQuantity: req.quantity, lineUnitId, baseUnitId, issueQty, plannedBaseQty });
    }


    let totalActualCost = 0;
    const issueResults: Array<ReturnType<typeof InventoryEngine.recordMovement>> = [];

    // ---- Validate + plan all issues first (pure), then execute ----
    // FIX 1: `issueQty` is the BOM requirement CONVERTED to the item's base
    // inventory unit (70 GRAM → 0.07 KG), so the FIFO deduction, the recorded
    // consumption and the derived material cost all use the same physical
    // quantity that was actually moved out of stock.
    for (const iss of issues) {
      const moveRes = InventoryEngine.recordMovement({
        itemId: iss.materialItemId,
        warehouseId: 'wh-raw',
        movementType: 'production_issue',
        date: params.date,
        quantityIn: 0,
        quantityOut: iss.issueQty,
        unitCost: 0, // engine derives actual FIFO cost
        documentType: 'صرف خامات لأمر إنتاج',
        documentNumber: order.orderNumber,
        notes: `صرف مواد لأمر إنتاج ${order.orderNumber} (${iss.lineQuantity} ${iss.lineUnitId} = ${iss.issueQty} ${iss.baseUnitId})`,
      });
      if (!moveRes.success) return { success: false, error: moveRes.error };
      issueResults.push(moveRes);
      totalActualCost += moveRes.actualCost || 0;
    }

    // ---- Record consumption lines + audit (atomic mutate) ----
    erpDb.mutate(draft => {
      for (const iss of issues) {
        const consumed = issueResults.shift();
        const actualCost = consumed?.actualCost || 0;
        // The PHYSICAL quantity that left the batches (exact FIFO sum, no
        // rounding drift) — this is what the consumption row must carry.
        const exactQty = Number(
          (consumed?.consumedBatches || []).reduce((s, b) => s + b.quantity, 0).toFixed(6)
        ) || iss.issueQty;
        const actualQty = exactQty;
        const unitCost = actualQty > 0 ? actualCost / actualQty : 0;

        draft.productionConsumptions.push({
          id: generateErpId('pc'),
          productionOrderId: params.orderId,
          materialItemId: iss.materialItemId,
          warehouseId: 'wh-raw',
          unitId: iss.lineUnitId,
          // Planned and actual are both recorded in the item's BASE unit so
          // `ISSUED = CONSUMED + RETURNED + VARIANCE` reconciles per material
          // against the FIFO batches that were really deducted.
          plannedQuantity: iss.plannedBaseQty || actualQty,
          actualQuantity: exactQty,
          unitCost,
          date: params.date,
          // FIX 2 — batch traceability: remember the exact layers this issue
          // consumed so unconsumed material can be returned to the SAME batch.
          batchAllocations: (consumed?.consumedBatches || []).map(b => ({
            batchNumber: b.batchNumber,
            quantity: b.quantity,
            unitCost: b.unitCost,
          })),
          returnedQuantity: 0,
          approvedVarianceQuantity: 0,
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

    // FIX 2 — INCREMENTAL FINISHED-GOODS VALUATION.
    // `calculateCostBreakdown` is CUMULATIVE for the whole order. Booking that
    // cumulative figure into every stage batch re-capitalised stage 1's
    // material inside stage 2 (up to 1.4× over-valuation). Each output record
    // therefore books only the cost it ADDS:
    //   • material consumed-to-date − material consumed before this record
    //   • conversion not yet capitalised into this order's FG batches.
    const breakdown = this.calculateCostBreakdown(params.orderId);
    const appliedConversion = breakdown.actualLaborCost + breakdown.actualElectricityCost + breakdown.actualGasCost
      + breakdown.actualMaintenanceCost + breakdown.actualSupervisionCost;
    const totalUnits = goodQty + defectiveQty + scrapQty;
    const prevUnits = (order.producedQuantity || 0) + (order.defectiveQuantity || 0) + (order.scrapQuantity || 0);
    const consumedBefore = this.computeMaterialConsumption(db, order, prevUnits)
      .reduce((s, r) => s + r.consumedCost, 0);
    const consumedNow = this.computeMaterialConsumption(db, order, prevUnits + totalUnits)
      .reduce((s, r) => s + r.consumedCost, 0);
    const conversionAlreadyBooked = order.fgConversionCapitalized || 0;
    const stageCost = (consumedNow - consumedBefore) + (appliedConversion - conversionAlreadyBooked);
    const actualUnitCost = totalUnits > 0
      ? Math.max(0, stageCost) / totalUnits
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
      // FIX 2 — what has already been capitalised into the FG batches, so the
      // next output record (and the closure) book only the difference. Only the
      // SALEABLE (good) share lands in FG; defective/scrap output is valued into
      // its own warehouses by the waste journal.
      ord.fgCapitalizedCost = (ord.fgCapitalizedCost || 0)
        + (totalUnits > 0 ? Math.max(0, stageCost) * (goodQty / totalUnits) : 0);
      ord.fgConversionCapitalized = appliedConversion;

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
  public static closeProductionOrder(
    orderId: string,
    userId: string = 'usr-admin',
    userName: string = 'مدير الإنتاج',
    params?: {
      mode?: 'full' | 'partial';
      reason?: string;
      dispositions?: Array<{
        materialItemId: string;
        returnQuantity?: number;
        approvedVarianceQuantity?: number;
        approvedVarianceReason?: string;
      }>;
    }
  ): { success: boolean; error?: string; mode?: 'full' | 'partial' } {
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

    // ================= FIX 2 — FULL vs PARTIAL, NEVER SILENT =================
    const planned = Number(order.plannedQuantity) || 0;
    const isPartial = planned > 0 && totalUnits < planned - RECON_TOL;
    const requestedMode = params?.mode;
    const closeMode: 'full' | 'partial' = isPartial
      ? 'partial'
      : (requestedMode === 'partial' ? 'partial' : 'full');

    if (isPartial && requestedMode !== 'partial') {
      return {
        success: false,
        mode: 'partial',
        error:
          `لا يمكن إغلاق أمر الإنتاج ${order.orderNumber} كأمر مكتمل: الكمية المخططة ${planned} والكمية الفعلية ${totalUnits}. ` +
          `يجب استخدام الإغلاق الجزئي مع سبب صريح، وإرجاع الخامات غير المستهلكة أو اعتماد فارنسها لكل مادة على حدة.`,
      };
    }
    const closeReason = (params?.reason || '').trim();
    if (closeMode === 'partial' && !closeReason) {
      return {
        success: false,
        mode: 'partial',
        error: `لا يمكن إغلاق أمر الإنتاج ${order.orderNumber} جزئيًا بدون سبب صريح. أدخل سبب الإغلاق الجزئي.`,
      };
    }

    // ============ FIX 2 — PER-MATERIAL RECONCILIATION (no flat percentage) ============
    //   ISSUED = CONSUMED + RETURNED + APPROVED_VARIANCE   for EVERY material.
    // Anything left over without an explicit disposition BLOCKS the close.
    const recon = this.computeMaterialConsumption(db, order, totalUnits);
    const dispositions = params?.dispositions || [];
    type ClosePlan = {
      row: (typeof recon)[number];
      returnQty: number; varianceQty: number; varianceReason: string;
    };
    const plan: ClosePlan[] = [];

    for (const row of recon) {
      const item = db.items.find(i => i.id === row.materialItemId);
      const disp = dispositions.find(d => d.materialItemId === row.materialItemId);
      const returnQty = Number(disp?.returnQuantity) || 0;
      const varianceQty = Number(disp?.approvedVarianceQuantity) || 0;
      const varianceReason = (disp?.approvedVarianceReason || '').trim();
      if (returnQty < 0 || varianceQty < 0) {
        return { success: false, mode: closeMode, error: `كميات التصرّف يجب أن تكون أكبر من أو تساوي صفر (مادة: ${item?.nameAr || row.materialItemId})` };
      }
      const tol = Math.max(RECON_TOL, Math.abs(row.expected) * 1e-6);
      if (Math.abs(returnQty + varianceQty - row.remainder) > tol) {
        return {
          success: false,
          mode: closeMode,
          error:
            `لا يمكن إغلاق أمر الإنتاج ${order.orderNumber}: مادة (${item?.nameAr || row.materialItemId}) غير مُسوّاة — ` +
            `المصروف ${row.issued} والمستهلك ${row.consumed} والمتبقي ${row.remainder} يجب أن يُصرَّف صريحًا ` +
            `(إرجاع للمخزون + فارنس معتمد)، بينما التصرّف المقدّم ${returnQty + varianceQty}.`,
        };
      }
      if (varianceQty > 0 && !varianceReason) {
        return {
          success: false,
          mode: closeMode,
          error: `الفارنس المعتمد للمادة (${item?.nameAr || row.materialItemId}) يتطلب سببًا وترويضاً صريحين.`,
        };
      }
      plan.push({ row, returnQty, varianceQty, varianceReason });
    }
    for (const d of dispositions) {
      if (!recon.some(r => r.materialItemId === d.materialItemId)) {
        return { success: false, mode: closeMode, error: `تصرّف مقدّم لمادة لم تُصرف لأمر الإنتاج (${d.materialItemId}).` };
      }
    }
    // Approved variance is an authorized write-off of real material: it needs the
    // existing ERP authorization model (`approve` on the manufacturing module).
    if (plan.some(p => p.varianceQty > 0)) {
      const guard = AuthorizationService.enforce('manufacturing', 'approve', {
        userId, userName, isTest: (order as { isTest?: boolean }).isTest,
      } as never);
      if (!guard.allowed) return { success: false, mode: closeMode, error: guard.error };
    }

    // ============ FIX 2 — execute the explicit returns to the ORIGINAL batches ============
    let materialReturnedCost = 0;
    for (const p of plan) {
      if (p.returnQty <= 0) continue;
      // The layers this material was issued from: newest issue first, and inside
      // a consumption row the LAST allocated layer first — exactly reversing the
      // FIFO order of the issue, so quantity, batch identity and expiry survive.
      const layers: Array<{ batchNumber: string; quantity: number; unitCost: number }> = [];
      for (const c of [...p.row.rows].reverse()) {
        const allocs = Array.isArray(c.batchAllocations) ? [...c.batchAllocations].reverse() : [];
        if (allocs.length > 0) {
          for (const a of allocs) {
            layers.push({ batchNumber: a.batchNumber, quantity: Number(a.quantity) || 0, unitCost: Number(a.unitCost) || 0 });
          }
        } else {
          // Legacy consumption (issued before batch allocations were recorded):
          // fall back to the FIFO-first batch of that item/warehouse — the very
          // layer the original issue necessarily started from. A replacement
          // batch is NEVER invented just to balance a total.
          const first = db.batches
            .filter(b => b.itemId === p.row.materialItemId && b.warehouseId === p.row.warehouseId)
            .sort((a, b) => {
              const d = (a.productionDate || '').localeCompare(b.productionDate || '');
              return d !== 0 ? d : (a.batchNumber || '').localeCompare(b.batchNumber || '');
            })[0];
          if (first) {
            layers.push({ batchNumber: first.batchNumber, quantity: Number.MAX_SAFE_INTEGER, unitCost: first.unitCost || 0 });
          }
        }
      }

      let remaining = p.returnQty;
      for (const layer of layers) {
        if (remaining <= 1e-9) break;
        const take = Math.min(remaining, layer.quantity);
        if (take <= 0) continue;
        const original = db.batches.find(
          b => b.itemId === p.row.materialItemId && b.warehouseId === p.row.warehouseId && b.batchNumber === layer.batchNumber
        );
        const back = InventoryEngine.recordMovement({
          itemId: p.row.materialItemId,
          warehouseId: p.row.warehouseId,
          movementType: 'production_return',
          date: todayStr,
          quantityIn: take,
          quantityOut: 0,
          unitCost: layer.unitCost,
          batchNumber: layer.batchNumber,
          productionDate: original?.productionDate,
          expiryDate: original?.expiryDate,
          documentType: 'إرجاع خامات غير مستخدمة',
          documentNumber: order.orderNumber,
          notes: `إرجاع مادة غير مستهلكة لأمر الإنتاج ${order.orderNumber} إلى التشغيلة ${layer.batchNumber} (إغلاق جزئي)`,
          isTest: (order as { isTest?: boolean }).isTest,
        } as never);
        if (!back.success) {
          return { success: false, mode: closeMode, error: `تعذر إرجاع المادة إلى التشغيلة ${layer.batchNumber}: ${back.error}` };
        }
        materialReturnedCost += take * layer.unitCost;
        remaining -= take;
      }
      if (remaining > 1e-6) {
        const item = db.items.find(i => i.id === p.row.materialItemId);
        return {
          success: false,
          mode: closeMode,
          error: `تعذر إرجاع ${remaining} من (${item?.nameAr || p.row.materialItemId}) إلى التشغيلات الأصلية — تم إيقاف الإغلاق.`,
        };
      }
    }
    // Only the CONSUMED share is capitalised into finished goods.
    const materialConsumedCost = breakdown.actualMaterialCost;

    // ============ FIX 6 — CONVERSION ABSORPTION (validated before any mutation) ============
    // Each category is absorbed into FG FROM ITS OWN ACCOUNT: this clears
    // exactly what `recordConversionCost` debited (5105…5109) and never credits
    // an unrelated expense account, so category identity survives to the balance
    // sheet and no expense account is pushed negative by the closure.
    const conversionCredits: Array<{ label: string; amount: number; accountId: string; code: string; nameAr: string }> = [];
    const convDefs: Array<{ key: string; fallback: string; label: string; amount: number }> = [
      { key: 'variance_direct_labor', fallback: 'acc-5105', label: 'أجور عمالة مباشرة', amount: breakdown.actualLaborCost },
      { key: 'variance_electricity', fallback: 'acc-5106', label: 'كهرباء', amount: breakdown.actualElectricityCost },
      { key: 'variance_gas', fallback: 'acc-5107', label: 'غاز', amount: breakdown.actualGasCost },
      { key: 'variance_maintenance', fallback: 'acc-5108', label: 'صيانة', amount: breakdown.actualMaintenanceCost },
      { key: 'variance_overhead', fallback: 'acc-5109', label: 'إشراف وتكاليف صناعية', amount: breakdown.actualSupervisionCost },
    ];
    for (const d of convDefs) {
      if (!(d.amount > 0)) continue;
      const accId = AccountingEngine.getMappedAccountId(d.key, d.fallback);
      const acc = db.accounts.find(a => a.id === accId);
      if (!acc) {
        return { success: false, mode: closeMode, error: `حساب التكلفة التحويلية (${d.label}) غير موجود بدليل الحسابات — تعذر إغلاق أمر الإنتاج.` };
      }
      if (acc.isHeader) {
        return { success: false, mode: closeMode, error: `حساب التكلفة التحويلية (${d.label}) حساب رئيسي تجميعي — تعذر إغلاق أمر الإنتاج.` };
      }
      conversionCredits.push({ label: d.label, amount: d.amount, accountId: acc.id, code: acc.code, nameAr: acc.nameAr });
    }

    // FG is capitalised at what was ACTUALLY CONSUMED + conversion applied —
    // but only the SALEABLE share of it. QC-failed output (defective / scrap)
    // is carried by its own warehouses through the waste journal, so its share
    // of the cost is written off to the production variance instead of being
    // double-counted inside finished goods. With no QC failure the two are equal.
    const goodUnits = order.producedQuantity || 0;
    const capitalizedActualCost = materialConsumedCost + appliedConversionCost;
    const fgCapitalizedCost = totalUnits > 0 ? capitalizedActualCost * (goodUnits / totalUnits) : capitalizedActualCost;
    const qcLossCost = capitalizedActualCost - fgCapitalizedCost;
    const actualUnitCost = totalUnits > 0 ? capitalizedActualCost / totalUnits : 0;

    // Post the closure journal. FIX 2 — it is balanced BY CONSTRUCTION:
    //   Dr FG                 = consumed material + conversion applied
    //   Cr raw materials      = consumed material
    //   Cr accrued conversion = conversion applied
    // The unconsumed material has already been returned to its ORIGINAL batches,
    // so nothing is left unexplained and no synthetic "balancing variance" plug
    // is posted (that plug was the reason a closure could only succeed when the
    // standard-vs-actual variance happened to be ~zero).
    const invFinishedAccId = order.targetMarket === 'export'
      ? AccountingEngine.getMappedAccountId('inventory_finished_export', 'acc-1110')
      : AccountingEngine.getMappedAccountId('inventory_finished_local', 'acc-1109');
    const rawMaterialsAccId = AccountingEngine.getMappedAccountId('purchase_raw_inventory', 'acc-1108');

    const lines: JournalLine[] = [];    // Debit: Finished goods at the ACTUAL CONSUMED cost of the SALEABLE output
    // (QA-04 — the share belonging to units that were never produced is returned
    // to stock; the QC-failed share is written off to variance below).
    if (fgCapitalizedCost > 0) {
    lines.push({
      id: '', journalEntryId: '',
      accountId: invFinishedAccId,
      accountCode: db.accounts.find(a => a.id === invFinishedAccId)?.code || '',
      accountNameAr: db.accounts.find(a => a.id === invFinishedAccId)?.nameAr || '',
      debit: fgCapitalizedCost,
      credit: 0,
      currency: 'EGP' as const,
      originalAmount: fgCapitalizedCost,
      exchangeRate: 1, costCenterId: 'cc-prod',
      description: `استلام منتج تام أمر إنتاج ${order.orderNumber} بالتكلفة الفعلية`,
    });
    }

    // QC-FAILED OUTPUT (defective + scrap): its share of the consumed cost is
    // NOT capitalised into finished goods — those units live in the damaged /
    // scrap warehouses (valued by the waste journal), so the unrecovered cost is
    // recognised as a production variance. This keeps GL 1109 identical to the
    // FG batch ledger instead of double-counting the QC-failed share.
    if (qcLossCost > 0.01) {
      const varAccId = AccountingEngine.getMappedAccountId('variance_material_quantity', 'acc-5104');
      const varAcc = db.accounts.find(a => a.id === varAccId);
      if (!varAcc || varAcc.isHeader) {
        return { success: false, mode: closeMode, error: 'حساب فروق التصنيع غير صالح بدليل الحسابات — تعذر إغلاق أمر الإنتاج.' };
      }
      lines.push({
        id: '', journalEntryId: '',
        accountId: varAccId,
        accountCode: varAcc.code,
        accountNameAr: varAcc.nameAr,
        debit: qcLossCost,
        credit: 0,
        currency: 'EGP' as const,
        originalAmount: qcLossCost,
        exchangeRate: 1, costCenterId: 'cc-prod',
        description: `إخفاق رقمة جودة (${order.defectiveQuantity || 0} معيب + ${order.scrapQuantity || 0} هالك) بأمر إنتاج ${order.orderNumber} — غير مُحتسب في المنتج التام`,
      });
    }

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
    }    // Applied conversion costs are absorbed into FG FROM their own category
    // accounts (FIX 6): the expense recognised by `recordConversionCost` is
    // cleared into the asset, and no unrelated account is credited.
    for (const c of conversionCredits) {
      lines.push({
        id: '', journalEntryId: '',
        accountId: c.accountId,
        accountCode: c.code,
        accountNameAr: c.nameAr,
        debit: 0, credit: c.amount, currency: 'EGP' as const,
        originalAmount: c.amount, exchangeRate: 1, costCenterId: 'cc-prod',
        description: `تحميل تكلفة ${c.label} لأمر إنتاج ${order.orderNumber}`,
      });
    }    // Standard-vs-actual variance is a REPORTING figure (breakdown) here, not a
    // journal line: finished goods are capitalised at ACTUAL cost, so there is
    // nothing to re-classify — posting it would double-count the difference.


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
    }    erpDb.mutate(draft => {
      const ord = draft.productionOrders.find(o => o.id === orderId);
      if (ord) {
        ord.status = 'completed';
        ord.actualCompletionDate = todayStr;
        // FIX 2 — the closure itself is an auditable document.
        ord.closeMode = closeMode;
        ord.closeReason = closeReason || undefined;
        ord.closedByUserId = userId;
        ord.closedByName = userName;
        ord.closedAt = new Date().toISOString();
        ord.materialReconciliation = plan.map(p => ({
          materialItemId: p.row.materialItemId,
          issuedQuantity: p.row.issued,
          consumedQuantity: p.row.consumed,
          returnedQuantity: p.returnQty,
          approvedVarianceQuantity: p.varianceQty,
          approvedVarianceReason: p.varianceReason || undefined,
        }));
        ord.fgCapitalizedCost = fgCapitalizedCost;
      }

      // Persist the returns on the consumption rows (newest issue first).
      for (const p of plan) {
        const idOrder = [...p.row.rows].reverse().map(c => c.id);
        let toReturn = p.returnQty;
        for (const id of idOrder) {
          if (toReturn <= 1e-9) break;
          const c = draft.productionConsumptions.find(x => x.id === id);
          if (!c) continue;
          const issuedHere = Number(c.actualQuantity) || 0;
          const take = Math.min(toReturn, issuedHere);
          if (take <= 0) continue;
          c.returnedQuantity = Number(((Number(c.returnedQuantity) || 0) + take).toFixed(6));
          toReturn -= take;
        }
        if (p.varianceQty > 0) {
          const first = draft.productionConsumptions.find(x => x.id === p.row.rows[0]?.id);
          if (first) {
            first.approvedVarianceQuantity = Number(((Number(first.approvedVarianceQuantity) || 0) + p.varianceQty).toFixed(6));
            first.approvedVarianceReason = p.varianceReason;
          }
        }
      }

      // FIX 2 — the FG batches must carry EXACTLY what the journal capitalises.
      // Staged output books its cost incrementally; any conversion recorded
      // after the last output (and rounding) is reconciled here, once, so the
      // batch ledger and GL 1109/1110 agree to the cent.
      const fgResidual = fgCapitalizedCost - (order.fgCapitalizedCost || 0);
      if (Math.abs(fgResidual) > 0.005) {
        const fgBatches = draft.batches.filter(b =>
          b.itemId === order.productId
          && b.warehouseId === order.destinationWarehouseId
          && String(b.batchNumber || '').startsWith(`PRD-${order.orderNumber}-`)
          && (b.quantity || 0) > 0
        );
        const totalFgQty = fgBatches.reduce((s, b) => s + b.quantity, 0);
        if (totalFgQty > 0) {
          for (const b of fgBatches) {
            const newValue = (b.quantity * (b.unitCost || 0)) + fgResidual * (b.quantity / totalFgQty);
            b.unitCost = Number((newValue / b.quantity).toFixed(6));
          }
        }
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
        description: `إغلاق أمر إنتاج ${order.orderNumber} (${closeMode === 'partial' ? 'إغلاق جزئي' : 'إغلاق كامل'})`
          + `${closeReason ? ` — السبب: ${closeReason}` : ''}: كلفة المواد المستهلكة ${materialConsumedCost.toLocaleString('ar-EG')} ج.م`
          + `، إرجاع ${materialReturnedCost.toLocaleString('ar-EG')} ج.م، تكاليف تحويل ${appliedConversionCost.toLocaleString('ar-EG')} ج.م`
          + `، رأسمالة المنتج التام ${fgCapitalizedCost.toLocaleString('ar-EG')} ج.م`,
      });
    });

    return { success: true, mode: closeMode };
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
