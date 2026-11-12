// npm run monitor [-- --channels 57-67]
// Listens for Art-Net on udp 6454 and prints channels that change. Use it on a laptop or
// the Pi to see exactly what TPBC Lights (or Lightkey) is sending, without any lights.
import { createSocket } from 'node:dgram';
import { parseArtDmx } from '../src/artnet.ts';

const i = process.argv.indexOf('--channels');
const [lo, hi] = i > 0 ? process.argv[i + 1].split('-').map(Number) : [1, 512];
let last: Uint8Array = new Uint8Array(512);
const s = createSocket({ type: 'udp4', reuseAddr: true });
s.on('message', (buf, r) => {
  const p = parseArtDmx(buf);
  if (!p) return;
  const changes: string[] = [];
  for (let c = lo; c <= Math.min(hi, p.data.length); c++) if (p.data[c - 1] !== last[c - 1]) changes.push(`${c}=${p.data[c - 1]}`);
  if (changes.length) console.log(`${new Date().toISOString().slice(11, 23)} ${r.address} u${p.universe}: ${changes.join(' ')}`);
  last = p.data;
});
s.bind(6454, () => console.log(`listening for Art-Net on 6454, channels ${lo}-${hi}`));
