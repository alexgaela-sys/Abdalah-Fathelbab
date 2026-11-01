// Data-source resolver for the SnakDip ERP build.
//
// VITE_DATA_MODE is the single switch between the two sources:
//   * unset / anything else -> 'local'  (localStorage snapshot — the default,
//     unchanged: the local ERP keeps running exactly as before),
//   * 'cloud'                -> 'cloud' (the cloud panels listed in the parity
//     matrix; they read Supabase TEST through the existing read RPCs and never
//     fall back to localStorage).
//
// It never reads a value other than this flag, so no runtime state can silently
// flip the source, and nothing here contacts Supabase.

export type DataMode = 'local' | 'cloud';

export function resolveDataMode(): DataMode {
  const flag = (import.meta.env as Record<string, string | undefined>).VITE_DATA_MODE;
  return (flag || '').trim() === 'cloud' ? 'cloud' : 'local';
}
