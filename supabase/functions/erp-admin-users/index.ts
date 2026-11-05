// erp-admin-users — creates and manages SIGN-IN accounts on behalf of an ERP admin.
//
// Why a server function: creating a login needs the project's service-role key,
// which must never reach a browser. The browser calls this function with the
// signed-in admin's own token; the function checks, against the database, that
// the caller really is an approved admin member before it does anything.
//
// Actions (JSON body):
//   create        { email, password, role?: 'admin'|'staff' }  -> { ok, user_id }
//   set_password  { user_id, password }
//   set_active    { user_id, active }          (disables sign-in and ERP access)
//   set_role      { user_id, role: 'admin'|'staff' }
//   delete        { user_id }
//
// What each ERP user may DO inside the app (Accountant, Warehouse ... and the
// per-module permissions) is stored in the ERP's own users list, not here. Here a
// login is only "allowed in" (staff) or "may also manage users and import" (admin).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ ok: false, error: 'method_not_allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader = req.headers.get('Authorization') ?? '';

  // 1) who is calling
  const asCaller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: who, error: whoErr } = await asCaller.auth.getUser();
  if (whoErr || !who?.user) return reply({ ok: false, error: 'not_signed_in' }, 401);
  const callerId = who.user.id;

  // 2) is the caller an approved admin member (checked with the service role, never trusted from the client)
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: member } = await admin
    .from('erp_members').select('role,status').eq('user_id', callerId).maybeSingle();
  if (!member || member.status !== 'approved' || member.role !== 'admin') {
    return reply({ ok: false, error: 'admin_only' }, 403);
  }

  let body: any;
  try { body = await req.json(); } catch { return reply({ ok: false, error: 'bad_json' }, 400); }
  const action = String(body?.action ?? '');
  const memberRole = (r: unknown) => (r === 'admin' ? 'admin' : 'staff');

  try {
    if (action === 'create') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const password = String(body.password ?? '');
      if (!EMAIL_RE.test(email)) return reply({ ok: false, error: 'invalid_email' }, 400);
      if (password.length < 6) return reply({ ok: false, error: 'password_too_short' }, 400);

      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error || !data?.user) {
        const msg = error?.message ?? 'create_failed';
        return reply({ ok: false, error: /already|registered|exists/i.test(msg) ? 'email_exists' : msg }, 400);
      }
      const { error: insErr } = await admin.from('erp_members').insert({
        user_id: data.user.id, note: email, status: 'approved', role: memberRole(body.role),
      });
      if (insErr) {
        await admin.auth.admin.deleteUser(data.user.id); // do not leave a login that cannot work
        return reply({ ok: false, error: insErr.message }, 500);
      }
      return reply({ ok: true, user_id: data.user.id });
    }

    const userId = String(body.user_id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return reply({ ok: false, error: 'invalid_user_id' }, 400);
    const isSelf = userId === callerId;

    if (action === 'set_password') {
      const password = String(body.password ?? '');
      if (password.length < 6) return reply({ ok: false, error: 'password_too_short' }, 400);
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return reply({ ok: false, error: error.message }, 400);
      return reply({ ok: true });
    }

    if (action === 'set_active') {
      if (isSelf) return reply({ ok: false, error: 'cannot_disable_self' }, 400);
      const active = body.active === true;
      const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: active ? 'none' : '876000h' });
      if (error) return reply({ ok: false, error: error.message }, 400);
      await admin.from('erp_members').update({ status: active ? 'approved' : 'pending' }).eq('user_id', userId);
      return reply({ ok: true });
    }

    if (action === 'set_role') {
      if (isSelf) return reply({ ok: false, error: 'cannot_change_own_role' }, 400);
      const { error } = await admin.from('erp_members').update({ role: memberRole(body.role) }).eq('user_id', userId);
      if (error) return reply({ ok: false, error: error.message }, 400);
      return reply({ ok: true });
    }

    if (action === 'delete') {
      if (isSelf) return reply({ ok: false, error: 'cannot_delete_self' }, 400);
      await admin.from('erp_members').delete().eq('user_id', userId);
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) return reply({ ok: false, error: error.message }, 400);
      return reply({ ok: true });
    }

    return reply({ ok: false, error: 'unknown_action' }, 400);
  } catch (e) {
    return reply({ ok: false, error: (e as Error).message || 'server_error' }, 500);
  }
});
