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
    // ITEM 7 — the BOM reference is FROZEN on the order (bomSnapshot). Later BOM
    // edits must never rewrite an old order's expectation; the live BOM is only
    // a fallback for legacy orders created before snapshots existed.
    const snapshot = order.bomSnapshot;
    if (snapshot) {
      const scale = totalUnits / (snapshot.baseQuantity || 1);
      for (const line of snapshot.lines) {
        const target = byMaterial.get(line.materialItemId);
        if (!target) continue;
        const item = db.items.find(i => i.id === line.materialItemId);
        let factor = 1;
        try {
          factor = getUnitConversion(db, line.unitId, item?.baseUnitId || line.unitId);
        } catch {
          continue;
        }
        const wasteFactor = 1 + ((line.wastePercentage || 0) / 100);
        target.expected = Number((line.quantityRequired * scale * wasteFactor * factor).toFixed(6));
      }
    } else {
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
      // ITEM 7 — freeze the BOM reference AT ORDER CREATION so later BOM edits
      // never rewrite this order's expected/variance figures.
      bomSnapshot: {
        bomId: bom.id,
        bomNumber: bom.bomNumber,
        version: bom.version,
        baseQuantity: bom.baseQuantity,
        unitId: bom.unitId,
        lines: db.bomLines
          .filter(l => l.bomId === bom.id)
          .map(l => ({ materialItemId: l.materialItemId, quantityRequired: l.quantityRequired, unitId: l.unitId, wastePercentage: l.wastePercentage })),
      },
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
   * R-07 — raw-material usage variance across ALL real production orders.
   *
   * For every production order that actually exists (cancelled orders are
   * excluded — their issues were returned and must not count), the expected
   * quantity is derived PER MATERIAL from the order's own frozen BOM snapshot
   * (scaled to the produced units, waste factor and unit conversion applied),
   * and the issued quantity is the real FIFO consumption recorded on the order.
   *
   * A material with no issue record on any order reports zero here, so nothing
   * that was never issued can appear in the variance report.
   *
   * varianceQty = issued − expected (positive = over-use, negative = saving)
   * varianceValue = that difference valued at the real FIFO issue cost.
   */
  public static getRawMaterialUsageReport(params?: { fromDate?: string; toDate?: string }): Array<{
    materialItemId: string;
    issuedQty: number;
    expectedQty: number;
    varianceQty: number;
    varianceValue: number;
    ordersCounted: number;
  }> {
    const db = erpDb.getSnapshot();
    const inRange = (d?: string) => {
      if (!params?.fromDate && !params?.toDate) return true;
      if (!d) return false;
      const t = new Date(d).getTime();
      if (params?.fromDate && t < new Date(params.fromDate).getTime()) return false;
      if (params?.toDate) {
        const to = new Date(params.toDate);
        to.setHours(23, 59, 59, 999);
        if (t > to.getTime()) return false;
      }
      return true;
    };

    const rows = new Map<string, { materialItemId: string; issuedQty: number; expectedQty: number; varianceValue: number; ordersCounted: number }>();
    const orders = db.productionOrders.filter(o => o.status !== 'cancelled' && inRange(o.startDate || o.expectedCompletionDate));
    for (const order of orders) {
      // R-07: the benchmark is the STANDARD consumption of the PLAN — the
      // order's own frozen BOM scaled to its planned quantity. Comparing the
      // real FIFO issue against it measures over/under use whether the order
      // is still open or already closed.
      const planUnits = order.plannedQuantity || 0;
      const recon = this.computeMaterialConsumption(db, order, planUnits);
      for (const r of recon) {
        if (!(r.issued > 0)) continue; // never-issued material: nothing to variance
        let row = rows.get(r.materialItemId);
        if (!row) {
          row = { materialItemId: r.materialItemId, issuedQty: 0, expectedQty: 0, varianceValue: 0, ordersCounted: 0 };
          rows.set(r.materialItemId, row);
        }
        row.issuedQty += r.issued;
        row.expectedQty += r.expected;
        row.varianceValue += (r.issued - r.expected) * r.unitCost;
        row.ordersCounted += 1;
      }
    }
    return [...rows.values()].map(r => ({
      ...r,
      varianceQty: r.issuedQty - r.expectedQty,
      varianceValue: Number(r.varianceValue.toFixed(2)),
    }));
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
    lines?: Array<{
      materialItemId: string;
      quantity: number;
      /** ITEM 8 — 'bom' (default) | 'substitute' | 'additional' (both need reason + approve). */
      issueKind?: 'bom' | 'substitute' | 'additional';
      substituteForMaterialItemId?: string;
      reason?: string;
    }>;
    date: string;
    userId: string;
    userName: string;
    /** ITEM 8 — shared reason for non-BOM lines of this issue batch. */
    reason?: string;
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

    const snapshot = order.bomSnapshot;
    const scale = order.plannedQuantity / (snapshot?.baseQuantity || bom.baseQuantity || 1);
    const bomLines: BomLine[] = snapshot
      ? snapshot.lines.map((l, idx) => ({
          id: `snap-${idx + 1}`, bomId: order.bomId,
          materialItemId: l.materialItemId, quantityRequired: l.quantityRequired,
          unitId: l.unitId, wastePercentage: l.wastePercentage,
        }))
      : db.bomLines.filter(l => l.bomId === order.bomId);

    // Determine required lines (explicit override or BOM-driven)
    const isOverrideIssue = !!(params.lines && params.lines.length > 0);
    const bomMaterialIds = new Set(bomLines.map(l => l.materialItemId));
    type ReqLine = {
      materialItemId: string; quantity: number; unitId?: string;
      issueKind?: 'bom' | 'substitute' | 'additional';
      substituteForMaterialItemId?: string; reason?: string;
    };
    const requirements: ReqLine[] = isOverrideIssue
      ? (params.lines as NonNullable<typeof params.lines>).map(l => ({
          materialItemId: l.materialItemId,
          quantity: Number(l.quantity) || 0,
          issueKind: l.issueKind,
          substituteForMaterialItemId: l.substituteForMaterialItemId,
          reason: l.reason,
        }))
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

    // ---- ITEM 8 — classify every line. Anything outside the BOM (substitute /
    // additional) requires a persisted reason AND approval-grade permission,
    // and a substitute must name the BOM material it replaces.
    const resolved: Array<ReqLine & { kind: 'bom' | 'substitute' | 'additional'; lineReason: string }> =
      requirements.map(req => {
        const kind: 'bom' | 'substitute' | 'additional' = req.issueKind
          || (bomMaterialIds.has(req.materialItemId) ? 'bom' : 'additional');
        const lineReason = (req.reason || params.reason || '').trim();
        return { ...req, kind, lineReason };
      });
    const nonBomLines = resolved.filter(r => r.kind !== 'bom');
    if (nonBomLines.length > 0) {
      for (const r of nonBomLines) {
        const name = db.items.find(i => i.id === r.materialItemId)?.nameAr || r.materialItemId;
        if (!r.lineReason) {
          return {
            success: false,
            error: `خامة ${r.kind === 'substitute' ? 'بديلة' : 'إضافية'} خارج معادلة التصنيع (${name}) تتطلب سببًا صريحًا يُسجَّل في التدقيق.`,
          };
        }
        if (r.kind === 'substitute') {
          if (!r.substituteForMaterialItemId) {
            return { success: false, error: `الخامة البديلة (${name}) يجب ربطها بالخامة التي تحل محلها من معادلة التصنيع` };
          }
          if (!bomMaterialIds.has(r.substituteForMaterialItemId)) {
            const orig = db.items.find(i => i.id === r.substituteForMaterialItemId)?.nameAr || r.substituteForMaterialItemId;
            return { success: false, error: `الخامة البديلة (${name}) مربوطة بمادة (${orig}) غير موجودة في معادلة التصنيع` };
          }
        }
      }
      const approveGuard = AuthorizationService.enforce('manufacturing', 'approve', {
        userId: params.userId, userName: params.userName,
        isTest: (order as { isTest?: boolean }).isTest,
      });
      if (!approveGuard.allowed) {
        return { success: false, error: `صرف خامات بديلة/إضافية يتطلب صلاحية اعتماد: ${approveGuard.error}` };
      }
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
      baseUnitId: string; issueQty: number; plannedBaseQty: number; tol: number;
      kind: 'bom' | 'substitute' | 'additional';
      lineReason?: string;
      substituteForMaterialItemId?: string;
    };
    const issues: IssueLine[] = [];
    // PROD-05 — plan-vs-issued tolerance: staged issues round line quantities to
    // 3 decimals, and a line unit may differ from the stocked base unit (70 GRAM
    // vs KG), so the permitted slack scales with the conversion factor.
    const PROD_EPS = 0.01;
    for (const req of resolved) {
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
      issues.push({ materialItemId: req.materialItemId, lineQuantity: req.quantity, lineUnitId, baseUnitId, issueQty, plannedBaseQty,
        tol: Number((PROD_EPS + 0.002 * Math.abs(toBaseUnit)).toFixed(6)),
        kind: req.kind, lineReason: req.lineReason || undefined,
        substituteForMaterialItemId: req.substituteForMaterialItemId });
    }

    // ---- PROD-05 — refuse duplicate / over-plan material issues (pre-mutation) ----
    // Net material this order still holds per material = actual issued − returned −
    // approved variance (consumption rows are immutable after issue; returns and
    // approved variance accumulate on them). Rules:
    //   • BOM material: the cumulative issue may never exceed the planned
    //     requirement (small EPS absorbs 3-decimal rounding of staged 40%+60%
    //     issues) — this blocks BOTH a second default issue of an already-issued
    //     plan and any partial issue that would over-consume the plan.
    //   • Exception: an EXPLICIT override issued on a VIRGIN order may exceed the
    //     plan (deliberate extra material, accounted as variance at close — used
    //     by the partial-close test where 140 units are issued against a plan of 110).
    //   • Non-BOM material (no plan): issuing the same quantity again on the same
    //     order is treated as a duplicate.
    // Repeating the operation would double-consume WH-01 and inflate material cost.
    const netByMaterial = new Map<string, number>();
    for (const c of db.productionConsumptions) {
      if (c.productionOrderId !== order.id) continue;
      const net = (Number(c.actualQuantity) || 0)
        - (Number(c.returnedQuantity) || 0)
        - (Number(c.approvedVarianceQuantity) || 0);
      netByMaterial.set(c.materialItemId, (netByMaterial.get(c.materialItemId) || 0) + net);
    }
    for (const iss of issues) {
      const netIssued = netByMaterial.get(iss.materialItemId) || 0;
      const materialName = db.items.find(i => i.id === iss.materialItemId)?.nameAr || iss.materialItemId;
      if (plannedByLineUnit.has(iss.materialItemId)) {
        const virginOverride = isOverrideIssue && netIssued <= PROD_EPS;
        if (!virginOverride && netIssued + iss.issueQty > iss.plannedBaseQty + iss.tol) {
          return {
            success: false,
            error: `صرف مكرر على أمر الإنتاج ${order.orderNumber}: المادة (${materialName}) منصرفة سابقاً ${netIssued} ${iss.baseUnitId}، ومعادلة التصنيع تتطلب ${iss.plannedBaseQty} ${iss.baseUnitId} فقط — لا يُسمح بصرف يتجاوز الخطة أو بإعادة صرف نفس الصرف.`,
          };
        }
      } else if (netIssued > PROD_EPS && netIssued >= iss.issueQty - PROD_EPS) {
        return {
          success: false,
          error: `صرف مكرر على أمر الإنتاج ${order.orderNumber}: المادة (${materialName}) منصرفة مسبقاً بالكمية نفسها (${iss.issueQty} ${iss.baseUnitId}).`,
        };
      }
      netByMaterial.set(iss.materialItemId, netIssued + iss.issueQty);
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
          // ITEM 8 — classification + audit of every issue line.
          issueKind: iss.kind,
          substituteForMaterialItemId: iss.substituteForMaterialItemId,
          issueReason: iss.lineReason,
          issuedByUserId: params.userId,
          issuedByName: params.userName,
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
        description: `صرف مواد خام لأمر الإنتاج ${order.orderNumber} بتكلفة فعلية ${totalActualCost.toLocaleString('ar-EG')} ج.م (FIFO متعدد التشغيلات)`
          + (() => {
              const extras = issues.filter(i => i.kind !== 'bom');
              if (extras.length === 0) return '';
              return ' — ' + extras.map(i =>
                `${i.kind === 'substitute' ? 'خامة بديلة عن ' : 'خامة إضافية: '}`
                + `${db.items.find(x => x.id === i.materialItemId)?.nameAr || i.materialItemId} (${i.issueQty} ${i.baseUnitId})`
                + `${i.lineReason ? ` — السبب: ${i.lineReason}` : ''}`
              ).join('؛ ');
            })(),
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

    // ITEM 11 — the automatic 10% scrap valuation is REMOVED, and ITEM 10 removes
    // the 50% defective valuation plus the injection of finished goods into the
    // raw-materials warehouse. QC-failed output is recorded as QUANTITY only
    // (zero book value): the transfer itself never creates inventory value. The
    // cost of QC-failed units is written off ONCE at closure through qcLossCost
    // → 5104, so GL, batch ledger and totals stay consistent.
    let scrapMoved = 0;
    let defectiveMoved = 0;

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

        const scrapUnitCost = 0; // ITEM 11 — no automatic valuation on transfer
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
        scrapMoved = scrapQty;
      }

      // Record Defective Output if any.
      // ITEM 10 — a FINISHED-product item is NEVER pushed into WH-01 as if it
      // were recovered raw material (that invented inventory value at 50%).
      // Defective output always lands in WH-04 (damaged) as QUANTITY at zero
      // value; real raw-material recovery is recorded separately through
      // ManufacturingEngine.recordRawMaterialRecovery with the actual items,
      // units and quantities recovered.
      if (defectiveQty > 0) {
        const isRecycle = params.defectiveAction === 'to_recycling';
        const targetWh = 'wh-damaged';
        const waste: ProductionWaste = {
          id: generateErpId('wst'),
          productionOrderId: ord.id,
          materialItemId: ord.productId,
          batchNumber,
          quantity: defectiveQty,
          wasteType: isRecycle ? 'recyclable' : 'damaged',
          destinationWarehouseId: targetWh,
          reason: params.wasteReason || (isRecycle
            ? 'معيب مُعلَّن لإعادة التدوير — تُسجَّل استرادة الخامات الفعلية عبر مستند استرداد منفصل'
            : 'معيب تصنيع'),
          actionTaken: params.defectiveAction,
          date: dateStr,
          userId: params.userId,
        };
        draft.productionWastes.push(waste);

        const defUnitCost = 0; // ITEM 10 — no invented 50% value on transfer
        InventoryEngine.recordMovement({
          itemId: ord.productId,
          warehouseId: targetWh,
          movementType: 'scrap',
          date: params.date,
          quantityIn: defectiveQty,
          quantityOut: 0,
          unitCost: defUnitCost,
          documentType: 'توالف إنتاج',
          documentNumber: ord.orderNumber,
          batchNumber,
          notes: isRecycle
            ? 'معيب قابل لإعادة التدوير — بانتظار استرداد الخامات الفعلية بمستند منفصل'
            : 'محول لمستودع التوالف',
        });
        defectiveMoved = defectiveQty;
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

    // ITEM 11 — the PROD-WASTE journal that capitalized 10%/50% of production
    // cost into 1112/1111/1108 on transfer is REMOVED: it created inventory
    // value out of nothing. The QC-failed cost share is written off exactly once
    // by the order-closure entry (qcLossCost → 5104), and the transfers above
    // move QUANTITY at zero value, so batch ledger and GL agree by construction.
    void scrapMoved;
    void defectiveMoved;

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

  // ===================== REMEDIATION — ITEMS 1 / 2 / 3 / 10 =====================

  /**
   * ITEM 1 — edit the PLANNED quantity of an open production order.
   *
   * Allowed ONLY before the first material issue: once a single
   * productionConsumptions row exists, the quantity is frozen for BOTH the UI
   * and this API — a direct API call is rejected here with the same reason.
   * Historical production/issue movements are never touched.
   */
  public static updateProductionOrderQuantity(params: {
    orderId: string;
    newPlannedQuantity: number;
    reason: string;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; error?: string; order?: ProductionOrder } {
    const db = erpDb.getSnapshot();
    const order = db.productionOrders.find(o => o.id === params.orderId);
    if (!order) return { success: false, error: 'أمر الإنتاج غير موجود' };
    if (order.status === 'completed' || order.status === 'cancelled') {
      return { success: false, error: 'لا يمكن تعديل كمية أمر إنتاج مغلق أو ملغى' };
    }
    const guard = AuthorizationService.enforce('manufacturing', 'edit', {
      userId: params.userId, userName: params.userName,
      isTest: params.isTest ?? ((order as { isTest?: boolean }).isTest),
    });
    if (!guard.allowed) return { success: false, error: guard.error };

    const newQty = Number(params.newPlannedQuantity);
    if (!Number.isFinite(newQty) || newQty <= 0) {
      return { success: false, error: 'الكمية المخططة يجب أن تكون رقمًا أكبر من صفر' };
    }
    if (newQty === order.plannedQuantity) {
      return { success: false, error: 'الكمية الجديدة مساوية للكمية الحالية — لا يوجد ما يُعدّل' };
    }
    const reason = (params.reason || '').trim();
    if (!reason) {
      return { success: false, error: 'تعديل الكمية المخططة يتطلب سببًا صريحًا يُسجَّل في سجل التدقيق' };
    }
    const hasIssue = db.productionConsumptions.some(c => c.productionOrderId === order.id);
    if (hasIssue) {
      return {
        success: false,
        error: `لا يمكن تعديل الكمية المخططة لأمر ${order.orderNumber}: تم تسجيل أول صرف خامات لهذا الأمر. `
          + 'الكمية المخططة تُجمَّد بعد أول صرف حمايةً لتاريخ الإنتاج — راجع مسؤول الإنتاج لتصحيح الصرف أو أنشئ أمرًا جديدًا.',
      };
    }

    const from = order.plannedQuantity;
    let updated: ProductionOrder | undefined;
    erpDb.mutate(draft => {
      const ord = draft.productionOrders.find(o => o.id === params.orderId);
      if (!ord) return;
      ord.plannedQuantity = newQty;
      ord.remainingQuantity = Math.max(0, newQty - (ord.producedQuantity || 0));
      ord.quantityEditHistory = [
        ...(ord.quantityEditHistory || []),
        {
          id: generateErpId('qedit'),
          editedAt: new Date().toISOString(),
          userId: guard.userId,
          userName: guard.userName,
          fromQuantity: from,
          toQuantity: newQty,
          reason,
        },
      ];
      updated = ord;
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId,
        userName: guard.userName,
        module: 'إدارة الإنتاج والتكاليف',
        action: 'edit',
        recordId: ord.id,
        description: `تعديل الكمية المخططة لأمر إنتاج ${ord.orderNumber} من ${from} إلى ${newQty} — السبب: ${reason}`,
      });
    });
    return updated ? { success: true, order: updated } : { success: false, error: 'تعذّر تعديل أمر الإنتاج' };
  }

  /**
   * ITEM 2 — read-only per-material issue status for the material-issue screen:
   * the full-plan BOM requirement, net already issued, what remains, and the
   * current WH-01 balance — plus substitute/additional lines issued outside BOM.
   * All quantities are in the item's BASE inventory unit.
   */
  public static getMaterialIssueStatus(orderId: string): Array<{
    materialItemId: string;
    itemNameAr: string;
    unitId: string;
    unitNameAr: string;
    requiredQuantity: number;
    issuedQuantity: number;
    remainingQuantity: number;
    stockBalance: number;
    fromBom: boolean;
    issueKind: 'bom' | 'substitute' | 'additional';
    substituteForMaterialItemId?: string;
  }> {
    const db = erpDb.getSnapshot();
    const order = db.productionOrders.find(o => o.id === orderId);
    if (!order) return [];
    const unitsMap = new Map(db.units.map(u => [u.id, u.nameAr]));
    const rows = db.productionConsumptions.filter(c => c.productionOrderId === orderId);

    const netByMaterial = new Map<string, number>();
    const metaByMaterial = new Map<string, { kind?: 'bom' | 'substitute' | 'additional'; substituteFor?: string }>();
    for (const c of rows) {
      const net = (Number(c.actualQuantity) || 0)
        - (Number(c.returnedQuantity) || 0)
        - (Number(c.approvedVarianceQuantity) || 0);
      netByMaterial.set(c.materialItemId, (netByMaterial.get(c.materialItemId) || 0) + net);
      if (c.issueKind && c.issueKind !== 'bom') {
        metaByMaterial.set(c.materialItemId, { kind: c.issueKind, substituteFor: c.substituteForMaterialItemId });
      }
    }

    const snapshot = order.bomSnapshot;
    const liveBom = db.boms.find(b => b.id === order.bomId);
    const bomLines = snapshot
      ? snapshot.lines
      : db.bomLines.filter(l => l.bomId === order.bomId).map(l => ({
          materialItemId: l.materialItemId, quantityRequired: l.quantityRequired, unitId: l.unitId, wastePercentage: l.wastePercentage,
        }));
    const baseQty = snapshot?.baseQuantity || liveBom?.baseQuantity || 1;
    const scale = order.plannedQuantity / baseQty;

    const out: ReturnType<typeof ManufacturingEngine.getMaterialIssueStatus> = [];
    for (const bl of bomLines) {
      const item = db.items.find(i => i.id === bl.materialItemId);
      const wasteFactor = 1 + ((bl.wastePercentage || 0) / 100);
      let reqBase = bl.quantityRequired * scale * wasteFactor;
      try {
        reqBase *= getUnitConversion(db, bl.unitId, item?.baseUnitId || bl.unitId);
      } catch {
        // no conversion — report the raw requirement, issue path will block anyway
      }
      const issued = netByMaterial.get(bl.materialItemId) || 0;
      const baseUnitId = item?.baseUnitId || bl.unitId;
      out.push({
        materialItemId: bl.materialItemId,
        itemNameAr: item?.nameAr || bl.materialItemId,
        unitId: baseUnitId,
        unitNameAr: unitsMap.get(baseUnitId) || baseUnitId,
        requiredQuantity: Number(reqBase.toFixed(6)),
        issuedQuantity: Number(issued.toFixed(6)),
        remainingQuantity: Number(Math.max(0, reqBase - issued).toFixed(6)),
        stockBalance: InventoryEngine.getItemBalance(bl.materialItemId, 'wh-raw'),
        fromBom: true,
        issueKind: 'bom',
      });
    }
    for (const [mid, meta] of metaByMaterial) {
      if (bomLines.some(b => b.materialItemId === mid)) continue;
      const item = db.items.find(i => i.id === mid);
      const issued = netByMaterial.get(mid) || 0;
      out.push({
        materialItemId: mid,
        itemNameAr: item?.nameAr || mid,
        unitId: item?.baseUnitId || 'unit-kg',
        unitNameAr: unitsMap.get(item?.baseUnitId || 'unit-kg') || '',
        requiredQuantity: 0,
        issuedQuantity: Number(issued.toFixed(6)),
        remainingQuantity: 0,
        stockBalance: InventoryEngine.getItemBalance(mid, 'wh-raw'),
        fromBom: false,
        issueKind: meta.kind || 'additional',
        substituteForMaterialItemId: meta.substituteFor,
      });
    }
    return out;
  }

  /**
   * ITEM 3 — distribute a monthly payroll / supervision cost over the production
   * orders that actually produced in the period.
   *
   * Accounting (per order share, so each order carries ONLY its share):
   *   Dr 5105/5109 (mapped variance account of the cost type)
   *   Cr 2104 accrued (or 6101 when the salary was ALREADY recognized as an
   *     expense — `alreadyRecognized`, a reclassification, never a second
   *     recognition).
   * Each share is posted with sourceDocumentType 'production_conversion_cost'
   * + sourceDocumentId = orderId, which is exactly how calculateCostBreakdown
   * and closeProductionOrder read conversion costs — so standard vs actual vs
   * variance keep working with no second costing engine.
   *
   * Allocation basis: produced quantity per order from production_output
   * transactions in the period, in a single common unit. Mixed units that have
   * no configured conversion BLOCK the distribution (never summed silently).
   * One distribution per (period, costType) — re-posting is rejected.
   */
  public static distributeProductionPayroll(params: {
    period: string; // YYYY-MM
    costType: 'direct_labor' | 'supervision';
    totalAmount: number;
    sourceDescription: string;
    date?: string; // posting date (defaults to today)
    /** true when the payroll was already recognized on 6101 → reclassify instead of accruing. */
    alreadyRecognized?: boolean;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; error?: string; distribution?: import('../types/erp').ProductionPayrollDistribution } {
    const guard = AuthorizationService.enforce('manufacturing', 'post', {
      userId: params.userId, userName: params.userName, isTest: params.isTest,
    });
    if (!guard.allowed) return { success: false, error: guard.error };

    if (!/^\d{4}-\d{2}$/.test(params.period || '')) {
      return { success: false, error: 'الفترة يجب أن تكون بصيغة YYYY-MM (مثال: 2026-10)' };
    }
    const amount = Number(params.totalAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, error: 'مبلغ التوزيع يجب أن يكون رقمًا أكبر من صفر' };
    }
    const source = (params.sourceDescription || '').trim();
    if (!source) {
      return { success: false, error: 'يجب توثيق مصدر المبلغ (مرتبات رقم / مستند) قبل التوزيع' };
    }

    const db = erpDb.getSnapshot();
    const existing = (db.payrollDistributions || []).find(
      d => d.period === params.period && d.costType === params.costType && d.status === 'posted'
    );
    if (existing) {
      return {
        success: false,
        error: `تم تحميل تكاليف ${params.costType === 'direct_labor' ? 'العمالة المباشرة' : 'الإشراف'} للفترة ${params.period} مسبقًا `
          + `(${existing.distributionNumber} بمبلغ ${existing.totalAmount} ج.م). لا يُسمح بتكرار تحميل الفترة والنوع — عدّل أو اعكس التوزيع السابق أولًا.`,
      };
    }

    // ---- produced quantity per order in the period (single pass) ----
    const qtyByOrder = new Map<string, number>();
    for (const t of db.inventoryTransactions) {
      if (t.movementType !== 'production_output') continue;
      if (!String(t.date || '').startsWith(params.period)) continue;
      if (t.isTest && !params.isTest) continue;
      const order = db.productionOrders.find(o => o.orderNumber === t.documentNumber);
      if (!order) continue;
      if (order.status === 'cancelled') continue;
      qtyByOrder.set(order.id, (qtyByOrder.get(order.id) || 0) + (Number(t.quantityIn) || 0));
    }
    const participating = [...qtyByOrder.entries()]
      .map(([id, qty]) => ({ order: db.productionOrders.find(o => o.id === id)!, qty }))
      .filter(x => !!x.order && x.qty > 0);
    if (participating.length === 0) {
      return {
        success: false,
        error: `لا توجد كمية إنتاج صالحة للتوزيع في الفترة ${params.period}: مبلغ ${amount} ج.م `
          + 'لم يُوزَّع على أي أمر إنتاج (لم يُسجَّل إنتاج فعلي هذا الشهر). لم يُرحّل أي قيد.',
      };
    }

    // ---- heterogeneous units: convert to one common unit or BLOCK ----
    const unitOf = (productId: string) => db.items.find(i => i.id === productId)?.baseUnitId || '';
    const commonUnit = unitOf(participating[0].order.productId);
    const converted: Array<{ order: ProductionOrder; qty: number }> = [];
    for (const p of participating) {
      const u = unitOf(p.order.productId);
      let qty = p.qty;
      if (u !== commonUnit) {
        try {
          qty = p.qty * getUnitConversion(db, u, commonUnit);
        } catch {
          return {
            success: false,
            error: `لا يمكن توزيع رواتب الإنتاج للفترة ${params.period}: أصناف بوحدات قياس مختلفة لا يوجد بينها معامل تحويل `
              + `(${u} ← ${commonUnit}) للمعدّل ${p.order.orderNumber}. لا تُجمع كميات غير متجانسة دون تحويل موثوق — أدخل تحويل وحدات أو وزّع يدويًا بأمر لكل أمر.`,
          };
        }
      }
      converted.push({ order: p.order, qty });
    }
    const totalBasis = converted.reduce((s, c) => s + c.qty, 0);
    if (!(totalBasis > 0)) {
      return { success: false, error: 'كمية الإنتاج أساس التوزيع تساوي صفر — ممنوع التوزيع الصامت' };
    }

    // ---- allocation with exact 2-decimal rounding (largest remainder) ----
    const costTypeLabel = params.costType === 'direct_labor' ? 'عمالة مباشرة' : 'إشراف إنتاج';
    const expenseKey = params.costType === 'direct_labor' ? 'variance_direct_labor' : 'variance_overhead';
    const expenseFallback = params.costType === 'direct_labor' ? 'acc-5105' : 'acc-5109';
    const creditKey = params.alreadyRecognized ? 'expenses_default' : 'conversion_cost_payable';
    const creditFallback = params.alreadyRecognized ? 'acc-6101' : 'acc-2104';
    const expenseAccId = AccountingEngine.getMappedAccountId(expenseKey, expenseFallback);
    const creditAccId = AccountingEngine.getMappedAccountId(creditKey, creditFallback);
    const expenseAcc = db.accounts.find(a => a.id === expenseAccId);
    const creditAcc = db.accounts.find(a => a.id === creditAccId);
    if (!expenseAcc || expenseAcc.isHeader) return { success: false, error: 'حساب تكلفة التوزيع غير صالح بدليل الحسابات' };
    if (!creditAcc || creditAcc.isHeader) return { success: false, error: 'حساب الجانب الدائن للتوزيع غير صالح بدليل الحسابات' };

    const raw = converted.map(c => ({ ...c, ratio: c.qty / totalBasis, amount: (amount * c.qty) / totalBasis }));
    const floors = raw.map(r => Math.floor(r.amount * 100) / 100);
    let remainderCents = Math.round(amount * 100) - Math.round(floors.reduce((s, f) => s + f, 0) * 100);
    const orderOfRemainder = raw
      .map((r, i) => ({ i, frac: r.amount - floors[i] }))
      .sort((a, b) => b.frac - a.frac);
    const allocated = [...floors];
    for (let k = 0; remainderCents > 0 && k < orderOfRemainder.length; k++) {
      const idx = orderOfRemainder[k].i;
      allocated[idx] = Number((allocated[idx] + 0.01).toFixed(2));
      remainderCents -= 1;
    }
    const sumAllocated = Number(allocated.reduce((s, a) => s + a, 0).toFixed(2));
    if (Math.abs(sumAllocated - amount) > 0.005) {
      return { success: false, error: 'تعذّر تحقيق مطابقة توزيع رواتب الإنتاج: مجموع النسب لا يساوي المبلغ القابل للتوزيع' };
    }

    const postingDate = params.date || new Date().toISOString().split('T')[0];
    const distNumber = nextDocNumber(
      db as unknown as { [k: string]: unknown }, 'payrollDistributions', 'PAYDIST', 5, 'distributionNumber'
    );
    const allocations: import('../types/erp').ProductionPayrollDistribution['allocations'] = [];
    const journalIds: string[] = [];

    for (let i = 0; i < raw.length; i++) {
      const share = allocated[i];
      if (share <= 0) continue;
      const ord = raw[i].order;
      const desc = `${costTypeLabel} — حصة أمر إنتاج ${ord.orderNumber} من رواتب الفترة ${params.period}`;
      const lines: JournalLine[] = [
        {
          id: '', journalEntryId: '',
          accountId: expenseAcc.id, accountCode: expenseAcc.code, accountNameAr: expenseAcc.nameAr,
          debit: share, credit: 0, currency: 'EGP' as const,
          originalAmount: share, exchangeRate: 1, costCenterId: 'cc-prod',
          description: desc,
        },
        {
          id: '', journalEntryId: '',
          accountId: creditAcc.id, accountCode: creditAcc.code, accountNameAr: creditAcc.nameAr,
          debit: 0, credit: share, currency: 'EGP' as const,
          originalAmount: share, exchangeRate: 1, costCenterId: 'cc-prod',
          description: desc,
        },
      ];
      const jv = AccountingEngine.postJournal({
        date: postingDate,
        reference: `PAYROLL-${params.period}-${params.costType}-${ord.orderNumber}`,
        description: `${desc} — المصدر: ${source}`,
        sourceDocumentType: 'production_conversion_cost',
        sourceDocumentId: ord.id,
        lines,
      }, guard.userId, guard.userName, params.isTest);
      if (!jv.success || !jv.entry) {
        return { success: false, error: `تعذر ترحيل حصة أمر ${ord.orderNumber}: ${jv.error}` };
      }
      journalIds.push(jv.entry.id);
      allocations.push({
        productionOrderId: ord.id,
        productionOrderNumber: ord.orderNumber,
        basisQuantity: Number(raw[i].qty.toFixed(6)),
        ratio: Number((raw[i].ratio).toFixed(6)),
        allocatedAmount: share,
        journalEntryId: jv.entry.id,
      });
    }

    const distribution: import('../types/erp').ProductionPayrollDistribution = {
      id: generateErpId('payd'),
      distributionNumber: distNumber,
      period: params.period,
      costType: params.costType,
      costTypeNameAr: costTypeLabel,
      totalAmount: amount,
      sourceDescription: source,
      allocations,
      status: 'posted',
      postedAt: new Date().toISOString(),
      userId: guard.userId,
      userName: guard.userName,
      isTest: params.isTest,
    };
    erpDb.mutate(draft => {
      draft.payrollDistributions.push(distribution);
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId,
        userName: guard.userName,
        module: 'إدارة الإنتاج والتكاليف',
        action: 'post',
        recordId: distribution.id,
        description: `توزيع ${costTypeLabel} للفترة ${params.period} بمبلغ ${amount} ج.م على ${allocations.length} أمر إنتاج — المصدر: ${source}`,
      });
    });

    return { success: true, distribution };
  }

  /**
   * ITEM 10 — documented recovery of REAL raw materials back into WH-01
   * (e.g. material actually reclaimed from a defective run).
   *
   * The user states the actual items/quantities recovered — nothing is
   * invented, no percentage applies, and a finished-product item can never be
   * pushed into the raw warehouse. Journal when the recovered material carries
   * book value: Dr 1108 | Cr 5104 (recovery of material previously written
   * off), so the inventory increase is always supported by an entry.
   */
  public static recordRawMaterialRecovery(params: {
    orderId: string;
    lines: Array<{ materialItemId: string; quantity: number; unitId?: string }>;
    reason: string;
    date: string;
    userId: string;
    userName: string;
    isTest?: boolean;
  }): { success: boolean; error?: string; journalEntryId?: string; totalRecoveredCost?: number } {
    const db = erpDb.getSnapshot();
    const order = db.productionOrders.find(o => o.id === params.orderId);
    if (!order) return { success: false, error: 'أمر الإنتاج غير موجود' };
    if (order.status === 'completed' || order.status === 'cancelled') {
      return { success: false, error: 'لا يمكن تسجيل استرداد خامات على أمر إنتاج مغلق أو ملغى' };
    }
    const guard = AuthorizationService.enforce('manufacturing', 'approve', {
      userId: params.userId, userName: params.userName,
      isTest: params.isTest ?? ((order as { isTest?: boolean }).isTest),
    });
    if (!guard.allowed) return { success: false, error: guard.error };
    const reason = (params.reason || '').trim();
    if (!reason) return { success: false, error: 'استرداد الخامات يتطلب سببًا موثقًا صريحًا' };
    if (!params.lines || params.lines.length === 0) {
      return { success: false, error: 'يجب إدخال الأصناف والوحدات والكميات الحقيقية المستردة' };
    }

    type Prepared = { item: Item; qtyBase: number; unitCost: number };
    const prepared: Prepared[] = [];
    for (const l of params.lines) {
      const item = db.items.find(i => i.id === l.materialItemId);
      if (!item) return { success: false, error: `مادة مستردة غير مسجلة (${l.materialItemId})` };
      if (item.itemType === 'finished_product') {
        return { success: false, error: `لا يمكن استرادة منتج تام (${item.nameAr}) كمادة خام — سجّل الإنتاج المعيب في مستودع التوالف بدلًا من ذلك` };
      }
      const qty = Number(l.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return { success: false, error: `كمية الاسترادة يجب أن تكون أكبر من صفر (${item.nameAr})` };
      }
      let qtyBase = qty;
      if (l.unitId && l.unitId !== item.baseUnitId) {
        try {
          qtyBase = qty * getUnitConversion(db, l.unitId, item.baseUnitId);
        } catch (e) {
          return { success: false, error: `لا يوجد معامل تحويل وحدة للاسترداد (${item.nameAr}): ${(e as Error).message}` };
        }
      }
      // Book value of the recovered material: documented/standard cost only.
      const unitCost = Number((item.actualCost || item.standardCost || 0));
      prepared.push({ item, qtyBase: Number(qtyBase.toFixed(6)), unitCost });
    }
    const totalRecoveredCost = prepared.reduce((s, p) => s + p.qtyBase * p.unitCost, 0);
    const dateStr = params.date || new Date().toISOString().split('T')[0];

    // Physical recovery into WH-01 at the documented cost (0 when none exists —
    // a zero-cost movement is legal; a value is NEVER invented).
    for (const p of prepared) {
      const move = InventoryEngine.recordMovement({
        itemId: p.item.id,
        warehouseId: 'wh-raw',
        movementType: 'production_return',
        date: dateStr,
        quantityIn: p.qtyBase,
        quantityOut: 0,
        unitCost: p.unitCost,
        documentType: 'استرداد خامات من إنتاج معيب',
        documentNumber: order.orderNumber,
        notes: `استرداد ${p.qtyBase} ${p.item.baseUnitId} من (${p.item.nameAr}) لأمر ${order.orderNumber} — ${reason}`,
        isTest: params.isTest ?? ((order as { isTest?: boolean }).isTest),
      } as never);
      if (!move.success) return { success: false, error: move.error };
    }

    let journalEntryId: string | undefined;
    if (totalRecoveredCost > 0.01) {
      const rawAccId = AccountingEngine.getMappedAccountId('purchase_raw_inventory', 'acc-1108');
      const varAccId = AccountingEngine.getMappedAccountId('variance_material_quantity', 'acc-5104');
      const rawAcc = db.accounts.find(a => a.id === rawAccId);
      const varAcc = db.accounts.find(a => a.id === varAccId);
      if (!rawAcc || rawAcc.isHeader || !varAcc || varAcc.isHeader) {
        return { success: false, error: 'حسابات المخزون أو الفروق غير صالحة بدليل الحسابات — تعذر إثبات الاسترداد' };
      }
      const cost = Number(totalRecoveredCost.toFixed(2));
      const desc = `استرداد خامات فعلية لأمر إنتاج ${order.orderNumber} — ${reason}`;
      const jv = AccountingEngine.postJournal({
        date: dateStr,
        reference: `RECOVER-${order.orderNumber}`,
        description: desc,
        sourceDocumentType: 'production_material_recovery',
        sourceDocumentId: order.id,
        lines: [
          {
            id: '', journalEntryId: '', accountId: rawAcc.id, accountCode: rawAcc.code, accountNameAr: rawAcc.nameAr,
            debit: cost, credit: 0, currency: 'EGP' as const, originalAmount: cost, exchangeRate: 1,
            costCenterId: 'cc-prod', description: desc,
          },
          {
            id: '', journalEntryId: '', accountId: varAcc.id, accountCode: varAcc.code, accountNameAr: varAcc.nameAr,
            debit: 0, credit: cost, currency: 'EGP' as const, originalAmount: cost, exchangeRate: 1,
            costCenterId: 'cc-prod', description: `تخفيض فروق الكميات باسترداد مواد فعلية — ${reason}`,
          },
        ],
      }, params.userId, params.userName, params.isTest);
      if (!jv.success || !jv.entry) return { success: false, error: jv.error };
      journalEntryId = jv.entry.id;
    }

    erpDb.mutate(draft => {
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: params.userId,
        userName: params.userName,
        module: 'إدارة الإنتاج والتكاليف',
        action: 'post',
        recordId: order.id,
        description: `استرداد خامات لأمر إنتاج ${order.orderNumber}: `
          + prepared.map(p => `${p.item.nameAr} ${p.qtyBase} ${p.item.baseUnitId}`).join('، ')
          + ` — السبب: ${reason} — القيمة ${totalRecoveredCost.toFixed(2)} ج.م`,
      } as never);
    });
    return { success: true, journalEntryId, totalRecoveredCost };
  }
}
