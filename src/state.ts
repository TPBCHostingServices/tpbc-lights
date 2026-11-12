// Remember the running look across restarts, so a crash or `systemctl restart` during a
// service does not drop the stage to black. Written atomically; ignored when stale.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Snapshot } from './engine.ts';

interface Saved extends Snapshot { savedAt: string }

export function saveState(file: string, snap: Snapshot, now = new Date()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...snap, savedAt: now.toISOString() }));
  renameSync(tmp, file);
}

/** Returns the saved look, or null when there is none, it is unreadable, or it is older than maxAgeMinutes. */
export function loadState(file: string, maxAgeMinutes: number, now = new Date()): Snapshot | null {
  if (maxAgeMinutes <= 0 || !existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as Saved;
    const age = (now.getTime() - new Date(s.savedAt).getTime()) / 60000;
    if (!Array.isArray(s.active) || !(age >= -1 && age <= maxAgeMinutes)) return null;
    return s;
  } catch { return null; }
}
