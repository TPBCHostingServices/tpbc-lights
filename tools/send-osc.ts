// npm run send -- <address> [number] [--host 10.1.20.23] [--port 21600]
// Sends one OSC message, like FreeShow or Companion would.
import { createSocket } from 'node:dgram';
import { encodeOsc } from '../src/osc.ts';

const a = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = a.indexOf(n); if (i < 0) return d; const v = a[i + 1]; a.splice(i, 2); return v; };
const host = opt('--host', '127.0.0.1');
const port = Number(opt('--port', '21600'));
const [address, num] = a;
if (!address) { console.log('usage: npm run send -- /live/Youth/Wonder/CHORUS/activate [fade] [--host ip]'); process.exit(1); }
const s = createSocket('udp4');
s.send(encodeOsc(address, num !== undefined ? [{ type: 'f', value: Number(num) }] : []), port, host, () => { console.log(`sent ${address} to ${host}:${port}`); s.close(); });
