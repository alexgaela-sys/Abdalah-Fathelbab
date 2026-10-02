// Centralized sales channel + pricing helpers (F3/F4).
// Single source of truth for: customer type → channel → currency/warehouse/price.
// Uses the EXISTING per-item 3-price model only — no price-list architecture.
import { Item, SalesChannel, Customer } from '../types/erp';

/** Channel implied by the customer master type. */
export function channelForCustomerType(customerType: Customer['customerType']): SalesChannel {
  return customerType === 'export' ? 'export' : customerType === 'wholesale' ? 'wholesale' : 'retail';
}

/** Canonical price lookup: item + channel → selling price (existing 3-price model). */
export function priceFor(item: Item, channel: SalesChannel): number {
  if (channel === 'retail') return item.sellingPriceRetail;
  if (channel === 'wholesale') return item.sellingPriceWholesale;
  return item.sellingPriceExportUSD;
}

/** Invoice currency implied by the channel (export settles in USD). */
export function currencyForChannel(channel: SalesChannel): 'EGP' | 'USD' {
  return channel === 'export' ? 'USD' : 'EGP';
}

/** Default warehouse implied by the channel (export ships from WH-03). */
export function warehouseForChannel(channel: SalesChannel): string {
  return channel === 'export' ? 'wh-export' : 'wh-local';
}

/** Export channel is the dangerous boundary (currency/warehouse/VAT): customer and channel must agree. */
export function isChannelCustomerMismatch(customerType: Customer['customerType'], channel: SalesChannel): boolean {
  return (channel === 'export') !== (customerType === 'export');
}
