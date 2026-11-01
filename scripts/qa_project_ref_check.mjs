// Public metadata only: which project ref does the configured URL point at, and
// does it match SUPABASE_PROJECT_REF? No key or secret is read or printed.
const url = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const envRef = (process.env.SUPABASE_PROJECT_REF || '').trim();
let hostRef = '';
try {
  hostRef = new URL(url).hostname.split('.')[0];
} catch {
  hostRef = '';
}
const same = hostRef && envRef ? hostRef === envRef : null;
console.log(JSON.stringify({ urlConfigured: Boolean(url), hostRef, envRef, same }, null, 2));
