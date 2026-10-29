'use strict';

// Exercises the real ffmpeg/ffprobe commands on a generated tone. Skipped
// when ffmpeg is not installed. No network access.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { Media } = require('../src/media');
const { tmpDir } = require('./helpers');

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
