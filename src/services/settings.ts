// ITEM 13 — application settings (stored in the database schema, persisted to
// localStorage with everything else). Values are validated here; the UI never
// writes the schema directly.
import { erpDb, generateErpId } from './db';
import { AuthorizationService } from './authorization';

export class SettingsService {
  /** Days-before-expiry threshold for the "near expiry" bucket (default 10, always positive). */
  public static getExpiryWarningDays(): number {
    const db = erpDb.getSnapshot();
    const value = Number(db.settings?.expiryWarningDays);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 10;
  }

  public static setExpiryWarningDays(params: {
    days: number;
    userId?: string;
    userName?: string;
    isTest?: boolean;
  }): { success: boolean; error?: string; value?: number } {
    const guard = AuthorizationService.enforce('inventory', 'edit', {
      userId: params.userId, userName: params.userName, isTest: params.isTest,
    });
    if (!guard.allowed) return { success: false, error: guard.error };

    const days = Number(params.days);
    if (!Number.isFinite(days) || !Number.isInteger(days) || days < 1 || days > 3650) {
      return { success: false, error: 'عتبة الصلاحية يجب أن تكون عدد أيام صحيحًا بين 1 و 3650' };
    }
    const previous = this.getExpiryWarningDays();
    erpDb.mutate(draft => {
      draft.settings = { ...(draft.settings || { expiryWarningDays: 10 }), expiryWarningDays: days };
      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: new Date().toISOString(),
        userId: guard.userId,
        userName: guard.userName,
        module: 'المخزون - الإعدادات',
        action: 'edit',
        recordId: 'settings.expiryWarningDays',
        description: `تعديل عتبة تقرير الصلاحية من ${previous} إلى ${days} يوم`,
      });
    });
    return { success: true, value: days };
  }
}
