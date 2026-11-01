import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { supabaseTestConfigured } from './services/supabaseTestClient';

// Entry points:
//   /               -> the cloud system (Supabase TEST) when the TEST project is
//                      configured; otherwise the untouched local-first ERP,
//   ?local=1        -> the local-first ERP (localStorage) explicitly,
//   ?cloud=1&screen=… -> the same cloud shell, opened on that module,
//   ?poc=1          -> low-level JSON document POC.
//
// The local ERP module is loaded LAZILY: the cloud shell never imports
// services/db, so using the cloud cannot read or rewrite localStorage at all.
const params = new URLSearchParams(window.location.search);
const pocRequested = params.get('poc') === '1';
const localRequested = params.get('local') === '1';
const cloudRequested =
  params.get('cloud') === '1' || (!localRequested && !pocRequested && supabaseTestConfigured());
const cloudScreen = params.get('screen') ?? undefined;

const LocalApp = lazy(() => import('./App.tsx').then(m => ({ default: m.App })));
const CloudApp = lazy(() =>
  import('./components/modules/cloud/CloudApp.tsx').then(m => ({ default: m.CloudApp })),
);
const JsonDocPocPanel = lazy(() =>
  import('./components/modules/cloud/JsonDocPocPanel.tsx').then(m => ({ default: m.JsonDocPocPanel })),
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<div className="p-8 text-xs text-slate-500">جارٍ التحميل…</div>}>
      {pocRequested ? (
        <JsonDocPocPanel />
      ) : cloudRequested ? (
        <CloudApp initialScreen={cloudScreen} />
      ) : (
        <LocalApp />
      )}
    </Suspense>
  </StrictMode>,
);
