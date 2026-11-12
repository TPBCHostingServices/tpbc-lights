import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadShowOrThrow } from '../src/show.ts';
import { Engine, effectOffset } from '../src/engine.ts';
import { decodeOsc, encodeOsc } from '../src/osc.ts';
import { artDmxPacket, parseArtDmx } from '../src/artnet.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { show } = loadShowOrThrow(root);
const make = () => { const clock = { t: 0 }; const e = new Engine(show, { now: () => clock.t }); return { e, clock }; };
const dmx = (e: Engine, t: number, fixture: string, ch: number) => e.render(t)[show.fixtures[fixture].address - 1 + ch];
// channel offsets
const SLIM_DIM = 6, RAIL_DIM = 0, MH_PAN = 0, MH_TILT = 1, MH_WHEEL = 5, MH_SHUT = 6, MH_DIM = 7;

test('show passes npm run check', () => {
  execFileSync(process.execPath, [join(root, 'tools/check.ts')], { stdio: 'pipe' });
});

test('OSC: decodes the Companion Lightkey message shape', () => {
  const [m] = decodeOsc(encodeOsc('/live/Control_Panel/cue/HOUSE_100%/toggle', [{ type: 'f', value: 0 }]));
  assert.equal(m.address, '/live/Control_Panel/cue/HOUSE_100%/toggle');
  assert.deepEqual(m.args, [0]);
  const [n] = decodeOsc(encodeOsc('/live/nextCue', [{ type: 'i', value: 3 }]));
  assert.deepEqual(n.args, [3]);
  const [bare] = decodeOsc(encodeOsc('/live/Youth/Wonder/CHORUS/activate'));
  assert.deepEqual(bare.args, []);
});

test('Art-Net: ArtDmx packet round trip', () => {
  const f = new Uint8Array(512); f[0] = 255; f[511] = 7;
  const p = parseArtDmx(artDmxPacket(0, 1, f))!;
  assert.equal(p.universe, 0);
  assert.equal(p.data[0], 255);
  assert.equal(p.data[511], 7);
});

test('song cue from FreeShow address renders the converted look', () => {
  const { e, clock } = make();
  assert.ok(e.handleOsc('/live/Youth/Closer/BRIDGE/activate').ok);
  clock.t = 30;
  // Closer BRIDGE: magenta PARs 70%, purple bars 75%, magenta spots 60% (10/28 notes)
  assert.equal(dmx(e, clock.t, 'P1', SLIM_DIM), Math.round(70 * 2.55));
  assert.equal(dmx(e, clock.t, 'B1', RAIL_DIM), Math.round(75 * 2.55));
  assert.equal(dmx(e, clock.t, 'MH1', MH_DIM), Math.round(60 * 2.55));
  assert.equal(dmx(e, clock.t, 'MH1', MH_WHEEL), 14); // magenta slot
  assert.equal(dmx(e, clock.t, 'MH1', MH_TILT), 221); // Upper Wash
  assert.equal(dmx(e, clock.t, 'H203', 0), 0);
});

test('position presets only set position (Wonder INTRO spots stay off)', () => {
  const { e, clock } = make();
  e.handleOsc('/live/Youth/Wonder/INTRO/activate');
  clock.t = 30;
  assert.equal(dmx(e, clock.t, 'MH1', MH_DIM), 0);
  assert.equal(dmx(e, clock.t, 'MH1', MH_SHUT), 0);
});

test('fades are linear over the cue fade time', () => {
  const { e, clock } = make();
  e.activate('Youth/Closer/BRIDGE'); // 8 s fade, PARs to 70
  assert.equal(dmx(e, 4, 'P1', SLIM_DIM), Math.round(35 * 2.55));
  clock.t = 8;
  assert.equal(dmx(e, 8, 'P1', SLIM_DIM), Math.round(70 * 2.55));
});

test('song cues on a page replace each other; panel looks are exclusive', () => {
  const { e } = make();
  e.activate('Youth/Wonder/INTRO');
  e.activate('Youth/Wonder/CHORUS');
  e.activate('Control_Panel/cue/PRE_POST');
  e.activate('Control_Panel/cue/SERMON');
  assert.deepEqual(e.status().active, ['Youth/Wonder/CHORUS', 'Control_Panel/cue/SERMON']);
});

test('HOUSE 100% toggles on top of a song cue; the next song cue takes the house back down', () => {
  const { e, clock } = make();
  e.handleOsc('/live/Youth/Wonder/CHORUS/activate');
  clock.t = 10;
  e.handleOsc('/live/Youth/cue/HOUSE_100%/toggle', [0]);
  clock.t = 20;
  assert.equal(dmx(e, 20, 'H200', 0), 255);
  e.handleOsc('/live/Youth/cue/HOUSE_100%/toggle', [0]); // toggle off again
  clock.t = 30;
  assert.equal(dmx(e, 30, 'H200', 0), 0);
  e.handleOsc('/live/Youth/cue/HOUSE_100%/toggle', [0]);
  e.handleOsc('/live/Youth/Wonder/BRIDGE/activate');
  clock.t = 60;
  assert.equal(dmx(e, 60, 'H200', 0), 0);
});

test('GO / BACK walk the selected page cuelist', () => {
  const { e } = make();
  assert.ok(e.handleOsc('/live/Youth/select', [0]).ok);
  e.activate('Youth/Wonder/INTRO');
  e.handleOsc('/live/nextCue', [3]);
  assert.equal(e.status().currentSong.Youth, 'Youth/Wonder/VERSE');
  e.handleOsc('/live/previousCue', [3]);
  assert.equal(e.status().currentSong.Youth, 'Youth/Wonder/INTRO');
});

test('master: Companion Blackout (0) and Master 100% (1)', () => {
  const { e, clock } = make();
  e.activate('Control_Panel/cue/FULL_WHITE');
  clock.t = 10;
  e.handleOsc('/output/master', [0]);
  assert.equal(dmx(e, 10, 'P1', SLIM_DIM), 0);
  e.handleOsc('/output/master', [1]);
  assert.equal(dmx(e, 10, 'P1', SLIM_DIM), 255);
});

test('colour wheel: one slot moves directly, bigger moves dark-change', () => {
  const { e, clock } = make();
  e.activate('Control_Panel/cue/FULL_WHITE'); // spots white 75%
  clock.t = 10;
  assert.equal(dmx(e, 10, 'MH1', MH_DIM), Math.round(75 * 2.55));
  // jump white -> blue (7 slots) via a cue that sets blue at the same level
  const cue = { ...show.cues['Control_Panel/cue/FULL_WHITE'], id: 'test/blue', kind: 'button' as const, exclusive: undefined,
    targets: Object.fromEntries(show.groups.MH.map(m => [m, { level: 75, wheel: 'blue' }])) };
  show.cues['test/blue'] = cue;
  try {
    e.activate('test/blue', 0);
    assert.ok(dmx(e, 10.25, 'MH1', MH_DIM) < 191, 'dims first');
    assert.equal(dmx(e, 10.25, 'MH1', MH_WHEEL), 2, 'wheel still white while dimming');
    assert.equal(dmx(e, 11.0, 'MH1', MH_DIM), 0, 'dark while wheel travels');
    assert.equal(dmx(e, 11.0, 'MH1', MH_WHEEL), 44, 'wheel moved to blue');
    assert.equal(dmx(e, 20, 'MH1', MH_DIM), Math.round(75 * 2.55), 'back up');
    // one slot (blue -> light green is 1 slot): no dark-change
    show.cues['test/lg'] = { ...cue, id: 'test/lg', targets: Object.fromEntries(show.groups.MH.map(m => [m, { level: 75, wheel: 'light_green' }])) };
    e.activate('test/lg', 0);
    assert.equal(dmx(e, 20.1, 'MH1', MH_DIM), Math.round(75 * 2.55));
    assert.equal(dmx(e, 20.1, 'MH1', MH_WHEEL), 50);
  } finally { delete show.cues['test/blue']; delete show.cues['test/lg']; }
});

test('effects move around the cue position (relative) and average to zero', () => {
  const spec = { type: 'wiper', shape: 'sine_pan', pan: 30, tilt: 0, period: 8, spread: 0 };
  let sum = 0, max = 0;
  for (let i = 0; i < 80; i++) { const [p] = effectOffset(spec, i * 0.1, 0, 4); sum += p; max = Math.max(max, Math.abs(p)); }
  assert.ok(Math.abs(sum / 80) < 0.5);
  assert.ok(max > 29 && max <= 30);
  const { e } = make();
  e.activate('Youth/Wonder/CHORUS', 0); // wiper around Upper Wash
  const pans = [0, 2, 4, 6].map(t => dmx(e, 100 + t, 'MH1', MH_PAN));
  assert.ok(new Set(pans).size > 1, 'pan moves');
  assert.ok(pans.every(p => Math.abs(p - 128) < 20), 'stays near Upper Wash pan');
});

test('Floor Random toggles from Companion', () => {
  const { e } = make();
  assert.ok(e.handleOsc('/palette/Floor_Random/toggle').ok);
  assert.ok(e.status().active.includes('sequence/Floor_Random'));
  e.handleOsc('/palette/Floor_Random/toggle');
  assert.ok(!e.status().active.includes('sequence/Floor_Random'));
});

test('unknown addresses are reported, not ignored', () => {
  const { e } = make();
  const r = e.handleOsc('/live/Youth/No_Such_Song/CHORUS/activate');
  assert.equal(r.ok, false);
});

test('reload keeps the running cue', () => {
  const { e } = make();
  e.activate('Youth/Wonder/CHORUS');
  const fresh = loadShowOrThrow(root).show;
  e.reload(fresh);
  assert.deepEqual(e.status().active, ['Youth/Wonder/CHORUS']);
});
