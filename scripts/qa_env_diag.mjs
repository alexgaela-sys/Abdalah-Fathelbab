// Diagnose the TEST credentials WITHOUT printing any secret value.
// Prints only: url host shape, key shape (JWT or not), JWT claims role/ref/exp,
// and the HTTP status of a plain REST probe.
const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const anon = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
const ref = process.env.SUPABASE_PROJECT_REF || '';

const info = {
  url: url ? url.replace(/https:\/\/([^.]+)\.supabase\.co.*/, 'https://<ref>.supabase.co').replace(/[A-Za-z0-9]{12,}/g, '<redacted>') : '',
  urlIsSupabaseCo: /\.supabase\.co$/.test(url.replace(/\/$/, '')),
  urlHostLen: (() => { try { return new URL(url).hostname.length; } catch { return -1; } })(),
  keyLen: anon.length,
  keyLooksJwt: anon.split('.').length === 3,
  keyStartsWithJwt: anon.startsWith('eyJ'),
  envProjectRefLen: ref.length,
};

if (info.keyLooksJwt) {
  try {
    const payload = JSON.parse(Buffer.from(anon.split('.')[1], 'base64url').toString('utf8'));
    info.keyRole = payload.role;
    info.keyRef = payload.ref;
    info.keyExp = payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
    info.keyExpired = payload.exp ? payload.exp * 1000 < Date.now() : null;
    info.urlMatchesKeyRef = payload.ref ? url.includes(payload.ref) : null;
    info.envRefMatchesKeyRef = ref ? payload.ref === ref : null;
  } catch (e) {
    info.jwtDecodeError = String(e.message);
  }
}

if (url) {
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/rest/v1/', {
      headers: { apikey: anon, Authorization: 'Bearer ' + anon },
    });
    info.restStatus = res.status;
    info.restBodySnippet = (await res.text()).slice(0, 120);
  } catch (e) {
    info.restError = String(e.message);
  }

  // Per-variable probe: which env NAME actually holds a key this project accepts.
  // Statuses and lengths only — no value is ever printed.
  const candidates = {
    VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY || '',
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  };
  info.keyProbes = {};
  for (const [name, value] of Object.entries(candidates)) {
    const key = value.trim();
    if (!key) {
      info.keyProbes[name] = { present: false };
      continue;
    }
    try {
      const res = await fetch(url.replace(/\/$/, '') + '/auth/v1/health', {
        headers: { apikey: key, Authorization: 'Bearer ' + key },
      });
      info.keyProbes[name] = { present: true, len: key.length, authHealthStatus: res.status };
    } catch (e) {
      info.keyProbes[name] = { present: true, len: key.length, error: String(e.message) };
    }
  }
}

// Identity shape only: is the configured QA email the documented TEST account,
// and is a password present at all? No email address or password is printed.
const TEST_ACCOUNT = 'elhandsiagroup10@gmail.com';
const qaEmail = (process.env.SUPABASE_TEST_USER_EMAIL || process.env.QA_CLOUD_TEST_EMAIL || process.env.QA_E2E_EMAIL || '').trim();
const qaPassword = process.env.SUPABASE_TEST_USER_PASSWORD || process.env.QA_CLOUD_TEST_PASSWORD || process.env.QA_E2E_PASSWORD || '';
info.qaIdentity = {
  configured: qaEmail.length > 0,
  isDocumentedTestAccount: qaEmail.toLowerCase() === TEST_ACCOUNT,
  passwordPresent: qaPassword.length > 0,
  passwordLenBucket: qaPassword.length === 0 ? 0 : qaPassword.length < 8 ? 1 : qaPassword.length < 16 ? 2 : 3,
};

console.log(JSON.stringify(info, null, 2));
