// Diagnostic only: does the TEST Viewer fixture authenticate at all?
// Prints the GoTrue error message (never the password).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const require_ = createRequire(path.join(ROOT, 'package.json'));
const { createClient } = require_('@supabase/supabase-js');

const EMAIL = 'qa-viewer-browser@example.com';
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
let pw = 'Qa';
for (const n of crypto.getRandomValues(new Uint32Array(16))) pw += alphabet[n % alphabet.length];
pw += '7!';

const uri = readFileSync(path.join(ROOT, 'supabase', 'backups', '.test_db_url'), 'utf8').trim();
execFileSync('psql', [uri, '-v', 'ON_ERROR_STOP=1', '-At', '-c',
  `update auth.users set encrypted_password = crypt('${pw}', gen_salt('bf')), updated_at = now() where email = '${EMAIL}';`],
  { encoding: 'utf8' });

const client = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data, error } = await client.auth.signInWithPassword({ email: EMAIL, password: pw });
if (error) {
  console.log('SIGNIN_ERROR:', error.status ?? '', '|', error.message);
} else {
  console.log('SIGNIN_OK user=', data.user?.email, 'id=', data.user?.id);
  const { data: role, error: roleErr } = await client.rpc('current_erp_role');
  console.log('ROLE:', JSON.stringify(role), 'err=', roleErr?.message ?? 'none');
}
