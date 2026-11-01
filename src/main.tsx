import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {CloudGate} from './components/cloud/CloudGate.tsx';
import {CLOUD_STORAGE_MODE} from './services/db.ts';
import './index.css';

// Default build: the ERP exactly as before (data in this browser).
// Cloud build (VITE_ERP_STORAGE=supabase): the same ERP, started behind the
// cloud gate (sign-in, load shared data, first-time import).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {CLOUD_STORAGE_MODE ? (
      <CloudGate>
        <App />
      </CloudGate>
    ) : (
      <App />
    )}
  </StrictMode>,
);
