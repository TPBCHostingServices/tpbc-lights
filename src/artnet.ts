// Art-Net 4 ArtDmx sender (one universe). The Chauvet DMX-AN accepts Art-Net 3/4 ArtDmx.

import { createSocket, type Socket } from 'node:dgram';

export function artDmxPacket(universe: number, sequence: number, data: Uint8Array): Buffer {
  const len = 512;
  const buf = Buffer.alloc(18 + len);
  buf.write('Art-Net\0', 0, 'ascii');
  buf.writeUInt16LE(0x5000, 8);          // OpCode ArtDmx
  buf.writeUInt16BE(14, 10);             // protocol version 14
  buf.writeUInt8(sequence & 0xff, 12);   // sequence (1-255, 0 = disabled)
  buf.writeUInt8(0, 13);                 // physical
  buf.writeUInt16LE(universe & 0x7fff, 14); // SubUni (low byte) + Net (high byte)
  buf.writeUInt16BE(len, 16);
  Buffer.from(data.buffer, data.byteOffset, Math.min(len, data.length)).copy(buf, 18);
  return buf;
}

export class ArtNetSender {
  host: string; port: number; universe: number;
  private sock: Socket;
  private seq = 0;
  constructor(host: string, port = 6454, universe = 0) {
    this.host = host; this.port = port; this.universe = universe;
    this.sock = createSocket('udp4');
    this.sock.on('error', e => console.error(`[artnet] ${e.message}`));
  }
  send(frame: Uint8Array) {
    this.seq = this.seq >= 255 ? 1 : this.seq + 1;
    this.sock.send(artDmxPacket(this.universe, this.seq, frame), this.port, this.host);
  }
  close() { this.sock.close(); }
}

export function parseArtDmx(buf: Buffer): { universe: number; data: Uint8Array } | null {
  if (buf.length < 18 || buf.toString('ascii', 0, 8) !== 'Art-Net\0' || buf.readUInt16LE(8) !== 0x5000) return null;
  const len = buf.readUInt16BE(16);
  return { universe: buf.readUInt16LE(14), data: new Uint8Array(buf.subarray(18, 18 + len)) };
}
