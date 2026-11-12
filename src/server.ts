// TPBC Lights service: OSC in on 21600 (same as Lightkey), Art-Net out, HTTP API on 8080.
// Run with `npm start` (or the systemd unit in deploy/).

import { createSocket } from 'node:dgram';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadShow, type Problem } from './show.ts';
import { Engine, type Status } from './engine.ts';
import { decodeOsc } from './osc.ts';
import { ArtNetSender } from './artnet.ts';
import { loadConfig, lockedNow } from './config.ts';

const root = process.env.TPBC_LIGHTS_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(root);
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const first = loadShow(root);
const errors = first.problems.filter(p => p.level === 'error');
if (errors.length) {
  for (const e of errors) console.error(`ERROR ${e.file}: ${e.message}`);
  console.error('Show has errors; not starting. Run `npm run check`.');
  process.exit(1);
}
const engine = new Engine(first.show, { zeroFadeMeansDefault: cfg.zero_fade_means_default, log });
log(`loaded ${Object.keys(first.show.cues).length} cues, ${Object.keys(first.show.fixtures).length} fixtures`);

const recent: { at: string; from: string; address: string; result: string }[] = [];
const unmatched = new Map<string, number>();
const remember = (from: string, address: string, ok: boolean, message: string) => {
  recent.unshift({ at: new Date().toISOString(), from, address, result: message });
  recent.length = Math.min(recent.length, 100);
  if (!ok) unmatched.set(address, (unmatched.get(address) ?? 0) + 1);
};

// ---------- OSC in ----------
const osc = createSocket('udp4');
osc.on('message', (buf, rinfo) => {
  let msgs;
  try { msgs = decodeOsc(buf); } catch (e) { log(`bad OSC from ${rinfo.address}: ${(e as Error).message}`); return; }
  for (const m of msgs) {
    const r = engine.handleOsc(m.address, m.args);
    remember(rinfo.address, m.address, r.ok, r.message);
    log(`${r.ok ? 'OSC' : 'OSC UNMATCHED'} ${rinfo.address} ${m.address} ${JSON.stringify(m.args)} -> ${r.message}`);
  }
});
osc.bind(cfg.osc.port, () => log(`OSC listening on udp ${cfg.osc.port}`));

// ---------- Art-Net out ----------
const artnet = new ArtNetSender(cfg.artnet.node, cfg.artnet.port, cfg.artnet.universe);
let outputEnabled = cfg.artnet.enabled;
let lastFrame: Uint8Array = new Uint8Array(512);
setInterval(() => {
  lastFrame = engine.render();
  if (outputEnabled) artnet.send(lastFrame);
}, Math.round(1000 / cfg.artnet.fps));
log(`Art-Net ${outputEnabled ? 'ON' : 'OFF (shadow mode)'} -> ${cfg.artnet.node} universe ${cfg.artnet.universe}`);

// ---------- Companion feedback ----------
let lastSent: Partial<Record<'cue' | 'look' | 'master', string>> = {};
engine.onChange = (s: Status) => {
  const fb = cfg.companion_feedback;
  if (!fb.enabled) return;
  const page = s.selectedPage;
  const vals = { cue: (page && s.currentSong[page]) || '', look: s.look ?? '', master: String(s.master) };
  for (const k of ['cue', 'look', 'master'] as const) {
    if (lastSent[k] === vals[k]) continue;
    lastSent[k] = vals[k];
    const url = `${fb.url}/api/custom-variable/${encodeURIComponent(fb.variables[k])}/value?value=${encodeURIComponent(vals[k])}`;
    fetch(url, { method: 'POST' }).catch(e => log(`companion feedback failed: ${e.message}`));
  }
};

// ---------- HTTP API ----------
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
};
const readBody = (req: IncomingMessage) => new Promise<any>(resolve => {
  let d = '';
  req.on('data', c => (d += c));
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
});

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/status')) {
      return json(res, 200, { ...engine.status(), output: outputEnabled ? 'on' : 'shadow', locked: lockedNow(cfg), recent: recent.slice(0, 20), unmatched: Object.fromEntries(unmatched) });
    }
    if (req.method === 'GET' && url.pathname === '/api/cues') {
      return json(res, 200, Object.values(engine.show.cues).map(c => ({ id: c.id, address: `/live/${c.id}/activate`, file: c.file, fade: c.fade })));
    }
    if (req.method === 'GET' && url.pathname === '/api/dmx') return json(res, 200, Array.from(lastFrame));
    if (req.method === 'GET' && url.pathname === '/api/look') return json(res, 200, engine.settled());
    if (req.method === 'POST' && url.pathname === '/api/fire') {
      const b = await readBody(req);
      const r = engine.handleOsc(String(b.address ?? ''), Array.isArray(b.args) ? b.args : []);
      remember('http', String(b.address), r.ok, r.message);
      return json(res, r.ok ? 200 : 404, r);
    }
    if (req.method === 'POST' && url.pathname === '/api/output') {
      const b = await readBody(req);
      outputEnabled = !!b.enabled;
      log(`Art-Net output ${outputEnabled ? 'ON' : 'OFF'} (via API)`);
      return json(res, 200, { output: outputEnabled ? 'on' : 'shadow' });
    }
    if (req.method === 'POST' && url.pathname === '/api/reload') {
      const lock = lockedNow(cfg);
      if (lock && url.searchParams.get('force') !== '1') return json(res, 423, { ok: false, message: `service lock (${lock}); add ?force=1 to override` });
      const r = loadShow(root);
      const errs = r.problems.filter((p: Problem) => p.level === 'error');
      if (errs.length) return json(res, 400, { ok: false, message: 'show has errors; still running the old one', errors: errs });
      engine.reload(r.show);
      log(`reloaded show (${Object.keys(r.show.cues).length} cues)${lock ? ' [forced during service lock]' : ''}`);
      return json(res, 200, { ok: true, cues: Object.keys(r.show.cues).length, warnings: r.problems.length });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
}).listen(cfg.http.port, () => log(`HTTP API on http://0.0.0.0:${cfg.http.port}`));

process.on('SIGTERM', () => { log('stopping'); process.exit(0); });
