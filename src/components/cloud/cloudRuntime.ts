// One shared set of cloud objects for the whole page: configuration, sign-in,
// the Supabase store and the sync engine attached to the ERP database.

import { erpDb } from '../../services/db';
import { CloudSync } from '../../services/cloud/syncEngine';
import {
  readSupabaseConfigFromEnv,
  SupabaseAuth,
  SupabaseConfig,
  SupabaseHttpStore,
} from '../../services/cloud/supabaseHttpStore';

export interface CloudRuntime {
  cfg: SupabaseConfig;
  auth: SupabaseAuth;
  sync: CloudSync;
  store: SupabaseHttpStore;
}

let runtime: CloudRuntime | null | undefined;

/** null when VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY were not provided at build time */
export function getCloudRuntime(): CloudRuntime | null {
  if (runtime !== undefined) return runtime;
  const cfg = readSupabaseConfigFromEnv();
  if (!cfg) {
    runtime = null;
    return runtime;
  }
  const auth = new SupabaseAuth(cfg);
  const store = new SupabaseHttpStore(cfg, auth);
  const sync = erpDb.attachCloud(store);
  runtime = { cfg, auth, sync, store };
  return runtime;
}
