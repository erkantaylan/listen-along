'use strict';

// A tiny WebSocket server (RFC 6455 subset: unfragmented text frames, ping,
// close) for testing `la worker` against a stub of the server's worker hub
// without any dependency. Not a test file itself.

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

/** One server-side connection. */
class StubSocket {
  constructor(socket, path) {
    this.socket = socket;
    this.path = path;
    this.buf = Buffer.alloc(0);
    this.handlers = { message: [], close: [] };
    this.closed = false;
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.emitClose(1006));
    socket.on('error', () => {});
  }

  on(ev, fn) { this.handlers[ev].push(fn); return this; }

  emitClose(code) {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.handlers.close) fn(code);
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const maskOff = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (masked) {
        const mask = this.buf.subarray(maskOff, maskOff + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      this.buf = this.buf.subarray(off + len);
      if (opcode === 1) {
        let msg;
        try { msg = JSON.parse(payload.toString('utf8')); } catch { msg = payload.toString('utf8'); }
        for (const fn of this.handlers.message) fn(msg);
      } else if (opcode === 8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (!this.closed) { try { this.socket.write(frame(8, payload.subarray(0, 2))); } catch {} }
        this.socket.end();
        this.emitClose(code);
      } else if (opcode === 9) {
        this.socket.write(frame(10, payload));
      }
    }
  }

  send(obj) {
    if (this.closed) return;
    this.socket.write(frame(1, JSON.stringify(obj)));
  }

  /** Clean close with a code (the client sees it in its close event). */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const p = Buffer.alloc(2 + Buffer.byteLength(reason));
    p.writeUInt16BE(code, 0);
    p.write(reason, 2);
    this.socket.write(frame(8, p));
    setTimeout(() => this.socket.end(), 20);
    this.emitClose(code);
  }

  /** Drop the TCP connection without a close frame (a network failure). */
  terminate() {
    this.socket.destroy();
    this.emitClose(1006);
  }
}

/** Attach to an http.Server: every upgrade on `path` -> onConnection(StubSocket). */
function attachWsStub(server, path, onConnection) {
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== path) { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'));
    onConnection(new StubSocket(socket, url.pathname));
  });
}

module.exports = { attachWsStub };
