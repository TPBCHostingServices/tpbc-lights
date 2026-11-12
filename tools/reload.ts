// npm run reload [-- --force]   Check the show, then ask the running service to reload it.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
try { execFileSync(process.execPath, [join(root, 'tools/check.ts')], { stdio: 'inherit' }); }
catch { console.error('Not reloading: fix the errors above first.'); process.exit(1); }
const cfg = loadConfig(root);
const force = process.argv.includes('--force') ? '?force=1' : '';
const res = await fetch(`http://127.0.0.1:${cfg.http.port}/api/reload${force}`, { method: 'POST' });
console.log(res.status, JSON.stringify(await res.json()));
process.exit(res.ok ? 0 : 1);
