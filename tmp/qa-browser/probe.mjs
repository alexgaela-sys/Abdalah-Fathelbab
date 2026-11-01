const e = process.env;
const approved = 'elhandsiagroup10@gmail.com';
const has = k => typeof e[k] === 'string' && e[k].length > 0;
console.log('QA_CLOUD_TEST_EMAIL===approved:', e.QA_CLOUD_TEST_EMAIL === approved);
console.log('SUPABASE_TEST_USER_EMAIL===approved:', e.SUPABASE_TEST_USER_EMAIL === approved);
console.log('QA_E2E_EMAIL===approved:', e.QA_E2E_EMAIL === approved);
console.log('QA_E2E_EMAIL value:', JSON.stringify(e.QA_E2E_EMAIL || null));
console.log('pw present QA_CLOUD_TEST_PASSWORD:', has('QA_CLOUD_TEST_PASSWORD'));
console.log('pw present SUPABASE_TEST_USER_PASSWORD:', has('SUPABASE_TEST_USER_PASSWORD'));
console.log('pw present QA_E2E_PASSWORD:', has('QA_E2E_PASSWORD'));
console.log(
  'QA_CLOUD pw === SUPABASE_TEST_USER pw:',
  has('QA_CLOUD_TEST_PASSWORD') && e.QA_CLOUD_TEST_PASSWORD === e.SUPABASE_TEST_USER_PASSWORD,
);
console.log('QA_CLOUD pw === QA_E2E pw:', has('QA_CLOUD_TEST_PASSWORD') && e.QA_CLOUD_TEST_PASSWORD === e.QA_E2E_PASSWORD);
console.log(
  'SUPABASE_TEST_USER pw === QA_E2E pw:',
  has('SUPABASE_TEST_USER_PASSWORD') && e.SUPABASE_TEST_USER_PASSWORD === e.QA_E2E_PASSWORD,
);
console.log('VITE_DATA_MODE:', e.VITE_DATA_MODE === undefined ? '(unset)' : JSON.stringify(e.VITE_DATA_MODE));
console.log('VITE_SUPABASE_URL present:', has('VITE_SUPABASE_URL'));
console.log('VITE_SUPABASE_ANON_KEY present:', has('VITE_SUPABASE_ANON_KEY'));
