// Accounting Engine: Double-Entry Validation, Period Checking, Auto-Posting & Financial Statements
import { erpDb } from './db';
import { JournalEntry, JournalLine, Account, AccountingPeriod } from '../types/erp';

export interface ValidationResult {
  valid: boolean;
  errorAr?: string;
}

export class AccountingEngine {
  /**
   * Check if a given date falls inside an open accounting period.
   * Closed periods reject any new postings!
   */
  public static isPeriodOpen(dateStr: string): { isOpen: boolean; period?: AccountingPeriod; errorAr?: string } {
    const db = erpDb.getSnapshot();
    const targetDate = new Date(dateStr);
    
    // Find matching period
    const matchedPeriod = db.accountingPeriods.find(p => {
      const start = new Date(p.startDate);
      const end = new Date(p.endDate);
      end.setHours(23, 59, 59, 999);
      return targetDate >= start && targetDate <= end;
    });

    if (!matchedPeriod) {
      // If no exact period configured, verify if any closed period covers it
      const closedConflict = db.accountingPeriods.find(p => {
        if (!p.isClosed) return false;
        const start = new Date(p.startDate);
        const end = new Date(p.endDate);
        end.setHours(23, 59, 59, 999);
        return targetDate >= start && targetDate <= end;
      });
      if (closedConflict) {
        return { isOpen: false, period: closedConflict, errorAr: `لا يمكن ترحيل قيود في فترة مالية مغلقة (${closedConflict.nameAr})` };
      }
      return { isOpen: true }; // Open by default if unassigned
    }

    if (matchedPeriod.isClosed) {
      return { isOpen: false, period: matchedPeriod, errorAr: `الفترة المالية (${matchedPeriod.nameAr}) مغلقة ماليًا ومحظور إجراء قيود يومية عليها` };
    }

    return { isOpen: true, period: matchedPeriod };
  }

  /**
   * Validate double entry journal constraints:
   * 1. Total Debit == Total Credit (Tolerance 0.001)
   * 2. No posting to header accounts
   * 3. Must have at least 2 lines
   * 4. Date must be in an open period
   */
  public static validateJournalEntry(entry: Omit<JournalEntry, 'id' | 'entryNumber' | 'isPosted' | 'totalDebit' | 'totalCredit' | 'createdUserId'>): ValidationResult {
    if (!entry.lines || entry.lines.length < 2) {
      return { valid: false, errorAr: 'القيد المحاسبي يجب أن يحتوي على طرفين على الأقل (مدين ودائن)' };
    }

    // Verify open period
    const periodCheck = this.isPeriodOpen(entry.date);
    if (!periodCheck.isOpen) {
      return { valid: false, errorAr: periodCheck.errorAr || 'الفترة المحاسبية مغلقة' };
    }

    const db = erpDb.getSnapshot();
    const accountsMap = new Map<string, Account>();
    db.accounts.forEach(acc => accountsMap.set(acc.id, acc));

    let totalDebit = 0;
    let totalCredit = 0;

    for (let i = 0; i < entry.lines.length; i++) {
      const line = entry.lines[i];
      const account = accountsMap.get(line.accountId);

      if (!account) {
        return { valid: false, errorAr: `الحساب رقم ${line.accountCode || line.accountId} غير موجود بدليل الحسابات` };
      }

      if (account.isHeader) {
        return { valid: false, errorAr: `مرفوض: لا يمكن الترحيل على حساب رئيسي تجميعي (${account.code} - ${account.nameAr})، يجب اختيار حساب فرعي تحليلي` };
      }

      const debit = Number(line.debit) || 0;
      const credit = Number(line.credit) || 0;

      if (debit < 0 || credit < 0) {
        return { valid: false, errorAr: 'لا يُسمح بإدخال مبالغ سالبة في طرفي القيد' };
      }

      if (debit === 0 && credit === 0) {
        return { valid: false, errorAr: `يجب تحديد مبلغ مدين أو دائن للسطر رقم ${i + 1}` };
      }

      totalDebit += debit;
      totalCredit += credit;
    }

    const difference = Math.abs(totalDebit - totalCredit);
    if (difference > 0.01) {
      return {
        valid: false,
        errorAr: `القيد غير متزن ماليًا! إجمالي المدين (${totalDebit.toFixed(2)}) لا يساوي إجمالي الدائن (${totalCredit.toFixed(2)}) - الفرق: ${difference.toFixed(2)} ج.م`
      };
    }

    return { valid: true };
  }

  /**
   * Post a balanced journal entry into General Ledger
   */
  public static postJournal(
    entryData: Omit<JournalEntry, 'id' | 'entryNumber' | 'isPosted' | 'totalDebit' | 'totalCredit' | 'createdUserId'>,
    userId: string = 'usr-admin',
    userName: string = 'مدير النظام'
  ): { success: boolean; entry?: JournalEntry; error?: string } {
    const validation = this.validateJournalEntry(entryData);
    if (!validation.valid) {
      return { success: false, error: validation.errorAr };
    }

    let createdEntry: JournalEntry | undefined;

    erpDb.mutate((draft) => {
      const totalDebit = entryData.lines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
      const totalCredit = entryData.lines.reduce((sum, l) => sum + (Number(l.credit) || 0), 0);

      const count = draft.journalEntries.length + 1;
      const entryNumber = `JV-${new Date().getFullYear()}-${String(count).padStart(5, '0')}`;

      const newId = `jv-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      createdEntry = {
        ...entryData,
        id: newId,
        entryNumber,
        isPosted: true,
        postedAt: new Date().toISOString(),
        totalDebit,
        totalCredit,
        createdUserId: userId,
        lines: entryData.lines.map((l, idx) => ({
          ...l,
          id: `jvl-${newId}-${idx + 1}`,
          journalEntryId: newId,
        }))
      };

      draft.journalEntries.push(createdEntry);

      // Update account balances
      createdEntry.lines.forEach((line) => {
        const acc = draft.accounts.find(a => a.id === line.accountId);
        if (acc) {
          // Standard balance update:
          // For Assets & COGS & Expenses: Debit increases balance, Credit decreases
          // For Liabilities & Equity & Revenue: Credit increases balance, Debit decreases
          const isDebitNature = ['Assets', 'COGS', 'Operating Expenses', 'Other Expenses'].includes(acc.category);
          const impact = isDebitNature ? (line.debit - line.credit) : (line.credit - line.debit);
          acc.currentBalance = (acc.currentBalance || 0) + impact;
        }
      });

      // Audit Log
      draft.auditLogs.push({
        id: `aud-${Date.now()}`,
        timestamp: new Date().toISOString(),
        userId,
        userName,
        module: 'المحاسبة العامة',
        action: 'post',
        recordId: newId,
        description: `ترحيل قيد يومية متزن رقم ${entryNumber} بقيمة ${totalDebit.toLocaleString('ar-EG')} ج.م: ${entryData.description}`,
      });
    });

    return { success: true, entry: createdEntry };
  }

  /**
   * Reverse an existing posted journal entry (Cancellation via reversal)
   */
  public static reverseJournal(
    originalEntryId: string, 
    reason: string, 
    userId: string = 'usr-admin',
    userName: string = 'مدير النظام'
  ): { success: boolean; reversalEntry?: JournalEntry; error?: string } {
    const db = erpDb.getSnapshot();
    const original = db.journalEntries.find(j => j.id === originalEntryId);

    if (!original) {
      return { success: false, error: 'القيد المحاسبي الأصلي غير موجود' };
    }

    if (original.isReversed) {
      return { success: false, error: 'تم إلغاء وعكس هذا القيد المحاسبي مسبقًا' };
    }

    // Verify current date period is open
    const todayStr = new Date().toISOString().split('T')[0];
    const periodCheck = this.isPeriodOpen(todayStr);
    if (!periodCheck.isOpen) {
      return { success: false, error: `لا يمكن إجراء قيد عكسي: ${periodCheck.errorAr}` };
    }

    let reversalEntry: JournalEntry | undefined;

    erpDb.mutate((draft) => {
      const origInDraft = draft.journalEntries.find(j => j.id === originalEntryId);
      if (!origInDraft) return;

      const reversalLines: JournalLine[] = origInDraft.lines.map((line, idx) => ({
        ...line,
        id: `rev-line-${Date.now()}-${idx}`,
        journalEntryId: '',
        debit: line.credit, // swap debit and credit
        credit: line.debit,
        description: `قيد عكسي للقيد ${origInDraft.entryNumber} - ${reason}`
      }));

      const count = draft.journalEntries.length + 1;
      const reversalNumber = `REV-${new Date().getFullYear()}-${String(count).padStart(5, '0')}`;
      const revId = `rev-${Date.now()}`;

      reversalEntry = {
        id: revId,
        entryNumber: reversalNumber,
        date: todayStr,
        reference: `عكس قيد ${origInDraft.entryNumber}`,
        description: `قيد عكسي وإلغاء للقيد رقم ${origInDraft.entryNumber}: ${reason}`,
        sourceDocumentType: 'journal_reversal',
        sourceDocumentId: origInDraft.id,
        isPosted: true,
        postedAt: new Date().toISOString(),
        totalDebit: origInDraft.totalCredit,
        totalCredit: origInDraft.totalDebit,
        createdUserId: userId,
        lines: reversalLines.map(l => ({ ...l, journalEntryId: revId })),
      };

      origInDraft.isReversed = true;
      origInDraft.reversedByEntryId = revId;
      draft.journalEntries.push(reversalEntry);

      // Adjust account balances
      reversalEntry.lines.forEach(line => {
        const acc = draft.accounts.find(a => a.id === line.accountId);
        if (acc) {
          const isDebitNature = ['Assets', 'COGS', 'Operating Expenses', 'Other Expenses'].includes(acc.category);
          const impact = isDebitNature ? (line.debit - line.credit) : (line.credit - line.debit);
          acc.currentBalance = (acc.currentBalance || 0) + impact;
        }
      });

      // Audit Log
      draft.auditLogs.push({
        id: `aud-${Date.now()}`,
        timestamp: new Date().toISOString(),
        userId,
        userName,
        module: 'المحاسبة العامة',
        action: 'reverse',
        recordId: revId,
        description: `إجراء قيد عكسي ${reversalNumber} لعكس القيد ${origInDraft.entryNumber}. السبب: ${reason}`,
      });
    });

    return { success: true, reversalEntry };
  }

  /**
   * Helper to retrieve configured Account ID from mappings
   */
  public static getMappedAccountId(key: string, defaultFallbackId: string): string {
    const db = erpDb.getSnapshot();
    return db.accountMappings[key] || defaultFallbackId;
  }
}
