// One-time converter: import/lightkey-export.json -> pages.yaml, panels/, songs/, sequences.yaml
// plus import/conversion-report.md listing every judgement call.
//
//   npm run convert-lightkey            (refuses to overwrite existing song files)
//   npm run convert-lightkey -- --force (overwrite)
//
// Lightkey rules applied: presets in a cue apply in listed order, then the cue's ad hoc
// values on top. An empty {} means "included at 0". House circuits 200-207 collapse to
// the HOUSE group (all or nothing, per Spencer 11/12).

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadShow, nearestSlot, type RGB, type Show } from '../src/show.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');
const ex = JSON.parse(readFileSync(join(root, 'import/lightkey-export.json'), 'utf8'));

// Rig only (no songs yet) to know fixtures, groups and wheel slots.
const { show } = loadShow(root);
const report: string[] = [];
const note = (s: string) => report.push(s);
const conflicts: Record<string, Set<string>> = {};

const HOUSE_NAMES: Record<string, string> = { na: 'H200', STG: 'H201', na1: 'H202', MID: 'H203', STG1: 'H204', REAR: 'H205', na2: 'H206', na3: 'H207' };
const fxName = (n: string) => HOUSE_NAMES[n] ?? n;

const POSITION_NAMES: Record<string, string> = { 'Upper Wash': 'upper_wash', 'Upper 4 Beams, 40%': 'upper_4_beams', 'Floor Wash': 'floor_wash' };
const mh = show.fixtures.MH1.profile;
const goboByLightkey: Record<string, string> = {};
for (const [k, v] of Object.entries(mh.gobos)) if (v.lightkey) goboByLightkey[v.lightkey] = k;

// Effect shapes and speeds come from the Youth cue notes (lightkey-youth-cues.md); the
// export only stores "PanTilt" plus a number.
const EFFECTS: Record<string, { type: string; period: number }> = {
  'O_Come_To_The_Altar/VERSE': { type: 'triangle_small', period: 12 },
  'O_Come_To_The_Altar/BRIDGE': { type: 'wiper', period: 10 },
  'Whole_Heart/PRE_CHORUS': { type: 'tilt_wave', period: 6 },
  'Whole_Heart/CHORUS_2': { type: 'wiper', period: 10 },
  'Closer/CHORUS_2': { type: 'wiper', period: 10 },
  'My_Lighthouse/CHORUS': { type: 'pan_track', period: 8 },
  'My_Lighthouse/BRIDGE': { type: 'wiper', period: 3 },
  'My_Lighthouse/CHORUS_2': { type: 'pan_track', period: 8 },
  'Washed/CHORUS': { type: 'wiper', period: 10 },
  'Washed/BRIDGE': { type: 'pan_track', period: 8 },
  'Washed/CHORUS_2': { type: 'wiper', period: 5 },
  'The_Lord_Will_Provide/BRIDGE': { type: 'pan_track', period: 8 },
  'Wonder/VERSE': { type: 'triangle_small', period: 12 },
  'Wonder/CHORUS': { type: 'wiper', period: 8 },
  'Wonder/BRIDGE': { type: 'pan_track', period: 12 },
  'Wonder/BRIDGE_2': { type: 'wiper', period: 8 },
  'Wonder/CHORUS_2': { type: 'wiper', period: 4 },
  'Gratitude/CHORUS': { type: 'tilt_wave', period: 10 },
  'The_Author/CHORUS': { type: 'tilt_wave', period: 10 },
};

type Attrs = { level?: number; color?: RGB; wheel?: string; position?: string | { pan: number; tilt: number }; gobo?: string; effect?: { type: string; period: number } };

const presets = new Map<string, any>();
for (const p of ex.presets) {
  presets.set(`${p.group}|${p.name}`, p);
  if (!presets.has(`*|${p.name}`)) presets.set(`*|${p.name}`, p);
}
const findPreset = (group: string, name: string) => presets.get(`${group}|${name}`) ?? presets.get(`*|${name}`);

const pct = (s: string): RGB => s.split('/').map(Number) as RGB;
const round = (n: number) => Math.round(n * 10) / 10;

/** Resolve one cue's contents into per-fixture attributes (our fixture names). */
function resolve(contents: any[], ctx: string): Record<string, Attrs> {
  const out: Record<string, Attrs> = {};
  const setBy: Record<string, string> = {};
  const apply = (values: Record<string, any>, source: string, isPreset: boolean, group = '') => {
    // A preset only applies its own kind of property (confirmed against cues built by
    // hand: "Upper Wash" stores dimmer 100% but INTRO cues using it have spots off).
    const kinds = !isPreset ? null
      : /POSITIONS/.test(group) && !/GOBO/.test(group) ? new Set(['pan', 'gobo'])
      : /GOBO/.test(group) ? new Set(['gobo'])
      : /COLORS/.test(group) ? new Set(['color', 'gobo'])
      : /DIMMER|HOUSE/.test(group) ? new Set(['level'])
      : null;
    const allowed = (k: string) => !kinds || kinds.has(k);
    // ...and only to the fixtures its group is for (SPOTS -> MH, WALL WASH -> BARS, PAR ->
    // PARs, HOUSE -> house). Lightkey saved extra fixtures into several presets (e.g.
    // SPOTS / COLORS / White also holds PAR and bar colours). A preset whose name lists
    // several things ("Dark Blue, Blue, Random Stars Large") is meant for the whole rig.
    const scope = !isPreset || source.includes(',') ? null
      : group.startsWith('SPOTS') ? 'MH' : group.startsWith('WALL WASH') ? 'BARS'
      : group.startsWith('PAR') ? 'PAR' : group.startsWith('HOUSE') ? 'HOUSE' : null;
    for (const [lkName, raw] of Object.entries<any>(values ?? {})) {
      if (scope && !show.groups[scope].includes(fxName(lkName))) continue;
      let v = raw;
      // White on the spots = open wheel (Lightkey stores no wheel value for it)
      if (kinds?.has('color') && show.fixtures[fxName(lkName)]?.profile.type === 'spot' && v.wheel === undefined && v.int !== undefined) v = { ...v, wheel: '100/100/100' };
      v = Object.fromEntries(Object.entries(v).filter(([k]) =>
        allowed(k === 'int' ? 'level' : k === 'rgb' || k === 'wheel' ? 'color' : k === 'pan°' || k === 'tilt°' ? 'pan' : k === 'gobo' ? 'gobo' : k)));
      if (Object.keys(raw).length === 0 && allowed('level')) v = {};
      else if (Object.keys(v).length === 0) continue;
      const name = fxName(lkName);
      if (!show.fixtures[name]) { note(`- ${ctx}: unknown fixture ${lkName} in ${source}, skipped`); continue; }
      const a = (out[name] ??= {});
      const set = (attr: keyof Attrs, val: any) => {
        const k = `${name}.${attr}`;
        const prev = (a as any)[attr];
        if (isPreset && setBy[k]?.startsWith('preset') && prev !== undefined && JSON.stringify(prev) !== JSON.stringify(val)) {
          const grp = Object.entries(show.groups).find(([, m]) => m.includes(name))?.[0] ?? name;
          const msg = `${grp} ${attr}: ${setBy[k].slice(7)} then ${source}; kept ${source}`;
          (conflicts[msg] ??= new Set()).add(ctx);
        }
        (a as any)[attr] = val;
        setBy[k] = isPreset ? `preset ${source}` : 'adhoc';
      };
      if (Object.keys(v).length === 0) set('level', 0);
      if (v.int !== undefined) set('level', v.int);
      if (v.rgb !== undefined) set('color', pct(v.rgb));
      if (v.wheel !== undefined) {
        const slot = nearestSlot(show.fixtures[name].profile, pct(v.wheel));
        set('wheel', slot!.name);
      }
      if (v['pan°'] !== undefined) {
        const pos = Object.entries(show.positions).find(([, p]) => Math.abs(p.pan - v['pan°']) < 0.05 && Math.abs(p.tilt - v['tilt°']) < 0.05);
        set('position', pos ? pos[0] : { pan: round(v['pan°']), tilt: round(v['tilt°']) });
      }
      if (v.gobo !== undefined) {
        const g = goboByLightkey[v.gobo];
        if (!g) note(`- ${ctx}: ${name} gobo ${v.gobo} has no mapping; left out`);
        else set('gobo', g);
      }
      if (v.strobe !== undefined) note(`- ${ctx}: ${name} strobe ${v.strobe} ignored (strobe not supported yet)`);
    }
  };
  for (const item of contents) {
    if (item.preset) {
      const p = findPreset(item.group, item.preset);
      if (!p) { note(`- ${ctx}: preset "${item.group} / ${item.preset}" not found, skipped`); continue; }
      apply(p.values, `"${p.group} / ${p.name}"`, true, p.group);
      if (POSITION_NAMES[p.name]) for (const m of show.groups.MH) if (out[m]?.position && typeof out[m].position === 'object') out[m].position = POSITION_NAMES[p.name];
    }
  }
  for (const item of contents) if (item.adhoc) apply(item.adhoc, 'ad hoc', false);
  for (const item of contents) if (item.effects?.length) {
    const [folderCue] = [ctx.split('/').slice(1).join('/')];
    const e = EFFECTS[folderCue];
    if (!e) note(`- ${ctx}: Lightkey effect ${JSON.stringify(item.effects)} has no shape in the notes; used wiper 8 s`);
    for (const m of show.groups.MH) (out[m] ??= {}).effect = e ?? { type: 'wiper', period: 8 };
  }
  // House: all or nothing
  const house = show.groups.HOUSE.map(h => out[h]?.level).filter(v => v !== undefined) as number[];
  if (house.length) {
    const lvl = Math.max(...house);
    if (new Set(house).size > 1 || house.length < show.groups.HOUSE.length) note(`- ${ctx}: house circuits had mixed/partial levels (${[...new Set(house)].join(', ')}); HOUSE set to ${lvl}`);
    for (const h of show.groups.HOUSE) out[h] = { level: lvl };
  }
  return out;
}

// ---------- YAML emitting ----------
const colorStr = (c: RGB) => {
  const named = Object.entries(show.colors).find(([, v]) => v[0] === c[0] && v[1] === c[1] && v[2] === c[2]);
  return named ? named[0] : `[${c.join(', ')}]`;
};
function attrsStr(a: Attrs): string {
  const parts: string[] = [];
  if (a.color) parts.push(`color: ${colorStr(a.color)}`);
  if (a.wheel) parts.push(`color: ${a.wheel}`);
  if (a.level !== undefined) parts.push(`level: ${a.level}`);
  if (a.position) parts.push(`position: ${typeof a.position === 'string' ? a.position : `{ pan: ${a.position.pan}, tilt: ${a.position.tilt} }`}`);
  if (a.gobo) parts.push(`gobo: ${a.gobo}`);
  if (a.effect) parts.push(`effect: { type: ${a.effect.type}, period: ${a.effect.period} }`);
  return `{ ${parts.join(', ')} }`;
}
const q = (k: string) => (/^[A-Z0-9_]+$/.test(k) ? k : JSON.stringify(k));

function cueLines(per: Record<string, Attrs>, indent: string): string[] {
  const lines: string[] = [];
  const done = new Set<string>();
  for (const [g, members] of Object.entries(show.groups)) {
    const present = members.filter(m => per[m]);
    if (!present.length) continue;
    const common: Attrs = {};
    for (const attr of ['level', 'color', 'wheel', 'position', 'gobo', 'effect'] as const) {
      const vals = members.map(m => JSON.stringify(per[m]?.[attr]));
      if (vals.every(v => v === vals[0]) && vals[0] !== undefined) (common as any)[attr] = per[members[0]][attr];
    }
    if (Object.keys(common).length) lines.push(`${indent}${g}: ${attrsStr(common)}`);
    for (const m of present) {
      const rest: Attrs = {};
      for (const [k, v] of Object.entries(per[m])) if ((common as any)[k] === undefined) (rest as any)[k] = v;
      if (Object.keys(rest).length) lines.push(`${indent}${m}: ${attrsStr(rest)}`);
      done.add(m);
    }
  }
  for (const [m, a] of Object.entries(per)) if (!done.has(m)) lines.push(`${indent}${m}: ${attrsStr(a)}`);
  return lines;
}

// ---------- write ----------
const header = (what: string) => `# ${what}\n# Converted from Lightkey (export 2026-11-11) by tools/convert-lightkey.ts.\n# Edit freely; this file is now the source of truth.\n`;
const pagesOut: string[] = ['# Cuelist order per page, used by GO / BACK (/live/nextCue, /live/previousCue).', '# Folders not listed here go after these, alphabetically.'];
const written: string[] = [];
const existingSongs = [...readdirSync(join(root, 'songs/sunday')), ...readdirSync(join(root, 'songs/youth'))].filter(f => f.endsWith('.yaml'));
if (existingSongs.length && !force) {
  console.error(`songs/ already has ${existingSongs.length} files. Re-run with --force to overwrite them.`);
  process.exit(1);
}

const LOOKS = new Set(['PRE_POST', 'START', 'VIDEO', 'SERMON']);
const HOUSE_BTN = new Set(['HOUSE 100%', 'HOUSE 0%']);

for (const panel of ex.panels) {
  const page = panel.panel.replace(/\s+/g, '_');
  const dir = page === 'Youth' ? 'songs/youth' : 'songs/sunday';
  pagesOut.push(`${page}:`, `  cuelist_order:`);
  // songs
  for (const folder of panel.cuelist) {
    const folderName = folder.folder.replace(/\s+/g, '_');
    pagesOut.push(`    - ${folderName}`);
    const lines = [header(`${folder.folder} (${panel.panel} page)`), `page: ${page}`, `folder: ${folderName}`, '', 'cues:'];
    for (const cue of folder.cues) {
      const ctx = `${page}/${folderName}/${cue.name.replace(/\s+/g, '_')}`;
      const per = resolve(cue.contents, ctx);
      const missing = ['PAR', 'BARS', 'MH'].filter(g => !show.groups[g].some(m => per[m]));
      if (missing.length) note(`- ${ctx}: has no ${missing.join(' / ')} values in the export, so ${missing.join(' / ')} go dark in this cue. Compare with the cue notes; add the look back if Lightkey shows it.`);
      lines.push(`  ${q(cue.name)}:`, `    fade: ${cue.fade}`, ...cueLines(per, '    '));
    }
    const file = join(root, dir, `${folderName.toLowerCase()}.yaml`);
    writeFileSync(file, lines.join('\n') + '\n');
    written.push(file);
  }
  // panel buttons
  const lines = [header(`${panel.panel} panel buttons (Companion pages 8 / 13)`), `page: ${page}`, '', 'buttons:'];
  for (const b of panel.buttons) {
    const per = resolve(b.contents, `${page}/cue/${b.name.replace(/\s+/g, '_')}`);
    const excl = LOOKS.has(b.name) ? 'looks' : HOUSE_BTN.has(b.name) ? 'house' : undefined;
    lines.push(`  ${q(b.name)}:`, `    fade: ${b.fade}`, ...(excl ? [`    exclusive: ${excl}`] : []), ...cueLines(per, '    '));
    if (b.fade_in !== b.fade) note(`- ${page}/cue/${b.name}: Lightkey also stores fade-in ${b.fade_in} s / fade-out ${b.fade_out} s; used fade ${b.fade} s. Check how fast it looks today.`);
  }
  const pf = join(root, 'panels', `${page.toLowerCase()}.yaml`);
  writeFileSync(pf, lines.join('\n') + '\n');
  written.push(pf);
}
writeFileSync(join(root, 'pages.yaml'), pagesOut.join('\n') + '\n');

// Floor Random: Lightkey library sequence (SPOTS, beat-controlled, one step "Floor Wash").
writeFileSync(join(root, 'sequences.yaml'), `# Sequences, toggled with /palette/<Name>/<start|stop|toggle> (Companion "Floor Random").
# Lightkey's Floor Random moved the spots around the floor on the beat (90 bpm). This is a
# close stand-in: random floor aims around Floor Wash, a new one every 2 beats (1.33 s).
Floor Random:
  fade: 1
  MH: { position: floor_wash, effect: { type: random_floor } }
`);
note('- Floor Random: rebuilt as a random walk around Floor Wash (1.33 s steps); Lightkey\'s exact steps were not in the export.');

for (const [msg, ctxs] of Object.entries(conflicts)) note(`- Two presets in one cue disagree. ${msg}. Check on stage. Cues: ${[...ctxs].join(', ')}`);

const intro = [
  '# Lightkey conversion report',
  '',
  `Generated by \`tools/convert-lightkey.ts\` from \`import/lightkey-export.json\`. ${written.length} files written.`,
  '',
  'Rules: presets apply in the order Lightkey lists them, then the cue\'s ad hoc values on top. A preset only sets its own kind of property (a position preset sets only position) and only on its own fixtures (SPOTS = MH, WALL WASH = bars, PAR = PARs, HOUSE = house). Empty `{}` = level 0. House circuits 200-207 = one HOUSE group. Spot wheel colours are the nearest wheel slot to Lightkey\'s RGB target. Effect shapes come from `lightkey-youth-cues.md`; Lightkey\'s stored numbers (2000/3000) were not used.',
  '',
  '## Judgement calls to check',
  '',
];
writeFileSync(join(root, 'import/conversion-report.md'), [...intro, ...(report.length ? report : ['None.'])].join('\n') + '\n');
console.log(`wrote ${written.length} files, ${report.length} notes in import/conversion-report.md`);
