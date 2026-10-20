// Shared invoice template renderer (header / footer / net-due highlight).
//
// Used by BOTH the printable invoice (InvoicePrint) and the live preview in the
// settings screen, so what the administrator approves is exactly what prints.
//
// Presentation only: totals, VAT and withholding values are passed in, never
// recalculated here. The system name and application link are intentionally NOT
// rendered anywhere in this document.
import React from 'react';
import type { Company, InvoiceTemplateSettings } from '../types/erp';
import { computeInvoiceNetDue } from '../services/companySettings';

export function resolveTemplateLogo(company: Company, template: InvoiceTemplateSettings): string {
  return template.logoDataUrl || company.logoDataUrl || '';
}

const hexWithAlpha = (hex: string, alpha: string): string => {
  const value = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex) ? hex : '#0f172a';
  if (value.length === 4) {
    const r = value[1], g = value[2], b = value[3];
    return `#${r}${r}${g}${g}${b}${b}${alpha}`;
  }
  return `${value}${alpha}`;
};

export const InvoiceHeader: React.FC<{
  company: Company;
  template: InvoiceTemplateSettings;
}> = ({ company, template }) => {
  const logo = resolveTemplateLogo(company, template);
  const align = template.alignment;
  return (
    <div style={{ color: template.textColor, textAlign: align }}>
      {template.showAccentBar && (
        <div style={{ height: 6, backgroundColor: template.accentColor, marginBottom: 10 }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: align === 'center' ? 'center' : align === 'left' ? 'flex-start' : 'flex-end', gap: 12 }}>
        {template.showLogo && logo && (
          <img src={logo} alt="شعار الشركة" style={{ height: 58, maxWidth: 120, objectFit: 'contain' }} />
        )}
        <div>
          <div style={{ fontSize: template.titleFontSize, fontWeight: 900, lineHeight: 1.25 }}>{company.nameAr}</div>
          <div style={{ fontSize: Math.max(10, template.bodyFontSize - 1) }}>{company.nameEn}</div>
        </div>
      </div>

      {(template.headerTextAr || template.headerTextEn) && (
        <div style={{ fontSize: template.bodyFontSize, marginTop: 6, whiteSpace: 'pre-wrap' }}>
          {template.headerTextAr}
          {template.headerTextAr && template.headerTextEn ? ' — ' : ''}
          {template.headerTextEn}
        </div>
      )}

      <div style={{ fontSize: Math.max(9, template.bodyFontSize - 1), marginTop: 6, lineHeight: 1.6 }}>
        {template.showAddress && company.address ? <div>{company.address}</div> : null}
        <div>
          {template.showPhone && company.phone ? <span>هاتف: {company.phone}</span> : null}
          {template.showPhone && company.phone && template.showEmail && company.email ? ' · ' : null}
          {template.showEmail && company.email ? <span>بريد: {company.email}</span> : null}
        </div>
        {template.showTaxNumber ? (
          <div>
            الرقم الضريبي: {company.taxNumber || '—'}
            {company.commercialRegister ? ` · السجل التجاري: ${company.commercialRegister}` : ''}
          </div>
        ) : null}
        {company.website ? <div>{company.website}</div> : null}
      </div>
    </div>
  );
};

export const InvoiceFooter: React.FC<{
  company: Company;
  template: InvoiceTemplateSettings;
}> = ({ company, template }) => (
  <div
    style={{
      marginTop: 14,
      paddingTop: 8,
      borderTop: `1px solid ${hexWithAlpha(template.accentColor, '55')}`,
      fontSize: Math.max(9, template.bodyFontSize - 1),
      color: template.textColor,
      textAlign: template.alignment,
      whiteSpace: 'pre-wrap',
    }}
  >
    {template.footerText}
    {(company.contactName || company.contactPhone) && (
      <div>
        {company.contactName ? `للتواصل: ${company.contactName}` : ''}
        {company.contactName && company.contactPhone ? ' · ' : ''}
        {company.contactPhone || ''}
      </div>
    )}
    {/* Deliberately NO system name / application link in the printed document. */}
  </div>
);

/** Prominent net amount due after VAT and documented deductions. */
export const NetDueHighlight: React.FC<{
  template: InvoiceTemplateSettings;
  totalAmount: number;
  withholdingAmount?: number;
  currency: string;
  format: (value: number) => string;
}> = ({ template, totalAmount, withholdingAmount, currency, format }) => {
  if (!template.showNetDue) return null;
  const net = computeInvoiceNetDue(Number(totalAmount), Number(withholdingAmount) || 0);
  const hasDeduction = (Number(withholdingAmount) || 0) > 0;
  return (
    <div
      style={{
        marginTop: 10,
        padding: '10px 12px',
        border: `2px solid ${template.accentColor}`,
        backgroundColor: hexWithAlpha(template.accentColor, '14'),
        color: template.textColor,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
      }}
    >
      <div>
        <div style={{ fontSize: Math.max(10, template.bodyFontSize - 1), fontWeight: 700 }}>
          {template.netDueLabel}
        </div>
        {hasDeduction && (
          <div style={{ fontSize: Math.max(9, template.bodyFontSize - 2) }}>
            بعد خصم {format(Number(withholdingAmount))} {currency} خصمًا من المنبع (تقديري حتى توثيق الشهادة)
          </div>
        )}
      </div>
      <div className="invoice-keep-color" style={{ fontSize: template.titleFontSize, fontWeight: 900, color: template.accentColor }}>
        {format(net)} {currency}
      </div>
    </div>
  );
};

export const InvoiceDocStyle = (template: InvoiceTemplateSettings): React.CSSProperties => ({
  color: template.textColor,
  fontSize: template.bodyFontSize,
  direction: 'rtl',
  // Exposed as custom properties so the print stylesheet can keep the designed
  // colors instead of forcing every node to black.
  ['--invoice-text' as string]: template.textColor,
  ['--invoice-accent' as string]: template.accentColor,
});
