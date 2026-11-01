'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHUNK_SIZE = 64 * 1024;

/** Same escaping FormData applies to names in a multipart header. */
function escapeName(name) {
  return String(name).replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/"/g, '%22');
}

/**
 * multipart/form-data with one file (part "file", first) and text fields, as a
 * stream read from disk 64 KiB at a time, so a large file never sits in
 * memory. Equivalent to FormData on the wire, but it knows how many bytes went
 * out: a chunk counts once the consumer asks for the next one, so with
 * fetch's backpressure the count is "accepted by the socket", which runs ahead
 * of the server by at most the OS send buffer.
 *
 * @param {string} file
 * @param {object} fields - undefined, null and '' are left out
 * @param {object} [opts]
 * @param {string} [opts.type] - the file part's Content-Type
 * @param {(sent: number, total: number) => void} [opts.onProgress] - bytes of the whole body
 * @returns {Promise<{stream: ReadableStream, contentType: string, contentLength: number, close: () => void}>}
 *   close() releases the file; call it when the request is over, because a
 *   server can answer (401, 409) without reading the whole body.
 */
async function fileFormBody(file, fields, { type = 'application/octet-stream', onProgress } = {}) {
  const { size } = await fs.promises.stat(file);
  const boundary = `----la-upload-${crypto.randomBytes(12).toString('hex')}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${escapeName(path.basename(file))}"\r\nContent-Type: ${type}\r\n\r\n`);
  let tailText = '\r\n';
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null || v === '') continue;
    tailText += `--${boundary}\r\nContent-Disposition: form-data; name="${escapeName(k)}"\r\n\r\n${String(v).replace(/\r?\n|\r/g, '\r\n')}\r\n`;
  }
  const tail = Buffer.from(`${tailText}--${boundary}--\r\n`);
  const total = head.length + size + tail.length;

  let sent = 0;
  const count = (n) => {
    sent += n;
    if (onProgress) { try { onProgress(sent, total); } catch { /* progress must not break the upload */ } }
  };

  async function* chunks() {
    yield head;
    count(head.length);
    const fh = await fs.promises.open(file, 'r');
    try {
      let pos = 0;
      while (pos < size) {
        const buf = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) throw new Error(`${file} got shorter during the upload`);
        yield buf.subarray(0, bytesRead);
        pos += bytesRead;
        count(bytesRead);
      }
    } finally {
      await fh.close();
    }
    yield tail;
    count(tail.length);
  }

  const iter = chunks();
  const stream = new ReadableStream({
    async pull(controller) {
      const { value, done } = await iter.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() { await iter.return(); },
  }, { highWaterMark: 0 });

  return {
    stream,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: total,
    close: () => { iter.return().catch(() => {}); },
  };
}

module.exports = { fileFormBody };
