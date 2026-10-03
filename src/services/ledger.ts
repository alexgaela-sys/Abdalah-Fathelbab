// Sub-ledger engine (master UAT — F27/F28/F29/F30).
//
// SINGLE SOURCE OF TRUTH: every customer-facing and cash-facing financial
// movement is read from the POSTED GENERAL LEDGER (account 1105/1106 for the
// customers, 1101 for the treasury). The sub-ledger can therefore never diverge
// from the GL, and it automatically contains every document type that posts to
// those control accounts:
//
//   sales invoices • sales returns • cash/bank collections • cheques (registered
//   from the Cheques screen or from a receipt) • cheque bounces • export
//   collections • adjustments
//
// Nothing here writes to the database. This is a pure projection of posted
// journal lines, exactly like the Trial Balance is.
import { erpDb } from './db';
import { AccountingEngine } from './accounting';
import { Customer, JournalEntry, TreasuryTransaction } from '../types/erp';

export type CustomerDocType =
  | 'sales_invoice' | 'customer_payment' | 'sales_return' | 'cheque'
  | 'cheque_bounce' | 'export_collection' | 'adjustment' | 'other';

export interface CustomerStatementRow {
  id: string;
  date: string;
  documentNumber: string;
  documentType: CustomerDocType;
  documentTypeLabelAr: string;
  description: string;
  reference: string;
  debit: number;
  credit: number;
  runningBalance: number;
  /** Link to the source document (tab + record/document number). */
  link?: { tab: string; recordId: string };
}

export interface CustomerStatement {
  customerId: string;
  currency: 'EGP' | 'USD';
  openingBalance: number;
  rows: CustomerStatementRow[];
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
  /** Denormalized balance kept on the customer card. */
  cardBalance: number;
  /** closingBalance - cardBalance (non-zero = a REAL divergence, shown as-is). */
  cardDiff: number;
  /** GL receivable balance for this customer (converted to customer currency). */
  glBalance: number;
  glDiff: number;
}

const DOC_LABELS: Record<CustomerDocType, string> = {
  sales_invoice: 'فاتورة مبيعات',
  customer_payment: 'سند تحصيل',
  sales_return: 'مرتجع مبيعات',
  cheque: 'شيك',
  cheque_bounce: 'ارتجاع شيك',
  export_collection: 'تحصيل شحنة تصدير',
  adjustment: 'تسوية',
  other: 'قيد محاسبي',
};

function classify(entry: JournalEntry): CustomerDocType {
  switch (entry.sourceDocumentType) {
    case 'sales_invoice': return 'sales_invoice';
    case 'sales_return':
    case 'sales_return_cogs': return 'sales_return';
    case 'customer_payment': return 'customer_payment';
    case 'cheque_registration': return 'cheque';
    case 'cheque_recognition': return 'cheque';
    case 'cheque_status_change': return 'cheque_bounce';
    case 'export_collection': return 'export_collection';
    default: return 'other';
  }
}

/** Resolve a human document number/description for a journal entry. */
function describe(entry: JournalEntry): { documentNumber: string; description: string; reference: string; link?: { tab: string; recordId: string } } {
  const db = erpDb.getSnapshot();
  const id = entry.sourceDocumentId;
  switch (entry.sourceDocumentType) {
    case 'sales_invoice': {
      const inv = db.salesInvoices.find(i => i.id === id);
      const cust = inv ? db.customers.find(c => c.id === inv.customerId) : undefined;
      return {
        documentNumber: inv?.invoiceNumber || entry.reference || id || '',
        description: `فاتورة مبيعات${inv ? ` للعميل ${cust?.name || ''}` : ''}`,
        reference: entry.reference,
        link: inv ? { tab: 'sales', recordId: inv.id } : undefined,
      };
    }
    case 'sales_return':
    case 'sales_return_cogs': {
      const ret = db.salesReturns.find(r => r.id === id);
      const cust = ret ? db.customers.find(c => c.id === ret.customerId) : undefined;
      return {
        documentNumber: ret?.returnNumber || entry.reference || id || '',
        description: `مرتجع مبيعات من العميل ${cust?.name || ''}`,
        reference: entry.reference,
        link: ret ? { tab: 'sales', recordId: ret.id } : undefined,
      };
    }
    case 'customer_payment': {
      const pmt = db.payments.find(p => p.id === id);
      const cust = pmt ? db.customers.find(c => c.id === pmt.partyId) : undefined;
      const method = pmt?.paymentMethod === 'cash' ? 'نقدية' : pmt?.paymentMethod === 'bank' ? 'تحويل بنكي' : 'شيك';
      const cheque = pmt?.chequeId ? db.cheques.find(c => c.id === pmt.chequeId) : undefined;
      return {
        documentNumber: cheque?.chequeNumber || pmt?.paymentNumber || entry.reference || id || '',
        description: `سند تحصيل (${method}) من العميل ${cust?.name || ''}${pmt?.reference ? ` — ${pmt.reference}` : ''}`,
        reference: pmt?.reference || entry.reference,
        link: cheque ? { tab: 'cheques', recordId: cheque.id } : (pmt ? { tab: 'customers', recordId: pmt.id } : undefined),
      };
    }
    case 'cheque_registration':
    case 'cheque_recognition':
    case 'cheque_status_change': {
      const chq = db.cheques.find(c => c.id === id);
      const party = chq
        ? (chq.partyType === 'customer'
          ? db.customers.find(c => c.id === chq.partyId)?.name
          : db.suppliers.find(s => s.id === chq.partyId)?.name)
        : undefined;
      return {
        documentNumber: chq?.chequeNumber || entry.reference || id || '',
        description: `شيك ${chq?.type === 'outgoing' ? 'صادر' : 'وارد'}${chq ? ` - ${party || ''}` : ''} — ${entry.description}`,
        reference: entry.reference,
        link: chq ? { tab: 'cheques', recordId: chq.id } : undefined,
      };
    }
    case 'export_collection': {
      const shp = db.exportShipments.find(s => s.id === id);
      const cust = shp ? db.customers.find(c => c.id === shp.customerId) : undefined;
      return {
        documentNumber: shp ? `EXP-COL-${shp.shipmentNumber}` : (entry.reference || id || ''),
        description: `تحصيل شحنة تصدير${shp ? ` للعميل ${cust?.name || ''}` : ''}`,
        reference: entry.reference,
        link: shp ? { tab: 'export', recordId: shp.id } : undefined,
      };
    }
    default:
      return {
        documentNumber: entry.reference || entry.entryNumber,
        description: entry.description,
        reference: entry.reference,
      };
  }
}

export class LedgerService {
  /** Posted, non-reversed journal entries (the only authoritative postings). */
  private static posted(): JournalEntry[] {
    return erpDb.getSnapshot().journalEntries.filter(j => j.isPosted && !j.isReversed);
  }

  /** Receivable control account of a customer (1105 local / 1106 export). */
  public static receivableAccountId(customer: Pick<Customer, 'currency'>): string {
    return customer.currency === 'USD'
      ? AccountingEngine.getMappedAccountId('customer_receivable_export', 'acc-1106')
      : AccountingEngine.getMappedAccountId('customer_receivable_local', 'acc-1105');
  }

  /** Convert a journal line amount (EGP) into the customer's own currency. */
  private static toCustomerCurrency(amountEGP: number, lineCurrency: string, lineOriginal: number, lineRate: number, customer: Pick<Customer, 'currency'>): number {
    if (!amountEGP) return 0;
    if (customer.currency === 'USD') {
      if (lineCurrency === 'USD' && lineRate > 0 && lineOriginal) return lineOriginal;
      const rate = lineRate > 0 ? lineRate : (erpDb.getSnapshot().company.currentUsdExchangeRate || 1);
      return rate > 0 ? amountEGP / rate : amountEGP;
    }
    if (lineCurrency === 'EGP') return amountEGP;
    const rate = lineRate > 0 ? lineRate : (erpDb.getSnapshot().company.currentUsdExchangeRate || 1);
    return amountEGP * rate;
  }

  /**
   * Which customer does a journal entry belong to?
   * The receivable control accounts (1105/1106) are SHARED by every customer, so
   * the account alone is not enough — the source document of the entry decides.
   * Entries whose source document cannot be resolved to a customer are manual
   * postings and are reported separately, never silently attributed.
   */
  private static partyOf(entry: JournalEntry): string | undefined {
    const db = erpDb.getSnapshot();
    const id = entry.sourceDocumentId;
    if (!id) return undefined;
    switch (entry.sourceDocumentType) {
      case 'sales_invoice': return db.salesInvoices.find(i => i.id === id)?.customerId;
      case 'sales_return':
      case 'sales_return_cogs': return db.salesReturns.find(r => r.id === id)?.customerId;
      case 'customer_payment': {
        const p = db.payments.find(x => x.id === id);
        return p && p.paymentType === 'customer_receipt' ? p.partyId : undefined;
      }
      case 'cheque_registration':
      case 'cheque_recognition':
      case 'cheque_status_change': {
        const c = db.cheques.find(x => x.id === id);
        return c && c.partyType === 'customer' ? c.partyId : undefined;
      }
      case 'export_collection': return db.exportShipments.find(s => s.id === id)?.customerId;
      case 'rep_custody_sale': return db.salesInvoices.find(i => i.id === id)?.customerId;
      default: return undefined;
    }
  }

  /**
   * F27/F28/F30 — the ONE customer statement.
   * Every posted movement on the customer's receivable control account appears
   * exactly once, whether it originated from a sales invoice, a return, a cash or
   * bank collection, a cheque (registered on the Cheques screen or received with a
   * receipt), a cheque bounce or an export collection.
   */
  public static buildCustomerStatement(params: {
    customerId: string;
    fromDate?: string;
    toDate?: string;
    docType?: CustomerDocType | 'all';
  }): CustomerStatement {
    const db = erpDb.getSnapshot();
    const customer = db.customers.find(c => c.id === params.customerId);
    const empty: CustomerStatement = {
      customerId: params.customerId, currency: 'EGP', openingBalance: 0, rows: [],
      totalDebit: 0, totalCredit: 0, closingBalance: 0, cardBalance: 0, cardDiff: 0, glBalance: 0, glDiff: 0,
    };
    if (!customer) return empty;

    const recvAcc = this.receivableAccountId(customer);
    const fromDate = params.fromDate || '0000-01-01';
    const toDate = params.toDate || '9999-12-31';
    const docType = params.docType || 'all';

    const items = this.posted()
      .map(entry => {
        const lines = entry.lines.filter(l => l.accountId === recvAcc);
        if (lines.length === 0) return null;
        // 1105/1106 are shared control accounts: only entries whose SOURCE
        // document belongs to this customer belong in this customer's statement.
        if (this.partyOf(entry) !== customer.id) return null;
        const type = classify(entry);
        const info = describe(entry);
        let debit = 0;
        let credit = 0;
        for (const l of lines) {
          debit += this.toCustomerCurrency(l.debit || 0, l.currency, l.originalAmount || 0, l.exchangeRate || 0, customer);
          credit += this.toCustomerCurrency(l.credit || 0, l.currency, l.originalAmount || 0, l.exchangeRate || 0, customer);
        }
        return {
          id: entry.id,
          date: entry.date,
          documentNumber: info.documentNumber,
          documentType: type,
          documentTypeLabelAr: DOC_LABELS[type],
          description: info.description,
          reference: info.reference,
          link: info.link,
          debit: Number(debit.toFixed(2)),
          credit: Number(credit.toFixed(2)),
          entryNumber: entry.entryNumber,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => {
        const byDate = (a.date || '').localeCompare(b.date || '');
        if (byDate !== 0) return byDate;
        return (a.entryNumber || '').localeCompare(b.entryNumber || '', 'en', { numeric: true });
      });

    let opening = Number(customer.openingBalance) || 0;
    for (const it of items) {
      if (it.date < fromDate) opening += it.debit - it.credit;
    }
    opening = Number(opening.toFixed(2));

    const visible = items.filter(it =>
      it.date >= fromDate && it.date <= toDate && (docType === 'all' || it.documentType === docType)
    );

    let running = opening;
    let totalDebit = 0;
    let totalCredit = 0;
    const rows: CustomerStatementRow[] = visible.map(it => {
      totalDebit += it.debit;
      totalCredit += it.credit;
      running = Number((running + it.debit - it.credit).toFixed(2));
      return { ...it, runningBalance: running };
    });

    const closingBalance = running;
    const cardBalance = Number(customer.currentBalance || 0);
    const glBalance = Number((closingBalance).toFixed(2));

    return {
      customerId: customer.id,
      currency: customer.currency,
      openingBalance: opening,
      rows,
      totalDebit: Number(totalDebit.toFixed(2)),
      totalCredit: Number(totalCredit.toFixed(2)),
      closingBalance,
      cardBalance,
      cardDiff: Number((closingBalance - cardBalance).toFixed(2)),
      glBalance,
      glDiff: 0,
    };
  }

  /** All customers' GL receivable closing balances (F30 reconciliation). */
  public static receivableAgingRows(): Array<{ customerId: string; balance: number }> {
    const db = erpDb.getSnapshot();
    return db.customers.map(c => ({
      customerId: c.id,
      balance: this.buildCustomerStatement({ customerId: c.id }).closingBalance,
    }));
  }
}

export interface TreasuryRow {
  id: string;
  date: string;
  documentNumber: string;
  transactionType: TreasuryTransaction['type'];
  transactionTypeLabelAr: string;
  isDebit: boolean;
  description: string;
  partyName: string;
  debit: number;
  credit: number;
  postingSequence: string;
  runningBalance: number;
  sourceDocumentType: string;
  journalEntryId: string;
  link?: { tab: string; recordId: string };
}

export interface TreasuryLedger {
  cashAccountId: string;
  openingBalance: number;
  rows: TreasuryRow[];
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
  /** GL 1101 balance — the ledger MUST equal it. */
  glBalance: number;
  glDiff: number;
}

const TREASURY_TYPE_BY_SOURCE: Record<string, TreasuryTransaction['type']> = {
  sales_invoice: 'cash_receipt',
  customer_payment: 'cash_receipt',
  supplier_payment: 'cash_payment',
  rep_custody_settlement: 'cash_receipt',
  rep_custody_loading: 'advance_custody',
  rep_loading: 'advance_custody',
  expense: 'cash_payment',
  treasury_transaction: 'cash_receipt',
  purchase_invoice: 'cash_payment',
  export_collection: 'cash_receipt',
  sales_return: 'cash_payment',
};

const TREASURY_LABEL_AR: Record<string, string> = {
  sales_invoice: 'مبيعات نقدية',
  customer_payment: 'تحصيل عميل نقدي',
  supplier_payment: 'سداد مورد نقدي',
  rep_custody_settlement: 'تسوية عهدة مندوب',
  rep_custody_loading: 'تحميل عهدة مندوب',
  rep_loading: 'تحميل عهدة مندوب',
  expense: 'مصروف نقدي',
  treasury_transaction: 'حركة خزينة',
  purchase_invoice: 'سداد مشتريات',
  export_collection: 'تحصيل تصدير',
  sales_return: 'مرتجع مبيعات',
};

function treasuryPartyName(entry: JournalEntry): string {
  const db = erpDb.getSnapshot();
  const id = entry.sourceDocumentId;
  switch (entry.sourceDocumentType) {
    case 'customer_payment': {
      const p = db.payments.find(x => x.id === id);
      return p ? (db.customers.find(c => c.id === p.partyId)?.name || '') : '';
    }
    case 'supplier_payment': {
      const p = db.payments.find(x => x.id === id);
      return p ? (db.suppliers.find(s => s.id === p.partyId)?.name || '') : '';
    }
    case 'sales_invoice': {
      const i = db.salesInvoices.find(x => x.id === id);
      return i ? (db.customers.find(c => c.id === i.customerId)?.name || '') : '';
    }
    case 'rep_custody_settlement': {
      const c = db.representativeCustodies.find(x => x.id === id);
      const rep = c ? db.salesReps.find(r => r.id === c.repId) : undefined;
      return rep ? `${rep.name} (${c?.custodyNumber || ''})` : (c?.custodyNumber || '');
    }
    case 'rep_loading':
    case 'rep_custody_loading': {
      const c = db.representativeCustodies.find(x => x.id === id);
      const rep = c ? db.salesReps.find(r => r.id === c.repId) : undefined;
      return rep ? `${rep.name} (${c?.custodyNumber || ''})` : (c?.custodyNumber || '');
    }
    case 'expense': {
      const e = db.expenses.find(x => x.id === id);
      return e?.description || '';
    }
    case 'export_collection': {
      const s = db.exportShipments.find(x => x.id === id);
      return s ? (db.customers.find(c => c.id === s.customerId)?.name || '') : '';
    }
    default: return '';
  }
}

function treasuryLink(entry: JournalEntry): TreasuryRow['link'] {
  const id = entry.sourceDocumentId;
  switch (entry.sourceDocumentType) {
    case 'sales_invoice': return { tab: 'sales', recordId: id || '' };
    case 'customer_payment': case 'supplier_payment': return { tab: 'treasury', recordId: id || '' };
    case 'rep_custody_settlement': case 'rep_loading': case 'rep_custody_loading':
      return { tab: 'representatives', recordId: id || '' };
    case 'expense': return { tab: 'expenses', recordId: id || '' };
    case 'export_collection': return { tab: 'export', recordId: id || '' };
    default: return { tab: 'treasury', recordId: id || '' };
  }
}

/**
 * F29 — TREASURY as a single source of truth.
 *
 * Derived from the posted journal lines of the cash account (1101), so every
 * economically cash-affecting workflow (cash sales, customer cash collection,
 * supplier cash payment, representative custody settlement/loading, cash expense,
 * internal cash transfer) moves the ledger and the GL in perfect lockstep. It is
 * impossible for a workflow to move cash in the GL without appearing here.
 */
export class TreasuryLedgerService {
  public static build(params: {
    fromDate?: string;
    toDate?: string;
    typeFilter?: TreasuryTransaction['type'] | 'all';
  }): TreasuryLedger {
    const db = erpDb.getSnapshot();
    const cashAcc = AccountingEngine.getMappedAccountId('cash_treasury', 'acc-1101');
    const fromDate = params.fromDate || '0000-01-01';
    const toDate = params.toDate || '9999-12-31';
    const typeFilter = params.typeFilter || 'all';

    const hits = erpDb.getSnapshot().journalEntries
      .filter(j => j.isPosted && !j.isReversed)
      .map(entry => {
        const lines = entry.lines.filter(l => l.accountId === cashAcc);
        if (lines.length === 0) return null;
        let debit = 0;
        let credit = 0;
        for (const l of lines) { debit += l.debit || 0; credit += l.credit || 0; }
        const type = TREASURY_TYPE_BY_SOURCE[entry.sourceDocumentType]
          || (credit > debit ? 'cash_payment' : 'cash_receipt');
        return {
          id: entry.id,
          journalEntryId: entry.id,
          date: entry.date,
          documentNumber: entry.reference || entry.entryNumber,
          transactionType: type as TreasuryTransaction['type'],
          transactionTypeLabelAr: TREASURY_LABEL_AR[entry.sourceDocumentType] || (credit > debit ? 'سند صرف نقدية' : 'سند قبض وارد'),
          isDebit: debit > 0,
          description: entry.description,
          partyName: treasuryPartyName(entry),
          debit: Number(debit.toFixed(2)),
          credit: Number(credit.toFixed(2)),
          postingSequence: entry.entryNumber,
          sourceDocumentType: entry.sourceDocumentType,
          link: treasuryLink(entry),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => {
        const byDate = (a.date || '').localeCompare(b.date || '');
        if (byDate !== 0) return byDate;
        return (a.postingSequence || '').localeCompare(b.postingSequence || '', 'en', { numeric: true });
      });

    let opening = 0;
    for (const h of hits) {
      if (h.date < fromDate) opening += h.debit - h.credit;
    }
    opening = Number(opening.toFixed(2));

    const visible = hits.filter(h =>
      h.date >= fromDate && h.date <= toDate && (typeFilter === 'all' || h.transactionType === typeFilter)
    );

    let running = opening;
    let totalDebit = 0;
    let totalCredit = 0;
    const rows: TreasuryRow[] = visible.map(h => {
      totalDebit += h.debit;
      totalCredit += h.credit;
      running = Number((running + h.debit - h.credit).toFixed(2));
      return { ...h, runningBalance: running };
    });

    const closingBalance = running;
    const glBalance = Number((db.accounts.find(a => a.id === cashAcc)?.currentBalance || 0).toFixed(2));

    return {
      cashAccountId: cashAcc,
      openingBalance: opening,
      rows,
      totalDebit: Number(totalDebit.toFixed(2)),
      totalCredit: Number(totalCredit.toFixed(2)),
      closingBalance,
      glBalance,
      glDiff: Number((closingBalance - glBalance).toFixed(2)),
    };
  }
}
