import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export interface Config {
  host: string;
  artnet: { enabled: boolean; node: string; port: number; universe: number; fps: number };
  osc: { port: number };
  http: { port: number };
  companion_feedback: { enabled: boolean; url: string; variables: { cue: string; look: string; master: string } };
  zero_fade_means_default: boolean;
  service_lock: { windows: { days: string[]; start: string; end: string }[] };
}

export function loadConfig(root: string): Config {
  const c = parse(readFileSync(join(root, 'config/config.yaml'), 'utf8'));
  return {
    host: c.host,
    artnet: { enabled: process.env.TPBC_ARTNET_ENABLED ? process.env.TPBC_ARTNET_ENABLED === '1' : !!c.artnet?.enabled, node: process.env.TPBC_ARTNET_NODE ?? c.artnet?.node ?? '10.1.20.11', port: c.artnet?.port ?? 6454, universe: c.artnet?.universe ?? 0, fps: c.artnet?.fps ?? 40 },
    osc: { port: c.osc?.port ?? 21600 },
    http: { port: c.http?.port ?? 8080 },
    companion_feedback: c.companion_feedback ?? { enabled: false, url: '', variables: { cue: '', look: '', master: '' } },
    zero_fade_means_default: c.zero_fade_means_default ?? true,
    service_lock: { windows: c.service_lock?.windows ?? [] },
  };
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Returns the matching lock window description, or null when no service is on. */
export function lockedNow(cfg: Config, d = new Date()): string | null {
  const day = DAYS[d.getDay()];
  const mins = d.getHours() * 60 + d.getMinutes();
  for (const w of cfg.service_lock.windows) {
    const [sh, sm] = w.start.split(':').map(Number);
    const [eh, em] = w.end.split(':').map(Number);
    if (w.days.includes(day) && mins >= sh * 60 + sm && mins < eh * 60 + em) return `${day} ${w.start}-${w.end}`;
  }
  return null;
}
