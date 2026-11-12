// Loads the YAML show (rig, presets, effects, panels, songs) and resolves it into
// plain cue objects the engine can run. Every problem is reported with its file so
// `npm run check` can tell Claude (or a person) exactly what to fix.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';

export type RGB = [number, number, number];

export type ChannelDef =
  | { kind: 'attr'; attr: string }
  | { kind: 'fixed'; name: string; value: number };

export interface WheelSlot { name: string; dmx: number; rgb: RGB; index: number }

export interface Profile {
  id: string;
  model: string;
  mode: string;
  type: 'rgb' | 'spot' | 'dimmer';
  channels: ChannelDef[];
  verify: boolean;
  panRange: number;
  tiltRange: number;
  shutter: { open: number; closed: number };
  wheel: WheelSlot[];
  darkChange: { maxFreeSlots: number; dimTime: number; darkTime: number; darkTimePerSlot: number; riseTime: number } | null;
  gobos: Record<string, { dmx: number | null; lightkey?: string }>;
}

export interface Calibration { panOffset: number; tiltOffset: number; panInvert: boolean; tiltInvert: boolean }

export interface Fixture { name: string; profile: Profile; address: number; calibration: Calibration }

export interface EffectSpec { type: string; shape: string; pan: number; tilt: number; period: number; spread: number }

export interface FixtureTarget {
  level?: number;
  color?: RGB;
  wheel?: string;
  pan?: number;
  tilt?: number;
  gobo?: string;
  effect?: EffectSpec | null;
}

export interface Cue {
  id: string;              // e.g. "Youth/Wonder/CHORUS" or "Control_Panel/cue/SERMON"
  kind: 'song' | 'button' | 'sequence';
  page: string;            // OSC page name, e.g. Control_Panel
  folder?: string;
  name: string;            // OSC name (spaces as _)
  label: string;           // as written in the file
  fade: number;
  exclusive?: string;
  targets: Record<string, FixtureTarget>;
  file: string;
}

export interface Page { name: string; cuelist: string[] }

export interface Show {
  root: string;
  fixtures: Record<string, Fixture>;
  groups: Record<string, string[]>;
  colors: Record<string, RGB>;
  positions: Record<string, { pan: number; tilt: number }>;
  effects: Record<string, Omit<EffectSpec, 'type'>>;
  cues: Record<string, Cue>;
  pages: Record<string, Page>;
  sequences: Record<string, Cue>;
}

export interface Problem { level: 'error' | 'warning'; file: string; message: string }

export class ShowError extends Error {
  problems: Problem[];
  constructor(problems: Problem[]) {
    super(problems.filter(p => p.level === 'error').map(p => `${p.file}: ${p.message}`).join('\n'));
    this.problems = problems;
  }
}

export const oscName = (s: string): string => s.trim().replace(/\s+/g, '_');

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readYaml(path: string): any {
  return parse(readFileSync(path, 'utf8'));
}

function listYaml(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.yaml') && !f.startsWith('_')).sort().map(f => join(dir, f));
}

export function loadShow(root: string): { show: Show; problems: Problem[] } {
  const problems: Problem[] = [];
  const rel = (p: string) => relative(root, p) || p;
  const err = (file: string, message: string) => problems.push({ level: 'error', file: rel(file), message });
  const warn = (file: string, message: string) => problems.push({ level: 'warning', file: rel(file), message });

  // ---- fixture profiles ----
  const profiles: Record<string, Profile> = {};
  for (const file of listYaml(join(root, 'rig/fixtures'))) {
    const id = file.split('/').pop()!.replace(/\.yaml$/, '');
    let y: any;
    try { y = readYaml(file); } catch (e) { err(file, `YAML error: ${(e as Error).message}`); continue; }
    const channels: ChannelDef[] = [];
    for (const c of y.channels ?? []) {
      if (typeof c === 'string') channels.push({ kind: 'attr', attr: c });
      else if (c && typeof c.fixed === 'string' && isNum(c.value)) channels.push({ kind: 'fixed', name: c.fixed, value: c.value });
      else err(file, `bad channel entry ${JSON.stringify(c)}`);
    }
    const known = new Set(['red', 'green', 'blue', 'dimmer', 'pan', 'tilt', 'pan_fine', 'tilt_fine', 'wheel', 'shutter', 'gobo']);
    for (const c of channels) if (c.kind === 'attr' && !known.has(c.attr)) err(file, `unknown channel "${c.attr}"`);
    const wheel: WheelSlot[] = (y.wheel ?? []).map((w: any, i: number) => ({ name: w.name, dmx: w.dmx, rgb: w.rgb, index: i }));
    for (const h of y.wheel_half ?? []) {
      const a = wheel.findIndex(w => w.name === h.between?.[0]);
      const b = wheel.findIndex(w => w.name === h.between?.[1]);
      if (a < 0 || b < 0) { err(file, `wheel_half ${h.name}: "between" must name two wheel slots`); continue; }
      // half position sits between the two slots; for wrap-around pairs (amber/white) use the far end
      const index = Math.abs(a - b) === 1 ? (a + b) / 2 : Math.max(a, b) + 0.5;
      wheel.push({ name: h.name, dmx: h.dmx, rgb: h.rgb, index });
    }
    const dc = y.dark_change;
    profiles[id] = {
      id, model: y.model, mode: y.mode, type: y.type, channels, verify: !!y.verify,
      panRange: y.pan_range ?? 540, tiltRange: y.tilt_range ?? 270,
      shutter: y.shutter ?? { open: 255, closed: 0 },
      wheel,
      darkChange: dc ? { maxFreeSlots: dc.max_free_slots ?? 1, dimTime: dc.dim_time ?? 0.5, darkTime: dc.dark_time ?? 0.6, darkTimePerSlot: dc.dark_time_per_slot ?? 0.2, riseTime: dc.rise_time ?? 1 } : null,
      gobos: y.gobos ?? {},
    };
    if (!['rgb', 'spot', 'dimmer'].includes(y.type)) err(file, `type must be rgb, spot or dimmer`);
  }

  // ---- patch ----
  const patchFile = join(root, 'rig/patch.yaml');
  const patch = readYaml(patchFile) ?? {};
  const fixtures: Record<string, Fixture> = {};
  const used = new Map<number, string>();
  for (const [name, f] of Object.entries<any>(patch.fixtures ?? {})) {
    const profile = profiles[f.profile];
    if (!profile) { err(patchFile, `${name}: unknown profile "${f.profile}"`); continue; }
    if (!Number.isInteger(f.address) || f.address < 1 || f.address + profile.channels.length - 1 > 512) {
      err(patchFile, `${name}: address ${f.address} out of range`); continue;
    }
    for (let ch = f.address; ch < f.address + profile.channels.length; ch++) {
      if (used.has(ch)) err(patchFile, `${name}: channel ${ch} already used by ${used.get(ch)}`);
      used.set(ch, name);
    }
    const c = patch.calibration?.[name] ?? {};
    fixtures[name] = {
      name, profile, address: f.address,
      calibration: { panOffset: c.pan_offset ?? 0, tiltOffset: c.tilt_offset ?? 0, panInvert: !!c.pan_invert, tiltInvert: !!c.tilt_invert },
    };
    if (profile.verify) warn(patchFile, `${name}: profile ${profile.id} has unverified channel values`);
  }
  const groups: Record<string, string[]> = {};
  for (const [g, members] of Object.entries<any>(patch.groups ?? {})) {
    groups[g] = [];
    for (const m of members) {
      if (!fixtures[m]) err(patchFile, `group ${g}: unknown fixture ${m}`);
      else groups[g].push(m);
    }
  }

  // ---- presets & effects ----
  const colors: Record<string, RGB> = {};
  const colorsFile = join(root, 'presets/colors.yaml');
  for (const [k, v] of Object.entries<any>(readYaml(colorsFile) ?? {})) {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(x => isNum(x) && x >= 0 && x <= 100)) err(colorsFile, `${k}: must be [r, g, b] in percent`);
    else colors[k] = v as RGB;
  }
  const positions: Show['positions'] = {};
  const posFile = join(root, 'presets/positions.yaml');
  for (const [k, v] of Object.entries<any>(readYaml(posFile) ?? {})) {
    if (!isNum(v?.pan) || !isNum(v?.tilt)) err(posFile, `${k}: needs numeric pan and tilt`);
    else positions[k] = { pan: v.pan, tilt: v.tilt };
  }
  const effects: Show['effects'] = {};
  const fxFile = join(root, 'effects/library.yaml');
  const shapes = new Set(['sine_pan', 'sine_tilt', 'triangle', 'circle', 'figure8', 'random_walk']);
  for (const [k, v] of Object.entries<any>(readYaml(fxFile) ?? {})) {
    if (!shapes.has(v?.shape)) { err(fxFile, `${k}: unknown shape "${v?.shape}" (use ${[...shapes].join(', ')})`); continue; }
    effects[k] = { shape: v.shape, pan: v.pan ?? 0, tilt: v.tilt ?? 0, period: v.period ?? 8, spread: v.spread ?? 0 };
  }

  const show: Show = { root, fixtures, groups, colors, positions, effects, cues: {}, pages: {}, sequences: {} };

  // ---- cue resolution ----
  const resolveCue = (file: string, ctx: string, body: any): Record<string, FixtureTarget> => {
    const targets: Record<string, FixtureTarget> = {};
    if (!body || typeof body !== 'object') { err(file, `${ctx}: cue body must be a map`); return targets; }
    const keys = Object.keys(body).filter(k => !['fade', 'exclusive', 'note', 'extends'].includes(k));
    // groups first, then single fixtures, so a fixture line overrides its group
    const ordered = [...keys.filter(k => groups[k]), ...keys.filter(k => !groups[k])];
    for (const key of ordered) {
      const members = groups[key] ?? (fixtures[key] ? [key] : null);
      if (!members) { err(file, `${ctx}: "${key}" is not a group or fixture`); continue; }
      let spec = body[key];
      if (spec === 'off' || spec === 0) spec = { level: 0 };
      if (!spec || typeof spec !== 'object') { err(file, `${ctx}.${key}: expected a map like { level: 50 }`); continue; }
      const perFixture: Record<string, any> = spec.per_fixture ?? {};
      for (const m of members) {
        const t: FixtureTarget = (targets[m] ??= {});
        applySpec(file, `${ctx}.${key}`, fixtures[m], spec, t);
      }
      for (const [list, colour] of Object.entries(perFixture)) {
        for (const m of list.split(',').map(s => s.trim())) {
          if (!members.includes(m)) { err(file, `${ctx}.${key}.per_fixture: ${m} is not in ${key}`); continue; }
          applySpec(file, `${ctx}.${key}.${m}`, fixtures[m], typeof colour === 'object' && !Array.isArray(colour) ? colour : { color: colour }, (targets[m] ??= {}));
        }
      }
    }
    return targets;
  };

  const applySpec = (file: string, ctx: string, fx: Fixture, spec: any, t: FixtureTarget) => {
    const p = fx.profile;
    for (const [k, v] of Object.entries<any>(spec)) {
      switch (k) {
        case 'level':
          if (!isNum(v) || v < 0 || v > 100) err(file, `${ctx}: level must be 0-100`);
          else t.level = v;
          break;
        case 'color': {
          const rgb = Array.isArray(v) ? v : show.colors[v];
          if (p.type === 'spot') {
            const slot = p.wheel.find(w => w.name === v) ?? (rgb ? nearestSlot(p, rgb as RGB) : undefined);
            if (!slot) err(file, `${ctx}: unknown colour "${v}" (not a wheel slot or named colour)`);
            else t.wheel = slot.name;
          } else if (p.type === 'rgb') {
            if (!rgb || rgb.length !== 3 || !rgb.every((x: unknown) => isNum(x) && x >= 0 && x <= 100)) err(file, `${ctx}: unknown colour "${v}"`);
            else t.color = [rgb[0], rgb[1], rgb[2]];
          } else err(file, `${ctx}: ${fx.name} has no colour`);
          break;
        }
        case 'position': {
          if (p.type !== 'spot') { err(file, `${ctx}: ${fx.name} cannot move`); break; }
          const pos = typeof v === 'string' ? show.positions[v] : v;
          if (!pos || !isNum(pos.pan) || !isNum(pos.tilt)) err(file, `${ctx}: unknown position "${JSON.stringify(v)}"`);
          else { t.pan = pos.pan; t.tilt = pos.tilt; }
          break;
        }
        case 'gobo':
          if (p.type !== 'spot') { err(file, `${ctx}: ${fx.name} has no gobo`); break; }
          if (!(v in p.gobos)) err(file, `${ctx}: unknown gobo "${v}" (known: ${Object.keys(p.gobos).join(', ')})`);
          else t.gobo = v;
          break;
        case 'effect': {
          if (p.type !== 'spot') { err(file, `${ctx}: effects only work on moving heads`); break; }
          if (v === null || v === 'none') { t.effect = null; break; }
          const type = typeof v === 'string' ? v : v?.type;
          const base = show.effects[type];
          if (!base) { err(file, `${ctx}: unknown effect "${type}" (known: ${Object.keys(show.effects).join(', ')})`); break; }
          const o = typeof v === 'object' ? v : {};
          t.effect = { type, shape: base.shape, pan: o.pan ?? base.pan, tilt: o.tilt ?? base.tilt, period: o.period ?? base.period, spread: o.spread ?? base.spread };
          if (!(t.effect.period > 0)) err(file, `${ctx}: effect period must be > 0`);
          break;
        }
        case 'per_fixture':
          break;
        default:
          err(file, `${ctx}: unknown setting "${k}" (use level, color, position, gobo, effect, per_fixture)`);
      }
    }
  };

  const addCue = (cue: Cue) => {
    if (show.cues[cue.id]) err(cue.file, `duplicate cue ${cue.id} (also in ${show.cues[cue.id].file})`);
    show.cues[cue.id] = cue;
  };

  // ---- pages (cuelist order) ----
  const pagesFile = join(root, 'pages.yaml');
  const pagesY = existsSync(pagesFile) ? readYaml(pagesFile) ?? {} : {};
  for (const [pageName, def] of Object.entries<any>(pagesY)) {
    show.pages[pageName] = { name: pageName, cuelist: [] };
    (show.pages[pageName] as any)._order = def?.cuelist_order ?? [];
  }
  const page = (name: string) => (show.pages[name] ??= { name, cuelist: [], ...{ _order: [] } } as any);

  // ---- panels ----
  for (const file of listYaml(join(root, 'panels'))) {
    let y: any;
    try { y = readYaml(file); } catch (e) { err(file, `YAML error: ${(e as Error).message}`); continue; }
    if (!y?.page) { err(file, 'missing "page"'); continue; }
    page(y.page);
    for (const [label, body] of Object.entries<any>(y.buttons ?? {})) {
      const name = oscName(label);
      addCue({
        id: `${y.page}/cue/${name}`, kind: 'button', page: y.page, name, label,
        fade: isNum(body?.fade) ? body.fade : 0.5, exclusive: body?.exclusive,
        targets: resolveCue(file, `${label}`, body), file: rel(file),
      });
    }
  }

  // ---- songs ----
  for (const dir of ['songs/sunday', 'songs/youth', 'songs']) {
    for (const file of listYaml(join(root, dir))) {
      let y: any;
      try { y = readYaml(file); } catch (e) { err(file, `YAML error: ${(e as Error).message}`); continue; }
      if (!y?.page || !y?.folder) { err(file, 'missing "page" or "folder"'); continue; }
      const folder = y.folder as string;
      if (folder !== oscName(folder) || /['&]/.test(folder)) err(file, `folder "${folder}" must use underscores and no apostrophes or ampersands`);
      page(y.page);
      const raw = y.cues ?? {};
      for (const [label, body] of Object.entries<any>(raw)) {
        const name = oscName(label);
        let merged = body;
        if (body?.extends) {
          const [f, c] = String(body.extends).split('/');
          const src = f === folder ? raw[c] : undefined;
          if (!src) err(file, `${label}: extends "${body.extends}" not found (only cues in the same file can be extended)`);
          else merged = { ...src, ...body };
        }
        addCue({
          id: `${y.page}/${folder}/${name}`, kind: 'song', page: y.page, folder, name, label,
          fade: isNum(merged?.fade) ? merged.fade : 3,
          targets: resolveCue(file, `${folder}.${label}`, merged), file: rel(file),
        });
        if (!isNum(merged?.fade)) warn(file, `${label}: no fade given, using 3 s`);
      }
    }
  }

  // ---- sequences (toggled with /palette/<name>/...) ----
  const seqFile = join(root, 'sequences.yaml');
  if (existsSync(seqFile)) {
    for (const [label, body] of Object.entries<any>(readYaml(seqFile) ?? {})) {
      const name = oscName(label);
      show.sequences[name] = {
        id: `sequence/${name}`, kind: 'sequence', page: '*', name, label,
        fade: isNum(body?.fade) ? body.fade : 1, targets: resolveCue(seqFile, label, body), file: rel(seqFile),
      };
    }
  }

  // ---- cuelist order per page: pages.yaml order first, then the rest alphabetically ----
  for (const pg of Object.values<any>(show.pages)) {
    const folders = [...new Set(Object.values(show.cues).filter(c => c.kind === 'song' && c.page === pg.name).map(c => c.folder!))];
    const order: string[] = pg._order ?? [];
    for (const f of order) if (!folders.includes(f)) warn(pagesFile, `${pg.name}: cuelist_order lists "${f}" but there is no song file for it`);
    const sorted = [...order.filter((f: string) => folders.includes(f)), ...folders.filter(f => !order.includes(f)).sort()];
    pg.cuelist = sorted.flatMap(f => Object.values(show.cues).filter(c => c.kind === 'song' && c.page === pg.name && c.folder === f).map(c => c.id));
    delete pg._order;
  }

  // ---- whole-show checks ----
  for (const cue of Object.values(show.cues)) {
    for (const [fx, t] of Object.entries(cue.targets)) {
      if (t.effect && t.pan === undefined && cue.kind !== 'sequence') warn(cue.file, `${cue.label}: ${fx} has an effect but no position; it will move around wherever the head already points`);
    }
  }

  return { show, problems };
}

export function nearestSlot(p: Profile, rgb: RGB): WheelSlot | undefined {
  let best: WheelSlot | undefined, bestD = Infinity;
  for (const w of p.wheel) {
    if (!Number.isInteger(w.index)) continue; // half positions only by name
    const d = (w.rgb[0] - rgb[0]) ** 2 + (w.rgb[1] - rgb[1]) ** 2 + (w.rgb[2] - rgb[2]) ** 2;
    if (d < bestD) { bestD = d; best = w; }
  }
  return best;
}

export function loadShowOrThrow(root: string): { show: Show; problems: Problem[] } {
  const r = loadShow(root);
  if (r.problems.some(p => p.level === 'error')) throw new ShowError(r.problems);
  return r;
}
