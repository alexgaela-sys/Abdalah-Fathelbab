import React from 'react';
import type { CloudSalesInvoiceDetail } from '../services/cloudSalesInvoice';

export interface CloudSalesInvoiceDetailsProps {
  detail: CloudSalesInvoiceDetail | null;
  loading?: boolean;
  error?: string | null;
}

export function CloudSalesInvoiceDetails({ detail, loading, error }: CloudSalesInvoiceDetailsProps) {
  if (loading) return <div>جارٍ تحميل تفاصيل الفاتورة...</div>;
  if (error) return <div>خطأ: {error}</div>;
  if (!detail) return null;
  return (
    <div>
      <div>فاتورة مبيعات سحابية: {detail.invoice.invoiceNumber}</div>
      <div>{detail.invoice.customerNameAr}</div>
    </div>
  );
}
