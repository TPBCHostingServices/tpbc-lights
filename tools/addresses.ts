// npm run addresses [-- Youth]   List every OSC address the show answers (for FreeShow
// emitter templates). Enter them in FreeShow without the leading "/".
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadShowOrThrow } from '../src/show.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { show } = loadShowOrThrow(root);
const page = process.argv[2];
for (const c of Object.values(show.cues)) {
  if (page && c.page !== page) continue;
  const mode = c.kind === 'button' && /HOUSE|FULL/.test(c.name) ? 'toggle' : 'activate';
  console.log(`live/${c.id}/${mode}`);
}
