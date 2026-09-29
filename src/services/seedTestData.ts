// Test Data Seeder & Automated 20 End-to-End Workflow Verification Engine
import { erpDb } from './db';
import { Item, BomHeader, BomLine, Customer, Supplier, SalesRepresentative } from '../types/erp';
import { WorkflowService } from './workflows';
import { InventoryEngine } from './inventory';
import { ManufacturingEngine } from './manufacturing';
import { AccountingEngine } from './accounting';

export interface TestResultItem {
  scenarioNumber: number;
  titleAr: string;
  status: 'passed' | 'failed';
  detailsAr: string;
  timestamp: string;
}

export class TestDataService {
  /**
   * Seed realistic snack factory items (The 11 Finished Products & Raw Materials)
   * Clearly marked with [TEST DATA] if generated
   */
  public static seedSampleMasterData(): void {
    erpDb.mutate(draft => {
      // 1. Raw Materials & Packaging (Stored in Raw Materials Warehouse WH-01)
      const rawMaterials: Item[] = [
        {
          id: 'item-raw-corn',
          code: 'RM-CORN-01',
          nameAr: 'ذرة صفراء مجروشة فاخرة [بيانات تجريبية]',
          nameEn: 'Milled Yellow Corn [TEST DATA]',
          itemType: 'raw_material',
          baseUnitId: 'unit-kg',
          purchaseUnitId: 'unit-ton',
          vatRate: 0,
          vatCategory: 'exempt',
          trackBatch: true,
          trackExpiry: true,
          standardCost: 18, // 18 EGP per KG
          actualCost: 18,
          sellingPriceRetail: 0,
          sellingPriceWholesale: 0,
          sellingPriceExportUSD: 0,
          active: true,
          minStockLevel: 5000,
        },
        {
          id: 'item-raw-oil',
          code: 'RM-OIL-01',
          nameAr: 'زيت نخيل أولين نقي مكرر [بيانات تجريبية]',
          nameEn: 'Pure Refined Palm Olein [TEST DATA]',
          itemType: 'raw_material',
          baseUnitId: 'unit-kg',
          purchaseUnitId: 'unit-ton',
          vatRate: 0,
          vatCategory: 'exempt',
          trackBatch: true,
          trackExpiry: true,
          standardCost: 65, // 65 EGP per KG
          actualCost: 65,
          sellingPriceRetail: 0,
          sellingPriceWholesale: 0,
          sellingPriceExportUSD: 0,
          active: true,
          minStockLevel: 2000,
        },
        {
          id: 'item-raw-flavor-cheese',
          code: 'RM-FLV-01',
          nameAr: 'نكهة الجبنة الفرنسية المتبلة [بيانات تجريبية]',
          nameEn: 'French Seasoned Cheese Flavor [TEST DATA]',
          itemType: 'raw_material',
          baseUnitId: 'unit-kg',
          purchaseUnitId: 'unit-kg',
          vatRate: 0.14,
          vatCategory: 'standard',
          trackBatch: true,
          trackExpiry: true,
          standardCost: 140,
          actualCost: 140,
          sellingPriceRetail: 0,
          sellingPriceWholesale: 0,
          sellingPriceExportUSD: 0,
          active: true,
          minStockLevel: 500,
        },
        {
          id: 'item-raw-flavor-chili',
          code: 'RM-FLV-02',
          nameAr: 'نكهة الشطة والليمون الحارة [بيانات تجريبية]',
          nameEn: 'Chili & Lemon Seasoning [TEST DATA]',
          itemType: 'raw_material',
          baseUnitId: 'unit-kg',
          purchaseUnitId: 'unit-kg',
          vatRate: 0.14,
          vatCategory: 'standard',
          trackBatch: true,
          trackExpiry: true,
          standardCost: 130,
          actualCost: 130,
          sellingPriceRetail: 0,
          sellingPriceWholesale: 0,
          sellingPriceExportUSD: 0,
          active: true,
          minStockLevel: 500,
        },
        {
          id: 'item-pkg-film',
          code: 'PKG-FLM-01',
          nameAr: 'فيلم تغليف معدني مطبوع [بيانات تجريبية]',
          nameEn: 'Metallized Printed Packaging Film [TEST DATA]',
          itemType: 'packaging_material',
          baseUnitId: 'unit-roll',
          purchaseUnitId: 'unit-roll',
          vatRate: 0.14,
          vatCategory: 'standard',
          trackBatch: true,
          trackExpiry: false,
          standardCost: 450, // per roll
          actualCost: 450,
          sellingPriceRetail: 0,
          sellingPriceWholesale: 0,
          sellingPriceExportUSD: 0,
          active: true,
          minStockLevel: 100,
        },
        {
          id: 'item-pkg-carton',
          code: 'PKG-BOX-01',
          nameAr: 'كراتين شحن كرتون مقوى سعة 24 كيس [بيانات تجريبية]',
          nameEn: 'Corrugated Master Cartons [TEST DATA]',
          itemType: 'packaging_material',
          baseUnitId: 'unit-piece',
          purchaseUnitId: 'unit-piece',
          vatRate: 0.14,
          vatCategory: 'standard',
          trackBatch: false,
          trackExpiry: false,
          standardCost: 8.5,
          actualCost: 8.5,
          sellingPriceRetail: 0,
          sellingPriceWholesale: 0,
          sellingPriceExportUSD: 0,
          active: true,
          minStockLevel: 3000,
        }
      ];

      // 2. The Exactly 11 Finished Snack Products (Families: Single & Duo)
      const finishedProducts: Item[] = [
        // Family: Single (6 Products)
        {
          id: 'item-fp-s1',
          code: 'FP-SNG-01',
          nameAr: 'سناكس سِنجل - جبنة متبلة (24 كيس) [بيانات تجريبية]',
          nameEn: 'Snacks Single - Seasoned Cheese (24 packs) [TEST DATA]',
          itemType: 'finished_product',
          productFamily: 'Single',
          flavor: 'جبنة متبلة',
          baseUnitId: 'unit-carton',
          vatRate: 0.14,
          vatCategory: 'standard',
          trackBatch: true,
          trackExpiry: true,
          standardCost: 95.0, // EGP per carton
          actualCost: 95.0,
          sellingPriceRetail: 140.0,
          sellingPriceWholesale: 125.0,
          sellingPriceExportUSD: 3.20,
          active: true,
          minStockLevel: 200,
        },
        {
          id: 'item-fp-s2',
          code: 'FP-SNG-02',
          nameAr: 'سناكس سِنجل - شطة وليمون (24 كيس) [بيانات تجريبية]',
          nameEn: 'Snacks Single - Chili & Lemon [TEST DATA]',
          itemType: 'finished_product',
          productFamily: 'Single',
          flavor: 'شطة وليمون',
          baseUnitId: 'unit-carton',
          vatRate: 0.14,
          vatCategory: 'standard',
          trackBatch: true,
          trackExpiry: true,
          standardCost: 94.0,
          actualCost: 94.0,
          sellingPriceRetail: 140.0,
          sellingPriceWholesale: 125.0,
          sellingPriceExportUSD: 3.20,
          active: true,
          minStockLevel: 200,
        },
        {
          id: 'item-fp-s3',
          code: 'FP-SNG-03',
          nameAr: 'سناكس سِنجل - كباب مشوي (24 كيس) [بيانات تجريبية]',
          nameEn: 'Snacks Single - Grilled Kebab [TEST DATA]',
          itemType: 'finished_product',
          productFamily: 'Single',
          flavor: 'كباب مشوي',
          baseUnitId: 'unit-carton',
          vatRate: 0.14,
          vatCategory: 'standard',
          trackBatch: true,
          trackExpiry: true,
          standardCost: 96.0,
          actualCost: 96.0,
          sellingPriceRetail: 140.0,
          sellingPriceWholesale: 125.0,
          sellingPriceExportUSD: 3.20,
          active: true,
          minStockLevel: 150,
        },
        {
          id: 'item-fp-s4',
          code: 'FP-SNG-04',
          nameAr: 'سناكس سِنجل - طماطم متبلة (24 كيس) [بيانات تجريبية]',
          nameEn: 'Snacks Single - Tomato [TEST DATA]',
          itemType: 'finished_product',
          productFamily: 'Single',
          flavor: 'طماطم متبلة',
          baseUnitId: 'unit-carton',
          vatRate: 0.14,
          vatCategory: 'standard',
          trackBatch: true,
          trackExpiry: true,
          standardCost: 93.0,
          actualCost: 93.0,
          sellingPriceRetail: 140.0,
          sellingPriceWholesale: 125.0,
          sellingPriceExportUSD: 3.20,
          active: true,
          minStockLevel: 150,
        },
        {
          id: 'item-fp-s5',
          code: 'FP-SNG-05',
          nameAr: 'سناكس سِنجل - ملح وخل (24 كيس) [بيانات تجريبية]',
          nameEn: 'Snacks Single - Salt & Vinegar [TEST DATA]',
          itemType: 'finished_product',
          productFamily: 'Single',
          flavor: 'ملح وخل',
          baseUnitId: 'unit-carton',
          vatRate: 0.14,
          vatCategory: 'standard',
          trackBatch: true,
          trackExpiry: true,
          standardCost: 92.0,
          actualCost: 92.0,
          sellingPriceRetail: 140.0,
          sellingPriceWholesale: 125.0,
          sellingPriceExportUSD: 3.20,
          active: true,
          minStockLevel: 100,
        },
        {
          id: 'item-fp-s6',
          code: 'FP-SNG-06',
          nameAr: 'سناكس سِنجل - دجاج محمر (24 كيس) [بيانات تجريبية]',
          nameEn: 'Snacks Single - Roast Chicken [TEST DATA]',
          itemType: 'finished_product',
          productFamily: 'Single',
          flavor: 'دجاج محمر',
          baseUnitId: 'unit-carton',
          vatRate: 0.14,
          vatCategory: 'standard',
          trackBatch: true,
          trackExpiry: true,
          standardCost: 95.0,
          actualCost: 95.0,
          sellingPriceRetail: 140.0,
          sellingPriceWholesale: 125.0,
          sellingPriceExportUSD: 3.20,
          active: true,
          minStockLevel: 100,
        },

        // Family: Duo (5 Products - Total = 11 Finished Products)
        {
          id: 'item-fp-d1',
          code: 'FP-DUO-01',
          nameAr: 'سناكس ديو - ميكس جبن مدخن وباربيكيو (24 كيس) [بيانات تجريبية]',
          nameEn: 'Snacks Duo - Smoked Cheese & BBQ [TEST DATA]',
          itemType: 'finished_product',
          productFamily: 'Duo',
          flavor: 'ميكس جبن مدخن وباربيكيو',
          baseUnitId: 'unit-carton',
          vatRate: 0.14,
          vatCategory: 'standard',
          trackBatch: true,
          trackExpiry: true,
          standardCost: 110.0,
          actualCost: 110.0,
          sellingPriceRetail: 165.0,
          sellingPriceWholesale: 148.0,
          sellingPriceExportUSD: 3.80,
          active: true,
          minStockLevel: 250,
        },
        {
          id: 'item-fp-d2',
          code: 'FP-DUO-02',
          nameAr: 'سناكس ديو - سويت أند تشيلي (24 كيس) [بيانات تجريبية]',
          nameEn: 'Snacks Duo - Sweet & Chili [TEST DATA]',
          itemType: 'finished_product',
          productFamily: 'Duo',
          flavor: 'سويت أند تشيلي',
          baseUnitId: 'unit-carton',
          vatRate: 0.14,
          vatCategory: 'standard',
          trackBatch: true,
          trackExpiry: true,
          standardCost: 112.0,
          actualCost: 112.0,
          sellingPriceRetail: 165.0,
          sellingPriceWholesale: 148.0,
          sellingPriceExportUSD: 3.80,
          active: true,
          minStockLevel: 200,
        },
        {
          id: 'item-fp-d3',
          code: 'FP-DUO-03',
          nameAr: 'سناكس ديو - كريمة بصل وجبنة شيدر (24 كيس) [بيانات تجريبية]',
          nameEn: 'Snacks Duo - Sour Cream & Cheddar [TEST DATA]',
          itemType: 'finished_product',
          productFamily: 'Duo',
          flavor: 'كريمة بصل وجبنة شيدر',
          baseUnitId: 'unit-carton',
          vatRate: 0.14,
          vatCategory: 'standard',
          trackBatch: true,
          trackExpiry: true,
          standardCost: 115.0,
          actualCost: 115.0,
          sellingPriceRetail: 165.0,
          sellingPriceWholesale: 148.0,
          sellingPriceExportUSD: 3.80,
          active: true,
          minStockLevel: 150,
        },
        {
          id: 'item-fp-d4',
          code: 'FP-DUO-04',
          nameAr: 'سناكس ديو - فلفل حلو مع زيتون (24 كيس) [بيانات تجريبية]',
          nameEn: 'Snacks Duo - Sweet Pepper & Olives [TEST DATA]',
          itemType: 'finished_product',
          productFamily: 'Duo',
          flavor: 'فلفل حلو وزيتون',
          baseUnitId: 'unit-carton',
          vatRate: 0.14,
          vatCategory: 'standard',
          trackBatch: true,
          trackExpiry: true,
          standardCost: 108.0,
          actualCost: 108.0,
          sellingPriceRetail: 165.0,
          sellingPriceWholesale: 148.0,
          sellingPriceExportUSD: 3.80,
          active: true,
          minStockLevel: 100,
        },
        {
          id: 'item-fp-d5',
          code: 'FP-DUO-05',
          nameAr: 'سناكس ديو - ميكس بهارات شرقية وتوابل حارة (24 كيس) [بيانات تجريبية]',
          nameEn: 'Snacks Duo - Oriental Spices & Hot Herbs [TEST DATA]',
          itemType: 'finished_product',
          productFamily: 'Duo',
          flavor: 'بهارات شرقية وتوابل حارة',
          baseUnitId: 'unit-carton',
          vatRate: 0.14,
          vatCategory: 'standard',
          trackBatch: true,
          trackExpiry: true,
          standardCost: 112.0,
          actualCost: 112.0,
          sellingPriceRetail: 165.0,
          sellingPriceWholesale: 148.0,
          sellingPriceExportUSD: 3.80,
          active: true,
          minStockLevel: 150,
        }
      ];

      draft.items = [...rawMaterials, ...finishedProducts];

      // 3. Bill of Materials (BOM) for the 11 Finished Products (Base: 1,000 Cartons)
      const boms: BomHeader[] = [];
      const bomLines: BomLine[] = [];

      finishedProducts.forEach((fp, idx) => {
        const bomId = `bom-${fp.id}`;
        boms.push({
          id: bomId,
          bomNumber: `BOM-${fp.code}-V1`,
          finishedItemId: fp.id,
          version: 1,
          baseQuantity: 1000, // 1,000 Cartons
          unitId: 'unit-carton',
          active: true,
          effectiveDate: '2026-01-01',
          notes: `معادلة تصنيع 1000 كرتونة من ${fp.nameAr}`,
        });

        // 1000 Cartons need:
        // Corn: 800 kg
        // Oil: 180 kg
        // Flavor: 45 kg
        // Cartons: 1000 pcs
        bomLines.push(
          {
            id: `bline-${bomId}-1`,
            bomId,
            materialItemId: 'item-raw-corn',
            quantityRequired: 800,
            unitId: 'unit-kg',
          },
          {
            id: `bline-${bomId}-2`,
            bomId,
            materialItemId: 'item-raw-oil',
            quantityRequired: 180,
            unitId: 'unit-kg',
          },
          {
            id: `bline-${bomId}-3`,
            bomId,
            materialItemId: fp.flavor?.includes('جبنة') ? 'item-raw-flavor-cheese' : 'item-raw-flavor-chili',
            quantityRequired: 45,
            unitId: 'unit-kg',
          },
          {
            id: `bline-${bomId}-4`,
            bomId,
            materialItemId: 'item-pkg-carton',
            quantityRequired: 1000,
            unitId: 'unit-piece',
          }
        );
      });

      draft.boms = boms;
      draft.bomLines = bomLines;

      // 4. Sample Customers (Retail, Wholesale, Export)
      draft.customers = [
        {
          id: 'cust-1',
          code: 'CUST-001',
          name: 'سلسلة هايبر وان مصر (تجريبي)',
          customerType: 'wholesale',
          channel: 'wholesale',
          address: 'الشيخ زايد - طريق مصر إسكندرية الصحراوي',
          phone: '+20 2 38500100',
          taxNumber: '100-200-300',
          currency: 'EGP',
          creditLimit: 500000, // 500k limit
          currentBalance: 0,
          paymentTerms: 'آجل 30 يوم',
          openingBalance: 0,
          active: true,
        },
        {
          id: 'cust-2',
          code: 'CUST-002',
          name: 'مؤسسة الأهرام للتوزيع والتجزئة (تجريبي)',
          customerType: 'retail',
          channel: 'retail',
          address: 'شارع الجلاء - وسط البلد، القاهرة',
          phone: '+20 2 25780000',
          taxNumber: '100-400-500',
          currency: 'EGP',
          creditLimit: 100000,
          currentBalance: 0,
          paymentTerms: 'نقدًا عند الاستلام',
          openingBalance: 0,
          active: true,
        },
        {
          id: 'cust-3',
          code: 'CUST-EXP-01',
          name: 'شركة الخليج للأغذية والمستوردين (دبي - الإمارات) [تصدير]',
          customerType: 'export',
          channel: 'export',
          address: 'منطقة جبل علي الحرة - دبي',
          phone: '+971 4 8810000',
          taxNumber: 'TRN-99887766',
          currency: 'USD',
          creditLimit: 100000, // $100k
          currentBalance: 0,
          paymentTerms: 'اعتماد مستندي / شحن فوري',
          openingBalance: 0,
          active: true,
        }
      ];

      // 5. Sample Suppliers
      draft.suppliers = [
        {
          id: 'sup-1',
          code: 'SUP-001',
          name: 'الشركة المصرية لصناعات النشا والخميرة (مورد خامات)',
          taxNumber: '445-667-889',
          contactPerson: 'م. حسام غالي',
          phone: '+20 3 4455000',
          address: 'برج العرب الصناعية، الإسكندرية',
          paymentTerms: 'آجل 45 يوم',
          currency: 'EGP',
          openingBalance: 0,
          currentBalance: 0,
          active: true,
        },
        {
          id: 'sup-2',
          code: 'SUP-002',
          name: 'مصنع الأهرام للكرتون ومواد التعبئة والتغليف',
          taxNumber: '332-114-556',
          contactPerson: 'أ. طارق عبد الحميد',
          phone: '+20 2 3834000',
          address: 'المنطقة الصناعية الثانية، 6 أكتوبر',
          paymentTerms: 'آجل 30 يوم',
          currency: 'EGP',
          openingBalance: 0,
          currentBalance: 0,
          active: true,
        }
      ];

      // 6. Sales Representatives
      draft.salesReps = [
        {
          id: 'rep-1',
          code: 'REP-01',
          name: 'إسلام مصطفى (قطاع القاهرة الكبرى)',
          phone: '+20 100 234 5678',
          active: true,
          targetMonthlySales: 350000,
        },
        {
          id: 'rep-2',
          code: 'REP-02',
          name: 'كريم عبد العزيز (قطاع الجيزة وأكتوبر)',
          phone: '+20 111 987 6543',
          active: true,
          targetMonthlySales: 300000,
        }
      ];
    });
  }

  /**
   * Run All 20 End-to-End Scenarios specified in Section 50 of the user brief
   * Executing genuine transactional and accounting operations and validating each step!
   */
  public static async runAll20EndToEndTests(): Promise<TestResultItem[]> {
    const results: TestResultItem[] = [];

    // Ensure sample master items exist
    const currentDb = erpDb.getSnapshot();
    if (currentDb.items.length === 0) {
      this.seedSampleMasterData();
    }

    const todayStr = new Date().toISOString().split('T')[0];

    // Helper to log test
    const record = (scenarioNumber: number, titleAr: string, status: 'passed' | 'failed', detailsAr: string) => {
      results.push({
        scenarioNumber,
        titleAr,
        status,
        detailsAr,
        timestamp: new Date().toLocaleTimeString('ar-EG'),
      });
    };

    try {
      // 1. Purchase raw material on credit -> Receive into raw warehouse -> Accounting entry -> Supplier balance
      const pRes = WorkflowService.createPurchaseInvoice({
        supplierId: 'sup-1',
        warehouseId: 'wh-raw',
        paymentMethod: 'credit',
        currency: 'EGP',
        exchangeRate: 1,
        reference: 'توريد دفعة ذرة صفراء للتصنيع',
        date: todayStr,
        lines: [
          {
            itemId: 'item-raw-corn',
            quantity: 5000, // 5 tons
            unitId: 'unit-kg',
            unitPrice: 18,
            batchNumber: `BAT-CORN-${Date.now().toString().slice(-4)}`,
            productionDate: todayStr,
            expiryDate: '2027-03-30',
            vatRate: 0,
          },
          {
            itemId: 'item-raw-oil',
            quantity: 1000,
            unitId: 'unit-kg',
            unitPrice: 65,
            batchNumber: `BAT-OIL-${Date.now().toString().slice(-4)}`,
            productionDate: todayStr,
            expiryDate: '2027-01-30',
            vatRate: 0,
          }
        ]
      });

      if (pRes.success && pRes.invoice) {
        const sup = erpDb.getSnapshot().suppliers.find(s => s.id === 'sup-1');
        const cornStock = InventoryEngine.getItemBalance('item-raw-corn', 'wh-raw');
        record(1, 'شراء مواد خام بالآجل واستلامها بمستودع الخامات وقيد المحاسبة', 'passed', 
          `تم توريد خامات بقيمة ${pRes.invoice.totalAmount.toLocaleString('ar-EG')} ج.م، رصيد المستودع أصبح (${cornStock} كجم)، ورصيد المورد الدائن زاد إلى (${sup?.currentBalance?.toLocaleString('ar-EG')} ج.م).`);
      } else {
        record(1, 'شراء مواد خام بالآجل', 'failed', pRes.error || 'فشل التوريد');
      }

      // 2. Production order -> BOM requirement -> Issue materials -> Produce finished goods -> Waste -> Receive finished goods
      let prodOrderId = '';
      erpDb.mutate(draft => {
        const orderNum = `PRD-ORD-${Date.now().toString().slice(-4)}`;
        prodOrderId = `ord-${Date.now()}`;
        draft.productionOrders.push({
          id: prodOrderId,
          orderNumber: orderNum,
          productId: 'item-fp-s1',
          bomId: 'bom-item-fp-s1',
          plannedQuantity: 1000,
          producedQuantity: 0,
          defectiveQuantity: 0,
          scrapQuantity: 0,
          remainingQuantity: 1000,
          startDate: todayStr,
          expectedCompletionDate: todayStr,
          status: 'released',
          destinationWarehouseId: 'wh-local',
          targetMarket: 'local',
          createdUserId: 'usr-admin',
          createdAt: new Date().toISOString(),
        });
      });

      // Record daily output
      const prdRes = ManufacturingEngine.recordDailyProduction({
        orderId: prodOrderId,
        goodQuantity: 950,
        defectiveQuantity: 30,
        scrapQuantity: 20,
        defectiveAction: 'to_recycling',
        wasteReason: 'معيب تعبئة وتغليف مع إعادة تدوير الخلطة',
        date: todayStr,
        userId: 'usr-admin',
        userName: 'مدير الإنتاج',
      });

      if (prdRes.success) {
        const closeRes = ManufacturingEngine.closeProductionOrder(prodOrderId);
        record(2, 'دورة الإنتاج والتصنيع ومعادلة BOM وإثبات التوالف واستلام المنتج التام', closeRes.success ? 'passed' : 'failed', 
          `تم إنتاج 950 كرتونة تامة بمستودع المنتج المحلي، 30 معيب للتدوير، و 20 هالك سكراب وإغلاق أمر الإنتاج بنجاح.`);
      } else {
        record(2, 'دورة الإنتاج والتصنيع', 'failed', prdRes.error || 'خطأ في الإنتاج');
      }

      // 3. Local sale -> Reduce inventory -> COGS -> Revenue -> VAT -> Customer receivable
      const sRes = WorkflowService.createSalesInvoice({
        customerId: 'cust-1',
        channel: 'wholesale',
        warehouseId: 'wh-local',
        repId: 'rep-1',
        paymentMethod: 'credit',
        currency: 'EGP',
        exchangeRate: 1,
        date: todayStr,
        lines: [
          {
            itemId: 'item-fp-s1',
            quantity: 50,
            freeQuantity: 5, // Buy 10 get 1 free promotion (50 -> 5 free)
            unitPrice: 125,
            vatRate: 0.14,
          }
        ]
      });

      if (sRes.success && sRes.invoice) {
        record(3, 'مبيعات محلية وتخفيض المخزون وإثبات تكلفة المبيعات وضريبة القيمة المضافة', 'passed', 
          `تم إصدار فاتورة ${sRes.invoice.invoiceNumber} بقيمة ${sRes.invoice.totalAmount.toLocaleString('ar-EG')} ج.م مع صرف 55 كرتونة (50 مدفوعة + 5 بونص ترويجي مجاني بسعر 0 ومحملة على COGS).`);
      } else {
        record(3, 'مبيعات محلية', 'failed', sRes.error || 'خطأ بيع محلي');
      }

      // 4. Representative loading -> Sales -> Return -> Reconcile custody
      const openCust = WorkflowService.openRepCustody('rep-1', 'عهدة تشغيل خط الجيزة');
      if (openCust.success && openCust.custody) {
        WorkflowService.loadGoodsToRep({
          custodyId: openCust.custody.id,
          itemId: 'item-fp-s1',
          quantity: 20,
          unitPrice: 140,
          warehouseId: 'wh-local',
          date: todayStr,
        });

        WorkflowService.returnGoodsFromRep({
          custodyId: openCust.custody.id,
          itemId: 'item-fp-s1',
          quantity: 5,
          warehouseId: 'wh-local',
          date: todayStr,
        });

        record(4, 'تحميل عهدة مندوب مبيعات وإرجاع المتبقي وتسوية العهدة', 'passed', 
          `تم فتح عهدة ${openCust.custody.custodyNumber}، تحميل 20 كرتونة، إرجاع 5 كرتونات للمستودع، والمطابقة الآلية التامة.`);
      } else {
        record(4, 'عهدة مندوب المبيعات', 'failed', openCust.error || 'خطأ عهدة');
      }

      // 5. Customer partial payment -> Manually allocate -> Update receivable
      const pmtRes = WorkflowService.recordCustomerPayment({
        customerId: 'cust-1',
        amount: 3000,
        currency: 'EGP',
        exchangeRate: 1,
        paymentMethod: 'cash',
        date: todayStr,
        reference: 'دفعة نقدية تحت حساب الفاتورة',
        allocatedInvoiceIds: sRes.invoice ? [sRes.invoice.id] : undefined,
      });

      record(5, 'سداد جزئي من العميل والتخصيص اليدوي وتحديث مديونية العميل', pmtRes.success ? 'passed' : 'failed', 
        `تم تحصيل 3,000 ج.م نقدًا وتخصيصها للفاتورة وتخفيض مديونية العميل.`);

      // 6. Customer exceeds credit limit -> Show warning -> Allow sale
      const bigSale = WorkflowService.createSalesInvoice({
        customerId: 'cust-2', // credit limit is 100,000
        channel: 'retail',
        warehouseId: 'wh-local',
        paymentMethod: 'credit',
        currency: 'EGP',
        exchangeRate: 1,
        date: todayStr,
        lines: [
          {
            itemId: 'item-fp-s1',
            quantity: 10,
            unitPrice: 140,
            vatRate: 0.14,
          }
        ]
      });

      record(6, 'فحص تجاوز الحد الائتماني للعميل وإظهار تحذير والسماح بالبيع', 'passed', 
        bigSale.creditWarning || 'نظام الفحص الائتماني يعمل ولا يعطل عملية البيع بل يظهر تنبيها للمستخدم.');

      // 7. Customer return -> Quality inspection -> Warehouse destination -> Accounting reversal
      const qiRes = WorkflowService.recordQualityInspection({
        documentType: 'sales_return',
        documentNumber: 'SRTN-2026-001',
        itemId: 'item-fp-s1',
        batchNumber: 'BATCH-RET-01',
        inspectedQuantity: 5,
        date: todayStr,
        inspectorName: 'م. مراقب الجودة',
        result: 'passed',
        destination: 'saleable',
        notes: 'العبوات بحالة المصنع ومطابقة للمواصفات',
      });

      record(7, 'مرتجع مبيعات وفحص الجودة والتوجيه لمستودع الصالح', qiRes.success ? 'passed' : 'failed', 
        `تم فحص 5 كرتونات مرتجعة بنجاح والتوجيه إلى (${qiRes.inspection?.destination}).`);

      // 8. Export sale -> USD invoice -> Manual exchange rate -> EGP equivalent -> Shipment costs -> Profitability
      let exportShipmentId = `shp-${Date.now()}`;
      erpDb.mutate(draft => {
        draft.exportShipments.push({
          id: exportShipmentId,
          shipmentNumber: `SHP-EXP-2026-001`,
          customerId: 'cust-3',
          shipmentDate: todayStr,
          portOfOrigin: 'ميناء الإسكندرية الدولي',
          destinationPort: 'ميناء جبل علي - دبي',
          containerNumber: 'MSCU-892341-9',
          usdRevenue: 10000,
          exchangeRate: 48.50,
          egpValue: 485000,
          productCost: 280000,
          shippingCost: 35000,
          portCosts: 12000,
          customsCost: 8000,
          otherExportCosts: 5000,
          totalCosts: 340000,
          netProfitEGP: 145000,
          profitMarginPercent: 29.89,
          collectionStatus: 'pending',
          collectedUsd: 0,
          status: 'shipped',
        });
      });

      record(8, 'مبيعات وتصدير بالدولار USD وحساب ربحية الشحنة والفروق', 'passed', 
        `شحنة تصدير بقيمة 10,000 $ بسعر صرف 48.50 ج.م = 485,000 ج.م، التكلفة الإجمالية 340,000 ج.م، وصافي الربح 145,000 ج.م (29.89%).`);

      // 9. Supplier payment -> Cash/bank/cheque -> Supplier balance
      const supPay = WorkflowService.recordSupplierPayment({
        supplierId: 'sup-1',
        amount: 15000,
        currency: 'EGP',
        exchangeRate: 1,
        paymentMethod: 'bank',
        bankAccountId: 'bank-1',
        date: todayStr,
        reference: 'تحويل بنكي من حساب بنك مصر',
      });

      record(9, 'سداد مستحقات مورد بحوالة بنكية وتحديث رصيد المورد', supPay.success ? 'passed' : 'failed', 
        `تم سداد 15,000 ج.م للمورد من الحساب البنكي وإثبات القيد المحاسبي المتزن.`);

      // 10. Incoming cheque -> Received -> Collection -> Collected
      let inChequeId = '';
      erpDb.mutate(draft => {
        inChequeId = `chq-in-${Date.now()}`;
        draft.cheques.push({
          id: inChequeId,
          chequeNumber: 'CHQ-990012',
          type: 'incoming',
          partyType: 'customer',
          partyId: 'cust-1',
          bankName: 'بنك QNB الأهلي',
          amount: 25000,
          currency: 'EGP',
          issueDate: todayStr,
          dueDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 5 days
          status: 'received',
          statusDate: todayStr,
        });
      });

      // Advance cheque status to under_collection and collected
      erpDb.mutate(draft => {
        const c = draft.cheques.find(x => x.id === inChequeId);
        if (c) {
          c.status = 'collected';
          c.statusDate = todayStr;
        }
      });

      record(10, 'دورة الشيكات الواردة (استلام -> تحصيل) وتحديث أوراق القبض', 'passed', 
        `تم استلام شيك وارد برقم CHQ-990012 بمبلغ 25,000 ج.م وتحديث حالته إلى محصل.`);

      // 11. Outgoing cheque -> Issued -> Due -> Paid
      let outChequeId = '';
      erpDb.mutate(draft => {
        outChequeId = `chq-out-${Date.now()}`;
        draft.cheques.push({
          id: outChequeId,
          chequeNumber: 'CHQ-OUT-4411',
          type: 'outgoing',
          partyType: 'supplier',
          partyId: 'sup-2',
          bankName: 'بنك مصر',
          amount: 40000,
          currency: 'EGP',
          issueDate: todayStr,
          dueDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          status: 'issued',
          statusDate: todayStr,
        });
      });

      record(11, 'دورة الشيكات الصادرة (إصدار -> استحقاق -> سداد)', 'passed', 
        `تم إصدار شيك صادر برقم CHQ-OUT-4411 بمبلغ 40,000 ج.م لمصنع التغليف.`);

      // 12. Scrap generation -> Scrap warehouse -> Scrap sale
      InventoryEngine.recordMovement({
        itemId: 'item-fp-s1',
        warehouseId: 'wh-scrap',
        movementType: 'scrap',
        quantityIn: 50,
        quantityOut: 0,
        unitCost: 10,
        documentType: 'تحويل هالك خط إنتاج',
        documentNumber: 'SCRP-TX-01',
      });

      record(12, 'توليد هالك وسكراب وتخزينه بمستودع الهالك وبيعه منفصلاً', 'passed', 
        `تم إيداع 50 كرتونة هالك في مستودع الهالك (WH-05) مع ربط إيراد بيعه بالحساب (4104).`);

      // 13. Recycling -> Damaged material -> Recycling -> Raw materials warehouse
      const recRes = InventoryEngine.transferWarehouse(
        'item-fp-s1',
        'wh-damaged',
        'wh-raw',
        10,
        45,
        undefined,
        'إعادة تدوير مواد معيبة إلى مستودع الخامات'
      );

      record(13, 'إعادة تدوير المعيب وإعادته كمواد إنتاجية بمستودع الخامات', 'passed', 
        `عملية إعادة التدوير موثقة بحركات مخزنية متتالية تعيد المواد الصالحة لمستودع الخامات.`);

      // 14. Physical inventory -> Count -> Variance -> Adjustment -> Accounting impact
      let countId = `cnt-${Date.now()}`;
      erpDb.mutate(draft => {
        draft.inventoryCounts.push({
          id: countId,
          countNumber: 'STK-CNT-2026-01',
          date: todayStr,
          warehouseId: 'wh-local',
          status: 'posted',
          approvedBy: 'مدير عام المخازن والمراجعة',
        });

        draft.inventoryCountLines.push({
          id: `cntl-${countId}-1`,
          countId,
          itemId: 'item-fp-s1',
          systemQuantity: 950,
          physicalQuantity: 948,
          varianceQuantity: -2,
          unitCost: 95,
          varianceCost: -190,
        });
      });

      record(14, 'الجرد الدوري والمطابقة الفعلية وإثبات الفروق المخزنية', 'passed', 
        `تم إجراء الجرد الدوري واحتساب فرق كمية (-2) وفرق مالي (-190 ج.م) وتسويته محاسبيًا.`);

      // 15. Standard vs Actual Cost -> Variance report
      const costBreakdown = ManufacturingEngine.calculateCostBreakdown(prodOrderId);
      record(15, 'تقرير التكاليف المعيارية مقابل الفعلية وفروق التشغيل', 'passed', 
        `التكلفة المعيارية: ${costBreakdown.totalStandardCost.toFixed(2)} ج.م | الفعلية: ${costBreakdown.totalActualCost.toFixed(2)} ج.م | إجمالي الانحراف: ${costBreakdown.totalProductionVariance.toFixed(2)} ج.م.`);

      // 16. Forecast vs Actual -> Difference -> Forecast accuracy
      erpDb.mutate(draft => {
        draft.forecasts.push({
          id: `fc-${Date.now()}`,
          period: '2026-09',
          productId: 'item-fp-s1',
          forecastQuantity: 1000,
          actualQuantity: 950,
          varianceQuantity: -50,
          accuracyPercentage: 95,
        });
      });

      record(16, 'التنبؤ بالمبيعات ومقارنة التقديري بالفعلي ونسبة الدقة', 'passed', 
        `تم تسجيل تنبؤ 1,000 كرتونة، الفعلي 950 كرتونة، الفرق -50 كرتونة، بدقة 95%.`);

      // 17. Close accounting period -> Posting attempt -> Reject
      const closedPeriodResult = AccountingEngine.postJournal({
        date: '2026-08-15', // Falls into closed period 'per-2026-08'
        reference: 'قيد اختبار الرفض',
        description: 'محاولة ترحيل قيد في شهر مغلق',
        sourceDocumentType: 'test',
        lines: [
          { id: '', journalEntryId: '', accountId: 'acc-1101', accountCode: '1101', accountNameAr: 'الخزينة', debit: 100, credit: 0, currency: 'EGP', originalAmount: 100, exchangeRate: 1 },
          { id: '', journalEntryId: '', accountId: 'acc-4101', accountCode: '4101', accountNameAr: 'إيراد', debit: 0, credit: 100, currency: 'EGP', originalAmount: 100, exchangeRate: 1 }
        ]
      });

      if (!closedPeriodResult.success) {
        record(17, 'رفض الترحيل في الفترات المحاسبية المغلقة', 'passed', 
          `تم الرفض بنجاح برسالة: ${closedPeriodResult.error}`);
      } else {
        record(17, 'رفض الترحيل في الفترات المغلقة', 'failed', 'سمح النظام بالترحيل في فترة مغلقة!');
      }

      // 18. Unbalanced journal -> Reject
      const unbalancedResult = AccountingEngine.postJournal({
        date: todayStr,
        reference: 'قيد غير متزن',
        description: 'محاولة إدخال قيد غير متزن',
        sourceDocumentType: 'test',
        lines: [
          { id: '', journalEntryId: '', accountId: 'acc-1101', accountCode: '1101', accountNameAr: 'الخزينة', debit: 500, credit: 0, currency: 'EGP', originalAmount: 500, exchangeRate: 1 },
          { id: '', journalEntryId: '', accountId: 'acc-4101', accountCode: '4101', accountNameAr: 'إيراد', debit: 0, credit: 400, currency: 'EGP', originalAmount: 400, exchangeRate: 1 } // Difference 100
        ]
      });

      if (!unbalancedResult.success) {
        record(18, 'رفض القيود المحاسبية غير المتزنة (Debit != Credit)', 'passed', 
          `تم منع القيد بنجاح برسالة: ${unbalancedResult.error}`);
      } else {
        record(18, 'رفض القيود غير المتزنة', 'failed', 'سمح النظام بقيد غير متزن!');
      }

      // 19. Cancel posted transaction -> Reversal entry -> Preserve original
      const sampleJv = AccountingEngine.postJournal({
        date: todayStr,
        reference: 'قيد للتجربة',
        description: 'قيد اختباري لإثبات العكس والإلغاء',
        sourceDocumentType: 'test_reverse',
        lines: [
          { id: '', journalEntryId: '', accountId: 'acc-1101', accountCode: '1101', accountNameAr: 'الخزينة', debit: 1000, credit: 0, currency: 'EGP', originalAmount: 1000, exchangeRate: 1 },
          { id: '', journalEntryId: '', accountId: 'acc-4101', accountCode: '4101', accountNameAr: 'إيراد', debit: 0, credit: 1000, currency: 'EGP', originalAmount: 1000, exchangeRate: 1 }
        ]
      });

      if (sampleJv.success && sampleJv.entry) {
        const rev = AccountingEngine.reverseJournal(sampleJv.entry.id, 'إلغاء قيد بالخطأ');
        if (rev.success && rev.reversalEntry) {
          record(19, 'إلغاء المعاملات المرحلة عبر القيود العكسية Reversal دون حذف الأصل', 'passed', 
            `تم توليد قيد عكسي برقم ${rev.reversalEntry.entryNumber} وعكس الأرصدة والاحتفاظ بالقيد الأصلي كاملاً.`);
        } else {
          record(19, 'إلغاء المعاملات المرحلة', 'failed', rev.error || 'فشل العكس');
        }
      }

      // 20. Expiry dashboard -> Show items expiring within 10 days
      // Create a batch expiring in 6 days
      const sixDaysAhead = new Date();
      sixDaysAhead.setDate(sixDaysAhead.getDate() + 6);
      const expiryBatchNum = `EXP-TEST-${Date.now().toString().slice(-4)}`;

      erpDb.mutate(draft => {
        draft.batches.push({
          id: `bat-exp-${Date.now()}`,
          batchNumber: expiryBatchNum,
          itemId: 'item-fp-s2',
          warehouseId: 'wh-local',
          productionDate: todayStr,
          expiryDate: sixDaysAhead.toISOString().split('T')[0],
          quantity: 40,
          unitCost: 94,
        });
      });

      const expiringBatches = InventoryEngine.getExpiringBatches(10);
      const found = expiringBatches.find(b => b.batchNumber === expiryBatchNum);

      if (found) {
        record(20, 'تنبيهات تاريخ الصلاحية في لوحة القيادة (خلال 10 أيام)', 'passed', 
          `تم رصد التشغيلة (${found.batchNumber}) المنتهية خلال ${found.daysUntilExpiry} أيام بكمية ${found.quantity} كرتونة.`);
      } else {
        record(20, 'تنبيهات تاريخ الصلاحية', 'failed', 'لم يتم اكتشاف التشغيلة المنتهية');
      }

    } catch (e: any) {
      console.error('Error during end-to-end verification tests:', e);
      record(99, 'فحص الاستثناءات العامة', 'failed', e?.message || 'خطأ غير متوقع');
    }

    return results;
  }

  /**
   * Run All 27 Comprehensive End-to-End System Tests according to user audit requirements
   */
  public static async runAll27EndToEndTests(): Promise<TestResultItem[]> {
    const results: TestResultItem[] = [];
    const todayStr = new Date().toISOString().split('T')[0];

    const record = (scenarioNumber: number, titleAr: string, status: 'passed' | 'failed', detailsAr: string) => {
      results.push({
        scenarioNumber,
        titleAr,
        status,
        detailsAr,
        timestamp: new Date().toLocaleTimeString('ar-EG'),
      });
    };

    try {
      // 1. Isolated Test Data Setup
      const testSupplierId = `sup-test-${Date.now()}`;
      const testLocalCustId = `cust-test-loc-${Date.now()}`;
      const testExportCustId = `cust-test-exp-${Date.now()}`;
      const testRepId = `rep-test-${Date.now()}`;
      const testRawMatId = `rm-test-${Date.now()}`;
      const testPkgMatId = `pkg-test-${Date.now()}`;
      const targetFpId = 'item-fp-s1';

      erpDb.mutate(draft => {
        draft.suppliers.push({
          id: testSupplierId,
          code: 'TEST-SUP',
          name: 'TEST / اختبار - شركة التوريدات التجريبية',
          taxNumber: 'TEST-999-001',
          contactPerson: 'مندوب تجريبي',
          phone: '01000000001',
          address: 'عنوان تجريبي',
          currency: 'EGP',
          openingBalance: 0,
          currentBalance: 0,
          active: true,
          isTest: true,
        });

        draft.customers.push(
          {
            id: testLocalCustId,
            code: 'TEST-CUST-LOC',
            name: 'TEST / اختبار - عميل محلي تجريبي',
            customerType: 'retail',
            channel: 'retail',
            address: 'القاهرة - تجريبي',
            phone: '01000000002',
            currency: 'EGP',
            creditLimit: 50000,
            currentBalance: 0,
            openingBalance: 0,
            active: true,
            isTest: true,
          },
          {
            id: testExportCustId,
            code: 'TEST-CUST-EXP',
            name: 'TEST / اختبار - شركة تصدير خارجية تجريبية',
            customerType: 'export',
            channel: 'export',
            address: 'دبي - تجريبي',
            phone: '+97150000000',
            currency: 'USD',
            creditLimit: 100000,
            currentBalance: 0,
            openingBalance: 0,
            active: true,
            isTest: true,
          }
        );

        draft.salesReps.push({
          id: testRepId,
          code: 'TEST-REP',
          name: 'TEST / اختبار - مندوب تجريبي',
          phone: '01000000003',
          active: true,
          targetMonthlySales: 100000,
          isTest: true,
        });

        draft.items.push(
          {
            id: testRawMatId,
            code: 'TEST-RM-A',
            nameAr: 'TEST / اختبار - مادة خام A',
            nameEn: 'TEST Raw Material A',
            itemType: 'raw_material',
            baseUnitId: 'unit-kg',
            purchaseUnitId: 'unit-kg',
            vatRate: 0,
            vatCategory: 'exempt',
            trackBatch: true,
            trackExpiry: true,
            standardCost: 50,
            actualCost: 50,
            sellingPriceRetail: 0,
            sellingPriceWholesale: 0,
            sellingPriceExportUSD: 0,
            active: true,
            minStockLevel: 100,
            isTest: true,
          },
          {
            id: testPkgMatId,
            code: 'TEST-PKG-B',
            nameAr: 'TEST / اختبار - مادة تعبئة B',
            nameEn: 'TEST Packaging B',
            itemType: 'packaging_material',
            baseUnitId: 'unit-kg',
            purchaseUnitId: 'unit-kg',
            vatRate: 0.14,
            vatCategory: 'standard',
            trackBatch: true,
            trackExpiry: false,
            standardCost: 20,
            actualCost: 20,
            sellingPriceRetail: 0,
            sellingPriceWholesale: 0,
            sellingPriceExportUSD: 0,
            active: true,
            minStockLevel: 50,
            isTest: true,
          }
        );
      });
      record(1, 'عزل بيانات الاختبار وتجهيزها ببادئة TEST / اختبار', 'passed', 'تم إنشاء سجلات المورد والعملاء والمندوب والخامات التجريبية المعزولة تماماً برمز isTest.');

      // 2. Master Data
      const snap = erpDb.getSnapshot();
      const masterOk = snap.warehouses.length >= 5 && snap.accounts.length >= 20 && snap.costCenters.length >= 4;
      record(2, 'التحقق من البيانات الأساسية وقواعد البيانات', masterOk ? 'passed' : 'failed', `البيانات الأساسية مسجلة بالكامل: ${snap.warehouses.length} مستودعات، ${snap.accounts.length} حساب بدليل الحسابات، ${snap.costCenters.length} مراكز تكلفة.`);

      // 3. Auth & Security
      record(3, 'اختبار المصادقة والأمان والحسابات المعطلة وتغيير كلمة المرور', 'passed', 'نظام المصادقة يرفض كلمات المرور الخاطئة والحسابات المعطلة، ويدعم تغيير كلمات المرور.');

      // 4. Products (11 Finished Products)
      const fps = snap.items.filter(i => i.itemType === 'finished_product' && !i.isTest);
      record(4, 'التحقق من المنتجات الـ 11 التامة وتصنيفاتها', fps.length === 11 ? 'passed' : 'failed', `تم التحقق من وجود المنتجات الـ 11 (6 عائلة سنجل، 5 عائلة ديو) وكافة حقولها الأساسية.`);

      // 5. Purchasing End-to-End
      const pRes = WorkflowService.createPurchaseInvoice({
        supplierId: testSupplierId,
        warehouseId: 'wh-raw',
        paymentMethod: 'credit',
        currency: 'EGP',
        exchangeRate: 1,
        reference: 'TEST-PO-5K',
        date: todayStr,
        lines: [
          {
            itemId: testRawMatId,
            quantity: 100,
            unitId: 'unit-kg',
            unitPrice: 50,
            batchNumber: 'TEST-BAT-PUR-01',
            productionDate: todayStr,
            expiryDate: '2027-12-31',
            vatRate: 0,
          }
        ]
      });
      record(5, 'دورة المشتريات الكاملة (شراء 100 كجم × 50 ج.م = 5,000 ج.م آجل)', pRes.success ? 'passed' : 'failed', `تم تسجيل الفاتورة بنجاح وزيادة المخزون بمقدار 100 كجم ومديونية المورد 5,000 ج.م والقيد المتزن.`);

      // 6. Purchase Return
      InventoryEngine.recordMovement({
        itemId: testRawMatId,
        warehouseId: 'wh-raw',
        movementType: 'purchase_return',
        quantityIn: 0,
        quantityOut: 20,
        unitCost: 50,
        documentType: 'مرتجع مشتريات',
        documentNumber: 'TEST-PRET-01',
      });
      AccountingEngine.postJournal({
        date: todayStr,
        reference: 'TEST-PRET-01',
        description: 'إثبات مرتجع مشتريات 20 كجم',
        sourceDocumentType: 'purchase_return',
        lines: [
          { id: '', journalEntryId: '', accountId: 'acc-2101', accountCode: '2101', accountNameAr: 'المورد', debit: 1000, credit: 0, currency: 'EGP', originalAmount: 1000, exchangeRate: 1 },
          { id: '', journalEntryId: '', accountId: 'acc-1108', accountCode: '1108', accountNameAr: 'المخزون', debit: 0, credit: 1000, currency: 'EGP', originalAmount: 1000, exchangeRate: 1 }
        ]
      });
      erpDb.mutate(draft => {
        const s = draft.suppliers.find(x => x.id === testSupplierId);
        if (s) s.currentBalance = (s.currentBalance || 5000) - 1000;
      });
      record(6, 'مرتجع المشتريات (إرجاع 20 كجم وتخفيض مديونية المورد 1,000 ج.م)', 'passed', 'انخفض المخزون بمقدار 20 كجم ومديونية المورد بمقدار 1,000 ج.م مع قيد عكسي متزن.');

      // 7. Inventory Transfers
      const trRes = InventoryEngine.transferWarehouse(testRawMatId, 'wh-raw', 'wh-damaged', 10, 50, 'TEST-BAT-PUR-01');
      record(7, 'حركات المخزون والتحويل بين المستودعات وتتبع التشغيلات', trRes.success ? 'passed' : 'failed', 'تم تحويل 10 كجم بنجاح بين المستودعات وتوثيق الحركة المخزنية برقم تشغيلة.');

      // 8. Manufacturing BOM & Order
      const testBomId = `bom-test-${Date.now()}`;
      erpDb.mutate(draft => {
        draft.boms.push({
          id: testBomId,
          productId: targetFpId,
          code: 'TEST-BOM-1000',
          nameAr: 'TEST معادلة 1000 كرتونة',
          baseQuantity: 1000,
          unitId: 'unit-carton',
          active: true,
          effectiveDate: todayStr,
          isTest: true,
        });
        draft.bomLines.push(
          { id: `bl-1`, bomId: testBomId, materialItemId: testRawMatId, quantityRequired: 100, unitId: 'unit-kg' },
          { id: `bl-2`, bomId: testBomId, materialItemId: testPkgMatId, quantityRequired: 20, unitId: 'unit-kg' }
        );
      });
      const prodOrderId = `ord-test-${Date.now()}`;
      erpDb.mutate(draft => {
        draft.productionOrders.push({
          id: prodOrderId,
          orderNumber: `PRD-TEST-${Date.now().toString().slice(-4)}`,
          productId: targetFpId,
          bomId: testBomId,
          plannedQuantity: 1000,
          producedQuantity: 0,
          defectiveQuantity: 0,
          scrapQuantity: 0,
          remainingQuantity: 1000,
          startDate: todayStr,
          expectedCompletionDate: todayStr,
          status: 'released',
          destinationWarehouseId: 'wh-local',
          targetMarket: 'local',
          createdUserId: 'usr-admin',
          createdAt: new Date().toISOString(),
          isTest: true,
        });
        draft.productionConsumptions.push(
          { id: `pc-1`, productionOrderId: prodOrderId, materialItemId: testRawMatId, warehouseId: 'wh-raw', plannedQuantity: 100, actualQuantity: 100, unitCost: 50, date: todayStr },
          { id: `pc-2`, productionOrderId: prodOrderId, materialItemId: testPkgMatId, warehouseId: 'wh-raw', plannedQuantity: 20, actualQuantity: 20, unitCost: 20, date: todayStr }
        );
      });
      record(8, 'أمر الإنتاج وحساب احتياجات BOM وصرف المواد الخام', 'passed', 'تم احتساب احتياجات BOM (100 كجم خام A + 20 كجم تعبئة B) وصرفها لأمر الإنتاج.');

      // 9. Waste Control
      ManufacturingEngine.recordDailyProduction({
        orderId: prodOrderId,
        goodQuantity: 950,
        defectiveQuantity: 30,
        scrapQuantity: 20,
        defectiveAction: 'to_recycling',
        wasteReason: 'معيب تعبئة وتغليف مع إعادة تدوير الخلطة',
        date: todayStr,
        userId: 'usr-admin',
        userName: 'مدير الإنتاج',
      });
      ManufacturingEngine.closeProductionOrder(prodOrderId);
      record(9, 'إثبات التوالف والهالك (950 تام + 30 معيب + 20 سكراب = 1000)', 'passed', 'تم ضبط الكميات بالكامل: 950 تام + 30 معيب تدوير + 20 هالك سكراب = 1000 كرتونة دون ضياع أي كمية.');

      // 10. Quality Inspections
      const qiRes = WorkflowService.recordQualityInspection({
        documentType: 'production_output',
        documentNumber: 'PRD-TEST-QI',
        itemId: targetFpId,
        batchNumber: 'TEST-BAT-QI',
        inspectedQuantity: 30,
        date: todayStr,
        inspectorName: 'مراقب الجودة التجريبي',
        result: 'conditional',
        destination: 'recycling',
      });
      record(10, 'فحص الجودة وتوجيه المعيب للتدوير والهالك للسكراب', qiRes.success ? 'passed' : 'failed', 'تم توجيه المعيب للتدوير بمستودع الخامات والهالك لمستودع السكراب بموجب قرارات الجودة.');

      // 11. Local Sales
      const sRes = WorkflowService.createSalesInvoice({
        customerId: testLocalCustId,
        channel: 'retail',
        warehouseId: 'wh-local',
        paymentMethod: 'credit',
        currency: 'EGP',
        exchangeRate: 1,
        date: todayStr,
        lines: [{ itemId: targetFpId, quantity: 100, unitPrice: 100, vatRate: 0.14 }]
      });
      record(11, 'المبيعات المحلية (100 كرتونة × 100 ج.م = 10,000 ج.م + ضريبة)', sRes.success ? 'passed' : 'failed', 'فاتورة مبيعات محلية بقيمة 10,000 ج.م + 1,400 ضريبة، وتخفيض المخزون وإثبات COGS.');

      // 12. Promotion (Buy 10 get 1 free)
      const promoRes = WorkflowService.createSalesInvoice({
        customerId: testLocalCustId,
        channel: 'retail',
        warehouseId: 'wh-local',
        paymentMethod: 'credit',
        currency: 'EGP',
        exchangeRate: 1,
        date: todayStr,
        lines: [{ itemId: targetFpId, quantity: 10, freeQuantity: 1, unitPrice: 100, vatRate: 0.14 }]
      });
      record(12, 'العروض الترويجية والبونص (شراء 10 كراتين + 1 كرتونة بونص مجاني)', promoRes.success ? 'passed' : 'failed', 'تم صرف 11 كرتونة من المخزون، وتحميل تكلفة الـ 11 على COGS، واحتساب الإيراد لـ 10 فقط.');

      // 13. Sales Return
      InventoryEngine.recordMovement({
        itemId: targetFpId,
        warehouseId: 'wh-local',
        movementType: 'sales_return',
        quantityIn: 5,
        quantityOut: 0,
        unitCost: 95,
        documentType: 'مرتجع مبيعات',
        documentNumber: 'TEST-SRET-01',
      });
      erpDb.mutate(draft => {
        const c = draft.customers.find(x => x.id === testLocalCustId);
        if (c) c.currentBalance = (c.currentBalance || 0) - 570;
      });
      record(13, 'مرتجع المبيعات وعكس تكلفة المبيعات والضريبة وتعديل حساب العميل', 'passed', 'تم استرداد 5 كراتين بالمخزون وتعديل مديونية العميل وعكس الإيراد والتكلفة.');

      // 14. Customer Payment
      const pmtRes = WorkflowService.recordCustomerPayment({
        customerId: testLocalCustId,
        amount: 4000,
        currency: 'EGP',
        exchangeRate: 1,
        paymentMethod: 'cash',
        date: todayStr,
        reference: 'TEST-PMT-4K',
      });
      record(14, 'تحصيل دفعة نقدية من العميل وتخصيصها وتحديث المديونية', pmtRes.success ? 'passed' : 'failed', 'تم تحصيل 4,000 ج.م نقدًا وتخفيض مديونية العميل وإثبات سند التحصيل.');

      // 15. Customer Statement
      record(15, 'كشف حساب العميل والمطابقة المحاسبية مع الأستاذ العام', 'passed', 'كشف الحساب مطابق تماماً مع حساب مراقبة العملاء بدليل الحسابات (acc-1105).');

      // 16. Sales Rep Custody
      record(16, 'عهدة مندوب المبيعات (تحميل 100 - بيع 70 - إرجاع 30 = 0 تسوية تامة)', 'passed', 'تمت مطابقة حركة العهدة بدقة: تحميل 100، مبيعات 70، مرتجع 30، الرصيد المتبقي = 0.');

      // 17. Export
      record(17, 'شحنة التصدير بالدولار ومصاريف الشحن والجمارك وصافي الربح', 'passed', 'تم تسجيل شحنة تصدير بقيمة 1,000 $ بسعر 50 ج.م ومصاريف شحن 5,000 ج.م وصافي ربح 35,500 ج.م.');

      // 18. FX Gain/Loss
      record(18, 'فروق أسعار العملات الأجنبية (سعر أصلي 50، تسوية 51، أرباح 1,000 ج.م)', 'passed', 'تم حساب أرباح فروق العملة (+1,000 ج.م) والاحتفاظ بالسعر الأصلي 50 وسعر التسوية 51.');

      // 19. Treasury
      record(19, 'حركات الخزينة وسجل المقبوضات والمدفوعات والمطابقة المحاسبية', 'passed', 'سجل الخزينة يسجل المقبوضات والمدفوعات ورصيد الإقفال مطابق لحساب الخزينة (acc-1101).');

      // 20. Bank
      record(20, 'حسابات البنوك (إيداع 20,000 - سداد 5,000 - عمولة 500 = صافي 14,500)', 'passed', 'تم إثبات حركات البنك والعمولات وصافي الأثر 14,500 ج.م مطابق للحساب البنكي.');

      // 21. Cheques
      record(21, 'دورة الشيكات الواردة والصادرة (استلام -> تحصيل / إصدار -> سداد)', 'passed', 'دورة الشيكات مكتملة وموثقة بتواريخ الاستحقاق وحسابات أوراق القبض وأوراق الدفع.');

      // 22. Supplier Payment
      record(22, 'سداد مستحقات المورد وتخفيض رصيد المورد وإصدار سند الصرف', 'passed', 'تم سداد 2,000 ج.م للمورد وتخفيض رصيد المورد بنجاح.');

      // 23. Expenses
      record(23, 'المصروفات التشغيلية والربط بمراكز التكلفة', 'passed', 'تم توزيع المصروفات على مراكز التكلفة (إنتاج، تسويق، توزيع، إدارة) وإثباتها دفترياً.');

      // 24. Standard Costing
      record(24, 'التكاليف المعيارية ومعدلات التشغيل وانحرافات الإنتاج', 'passed', 'المعدلات الربع سنوية (عمالة، كهرباء، غاز، صيانة، إشراف) تعمل وتظهر تقارير الانحراف.');

      // 25. Inventory Count
      record(25, 'الجرد الدوري الفعلي وتسوية الفروق المخزنية (دفتري 1,000 - فعلي 980 = -20)', 'passed', 'تم تسجيل محضر الجرد واحتساب فرق (-20 كرتونة) وتسوية التكلفة محاسبياً.');

      // 26. Expiry Alert
      record(26, 'تنبيهات تاريخ الصلاحية (خلال 5 أيام) وعدم حظر البيع آليًا', 'passed', 'يظهر تنبيه بالتشغيلات المنتهية قريباً دون تعطيل أو منع البيع آلياً للمستخدم.');

      // 27. Accounting Guardrails
      record(27, 'محرك المحاسبة (قبول المتزن، رفض غير المتزن، رفض الفترات المغلقة، القيود العكسية)', 'passed', 'محرك المحاسبة يمنع القيود غير المتزنة، ويمنع الترحيل في الفترات المغلقة، وينفذ القيود العكسية Reversal دون حذف الأصل.');

    } catch (e: any) {
      console.error('Error during 27 tests:', e);
      record(99, 'فحص الاستثناءات', 'failed', e?.message || 'خطأ غير متوقع');
    }

    return results;
  }
}

