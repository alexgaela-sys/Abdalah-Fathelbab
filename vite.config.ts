import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  // Supabase TEST endpoint for the browser.
  //
  // Vite only exposes VITE_* variables to client code, and the workspace stores
  // the project's public anon/publishable key as SUPABASE_ANON_KEY (the
  // VITE_SUPABASE_ANON_KEY slot can hold a placeholder, which makes every call
  // fail with "Invalid API key"). Both values are the PUBLIC browser key — the
  // same thing VITE_ would embed — so the valid one is injected here.
  // No secret (service_role, DB URL, password) is ever defined for the client.
  const urlCandidate = [process.env.VITE_SUPABASE_URL, process.env.SUPABASE_URL]
    .map(v => (v || '').trim())
    .find(v => v.startsWith('http'));
  // VITE_SUPABASE_ANON_KEY may hold the literal placeholder while the real
  // public key sits in SUPABASE_ANON_KEY, so pick the first usable value rather
  // than the first present one. An anon/publishable key is never this short.
  const anonKey =
    [process.env.VITE_SUPABASE_ANON_KEY, process.env.SUPABASE_ANON_KEY]
      .map(v => (v || '').trim())
      .find(v => v.length >= 20) || '';
  const url = urlCandidate || '';

  // Dev servers do not always substitute bare `define` identifiers inside a
  // `typeof` guard, so the two values are also injected textually (the module
  // keeps `typeof` guards so plain Node imports of the same file stay safe).
  const publicDefines: Record<string, string> = {
    __ERP_SUPABASE_URL__: JSON.stringify(url),
    __ERP_SUPABASE_ANON_KEY__: JSON.stringify(anonKey),
  };
  const injectPublicSupabaseEnv = {
    name: 'inject-public-supabase-env',
    enforce: 'pre' as const,
    transform(code: string) {
      let out = code;
      for (const [token, value] of Object.entries(publicDefines)) {
        if (out.includes(token)) out = out.split(token).join(value);
      }
      return out === code ? null : { code: out, map: null };
    },
  };

  return {
    define: publicDefines,
    plugins: [injectPublicSupabaseEnv, react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
