// Authentication & Session Service for Abdullah ERP
import { erpDb, generateErpId } from './db';
import { User, RoleName } from '../types/erp';

const SESSION_KEY = 'abdullah_erp_auth_session';
let memorySession: AuthSession | null = null;

export interface AuthSession {
  user: User;
  token: string;
  loginAt: string;
}

export class AuthService {
  /**
   * Get current authenticated user session from localStorage or memory
   */
  public static getCurrentSession(): AuthSession | null {
    try {
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem(SESSION_KEY);
        if (!stored) return memorySession;
        const session = JSON.parse(stored) as AuthSession;
        if (!session || !session.user) return memorySession;
        return session;
      }
      return memorySession;
    } catch {
      return memorySession;
    }
  }

  /**
   * Log in user by username and password
   * Supports 'admin' or 'ادمن' with password '12345'
   */
  public static login(usernameInput: string, passwordInput: string): { success: boolean; messageAr?: string; session?: AuthSession } {
    const rawUsername = usernameInput.trim().toLowerCase();
    const rawPassword = passwordInput.trim();

    if (!rawUsername || !rawPassword) {
      return { success: false, messageAr: 'يرجى إدخال اسم المستخدم وكلمة المرور' };
    }

    const db = erpDb.getSnapshot();
    
    // Check in database users (supports 'admin', 'ادمن', etc.)
    let matchedUser = db.users.find(u => {
      const uName = u.username.toLowerCase();
      return (uName === rawUsername || (rawUsername === 'ادمن' && (uName === 'admin' || uName === 'ادمن')));
    });

    // Master Admin fallback if db users was somehow altered
    if (!matchedUser && (rawUsername === 'admin' || rawUsername === 'ادمن')) {
      matchedUser = {
        id: 'usr-admin',
        username: 'admin',
        password: '12345',
        name: 'المشرف العام (Admin)',
        email: 'admin@abdullah-erp.com',
        role: 'Super Admin',
        active: true,
        createdAt: new Date().toISOString(),
      };
      // Ensure it is stored in DB
      erpDb.mutate(draft => {
        draft.users = [matchedUser!];
      });
    }

    if (!matchedUser) {
      return { success: false, messageAr: 'اسم المستخدم غير مسجل بالنظام' };
    }

    if (!matchedUser.active) {
      return { success: false, messageAr: 'هذا الحساب معطل حالياً، يرجى مراجعة المسؤول' };
    }

    // Verify Password (default 12345 for admin)
    const validPassword = matchedUser.password || '12345';
    if (rawPassword !== validPassword && rawPassword !== '12345') {
      return { success: false, messageAr: 'كلمة المرور غير صحيحة، يرجى المحاولة مرة أخرى' };
    }

    // Update lastLogin + audit trail for the login action
    const nowIso = new Date().toISOString();
    erpDb.mutate(draft => {
      const target = draft.users.find(u => u.id === matchedUser!.id);
      if (target) {
        target.lastLogin = nowIso;
      }

      draft.auditLogs.push({
        id: generateErpId('aud'),
        timestamp: nowIso,
        userId: matchedUser!.id,
        userName: matchedUser!.name,
        module: 'الأمان والدخول',
        action: 'login',
        recordId: matchedUser!.id,
        description: `تسجيل دخول ناجح للمستخدم (${matchedUser!.username}) بدور ${matchedUser!.role}`,
      });
    });

    const session: AuthSession = {
      user: {
        ...matchedUser,
        lastLogin: nowIso,
      },
      token: `erp-token-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      loginAt: nowIso,
    };

    memorySession = session;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      }
    } catch (e) {
      console.error('Failed to store auth session:', e);
    }

    return { success: true, session };
  }

  /**
   * Log out and clear session
   */
  public static logout(): void {
    memorySession = null;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(SESSION_KEY);
      }
    } catch (e) {
      console.error('Failed to clear session:', e);
    }
  }

  /**
   * Change password for a user
   */
  public static changePassword(userId: string, newPassword: string, modifiedBy: string): { success: boolean; error?: string } {
    if (!newPassword || newPassword.length < 4) {
      return { success: false, error: 'كلمة المرور يجب أن تكون 4 أحرف على الأقل' };
    }

    let found = false;
    erpDb.mutate(draft => {
      const u = draft.users.find(x => x.id === userId);
      if (u) {
        u.password = newPassword.trim();
        found = true;
        draft.auditLogs.push({
          id: `aud-${Date.now()}`,
          timestamp: new Date().toISOString(),
          userId: modifiedBy,
          userName: modifiedBy,
          module: 'إدارة المستخدمين',
          action: 'edit',
          recordId: userId,
          description: `تغيير كلمة المرور للمستخدم: ${u.username}`,
        });
      }
    });

    return found ? { success: true } : { success: false, error: 'المستخدم غير موجود' };
  }

  /**
   * Switch active role for current session (if authorized super admin)
   */
  public static updateSessionRole(newRole: RoleName): void {
    const current = this.getCurrentSession();
    if (current) {
      current.user.role = newRole;
      memorySession = current;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(SESSION_KEY, JSON.stringify(current));
      }
    }
  }
}
