// The lighting engine: keeps the stack of active cues, fades between looks, runs
// position effects and the colour-wheel dark-change, and renders a 512-channel frame.
//
// Model (same as Lightkey's live behaviour, as far as we use it):
//  - Every active cue contributes fixture attributes. For each attribute the most
//    recently activated cue that sets it wins ("latest takes precedence").
//  - Song cues on a page replace each other (one cuelist cue at a time per page).
//  - Panel buttons with the same `exclusive` group replace each other.
//  - An attribute nobody sets: level goes to 0, colour/position/gobo hold.

import type { Show, Cue, Fixture, FixtureTarget, EffectSpec, RGB } from './show.ts';

export type Clock = () => number; // seconds

class Tr {
  from: number; to: number; t0: number; dur: number;
  constructor(from: number, to: number, t0: number, dur: number) {
    this.from = from; this.to = to; this.t0 = t0; this.dur = Math.max(0, dur);
  }
  value(now: number): number {
    if (this.dur === 0 || now >= this.t0 + this.dur) return this.to;
    if (now <= this.t0) return this.from;
    return this.from + (this.to - this.from) * ((now - this.t0) / this.dur);
  }
  done(now: number): boolean { return this.dur === 0 || now >= this.t0 + this.dur; }
}

interface Gate { t0: number; dim: number; dark: number; rise: number }

interface FState {
  level: Tr;
  rgb: [Tr, Tr, Tr];
  pan: Tr;
  tilt: Tr;
  wheel: string | undefined;        // slot currently sent
  wheelTarget: string | undefined;  // slot asked for
  wheelSwitchAt: number;
  gobo: string | undefined;
  gate: Gate | null;
  effects: { key: string; spec: EffectSpec; weight: Tr }[];
  effectKey: string;
}

interface Active { cue: Cue; seq: number }

export interface FireResult { ok: boolean; message: string }

/** What survives a restart: enough to bring the lights back to the same look. */
export interface Snapshot {
  active: string[];   // cue ids, oldest first (activation order decides who wins)
  master: number;     // 0-1
  selectedPage: string | null;
  currentSong: Record<string, string>;
}

export interface Status {
  active: string[];
  master: number;
  selectedPage: string | null;
  currentSong: Record<string, string>;
  look: string | null;
}

const ATTRS = ['level', 'color', 'wheel', 'pan', 'tilt', 'gobo', 'effect'] as const;

export class Engine {
  show: Show;
  now: Clock;
  zeroFadeMeansDefault: boolean;
  states: Record<string, FState> = {};
  active = new Map<string, Active>();
  seq = 0;
  master: Tr;
  selectedPage: string | null = null;
  currentSong: Record<string, string> = {};
  onChange: ((s: Status) => void) | null = null;
  private instant = false; // while restoring: no fades, no dark-change
  log: (msg: string) => void;

  constructor(show: Show, opts: { now?: Clock; zeroFadeMeansDefault?: boolean; log?: (m: string) => void } = {}) {
    this.show = show;
    this.now = opts.now ?? (() => performance.now() / 1000);
    this.zeroFadeMeansDefault = opts.zeroFadeMeansDefault ?? true;
    this.log = opts.log ?? (() => {});
    this.master = new Tr(1, 1, 0, 0);
    this.selectedPage = Object.keys(show.pages)[0] ?? null;
    this.initStates();
  }

  private initStates() {
    const t = this.now();
    for (const fx of Object.values(this.show.fixtures)) {
      if (this.states[fx.name]) continue;
      this.states[fx.name] = {
        level: new Tr(0, 0, t, 0),
        rgb: [new Tr(100, 100, t, 0), new Tr(100, 100, t, 0), new Tr(100, 100, t, 0)],
        pan: new Tr(fx.profile.panRange / 2, fx.profile.panRange / 2, t, 0),
        tilt: new Tr(0, 0, t, 0),
        wheel: fx.profile.wheel[0]?.name, wheelTarget: fx.profile.wheel[0]?.name, wheelSwitchAt: 0,
        gobo: undefined, gate: null, effects: [], effectKey: '',
      };
    }
    for (const name of Object.keys(this.states)) if (!this.show.fixtures[name]) delete this.states[name];
  }

  // ---------- public control ----------

  /** Swap in a newly loaded show without dropping the running look. */
  reload(show: Show, fade = 1) {
    this.show = show;
    this.initStates();
    for (const [id, a] of [...this.active]) {
      const fresh = id.startsWith('sequence/') ? show.sequences[id.slice(9)] : show.cues[id];
      if (fresh) a.cue = fresh; else this.active.delete(id);
    }
    if (this.selectedPage && !show.pages[this.selectedPage]) this.selectedPage = Object.keys(show.pages)[0] ?? null;
    this.apply(fade);
  }

  snapshot(): Snapshot {
    const active = [...this.active.values()].sort((a, b) => a.seq - b.seq).map(a => a.cue.id);
    return { active, master: this.master.to, selectedPage: this.selectedPage, currentSong: { ...this.currentSong } };
  }

  /** Bring back a saved look at once (used after a restart). Unknown cues are skipped. */
  restore(snap: Snapshot): number {
    this.instant = true;
    try {
      let n = 0;
      this.active.clear();
      for (const id of snap.active ?? []) {
        const cue = id.startsWith('sequence/') ? this.show.sequences[id.slice(9)] : this.show.cues[id];
        if (!cue) continue;
        this.active.set(id, { cue, seq: ++this.seq });
        n++;
      }
      this.currentSong = {};
      for (const [pg, id] of Object.entries(snap.currentSong ?? {})) if (this.show.cues[id]) this.currentSong[pg] = id;
      if (snap.selectedPage && this.show.pages[snap.selectedPage]) this.selectedPage = snap.selectedPage;
      const m = typeof snap.master === 'number' && Number.isFinite(snap.master) ? Math.min(1, Math.max(0, snap.master)) : 1;
      this.master = new Tr(m, m, this.now(), 0);
      this.apply(0);
      return n;
    } finally { this.instant = false; }
  }

  activate(id: string, fade?: number): FireResult {
    const cue = id.startsWith('sequence/') ? this.show.sequences[id.slice(9)] : this.show.cues[id];
    if (!cue) return { ok: false, message: `no cue ${id}` };
    for (const [otherId, a] of [...this.active]) {
      if (otherId === id) continue;
      const c = a.cue;
      if (cue.kind === 'song' && c.kind === 'song' && c.page === cue.page) this.active.delete(otherId);
      if (cue.exclusive && c.exclusive === cue.exclusive && c.page === cue.page) this.active.delete(otherId);
    }
    this.active.set(id, { cue, seq: ++this.seq });
    if (cue.kind === 'song') this.currentSong[cue.page] = id;
    this.apply(fade ?? cue.fade);
    return { ok: true, message: `activated ${id}` };
  }

  deactivate(id: string, fade?: number): FireResult {
    const a = this.active.get(id);
    if (!a) return { ok: true, message: `${id} was not active` };
    this.active.delete(id);
    this.apply(fade ?? a.cue.fade);
    return { ok: true, message: `deactivated ${id}` };
  }

  toggle(id: string, fade?: number): FireResult {
    return this.active.has(id) ? this.deactivate(id, fade) : this.activate(id, fade);
  }

  setMaster(level01: number, fade = 0) {
    const t = this.now();
    const v = Math.min(1, Math.max(0, level01));
    this.master = new Tr(this.master.value(t), v, t, fade);
    this.changed();
  }

  step(dir: 1 | -1, fade?: number): FireResult {
    const page = this.selectedPage;
    if (!page || !this.show.pages[page]) return { ok: false, message: 'no page selected' };
    const list = this.show.pages[page].cuelist;
    if (!list.length) return { ok: false, message: `page ${page} has no song cues` };
    const cur = this.currentSong[page] ? list.indexOf(this.currentSong[page]) : -1;
    const next = cur < 0 ? (dir === 1 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, cur + dir));
    return this.activate(list[next], fade);
  }

  selectPage(page: string): FireResult {
    if (!this.show.pages[page]) return { ok: false, message: `no page ${page}` };
    this.selectedPage = page;
    this.changed();
    return { ok: true, message: `selected page ${page}` };
  }

  /** Handle one OSC message using Lightkey's address scheme. */
  handleOsc(address: string, args: unknown[] = []): FireResult {
    const parts = address.split('/').filter(Boolean);
    const num = typeof args[0] === 'number' ? (args[0] as number) : undefined;
    const fade = num === undefined || (num === 0 && this.zeroFadeMeansDefault) ? undefined : num;
    const modeRun = (id: string, mode: string): FireResult => {
      if (mode === 'activate' || mode === 'start') return this.activate(id, fade);
      if (mode === 'deactivate' || mode === 'stop') return this.deactivate(id, fade);
      if (mode === 'toggle') return this.toggle(id, fade);
      return { ok: false, message: `unknown mode "${mode}"` };
    };
    const pagesFor = (p: string): string[] =>
      p === '*' ? Object.keys(this.show.pages) : p === 'selected' ? (this.selectedPage ? [this.selectedPage] : []) : [p];

    if (parts[0] === 'live') {
      if (parts.length === 2) {
        if (parts[1] === 'nextCue') return this.step(1, fade);
        if (parts[1] === 'previousCue') return this.step(-1, fade);
        return { ok: false, message: `cuelist command "${parts[1]}" not supported` };
      }
      if (parts.length === 3 && parts[2] === 'select') return this.selectPage(parts[1]);
      if (parts.length === 5) {
        const [, page, folder, name, mode] = parts;
        const results: FireResult[] = [];
        for (const pg of pagesFor(page)) {
          const id = folder === 'cue' ? this.findButton(pg, name) : this.findSong(pg, folder, name);
          if (id) results.push(modeRun(id, mode));
        }
        if (results.length) return results.find(r => !r.ok) ?? results[0];
        return { ok: false, message: `no cue matches ${address}` };
      }
    }
    if (parts[0] === 'output' && parts[1] === 'master' && num !== undefined) {
      this.setMaster(num);
      return { ok: true, message: `master ${Math.round(num * 100)}%` };
    }
    if (parts[0] === 'palette' && parts.length >= 3) {
      const mode = parts[parts.length - 1];
      const name = parts.slice(1, -1).join('_');
      const seq = Object.keys(this.show.sequences).find(s => s.toLowerCase() === name.toLowerCase());
      if (seq) return modeRun(`sequence/${seq}`, mode);
      return { ok: false, message: `no sequence ${name}` };
    }
    return { ok: false, message: `unsupported address ${address}` };
  }

  private findButton(page: string, name: string): string | undefined {
    const id = `${page}/cue/${name}`;
    if (this.show.cues[id]) return id;
    const lower = id.toLowerCase();
    return Object.keys(this.show.cues).find(k => k.toLowerCase() === lower);
  }

  private findSong(page: string, folder: string, name: string): string | undefined {
    const id = `${page}/${folder}/${name}`;
    if (this.show.cues[id]) return id;
    const lower = id.toLowerCase();
    return Object.keys(this.show.cues).find(k => k.toLowerCase() === lower && this.show.cues[k].kind === 'song');
  }

  status(): Status {
    const sorted = [...this.active.values()].sort((a, b) => a.seq - b.seq);
    const look = [...sorted].reverse().find(a => a.cue.kind === 'button' && a.cue.exclusive === 'looks');
    return {
      active: sorted.map(a => a.cue.id),
      master: Math.round(this.master.value(this.now()) * 100),
      selectedPage: this.selectedPage,
      currentSong: { ...this.currentSong },
      look: look ? look.cue.label : null,
    };
  }

  // ---------- merging and transitions ----------

  private merged(): Record<string, FixtureTarget> {
    const out: Record<string, FixtureTarget> = {};
    const stack = [...this.active.values()].sort((a, b) => b.seq - a.seq); // newest first
    for (const name of Object.keys(this.show.fixtures)) {
      const t: FixtureTarget = {};
      for (const attr of ATTRS) {
        for (const a of stack) {
          const ft = a.cue.targets[name];
          if (!ft) continue;
          if (attr === 'pan' || attr === 'tilt') {
            if (ft.pan !== undefined) { t.pan = ft.pan; t.tilt = ft.tilt; break; }
            continue;
          }
          if ((ft as any)[attr] !== undefined) { (t as any)[attr] = (ft as any)[attr]; break; }
        }
      }
      out[name] = t;
    }
    return out;
  }

  private apply(fade: number) {
    const now = this.now();
    const target = this.merged();
    for (const fx of Object.values(this.show.fixtures)) {
      const st = this.states[fx.name];
      const t = target[fx.name];
      const level = t.level ?? 0;
      if (st.level.to !== level) st.level = new Tr(st.level.value(now), level, now, fade);
      if (t.color) for (let i = 0; i < 3; i++) if (st.rgb[i].to !== t.color[i]) st.rgb[i] = new Tr(st.rgb[i].value(now), t.color[i], now, fade);
      if (t.pan !== undefined && st.pan.to !== t.pan) st.pan = new Tr(st.pan.value(now), t.pan, now, fade);
      if (t.tilt !== undefined && st.tilt.to !== t.tilt) st.tilt = new Tr(st.tilt.value(now), t.tilt, now, fade);
      if (t.gobo !== undefined) st.gobo = t.gobo;
      if (t.wheel !== undefined && t.wheel !== st.wheelTarget) this.moveWheel(fx, st, t.wheel, now);
      const spec = t.effect ?? null;
      const key = spec ? JSON.stringify(spec) : '';
      if (key !== st.effectKey) {
        for (const e of st.effects) e.weight = new Tr(e.weight.value(now), 0, now, fade);
        if (spec) st.effects.push({ key, spec, weight: new Tr(0, 1, now, fade) });
        st.effectKey = key;
      }
    }
    this.changed();
  }

  /** Colour wheel change, with the dark-change for moves of more than one slot. */
  private moveWheel(fx: Fixture, st: FState, slot: string, now: number) {
    const p = fx.profile;
    const from = p.wheel.find(w => w.name === (st.wheelTarget ?? st.wheel));
    const to = p.wheel.find(w => w.name === slot);
    st.wheelTarget = slot;
    const dc = p.darkChange;
    const dist = from && to ? Math.abs(from.index - to.index) : 0;
    if (!dc || dist <= dc.maxFreeSlots || this.instant) {
      st.wheelSwitchAt = now;
      st.wheel = slot;
      return;
    }
    const lit = this.outputLevel(fx.name, now) > 0.5;
    const dim = lit ? dc.dimTime : 0;
    st.gate = { t0: now, dim, dark: dc.darkTime + dc.darkTimePerSlot * dist, rise: dc.riseTime };
    st.wheelSwitchAt = now + dim;
    this.log(`${fx.name}: wheel ${from?.name} -> ${to?.name} (${dist} slots), dark-change`);
  }

  private gateValue(st: FState, now: number): number {
    const g = st.gate;
    if (!g) return 1;
    const t = now - g.t0;
    if (t < g.dim) return 1 - t / g.dim;
    if (t < g.dim + g.dark) return 0;
    if (t < g.dim + g.dark + g.rise) return (t - g.dim - g.dark) / g.rise;
    st.gate = null;
    return 1;
  }

  /** Fixture level in percent after dark-change gate and master. */
  outputLevel(name: string, now = this.now()): number {
    const st = this.states[name];
    return st.level.value(now) * this.gateValue(st, now) * this.master.value(now);
  }

  // ---------- rendering ----------

  render(now = this.now()): Uint8Array {
    const frame = new Uint8Array(512);
    const mhNames = this.show.groups.MH ?? [];
    for (const fx of Object.values(this.show.fixtures)) {
      const st = this.states[fx.name];
      const p = fx.profile;
      if (st.wheelTarget !== st.wheel && now >= st.wheelSwitchAt) st.wheel = st.wheelTarget;
      const level = this.outputLevel(fx.name, now);
      // effects (relative to the base position)
      let dPan = 0, dTilt = 0;
      st.effects = st.effects.filter(e => !(e.weight.done(now) && e.weight.to === 0));
      const idx = Math.max(0, mhNames.indexOf(fx.name));
      const n = Math.max(1, mhNames.length);
      for (const e of st.effects) {
        const w = e.weight.value(now);
        if (w <= 0) continue;
        const [dp, dt] = effectOffset(e.spec, now, idx, n);
        dPan += w * dp; dTilt += w * dt;
      }
      const values: Record<string, number> = {};
      const b = (pct: number) => Math.round(Math.min(100, Math.max(0, pct)) * 2.55);
      values.dimmer = b(level);
      values.red = b(st.rgb[0].value(now));
      values.green = b(st.rgb[1].value(now));
      values.blue = b(st.rgb[2].value(now));
      if (p.type === 'spot') {
        const cal = fx.calibration;
        let pan = st.pan.value(now) + dPan;
        let tilt = st.tilt.value(now) + dTilt;
        pan = (cal.panInvert ? p.panRange - pan : pan) + cal.panOffset;
        tilt = (cal.tiltInvert ? -tilt : tilt) + cal.tiltOffset;
        const pan16 = Math.round(Math.min(1, Math.max(0, pan / p.panRange)) * 65535);
        const tilt16 = Math.round(Math.min(1, Math.max(0, (tilt + p.tiltRange / 2) / p.tiltRange)) * 65535);
        values.pan = pan16 >> 8; values.pan_fine = pan16 & 255;
        values.tilt = tilt16 >> 8; values.tilt_fine = tilt16 & 255;
        values.shutter = values.dimmer > 0 ? p.shutter.open : p.shutter.closed;
        values.wheel = p.wheel.find(w => w.name === st.wheel)?.dmx ?? 0;
        const gobo = st.gobo ? p.gobos[st.gobo] : undefined;
        values.gobo = gobo?.dmx ?? p.gobos.open?.dmx ?? 0;
      }
      p.channels.forEach((c, i) => {
        frame[fx.address - 1 + i] = c.kind === 'fixed' ? c.value : (values[c.attr] ?? 0);
      });
    }
    return frame;
  }

  /** Final look of every fixture once all fades finish (for tools and tests). */
  settled(): Record<string, { level: number; color: RGB; wheel?: string; pan: number; tilt: number; gobo?: string; effect?: string }> {
    const out: any = {};
    for (const fx of Object.values(this.show.fixtures)) {
      const st = this.states[fx.name];
      out[fx.name] = {
        level: st.level.to, color: st.rgb.map(r => r.to) as RGB,
        ...(fx.profile.type === 'spot' ? { wheel: st.wheelTarget, pan: st.pan.to, tilt: st.tilt.to, gobo: st.gobo, effect: st.effects.filter(e => e.weight.to > 0).map(e => e.spec.type).join(',') || undefined } : {}),
      };
    }
    return out;
  }

  private changed() { this.onChange?.(this.status()); }
}

/** Position offset in degrees [pan, tilt] for an effect at time `now`. */
export function effectOffset(e: EffectSpec, now: number, idx: number, n: number): [number, number] {
  const phase = ((now / e.period) + (e.spread * idx) / n) % 1;
  const a = phase * 2 * Math.PI;
  switch (e.shape) {
    case 'sine_pan': return [e.pan * Math.sin(a), e.tilt * Math.sin(a)];
    case 'sine_tilt': return [e.pan * Math.sin(a), e.tilt * Math.sin(a)];
    case 'circle': return [e.pan * Math.cos(a), e.tilt * Math.sin(a)];
    case 'figure8': return [e.pan * Math.sin(a), e.tilt * Math.sin(2 * a)];
    case 'triangle': {
      const v = [[0, 1], [-0.866, -0.5], [0.866, -0.5], [0, 1]];
      const s = phase * 3, i = Math.floor(s), f = s - i;
      const x = v[i][0] + (v[i + 1][0] - v[i][0]) * f, y = v[i][1] + (v[i + 1][1] - v[i][1]) * f;
      return [e.pan * x, e.tilt * y];
    }
    case 'random_walk': {
      const step = Math.floor(now / e.period) + idx * 7919;
      const f = (now / e.period) % 1;
      const r = (k: number, s: number) => { const x = Math.sin(k * 12.9898 + s * 78.233) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
      const ease = (1 - Math.cos(f * Math.PI)) / 2;
      return [e.pan * (r(step, 1) + (r(step + 1, 1) - r(step, 1)) * ease), e.tilt * (r(step, 2) + (r(step + 1, 2) - r(step, 2)) * ease)];
    }
    default: return [0, 0];
  }
}
