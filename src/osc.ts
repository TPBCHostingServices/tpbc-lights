// Minimal OSC 1.0 codec: enough for FreeShow and Companion (strings, ints, floats,
// bundles). No dependencies.

export interface OscMessage { address: string; args: (number | string | boolean | null)[] }

function readString(buf: Buffer, off: number): [string, number] {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  const s = buf.toString('utf8', off, end);
  return [s, (end + 4) & ~3];
}

export function decodeOsc(buf: Buffer): OscMessage[] {
  if (buf.length >= 8 && buf.toString('ascii', 0, 7) === '#bundle') {
    const out: OscMessage[] = [];
    let off = 16; // "#bundle\0" + 8-byte timetag
    while (off + 4 <= buf.length) {
      const size = buf.readInt32BE(off);
      off += 4;
      if (size <= 0 || off + size > buf.length) break;
      out.push(...decodeOsc(buf.subarray(off, off + size)));
      off += size;
    }
    return out;
  }
  let [address, off] = readString(buf, 0);
  if (!address.startsWith('/')) throw new Error('not an OSC message');
  const args: OscMessage['args'] = [];
  if (off < buf.length && buf[off] === 0x2c) {
    let tags: string;
    [tags, off] = readString(buf, off);
    for (const t of tags.slice(1)) {
      switch (t) {
        case 'i': args.push(buf.readInt32BE(off)); off += 4; break;
        case 'f': args.push(buf.readFloatBE(off)); off += 4; break;
        case 'd': args.push(buf.readDoubleBE(off)); off += 8; break;
        case 'h': args.push(Number(buf.readBigInt64BE(off))); off += 8; break;
        case 's': { let s: string; [s, off] = readString(buf, off); args.push(s); break; }
        case 'T': args.push(true); break;
        case 'F': args.push(false); break;
        case 'N': args.push(null); break;
        default: throw new Error(`unsupported OSC type tag "${t}"`);
      }
    }
  }
  return [{ address, args }];
}

function padString(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  const len = (b.length + 4) & ~3;
  const out = Buffer.alloc(len);
  b.copy(out);
  return out;
}

export function encodeOsc(address: string, args: ({ type: 'i' | 'f'; value: number } | string)[] = []): Buffer {
  let tags = ',';
  const parts: Buffer[] = [];
  for (const a of args) {
    if (typeof a === 'string') { tags += 's'; parts.push(padString(a)); continue; }
    const b = Buffer.alloc(4);
    if (a.type === 'i') b.writeInt32BE(a.value); else b.writeFloatBE(a.value);
    tags += a.type;
    parts.push(b);
  }
  return Buffer.concat([padString(address), padString(tags), ...parts]);
}
