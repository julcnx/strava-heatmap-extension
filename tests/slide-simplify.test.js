import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHeatmapRaster,
  lineBounds,
  metersPerPixel,
  project,
  sampleDensity,
  slideLine,
  unproject,
} from '../src/clients/common/slide.js';
import { readLine, readTile, pointDistance, sampleLine } from './fixtures.js';

const input = readLine('lineInput1.osc');
const previous = readLine('lineOutput1.osc');
const raster = createHeatmapRaster(
  [readTile('15_25831_16258.png')],
  15,
  lineBounds(input, 15, 20)
);
const scale = metersPerPixel(input[0][1]);
const options = { yield: async () => {} };

function statistics(locations) {
  const points = locations.map((loc) => project(loc));
  const lengths = points
    .slice(1)
    .map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]) * scale);
  const turns = points.slice(1, -1).map((p, i) => {
    const a = points[i],
      b = points[i + 2];
    const u = [p[0] - a[0], p[1] - a[1]],
      v = [b[0] - p[0], b[1] - p[1]];
    return (
      (Math.acos(
        Math.max(
          -1,
          Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v)))
        )
      ) *
        180) /
      Math.PI
    );
  });
  const samples = sampleLine(points);
  return {
    nodes: points.length,
    short: lengths.filter((length) => length < 5).length,
    sharp: turns.filter((angle) => angle > 30).length,
    minimum: Math.min(...lengths),
    heat: samples.reduce((sum, p) => sum + sampleDensity(raster, p), 0) / samples.length,
  };
}

test('new straight-passage example loses raster kinks without losing the trail', async (t) => {
  const result = await slideLine(input, raster, options);
  const before = statistics(previous),
    after = statistics(result.map((p) => p.loc));
  t.diagnostic(
    `Straight-passage cleanup: ${before.nodes} → ${after.nodes} nodes, ${before.short} → ${after.short} segments under 5 m, ${before.sharp} → ${after.sharp} turns over 30°; heat ${before.heat.toFixed(4)} → ${after.heat.toFixed(4)}`
  );
  assert.ok(
    after.nodes < before.nodes * 0.6,
    'substantially reduce unnecessary vertices'
  );
  assert.equal(after.short, 0, 'no clustered inserted nodes in this example');
  assert.ok(after.sharp < before.sharp * 0.3, 'remove short angular stair-steps');
  assert.ok(
    after.heat >= before.heat - 0.01,
    'retain essentially the same density alignment'
  );
  assert.deepEqual(result[0].loc, input[0]);
  assert.deepEqual(result.at(-1).loc, input.at(-1));
  assert.deepEqual(
    result.filter((p) => p.nodeIndex !== null).map((p) => p.nodeIndex),
    input.map((_, i) => i)
  );
});

test('simplification stays within 2 m of the traced path and does not move retained nodes', async () => {
  const dense = await slideLine(input, raster, { ...options, simplifyMeters: 0 });
  const clean = await slideLine(input, raster, options);
  const line = clean.map((p) => project(p.loc));
  const errors = sampleLine(dense.map((p) => project(p.loc))).map(
    (p) => pointDistance(p, line) * scale
  );
  assert.ok(Math.max(...errors) <= 2.00001, 'bound geometric simplification error');
  assert.ok(
    clean.every((p) =>
      dense.some(
        (q) =>
          q.nodeIndex === p.nodeIndex && q.loc[0] === p.loc[0] && q.loc[1] === p.loc[1]
      )
    ),
    'simplify by removal, not by shifting geometry'
  );
});

test('protected interior guide nodes cannot be removed or moved by cleanup', async () => {
  const result = await slideLine(input, raster, { ...options, fixedIndices: [2, 7] });
  for (const i of [0, 2, 7, input.length - 1]) {
    assert.deepEqual(result.find((p) => p.nodeIndex === i).loc, input[i]);
  }
});

test('density-aware Douglas–Peucker keeps a hairpin even with an excessive geometric tolerance', async () => {
  const width = 100,
    height = 100,
    density = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const distance =
        y <= 60
          ? Math.min(Math.abs(x - 30), Math.abs(x - 60))
          : Math.abs(Math.hypot(x - 45, y - 60) - 15);
      density[y * width + x] = Math.exp((-distance * distance) / 2);
    }
  }
  const origin = project(input[0]);
  const hairpin = {
    width,
    height,
    x: Math.floor(origin[0]),
    y: Math.floor(origin[1]),
    zoom: 15,
    density,
    coverage: new Uint8Array(width * height).fill(1),
  };
  const locations = [
    [30, 20],
    [31, 61],
    [60, 61],
    [60, 20],
  ].map(([x, y]) => unproject([hairpin.x + x, hairpin.y + y]));
  const result = await slideLine(locations, hairpin, {
    ...options,
    searchRadiusMeters: 48,
    snapRadiusMeters: 10,
    simplifyMeters: 100,
  });
  const points = result.map((p) => project(p.loc));
  assert.ok(
    Math.max(...points.map((p) => p[1] - hairpin.y)) >= 73,
    'retain the bottom of the U'
  );
  assert.ok(
    sampleLine(points).every((p) => sampleDensity(hairpin, p) > 0.4),
    'never cut the chord through the dark interior'
  );
});

test('invalid simplification settings fail without returning an edit', async () => {
  for (const simplifyMeters of [-1, NaN, Infinity]) {
    await assert.rejects(
      slideLine(input, raster, { ...options, simplifyMeters }),
      /simplification tolerance/
    );
  }
});
