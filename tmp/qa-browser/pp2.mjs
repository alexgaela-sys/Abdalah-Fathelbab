import fs from 'node:fs';
const ROOT = '/home/daytona/codebase';
const a = fs.readFileSync(ROOT + '/scripts/qa_supabase_browser.mjs','utf8');
const i = a.indexOf('async function ensureSignedIn(page) {');
const j = a.indexOf('\n\nasync function openCloud(page, screen) {');
console.log(a.slice(i, j));
