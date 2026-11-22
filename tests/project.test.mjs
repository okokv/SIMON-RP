import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('GitHub Pages uses relative static asset paths and public-only Supabase config', () => {
  const html = read('public/index.html');
  const config = read('public/config.js');
  const workflow = read('.github/workflows/pages.yml');
  assert.match(html, /href="\.\/assets\/app\.css"/);
  assert.match(html, /src="\.\/config\.js"/);
  assert.match(html, /src="\.\/assets\/app\.js"/);
  assert.match(config, /SUPABASE_ANON_KEY/);
  assert.doesNotMatch(config, /(?:SUPABASE_SERVICE_ROLE_KEY|BOT_TOKEN)\s*:\s*['"][^'"]{8,}/i);
  assert.match(workflow, /SUPABASE_URL/);
  assert.match(workflow, /SUPABASE_ANON_KEY/);
});

test('Edge functions enforce Telegram initData and keep database service key server-side', () => {
  const api = read('supabase/functions/simon-api/index.ts');
  const migration = read('supabase/migrations/202611220001_initial_schema.sql');
  assert.match(api, /verifyTelegramInitData\(initData, botToken/);
  assert.match(api, /x-telegram-init-data/);
  assert.match(api, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table public\.%I from anon, authenticated/i);
});

test('Stars are disabled by default and invoice creation has a database-backed single-send guard', () => {
  const api = read('supabase/functions/simon-api/index.ts');
  const env = read('.env.example');
  assert.match(env, /^TELEGRAM_STARS_ENABLED=false$/m);
  assert.match(api, /if\(p\.invoice_status==='sent'\)/);
  assert.match(api, /eq\('invoice_status','not_sent'\)\.select\('id'\)/);
  assert.match(api, /invoice_status:'sending'/);
});

test('production source contains no injected tokens, credentials, or local SQLite data', () => {
  const files = ['public/config.js','.env.example','.gitignore','supabase/config.toml'];
  const joined = files.map(read).join('\n');
  assert.doesNotMatch(joined, /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/);
  assert.doesNotMatch(joined, /SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*['"][^'"]{12,}/);
  assert.equal(fs.existsSync(path.join(root,'data')), false);
  assert.equal(fs.existsSync(path.join(root,'.env')), false);
});
