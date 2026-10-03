import React, { useState } from 'react';
import ItemCardReport from './ItemCardReport';
import { 
  Package, Plus, Search, Edit3, Eye, Power, 
  CheckCircle2, AlertCircle, Filter, Tag, DollarSign,
  Layers, Barcode, Calendar, Boxes, Check, FileText
} from 'lucide-react';
import { erpDb } from '../../services/db';
import { Item, ProductFamily, ItemType } from '../../types/erp';
import { MasterDataService } from '../../services/masterData';

export const ProductsMasterView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [searchQuery, setSearchQuery] = useState('');
  const [familyFilter, setFamilyFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('finished_product'); // default to finished products as requested
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Modal State
  const [modalMode, setModalMode] = useState<'create' | 'edit' | 'view' | null>(null);
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);

  // Form State
  const [code, setCode] = useState('');
  const [barcode, setBarcode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [itemType, setItemType] = useState<ItemType>('finished_product');
  const [productFamily, setProductFamily] = useState<ProductFamily | ''>('Single');
  const [flavor, setFlavor] = useState('');
  // UOM change: finished products are measured in PCS / قطعة.
  const [baseUnitId, setBaseUnitId] = useState('unit-piece');
  const [purchaseUnitId, setPurchaseUnitId] = useState('unit-piece');
  const [showItemCard, setShowItemCard] = useState(false);
  const [vatCategory, setVatCategory] = useState<'standard' | 'exempt' | 'export'>('standard');
  const [vatRate, setVatRate] = useState(0.14);
  const [standardCost, setStandardCost] = useState(0);
  const [actualCost, setActualCost] = useState(0);
  const [sellingPriceRetail, setSellingPriceRetail] = useState(0);
  const [sellingPriceWholesale, setSellingPriceWholesale] = useState(0);
  const [sellingPriceExportUSD, setSellingPriceExportUSD] = useState(0);
  const [minStockLevel, setMinStockLevel] = useState(0);
  const [expiryPeriodDays, setExpiryPeriodDays] = useState(180);
  const [active, setActive] = useState(true);
  const [trackBatch, setTrackBatch] = useState(true);
  const [trackExpiry, setTrackExpiry] = useState(true);

  const unitsMap = new Map(db.units.map(u => [u.id, u.nameAr]));

  const openCreateModal = () => {
    const finishedCount = db.items.filter(i => i.itemType === 'finished_product').length;
    setCode(`FP-NEW-${String(finishedCount + 1).padStart(2, '0')}`);
    setBarcode('');
    setNameAr('');
    setNameEn('');
    setItemType('finished_product');
    setProductFamily('Single');
    setFlavor('');
    setBaseUnitId('unit-carton');
    setPurchaseUnitId('unit-carton');
    setVatCategory('standard');
    setVatRate(0.14);
    setStandardCost(0);
    setActualCost(0);
    setSellingPriceRetail(0);
    setSellingPriceWholesale(0);
    setSellingPriceExportUSD(0);
    setMinStockLevel(0);
    setExpiryPeriodDays(180);
    setActive(true);
    setTrackBatch(true);
    setTrackExpiry(true);
    setModalMode('create');
    setSelectedItem(null);
  };

  const openEditModal = (item: Item) => {
    setSelectedItem(item);
    setCode(item.code);
    setBarcode(item.barcode || '');
    setNameAr(item.nameAr);
    setNameEn(item.nameEn);
    setItemType(item.itemType);
    setProductFamily(item.productFamily || '');
    setFlavor(item.flavor || '');
    setBaseUnitId(item.baseUnitId);
    setPurchaseUnitId(item.purchaseUnitId || item.baseUnitId);
    setVatCategory((item.vatCategory as any) || 'standard');
    setVatRate(item.vatRate ?? 0.14);
    setStandardCost(item.standardCost || 0);
    setActualCost(item.actualCost || 0);
    setSellingPriceRetail(item.sellingPriceRetail || 0);
    setSellingPriceWholesale(item.sellingPriceWholesale || 0);
    setSellingPriceExportUSD(item.sellingPriceExportUSD || 0);
    setMinStockLevel(item.minStockLevel || 0);
    setExpiryPeriodDays(item.expiryPeriodDays || 180);
    setActive(item.active);
    setTrackBatch(item.trackBatch);
    setTrackExpiry(item.trackExpiry);
    setModalMode('edit');
  };

  const openViewModal = (item: Item) => {
    openEditModal(item);
    setModalMode('view');
  };

  const handleToggleActive = (item: Item) => {
    const actionLabel = item.active ? 'تعطيل' : 'إعادة تنشيط';
    if (confirm(`هل أنت متأكد من ${actionLabel} الصنف "${item.nameAr}"؟`)) {
      // F15: guarded service write (no direct UI mutation).
      const res = MasterDataService.setItemActive(item.id, !item.active, {
        userId: 'usr-admin', userName: 'المشرف العام (Admin)',
      });
      if (!res.success) alert(res.error || 'تعذر تغيير حالة الصنف');
    }
  };

  const handleSaveItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameAr.trim()) {
      alert('يرجى إدخال اسم الصنف بالعربية');
      return;
    }
    if (!code.trim()) {
      alert('يرجى إدخال كود الصنف');
      return;
    }

    const itemPayload: Omit<Item, 'id'> & { id?: string } = {
      id: modalMode === 'edit' && selectedItem ? selectedItem.id : undefined,
      code: code.trim().toUpperCase(),
      barcode: barcode.trim(),
      nameAr: nameAr.trim(),
      nameEn: nameEn.trim(),
      itemType,
      productFamily: itemType === 'finished_product' ? (productFamily as ProductFamily) : undefined,
      flavor: flavor.trim(),
      baseUnitId,
      purchaseUnitId,
      vatRate: vatCategory === 'standard' ? 0.14 : 0,
      vatCategory,
      trackBatch,
      trackExpiry,
      expiryPeriodDays: Number(expiryPeriodDays) || 0,
      standardCost: Number(standardCost) || 0,
      actualCost: Number(actualCost) || 0,
      sellingPriceRetail: Number(sellingPriceRetail) || 0,
      sellingPriceWholesale: Number(sellingPriceWholesale) || 0,
      sellingPriceExportUSD: Number(sellingPriceExportUSD) || 0,
      minStockLevel: Number(minStockLevel) || 0,
      active,
    };

    // F15: guarded service write (no direct UI mutation).
    const saveRes = modalMode === 'create'
      ? MasterDataService.createItem(itemPayload as Omit<Item, 'id'>, { userId: 'usr-admin', userName: 'المشرف العام (Admin)' })
      : selectedItem
        ? MasterDataService.updateItem({ ...itemPayload, id: selectedItem.id } as Item, { userId: 'usr-admin', userName: 'المشرف العام (Admin)' })
        : { success: false as const, error: 'لم يتم تحديد صنف للتعديل' };

    if (!saveRes.success) {
      alert(saveRes.error || 'تعذر حفظ بيانات الصنف');
      return;
    }

    setModalMode(null);
  };

  // Filtered Items
  const filteredItems = db.items.filter(item => {
    const matchesSearch = 
      item.nameAr.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.nameEn.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (item.barcode && item.barcode.includes(searchQuery)) ||
      (item.flavor && item.flavor.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesFamily = familyFilter === 'all' || item.productFamily === familyFilter;
    const matchesType = typeFilter === 'all' || item.itemType === typeFilter;
    const matchesStatus = statusFilter === 'all' || 
      (statusFilter === 'active' && item.active) || 
      (statusFilter === 'inactive' && !item.active);

    return matchesSearch && matchesFamily && matchesType && matchesStatus;
  });

  const totalFinished = db.items.filter(i => i.itemType === 'finished_product').length;
  const totalSingle = db.items.filter(i => i.itemType === 'finished_product' && i.productFamily === 'Single').length;
  const totalDuo = db.items.filter(i => i.itemType === 'finished_product' && i.productFamily === 'Duo').length;
  const totalRaw = db.items.filter(i => i.itemType === 'raw_material' || i.itemType === 'packaging_material').length;

  return (
    <div className="space-y-6 text-right">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-black text-slate-900">سجل الأصناف والمنتجات التامة (Product Master)</h2>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-900 font-bold border border-amber-200">
              SnakDip Catalog
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            إدارة كتالوج المنتجات التامة الـ 11 (عائلات Single و Duo)، الخامات، التكاليف، وأسعار البيع مع إمكانية الإنشاء والتعديل الكامل
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* F18: the item card is reachable from the product master too. */}
          <button
            onClick={() => setShowItemCard(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs shadow-md transition cursor-pointer"
          >
            <FileText className="w-4 h-4" />
            <span>كارت الصنف (Item Card)</span>
          </button>

          <button
            onClick={openCreateModal}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>إضافة صنف / منتج جديد</span>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
        <div 
          onClick={() => { setTypeFilter('finished_product'); setFamilyFilter('all'); }}
          className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs cursor-pointer hover:border-amber-400 transition"
        >
          <div className="text-[11px] text-slate-500 font-medium">المنتجات التامة المعتمدة</div>
          <div className="text-2xl font-black text-slate-900 mt-1 font-mono">{totalFinished}</div>
          <div className="text-[10px] text-amber-600 font-medium mt-0.5">منتج تام معتمد</div>
        </div>

        <div 
          onClick={() => { setTypeFilter('finished_product'); setFamilyFilter('Single'); }}
          className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs cursor-pointer hover:border-amber-400 transition"
        >
          <div className="text-[11px] text-slate-500 font-medium">عائلة سِنجل (Single)</div>
          <div className="text-2xl font-black text-slate-900 mt-1 font-mono">{totalSingle}</div>
          <div className="text-[10px] text-slate-400 mt-0.5">6 نكهات فردية</div>
        </div>

        <div 
          onClick={() => { setTypeFilter('finished_product'); setFamilyFilter('Duo'); }}
          className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs cursor-pointer hover:border-amber-400 transition"
        >
          <div className="text-[11px] text-slate-500 font-medium">عائلة ديو (DUO BOX)</div>
          <div className="text-2xl font-black text-slate-900 mt-1 font-mono">{totalDuo}</div>
          <div className="text-[10px] text-slate-400 mt-0.5">5 علب ثنائية</div>
        </div>

        <div 
          onClick={() => { setTypeFilter('all'); setFamilyFilter('all'); }}
          className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs cursor-pointer hover:border-amber-400 transition"
        >
          <div className="text-[11px] text-slate-500 font-medium">الخامات ومواد التعبئة</div>
          <div className="text-2xl font-black text-slate-900 mt-1 font-mono">{totalRaw}</div>
          <div className="text-[10px] text-slate-400 mt-0.5">مواد أولية وتعبئة</div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs space-y-3">
        <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
          {/* Search Box */}
          <div className="relative flex-1">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="بحث باسم الصنف (عربي/إنجليزي)، الكود، الباركود، أو النكهة..."
              className="w-full pr-10 pl-4 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs focus:bg-white focus:border-amber-500 focus:outline-none"
            />
            <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>

          {/* Type Filter */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 md:pb-0">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs font-semibold focus:outline-none focus:border-amber-500"
            >
              <option value="all">كل الأنواع</option>
              <option value="finished_product">المنتجات التامة فقط</option>
              <option value="raw_material">المواد الخام فقط</option>
              <option value="packaging_material">مواد التعبئة والتغليف</option>
            </select>

            {/* Family Filter */}
            <select
              value={familyFilter}
              onChange={(e) => setFamilyFilter(e.target.value)}
              className="px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs font-semibold focus:outline-none focus:border-amber-500"
            >
              <option value="all">كل العائلات</option>
              <option value="Single">عائلة سِنجل (Single)</option>
              <option value="Duo">عائلة ديو (Duo Box)</option>
            </select>

            {/* Status Filter */}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs font-semibold focus:outline-none focus:border-amber-500"
            >
              <option value="all">كل الحالات</option>
              <option value="active">الأصناف النشطة</option>
              <option value="inactive">المعطلة / الموقوفة</option>
            </select>
          </div>
        </div>
      </div>

      {/* Products Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-100 text-slate-700 font-bold border-b border-slate-200">
              <tr>
                <th className="p-3.5 whitespace-nowrap">كود الصنف</th>
                <th className="p-3.5 whitespace-nowrap">الباركود</th>
                <th className="p-3.5">اسم المنتج (عربي / إنجليزي)</th>
                <th className="p-3.5 whitespace-nowrap">العائلة والنكهة</th>
                <th className="p-3.5 whitespace-nowrap">الوحدة</th>
                <th className="p-3.5 whitespace-nowrap text-center">الضريبة</th>
                <th className="p-3.5 whitespace-nowrap text-left">التكلفة المعيارية</th>
                <th className="p-3.5 whitespace-nowrap text-left">سعر التجزئة</th>
                <th className="p-3.5 whitespace-nowrap text-left">سعر الجملة</th>
                <th className="p-3.5 whitespace-nowrap text-left">تصدير (USD)</th>
                <th className="p-3.5 whitespace-nowrap text-center">حد الطلب</th>
                <th className="p-3.5 whitespace-nowrap text-center">الحالة</th>
                <th className="p-3.5 whitespace-nowrap text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={13} className="py-12 text-center text-slate-400">
                    لا توجد أصناف مطابقة لمعايير البحث الحالية
                  </td>
                </tr>
              ) : (
                filteredItems.map(item => (
                  <tr key={item.id} className="hover:bg-slate-50/80 transition">
                    <td className="p-3.5 font-mono font-bold text-slate-800 whitespace-nowrap">
                      {item.code}
                    </td>
                    <td className="p-3.5 font-mono text-slate-500 whitespace-nowrap">
                      {item.barcode || '—'}
                    </td>
                    <td className="p-3.5">
                      <div className="font-bold text-slate-900">{item.nameAr}</div>
                      <div className="text-[11px] text-slate-400 font-medium">{item.nameEn}</div>
                    </td>
                    <td className="p-3.5 whitespace-nowrap">
                      {item.productFamily ? (
                        <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                          item.productFamily === 'Single' 
                            ? 'bg-amber-50 text-amber-900 border-amber-200' 
                            : 'bg-purple-50 text-purple-900 border-purple-200'
                        }`}>
                          {item.productFamily}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                      {item.flavor && (
                        <span className="block text-[10px] text-slate-500 mt-0.5">{item.flavor}</span>
                      )}
                    </td>
                    <td className="p-3.5 text-slate-700 whitespace-nowrap font-medium">
                      {unitsMap.get(item.baseUnitId) || item.baseUnitId}
                    </td>
                    <td className="p-3.5 text-center whitespace-nowrap">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                        item.vatCategory === 'standard' 
                          ? 'bg-blue-50 text-blue-800 border border-blue-200' 
                          : 'bg-slate-100 text-slate-600'
                      }`}>
                        {item.vatCategory === 'standard' ? '14%' : 'معفى 0%'}
                      </span>
                    </td>
                    <td className="p-3.5 text-left font-mono font-semibold text-slate-700 whitespace-nowrap">
                      {item.standardCost ? `${item.standardCost.toFixed(2)} ج.م` : '0.00'}
                    </td>
                    <td className="p-3.5 text-left font-mono font-bold text-slate-900 whitespace-nowrap">
                      {item.sellingPriceRetail ? `${item.sellingPriceRetail.toFixed(2)} ج.م` : '0.00'}
                    </td>
                    <td className="p-3.5 text-left font-mono text-slate-700 whitespace-nowrap">
                      {item.sellingPriceWholesale ? `${item.sellingPriceWholesale.toFixed(2)} ج.م` : '0.00'}
                    </td>
                    <td className="p-3.5 text-left font-mono text-emerald-700 font-bold whitespace-nowrap">
                      {item.sellingPriceExportUSD ? `$${item.sellingPriceExportUSD.toFixed(2)}` : '$0.00'}
                    </td>
                    <td className="p-3.5 text-center font-mono text-slate-600 whitespace-nowrap">
                      {item.minStockLevel || 0}
                    </td>
                    <td className="p-3.5 text-center whitespace-nowrap">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                        item.active 
                          ? 'bg-emerald-100 text-emerald-800' 
                          : 'bg-rose-100 text-rose-800'
                      }`}>
                        {item.active ? 'نشط' : 'معطل'}
                      </span>
                    </td>
                    <td className="p-3.5 text-center whitespace-nowrap">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => openViewModal(item)}
                          className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition cursor-pointer"
                          title="عرض تفاصيل الصنف"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => openEditModal(item)}
                          className="p-1.5 rounded-lg text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 transition cursor-pointer"
                          title="تعديل الصنف"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleToggleActive(item)}
                          className={`p-1.5 rounded-lg transition cursor-pointer ${
                            item.active 
                              ? 'text-rose-600 hover:text-rose-800 hover:bg-rose-50' 
                              : 'text-emerald-600 hover:text-emerald-800 hover:bg-emerald-50'
                          }`}
                          title={item.active ? 'تعطيل الصنف' : 'إعادة تنشيط الصنف'}
                        >
                          <Power className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Product Create / Edit / View Modal */}
      {showItemCard && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/60 backdrop-blur-xs p-4">
          <div className="max-w-6xl mx-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-black text-base text-white">كارت الصنف — حركة المخزون التفصيلية</h3>
              <button
                onClick={() => setShowItemCard(false)}
                className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-bold"
              >
                إغلاق
              </button>
            </div>
            <div className="bg-white rounded-2xl p-4">
              <ItemCardReport />
            </div>
          </div>
        </div>
      )}

      {modalMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-3xl overflow-hidden text-right flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="p-5 bg-gradient-to-r from-slate-900 to-slate-800 text-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-amber-500 text-slate-950 flex items-center justify-center font-bold text-lg">
                  <Package className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-base">
                    {modalMode === 'create' && 'إضافة صنف / منتج جديد للكتالوج'}
                    {modalMode === 'edit' && `تعديل الصنف: ${nameAr || code}`}
                    {modalMode === 'view' && `تفاصيل الصنف: ${nameAr || code}`}
                  </h3>
                  <p className="text-xs text-slate-300">سجل البيانات الأساسية، التسعير، والتكاليف</p>
                </div>
              </div>
              <button 
                onClick={() => setModalMode(null)} 
                className="text-slate-400 hover:text-white p-1 rounded-xl cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Modal Form */}
            <form onSubmit={handleSaveItem} className="p-6 overflow-y-auto space-y-4 flex-1">
              {/* Row 1: Code, Barcode, Type */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">كود الصنف (Product Code) *</label>
                  <input
                    type="text"
                    disabled={modalMode === 'view'}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    placeholder="FP-SNG-01"
                    className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">الباركود الدولي (Barcode)</label>
                  <input
                    type="text"
                    disabled={modalMode === 'view'}
                    value={barcode}
                    onChange={(e) => setBarcode(e.target.value)}
                    placeholder="6223000000000"
                    className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">نوع الصنف (Item Type)</label>
                  <select
                    disabled={modalMode === 'view'}
                    value={itemType}
                    onChange={(e) => setItemType(e.target.value as any)}
                    className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold"
                  >
                    <option value="finished_product">منتج تام الصنع (Finished)</option>
                    <option value="raw_material">مادة خام أولية (Raw)</option>
                    <option value="packaging_material">مادة تعبئة وتغليف (Packaging)</option>
                  </select>
                </div>
              </div>

              {/* Row 2: Arabic & English Names */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">اسم الصنف بالعربية *</label>
                  <input
                    type="text"
                    disabled={modalMode === 'view'}
                    value={nameAr}
                    onChange={(e) => setNameAr(e.target.value)}
                    required
                    placeholder="أصابع سوبر هيت + صوص سويت تشيلي"
                    className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">الاسم بالإنجليزية (English Name)</label>
                  <input
                    type="text"
                    disabled={modalMode === 'view'}
                    value={nameEn}
                    onChange={(e) => setNameEn(e.target.value)}
                    placeholder="Superheat Fingers + Sweet Chili Dip"
                    className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
              </div>

              {/* Row 3: Product Family & Flavor (for finished goods) */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">عائلة المنتج (Family)</label>
                  <select
                    disabled={modalMode === 'view' || itemType !== 'finished_product'}
                    value={productFamily}
                    onChange={(e) => setProductFamily(e.target.value as any)}
                    className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    <option value="Single">عائلة سِنجل (Single)</option>
                    <option value="Duo">عائلة ديو (Duo Box)</option>
                    <option value="">أخرى / غير محدد</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">النكهة / الصوص (Flavor)</label>
                  <input
                    type="text"
                    disabled={modalMode === 'view'}
                    value={flavor}
                    onChange={(e) => setFlavor(e.target.value)}
                    placeholder="Sweet Chili Dip"
                    className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">وحدة القياس الأساسية</label>
                  <select
                    disabled={modalMode === 'view'}
                    value={baseUnitId}
                    onChange={(e) => setBaseUnitId(e.target.value)}
                    className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs"
                  >
                    {db.units.map(u => (
                      <option key={u.id} value={u.id}>{u.nameAr}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Row 4: Pricing & Costs */}
              <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-3">
                <div className="text-xs font-bold text-slate-800 flex items-center gap-1.5 pb-2 border-b border-slate-200">
                  <DollarSign className="w-3.5 h-3.5 text-amber-600" />
                  <span>التكاليف وأسعار البيع المعتمدة</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">التكلفة المعيارية (EGP)</label>
                    <input
                      type="number"
                      disabled={modalMode === 'view'}
                      value={standardCost}
                      onChange={(e) => setStandardCost(Number(e.target.value))}
                      className="w-full p-2 rounded-xl bg-white border border-slate-300 text-xs font-mono font-bold"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">التكلفة الفعلية (EGP)</label>
                    <input
                      type="number"
                      disabled={modalMode === 'view'}
                      value={actualCost}
                      onChange={(e) => setActualCost(Number(e.target.value))}
                      className="w-full p-2 rounded-xl bg-white border border-slate-300 text-xs font-mono font-bold"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">سعر بيع التجزئة (EGP)</label>
                    <input
                      type="number"
                      disabled={modalMode === 'view'}
                      value={sellingPriceRetail}
                      onChange={(e) => setSellingPriceRetail(Number(e.target.value))}
                      className="w-full p-2 rounded-xl bg-white border border-slate-300 text-xs font-mono font-bold text-indigo-700"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">سعر بيع الجملة (EGP)</label>
                    <input
                      type="number"
                      disabled={modalMode === 'view'}
                      value={sellingPriceWholesale}
                      onChange={(e) => setSellingPriceWholesale(Number(e.target.value))}
                      className="w-full p-2 rounded-xl bg-white border border-slate-300 text-xs font-mono font-bold"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">سعر التصدير (USD)</label>
                    <input
                      type="number"
                      step="0.01"
                      disabled={modalMode === 'view'}
                      value={sellingPriceExportUSD}
                      onChange={(e) => setSellingPriceExportUSD(Number(e.target.value))}
                      className="w-full p-2 rounded-xl bg-white border border-slate-300 text-xs font-mono font-bold text-emerald-700"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">فئة ضريبة القيمة المضافة</label>
                    <select
                      disabled={modalMode === 'view'}
                      value={vatCategory}
                      onChange={(e) => setVatCategory(e.target.value as any)}
                      className="w-full p-2 rounded-xl bg-white border border-slate-300 text-xs"
                    >
                      <option value="standard">خاضع للسعر العام 14%</option>
                      <option value="exempt">معفى من الضريبة 0%</option>
                      <option value="export">تصدير للخارج 0%</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">حد الأمان للمخزون (Min Stock)</label>
                    <input
                      type="number"
                      disabled={modalMode === 'view'}
                      value={minStockLevel}
                      onChange={(e) => setMinStockLevel(Number(e.target.value))}
                      className="w-full p-2 rounded-xl bg-white border border-slate-300 text-xs font-mono"
                    />
                  </div>
                </div>
              </div>

              {/* Row 5: Expiry & Status */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">فترة الصلاحية بالأيام</label>
                  <input
                    type="number"
                    disabled={modalMode === 'view'}
                    value={expiryPeriodDays}
                    onChange={(e) => setExpiryPeriodDays(Number(e.target.value))}
                    placeholder="180"
                    className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">حالة الصنف</label>
                  <select
                    disabled={modalMode === 'view'}
                    value={active ? 'active' : 'inactive'}
                    onChange={(e) => setActive(e.target.value === 'active')}
                    className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold"
                  >
                    <option value="active">نشط ومفعل (Active)</option>
                    <option value="inactive">معطل وموقوف (Inactive)</option>
                  </select>
                </div>
              </div>

              {/* Modal Actions */}
              <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setModalMode(null)}
                  className="px-5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs cursor-pointer"
                >
                  {modalMode === 'view' ? 'إغلاق' : 'إلغاء'}
                </button>
                {modalMode !== 'view' && (
                  <button
                    type="submit"
                    className="px-6 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md cursor-pointer"
                  >
                    {modalMode === 'create' ? 'حفظ الصنف الجديد' : 'تحديث بيانات الصنف'}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
