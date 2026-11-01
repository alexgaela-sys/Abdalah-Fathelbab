// Cloud sync engine for the SnakDip ERP.
//
// The ERP keeps working exactly as before: one in-memory database object that
// every screen and every accounting workflow reads (getSnapshot) and changes
// (mutate). This engine sits underneath and makes that object shared:
//
//   * every device loads the same records from the server at start-up;
//   * after each user action it works out WHICH records changed (by comparing
//     against what the server last confirmed) and sends only those, in one
//     all-or-nothing request that carries the version each record had when the
//     device last saw it;
//   * if another device changed the same record meanwhile, the server refuses
//     (conflict). The device throws away its unsaved edit, reloads the latest
//     data and tells the user — nothing is ever overwritten silently;
//   * a light poll of the change feed pulls other devices' edits in.
//
// No accounting logic lives here and none is duplicated: balances, FIFO,
// journals, costing all still run in the existing TypeScript services.

import {
  ApplyResult,
  ConflictInfo,
  OutgoingChange,
  RemoteChange,
  RemoteRejectedError,
  RemoteStore,
  RemoteUnavailableError,
} from './remoteStore';

/** Whole-object entries of the database that are not lists (company, settings, ...). */
export const SINGLETON_COLLECTION = '__singletons';
export const SINGLETON_KEYS: readonly string[] = ['company', 'settings', 'accountMappings'];

/**
 * Collections that are never uploaded to the cloud and never overwritten by
 * a reload. The local `users` list carries login credentials in plaintext;
 * uploading it would expose those credentials to every approved member via
 * erp_load_page(). The cloud sign-in path is Supabase Auth (CloudGate →
 * /auth/v1/token), so these records stay device-local.
 */
export const SENSITIVE_COLLECTIONS: ReadonlySet<string> = new Set(['users']);

export type SyncState = 'disconnected' | 'connecting' | 'idle' | 'saving' | 'offline' | 'error';

/** Shown to the user until they dismiss it; independent of the connection state. */
export interface SyncNotice {
  kind: 'conflict';
  message: string;
  conflicts: ConflictInfo[];
}

export interface SyncStatus {
  state: SyncState;
  /** edits exist that the server has not confirmed yet */
  pending: boolean;
  /** human readable (Arabic) explanation for offline / error */
  message?: string;
  /** machine readable: 'auth' = sign in again, 'forbidden' = account not approved */
  code?: string;
  /** a refused save the user has not acknowledged yet */
  notice?: SyncNotice;
  lastSavedAt?: number;
}

interface Diff {
  changes: OutgoingChange[];
  serialized: Map<string, string>;
}

export interface SyncHost {
  /** the live in-memory database */
  getDb(): Record<string, any>;
  /** a database object containing every collection; list contents are ignored (the server supplies them) */
  createEmpty(): Record<string, any>;
  /** the server changed the in-memory database (not a local edit): refresh the UI, do not save */
  onRemoteApplied(): void;
}

export interface SyncOptions {
  clientId?: string;
  /** how often to ask the server for other devices' changes */
  pollMs?: number;
  /** most changes sent in one request */
  maxBatch?: number;
}

export const MSG_CONFLICT =
  'لم تُحفظ آخر عملية لأن جهازًا آخر عدّل نفس البيانات في نفس الوقت. تم تحديث الشاشة بآخر نسخة من الخادم، راجع البيانات ثم أعد العملية.';
export const MSG_OFFLINE = 'لا يوجد اتصال بالخادم. التغييرات الأخيرة لم تُحفظ بعد وستُحفظ تلقائيًا عند عودة الاتصال.';
export const MSG_FORBIDDEN = 'هذا الحساب غير مصرّح له باستخدام النظام السحابي. اطلب من المسؤول إضافته.';
export const MSG_AUTH = 'انتهت جلسة الدخول. سجّل الدخول من جديد.';

type Row = { collection: string; id: string; data: Record<string, unknown> };

const SEP = '\u0001';
const keyOf = (collection: string, id: string) => collection + SEP + id;

export class CloudSync {
  readonly clientId: string;

  private readonly store: RemoteStore;
  private readonly host: SyncHost;
  private readonly pollMs: number;
  private readonly maxBatch: number;

  /** last server version we know per record */
  private versions = new Map<string, number>();
  /** JSON of each record as the server last confirmed it (what a diff is measured against) */
  private shadow = new Map<string, string>();
  private cursor = 0;

  private status: SyncStatus = { state: 'disconnected', pending: false };
  private listeners = new Set<(s: SyncStatus) => void>();

  private chain: Promise<unknown> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 2000;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private warnedExtraKeys = new Set<string>();

  constructor(store: RemoteStore, host: SyncHost, opts: SyncOptions = {}) {
    this.store = store;
    this.host = host;
    this.pollMs = opts.pollMs ?? 4000;
    this.maxBatch = opts.maxBatch ?? 1000;
    this.clientId =
      opts.clientId ?? `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // ---------------------------------------------------------------- status ---

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribe(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private setStatus(patch: Partial<SyncStatus>, replaceDetails = false) {
    const next: SyncStatus = { ...this.status, ...patch };
    if (replaceDetails) {
      if (!('message' in patch)) delete next.message;
      if (!('code' in patch)) delete next.code;
    }
    this.status = next;
    this.listeners.forEach(fn => {
      try {
        fn(next);
      } catch (e) {
        console.error('sync status listener failed', e);
      }
    });
  }

  /** The user has read the notice (a refused save) or the error banner. */
  dismissNotice() {
    const next: SyncStatus = { ...this.status };
    delete next.notice;
    if (next.state === 'error') {
      next.state = 'idle';
      delete next.message;
      delete next.code;
    }
    this.status = next;
    this.listeners.forEach(fn => fn(next));
  }

  // ------------------------------------------------------------ operations ---

  /** Runs operations one at a time: a flush, a poll and a reload never interleave. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /**
   * Loads everything from the server into the live database.
   * empty = true means the server holds no records yet (first-time setup).
   */
  connect(): Promise<{ empty: boolean }> {
    this.stopped = false;
    return this.run(async () => {
      this.setStatus({ state: 'connecting' }, true);
      try {
        const n = await this.reloadUnlocked();
        this.setStatus({ state: 'idle', pending: false }, true);
        return { empty: n === 0 };
      } catch (e) {
        this.failFromError(e);
        throw e;
      }
    });
  }

  /** Throws away unsaved local edits and rebuilds the database from the server. */
  reload(): Promise<number> {
    return this.run(() => this.reloadUnlocked());
  }

  private async reloadUnlocked(): Promise<number> {
    // Position first, records second: anything that lands in between is
    // replayed by the next poll (replays are harmless — versions decide).
    const head = await this.store.head();
    const records = await this.store.loadAll();

    // The template carries the app's default seed data; the server is the only
    // source of list contents, so start every list empty.
    const fresh = this.host.createEmpty();
    for (const k of Object.keys(fresh)) {
      if (Array.isArray(fresh[k])) fresh[k] = [];
    }
    // Device-local collections (users) are never uploaded, so the server cannot
    // refill them: keep what this device already has instead of wiping it.
    const current = this.host.getDb();
    for (const name of SENSITIVE_COLLECTIONS) {
      if (Array.isArray(current[name])) fresh[name] = current[name];
    }
    const versions = new Map<string, number>();
    const shadow = new Map<string, string>();

    for (const r of records) {
      if (r.collection === SINGLETON_COLLECTION) {
        if (!SINGLETON_KEYS.includes(r.id)) continue;
        fresh[r.id] = r.data;
      } else {
        const list = fresh[r.collection];
        if (!Array.isArray(list)) continue; // written by a newer app version: leave it alone
        list.push(r.data);
      }
      const k = keyOf(r.collection, r.id);
      versions.set(k, r.version);
      shadow.set(k, JSON.stringify(r.data));
    }

    // Install in place so anything holding the database object keeps working.
    const db = this.host.getDb();
    for (const k of Object.keys(fresh)) db[k] = fresh[k];

    this.versions = versions;
    this.shadow = shadow;
    this.cursor = head;
    this.host.onRemoteApplied();
    return records.length;
  }

  // ----------------------------------------------------------------- diff ---

  private *rows(db: Record<string, any>): Generator<Row> {
    for (const [name, value] of Object.entries(db)) {
      if (SENSITIVE_COLLECTIONS.has(name)) continue; // never leaves the device
      if (Array.isArray(value)) {
        for (const rec of value) {
          if (!rec || typeof rec.id !== 'string' || !rec.id) {
            throw new Error(`سجل بدون معرّف داخل «${name}» — لا يمكن حفظه سحابيًا`);
          }
          yield { collection: name, id: rec.id, data: rec };
        }
      } else if (SINGLETON_KEYS.includes(name)) {
        if (value && typeof value === 'object') {
          yield { collection: SINGLETON_COLLECTION, id: name, data: value };
        }
      } else if (value && typeof value === 'object' && !this.warnedExtraKeys.has(name)) {
        this.warnedExtraKeys.add(name);
        console.warn(`[cloud-sync] «${name}» is not a list or a known singleton and is not synced`);
      }
    }
  }

  /** Everything that differs from what the server last confirmed. */
  private computeChanges(): Diff {
    const db = this.host.getDb();
    const changes: OutgoingChange[] = [];
    const serialized = new Map<string, string>();
    const seen = new Set<string>();

    for (const row of this.rows(db)) {
      const k = keyOf(row.collection, row.id);
      if (seen.has(k)) throw new Error(`معرّف مكرر «${row.id}» داخل «${row.collection}»`);
      seen.add(k);
      const s = JSON.stringify(row.data);
      if (this.shadow.get(k) !== s) {
        serialized.set(k, s);
        changes.push({
          collection: row.collection,
          id: row.id,
          op: 'upsert',
          base_version: this.versions.get(k) ?? 0,
          data: JSON.parse(s),
        });
      }
    }

    for (const k of this.shadow.keys()) {
      if (seen.has(k)) continue;
      const [collection, id] = k.split(SEP);
      changes.push({ collection, id, op: 'delete', base_version: this.versions.get(k) ?? 0 });
    }

    return { changes, serialized };
  }

  // ---------------------------------------------------------------- saving ---

  /** Called by the host after any local edit. Saves shortly after, batching a whole user action. */
  markDirty() {
    if (this.stopped) return;
    this.setStatus({ pending: true });
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow().catch(() => undefined);
    }, 0);
  }

  /** Resolves once every local edit is confirmed by the server (or saving failed / conflicted). */
  flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    return this.run(async () => {
      await this.flushLoop();
    });
  }

  /** true when everything made so far has been saved */
  isSaved(): boolean {
    return !this.status.pending && this.status.state !== 'offline';
  }

  /** true = everything is saved; false = stopped (offline, refused, conflict) */
  private async flushLoop(): Promise<boolean> {
    for (let guard = 0; guard < 50; guard++) {
      let diff: Diff;
      try {
        diff = this.computeChanges();
      } catch (e) {
        this.setStatus({ state: 'error', message: (e as Error).message, code: 'invalid' }, true);
        return false;
      }
      if (diff.changes.length === 0) {
        this.setStatus({ pending: false });
        if (this.status.state === 'saving' || this.status.state === 'offline') {
          this.setStatus({ state: 'idle' }, true);
        }
        return true;
      }

      this.setStatus({ state: 'saving', pending: true }, true);
      const proceed = await this.sendBatches(diff.changes, diff.serialized);
      if (!proceed) return false;
    }
    return false;
  }

  /** returns true when everything was accepted and another diff pass should follow */
  private async sendBatches(changes: OutgoingChange[], serialized: Map<string, string>): Promise<boolean> {
    for (let i = 0; i < changes.length; i += this.maxBatch) {
      const chunk = changes.slice(i, i + this.maxBatch);
      let res: ApplyResult;
      try {
        res = await this.store.apply(chunk, this.clientId);
      } catch (e) {
        this.failFromError(e);
        return false;
      }

      if (res.status === 'ok') {
        const newVersions = new Map<string, number>();
        for (const v of res.versions) newVersions.set(keyOf(v.collection, v.id), v.version);
        for (const c of chunk) {
          const k = keyOf(c.collection, c.id);
          if (c.op === 'delete') {
            this.shadow.delete(k);
            this.versions.delete(k);
          } else {
            const s = serialized.get(k);
            if (s !== undefined) this.shadow.set(k, s);
            const v = newVersions.get(k);
            if (v !== undefined) this.versions.set(k, v);
          }
        }
        this.retryDelay = 2000;
        this.setStatus({ lastSavedAt: Date.now() });
        continue;
      }

      if (res.status === 'conflict') {
        await this.resolveConflict(res.conflicts);
        return false;
      }
      if (res.status === 'forbidden') {
        this.setStatus({ state: 'error', message: MSG_FORBIDDEN, code: 'forbidden' }, true);
        return false;
      }
      this.setStatus({ state: 'error', message: `رفض الخادم الحفظ (${res.reason ?? 'invalid'})`, code: 'invalid' }, true);
      return false;
    }
    return true;
  }

  /** Another device got there first: drop our unsaved edit, take the server's truth, tell the user. */
  private async resolveConflict(conflicts: ConflictInfo[]) {
    try {
      await this.reloadUnlocked();
    } catch (e) {
      this.failFromError(e);
      return;
    }
    this.setStatus(
      { state: 'idle', pending: false, notice: { kind: 'conflict', message: MSG_CONFLICT, conflicts } },
      true,
    );
  }

  private failFromError(e: unknown) {
    if (e instanceof RemoteUnavailableError) {
      this.setStatus({ state: 'offline', pending: true, message: MSG_OFFLINE }, true);
      this.scheduleRetry();
    } else if (e instanceof RemoteRejectedError && (e.code === 'auth' || e.code === 'forbidden')) {
      this.setStatus(
        { state: 'error', message: e.code === 'auth' ? MSG_AUTH : MSG_FORBIDDEN, code: e.code },
        true,
      );
    } else {
      this.setStatus({ state: 'error', message: (e as Error)?.message || 'خطأ غير متوقع في الحفظ', code: 'error' }, true);
    }
  }

  private scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, 30000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.flushNow().catch(() => undefined);
    }, delay);
  }

  // --------------------------------------------------------------- polling ---

  startPolling() {
    if (this.pollTimer) return;
    this.stopped = false;
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch(() => undefined);
    }, this.pollMs);
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pollTimer = this.flushTimer = this.retryTimer = null;
  }

  /** Pulls in whatever other devices changed since the last look. */
  pollOnce(): Promise<void> {
    return this.run(async () => {
      if (this.stopped || this.status.state === 'connecting' || this.status.state === 'disconnected') return;
      // our own unsaved edits go out first, so a remote change can never land on top of them
      const saved = await this.flushLoop();
      if (!saved) return;

      let touched = false;
      try {
        for (let guard = 0; guard < 200; guard++) {
          const res = await this.store.changesSince(this.cursor, 500);
          if (res.status === 'reset') {
            await this.reloadUnlocked();
            return;
          }
          if (res.status === 'forbidden') {
            this.setStatus({ state: 'error', message: MSG_FORBIDDEN, code: 'forbidden' }, true);
            return;
          }
          for (const ch of res.changes) {
            if (this.applyRemoteChange(ch)) touched = true;
          }
          this.cursor = Math.max(this.cursor, res.last);
          if (!res.more) break;
        }
      } catch (e) {
        this.failFromError(e);
        return;
      } finally {
        if (touched) this.host.onRemoteApplied();
      }
      if (this.status.state === 'offline') this.setStatus({ state: 'idle' }, true);
    });
  }

  /** returns true when the in-memory database changed */
  private applyRemoteChange(ch: RemoteChange): boolean {
    const db = this.host.getDb();
    const k = keyOf(ch.collection, ch.id);
    const known = this.versions.get(k) ?? 0;

    if (ch.op === 'upsert') {
      if (!ch.data || ch.version <= known) return false;
      if (ch.collection === SINGLETON_COLLECTION) {
        if (!SINGLETON_KEYS.includes(ch.id)) return false;
        if (this.hasLocalEdit(k, db[ch.id])) return false;
        db[ch.id] = ch.data;
      } else {
        const list = db[ch.collection];
        if (!Array.isArray(list)) return false;
        const i = list.findIndex((r: any) => r && r.id === ch.id);
        if (i >= 0) {
          if (this.hasLocalEdit(k, list[i])) return false;
          list[i] = ch.data;
        } else {
          list.push(ch.data);
        }
      }
      this.versions.set(k, ch.version);
      this.shadow.set(k, JSON.stringify(ch.data));
      return true;
    }

    // delete
    if (ch.collection === SINGLETON_COLLECTION) return false;
    const list = db[ch.collection];
    if (!Array.isArray(list)) return false;
    const i = list.findIndex((r: any) => r && r.id === ch.id);
    if (i < 0) {
      this.versions.delete(k);
      this.shadow.delete(k);
      return false;
    }
    if (this.hasLocalEdit(k, list[i])) return false;
    list.splice(i, 1);
    this.versions.delete(k);
    this.shadow.delete(k);
    return true;
  }

  private hasLocalEdit(k: string, current: unknown): boolean {
    const s = this.shadow.get(k);
    return s !== undefined && JSON.stringify(current) !== s;
  }

  // ---------------------------------------------------------------- import ---

  /**
   * One-time upload of a complete database (from a browser's old local data or a
   * backup file). Resumable: records already on the server are skipped, and the
   * result is verified against the server's own counts before returning.
   */
  importAll(
    source: Record<string, any>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ inserted: number; skipped: number }> {
    return this.run(async () => {
      const rows = Array.from(this.rows(source));
      const existing = new Set((await this.store.loadAll()).map(r => keyOf(r.collection, r.id)));
      const todo = rows.filter(r => !existing.has(keyOf(r.collection, r.id)));

      const CHUNK_RECORDS = 250;
      const CHUNK_BYTES = 2_500_000;
      let done = 0;
      let batch: OutgoingChange[] = [];
      let bytes = 0;

      const send = async () => {
        if (!batch.length) return;
        const res = await this.store.apply(batch, this.clientId, true);
        if (res.status !== 'ok') {
          throw new Error(`فشل رفع البيانات (${res.status}${'reason' in res && res.reason ? `: ${res.reason}` : ''})`);
        }
        done += batch.length;
        batch = [];
        bytes = 0;
        onProgress?.(done, todo.length);
      };

      for (const r of todo) {
        const size = JSON.stringify(r.data).length;
        if (batch.length >= CHUNK_RECORDS || (bytes + size > CHUNK_BYTES && batch.length > 0)) await send();
        batch.push({ collection: r.collection, id: r.id, op: 'upsert', base_version: 0, data: r.data });
        bytes += size;
      }
      await send();

      // verify: the server must now hold at least every record we meant to store
      const expected = new Map<string, number>();
      for (const r of rows) expected.set(r.collection, (expected.get(r.collection) ?? 0) + 1);
      const { counts } = await this.store.stats();
      for (const [collection, n] of expected) {
        if ((counts[collection] ?? 0) < n) {
          throw new Error(`التحقق فشل: «${collection}» عليه ${counts[collection] ?? 0} من ${n} سجل`);
        }
      }
      return { inserted: todo.length, skipped: rows.length - todo.length };
    });
  }
}
