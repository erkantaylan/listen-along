'use strict';

// Exercises the real ffmpeg/ffprobe commands on a generated tone. Skipped
// when ffmpeg is not installed. No network access.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Media } = require('../src/media');
const { tmpDir } = require('./helpers');
const { readMeta } = require('../src/pipeline');

const ffmpeg = process.env.LA_FFMPEG_BIN || 'ffmpeg';
const hasFfmpeg = spawnSync(ffmpeg, ['-version']).status === 0
  && spawnSync(process.env.LA_FFPROBE_BIN || 'ffprobe', ['-version']).status === 0;

test('real ffmpeg: probe tags, convert mp3 -> AAC m4a, embed cover', { skip: !hasFfmpeg && 'ffmpeg/ffprobe not installed' }, async () => {
  const dir = tmpDir('la-ff-');
  const mp3 = path.join(dir, 'tone.mp3');
  const jpg = path.join(dir, 'cover.jpg');
  let p = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-metadata', 'title=Tone', '-metadata', 'artist=Generator', '-metadata', 'album=Tests', mp3]);
  assert.equal(p.status, 0, String(p.stderr));
  p = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', jpg]);
  assert.equal(p.status, 0, String(p.stderr));

  const media = new Media();
  await media.check();
  const src = await media.probe(mp3);
  assert.equal(src.codec, 'mp3');
  assert.equal(src.tags.title, 'Tone');
  assert.equal(src.tags.artist, 'Generator');
  assert.ok(!Media.isAacM4a(src, mp3));

  const out = path.join(dir, 'tone.m4a');
  await media.toM4a(mp3, out);
  const conv = await media.probe(out);
  assert.ok(Media.isAacM4a(conv, out), JSON.stringify(conv));
  assert.equal(conv.tags.title, 'Tone');
  assert.equal(conv.tags.album, 'Tests');
  assert.ok(Math.abs(conv.duration - 2) < 0.2);

  await media.embedCover(out, jpg);
  const withCover = await media.probe(out);
  assert.equal(withCover.hasCover, true);
  assert.equal(withCover.codec, 'aac');
  assert.equal(withCover.tags.artist, 'Generator');

  await assert.rejects(media.probe(jpg), /no audio stream/i);
});

test('real ffmpeg: a `la download`-style m4a yields youtube_id + source_url from its comment tag', { skip: !hasFfmpeg && 'ffmpeg/ffprobe not installed' }, async () => {
  const dir = tmpDir('la-ff-');
  // Same shape as the files yt-dlp --embed-metadata + keep-dir naming produce:
  // comment = webpage_url, name "<Artist> - <Title> [<id>].m4a".
  const file = path.join(dir, '2CELLOS - Misirlou [HOLIDAY VIDEO] [saHMo3zV_iA].m4a');
  const p = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac',
    '-metadata', 'title=Misirlou', '-metadata', 'artist=2CELLOS',
    '-metadata', 'comment=https://www.youtube.com/watch?v=saHMo3zV_iA', file]);
  assert.equal(p.status, 0, String(p.stderr));
  const meta = await readMeta(new Media(), file);
  assert.equal(meta.youtube_id, 'saHMo3zV_iA');
  assert.equal(meta.source_url, 'https://www.youtube.com/watch?v=saHMo3zV_iA');
  assert.equal(meta.title, 'Misirlou');
});

/** md5 of a file's audio packets: equal = the same Opus data, not re-encoded. */
function audioMd5(file) {
  const p = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-']);
  assert.equal(p.status, 0, String(p.stderr));
  return String(p.stdout).trim();
}

test('real ffmpeg: WebM Opus -> Ogg .opus by stream copy, cover embedded as METADATA_BLOCK_PICTURE, tags kept', { skip: !hasFfmpeg && 'ffmpeg/ffprobe not installed' }, async () => {
  const dir = tmpDir('la-ff-');
  const webm = path.join(dir, 'tone.webm');
  const jpg = path.join(dir, 'cover.jpg');
  let p = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libopus', '-b:a', '128k',
    '-metadata', 'title=Tone', '-metadata', 'artist=Generator', '-metadata', 'comment=https://www.youtube.com/watch?v=saHMo3zV_iA', webm]);
  if (p.status !== 0) return; // an ffmpeg without libopus: nothing to test here
  p = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1', jpg]);
  assert.equal(p.status, 0, String(p.stderr));

  const media = new Media();
  const src = await media.probe(webm);
  assert.equal(src.codec, 'opus');
  assert.equal(Media.uploadFormat(src, webm), null);

  const out = path.join(dir, 'tone.opus');
  await media.toOpus(webm, out);
  const ogg = await media.probe(out);
  assert.equal(Media.uploadFormat(ogg, out), 'opus', JSON.stringify(ogg));
  assert.equal(ogg.tags.title, 'Tone');
  assert.equal(ogg.tags.artist, 'Generator');
  assert.equal(audioMd5(out), audioMd5(webm), 'the Opus packets are copied, not re-encoded');

  await media.embedCover(out, jpg);
  const withCover = await media.probe(out);
  assert.equal(withCover.hasCover, true);
  assert.equal(Media.uploadFormat(withCover, out), 'opus');
  assert.equal(withCover.tags.title, 'Tone');
  assert.equal(withCover.tags.artist, 'Generator');
  assert.ok(Math.abs(withCover.duration - 2) < 0.2);
  assert.equal(audioMd5(out), audioMd5(webm), 'still the same Opus packets');
  const meta = await readMeta(media, out);
  assert.equal(meta.youtube_id, 'saHMo3zV_iA', 'from the comment tag, as with m4a');
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.cover.')), 'no temp files left');
});

test('flacPictureBlock reads the JPEG size', () => {
  const { flacPictureBlock, jpegSize, escapeFfmeta } = require('../src/media');
  // Minimal JPEG header: SOI, APP0 (len 16), SOF0 with height 48, width 64.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03, ...Buffer.alloc(9)]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
  assert.deepEqual(jpegSize(jpeg), { width: 64, height: 48 });
  const block = flacPictureBlock(jpeg);
  assert.equal(block.readUInt32BE(0), 3, 'front cover');
  assert.equal(block.subarray(8, 18).toString(), 'image/jpeg');
  assert.equal(block.readUInt32BE(22), 64);
  assert.equal(block.readUInt32BE(26), 48);
  assert.equal(block.readUInt32BE(38), jpeg.length);
  assert.deepEqual(jpegSize(Buffer.from('nope')), { width: 0, height: 0 });
  assert.equal(escapeFfmeta('a=b;c#d\\e\nf'), 'a\\=b\\;c\\#d\\\\e\\\nf');
});
