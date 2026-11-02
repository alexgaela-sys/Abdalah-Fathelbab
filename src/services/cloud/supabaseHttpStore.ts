// Supabase backend for the cloud sync engine, using plain fetch (no extra
// dependency): GoTrue for sign-in, PostgREST RPC for the store functions from
// supabase/cloud-store/001_erp_store.sql.

import {
  ApplyResult,
  ChangesResult,
  OutgoingChange,
  RemoteRecord,
  RemoteRejectedError,
  RemoteStore,
  RemoteUnavailableError,
} from './remoteStore';

export interface SupabaseConfig {
  /** https://<project-ref>.supabase.co */
  url: string;
  /** the public anon / publishable key (safe to ship in the browser) */
  anonKey: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  /** epoch milliseconds */
  expiresAt: number;
  userId: string;
  email: string;
}

type FetchLike = (input: string, init?: any) => Promise<any>;

interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const SESSION_KEY = 'snakdip_cloud_session';

/** Reads the two public settings Vite injects at build time. Null when not configured. */
export function readSupabaseConfigFromEnv(): SupabaseConfig | null {
  let env: Record<string, string | undefined> = {};
  try {
    env = ((import.meta as any).env ?? {}) as Record<string, string | undefined>;
  } catch {
    env = {};
  }
  const url = (env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = (env.VITE_SUPABASE_ANON_KEY || '').trim();
  if (!url || anonKey.length < 20) return null;
  // credentials and sessions travel to this address: https only (plain http just for local development)
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) return null;
  return { url, anonKey };
}

function defaultStorage(): SessionStorageLike | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* blocked storage */
  }
  return null;
}

async function readErrorText(res: any): Promise<string> {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      return String(j.error_description || j.msg || j.message || j.error || text).slice(0, 300);
    } catch {
      return String(text).slice(0, 300);
    }
  } catch {
    return '';
  }
}

export class SupabaseAuth {
  private session: AuthSession | null = null;
  private refreshing: Promise<AuthSession> | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly storage: SessionStorageLike | null;

  constructor(
    private readonly cfg: SupabaseConfig,
    opts: { fetchImpl?: FetchLike; storage?: SessionStorageLike | null } = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => (globalThis as any).fetch(i, init));
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.session = this.readStored();
  }

  private readStored(): AuthSession | null {
    try {
      const raw = this.storage?.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw) as AuthSession;
      return s && s.accessToken && s.refreshToken ? s : null;
    } catch {
      return null;
    }
  }

  private persist(s: AuthSession | null) {
    this.session = s;
    try {
      if (!this.storage) return;
      if (s) this.storage.setItem(SESSION_KEY, JSON.stringify(s));
      else this.storage.removeItem(SESSION_KEY);
    } catch {
      /* storage full / blocked: stay signed in for this page only */
    }
  }

  getSession(): AuthSession | null {
    return this.session;
  }

  private async post(path: string, body: unknown, token?: string): Promise<any> {
    let res: any;
    try {
      res = await this.fetchImpl(`${this.cfg.url}${path}`, {
        method: 'POST',
        headers: {
          apikey: this.cfg.anonKey,
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body ?? {}),
      });
    } catch (e) {
      throw new RemoteUnavailableError(`تعذّر الاتصال بالخادم (${(e as Error)?.message || 'network'})`);
    }
    return res;
  }

  private toSession(j: any): AuthSession {
    const expiresAt = j.expires_at
      ? Number(j.expires_at) * 1000
      : Date.now() + Number(j.expires_in || 3600) * 1000;
    return {
      accessToken: String(j.access_token),
      refreshToken: String(j.refresh_token),
      expiresAt,
      userId: String(j.user?.id ?? ''),
      email: String(j.user?.email ?? ''),
    };
  }

  async signIn(email: string, password: string): Promise<AuthSession> {
    const res = await this.post('/auth/v1/token?grant_type=password', { email: email.trim(), password });
    if (!res.ok) {
      const msg = await readErrorText(res);
      if (res.status >= 500) throw new RemoteUnavailableError(`الخادم غير متاح (${res.status})`);
      throw new RemoteRejectedError(
        /invalid login|invalid_grant|credentials/i.test(msg) ? 'البريد أو كلمة المرور غير صحيحة' : msg || 'تعذّر تسجيل الدخول',
        'auth',
      );
    }
    const s = this.toSession(await res.json());
    this.persist(s);
    return s;
  }

  /** A valid access token, refreshing it first when it is about to expire. */
  async getAccessToken(): Promise<string> {
    const s = this.session;
    if (!s) throw new RemoteRejectedError('انتهت جلسة الدخول. سجّل الدخول من جديد.', 'auth');
    if (s.expiresAt - Date.now() > 60_000) return s.accessToken;
    return (await this.refresh()).accessToken;
  }

  refresh(): Promise<AuthSession> {
    if (this.refreshing) return this.refreshing;
    const s = this.session;
    if (!s) return Promise.reject(new RemoteRejectedError('انتهت جلسة الدخول. سجّل الدخول من جديد.', 'auth'));

    this.refreshing = (async () => {
      const res = await this.post('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refreshToken });
      if (!res.ok) {
        if (res.status >= 500) throw new RemoteUnavailableError(`الخادم غير متاح (${res.status})`);
        this.persist(null);
        throw new RemoteRejectedError('انتهت جلسة الدخول. سجّل الدخول من جديد.', 'auth');
      }
      const next = this.toSession(await res.json());
      this.persist(next);
      return next;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** The signed-in person changes THEIR OWN sign-in password (Supabase Auth, PUT /auth/v1/user). */
  async updatePassword(newPassword: string): Promise<void> {
    const token = await this.getAccessToken();
    let res: any;
    try {
      res = await this.fetchImpl(`${this.cfg.url}/auth/v1/user`, {
        method: 'PUT',
        headers: {
          apikey: this.cfg.anonKey,
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ password: newPassword }),
      });
    } catch (e) {
      throw new RemoteUnavailableError(`تعذّر الاتصال بالخادم (${(e as Error)?.message || 'network'})`);
    }
    if (!res.ok) {
      throw new RemoteRejectedError(await readErrorText(res), res.status === 401 ? 'auth' : 'rejected');
    }
  }

  async signOut(): Promise<void> {
    const s = this.session;
    this.persist(null);
    if (!s) return;
    try {
      await this.post('/auth/v1/logout?scope=local', {}, s.accessToken);
    } catch {
      /* the local session is already gone; the server token expires by itself */
    }
  }
}

export class SupabaseHttpStore implements RemoteStore {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly cfg: SupabaseConfig,
    private readonly auth: SupabaseAuth,
    opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => (globalThis as any).fetch(i, init));
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private readonly timeoutMs: number;

  private async rpc<T>(fn: string, args: Record<string, unknown>, allowRefresh = true): Promise<T> {
    const token = await this.auth.getAccessToken();

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    let res: any;
    try {
      res = await this.fetchImpl(`${this.cfg.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          apikey: this.cfg.anonKey,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
        signal: controller?.signal,
      });
    } catch (e) {
      throw new RemoteUnavailableError(`تعذّر الاتصال بالخادم (${(e as Error)?.name === 'AbortError' ? 'timeout' : (e as Error)?.message || 'network'})`);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (res.status === 401) {
      if (allowRefresh) {
        await this.auth.refresh();
        return this.rpc<T>(fn, args, false);
      }
      throw new RemoteRejectedError('انتهت جلسة الدخول. سجّل الدخول من جديد.', 'auth');
    }
    if (res.status >= 500 || res.status === 429 || res.status === 408) {
      throw new RemoteUnavailableError(`الخادم غير متاح مؤقتًا (${res.status})`);
    }
    if (!res.ok) {
      const msg = await readErrorText(res);
      if (res.status === 403 || /permission denied|not authorized/i.test(msg)) {
        throw new RemoteRejectedError('هذا الحساب غير مصرّح له باستخدام النظام السحابي', 'forbidden');
      }
      if (res.status === 404) {
        throw new RemoteRejectedError(
          'لم يتم العثور على دوال النظام السحابي في قاعدة البيانات. شغّل ملف 001_erp_store.sql أولًا.',
          'not_installed',
        );
      }
      throw new RemoteRejectedError(`رفض الخادم الطلب (${res.status}): ${msg}`, 'rejected');
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new RemoteUnavailableError('رد غير مفهوم من الخادم');
    }
  }

  async head(): Promise<number> {
    const v = await this.rpc<number | null>('erp_head_seq', {});
    if (v === null || v === undefined) {
      throw new RemoteRejectedError('هذا الحساب غير مصرّح له باستخدام النظام السحابي', 'forbidden');
    }
    return Number(v);
  }

  async loadAll(): Promise<RemoteRecord[]> {
    const out: RemoteRecord[] = [];
    let afterCollection = '';
    let afterOrd = 0;
    for (let page = 0; page < 100_000; page++) {
      const r = await this.rpc<any>('erp_load_page', {
        p_after_collection: afterCollection,
        p_after_ord: afterOrd,
        p_limit: 1000,
      });
      if (r.status === 'forbidden') {
        throw new RemoteRejectedError('هذا الحساب غير مصرّح له باستخدام النظام السحابي', 'forbidden');
      }
      for (const row of r.rows as RemoteRecord[]) out.push(row);
      if (r.done || !r.next) break;
      afterCollection = String(r.next.collection);
      afterOrd = Number(r.next.ord);
    }
    return out;
  }

  async changesSince(after: number, limit = 500): Promise<ChangesResult> {
    return this.rpc<ChangesResult>('erp_changes_since', { p_after: after, p_limit: limit });
  }

  async apply(changes: OutgoingChange[], clientId: string, bulk = false): Promise<ApplyResult> {
    return this.rpc<ApplyResult>('erp_apply_changes', {
      p_changes: changes,
      p_client_id: clientId,
      p_bulk: bulk,
    });
  }

  async stats(): Promise<{ counts: Record<string, number>; head: number; role?: string | null }> {
    const r = await this.rpc<any>('erp_stats', {});
    if (r.status === 'forbidden') {
      throw new RemoteRejectedError('هذا الحساب غير مصرّح له باستخدام النظام السحابي', 'forbidden');
    }
    return { counts: r.counts ?? {}, head: Number(r.head ?? 0), role: r.role ?? null };
  }
}
