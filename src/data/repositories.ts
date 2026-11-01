// Minimal build-only stub for the current local-first phase.
// The real repository layer for Supabase is NOT implemented in this file.

export type WarehouseRow = {
  id: string;
  code: string;
  nameAr: string;
  type: string;
  location: string;
  managerName: string;
  active: boolean;
};

export type AccountingPeriodRow = {
  id: string;
  nameAr: string;
  startOn: string;
  endOn: string;
  isOpen: boolean;
  isClosed: boolean;
};

export type CompanyRow = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  taxNumber: string;
  commercialRegister: string;
  address: string;
  phone: string;
  baseCurrency: 'EGP';
  exportCurrency: 'USD';
  currentUsdExchangeRate: number;
  email: string;
  website: string;
  contactName: string;
  contactPhone: string;
  logoDataUrl: string;
  usdRate: number;
};

export interface CloudFailureEnvelope {
  code: string;
  messageAr: string;
}

export const repositories = () => {
  // Build-only facade: in local mode these would normally route to Supabase;
  // here they intentionally do not pretend to connect.
  return {
    listWarehouses: async (): Promise<
      | { ok: true; data: WarehouseRow[] }
      | { ok: false; error: string; code: string; failure: CloudFailureEnvelope }
    > => {
      return {
        ok: false,
        error: 'قائمة المستودعات السحابية غير مفعّلة في هذه النسخة المحلية',
        code: 'cloud-disabled',
        failure: { code: 'cloud-disabled', messageAr: 'قائمة المستودعات السحابية غير مفعلة في هذه النسخة المحلية' },
      };
    },
    getCompany: async (): Promise<
      | { ok: true; data: CompanyRow }
      | { ok: false; error: string }
    > => {
      return { ok: false, error: 'بيانات الشركة السحابية غير مفعلة في هذه النسخة المحلية' };
    },
    listAccountingPeriods: async (): Promise<
      | { ok: true; data: AccountingPeriodRow[] }
      | { ok: false; error: string }
    > => {
      return { ok: false, error: 'فترات المحاسبة السحابية غير مفعلة في هذه النسخة المحلية' };
    },
  };
};
