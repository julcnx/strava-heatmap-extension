import test from 'node:test';
import assert from 'node:assert/strict';
import {
  project,
  unproject,
  metersPerPixel,
  lineBounds,
  createHeatmapRaster,
  slideLine,
  sampleDensity,
} from '../src/clients/common/slide.js';
import { readTile, readLine, pointDistance, sampleLine } from './fixtures.js';

const tiles = ['15_25844_16255.png', '15_25845_16255.png', '14_12922_8127.png'].map(
  (name) => readTile(name)
);
const input = readLine('lineInput.osc');
const optimal = readLine('optimalOutputAfterSlide.osc');
const bounds = lineBounds(input, 15, 18);

test('Web Mercator round trips at both fixture zoom levels', () => {
  for (const zoom of [14, 15]) {
    const loc = [103.943456, 1.413753];
    const result = unproject(project(loc, zoom), zoom);
    assert.ok(Math.abs(result[0] - loc[0]) < 1e-10);
    assert.ok(Math.abs(result[1] - loc[1]) < 1e-10);
  }
});

test('supplied line follows the density ridge and preserves ordered vertices', async (t) => {
  const raster = createHeatmapRaster(tiles, 15, bounds);
  const result = await slideLine(input, raster, { yield: async () => {} });
  assert.deepEqual(result[0].loc, input[0]);
  assert.deepEqual(result.at(-1).loc, input.at(-1));
  assert.deepEqual(
    result.filter((p) => p.nodeIndex !== null).map((p) => p.nodeIndex),
    input.map((_, i) => i)
  );
  assert.ok(result.length > input.length, 'insert vertices on curves');
  const actual = result.map((p) => project(p.loc));
  const expected = optimal.map((p) => project(p));
  const scale = metersPerPixel(input[0][1]);
  const errors = [
    ...sampleLine(actual).map((p) => pointDistance(p, expected)),
    ...sampleLine(expected).map((p) => pointDistance(p, actual)),
  ]
    .map((d) => d * scale)
    .sort((a, b) => a - b);
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  const p95 = errors[Math.floor(errors.length * 0.95)];
  t.diagnostic(
    `Symmetric reference distance: mean ${mean.toFixed(2)} m, p95 ${p95.toFixed(2)} m; ${result.length} output nodes`
  );
  assert.ok(mean < 2, `mean deviation ${mean} m`);
  assert.ok(p95 < 5, `p95 deviation ${p95} m`);
  const heat = sampleLine(actual).map((p) => sampleDensity(raster, p));
  assert.ok(heat.reduce((a, b) => a + b, 0) / heat.length > 0.7, 'stay on bright heat');
});

test('highest-resolution pixels win independent of tile order', () => {
  const fine = createHeatmapRaster(tiles.slice(0, 2), 15, bounds);
  const mixed = createHeatmapRaster(tiles.slice().reverse(), 15, bounds);
  assert.deepEqual(mixed.density, fine.density);
  assert.deepEqual(mixed.coverage, fine.coverage);
});

test('zoom 14 parent provides real-scale fallback, not a misplaced zoom 15 tile', async () => {
  const raster = createHeatmapRaster([tiles[2]], 15, bounds);
  const result = await slideLine(input, raster, { yield: async () => {} });
  assert.ok(result.length > input.length);
  assert.deepEqual(result[0].loc, input[0]);
  assert.deepEqual(result.at(-1).loc, input.at(-1));
});

test('protected interior nodes remain exactly fixed', async () => {
  const result = await slideLine(input, createHeatmapRaster(tiles, 15, bounds), {
    fixedIndices: [1, 4],
    yield: async () => {},
  });
  for (const i of [1, 4])
    assert.deepEqual(result.find((p) => p.nodeIndex === i).loc, input[i]);
});

test('cancelled, empty and invalid inputs cannot produce an edit', async () => {
  const raster = createHeatmapRaster(tiles, 15, bounds);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(slideLine(input, raster, { signal: controller.signal }), {
    name: 'AbortError',
  });
  await assert.rejects(
    slideLine(
      [
        [NaN, 1],
        [1, 1],
      ],
      raster
    ),
    /valid line/
  );
  const empty = { ...raster, density: new Float32Array(raster.density.length) };
  await assert.rejects(slideLine(input, empty), /No usable heatmap/);
  assert.throws(() => createHeatmapRaster([]), /No heatmap tiles/);
});

test('a synthetic hairpin follows the valley instead of cutting across the bend', async () => {
  const width = 100,
    height = 100,
    density = new Float32Array(width * height);
  // U-shaped ridge: x=30/60 joined by the semicircle below y=60.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const distance =
        y <= 60
          ? Math.min(Math.abs(x - 30), Math.abs(x - 60))
          : Math.abs(Math.hypot(x - 45, y - 60) - 15);
      density[y * width + x] = Math.exp((-distance * distance) / 2);
    }
  }
  const p = project([103.943, 1.414]);
  const raster = {
    width,
    height,
    x: Math.floor(p[0]),
    y: Math.floor(p[1]),
    zoom: 15,
    density,
    coverage: new Uint8Array(width * height).fill(1),
  };
  const locations = [
    [30, 20],
    [31, 61],
    [60, 61],
    [60, 20],
  ].map(([x, y]) => unproject([raster.x + x, raster.y + y]));
  const result = await slideLine(locations, raster, {
    searchRadiusMeters: 48,
    snapRadiusMeters: 10,
    yield: async () => {},
  });
  const points = result.map((point) => project(point.loc));
  assert.ok(
    Math.max(...points.map((point) => point[1] - raster.y)) >= 73,
    'trace bottom of U'
  );
  const samples = sampleLine(points);
  assert.ok(
    samples.every((point) => sampleDensity(raster, point) > 0.4),
    'no chord through dark interior'
  );
});
