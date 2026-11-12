// npm run render -- <address or cue id> [more...]
// Fires the cues in order (offline, no network) and prints the finished look plus the
// DMX values per fixture. Example:
//   npm run render -- /live/Youth/Wonder/CHORUS/activate
//   npm run render -- Control_Panel/cue/SERMON
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadShowOrThrow } from '../src/show.ts';
import { Engine } from '../src/engine.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { show } = loadShowOrThrow(root);
let t = 0;
const eng = new Engine(show, { now: () => t });
const args = process.argv.slice(2);
if (!args.length) { console.log('usage: npm run render -- <address|cue id> ...'); process.exit(1); }
for (const a of args) {
  const r = a.startsWith('/') ? eng.handleOsc(a, []) : eng.activate(a);
  console.log(`${r.ok ? '✓' : '✗'} ${r.message}`);
  t += 30; // let every fade and dark-change finish
}
const frame = eng.render(t);
const look = eng.settled();
console.log('\nfixture  look' + ' '.repeat(52) + 'DMX');
for (const fx of Object.values(show.fixtures)) {
  const l = look[fx.name];
  const desc = fx.profile.type === 'spot'
    ? `level ${l.level}, wheel ${l.wheel}, pan ${l.pan} tilt ${l.tilt}${l.gobo ? ', gobo ' + l.gobo : ''}${l.effect ? ', effect ' + l.effect : ''}`
    : fx.profile.type === 'rgb' ? `level ${l.level}, rgb ${l.color.join('/')}` : `level ${l.level}`;
  const dmx = Array.from(frame.slice(fx.address - 1, fx.address - 1 + fx.profile.channels.length)).join(' ');
  console.log(`${fx.name.padEnd(8)} ${desc.padEnd(56)} @${fx.address}: ${dmx}`);
}
