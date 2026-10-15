// Slide's line fitting (src/clients/www.openstreetmap.org/slide/algorithm.js),
// on synthetic heatmap tiles. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHeatmapRaster,
  project,
  slideLine,
} from '../src/clients/www.openstreetmap.org/slide/algorithm.js';

// Metres east/north of a point in southern Spain (Example 3 of #43) as [lon, lat].
const lat0 = 36.7615,
  lon0 = -4.4044;
const east = 111319.49 * Math.cos((lat0 * Math.PI) / 180),
  north = 110574;
const at = ([e, n]) => [lon0 + e / east, lat0 + n / north];
const metres = (loc) => [(loc[0] - lon0) * east, (loc[1] - lat0) * north];

// Heatmap tiles of a 5 m wide trail along `centre` (metres), at zoom 15.
function trailTiles(centre) {
  const pixels = centre.map((p) => project(at(p), 15));
  const tiles = [];
  const range = (k) => [
    Math.floor((Math.min(...pixels.map((p) => p[k])) - 80) / 512),
    Math.floor((Math.max(...pixels.map((p) => p[k])) + 80) / 512),
  ];
  const [x0, x1] = range(0),
    [y0, y1] = range(1);
  const sigma = 2.5 / (2.39 * Math.cos((lat0 * Math.PI) / 180));
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const density = new Float32Array(512 * 512);
      for (let y = 0; y < 512; y++) {
        for (let x = 0; x < 512; x++) {
          let d = Infinity;
          for (const p of pixels)
            d = Math.min(d, (p[0] - tx * 512 - x) ** 2 + (p[1] - ty * 512 - y) ** 2);
          density[y * 512 + x] = Math.min(1, 1.3 * Math.exp(-d / (2 * sigma ** 2)));
        }
      }
      tiles.push({ z: 15, x: tx, y: ty, width: 512, height: 512, density });
    }
  }
  return tiles;
}

test('a tight bend keeps enough points to follow the trail', async () => {
  // West along y = 0, a 113° left turn of radius 6 m, then 150 m south-east.
  const radius = 6,
    turn = (113 * Math.PI) / 180;
  const centre = [];
  for (let x = 150; x >= 0; x -= 0.5) centre.push([x, 0]);
  for (let a = 0; a <= turn; a += 0.01)
    centre.push([-radius * Math.sin(a), -radius + radius * Math.cos(a)]);
  const end = centre[centre.length - 1],
    heading = Math.PI + turn;
  const along = (s) => [end[0] + s * Math.cos(heading), end[1] + s * Math.sin(heading)];
  for (let s = 0; s <= 150; s += 0.5) centre.push(along(s));
  // A rough line 3 m off the trail, with two points at the bend.
  const rough = [[150, 0], [60, 3], [12, 3], [-6, -2], [-6, -12], along(60), along(140)];
  const raster = createHeatmapRaster(trailTiles(centre), 15);
  const result = await slideLine(rough.map(at), raster, {
    fixedIndices: [0, rough.length - 1],
    yield: async () => {},
  });
  const line = result.map((point) => metres(point.loc));
  const offTrail = (p) =>
    Math.min(...centre.map((c) => Math.hypot(c[0] - p[0], c[1] - p[1])));
  let worst = 0;
  for (let i = 1; i < line.length; i++) {
    for (let t = 0; t <= 1; t += 0.05) {
      const [a, b] = [line[i - 1], line[i]];
      worst = Math.max(
        worst,
        offTrail([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
      );
    }
  }
  // About one heatmap pixel (1.9 m here); cutting the bend gave 3.8 m.
  assert.ok(worst < 3, `line runs ${worst.toFixed(1)} m off the trail`);
});
