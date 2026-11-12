// npm run import-qxf -- <file.qxf> [--mode "11 Channel"] [--id my-profile] [--out rig/fixtures]
// Converts a QLC+ fixture definition (.qxf) into a TPBC Lights profile. The result is
// written with `verify: true`: check it against the manual and the real fixture on the
// bench, then delete that line. Without --mode it lists the modes and stops.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';

interface QxfChannel { name: string; group: string; byte: number; colour: string; caps: { min: number; max: number; label: string }[] }

const attrs = (s: string) => Object.fromEntries([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
const unxml = (s: string) => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function parseQxf(xml: string) {
  const text = (tag: string) => unxml(xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? '').trim();
  const channels: Record<string, QxfChannel> = {};
  for (const m of xml.matchAll(/<Channel\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/Channel>)/g)) {
    const a = attrs(m[1]);
    if (!a.Name || m[2] === undefined || /<\/?Mode/.test(m[2])) continue;
    const body = m[2];
    const g = body.match(/<Group([^>]*)>([^<]*)<\/Group>/);
    const caps = [...body.matchAll(/<Capability\s+([^>]*)>([^<]*)<\/Capability>/g)].map(c => {
      const ca = attrs(c[1]);
      return { min: Number(ca.Min), max: Number(ca.Max), label: unxml(c[2]).trim() };
    });
    channels[unxml(a.Name)] = { name: unxml(a.Name), group: g?.[2].trim() ?? '', byte: Number(attrs(g?.[1] ?? '').Byte ?? 0), colour: body.match(/<Colour>([^<]*)<\/Colour>/)?.[1].trim() ?? '', caps };
  }
  const modes: Record<string, string[]> = {};
  for (const m of xml.matchAll(/<Mode\s+Name="([^"]*)">([\s\S]*?)<\/Mode>/g)) {
    const list: { n: number; name: string }[] = [];
    for (const c of m[2].matchAll(/<Channel\s+Number="(\d+)"[^>]*>([^<]*)<\/Channel>/g)) list.push({ n: Number(c[1]), name: unxml(c[2]).trim() });
    modes[unxml(m[1])] = list.sort((x, y) => x.n - y.n).map(x => x.name);
  }
  return { manufacturer: text('Manufacturer'), model: text('Model'), channels, modes };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const snake = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function convertQxf(xml: string, modeName: string, notes: string[] = []) {
  const q = parseQxf(xml);
  const names = q.modes[modeName];
  if (!names) throw new Error(`mode "${modeName}" not found; modes are: ${Object.keys(q.modes).join(', ')}`);
  const channels: (string | { fixed: string; value: number })[] = [];
  const used = new Set<string>();
  let wheel: { name: string; dmx: number; rgb: number[] }[] = [];
  let shutter: { open: number; closed: number } | undefined;
  const rgbOf = (label: string): number[] => {
    const l = label.toLowerCase();
    const table: [string, number[]][] = [['white', [100, 100, 100]], ['red', [100, 0, 0]], ['orange', [100, 50, 0]], ['amber', [100, 70, 0]], ['yellow', [100, 100, 0]], ['light green', [60, 100, 40]], ['green', [0, 100, 0]], ['cyan', [0, 100, 100]], ['light blue', [40, 70, 100]], ['blue', [0, 0, 100]], ['magenta', [100, 0, 100]], ['pink', [100, 40, 70]], ['purple', [60, 0, 100]], ['violet', [60, 0, 100]]];
    return (table.find(([k]) => l.includes(k)) ?? ['', [100, 100, 100]])[1];
  };
  const take = (attr: string, fallback: { fixed: string; value: number }) => {
    if (used.has(attr)) return fallback; // second channel of the same kind: hold it fixed
    used.add(attr); return attr;
  };
  for (const n of names) {
    const c = q.channels[n];
    if (!c) { notes.push(`channel "${n}" is not defined in the file; held at 0`); channels.push({ fixed: snake(n), value: 0 }); continue; }
    const fixed = { fixed: snake(c.name), value: 0 };
    const g = c.group.toLowerCase(), col = c.colour.toLowerCase();
    if (g === 'intensity' && col === 'red') channels.push(take('red', fixed));
    else if (g === 'intensity' && col === 'green') channels.push(take('green', fixed));
    else if (g === 'intensity' && col === 'blue') channels.push(take('blue', fixed));
    else if (g === 'intensity' && /shutter|strobe/i.test(c.name)) channels.push(fixed);
    else if (g === 'intensity' && !col) channels.push(take('dimmer', fixed));
    else if (g === 'pan') channels.push(take(c.byte ? 'pan_fine' : 'pan', fixed));
    else if (g === 'tilt') channels.push(take(c.byte ? 'tilt_fine' : 'tilt', fixed));
    else if (g === 'colour' && c.caps.length > 1 && !wheel.length) {
      const a = take('wheel', fixed);
      channels.push(a);
      if (a === 'wheel') wheel = c.caps.filter(x => !/rainbow|scroll|macro|auto|cycle|rotation|half|\+/i.test(x.label)).map(x => ({ name: snake(x.label), dmx: Math.round((x.min + x.max) / 2), rgb: rgbOf(x.label) }));
    }
    else if (g === 'gobo') channels.push(/rotat|index|shake/i.test(c.name) ? fixed : take('gobo', fixed));
    else if (g === 'shutter') {
      const open = c.caps.find(x => /open/i.test(x.label)), closed = c.caps.find(x => /clos|blackout/i.test(x.label));
      if (!used.has('shutter')) { channels.push(take('shutter', fixed)); shutter = { open: open ? open.max : 255, closed: closed ? closed.min : 0 }; }
      else channels.push(fixed);
    }
    else channels.push(fixed);
  }
  const has = (a: string) => channels.includes(a);
  const type = has('pan') ? 'spot' : has('red') && has('green') && has('blue') ? 'rgb' : 'dimmer';
  if (type === 'spot' && !shutter) { shutter = { open: 255, closed: 0 }; notes.push('no shutter channel found; assumed open=255, closed=0'); }
  if (type !== 'dimmer' && !has('dimmer')) notes.push('no dimmer channel found: levels will have no effect on this fixture');
  const profile: Record<string, unknown> = {
    model: [q.manufacturer, q.model].filter(Boolean).join(' '), mode: modeName, type, verify: true, channels,
  };
  if (type === 'spot') {
    profile.shutter = shutter;
    profile.wheel = wheel;
    profile.gobos = { open: { dmx: null } };
    notes.push('pan_range / tilt_range default to 540 / 270: set them from the manual if different');
    notes.push('gobos: fill in the DMX values for each gobo you use');
  }
  return { id: `${slug(q.manufacturer)}-${slug(q.model)}-${slug(modeName)}`, profile, notes };
}

// ---- command line ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const opt = (n: string) => { const i = a.indexOf(n); if (i < 0) return undefined; const v = a[i + 1]; a.splice(i, 2); return v; };
  const mode = opt('--mode'), idOpt = opt('--id'), outDir = opt('--out') ?? 'rig/fixtures';
  const file = a[0];
  if (!file) { console.log('usage: npm run import-qxf -- <file.qxf> [--mode "11 Channel"] [--id name] [--out rig/fixtures]'); process.exit(1); }
  const xml = readFileSync(file, 'utf8');
  if (!mode) {
    const q = parseQxf(xml);
    console.log(`${q.manufacturer} ${q.model}\nModes:`);
    for (const [m, list] of Object.entries(q.modes)) console.log(`  "${m}" (${list.length} channels)`);
    console.log('\nRun again with --mode "<name>".');
    process.exit(0);
  }
  const r = convertQxf(xml, mode);
  const id = idOpt ?? r.id;
  const out = join(outDir, `${id}.yaml`);
  if (existsSync(out)) { console.error(`${out} already exists; choose --id or delete it first.`); process.exit(1); }
  writeFileSync(out, `# Imported from ${file} by tools/import-qxf.ts. UNVERIFIED: test on the bench, then delete "verify: true".\n` + stringify(r.profile, undefined));
  console.log(`wrote ${out}`);
  for (const n of r.notes) console.log(`  note: ${n}`);
  console.log(`Next: add it to rig/patch.yaml (profile: ${id}), run npm run check.`);
}
