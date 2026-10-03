// UI permission affordances (QA-25).
//
// This is PURELY a UI affordance: a role without `create` on a module must not
// see an enabled write button that the service layer will reject.
// AuthorizationService remains the real security boundary — nothing here
// weakens or replaces it.
import { useMemo } from 'react';
import { AuthService } from '../services/auth';
import { PermissionService } from '../services/permissions';
import type { NavTab } from '../components/layout/Sidebar';

export interface ModuleWriteAccess {
  /** The role the UI is rendering for. */
  role: string;
  canCreate: boolean;
  canPost: boolean;
  /** Arabic tooltip shown on a disabled write control. */
  createDeniedTitle: string;
  postDeniedTitle: string;
  /** Arabic banner shown instead of an enabled write control. */
  readOnlyNotice: string;
}

/**
 * Read-only affordances for a module tab. Re-evaluates whenever the session
 * changes (login / logout / role switch) because getCurrentSession() is read on
 * every render and memoised against the session object identity.
 */
export function useModuleWriteAccess(tab: NavTab, moduleNameAr: string): ModuleWriteAccess {
  return useMemo(() => {
    const role = AuthService.getCurrentSession()?.user.role || 'Viewer';
    const canCreate = PermissionService.canCreate(role, tab);
    const canPost = PermissionService.canPost(role, tab);
    return {
      role,
      canCreate,
      canPost,
      createDeniedTitle: `لا تملك صلاحية إنشاء سجلات في ${moduleNameAr} — العرض فقط`,
      postDeniedTitle: `لا تملك صلاحية الترحيل في ${moduleNameAr} — العرض فقط`,
      readOnlyNotice: `دورك الحالي (${role}) لا يملك صلاحية الإضافة أو الترحيل في ${moduleNameAr} — العرض فقط.`,
    };
  }, [tab, moduleNameAr]);
}