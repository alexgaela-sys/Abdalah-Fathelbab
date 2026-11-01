import type { CloudSalesInvoiceRow } from '../services/cloudSalesInvoice';

export type SalesFormCustomer = {
  id: string;
  code: string;
  nameAr: string;
  customerType: string;
  channel: string | null;
  currency: string;
  creditLimit: number;
  currentBalance: number;
  isTest: boolean;
};

export type SalesFormItem = {
  id: string;
  code: string;
  nameAr: string;
  productFamily: string | null;
  baseUnitId: string;
  unitName: string;
  vatRate: number;
  sellingPriceRetail: number;
  sellingPriceWholesale: number;
  sellingPriceExportUsd: number;
};

export type SalesFormWarehouse = {
  id: string;
  code: string;
  nameAr: string;
  type: string;
};

export type SalesFormUnit = {
  id: string;
  nameAr: string;
};

export type SalesFormCompany = {
  currency: 'EGP' | 'USD';
  usdRate: number;
};

export type SalesFormReferences = {
  customers: SalesFormCustomer[];
  items: SalesFormItem[];
  warehouses: SalesFormWarehouse[];
  units: SalesFormUnit[];
  company: SalesFormCompany | null;
};

export type LoadSalesFormReferencesResult =
  | { ok: true; data: SalesFormReferences }
  | { ok: false; error: string; code?: string };

export type SalesChannel = 'retail' | 'wholesale' | 'export';

export type CloudSalesFormTotals = {
  subtotal: number;
  vat: number;
  total: number;
  subtotalEGP: number;
  vatEGP: number;
  totalEGP: number;
};

export function computeSalesFormTotals(
  lines: Array<{ quantity: number; unitPrice: number; vatRate: number; discount?: number }>,
  currency: 'EGP' | 'USD',
  exchangeRate: number,
): CloudSalesFormTotals {
  const subtotalEGP = lines.reduce((s, l) => s + (l.quantity * l.unitPrice * (currency === 'USD' ? exchangeRate : 1)), 0);
  const vatEGP = lines.reduce((s, l) => s + (l.quantity * l.unitPrice * l.vatRate * (currency === 'USD' ? exchangeRate : 1)), 0);
  const subtotal = currency === 'USD' ? subtotalEGP / (exchangeRate || 1) : subtotalEGP;
  const vat = currency === 'USD' ? vatEGP / (exchangeRate || 1) : vatEGP;
  const total = subtotal + vat;
  return {
    subtotal,
    vat,
    total,
    subtotalEGP,
    vatEGP,
    totalEGP: subtotalEGP + vatEGP,
  };
}

export function defaultWarehouseForChannel(
  warehouses: SalesFormWarehouse[],
  channel: SalesChannel,
): SalesFormWarehouse | null {
  // Build-only stub shape. Real default warehouse selection is implemented in
  // local ERP paths (warehouseForChannel in src/services/pricing).
  const match = warehouses.find(w => {
    if (channel === 'export') return w.type === 'export_finished';
    if (channel === 'wholesale') return w.type === 'local_finished';
    return w.type === 'local_finished';
  });
  return match ?? null;
}

export function priceForSalesChannel(
  _item: SalesFormItem,
  channel: SalesChannel,
): number {
  // Build-only stub shape. Real channel pricing is implemented in
  // src/services/pricing (priceForSalesChannel). Keep a numeric return type
  // because SalesView assigns result to unitPrice.
  if (channel === 'export') return 0;
  if (channel === 'wholesale') return 100;
  return 100;
}

export function validateSalesFormReferences(
  _request: {
    customerId: string;
    warehouseId: string;
    channel: string;
    currency: 'EGP' | 'USD';
    exchangeRate: number;
    lines: Array<{ itemId: string; quantity: number; unitPrice: number; vatRate: number }>;
  },
  _refs: SalesFormReferences,
): Array<{ field: string; message: string }> {
  // Build-only stub shape. Real reference validation against Supabase is not
  // implemented here.
  return [];
}

export async function loadSalesFormReferences(
  _repository: unknown,
): Promise<LoadSalesFormReferencesResult> {
  // Build-only stub. Real cloud refs must not be assumed available from this stub.
  return { ok: false, error: 'المرجعيات السحابية غير مفعّلة في هذه النسخة المحلية', code: 'cloud-disabled' };
}
