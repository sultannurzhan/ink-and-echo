import fs from 'node:fs';
import { loadEnv } from 'vite';

const root = process.cwd();
const env = { ...loadEnv('production', root, 'CLOUDFLARE_'), ...process.env };
const databaseId = env.CLOUDFLARE_D1_DATABASE_ID;
const accountId = env.CLOUDFLARE_ACCOUNT_ID;
if (!databaseId || !/^[a-f0-9-]{36}$/i.test(databaseId) || databaseId.startsWith('00000000-')) {
  throw new Error('Set the verified app D1 database UUID in ignored .env.local before deployment.');
}
if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('Set the verified personal CLOUDFLARE_ACCOUNT_ID.');
const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'));
config.account_id = accountId;
// Wrangler resolves these paths relative to work/, including on Windows.
config.main = '../worker/api.ts';
config.alias['server-only'] = '../worker/server-only.ts';
config.vars.FRONTEND_ORIGIN = 'https://sultannurzhan.github.io';
config.d1_databases[0].database_id = databaseId;
config.d1_databases[0].database_name = env.CLOUDFLARE_D1_DATABASE_NAME || 'ink-and-echo';
fs.mkdirSync('work', { recursive: true });
fs.writeFileSync('work/wrangler.production.json', JSON.stringify(config, null, 2));
console.log('Prepared app-only Worker configuration; deployment is a separate command.');
