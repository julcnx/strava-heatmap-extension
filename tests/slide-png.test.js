import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { decodeHeatmapPNG } from '../src/clients/common/slide-png.js';
import {
  createHeatmapRaster,
  lineBounds,
  metersPerPixel,
  project,
  slideLine,
} from '../src/clients/common/slide.js';
import { readTile, readLine, pointDistance, sampleLine } from './fixtures.js';
import { grayPalette, recolorGrayPNG, crc32 } from './gray-palette.js';

const names = ['15_25844_16255.png', '15_25845_16255.png', '14_12922_8127.png'];
const input = readLine('lineInput.osc');
const expected = readLine('optimalOutputAfterSlide.osc').map((point) => project(point));
const bounds = lineBounds(input, 15, 24);
const bytes = (name) => readFileSync(new URL(`../temp/${name}`, import.meta.url));

function deviation(locations) {
  const points = locations.map((point) => project(point));
  const distances = [
    ...sampleLine(points).map((p) => pointDistance(p, expected)),
    ...sampleLine(expected).map((p) => pointDistance(p, points)),
  ]
    .map((d) => d * metersPerPixel(input[0][1]))
    .sort((a, b) => a - b);
  return {
    mean: distances.reduce((a, b) => a + b, 0) / distances.length,
    p95: distances[Math.floor(distances.length * 0.95)],
  };
}

test('production PNG decoder matches independent zlib-decoded fixture indices', async () => {
  for (const name of [...names, '15_25831_16258.png']) {
    const decoded = await decodeHeatmapPNG(bytes(name));
    const fixture = readTile(name);
    assert.equal(decoded.width, fixture.width);
    assert.equal(decoded.height, fixture.height);
    assert.deepEqual(decoded.density, fixture.density);
  }
});

test('real gray palette reproduces brightness-based failure, but indexed decoding is palette-independent', async (t) => {
  assert.equal(grayPalette.length, 768);
  const hot = [],
    gray = [],
    wrong = [];
  for (const name of names) {
    const recolored = recolorGrayPNG(bytes(name));
    const metadata = readTile(name);
    hot.push({ ...metadata, ...(await decodeHeatmapPNG(bytes(name))) });
    gray.push({ ...metadata, ...(await decodeHeatmapPNG(recolored)) });
    wrong.push({ ...readTile(name, recolored), density: undefined });
  }
  const options = { yield: async () => {} };
  const hotResult = await slideLine(input, createHeatmapRaster(hot, 15, bounds), options);
  const grayResult = await slideLine(
    input,
    createHeatmapRaster(gray, 15, bounds),
    options
  );
  assert.deepEqual(
    grayResult,
    hotResult,
    'changing display palette must not change geometry'
  );
  const badResult = await slideLine(
    input,
    createHeatmapRaster(wrong, 15, bounds),
    options
  );
  const bad = deviation(badResult.map((p) => p.loc));
  const good = deviation(grayResult.map((p) => p.loc));
  t.diagnostic(
    `Gray brightness regression: ${bad.mean.toFixed(2)} m mean before, ${good.mean.toFixed(2)} m after index decoding`
  );
  assert.ok(
    bad.mean > 8,
    'old brightness interpretation reproduces the reported quality problem'
  );
  assert.ok(
    good.mean < 2 && good.p95 < 5,
    'gray palette now follows the reference ridge'
  );
});

test('reported current output is off-ridge; its retained guide nodes can recover the reference', async (t) => {
  const current = readLine('currentOutput.osc');
  const before = deviation(current);
  // -155..-164 are the ten original nodes retained by the reported operation,
  // not an exact reconstruction of their pre-Slide coordinates.
  const guides = readLine('currentOutput.osc', (id) => Number(id) >= -164);
  assert.equal(guides.length, 10);
  const tiles = names.map((name) => readTile(name));
  const result = await slideLine(
    guides,
    createHeatmapRaster(tiles, 15, lineBounds(guides, 15, 24)),
    {
      yield: async () => {},
    }
  );
  const after = deviation(result.map((p) => p.loc));
  t.diagnostic(
    `Reported output: ${before.mean.toFixed(2)} m mean / ${before.p95.toFixed(2)} m p95; recovered guides: ${after.mean.toFixed(2)} m / ${after.p95.toFixed(2)} m`
  );
  assert.ok(before.mean > 8);
  assert.ok(after.mean < 2 && after.p95 < 5);
  assert.deepEqual(result[0].loc, guides[0]);
  assert.deepEqual(result.at(-1).loc, guides.at(-1));
});

test('nearby rough lines stay on the reference, not just the exact original fixture', async () => {
  const tiles = names.map((name) => readTile(name));
  for (let trial = 1; trial <= 6; trial++) {
    const perturbed = input.map((loc, i) =>
      i === 0 || i === input.length - 1
        ? loc
        : [
            loc[0] + Math.sin(trial * (i + 1)) * 0.000045,
            loc[1] + Math.cos(trial * (i + 1)) * 0.000045,
          ]
    );
    const result = await slideLine(
      perturbed,
      createHeatmapRaster(tiles, 15, lineBounds(perturbed, 15, 24)),
      {
        yield: async () => {},
      }
    );
    const error = deviation(result.map((p) => p.loc));
    assert.ok(
      error.mean < 2 && error.p95 < 5,
      `perturbed input ${trial} remains accurate`
    );
  }
});

function chunk(type, bytes) {
  const name = Buffer.from(type),
    data = Buffer.concat([name, bytes]);
  const header = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  crc.writeUInt32BE(crc32(data));
  return Buffer.concat([header, data, crc]);
}

function testPNG(raw, { palette = grayPalette, alpha, width = 3, height = 5 } = {}) {
  alpha ||= Uint8Array.from({ length: 256 }, (_, i) => i);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 3;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('PLTE', Buffer.from(palette)),
    chunk('tRNS', Buffer.from(alpha)),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('indexed PNG decoding handles all five PNG row filters', async () => {
  const indices = Uint8Array.from([
    0, 64, 255, 32, 128, 192, 16, 220, 8, 255, 100, 16, 128, 192, 240,
  ]);
  const raw = new Uint8Array(20);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    return Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
      ? a
      : Math.abs(p - b) <= Math.abs(p - c)
        ? b
        : c;
  };
  for (let y = 0; y < 5; y++) {
    raw[y * 4] = y;
    for (let x = 0; x < 3; x++) {
      const i = y * 3 + x;
      const a = x ? indices[i - 1] : 0,
        b = y ? indices[i - 3] : 0,
        c = x && y ? indices[i - 4] : 0;
      raw[y * 4 + x + 1] =
        (indices[i] - [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][y]) & 255;
    }
  }
  const decoded = await decodeHeatmapPNG(testPNG(raw));
  assert.deepEqual(
    decoded.density,
    Float32Array.from(indices, (value) => value / 255)
  );
});

test('unsupported/corrupt PNGs and cancellation fail safely instead of falling back to brightness', async () => {
  await assert.rejects(decodeHeatmapPNG(new Uint8Array(100)), /not a PNG/);
  await assert.rejects(decodeHeatmapPNG(bytes(names[0]).subarray(0, 50)), /Truncated/);
  const alpha = Uint8Array.from({ length: 256 }, (_, i) => i);
  alpha[100] = 0;
  await assert.rejects(
    decodeHeatmapPNG(testPNG(new Uint8Array(20), { alpha })),
    /density encoding/
  );
  await assert.rejects(decodeHeatmapPNG(testPNG(new Uint8Array(19))), /incomplete/);
  await assert.rejects(decodeHeatmapPNG(testPNG(new Uint8Array(21))), /too many/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(decodeHeatmapPNG(bytes(names[0]), controller.signal), {
    name: 'AbortError',
  });
});
