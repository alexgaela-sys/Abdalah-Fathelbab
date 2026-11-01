// Tests the Supabase HTTP client (sign-in, token refresh, RPC calls, error
// mapping) against a scripted fake server — no network, no database needed.
// Run: bun scripts/cloud_http_selftest.ts
import { SupabaseAuth, SupabaseHttpStore } from '../src/services/cloud/supabaseHttpStore';
import { RemoteRejectedError, RemoteUnavailableError } from '../src/services/cloud/remoteStore';

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, info = '') => {
  if (ok) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}${info ? ` — ${info}` : ''}`); }
};
const rejects = async (p: Promise<unknown>, cls: any, code?: string) => {
  try { await p; return false; } catch (e: any) { return e instanceof cls && (code ? e.code === code : true); }
};

const cfg = { url: 'https://proj.supabase.co', anonKey: 'anon-key-0123456789abcdef' };
const resp = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const tokenBody = (n: number, expiresIn = 3600) => ({
  access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: expiresIn, user: { id: 'u1', email: 'a@b.test' },
});
const memStorage = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; };

type Call = { url: string; init: any };
function scripted(handler: (url: string, init: any, calls: Call[]) => any) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: any) => { calls.push({ url, init }); return handler(url, init, calls); };
  return { fetchImpl, calls };
}

// ---- sign in ------------------------------------------------------------
console.log('\n▶ Sign-in');
{
  const st = memStorage();
  const { fetchImpl, calls } = scripted(() => resp(200, tokenBody(1)));
  const auth = new SupabaseAuth(cfg, { fetchImpl, storage: st });
  const s = await auth.signIn(' a@b.test ', 'pw');
  check('posts to /auth/v1/token?grant_type=password', calls[0].url === `${cfg.url}/auth/v1/token?grant_type=password`);
  check('sends the public key as apikey', calls[0].init.headers.apikey === cfg.anonKey);
  check('sends the trimmed email and the password', JSON.parse(calls[0].init.body).email === 'a@b.test' && JSON.parse(calls[0].init.body).password === 'pw');
  check('returns and stores the session', s.accessToken === 'access-1' && !!st.m.get('snakdip_cloud_session'));
  check('a new SupabaseAuth restores the stored session', new SupabaseAuth(cfg, { fetchImpl, storage: st }).getSession()?.email === 'a@b.test');

  const bad = scripted(() => resp(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' }));
  const a2 = new SupabaseAuth(cfg, { fetchImpl: bad.fetchImpl, storage: memStorage() });
  check('wrong password -> RemoteRejectedError(auth) with an Arabic message', await rejects(a2.signIn('x@y.z', 'no'), RemoteRejectedError, 'auth'));
  const down = scripted(() => { throw new TypeError('fetch failed'); });
  check('no network -> RemoteUnavailableError', await rejects(new SupabaseAuth(cfg, { fetchImpl: down.fetchImpl, storage: memStorage() }).signIn('x@y.z', 'p'), RemoteUnavailableError));
}

// ---- rpc ----------------------------------------------------------------
console.log('\n▶ RPC calls');
{
  const st = memStorage();
  const { fetchImpl, calls } = scripted((url) => {
    if (url.includes('grant_type=password')) return resp(200, tokenBody(1));
    if (url.endsWith('/rpc/erp_apply_changes')) return resp(200, { status: 'ok', head: 7, versions: [] });
    return resp(404, { message: 'nope' });
  });
  const auth = new SupabaseAuth(cfg, { fetchImpl, storage: st });
  await auth.signIn('a@b.test', 'pw');
  const store = new SupabaseHttpStore(cfg, auth, { fetchImpl });
  const changes = [{ collection: 'items', id: 'i1', op: 'upsert' as const, base_version: 0, data: { a: 1 } }];
  const r = await store.apply(changes, 'dev-1', true);
  const c = calls[calls.length - 1];
  check('calls /rest/v1/rpc/erp_apply_changes', c.url === `${cfg.url}/rest/v1/rpc/erp_apply_changes`);
  check('sends apikey + the user token (Bearer)', c.init.headers.apikey === cfg.anonKey && c.init.headers.Authorization === 'Bearer access-1');
  check('body carries p_changes / p_client_id / p_bulk', (() => { const b = JSON.parse(c.init.body); return b.p_client_id === 'dev-1' && b.p_bulk === true && b.p_changes[0].id === 'i1'; })());
  check('returns the server answer', r.status === 'ok' && (r as any).head === 7);
}

// ---- token refresh -------------------------------------------------------
console.log('\n▶ Token refresh');
{
  const st = memStorage();
  let rpcCalls = 0;
  const { fetchImpl, calls } = scripted((url, init) => {
    if (url.includes('grant_type=password')) return resp(200, tokenBody(1));
    if (url.includes('grant_type=refresh_token')) return resp(200, tokenBody(2));
    rpcCalls++;
    // first RPC with the old token is refused as expired
    if (init.headers.Authorization === 'Bearer access-1') return resp(401, { message: 'JWT expired' });
    return resp(200, 41);
  });
  const auth = new SupabaseAuth(cfg, { fetchImpl, storage: st });
  await auth.signIn('a@b.test', 'pw');
  const store = new SupabaseHttpStore(cfg, auth, { fetchImpl });
  const head = await store.head();
  check('401 -> refreshes the token and retries once, transparently', head === 41 && rpcCalls === 2 && calls.some(c => c.url.includes('grant_type=refresh_token')));
  check('the refresh used the stored refresh token', JSON.parse(calls.find(c => c.url.includes('grant_type=refresh_token'))!.init.body).refresh_token === 'refresh-1');
  check('the new session replaced the old one', auth.getSession()?.accessToken === 'access-2');

  // a token that is about to expire is refreshed BEFORE the call
  const st2 = memStorage();
  const seen: string[] = [];
  const s2 = scripted((url, init) => {
    if (url.includes('grant_type=password')) return resp(200, tokenBody(1, 10)); // expires in 10s
    if (url.includes('grant_type=refresh_token')) return resp(200, tokenBody(2));
    seen.push(init.headers.Authorization);
    return resp(200, 1);
  });
  const a2 = new SupabaseAuth(cfg, { fetchImpl: s2.fetchImpl, storage: st2 });
  await a2.signIn('a@b.test', 'pw');
  await new SupabaseHttpStore(cfg, a2, { fetchImpl: s2.fetchImpl }).head();
  check('a nearly-expired token is refreshed before use', seen[0] === 'Bearer access-2');

  // concurrent calls share one refresh
  let refreshes = 0;
  const st3 = memStorage();
  const s3 = scripted(async (url) => {
    if (url.includes('grant_type=password')) return resp(200, tokenBody(1, 10));
    if (url.includes('grant_type=refresh_token')) { refreshes++; await new Promise(r => setTimeout(r, 20)); return resp(200, tokenBody(2)); }
    return resp(200, 1);
  });
  const a3 = new SupabaseAuth(cfg, { fetchImpl: s3.fetchImpl, storage: st3 });
  await a3.signIn('a@b.test', 'pw');
  const store3 = new SupabaseHttpStore(cfg, a3, { fetchImpl: s3.fetchImpl });
  await Promise.all([store3.head(), store3.head(), store3.head()]);
  check('three simultaneous calls trigger only one refresh', refreshes === 1, `refreshes=${refreshes}`);

  // refresh refused -> signed out
  const st4 = memStorage();
  const s4 = scripted((url) => url.includes('grant_type=password') ? resp(200, tokenBody(1, 10)) : resp(400, { error: 'invalid_grant' }));
  const a4 = new SupabaseAuth(cfg, { fetchImpl: s4.fetchImpl, storage: st4 });
  await a4.signIn('a@b.test', 'pw');
  check('a refused refresh token -> RemoteRejectedError(auth) and the session is cleared',
    await rejects(new SupabaseHttpStore(cfg, a4, { fetchImpl: s4.fetchImpl }).head(), RemoteRejectedError, 'auth') && a4.getSession() === null && !st4.m.get('snakdip_cloud_session'));
}

// ---- error mapping -------------------------------------------------------
console.log('\n▶ Error mapping');
{
  const mk = (rpcResponse: () => any) => {
    const { fetchImpl } = scripted((url) => url.includes('grant_type=password') ? resp(200, tokenBody(1)) : rpcResponse());
    const auth = new SupabaseAuth(cfg, { fetchImpl, storage: memStorage() });
    return auth.signIn('a@b.test', 'pw').then(() => new SupabaseHttpStore(cfg, auth, { fetchImpl }));
  };
  check('500 -> RemoteUnavailableError (retryable)', await rejects((await mk(() => resp(503, 'down'))).head(), RemoteUnavailableError));
  check('429 -> RemoteUnavailableError', await rejects((await mk(() => resp(429, 'slow down'))).head(), RemoteUnavailableError));
  check('403 -> RemoteRejectedError(forbidden)', await rejects((await mk(() => resp(403, { message: 'permission denied' }))).head(), RemoteRejectedError, 'forbidden'));
  check('404 -> RemoteRejectedError(not_installed) with a hint to run the SQL', await rejects((await mk(() => resp(404, { message: 'function not found' }))).head(), RemoteRejectedError, 'not_installed'));
  check('connection failure -> RemoteUnavailableError', await rejects((await mk(() => { throw new TypeError('fetch failed'); })).head(), RemoteUnavailableError));
  check('head() = null (not an approved member) -> RemoteRejectedError(forbidden)', await rejects((await mk(() => resp(200, null))).head(), RemoteRejectedError, 'forbidden'));
}

// ---- paged load ----------------------------------------------------------
console.log('\n▶ Paged load');
{
  const pages = [
    { status: 'ok', rows: [{ collection: 'a', id: '1', version: 1, ord: 1, data: {} }, { collection: 'a', id: '2', version: 1, ord: 2, data: {} }], done: false, next: { collection: 'a', ord: 2 } },
    { status: 'ok', rows: [{ collection: 'b', id: '9', version: 3, ord: 7, data: {} }], done: true, next: { collection: 'b', ord: 7 } },
  ];
  const sent: any[] = [];
  const { fetchImpl } = scripted((url, init) => {
    if (url.includes('grant_type=password')) return resp(200, tokenBody(1));
    sent.push(JSON.parse(init.body));
    return resp(200, pages[sent.length - 1]);
  });
  const auth = new SupabaseAuth(cfg, { fetchImpl, storage: memStorage() });
  await auth.signIn('a@b.test', 'pw');
  const all = await new SupabaseHttpStore(cfg, auth, { fetchImpl }).loadAll();
  check('loads every page and stops when done', all.length === 3 && sent.length === 2);
  check('2nd request continues from the last (collection, ord)', sent[1].p_after_collection === 'a' && sent[1].p_after_ord === 2);
}

// ---- sign out ------------------------------------------------------------
console.log('\n▶ Sign out');
{
  const st = memStorage();
  const { fetchImpl, calls } = scripted((url) => url.includes('grant_type=password') ? resp(200, tokenBody(1)) : resp(204, ''));
  const auth = new SupabaseAuth(cfg, { fetchImpl, storage: st });
  await auth.signIn('a@b.test', 'pw');
  await auth.signOut();
  check('clears the stored session', auth.getSession() === null && !st.m.get('snakdip_cloud_session'));
  check('tells the server (this device only)', calls.some(c => c.url === `${cfg.url}/auth/v1/logout?scope=local`));
}

console.log(`\n${'='.repeat(56)}\n${fail === 0 ? `🎉 ALL ${pass} HTTP CLIENT CHECKS PASSED` : `⚠️ ${fail} FAILED, ${pass} passed`}\n${'='.repeat(56)}`);
process.exit(fail === 0 ? 0 : 1);
