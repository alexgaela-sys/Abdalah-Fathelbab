// Calls the erp-admin-users Edge Function: the only place where sign-in accounts
// are created, switched off, re-passworded or deleted. It runs on the server with
// the service key; this file only carries the signed-in admin's own token to it.

import { getCloudRuntime } from './cloudRuntime';

export type AdminUsersRequest =
  | { action: 'create'; email: string; password: string; role?: 'admin' | 'staff' }
  | { action: 'set_password'; user_id: string; password: string }
  | { action: 'set_active'; user_id: string; active: boolean }
  | { action: 'set_role'; user_id: string; role: 'admin' | 'staff' }
  | { action: 'delete'; user_id: string };

export type AdminUsersResult = { ok: true; user_id?: string } | { ok: false; messageAr: string };

const MESSAGES: Record<string, string> = {
  email_exists: 'هذا البريد الإلكتروني مسجل بالفعل كحساب دخول',
  invalid_email: 'البريد الإلكتروني غير صحيح',
  password_too_short: 'كلمة المرور يجب ألا تقل عن 6 أحرف',
  admin_only: 'هذه العملية للمدير فقط',
  not_signed_in: 'انتهت جلسة الدخول، سجّل الدخول من جديد',
  cannot_disable_self: 'لا يمكنك تعطيل حسابك أنت',
  cannot_delete_self: 'لا يمكنك حذف حسابك أنت',
  cannot_change_own_role: 'لا يمكنك تغيير دور حسابك أنت',
};

export async function callAdminUsers(req: AdminUsersRequest): Promise<AdminUsersResult> {
  const rt = getCloudRuntime();
  if (!rt) return { ok: false, messageAr: 'النسخة السحابية غير مفعلة' };
  try {
    const token = await rt.auth.getAccessToken();
    const res = await fetch(`${rt.cfg.url}/functions/v1/erp-admin-users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: rt.cfg.anonKey,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(req),
    });
    if (res.status === 404) {
      return { ok: false, messageAr: 'خدمة إدارة الحسابات غير منشورة على Supabase (erp-admin-users)' };
    }
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (body?.ok) return { ok: true, user_id: body.user_id };
    const code = String(body?.error ?? `http_${res.status}`);
    return { ok: false, messageAr: MESSAGES[code] ?? `تعذّر تنفيذ العملية (${code})` };
  } catch {
    return { ok: false, messageAr: 'تعذّر الاتصال بالخادم، تحقق من الإنترنت وحاول مرة أخرى' };
  }
}
