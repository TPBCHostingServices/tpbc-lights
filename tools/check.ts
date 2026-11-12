// npm run check  — validate the whole show. Exit code 1 if anything is wrong.
// Run this after every edit, before reloading the live service.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { loadShow } from '../src/show.ts';
import { Engine } from '../src/engine.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { show, problems } = loadShow(root);
const verbose = process.argv.includes('--verbose');

// Every address FreeShow and Companion send today must still resolve.
const ex = JSON.parse(readFileSync(join(root, 'import/lightkey-export.json'), 'utf8'));
const legacy: string[] = [];
for (const p of ex.panels) {
  for (const b of p.buttons) legacy.push('/' + b.osc);
  for (const f of p.cuelist) for (const c of f.cues) legacy.push('/' + c.osc.replace(/ /g, '_'));
}
legacy.push('/live/nextCue', '/live/previousCue', '/live/Control_Panel/select', '/live/Youth/select', '/palette/Floor_Random/toggle');
for (const p of ['Control_Panel', 'Youth']) for (const n of ['HOUSE_100%', 'HOUSE_0%', 'FULL_WHITE']) legacy.push(`/live/${p}/cue/${n}/toggle`);

if (!problems.some(p => p.level === 'error')) {
  let t = 0;
  const eng = new Engine(show, { now: () => t });
  for (const addr of legacy) {
    const r = eng.handleOsc(addr, []);
    if (!r.ok) problems.push({ level: 'error', file: 'compatibility', message: `${addr} no longer resolves (${r.message}). FreeShow/Companion still send it.` });
    t += 20;
  }
  // render every cue once to catch runtime problems
  for (const id of Object.keys(show.cues)) { eng.activate(id); t += 20; eng.render(t); }
}

const errors = problems.filter(p => p.level === 'error');
const warnings = problems.filter(p => p.level === 'warning');
for (const e of errors) console.log(`ERROR   ${e.file}: ${e.message}`);
if (verbose) for (const w of warnings) console.log(`warning ${w.file}: ${w.message}`);
else if (warnings.length) {
  const byMsg = new Map<string, number>();
  for (const w of warnings) byMsg.set(w.message.replace(/^\S+: /, ''), (byMsg.get(w.message.replace(/^\S+: /, '')) ?? 0) + 1);
  for (const [m, n] of byMsg) console.log(`warning (${n}x) ${m}`);
}
console.log(`\n${Object.keys(show.fixtures).length} fixtures, ${Object.keys(show.cues).length} cues, ${Object.keys(show.sequences).length} sequences, ${legacy.length} legacy addresses checked.`);
console.log(errors.length ? `FAILED: ${errors.length} error(s).` : `OK${warnings.length ? ` with ${warnings.length} warning(s) (--verbose to list)` : ''}.`);
process.exit(errors.length ? 1 : 0);
