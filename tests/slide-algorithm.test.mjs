// Slide's line fitting (src/clients/www.openstreetmap.org/slide/algorithm.js),
// on synthetic heatmap tiles. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHeatmapRaster,
  project,
  slideLine,
  slideLineTwice,
} from '../src/clients/www.openstreetmap.org/slide/algorithm.js';

// Metres east/north of a point in southern Spain (Example 3 of #43) as [lon, lat].
const lat0 = 36.7615,
  lon0 = -4.4044;
const east = 111319.49 * Math.cos((lat0 * Math.PI) / 180),
  north = 110574;
const at = ([e, n]) => [lon0 + e / east, lat0 + n / north];
const metres = (loc) => [(loc[0] - lon0) * east, (loc[1] - lat0) * north];

// Heatmap tiles of 5 m wide trails at zoom 15. Each trail is a `centre` line
// (metres) with a `peak` heat (1.3 saturates its core).
function trailTiles(trails) {
  const pixels = trails.flatMap(({ centre }) => centre.map((p) => project(at(p), 15)));
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
          for (const { centre, peak } of trails) {
            let d = Infinity;
            for (const p of centre.map((c) => project(at(c), 15)))
              d = Math.min(d, (p[0] - tx * 512 - x) ** 2 + (p[1] - ty * 512 - y) ** 2);
            density[y * 512 + x] = Math.max(
              density[y * 512 + x],
              Math.min(1, peak * Math.exp(-d / (2 * sigma ** 2)))
            );
          }
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
  const raster = createHeatmapRaster(trailTiles([{ centre, peak: 1.3 }]), 15);
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

test('a stronger trail along another mapped way does not pull the line', async () => {
  // A busy road along x = 0, mapped, and a faint path 14 m west of it (a
  // path within 10 m of a mapped way is left as drawn). The path is drawn
  // roughly, 4 m off its trail towards the road.
  const road = [],
    path = [];
  for (let y = 0; y >= -200; y -= 2) {
    road.push([0, y]);
    path.push([-14, y]);
  }
  const raster = createHeatmapRaster(
    trailTiles([
      { centre: road, peak: 1.3 },
      { centre: path, peak: 0.3 },
    ]),
    15
  );
  const rough = [
    [-14, 0],
    [-10, -60],
    [-10, -140],
    [-14, -200],
  ].map(at);
  const options = { fixedIndices: [0, 3], yield: async () => {} };
  const offPath = async (extra) => {
    const result = await slideLine(rough, raster, { ...options, ...extra });
    return Math.max(...result.map((point) => Math.abs(metres(point.loc)[0] + 14)));
  };
  // Without the map the road's heat is a threat: the line is pulled onto it,
  // or not slid at all.
  const unmapped = await offPath({}).catch(() => Infinity);
  assert.ok(unmapped > 6);
  const mapped = { otherWays: [[at([0, 50]), at([0, -250])]] };
  const off = await offPath(mapped);
  assert.ok(off < 3, `line runs ${off.toFixed(1)} m off the path`);
});

test("a wide road's bright edge does not pull a path beside it", async () => {
  // A wide, busy road along x = 0 (heat 8 m either side of its centre),
  // mapped, and a faint path 20 m west of it, beyond a darker gap. The path is
  // drawn roughly, halfway to the road's edge (way 450064354).
  const road = [],
    path = [];
  for (let y = 0; y >= -200; y -= 2) {
    for (let x = -8; x <= 8; x += 2) road.push([x, y]);
    path.push([-20, y]);
  }
  const raster = createHeatmapRaster(
    trailTiles([
      { centre: road, peak: 1.3 },
      { centre: path, peak: 0.5 },
    ]),
    15
  );
  const rough = [
    [-20, 0],
    [-15, -60],
    [-15, -140],
    [-20, -200],
  ].map(at);
  const result = await slideLine(rough, raster, {
    fixedIndices: [0, 3],
    otherWays: [[at([0, 50]), at([0, -250])]],
    yield: async () => {},
  });
  const off = Math.max(...result.map((point) => Math.abs(metres(point.loc)[0] + 20)));
  assert.ok(off < 3, `line runs ${off.toFixed(1)} m off the path`);
});

// Open: the contrast normalisation still rates the faint trail against the
// bright one 13 m away (11.6 m off with 12 m, 3.7 m off with 6 m).
test('a line drawn on a faint trail stays on it, next to a bright unmapped one', { todo: true }, async () => {
  // A faint trail along x = 0 and a bright, unmapped trail 13 m west of it.
  // The line is drawn on the faint trail, slightly off (way 450064350).
  const faint = [],
    bright = [];
  for (let y = 0; y >= -200; y -= 2) {
    faint.push([0, y]);
    bright.push([-13, y]);
  }
  const raster = createHeatmapRaster(
    trailTiles([
      { centre: faint, peak: 0.15 },
      { centre: bright, peak: 1.3 },
    ]),
    15
  );
  const rough = [
    [0, 0],
    [-1.5, -50],
    [1.5, -100],
    [-1.5, -150],
    [0, -200],
  ].map(at);
  const result = await slideLine(rough, raster, {
    fixedIndices: [0, 4],
    yield: async () => {},
  });
  const off = Math.max(...result.map((point) => Math.abs(metres(point.loc)[0])));
  assert.ok(off < 3, `line runs ${off.toFixed(1)} m off the faint trail`);
});

test('a path branching off a mapped road still slides from the junction', async () => {
  // The path leaves the road at (0, 0), heads south-west, then runs 14 m west
  // of it.
  const road = [],
    path = [];
  for (let y = 50; y >= -200; y -= 2) road.push([0, y]);
  for (let s = 0; s <= 20; s += 1) path.push([-0.7 * s, -s]);
  for (let y = -22; y >= -200; y -= 2) path.push([-14, y]);
  const raster = createHeatmapRaster(
    trailTiles([
      { centre: road, peak: 1.3 },
      { centre: path, peak: 0.3 },
    ]),
    15
  );
  const rough = [
    [0, 0],
    [-10, -60],
    [-10, -140],
    [-14, -200],
  ].map(at);
  const result = await slideLine(rough, raster, {
    fixedIndices: [0, 3],
    otherWays: [[at([0, 50]), rough[0], at([0, -250])]],
    yield: async () => {},
  });
  const offPath = (p) =>
    Math.min(...path.map((c) => Math.hypot(c[0] - p[0], c[1] - p[1])));
  // Near the junction both trails share heat (action.js trims the overlap);
  // beyond, the line follows its own path.
  assert.equal(result.skipped, 0);
  const off = Math.max(
    ...result
      .map((point) => metres(point.loc))
      .filter((p) => p[1] < -25)
      .map(offPath)
  );
  assert.ok(off < 3, `line runs ${off.toFixed(1)} m off the path`);
});

test('a section never jumps to another heat trace', async () => {
  // A faint path along x = -10, and a stronger unmapped trace 10 m east of
  // its middle. The middle section must not detour onto it.
  const path = [],
    other = [];
  for (let y = 0; y >= -200; y -= 2) path.push([-10, y]);
  for (let y = -40; y >= -160; y -= 2) other.push([0, y]);
  const raster = createHeatmapRaster(
    trailTiles([
      { centre: path, peak: 0.3 },
      { centre: other, peak: 1.3 },
    ]),
    15
  );
  const rough = [
    [-10, 0],
    [-10, -15],
    [-10, -30],
    [-10, -170],
    [-10, -185],
    [-10, -200],
  ].map(at);
  const result = await slideLine(rough, raster, {
    fixedIndices: [0, 5],
    yield: async () => {},
  });
  assert.ok(result.skipped > 0); // the middle is left as drawn
  const off = Math.max(...result.map((point) => Math.abs(metres(point.loc)[0] + 10)));
  assert.ok(off < 3, `line jumps ${off.toFixed(1)} m off the path`);
});

test('free drawn points on a straight trail are dropped', async () => {
  // A straight trail along x = 0, drawn with a point every 20 m, each slightly
  // off. Only the line's ends are needed.
  const centre = [];
  for (let y = 0; y >= -200; y -= 2) centre.push([0, y]);
  const raster = createHeatmapRaster(trailTiles([{ centre, peak: 1 }]), 15);
  const rough = [];
  for (let y = 0; y >= -200; y -= 20) rough.push(at([y % 40 ? 1 : -1, y]));
  const result = await slideLine(rough, raster, {
    fixedIndices: [0, rough.length - 1],
    yield: async () => {},
  });
  assert.ok(result.length < 5, `${result.length} points on a straight trail`);
});

test('a drawn zigzag narrower than the trail is kept as drawn', async () => {
  // A straight trail along x = 0, too coarse to show a tight switchback,
  // drawn as a zigzag of ±2 m with 6 m legs in its middle.
  const centre = [];
  for (let y = 0; y >= -200; y -= 2) centre.push([0, y]);
  const raster = createHeatmapRaster(trailTiles([{ centre, peak: 1 }]), 15);
  const zigzag = [];
  for (let k = 0; k <= 8; k++) zigzag.push([k % 2 ? 2 : -2, -80 - 5 * k]);
  const rough = [[0, 0], ...zigzag, [0, -200]].map(at);
  const result = await slideLine(rough, raster, {
    fixedIndices: [0, rough.length - 1],
    yield: async () => {},
  });
  for (let k = 2; k < zigzag.length - 2; k++) {
    const point = result.find((p) => p.nodeIndex === k + 1);
    assert.ok(point, `zigzag point ${k} dropped`);
    const moved = Math.hypot(...metres(point.loc).map((v, i) => v - zigzag[k][i]));
    assert.ok(moved < 0.5, `zigzag point ${k} moved ${moved.toFixed(1)} m`);
  }
});

test('a turn is smoothed with extra points that stay on the trail', async () => {
  // West along y = 0, then a right-angle turn south at (0, 0), drawn with one
  // corner point.
  const centre = [];
  for (let x = 150; x >= 0; x -= 2) centre.push([x, 0]);
  for (let y = -2; y >= -150; y -= 2) centre.push([0, y]);
  const raster = createHeatmapRaster(trailTiles([{ centre, peak: 1 }]), 15);
  const rough = [
    [150, 0],
    [0, 0],
    [0, -150],
  ].map(at);
  const result = await slideLineTwice(rough, raster, {
    fixedIndices: [0, 2],
    yield: async () => {},
  });
  const near = result.filter((p) => Math.hypot(...metres(p.loc)) < 20);
  assert.ok(near.length >= 3, `${near.length} points within 20 m of the turn`);
  const off = Math.max(
    ...result.map((p) => {
      const [x, y] = metres(p.loc);
      return Math.min(Math.abs(y) + (x < 0 ? -x : 0), Math.abs(x) + (y > 0 ? y : 0));
    })
  );
  assert.ok(off < 4, `line runs ${off.toFixed(1)} m off the trail`);
});

test('a drawn jog across the trail is straightened, not kept as a switchback', async () => {
  // A straight trail along x = 0, drawn 2 m west of it, then one short leg
  // over to 2 m east: two opposite bends joined by a short leg between long
  // ones are a jog of the drawing, not switchbacks.
  const centre = [];
  for (let y = 0; y >= -200; y -= 2) centre.push([0, y]);
  const raster = createHeatmapRaster(trailTiles([{ centre, peak: 1 }]), 15);
  const rough = [
    [0, 0],
    [-2, -60],
    [-2, -100],
    [2, -106],
    [2, -150],
    [0, -200],
  ].map(at);
  const result = await slideLineTwice(rough, raster, {
    fixedIndices: [0, 5],
    yield: async () => {},
  });
  const off = Math.max(...result.map((p) => Math.abs(metres(p.loc)[0])));
  assert.ok(off < 1.5, `line runs ${off.toFixed(1)} m off the trail`);
});

test('sliding a slid line again leaves it unchanged', async () => {
  // A trail curving west then south; a second Slide must not move the first
  // result by the width of a heatmap pixel each time.
  const centre = [];
  for (let a = 0; a <= 90; a += 2) {
    const r = (a * Math.PI) / 180;
    centre.push([100 * Math.cos(r) - 100, -100 * Math.sin(r)]);
  }
  const raster = createHeatmapRaster(trailTiles([{ centre, peak: 1 }]), 15);
  const rough = [
    [0, 0],
    [-8, -45],
    [-35, -88],
    [-100, -100],
  ].map(at);
  const options = { fixedIndices: [0, 3], yield: async () => {} };
  const first = await slideLineTwice(rough, raster, options);
  const second = await slideLineTwice(
    first.map((p) => p.loc),
    raster,
    { ...options, fixedIndices: [0, first.length - 1] }
  );
  assert.deepEqual(
    second.map((p) => p.loc),
    first.map((p) => p.loc)
  );
});
