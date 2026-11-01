// The contract between the sync engine and a cloud backend.
//
// The engine (syncEngine.ts) never talks to Supabase directly: it talks to a
// RemoteStore. supabaseHttpStore.ts is the real implementation; the tests use
// one backed by a throwaway PostgreSQL running the same SQL.

/** One stored ERP record as the server holds it. */
export interface RemoteRecord {
  collection: string;
  id: string;
  version: number;
  /** insertion order on the server (lists are rebuilt in this order) */
  ord?: number;
  data: Record<string, unknown>;
}

export interface RemoteChange {
  seq: number;
  collection: string;
  id: string;
  op: 'upsert' | 'delete';
  version: number;
  ord?: number;
  /** current state of the record (absent for deletes) */
  data?: Record<string, unknown> | null;
}

/** A write the engine wants applied. base_version 0 = brand-new record. */
export interface OutgoingChange {
  collection: string;
  id: string;
  op: 'upsert' | 'delete';
  base_version: number;
  data?: Record<string, unknown>;
}

export interface ConflictInfo {
  collection: string;
  id: string;
  /** exists | deleted | stale | duplicate_number */
  reason: string;
  current_version?: number;
  number?: string;
}

export type ApplyResult =
  | { status: 'ok'; head: number; versions: Array<{ collection: string; id: string; version: number }> }
  | { status: 'conflict'; conflicts: ConflictInfo[] }
  | { status: 'forbidden' }
  | { status: 'invalid'; reason?: string };

export type ChangesResult =
  | { status: 'ok'; head: number; changes: RemoteChange[]; last: number; more: boolean }
  | { status: 'reset'; head: number }
  | { status: 'forbidden' };

export interface RemoteStore {
  /** current position of the change feed */
  head(): Promise<number>;
  /** every record, in insertion order */
  loadAll(): Promise<RemoteRecord[]>;
  changesSince(after: number, limit?: number): Promise<ChangesResult>;
  apply(changes: OutgoingChange[], clientId: string, bulk?: boolean): Promise<ApplyResult>;
  stats(): Promise<{ counts: Record<string, number>; head: number; role?: string | null }>;
}

/** The server could not be reached (network down, timeout, 5xx). Safe to retry. */
export class RemoteUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteUnavailableError';
  }
}

/** The server answered but refused (bad credentials, not a member, ...). Not retried blindly. */
export class RemoteRejectedError extends Error {
  readonly code: string;
  constructor(message: string, code = 'rejected') {
    super(message);
    this.name = 'RemoteRejectedError';
    this.code = code;
  }
}
