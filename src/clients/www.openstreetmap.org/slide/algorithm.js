/**
 * Strava Slide – the heatmap-snapping engine.
 *
 * Slide takes a roughly digitised OSM line and refits it onto the trail that
 * people actually recorded on the Strava heatmap. This file is the pure
 * geometry/raster core: it never touches the DOM or the OSM graph, so it can
 * be reused by any editor. The surrounding modules are:
 *
 *   index.js   – wires Slide into the iD editor (menu entry, Shift+S, dialog)
 *   tiles.js   – downloads the heatmap PNG tiles around the line
 *   png.js     – decodes those PNGs into ordered heat "density" values
 *   action.js  – turns the fitted geometry into an undoable iD edit
 *
 * How a line is fitted (see slideLine() at the bottom for the orchestration):
 *   1. Downloaded tiles are merged into one raster – createHeatmapRaster().
 *   2. A locally contrast-normalised copy ("tracking surface") is built so a
 *      faint but coherent trail is as visible as a bright road.
 *   3. Every original vertex is snapped onto the nearest trail point
 *      ("anchor"); fixed vertices (endpoints, junctions) keep their position.
 *   4. Between consecutive anchors, a corridor-constrained shortest path over
 *      the raster grid follows the density ridge – trace().
 *   5. That pixel path is simplified to a few vertices – simplify().
 *
 * Terminology used throughout:
 *   loc     – [longitude, latitude] pair, as used by OSM and iD
 *   point   – fractional [x, y] position in projected pixel space
 *   density – heat strength in 0..1 (1 = hottest Strava level)
 *   raster  – a rectangle of density + coverage samples in pixel space
 *   anchor  – the trail point that one original vertex snapped to
 *   segment – the piece of the line between two consecutive original vertices
 *
 * Why a corridor-constrained shortest path instead of an active contour
 * ("snake")? A contour is pulled by an average of nearby image forces, which
 * straightens it out of narrow hairpins. The grid search here must walk the
 * ridge continuously and cannot skip ahead, so tight switchbacks survive.
 */
import { detectJunctions } from './junctions.js';
const TILE_SIZE = 512;
const EARTH_CIRCUMFERENCE = 40075016.68557849;

// Tuning knobs, all in metres on the ground (converted to pixels where used).
// They are also shared with the tile loader (tiles.js): widening a search is
// only useful when the surrounding imagery has actually been downloaded.
//   searchRadiusMeters     – corridor half-width around the original segment
//   maxSearchRadiusMeters  – the same, when the first attempts find no trail
//   snapRadiusMeters       – how far an original vertex may move to a trail
//   maxSnapRadiusMeters    – the same, with adaptive widening attempts
//   simplifyMeters         – Douglas–Peucker tolerance for the final vertices
//   contrastRadiusMeters   – neighbourhood size of the contrast normalisation
//   minTriangleSquareMeters – inserted vertices forming a smaller triangle with
//                             their neighbours are dropped as noise
//   approachFactor         – a fixed vertex off the trail center joins it over
//                             this many times its offset, instead of a hook
//   avoidMeters            – a section is penalised for running this close to
//                             the path traced by earlier sections (same value
//                             as the duplicate-vertex merge in action.js)
//   otherWayMeters         – heat this close to another mapped road or path
//                             is ignored, fading back in by otherWayFadeMeters
//   otherWayFlankMeters    – further out, up to this distance, heat that keeps
//                             fading away from the other way is ignored too
//   junctionMeters         – except this close to a junction with the line
//   alignMeters            – a vertex already on a trail moves at most this
//                             far, across the line, to centre on it
//   jumpMeters             – a traced section straying sideways from its
//                             drawn segment further than this (or than
//                             JUMP_BULGE of its length) beyond its anchors
//                             jumped to another trace
export const SLIDE_DEFAULTS = Object.freeze({
  searchRadiusMeters: 24,
  maxSearchRadiusMeters: 80,
  snapRadiusMeters: 18,
  maxSnapRadiusMeters: 60,
  simplifyMeters: 2,
  contrastRadiusMeters: 12,
  minTriangleSquareMeters: 10,
  avoidMeters: 4,
  approachFactor: 3,
  otherWayMeters: 5,
  otherWayFadeMeters: 8,
  otherWayFlankMeters: 20,
  junctionMeters: 8,
  jumpMeters: 8,
  alignMeters: 6,
});

// Project [longitude, latitude] into Web-Mercator pixel coordinates at the
// given zoom. This is the shared "unit system" of the module: the raster, the
// path search and the simplification all work in these pixels. Zoom 15 (~2.4 m
// per pixel near the equator) matches the zoom of the downloaded tiles.
export function project(loc, zoom = 15) {
  const size = TILE_SIZE * 2 ** zoom;
  const lat = (Math.max(-85.05112878, Math.min(85.05112878, loc[1])) * Math.PI) / 180;
  return [
    ((loc[0] + 180) / 360) * size,
    ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * size,
  ];
}

// The exact inverse of project(): pixel coordinates back to [longitude,
// latitude]. The latitude is un-projected with atan(sinh(...)), the inverse of
// the Mercator y formula used above.
export function unproject(point, zoom = 15) {
  const size = TILE_SIZE * 2 ** zoom;
  return [
    (point[0] / size) * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * point[1]) / size))) * 180) / Math.PI,
  ];
}

// Ground width of one pixel at a latitude, in metres. Needed to translate the
// metre-based settings ("18 m snap radius") into pixels. It shrinks towards
// the poles because Mercator stretches them.
export function metersPerPixel(latitude, zoom = 15) {
  return (
    (EARTH_CIRCUMFERENCE * Math.cos((latitude * Math.PI) / 180)) / (TILE_SIZE * 2 ** zoom)
  );
}

// Projected bounding box of a line, expanded by `padding` pixels on every
// side. Decides which tiles to download and which area the raster covers.
export function lineBounds(locations, zoom, padding) {
  const points = locations.map((loc) => project(loc, zoom));
  return {
    minX: Math.floor(Math.min(...points.map((p) => p[0])) - padding),
    minY: Math.floor(Math.min(...points.map((p) => p[1])) - padding),
    maxX: Math.ceil(Math.max(...points.map((p) => p[0])) + padding),
    maxY: Math.ceil(Math.max(...points.map((p) => p[1])) + padding),
  };
}

// Smooth the raster slightly (small separable Gaussian: horizontally, then
// vertically). Raster stair-steps and single-pixel noise would otherwise
// dominate the per-cell cost, while tight turns and neighbouring paths must
// stay distinguishable – hence the narrow 5-tap kernel.
function blur(data, width, height) {
  const kernel = [0.0545, 0.2442, 0.4026, 0.2442, 0.0545];
  const temp = new Float32Array(data.length);
  const output = new Float32Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let k = -2; k <= 2; k++) {
        temp[y * width + x] +=
          data[y * width + Math.max(0, Math.min(width - 1, x + k))] * kernel[k + 2];
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let k = -2; k <= 2; k++) {
        output[y * width + x] +=
          temp[Math.max(0, Math.min(height - 1, y + k)) * width + x] * kernel[k + 2];
      }
    }
  }
  return output;
}

// Merge decoded tiles into a single raster covering `bounds`.
//
// Each tile carries its own zoom `z` and tile indices `x`/`y`; tiles may
// therefore differ in resolution (when zoom-15 imagery is missing, tiles.js
// falls back to a parent tile that covers four child tiles at half the
// resolution). `scale` below maps such a parent tile into the zoom-15 pixel
// grid. Tiles are processed finest-first and the first tile to cover a pixel
// wins, so the highest available resolution is always sampled.
//
// Two pixel formats are accepted:
//   * tile.density – decoded heat levels 0..1 (from png.js; the normal case)
//   * tile.data    – legacy RGBA pixels, only for palettes whose brightness is
//                    monotonic in heat (e.g. "hot"). Live tiles never use it,
//                    because Strava's display colours are not an ordered scale.
//
// `coverage` records whether a pixel is backed by real imagery at all.
// Uncovered pixels stay at density 0 and are never invented, so the tracer can
// never invent heat where no tile was downloaded.
//
// Returns { width, height, x, y, zoom, density, coverage }, where x/y are the
// projected coordinates of the raster's top-left corner: a global point `p`
// maps to raster-local coordinates (p[0] - x, p[1] - y).
export function createHeatmapRaster(tiles, zoom = 15, bounds) {
  if (!tiles.length) throw new Error('No heatmap tiles are available.');
  const extents = tiles.map((tile) => {
    const scale = TILE_SIZE * 2 ** (zoom - tile.z);
    return { tile, scale, x: tile.x * scale, y: tile.y * scale };
  });
  bounds ||= {
    minX: Math.floor(Math.min(...extents.map((e) => e.x))),
    minY: Math.floor(Math.min(...extents.map((e) => e.y))),
    maxX: Math.ceil(Math.max(...extents.map((e) => e.x + e.scale))),
    maxY: Math.ceil(Math.max(...extents.map((e) => e.y + e.scale))),
  };
  const width = bounds.maxX - bounds.minX + 1;
  const height = bounds.maxY - bounds.minY + 1;
  if (width < 2 || height < 2 || width * height > 4000000) {
    throw new Error('Slide area is too large. Select two points of the line to slide it in sections.');
  }
  const density = new Float32Array(width * height);
  const coverage = new Uint8Array(width * height);
  extents.sort((a, b) => b.tile.width / b.scale - a.tile.width / a.scale);
  for (const { tile, scale, x: tx, y: ty } of extents) {
    if (
      tile.density
        ? tile.density.length !== tile.width * tile.height
        : !tile.data || tile.data.length !== tile.width * tile.height * 4
    ) {
      throw new Error('Invalid heatmap tile pixels.');
    }
    const value = (x, y) => {
      if (tile.density) return tile.density[y * tile.width + x];
      const i = (y * tile.width + x) * 4;
      // Legacy RGBA input: luminance × alpha. Only useful for known monotonic
      // palettes such as hot; live tiles use decoded palette-index density.
      return (
        (((0.2126 * tile.data[i] +
          0.7152 * tile.data[i + 1] +
          0.0722 * tile.data[i + 2]) /
          255) *
          tile.data[i + 3]) /
        255
      );
    };
    for (
      let y = Math.max(bounds.minY, Math.ceil(ty));
      y < Math.min(bounds.maxY + 1, ty + scale);
      y++
    ) {
      for (
        let x = Math.max(bounds.minX, Math.ceil(tx));
        x < Math.min(bounds.maxX + 1, tx + scale);
        x++
      ) {
        const index = (y - bounds.minY) * width + x - bounds.minX;
        if (coverage[index]) continue;
        // Image samples live at pixel centers, not at the tile's upper-left
        // pixel edges. This also avoids a half-pixel shift in parent fallback.
        const px = Math.max(
          0,
          Math.min(tile.width - 1, ((x - tx) / scale) * tile.width - 0.5)
        );
        const py = Math.max(
          0,
          Math.min(tile.height - 1, ((y - ty) / scale) * tile.height - 0.5)
        );
        const x0 = Math.floor(px),
          y0 = Math.floor(py);
        const x1 = Math.min(x0 + 1, tile.width - 1),
          y1 = Math.min(y0 + 1, tile.height - 1);
        const dx = px - x0,
          dy = py - y0;
        density[index] =
          (value(x0, y0) * (1 - dx) + value(x1, y0) * dx) * (1 - dy) +
          (value(x0, y1) * (1 - dx) + value(x1, y1) * dx) * dy;
        coverage[index] = 1;
      }
    }
  }
  // Shift the range so the darkest covered pixel becomes exactly 0 and the
  // scale stays 0..1. This removes the flat image background without
  // amplifying almost-empty tiles (the 0.1 denominator guard).
  let floor = 1;
  for (let i = 0; i < density.length; i++) {
    if (coverage[i]) floor = Math.min(floor, density[i]);
  }
  for (let i = 0; i < density.length; i++) {
    density[i] = Math.max(0, (density[i] - floor) / Math.max(0.1, 1 - floor));
  }
  return {
    width,
    height,
    x: bounds.minX,
    y: bounds.minY,
    zoom,
    density: blur(density, width, height),
    coverage,
  };
}

// Bilinear interpolation of the density at a fractional pixel point; points
// outside the raster read 0. Interpolation matters because the path search
// compares costs of positions that can fall between pixel centers, and the
// simplification guard samples along chords that rarely hit pixel centers.
export function sampleDensity(raster, point) {
  const x = point[0] - raster.x,
    y = point[1] - raster.y;
  if (x < 0 || y < 0 || x >= raster.width - 1 || y >= raster.height - 1) return 0;
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    dx = x - x0,
    dy = y - y0;
  const i = y0 * raster.width + x0;
  return (
    (raster.density[i] * (1 - dx) + raster.density[i + 1] * dx) * (1 - dy) +
    (raster.density[i + raster.width] * (1 - dx) +
      raster.density[i + raster.width + 1] * dx) *
      dy
  );
}

// Shortest distance from point `p` to the segment a–b (0 for degenerate
// segments). Used to constrain the search corridor to the neighbourhood of the
// original line, which is what keeps Slide from wandering onto a parallel road.
function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
    : 0;
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}

// Minimal binary min-heap keyed by `cost` (entries are { index, cost } into a
// flattened 2-D array). Dijkstra's algorithm always needs the cheapest
// unexplored cell next, which this provides in O(log n).
class MinHeap {
  items = [];
  push(item) {
    let i = this.items.length;
    this.items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].cost <= item.cost) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = item;
  }
  pop() {
    const first = this.items[0],
      last = this.items.pop();
    if (this.items.length) {
      let i = 0;
      while (i * 2 + 1 < this.items.length) {
        let child = i * 2 + 1;
        if (
          child + 1 < this.items.length &&
          this.items[child + 1].cost < this.items[child].cost
        )
          child++;
        if (this.items[child].cost >= last.cost) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return first;
  }
}

// Cooperative cancellation. Slide can run for seconds on long lines, so the
// loops below call this regularly (together with options.yield(), which lets
// the browser repaint and the progress bar move) so the Cancel button stays
// responsive. A cancelled run throws a DOMException named 'AbortError', which
// index.js treats as "user cancelled", not as a failure.
function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Slide cancelled.', 'AbortError');
}

// "There is no heatmap trail here" is an expected outcome (faint heat, an
// ambiguous fork, incomplete coverage), not a bug. Tagging the error with
// SLIDE_NO_SIGNAL lets slideLine retry the step with a wider search radius
// before giving up, and lets index.js show an actionable message.
function noSignal(message) {
  const error = new Error(message);
  error.code = 'SLIDE_NO_SIGNAL';
  return error;
}

// Whether a raster pixel is actually backed by downloaded imagery. Used to
// keep paths and simplification chords inside real coverage.
function isCovered(raster, point) {
  const x = Math.floor(point[0]) - raster.x,
    y = Math.floor(point[1]) - raster.y;
  return (
    x >= 0 &&
    y >= 0 &&
    x < raster.width &&
    y < raster.height &&
    Boolean(raster.coverage[y * raster.width + x])
  );
}

// Radius ladder for adaptive widening: start small (fast, precise, and
// unlikely to jump onto a nearby parallel path) and double until `maximum`.
function searchRadii(initial, maximum) {
  const radii = [initial];
  while (radii[radii.length - 1] < maximum) {
    radii.push(Math.min(maximum, radii[radii.length - 1] * 2));
  }
  return radii;
}

// Heat on other mapped roads and paths belongs to them. A stronger parallel
// trail would otherwise pull the line onto it, and its brightness would make
// the line's own trail look faint after contrast normalisation. Fade their
// heat out within otherWayMeters (back to full at otherWayFadeMeters), except
// within junctionMeters of a junction with the line, where both trails share
// heat. `otherWays` are arrays of [lon, lat]; a junction is a line vertex at
// exactly the location of one of their vertices.
//
// A wide road's heat band reaches past otherWayFadeMeters, and the line would
// jump across a dark gap onto its bright edge. So up to otherWayFlankMeters,
// a pixel is also ignored when, on the straight walk from the other way to it,
// the heat leaves the other way's core (about level from where the walk
// starts, at otherWayMeters) and then keeps falling, metre after metre: it is
// the other way's flank. A pixel still in that core belongs to it too, unless
// the other way has no heat there.
// Heat that stops falling before going dark (a plateau, or a rise beyond a
// gap) belongs to something else, so a separate trail next to the road keeps
// its heat. Not within otherWayFlankMeters of a junction with the line: there
// the walk can run along the line's own trail, whose heat stays level too.
// The flank must keep falling, to this factor of its previous value per metre
// (unless it is dark); its core ends below this factor of its peak.
const FLANK_DROP = 0.97;
const NEAR_METERS = 10;
const FLANK_CORE = 0.85;
const FLANK_DARK = 0.02;
function maskOtherWays(raster, otherWays, locations, scale) {
  const { width, height } = raster;
  const inner = SLIDE_DEFAULTS.otherWayMeters / scale,
    outer = SLIDE_DEFAULTS.otherWayFadeMeters / scale,
    flank = SLIDE_DEFAULTS.otherWayFlankMeters / scale,
    junctionRadius = SLIDE_DEFAULTS.junctionMeters / scale;
  const metre = 1 / scale;
  const onFlank = (from, to) => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const at = (d) =>
      sampleDensity(raster, [
        from[0] + ((to[0] - from[0]) * d) / length,
        from[1] + ((to[1] - from[1]) * d) / length,
      ]);
    const start = at(inner);
    if (start <= FLANK_DARK) return false;
    let previous = start,
      falling = false;
    for (let d = inner + metre; d < length + metre; d += metre) {
      const value = at(Math.min(d, length));
      if (!falling) {
        // Rising well above the start: another trail's band, not this core.
        // Saturated heat cannot rise that far, so reaching it counts too.
        if (value > Math.min(start / FLANK_CORE, SATURATED_HEAT) && value > start) return false;
        falling = value < start * FLANK_CORE;
      } else if (value > FLANK_DARK && value > previous * FLANK_DROP) return false;
      previous = value;
    }
    return true;
  };
  const junctions = locations
    .filter((loc) =>
      otherWays.some((way) => way.some((o) => o[0] === loc[0] && o[1] === loc[1]))
    )
    .map((loc) => project(loc, raster.zoom));
  const weight = new Float32Array(width * height).fill(1);
  // Pixels within NEAR_METERS of another way (1), or further out within
  // otherWayFlankMeters (2), junctions included: the heat there may be that
  // way's. A vertex never moves into the first, and in either it only centres
  // on the trail it is on, never searches for one (see snap).
  const near = new Uint8Array(width * height);
  for (const way of otherWays) {
    const points = way.map((loc) => project(loc, raster.zoom));
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1],
        b = points[k];
      const minX = Math.max(0, Math.floor(Math.min(a[0], b[0]) - flank) - raster.x),
        maxX = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0]) + flank) - raster.x),
        minY = Math.max(0, Math.floor(Math.min(a[1], b[1]) - flank) - raster.y),
        maxY = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1]) + flank) - raster.y);
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        length = dx * dx + dy * dy;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const index = y * width + x;
          if (weight[index] === 0) continue;
          const p = [x + raster.x, y + raster.y];
          const t = length
            ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
            : 0;
          const nearest = [a[0] + dx * t, a[1] + dy * t];
          const d = Math.hypot(p[0] - nearest[0], p[1] - nearest[1]);
          if (d > flank) continue;
          if (d < NEAR_METERS / scale) near[index] = 1;
          else if (!near[index]) near[index] = 2;
          let w = Math.max(0, Math.min(1, (d - inner) / (outer - inner)));
          if (
            w > 0 &&
            d > inner &&
            !junctions.some((j) => Math.hypot(p[0] - j[0], p[1] - j[1]) <= flank) &&
            onFlank(nearest, p)
          )
            w = 0;
          if (w < weight[index]) weight[index] = w;
        }
      }
    }
  }
  for (const [jx, jy] of junctions) {
    for (
      let y = Math.max(0, Math.floor(jy - junctionRadius) - raster.y);
      y <= Math.min(height - 1, Math.ceil(jy + junctionRadius) - raster.y);
      y++
    ) {
      for (
        let x = Math.max(0, Math.floor(jx - junctionRadius) - raster.x);
        x <= Math.min(width - 1, Math.ceil(jx + junctionRadius) - raster.x);
        x++
      ) {
        if (Math.hypot(x + raster.x - jx, y + raster.y - jy) <= junctionRadius)
          weight[y * width + x] = 1;
      }
    }
  }
  return {
    ...raster,
    density: raster.density.map((value, i) => value * weight[i]),
    near,
  };
}

// Build the "tracking surface": a copy of the raster whose density is locally
// contrast-normalised (0..1 relative to the strongest heat nearby).
//
// The raw raster answers "how hot is this pixel?"; the tracking surface
// answers "is this pixel a local ridge?". Discovery – snapping and tracing –
// runs on the tracking surface so a faint but consistent forest trail is
// followed just like a bright road. Heat under MIN_HEAT counts as none, so
// compression specks and the near-empty heat of an area nobody records
// (around 0.01) are not amplified into convincing trails: the faintest real
// trails are around 0.05. Geometry
// quality decisions elsewhere still use the RAW density, so a wide saturated
// band is not mistaken for a narrow ridge.
//
// The neighbourhood maximum is computed with a sliding-window deque (a
// monotonic maximum filter) in two passes – rows, then columns – which is
// O(pixels) instead of O(pixels × radius²).
const MIN_HEAT = 0.02;
async function trackingSurface(raster, scale, options) {
  const radius = Math.max(1, Math.ceil(SLIDE_DEFAULTS.contrastRadiusMeters / scale));
  const { width, height, density, coverage } = raster;
  const horizontal = new Float32Array(density.length);
  const signal = new Float32Array(density.length);
  const queue = new Int32Array(Math.max(width, height));
  const value = (index) => (coverage[index] ? density[index] : 0);
  for (let y = 0; y < height; y++) {
    if (y % 64 === 0) {
      await options.yield();
      checkAbort(options.signal);
    }
    const row = y * width;
    let head = 0,
      tail = 0,
      next = 0;
    for (let x = 0; x < width; x++) {
      const right = Math.min(width - 1, x + radius);
      while (next <= right) {
        const v = value(row + next);
        while (tail > head && value(row + queue[tail - 1]) <= v) tail--;
        queue[tail++] = next++;
      }
      while (queue[head] < x - radius) head++;
      horizontal[row + x] = value(row + queue[head]);
    }
  }
  let hasSignal = false;
  for (let x = 0; x < width; x++) {
    if (x % 64 === 0) {
      await options.yield();
      checkAbort(options.signal);
    }
    let head = 0,
      tail = 0,
      next = 0;
    for (let y = 0; y < height; y++) {
      const bottom = Math.min(height - 1, y + radius);
      while (next <= bottom) {
        const v = horizontal[next * width + x];
        while (tail > head && horizontal[queue[tail - 1] * width + x] <= v) tail--;
        queue[tail++] = next++;
      }
      while (queue[head] < y - radius) head++;
      const index = y * width + x;
      signal[index] =
        value(index) < MIN_HEAT
          ? 0
          : value(index) / Math.max(MIN_HEAT, horizontal[queue[head] * width + x]);
      if (signal[index] >= 0.25) hasSignal = true;
    }
  }
  if (!hasSignal) throw noSignal('No usable heatmap trail is visible in this area.');
  // `heat`: the raw density, for the checks that need absolute brightness.
  return { ...raster, density: signal, heat: raster.density };
}

// Move one original vertex onto the nearest convincing trail point within
// `radius` pixels; returns undefined when there is none. Candidates are
// filtered by the signal threshold BEFORE the distance penalty is applied —
// otherwise a dark unsnapped pixel could outscore a weak visible trail and
// then fail the threshold afterwards.
//
// A vertex already on a trail, even a faint one, only moves across the line
// (along `normal`, perpendicular to the drawn line there) to the nearest ridge
// uphill: it never crosses a darker gap onto a brighter trail nearby, and at
// a fork it does not follow the merged heat up the brighter branch. It only
// centres on that trail: at most alignMeters (`align` pixels) away. A climb
// ending on weak heat (a false ridge, e.g. at the edge of a masked road) falls
// back to the search below. It does not climb into another mapped way's zone
// (raster.near, from maskOtherWays) unless it starts there: next to a
// junction, that way's heat is not masked and would pull the vertex onto it.
// A vertex already in the trail's core (at least
// IN_CORE of the ridge's heat) does not move at all: where the band is wider
// than the drawn detail (tight switchbacks), the heat cannot show that detail,
// and centring would flatten it.
const ON_TRAIL = 0.1;
const IN_CORE = 0.4;
// A drawn vertex turning by more than this, with a leg shorter than
// HOLD_LEG_METERS, is a bend of the drawing (e.g. a tight switchback) that the
// heat is too coarse to show: it holds its place when on the band (see snap).
// A bend with long legs is a turn the band itself shows: it is centred. Only
// zigzags are held: a bend needs a bend turning the other way within two
// vertices. A lone bend, or a bump turning one way, is drawing noise.
const HOLD_TURN_DEGREES = 35;
const HOLD_LEG_METERS = 12;
// ... and only while it swings at most this far from the band's ridge: a
// wider zigzag would show in the heat.
const HOLD_MAX_OFFSET_METERS = 4;
function snap(raster, point, radius, normal, align = radius, hold = 0) {
  const zone = (p) => {
    if (!raster.near) return 0;
    const x = Math.round(p[0]) - raster.x,
      y = Math.round(p[1]) - raster.y;
    return x >= 0 && y >= 0 && x < raster.width && y < raster.height
      ? raster.near[y * raster.width + x]
      : 0;
  };
  const near = (p) => zone(p) === 1;
  const startsNear = near(point);
  if (normal && sampleDensity(raster, point) >= ON_TRAIL) {
    const start = sampleDensity(raster, point);
    let peak = start;
    const climb = (sign) => {
      let distance = 0,
        value = start;
      for (;;) {
        const next = distance + 0.5;
        const p = [point[0] + sign * normal[0] * next, point[1] + sign * normal[1] * next];
        const sample = sampleDensity(raster, p);
        if (sample <= value || next > Math.min(radius, align) || (!startsNear && near(p)))
          break;
        distance = next;
        value = sample;
      }
      peak = Math.max(peak, value);
      return distance;
    };
    const up = [climb(1), -climb(-1)].filter(Boolean);
    // Both sides uphill (between two ridges): the nearer one.
    const offset = up.length ? up.sort((a, b) => Math.abs(a) - Math.abs(b))[0] : 0;
    // A held bend stays when on the band and within `hold` pixels of its ridge.
    if (hold && Math.abs(offset) <= hold && start >= peak * IN_CORE && start >= 0.25)
      return point.slice();
    const centred = [point[0] + normal[0] * offset, point[1] + normal[1] * offset];
    if (sampleDensity(raster, centred) >= 0.25) return centred;
  }
  // Off the trail next to another way: whatever heat a search finds there
  // may be that way's, so the vertex stays as drawn.
  if (zone(point)) return undefined;
  let best,
    bestScore = -Infinity;
  if (normal) {
    // Off the trail: search across the line too, never along it, so the
    // vertex does not jump past its neighbours.
    for (let d = -radius; d <= radius; d += 0.5) {
      const p = [point[0] + normal[0] * d, point[1] + normal[1] * d];
      if (!isCovered(raster, p)) continue;
      const value = sampleDensity(raster, p);
      if (value < 0.25 || (!startsNear && near(p))) continue;
      const score = value - 0.12 * (d / radius) ** 2;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }
  for (let y = Math.floor(point[1] - radius); y <= Math.ceil(point[1] + radius); y++) {
    for (let x = Math.floor(point[0] - radius); x <= Math.ceil(point[0] + radius); x++) {
      const distance = Math.hypot(x - point[0], y - point[1]);
      const index = (y - raster.y) * raster.width + x - raster.x;
      if (
        distance > radius ||
        x < raster.x ||
        y < raster.y ||
        x >= raster.x + raster.width ||
        y >= raster.y + raster.height ||
        !raster.coverage[index]
      )
        continue;
      // Filter candidates BEFORE applying the distance penalty. Otherwise a
      // dark unsnapped point can beat a visible weak trail and fail afterwards.
      if (raster.density[index] < 0.25 || (!startsNear && near([x, y]))) continue;
      const score = raster.density[index] - 0.12 * (distance / radius) ** 2;
      if (score > bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
  }
  return best;
}

// A long drawn segment often cuts across a curve of its trail: the trail may
// bulge away from it by this fraction of its length (see jumpMeters).
const JUMP_BULGE = 0.25;
// Whether a traced path's raw heat dips below VALLEY_DIP of the heat it has
// on both sides of the dip (the brightest before and after it).
const VALLEY_DIP = 0.8;
function crossesValley(raster, points) {
  const heat = raster.heat ? { ...raster, density: raster.heat } : raster;
  const values = points.map((p) => sampleDensity(heat, p));
  const after = values.slice();
  for (let k = values.length - 2; k >= 0; k--) after[k] = Math.max(after[k], after[k + 1]);
  let before = 0;
  return values.some((value, k) => {
    before = Math.max(before, value);
    return value < VALLEY_DIP * Math.min(before, after[k]);
  });
}
// A drawn segment crossing this much dark ground cut a corner of its trail.
const CORNER_GAP_METERS = 6;
// A tight-corridor trace with more of its points than this at the corridor's
// edge is pressed against it (see traceSection).
const TIGHT_EDGE_SHARE = 0.1;

// Find the cheapest continuous grid path from `start` to `end` that stays
// inside a corridor of `radius` pixels around the original segment
// (`originalStart`/`originalEnd`). This is Dijkstra's algorithm over the
// raster cells with 8-connectivity.
//
// Per-cell cost (cellCosts) strongly prefers high density (8·(1 − density)²),
// with a small constant overhead and a mild penalty for straying from the
// original line, so the result follows the ridge but does not drift sideways.
// Adjacent cell costs are averaged for each step (trapezoid rule) so a step's
// cost does not depend on which of its two ends it is evaluated from.
//
// The heap stores cost + a small straight-line distance-to-end term (an
// A*-like tie-breaker). It does not change which path is cheapest, it just
// expands cells roughly in the direction of travel, which speeds the search up.
//
// Afterwards the path is validated for continuity: a long dark interior
// stretch means the corridor crossed a gap instead of following a trail. Such
// paths raise SLIDE_NO_SIGNAL so the caller can retry with a wider radius.
async function trace(raster, start, end, originalStart, originalEnd, radius, options) {
  if (!isCovered(raster, start) || !isCovered(raster, end)) {
    throw noSignal('Heatmap coverage is incomplete at an endpoint.');
  }
  const minX = Math.max(
    raster.x,
    Math.floor(Math.min(originalStart[0], originalEnd[0], start[0], end[0]) - radius)
  );
  const minY = Math.max(
    raster.y,
    Math.floor(Math.min(originalStart[1], originalEnd[1], start[1], end[1]) - radius)
  );
  const maxX = Math.min(
    raster.x + raster.width - 1,
    Math.ceil(Math.max(originalStart[0], originalEnd[0], start[0], end[0]) + radius)
  );
  const maxY = Math.min(
    raster.y + raster.height - 1,
    Math.ceil(Math.max(originalStart[1], originalEnd[1], start[1], end[1]) + radius)
  );
  const width = maxX - minX + 1,
    height = maxY - minY + 1;
  const costs = new Float32Array(width * height).fill(Infinity);
  const parents = new Int32Array(width * height).fill(-1);
  const visited = new Uint8Array(width * height);
  const cellCosts = new Float32Array(width * height).fill(Infinity);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = (y - minY) * width + x - minX;
      const j = (y - raster.y) * raster.width + x - raster.x;
      const distance = distanceToSegment([x, y], originalStart, originalEnd);
      if (!raster.coverage[j] || distance > radius) continue;
      cellCosts[i] =
        0.06 + 8 * (1 - raster.density[j]) ** 2 + 0.04 * (distance / radius) ** 2;
      // A trail never runs over itself: make re-using the path traced by
      // earlier sections expensive, except where this section starts on it.
      if (
        options.avoid?.[j] &&
        Math.hypot(x - start[0], y - start[1]) > options.avoidExclude
      )
        cellCosts[i] += 3;
    }
  }
  const from = (Math.round(start[1]) - minY) * width + Math.round(start[0]) - minX;
  const to = (Math.round(end[1]) - minY) * width + Math.round(end[0]) - minX;
  if (!Number.isFinite(cellCosts[from]) || !Number.isFinite(cellCosts[to])) {
    throw noSignal('The search corridor does not yet reach the snapped trail.');
  }
  const heap = new MinHeap();
  costs[from] = 0;
  heap.push({ index: from, cost: 0 });
  let iterations = 0;
  while (heap.items.length) {
    const { index } = heap.pop();
    if (visited[index]) continue;
    visited[index] = 1;
    if (index === to) break;
    if (++iterations % 8192 === 0) {
      await options.yield();
      checkAbort(options.signal);
    }
    const x = index % width,
      y = Math.floor(index / width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (
          (!dx && !dy) ||
          x + dx < 0 ||
          y + dy < 0 ||
          x + dx >= width ||
          y + dy >= height
        )
          continue;
        const next = index + dy * width + dx;
        if (visited[next] || !Number.isFinite(cellCosts[next])) continue;
        // Do not diagonally jump across holes in tile coverage/the corridor.
        if (
          dx &&
          dy &&
          (!Number.isFinite(cellCosts[index + dx]) ||
            !Number.isFinite(cellCosts[index + dy * width]))
        )
          continue;
        const cost =
          costs[index] + (Math.hypot(dx, dy) * (cellCosts[index] + cellCosts[next])) / 2;
        if (cost >= costs[next]) continue;
        costs[next] = cost;
        parents[next] = index;
        heap.push({
          index: next,
          cost: cost + 0.06 * Math.hypot(minX + x + dx - end[0], minY + y + dy - end[1]),
        });
      }
    }
  }
  if (!visited[to]) throw noSignal('No continuous heatmap coverage along this section.');
  const points = [];
  for (let i = to; i !== -1; i = parents[i])
    points.push([minX + (i % width), minY + Math.floor(i / width)]);
  points.reverse();
  points[0] = start;
  points[points.length - 1] = end;
  // Evaluate continuity in locally normalized signal, not absolute brightness.
  // A fixed endpoint may be off-trail: allow a bounded approach at either end,
  // but never treat a long dark interior shortcut as a traced trail.
  const support = points.map((p) => sampleDensity(raster, p) >= 0.12);
  const first = support.indexOf(true),
    last = support.lastIndexOf(true);
  let leading = 0,
    trailing = 0,
    gap = 0,
    longestGap = 0,
    dark = 0;
  let supportedLength = 0,
    totalLength = 0;
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1]
    );
    totalLength += length;
    if (support[i] && support[i - 1]) supportedLength += length;
  }
  for (let i = 1; i <= first; i++)
    leading += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1]
    );
  for (let i = last + 1; i < points.length && i > 0; i++)
    trailing += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1]
    );
  for (let i = first; i <= last && i >= 0; i++) {
    if (support[i]) gap = 0;
    else {
      dark++;
      gap += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      longestGap = Math.max(longestGap, gap);
    }
  }
  // A section follows the trail between its anchors. Straying sideways from
  // the drawn segment much further than the anchors themselves moved means
  // it crossed over to another heat trace and back: never allowed.
  const [dx, dy] = [originalEnd[0] - originalStart[0], originalEnd[1] - originalStart[1]];
  const sideways = (p) =>
    Math.hypot(dx, dy)
      ? Math.abs((p[0] - originalStart[0]) * dy - (p[1] - originalStart[1]) * dx) /
        Math.hypot(dx, dy)
      : Math.hypot(p[0] - originalStart[0], p[1] - originalStart[1]);
  const offset = Math.max(sideways(start), sideways(end));
  const stray = Math.max(...points.map(sideways));
  // The bulge allowance is for a trace that stays on one band (its heat never
  // dips): a trace that crosses a valley of the raw heat on its way out went
  // over to another trail.
  const bulge = Math.max(
    SLIDE_DEFAULTS.jumpMeters / options.scale,
    crossesValley(raster, points) ? 0 : JUMP_BULGE * Math.hypot(dx, dy)
  );
  // Unless the straight line between the anchors crosses dark ground: the
  // drawing cut a corner (e.g. a hairpin) and the trail must swing away from
  // it. The gap checks below still apply to the traced path.
  const chord = Math.hypot(end[0] - start[0], end[1] - start[1]);
  let darkRun = 0,
    cutsCorner = false;
  for (let s = 0; s <= chord; s++) {
    const p = [
      start[0] + ((end[0] - start[0]) * s) / Math.max(1, chord),
      start[1] + ((end[1] - start[1]) * s) / Math.max(1, chord),
    ];
    darkRun = sampleDensity(raster, p) < 0.12 ? darkRun + 1 : 0;
    if (darkRun * options.scale >= CORNER_GAP_METERS) cutsCorner = true;
  }
  if (!cutsCorner && stray > offset + bulge) {
    throw noSignal('The heatmap trail here jumps to another trace.');
  }
  const maxGap = 12 / options.scale;
  if (
    first === -1 ||
    leading > radius + 2 ||
    trailing > radius + 2 ||
    longestGap > maxGap ||
    dark > Math.max(3, (last - first + 1) * 0.15) ||
    supportedLength < Math.min(20 / options.scale, totalLength * 0.5)
  ) {
    throw noSignal(
      'No usable heatmap trail found near this line. Draw it closer to the trail, or double-click the line to add a point on the trail you want.'
    );
  }
  return points;
}

// Reduce the traced pixel path to a handful of vertices – Douglas–Peucker
// with `tolerance` pixels – with two guards that plain Douglas–Peucker lacks:
//   * coverage guard: the replacement chord must not cut across missing tiles
//     that the traced grid path deliberately went around;
//   * density guard:  a vertex is kept when replacing it would measurably
//     leave the density ridge. Clipping a narrow bend is invisible to the
//     metric error alone but obvious on the heatmap.
// Works on pixel points; the caller converts them to locations afterwards.
// Douglas–Peucker keeps any vertex more than `tolerance` off the chord, so
// raster stair-steps and short jogs survive as sharp little kinks. Repeatedly
// drop the vertex forming the smallest triangle with its neighbours
// (Visvalingam) until every remaining one exceeds `minArea`: a sharp turn on
// short legs is noise, a gentle turn on long legs is a real bend.
function removeSmallTurns(points, minArea) {
  const area = (a, b, c) =>
    Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  const result = points.slice();
  while (result.length > 2) {
    let smallest = -1,
      smallestArea = minArea;
    for (let i = 1; i < result.length - 1; i++) {
      const value = area(result[i - 1], result[i], result[i + 1]);
      if (value < smallestArea) {
        smallest = i;
        smallestArea = value;
      }
    }
    if (smallest === -1) break;
    result.splice(smallest, 1);
  }
  return result;
}

function simplify(points, tolerance, raster) {
  return points.filter((_, i) => simplifyKeep(points, tolerance, raster)[i]);
}

// Douglas–Peucker with a density guard: which of `points` to keep (the first
// and last always are).
function simplifyKeep(points, tolerance, raster) {
  const keep = new Uint8Array(points.length);
  if (points.length <= 2) return keep.fill(1);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let farthest = -1,
      maxDistance = tolerance;
    for (let i = start + 1; i < end; i++) {
      const distance = distanceToSegment(points[i], points[start], points[end]);
      if (distance > maxDistance) {
        farthest = i;
        maxDistance = distance;
      }
    }
    if (farthest === -1 && end > start + 1) {
      // Douglas–Peucker's geometric error alone can accept a chord that clips
      // a narrow bend. Keep a vertex if its replacement materially leaves the
      // density ridge, even when that chord is within the metric tolerance.
      const a = points[start],
        b = points[end];
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        length = dx * dx + dy * dy;
      // A simplification must not cut across a missing tile corner that the
      // traced grid path avoided. Check the whole chord, not just its ends.
      const steps = Math.max(1, Math.ceil(Math.sqrt(length) * 2));
      for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        if (!isCovered(raster, [a[0] + t * dx, a[1] + t * dy])) {
          farthest = Math.max(
            start + 1,
            Math.min(end - 1, Math.round(start + t * (end - start)))
          );
          break;
        }
      }
      let worstLoss = 0.06;
      for (let i = start + 1; i < end; i++) {
        const p = points[i];
        const t = length
          ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
          : 0;
        const replacement = [a[0] + t * dx, a[1] + t * dy];
        const loss = sampleDensity(raster, p) - sampleDensity(raster, replacement);
        if (loss > worstLoss) {
          farthest = i;
          worstLoss = loss;
        }
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push([start, farthest], [farthest, end]);
    }
  }
  return keep;
}

// Slide an entire line.
//
// Inputs:
//   locations – the original [lon, lat] vertices of the selected way/range
//   raster    – the merged heatmap raster (createHeatmapRaster)
//   options   – fixedIndices (indices that must not move: range endpoints are
//               always fixed, plus tagged nodes and junctions passed in by the
//               caller), signal (AbortSignal), yield (async hook so long loops
//               can repaint), onProgress (0..1), otherWays (nearby mapped
//               roads and paths as arrays of [lon, lat], whose heat is
//               ignored), plus the metre-based knobs documented in
//               SLIDE_DEFAULTS.
//
// Returns ordered records { loc, nodeIndex }: nodeIndex identifies the
// original vertex a point came from, or null for a point Slide created.
// Original vertices appear at most once and in ascending order; fixed ones and
// the ends always do, free ones may be dropped where the trail is straight.
// action.js relies on that to keep OSM node IDs (and with them tags and
// connections) where possible, and deletes the dropped ones.
export async function slideLine(locations, raster, options = {}) {
  if (
    locations.length < 2 ||
    locations.length > 1000 ||
    locations.some(
      (p) =>
        !Array.isArray(p) ||
        p.length !== 2 ||
        !p.every(Number.isFinite) ||
        Math.abs(p[1]) > 85.05112878 ||
        Math.abs(p[0]) > 180
    )
  ) {
    throw new Error('Slide works on 2 to 1000 points of a line.');
  }
  options = { yield: () => new Promise((resolve) => setTimeout(resolve, 0)), ...options };
  checkAbort(options.signal);
  const scale = metersPerPixel(locations[0][1], raster.zoom);
  const searchMeters = options.searchRadiusMeters ?? SLIDE_DEFAULTS.searchRadiusMeters;
  const snapMeters = options.snapRadiusMeters ?? SLIDE_DEFAULTS.snapRadiusMeters;
  // Explicit radii remain hard limits unless a larger maximum is requested.
  const maxSearchMeters =
    options.maxSearchRadiusMeters ??
    (options.searchRadiusMeters === undefined
      ? SLIDE_DEFAULTS.maxSearchRadiusMeters
      : searchMeters);
  const maxSnapMeters =
    options.maxSnapRadiusMeters ??
    (options.snapRadiusMeters === undefined
      ? Math.min(SLIDE_DEFAULTS.maxSnapRadiusMeters, maxSearchMeters)
      : snapMeters);
  const radius = searchMeters / scale,
    snapRadius = snapMeters / scale;
  // 1.2 m was only about half a zoom-15 pixel (~2.39 m/pixel here), so the old
  // Douglas–Peucker pass retained raster stair-steps as tiny 45°/90° bends.
  // Two meters removes that quantization noise; the density guard protects
  // genuine tight bends. Original vertices remain segment endpoints throughout.
  const tolerance = (options.simplifyMeters ?? SLIDE_DEFAULTS.simplifyMeters) / scale;
  const minArea =
    (options.minTriangleSquareMeters ?? SLIDE_DEFAULTS.minTriangleSquareMeters) /
    scale ** 2;
  if (!Number.isFinite(tolerance) || tolerance < 0)
    throw new Error('Invalid Slide simplification tolerance.');
  if (
    ![searchMeters, snapMeters, maxSearchMeters, maxSnapMeters].every(Number.isFinite) ||
    !(radius > 0) ||
    !(snapRadius > 0) ||
    snapRadius > radius ||
    maxSearchMeters < searchMeters ||
    maxSnapMeters < snapMeters ||
    maxSnapMeters > maxSearchMeters
  )
    throw new Error('Invalid Slide search radius.');
  options.scale = scale;
  // 1) Discovery surface: locally contrast-normalised density, without the
  //    heat of other mapped roads and paths.
  const own = options.otherWays?.length
    ? maskOtherWays(raster, options.otherWays, locations, scale)
    : raster;
  const tracking = await trackingSurface(own, scale, options);
  const originals = locations.map((loc) => project(loc, raster.zoom));
  // Fixed vertices never move. Limited ones (junctions, way ends) may snap,
  // but only within the normal radius; with no trail there they stay fixed.
  const fixed = new Set(options.fixedIndices || []);
  const limited = new Set(options.limitedIndices || []);
  const snapSearches = searchRadii(snapRadius, maxSnapMeters / scale);
  const align = (options.alignMeters ?? SLIDE_DEFAULTS.alignMeters) / scale;
  // Bends of the drawing (see HOLD_TURN_DEGREES): +1 or -1 by turn side.
  const bends = originals.map((p, i) => {
    if (i === 0 || i === originals.length - 1) return 0;
    const [a, b] = [originals[i - 1], originals[i + 1]];
    const u = [p[0] - a[0], p[1] - a[1]],
      v = [b[0] - p[0], b[1] - p[1]];
    const length = Math.hypot(...u) * Math.hypot(...v);
    const sharp =
      length > 0 &&
      Math.min(Math.hypot(...u), Math.hypot(...v)) * scale < HOLD_LEG_METERS &&
      (Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / length))) * 180) /
        Math.PI >
        HOLD_TURN_DEGREES;
    return sharp ? Math.sign(u[0] * v[1] - u[1] * v[0]) : 0;
  });
  // Only the mapper's drawing has bends to hold: in slideLineTwice's second
  // pass the "drawing" is the first pass's trace, whose small kinks are not
  // switchbacks (the ones the first pass held arrive fixed).
  // Two opposite bends joined by one short leg between long ones are a jog
  // of the drawing across the trail, not switchbacks: not held.
  const leg = (a) => Math.hypot(originals[a + 1][0] - originals[a][0], originals[a + 1][1] - originals[a][1]) * scale;
  const jog = (a, b) =>
    b === a + 1 &&
    a > 0 &&
    b < originals.length - 1 &&
    leg(a - 1) >= HOLD_LEG_METERS &&
    leg(b) >= HOLD_LEG_METERS;
  const holds = bends.map(
    (side, i) =>
      options.holdBends !== false &&
      side !== 0 &&
      [i - 2, i - 1, i + 1, i + 2].some(
        (j) => bends[j] && bends[j] === -side && !jog(Math.min(i, j), Math.max(i, j))
      )
  );
  // Unit normal of the drawn line at each vertex (from its neighbours), the
  // only direction a vertex already on a trail moves in.
  const normals = originals.map((p, i) => {
    const a = originals[Math.max(0, i - 1)],
      b = originals[Math.min(originals.length - 1, i + 1)];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return length ? [-(b[1] - a[1]) / length, (b[0] - a[0]) / length] : null;
  });
  // 2) Snap every vertex to a trail point ("anchor"). Fixed vertices are their
  //    own anchors, so endpoints and junctions never move. Snapping widens
  //    adaptively before giving up, because the drawn line may be far from the
  //    trail or the heat may be weak.
  const anchors = [];
  // Vertices with no trail nearby stay where they were drawn.
  const unsnapped = new Set();
  for (let i = 0; i < originals.length; i++) {
    await options.yield();
    checkAbort(options.signal);
    let anchor = fixed.has(i) ? originals[i] : null;
    for (const r of limited.has(i) ? [snapRadius] : snapSearches) {
      if (anchor) break;
      anchor = snap(
        tracking,
        originals[i],
        r,
        normals[i],
        align,
        holds[i] ? HOLD_MAX_OFFSET_METERS / scale : 0
      );
    }
    // The limit is measured from where the vertex was before ANY pass
    // (options.limitedOrigins), so two passes cannot add up past it.
    const origin = options.limitedOrigins?.[i];
    if (
      anchor &&
      limited.has(i) &&
      origin &&
      Math.hypot(...project(origin, raster.zoom).map((v, k) => v - anchor[k])) >
        snapRadius
    )
      anchor = null;
    if (!anchor && limited.has(i)) {
      anchor = originals[i];
      fixed.add(i);
    } else if (!anchor) {
      anchor = originals[i];
      unsnapped.add(i);
    }
    anchors.push(anchor);
  }
  // A closed line starts and ends on the same node: both ends must share one
  // position and status, so the last copies the first.
  const last = originals.length - 1;
  const closed =
    last > 1 &&
    locations[0][0] === locations[last][0] &&
    locations[0][1] === locations[last][1];
  const twin = (v) => (closed && v === 0 ? last : closed && v === last ? 0 : -1);
  if (closed) {
    if (fixed.has(0) || fixed.has(last)) {
      fixed.add(0);
      fixed.add(last);
      anchors[0] = originals[0];
    }
    if (unsnapped.has(0)) unsnapped.add(last);
    anchors[last] = anchors[0];
  }
  // 3) Trace the ridge from anchor to anchor, segment by segment. Each segment
  //    is simplified on its own and contributes: the interior simplified
  //    vertices (slide-created, nodeIndex null) followed by the segment's end
  //    vertex (nodeIndex i).
  // Sections without a usable trail are left as drawn instead of failing the
  // whole line; only an all-skipped line fails. A skipped section's vertices go
  // back to where they were drawn (a widened snap may have pulled them tens of
  // metres onto a trail end), and its neighbours are traced again to them.
  // Pixels within avoidMeters of the paths traced so far (sections before the
  // one being traced), so a section does not fold back over earlier ones.
  const avoidRadius = Math.ceil(SLIDE_DEFAULTS.avoidMeters / scale);
  const avoidExclude = (2 * SLIDE_DEFAULTS.avoidMeters) / scale;
  let avoid = new Uint8Array(tracking.width * tracking.height);
  const markAvoid = (path) => {
    for (const [px, py] of path) {
      for (let dy = -avoidRadius; dy <= avoidRadius; dy++) {
        for (let dx = -avoidRadius; dx <= avoidRadius; dx++) {
          const x = Math.round(px) + dx - tracking.x,
            y = Math.round(py) + dy - tracking.y;
          if (dx * dx + dy * dy > avoidRadius * avoidRadius) continue;
          if (x >= 0 && y >= 0 && x < tracking.width && y < tracking.height)
            avoid[y * tracking.width + x] = 1;
        }
      }
    }
  };
  const retraceSection = async (i) => {
    avoid = new Uint8Array(tracking.width * tracking.height);
    for (let k = 1; k < i; k++) if (paths[k]) markAvoid(paths[k]);
    return traceSection(i);
  };
  const traceSection = async (i) => {
    // First a tight corridor, jumpMeters beyond the anchors' own offset: when
    // the drawing lies on a trail of its own (even faint, next to a brighter
    // one), that trail is traced down the corridor's middle and kept. A trace
    // pressed against the corridor's edge means the trail lies outside it (a
    // curve the drawing cut across): widen as below.
    const [a, b] = [originals[i - 1], originals[i]];
    const tight =
      Math.max(distanceToSegment(anchors[i - 1], a, b), distanceToSegment(anchors[i], a, b)) +
      SLIDE_DEFAULTS.jumpMeters / scale;
    try {
      const path = await trace(tracking, anchors[i - 1], anchors[i], a, b, tight, {
        ...options,
        avoid,
        avoidExclude,
      });
      const edge = path.filter((p) => distanceToSegment(p, a, b) > tight - 1.5).length;
      if (edge <= path.length * TIGHT_EDGE_SHARE) return path;
    } catch (error) {
      if (error.code !== 'SLIDE_NO_SIGNAL') throw error;
    }
    // Then a narrow corridor (precise on hairpins), widened only when the
    // trail cannot be reached or is not continuous within it.
    for (const r of searchRadii(radius, maxSearchMeters / scale)) {
      await options.yield();
      checkAbort(options.signal);
      try {
        return await trace(
          tracking,
          anchors[i - 1],
          anchors[i],
          originals[i - 1],
          originals[i],
          r,
          { ...options, avoid, avoidExclude }
        );
      } catch (error) {
        if (error.code !== 'SLIDE_NO_SIGNAL') throw error;
      }
    }
    return null;
  };
  // Sections the caller wants left as drawn (slideLineTwice: those the first
  // pass left as drawn) are not traced.
  const untraced = new Set(options.untracedSections || []);
  const paths = [null];
  for (let i = 1; i < originals.length; i++) {
    paths[i] = untraced.has(i) ? null : await traceSection(i);
    if (paths[i]) markAvoid(paths[i]);
    options.onProgress?.(i / (originals.length - 1));
  }
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 1; i < originals.length; i++) {
      if (paths[i]) continue;
      for (const v of [i - 1, i]) {
        if (fixed.has(v) || unsnapped.has(v)) continue;
        for (const w of twin(v) < 0 ? [v] : [v, twin(v)]) {
          unsnapped.add(w);
          anchors[w] = originals[w];
          if (w > 0 && paths[w]) paths[w] = await retraceSection(w);
          if (w + 1 < originals.length && paths[w + 1])
            paths[w + 1] = await retraceSection(w + 1);
        }
        changed = true;
      }
    }
  }
  // A vertex next to a section left as drawn is where the heat ends: if it
  // was found off the trail (moved further than `align`), it stays as drawn.
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 1; i < originals.length; i++) {
      if (paths[i] && !unsnapped.has(i - 1) && !unsnapped.has(i)) continue;
      for (const v of [i - 1, i]) {
        if (fixed.has(v) || unsnapped.has(v)) continue;
        const [dx, dy] = [anchors[v][0] - originals[v][0], anchors[v][1] - originals[v][1]];
        if (Math.hypot(dx, dy) <= align) continue;
        for (const w of twin(v) < 0 ? [v] : [v, twin(v)]) {
          unsnapped.add(w);
          anchors[w] = originals[w];
        }
        changed = true;
      }
    }
  }
  // A free vertex snapped off the trail (e.g. onto the inner flank of a bend)
  // makes a spike: the trace runs out to it and back along itself. Cut the
  // folded part off both sections and move the vertex to where the fold
  // starts. A bend traced from the heat is rounded, its legs never overlap.
  const pointAt = (path, distance, backwards) => {
    const points = backwards ? path.slice().reverse() : path;
    let along = 0;
    for (let k = 1; k < points.length; k++) {
      const step = Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]);
      if (along + step >= distance) {
        const t = step ? (distance - along) / step : 0;
        const p = [
          points[k - 1][0] + (points[k][0] - points[k - 1][0]) * t,
          points[k - 1][1] + (points[k][1] - points[k - 1][1]) * t,
        ];
        return { p, k: backwards ? points.length - 1 - k : k };
      }
      along += step;
    }
    return null;
  };
  for (let i = 1; i < originals.length - 1; i++) {
    // A held bend of the drawing (a switchback) is a fold on purpose.
    if (fixed.has(i) || unsnapped.has(i) || holds[i] || !paths[i] || !paths[i + 1]) continue;
    let fold = null;
    for (let d = 0.5; d <= FOLD_MAX_METERS / scale; d += 0.5) {
      const a = pointAt(paths[i], d, true),
        b = pointAt(paths[i + 1], d, false);
      if (!a || !b) break;
      if (Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]) > FOLD_GAP * d) break;
      fold = { d, a, b };
    }
    if (!fold || fold.d * scale < FOLD_MIN_METERS) continue;
    const middle = [(fold.a.p[0] + fold.b.p[0]) / 2, (fold.a.p[1] + fold.b.p[1]) / 2];
    paths[i] = [...paths[i].slice(0, fold.a.k), middle];
    paths[i + 1] = [middle, ...paths[i + 1].slice(fold.b.k)];
    anchors[i] = middle;
  }
  // A section touching a vertex left off-trail is drawn straight too: tracing
  // into the dark only wanders.
  const traced = paths.map(
    (path, i) => Boolean(path) && !unsnapped.has(i - 1) && !unsnapped.has(i)
  );
  // A fixed vertex (endpoint, junction, tagged node) may sit off the trail
  // center; tracing from it jumps sideways to the ridge and leaves a hook.
  // Join the ridge gradually instead, over approachFactor × its offset.
  const approachLength = (v) => {
    if (!fixed.has(v)) return 0;
    const center = snap(tracking, originals[v], snapRadius, normals[v], align);
    if (!center) return 0;
    const offset = Math.hypot(center[0] - originals[v][0], center[1] - originals[v][1]);
    return offset > 1 ? SLIDE_DEFAULTS.approachFactor * offset : 0;
  };
  // Drop the interior points within `length` pixels along the path from its
  // first point, so the line runs straight from that point to the next one.
  const approach = (points, length) => {
    if (!length) return points;
    let along = 0,
      k = 1;
    for (; k < points.length - 1; k++) {
      along += Math.hypot(
        points[k][0] - points[k - 1][0],
        points[k][1] - points[k - 1][1]
      );
      if (along >= length) break;
    }
    return [points[0], ...points.slice(k)];
  };
  // A vertex between two sections left as drawn stays as drawn too.
  const locate = (i) =>
    fixed.has(i) || unsnapped.has(i) || (!traced[i] && !traced[i + 1])
      ? locations[i].slice()
      : unproject(anchors[i], raster.zoom);
  const result = [{ loc: locate(0), nodeIndex: 0 }];
  result.skipped = traced.filter((ok, i) => i && !ok).length;
  if (result.skipped === originals.length - 1) {
    throw noSignal(
      'No usable heatmap trail found near this line. Draw it closer to the trail, or double-click the line to add a point on the trail you want.'
    );
  }
  for (let i = 1; i < originals.length; i++) {
    // Approach on the traced pixels, before simplifying: on simplified points
    // the straight join would run on to the next kept point, across a bend.
    let path = traced[i] ? paths[i] : [];
    if (path.length > 2) {
      path = approach(path, approachLength(i - 1));
      path = approach(path.slice().reverse(), approachLength(i)).reverse();
    }
    const reduced = traced[i]
      ? removeSmallTurns(simplify(path, tolerance, tracking), minArea)
      : [];
    // The path's first and last pixel are the anchors themselves, which the
    // next iteration emits as section endpoints — skip them here.
    for (let j = 1; j < reduced.length - 1; j++) {
      result.push({ loc: unproject(reduced[j], raster.zoom), nodeIndex: null });
    }
    result.push({
      // Fixed and unsnapped vertices keep their original location verbatim;
      // everything else takes the snapped anchor position.
      loc: locate(i),
      nodeIndex: i,
      // The section ending here was left as drawn.
      untraced: !traced[i],
    });
  }
  checkAbort(options.signal);
  // The trail decides the points, not the drawing: simplify the whole slid
  // line again, so free original vertices on a straight stretch are dropped
  // (action.js deletes them) while bends keep the points Slide added. Fixed
  // and unsnapped vertices, and the ends of sections left as drawn, stay.
  // A held bend of the drawing (a switchback) that stayed in place is kept
  // as drawn too: the heat cannot show it, so neither simplification nor
  // smoothing may soften it.
  const held = (i) =>
    holds[i] && anchors[i][0] === originals[i][0] && anchors[i][1] === originals[i][1];
  const keepVertex = (i) =>
    fixed.has(i) ||
    unsnapped.has(i) ||
    held(i) ||
    !traced[i] ||
    (i < last && !traced[i + 1]);
  const pixels = result.map((record) => project(record.loc, raster.zoom));
  const keep = new Uint8Array(result.length);
  let from = 0;
  for (let k = 1; k < result.length; k++) {
    const i = result[k].nodeIndex;
    if (k < result.length - 1 && !(i !== null && keepVertex(i))) continue;
    const span = simplifyKeep(pixels.slice(from, k + 1), tolerance, tracking);
    span.forEach((flag, j) => (keep[from + j] ||= flag));
    from = k;
  }
  const simplified = result
    .filter((_, k) => keep[k])
    // `drawn`: a vertex that stays as drawn (fixed, unsnapped, or ending a
    // section left as drawn); smoothLine keeps it in place.
    .map((record) =>
      record.nodeIndex !== null && keepVertex(record.nodeIndex)
        ? { ...record, drawn: true }
        : record
    );
  simplified.skipped = result.skipped;
  return simplified;
}

// Slide twice: a second pass over the first result (now densely on the trail)
// smooths most remaining kinks. Protected vertices stay fixed in both passes,
// and second-pass indices are mapped back to the caller's original vertices.
const SECOND_PASS_ALIGN_METERS = 2;
// See slideLineTwice: free vertices left as drawn this close to a junction.
const JUNCTION_STUB_METERS = 25;
function junctionStubs(first, locations, fixed, otherWays) {
  const stubs = new Set();
  const record = new Map(first.flatMap((r, k) => (r.nodeIndex === null ? [] : [[r.nodeIndex, { ...r, k }]])));
  const meters = (a, b) =>
    Math.hypot((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 111320;
  const isJunction = (loc) => otherWays.some((way) => way.some((o) => o[0] === loc[0] && o[1] === loc[1]));
  for (const j of fixed) {
    if (!isJunction(locations[j])) continue;
    for (const step of [-1, 1]) {
      const run = [];
      let k = j + step;
      for (; k >= 0 && k < locations.length; k += step) {
        const r = record.get(k);
        // The section between k and the previous vertex was left as drawn.
        const section = record.get(Math.max(k, k - step));
        if (!r || !r.drawn || fixed.has(k) || !section?.untraced) break;
        if (meters(locations[j], locations[k]) > JUNCTION_STUB_METERS) break;
        run.push(k);
      }
      // ...and the line goes on along its trail after them.
      const next = record.get(k);
      if (run.length && next && !next.drawn) run.forEach((i) => stubs.add(i));
    }
  }
  return stubs;
}
// A spike (see slideLine): the sections into and out of a vertex run back
// along each other, closer than FOLD_GAP × the distance from the vertex, for
// at least FOLD_MIN_METERS (looking up to FOLD_MAX_METERS).
const FOLD_GAP = 0.35;
const FOLD_MIN_METERS = 2;
const FOLD_MAX_METERS = 15;
// Put every point except the fixed ones on the middle of its band. The display
// palette saturates long before the heat does, so the band looks flat, but the
// raw heat has a ridge, which the line follows. Hairpin
// tips are placed from the band's shape, because the two legs' heat merges
// there and shows no ridge.
const CENTRE_STEP_METERS = 1.5;
const CENTRE_TOLERANCE_METERS = 1.2;
const ROUTE_OFFSET_METERS = 0.5;
const ROUTE_OFFSETS = 16;
const ROUTE_MAX_CHANGE = 2;
const ROUTE_CHANGE_COST = 0.02;
const ROUTE_SHARPNESS = 8;
const ROUTE_MIN_HEAT = 0.02;
const ROUTE_EVEN_PASSES = 6;
// The palette's top (about 0.953): heat at least this high is saturated.
const SATURATED_HEAT = 0.94;
// A way joining the line within JOINING_WAY_DEGREES of its direction (over
// this distance) shares its band this far from the junction.
const JOINING_WAY_METERS = 40;
const JOINING_WAY_DEGREES = 45;
// Heat much stronger than the point's own trail is another trail: at a fork,
// heat rises into the brighter band with no dip in between.
const RIDGE_MAX_RISE = 1.3;
const RIDGE_BASE_METERS = 3;
const FOLD_SPAN_SAMPLES = 3;
const FOLD_RESTORE_SAMPLES = 10;
const BAND_RADIUS_METERS = 12;
const TIP_MIN_TURN_DEGREES = 100;
const TIP_NEAR_METERS = 8;
const TIP_FAR_METERS = 20;
const TIP_EDGE_METERS = 24;

// How far each pixel is inside its band: its distance, in pixels, to where the
// heat falls below half of the local peak.
function bandDepth(raster) {
  const { width, height, density } = raster;
  const latitude = unproject([raster.x, raster.y + height / 2], raster.zoom)[1];
  const radius = Math.max(2, Math.round(BAND_RADIUS_METERS / metersPerPixel(latitude, raster.zoom)));
  const rows = new Float32Array(density.length),
    top = new Float32Array(density.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let m = 0;
      for (let k = Math.max(0, x - radius); k <= Math.min(width - 1, x + radius); k++)
        m = Math.max(m, density[y * width + k]);
      rows[y * width + x] = m;
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let m = 0;
      for (let k = Math.max(0, y - radius); k <= Math.min(height - 1, y + radius); k++)
        m = Math.max(m, rows[k * width + x]);
      top[y * width + x] = m;
    }
  const depth = new Float32Array(density.length);
  for (let i = 0; i < depth.length; i++)
    depth[i] = top[i] >= 0.05 && density[i] >= 0.5 * top[i] ? 1e6 : 0;
  const relax = (i, j, d) => {
    if (depth[j] + d < depth[i]) depth[i] = depth[j] + d;
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!depth[i]) continue;
      if (x > 0) relax(i, i - 1, 1);
      if (y > 0) {
        relax(i, i - width, 1);
        if (x > 0) relax(i, i - width - 1, Math.SQRT2);
        if (x < width - 1) relax(i, i - width + 1, Math.SQRT2);
      }
    }
  for (let y = height - 1; y >= 0; y--)
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (!depth[i]) continue;
      if (x < width - 1) relax(i, i + 1, 1);
      if (y < height - 1) {
        relax(i, i + width, 1);
        if (x < width - 1) relax(i, i + width + 1, Math.SQRT2);
        if (x > 0) relax(i, i + width - 1, Math.SQRT2);
      }
    }
  return blur(depth.map((d) => (d >= 1e6 ? 0 : d)), width, height);
}

const turnDegrees = (u, v) =>
  (Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) * 180) / Math.PI;

// Experiment: climb `field` from `loc` to the top of its own band, at most
// MOVE_FIXED_METERS away, or null without a band there. Climbing rather than
// taking the highest value around keeps it off a neighbouring band. A free line
// end climbs the heat, up to `limit`: it has no other way to say that a brighter
// band nearby is not its own. A junction climbs the depth inside the band, which
// is highest where bands meet: the hottest point may be along one of them.
const MOVE_FIXED_METERS = 25;
// Across a band the depth rises about 1 pixel per pixel, along it far less:
// below this, the climb is drifting along the band.
const MOVE_FIXED_MIN_GAIN = 0.15;
const JUNCTION_MIN_CROSSING_SINE = 0.5;
const MOVE_FIXED_MIN_HEAT = 0.04;
// A junction's climb keeps at least this share of the heat it started on.
const MOVE_FIXED_KEEP_HEAT = 0.85;
const COURSE_METERS = 15;
const THROUGH_BAND_METERS = 20;
const THROUGH_BAND_MAX_TURN_DEGREES = 25;
const THROUGH_BAND_FIT_METERS = 30;
// A straight line accepts a node's new place only this close to its course.
const COURSE_SIDEWAYS_METERS = 6;
const OWN_STRETCH_METERS = 25;
const JUNCTION_SNAP_METERS = 18;
const JUNCTION_MAX_TURN_DEGREES = 45;
// Least-squares y = a + b·x + c·x² through `points` ([x, y] pairs, at least 3).
function fitParabola(points) {
  const s = [0, 0, 0, 0, 0],
    t = [0, 0, 0];
  for (const [x, y] of points) {
    for (let p = 0; p < 5; p++) s[p] += x ** p;
    for (let p = 0; p < 3; p++) t[p] += y * x ** p;
  }
  const det = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const m = [
    [s[0], s[1], s[2]],
    [s[1], s[2], s[3]],
    [s[2], s[3], s[4]],
  ];
  const d = det(m) || 1;
  return [0, 1, 2].map((j) => det(m.map((row, r) => row.map((v, col) => (col === j ? t[r] : v)))) / d);
}

// Experiment: every other way ends at this node, so none passes through it, and
// it can move like any point of the line: those ways only shift their last point.
function otherWaysEndAt(loc, otherWays) {
  const same = (o) => o[0] === loc[0] && o[1] === loc[1];
  return otherWays
    .filter((way) => way.some(same))
    .every((way) => same(way[0]) || same(way[way.length - 1]));
}

// Experiment: where a junction may go without changing the course of the way
// it shares: along that way's segments next to the node, and straight on past
// its end. Each entry is a direction and how far it allows, in pixels. Empty
// when the node is on several other ways, as moving along one bends the rest.
function alongOtherWay(loc, otherWays, zoom, reach) {
  const same = (o) => o[0] === loc[0] && o[1] === loc[1];
  const ways = otherWays.filter((way) => way.some(same));
  if (ways.length !== 1 || ways[0].filter(same).length !== 1) return [];
  const way = ways[0],
    k = way.findIndex(same);
  const here = project(loc, zoom);
  const toward = (other) => {
    const [x, y] = project(other, zoom);
    const length = Math.hypot(x - here[0], y - here[1]);
    return length ? { dx: (x - here[0]) / length, dy: (y - here[1]) / length, length } : null;
  };
  const rays = [];
  for (const [neighbour, atEnd] of [
    [k > 0 ? way[k - 1] : null, k === way.length - 1],
    [k < way.length - 1 ? way[k + 1] : null, k === 0],
  ]) {
    const ray = neighbour && toward(neighbour);
    if (!ray) continue;
    rays.push({ dx: ray.dx, dy: ray.dy, max: Math.min(reach, ray.length - 1) });
    if (atEnd) rays.push({ dx: -ray.dx, dy: -ray.dy, max: reach });
  }
  return rays;
}

// Where the way a junction shares crosses the line's own `course`: the point
// along `rays` nearest to it. Null to stay: at a shallow crossing that point
// is unreliable, and far away along the other way.
function slideJunction(raster, loc, rays, course) {
  const start = project(loc, raster.zoom);
  const length = Math.hypot(course[1][0] - course[0][0], course[1][1] - course[0][1]) || 1;
  const ux = (course[1][0] - course[0][0]) / length,
    uy = (course[1][1] - course[0][1]) / length;
  let best = null,
    bestDistance = distanceToSegment(start, course[0], course[1]) - 1;
  for (const { dx, dy, max } of rays) {
    if (Math.abs(dx * uy - dy * ux) < JUNCTION_MIN_CROSSING_SINE) continue;
    for (let t = 0.5; t <= max; t += 0.5) {
      const point = [start[0] + dx * t, start[1] + dy * t];
      const distance = distanceToSegment(point, course[0], course[1]);
      if (distance < bestDistance) {
        best = point;
        bestDistance = distance;
      }
    }
  }
  return best && unproject(best, raster.zoom);
}

function hottestHeat(raster, loc) {
  const scale = metersPerPixel(loc[1], raster.zoom),
    centre = project(loc, raster.zoom),
    radius = RIDGE_BASE_METERS / scale;
  let top = 0;
  for (let dy = -radius; dy <= radius; dy += 0.5)
    for (let dx = -radius; dx <= radius; dx += 0.5)
      if (dx * dx + dy * dy <= radius * radius)
        top = Math.max(top, sampleDensity(raster, [centre[0] + dx, centre[1] + dy]));
  return top;
}
function climbBand(raster, loc, field, minGain, limit = Infinity) {
  const scale = metersPerPixel(loc[1], raster.zoom),
    start = project(loc, raster.zoom),
    reach = MOVE_FIXED_METERS / scale;
  let point = start,
    value = field(point);
  // Outside the band: start from its nearest point.
  if (value <= 0) {
    let best = null;
    for (let r = 1; r <= reach && !best; r++)
      for (let a = 0; a < 16 && !best; a++) {
        const candidate = [
          start[0] + r * Math.cos((a * Math.PI) / 8),
          start[1] + r * Math.sin((a * Math.PI) / 8),
        ];
        if (field(candidate) > 0) best = candidate;
      }
    if (!best) return null;
    point = best;
    value = field(point);
  }
  for (let moved = true; moved; ) {
    moved = false;
    let next = null,
      nextValue = value + minGain(value);
    for (let a = 0; a < 16; a++) {
      const candidate = [
        point[0] + Math.cos((a * Math.PI) / 8),
        point[1] + Math.sin((a * Math.PI) / 8),
      ];
      if (Math.hypot(candidate[0] - start[0], candidate[1] - start[1]) > reach) continue;
      const v = field(candidate);
      if (v <= limit && v > nextValue) {
        next = candidate;
        nextValue = v;
      }
    }
    if (next) {
      point = next;
      value = nextValue;
      moved = true;
    }
  }
  return unproject(point, raster.zoom);
}

function centreOnBand(records, raster, fixed, otherWays, locations, free = new Map()) {
  const zoom = raster.zoom,
    scale = metersPerPixel(records[0].loc[1], zoom);
  const depth = bandDepth(raster),
    W = raster.width,
    H = raster.height;
  const depthAt = (x, y) => {
    const px = Math.max(0, Math.min(W - 2, x - raster.x)),
      py = Math.max(0, Math.min(H - 2, y - raster.y));
    const ix = Math.floor(px),
      iy = Math.floor(py),
      fx = px - ix,
      fy = py - iy,
      i = iy * W + ix;
    return (
      (depth[i] * (1 - fx) + depth[i + 1] * fx) * (1 - fy) +
      (depth[i + W] * (1 - fx) + depth[i + W + 1] * fx) * fy
    );
  };
  const step = CENTRE_STEP_METERS / scale;
  // A way joining the line at a shallow angle runs into its band before the
  // junction: there it only keeps the line from merging into it at the
  // junction itself, so its segments that close to the junction are marked
  // `joining` (see below).
  const lineIndex = new Map(locations.map((loc, j) => [loc.join(), j]));
  const otherSegments = otherWays.flatMap((way) => {
    const points = way.map((loc) => project(loc, zoom));
    const fromJunction = points.map(() => Infinity);
    way.forEach((loc, k) => {
      const j = lineIndex.get(loc.join());
      if (j === undefined) return;
      const a = project(locations[Math.max(0, j - 1)], zoom),
        b = project(locations[Math.min(locations.length - 1, j + 1)], zoom);
      for (const step of [1, -1]) {
        const walked = [[k, 0]];
        for (let m = k, along = 0; m + step >= 0 && m + step < points.length && along < JOINING_WAY_METERS; m += step) {
          along += Math.hypot(points[m + step][0] - points[m][0], points[m + step][1] - points[m][1]) * scale;
          walked.push([m + step, along]);
        }
        if (walked.length < 2) continue;
        const end = points[walked[walked.length - 1][0]];
        const [cx, cy] = [end[0] - points[k][0], end[1] - points[k][1]];
        const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
        if (
          Math.abs(cx * dy - cy * dx) >=
          Math.sin((JOINING_WAY_DEGREES * Math.PI) / 180) * Math.hypot(cx, cy) * Math.hypot(dx, dy)
        )
          continue;
        for (const [m, along] of walked) fromJunction[m] = Math.min(fromJunction[m], along);
      }
    });
    // A segment crossing JOINING_WAY_METERS is split there.
    const joining = (a, b) => Object.assign([a, b], { joining: true });
    return points.slice(1).flatMap((b, k) => {
      const a = points[k],
        [da, db] = [fromJunction[k], fromJunction[k + 1]];
      if (Math.max(da, db) <= JOINING_WAY_METERS) return [joining(a, b)];
      if (Math.min(da, db) >= JOINING_WAY_METERS) return [[a, b]];
      const t = (JOINING_WAY_METERS - Math.min(da, db)) / (Math.max(da, db) - Math.min(da, db));
      const [near, far] = da < db ? [a, b] : [b, a];
      const cut = [near[0] + (far[0] - near[0]) * t, near[1] + (far[1] - near[1]) * t];
      return [joining(near, cut), [cut, far]];
    });
  });
  const nearestOn = (p, [a, b]) => {
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
    return [a[0] + t * dx, a[1] + t * dy];
  };
  const toSegment = (p, segment) => {
    const q = nearestOn(p, segment);
    return Math.hypot(p[0] - q[0], p[1] - q[1]);
  };
  const drawnPoints = locations.map((loc) => project(loc, zoom));
  const drawnSegments = drawnPoints.slice(1).map((b, k) => [drawnPoints[k], b]);
  const nearestDrawn = (p) => {
    let best = p,
      bestDistance = Infinity;
    for (const segment of drawnSegments) {
      const q = nearestOn(p, segment);
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d < bestDistance) {
        bestDistance = d;
        best = q;
      }
    }
    return best;
  };
  const near = Math.max(2, Math.round(TIP_NEAR_METERS / CENTRE_STEP_METERS)),
    far = Math.round(TIP_FAR_METERS / CENTRE_STEP_METERS);
  const isPinned = (record, k) =>
    k === 0 ||
    k === records.length - 1 ||
    (record.nodeIndex !== null && fixed.has(record.nodeIndex) && !free.has(record.nodeIndex));
  const out = [records[0]];
  for (let from = 0; from < records.length - 1; ) {
    let to = from + 1;
    while (!isPinned(records[to], to)) to++;
    const run = records.slice(from, to + 1);
    const points = run.map((record) => project(record.loc, zoom));
    let c = [points[0]];
    const sampleOf = [0];
    for (let k = 1; k < points.length; k++) {
      const [a, b] = [points[k - 1], points[k]];
      const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      for (let s = 1; s <= n; s++)
        c.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
      sampleOf.push(c.length - 1);
    }
    // Free fixed vertices ride the route like any other point, and stay vertices.
    // They start at their target, the move spread over the neighbours so that
    // it leaves no kink for the route to follow.
    const riders = new Map(
      run.flatMap((record, k) =>
        k > 0 && k < run.length - 1 && free.has(record.nodeIndex)
          ? [[sampleOf[k], record.nodeIndex]]
          : []
      )
    );
    for (const [sample, nodeIndex] of riders) {
      const target = free.get(nodeIndex);
      if (!target) continue;
      const [tx, ty] = project(target, zoom);
      const dx = tx - c[sample][0],
        dy = ty - c[sample][1];
      const span = Math.ceil((2 * Math.hypot(dx, dy)) / step) + 1;
      for (let k = -span; k <= span; k++) {
        const j = sample + k;
        if (j <= 0 || j >= c.length - 1) continue;
        const w = 1 - Math.abs(k) / (span + 1);
        c[j] = [c[j][0] + dx * w, c[j][1] + dy * w];
      }
    }
    const inBand = c
      .map((p) => depthAt(p[0], p[1]))
      .filter((d) => d > 0)
      .sort((x, y) => x - y);
    const halfWidth = inBand.length ? inBand[Math.floor(inBand.length / 2)] : 0;
    // Hairpin tips: one band half-width back from the band's end, straight out
    // from the turn. A hairpin still reads as one further out; a short hook
    // does not. The move is spread over the neighbours.
    const tips = [];
    const legs = (i, span) => [
      [c[i][0] - c[i - span][0], c[i][1] - c[i - span][1]],
      [c[i + span][0] - c[i][0], c[i + span][1] - c[i][1]],
    ];
    const nearTurn = (i) => turnDegrees(...legs(i, near));
    for (let i = near; i < c.length - near; i++) {
      const turn = nearTurn(i);
      if (turn < TIP_MIN_TURN_DEGREES) continue;
      if (i < far || i >= c.length - far) continue;
      if (turnDegrees(...legs(i, far)) < TIP_MIN_TURN_DEGREES) continue;
      let peak = true;
      for (let j = Math.max(near, i - near); j <= Math.min(c.length - near - 1, i + near); j++)
        if (nearTurn(j) > turn) peak = false;
      if (!peak) continue;
      const [u, v] = legs(i, near);
      const lengthU = Math.hypot(...u) || 1,
        lengthV = Math.hypot(...v) || 1;
      let ox = u[0] / lengthU - v[0] / lengthV,
        oy = u[1] / lengthU - v[1] / lengthV;
      const length = Math.hypot(ox, oy) || 1;
      ox /= length;
      oy /= length;
      let edge = 0;
      for (let d = 0; d <= TIP_EDGE_METERS / scale; d += 0.25) {
        if (depthAt(c[i][0] + ox * d, c[i][1] + oy * d) <= 0.05) break;
        edge = d;
      }
      const move = Math.max(0, edge - halfWidth);
      for (let k = -near * 2; k <= near * 2; k++) {
        const j = i + k;
        if (j <= 0 || j >= c.length - 1) continue;
        const w = 1 - Math.abs(k) / (near * 2 + 1);
        c[j] = [c[j][0] + ox * move * w, c[j][1] + oy * move * w];
      }
      tips.push(i);
      i += near;
    }
    const tipSet = new Set(tips);
    const origin = c.map((p) => p.slice());
    // The heat of each point's own trail, from the line before it is centred.
    const across = (i) => {
      const A = origin[Math.max(0, i - 4)],
        B = origin[Math.min(origin.length - 1, i + 4)];
      const length = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
      return [-(B[1] - A[1]) / length, (B[0] - A[0]) / length];
    };
    const ownHeat = origin.map((p, i) => {
      const [nx, ny] = across(i);
      let heat = 0;
      for (let o = -RIDGE_BASE_METERS / scale; o <= RIDGE_BASE_METERS / scale; o += 0.5)
        heat = Math.max(heat, sampleDensity(raster, [p[0] + nx * o, p[1] + ny * o]));
      return heat;
    });
    // The legs of a tip while their heat is merged show no ridge: keep them straight.
    const merged = new Uint8Array(c.length);
    for (const tip of tips)
      for (let k = 1; k <= 60; k++) {
        const A = c[tip - k],
          B = c[tip + k];
        if (!A || !B) break;
        let gap = false;
        const n = Math.ceil(Math.hypot(B[0] - A[0], B[1] - A[1]) * 2);
        for (let s = 0; s <= n && !gap; s++)
          gap =
            depthAt(A[0] + ((B[0] - A[0]) * s) / (n || 1), A[1] + ((B[1] - A[1]) * s) / (n || 1)) <= 0.3;
        if (gap) break;
        merged[tip - k] = merged[tip + k] = 1;
      }
    // The best continuous route along the ridge: score offsets across the line
    // at every sample, then take the route with the most heat and the smoothest
    // change of offset. Each column is scored against its own best, so a faint
    // trail counts as much as a bright one, and heat well above the point's own
    // trail scores badly, so the route stays off a stronger trail at a fork.
    if (c.length > 2) {
      const count = 2 * ROUTE_OFFSETS + 1;
      const offsetAt = (k) => ((k - ROUTE_OFFSETS) * ROUTE_OFFSET_METERS) / scale;
      const locked = (i) => i === 0 || i === c.length - 1 || tipSet.has(i) || merged[i];
      const scores = c.map((_, i) => {
        const column = new Float32Array(count);
        if (locked(i)) return column;
        const [nx, ny] = across(i);
        const limit = ownHeat[i] * RIDGE_MAX_RISE;
        // No closer to another mapped way than the line or its drawing already
        // is: the drawing shows which side of that way the trail is on, even
        // when both share one band. A joining way (see otherSegments) only
        // within otherWayFadeMeters: further out, it is in the line's band.
        const flank = SLIDE_DEFAULTS.otherWayFlankMeters / scale,
          fade = SLIDE_DEFAULTS.otherWayFadeMeters / scale;
        const [ox, oy] = origin[i];
        const reachOthers = flank + (ROUTE_OFFSETS * ROUTE_OFFSET_METERS) / scale;
        const nearby = otherSegments.filter(
          ([a, b]) =>
            Math.min(a[0], b[0]) - reachOthers <= ox &&
            Math.max(a[0], b[0]) + reachOthers >= ox &&
            Math.min(a[1], b[1]) - reachOthers <= oy &&
            Math.max(a[1], b[1]) + reachOthers >= oy
        );
        const drawn = nearestDrawn(origin[i]);
        const own = nearby.map((segment) =>
          Math.min(toSegment(origin[i], segment), toSegment(drawn, segment))
        );
        let best = 0;
        const plateau = new Float32Array(count);
        for (let k = 0; k < count; k++) {
          const o = offsetAt(k);
          const candidate = [ox + nx * o, oy + ny * o];
          if (
            nearby.some((segment, n) => {
              const away = toSegment(candidate, segment);
              return away < (segment.joining ? fade : flank) && away < own[n];
            })
          )
            continue;
          const heat = sampleDensity(raster, candidate);
          column[k] = heat <= limit ? heat : Math.max(0, 2 * limit - heat);
          best = Math.max(best, column[k]);
          if (heat >= SATURATED_HEAT) plateau[k] = depthAt(...candidate);
        }
        // Where the heat saturates it has no ridge: the middle of the flat top
        // is the point deepest inside the band.
        const deepest = Math.max(...plateau);
        if (best > ROUTE_MIN_HEAT)
          for (let k = 0; k < count; k++)
            column[k] = (deepest > 0 && plateau[k] ? plateau[k] / deepest : column[k] / best) ** ROUTE_SHARPNESS;
        else column.fill(0);
        return column;
      });
      const total = new Float32Array(count).fill(-Infinity);
      total[ROUTE_OFFSETS] = 0;
      const from = c.map(() => new Int8Array(count));
      let current = total;
      for (let i = 1; i < c.length; i++) {
        const next = new Float32Array(count).fill(-Infinity);
        for (let k = 0; k < count; k++) {
          if (locked(i) && k !== ROUTE_OFFSETS) continue;
          for (let d = -ROUTE_MAX_CHANGE; d <= ROUTE_MAX_CHANGE; d++) {
            const before = k + d;
            if (before < 0 || before >= count || current[before] === -Infinity) continue;
            const value = current[before] + scores[i][k] - ROUTE_CHANGE_COST * d * d;
            if (value > next[k]) {
              next[k] = value;
              from[i][k] = d;
            }
          }
        }
        current = next;
      }
      let k = ROUTE_OFFSETS;
      const chosen = new Array(c.length).fill(0);
      for (let i = c.length - 1; i > 0; i--) {
        chosen[i] = offsetAt(k);
        k += from[i][k];
      }
      // The offsets come in steps: even them out, or every step would keep a point.
      for (let pass = 0; pass < ROUTE_EVEN_PASSES; pass++) {
        const before = chosen.slice();
        for (let i = 1; i < c.length - 1; i++)
          if (!locked(i)) chosen[i] = before[i] / 2 + (before[i - 1] + before[i + 1]) / 4;
      }
      c = origin.map((p, i) => {
        const [nx, ny] = across(i);
        return [p[0] + nx * chosen[i], p[1] + ny * chosen[i]];
      });
    }
    // A stretch running backwards compared with the line before centring has
    // looped: put it back.
    const restore = new Set();
    for (let i = FOLD_SPAN_SAMPLES; i < c.length - FOLD_SPAN_SAMPLES; i++) {
      const [a, b] = [c[i - FOLD_SPAN_SAMPLES], c[i + FOLD_SPAN_SAMPLES]];
      const [p, q] = [origin[i - FOLD_SPAN_SAMPLES], origin[i + FOLD_SPAN_SAMPLES]];
      if ((b[0] - a[0]) * (q[0] - p[0]) + (b[1] - a[1]) * (q[1] - p[1]) < 0)
        for (let j = i - FOLD_RESTORE_SAMPLES; j <= i + FOLD_RESTORE_SAMPLES; j++) restore.add(j);
    }
    c = c.map((p, i) => (restore.has(i) && i > 0 && i < c.length - 1 ? origin[i].slice() : p));
    // Round each tip over a few points: a single vertex turning back counts as
    // a spike (see SPIKE_TURN_DEGREES in action.js).
    for (const tip of tips)
      for (let pass = 0; pass < 2; pass++) {
        const next = c.map((p) => p.slice());
        for (let j = Math.max(1, tip - 2); j <= Math.min(c.length - 2, tip + 2); j++)
          for (const axis of [0, 1])
            next[j][axis] = c[j][axis] / 2 + (c[j - 1][axis] + c[j + 1][axis]) / 4;
        c = next;
      }
    const keep = simplifyKeep(c, CENTRE_TOLERANCE_METERS / scale, raster);
    for (const tip of tips)
      for (const j of [tip - 2, tip, tip + 2]) if (j > 0 && j < c.length - 1) keep[j] = 1;
    for (const sample of riders.keys()) keep[sample] = 1;
    const kept = c.flatMap((_, i) => (keep[i] ? [i] : []));
    // Reuse the free original nodes, in order, for the nearest kept points. A
    // kept point nearer a later node is that node's: taking it would move a
    // node onto its neighbour's place and leave the neighbour without one.
    const nodeSamples = run.flatMap((record, k) =>
      k > 0 && k < run.length - 1 && record.nodeIndex !== null && !riders.has(sampleOf[k]) ? [k] : []
    );
    const owner = new Map([
      [0, run[0].nodeIndex],
      [kept[kept.length - 1], run[run.length - 1].nodeIndex],
      ...riders,
    ]);
    let nextKept = 1;
    for (let k = 1; k < run.length - 1; k++) {
      if (run[k].nodeIndex === null) continue;
      if (riders.has(sampleOf[k])) {
        nextKept = kept.indexOf(sampleOf[k]) + 1;
        continue;
      }
      let best = -1,
        bestDistance = Infinity;
      for (let j = nextKept; j < kept.length - 1; j++) {
        if (riders.has(kept[j])) continue;
        const d = Math.hypot(c[kept[j]][0] - points[k][0], c[kept[j]][1] - points[k][1]);
        const later = nodeSamples.some(
          (m) => m > k && Math.hypot(c[kept[j]][0] - points[m][0], c[kept[j]][1] - points[m][1]) < d
        );
        if (!later && d < bestDistance) {
          bestDistance = d;
          best = j;
        }
      }
      if (best === -1) continue;
      owner.set(kept[best], run[k].nodeIndex);
      nextKept = best + 1;
    }
    for (let j = 1; j < kept.length; j++) {
      const i = kept[j];
      out.push({
        loc: j === kept.length - 1 ? run[run.length - 1].loc : unproject(c[i], zoom),
        nodeIndex: owner.get(i) ?? null,
      });
    }
    from = to;
  }
  return out;
}

export async function slideLineTwice(locations, raster, options = {}) {
  // Fixed vertices that may move settle first: the trace and the smoothing take
  // the line's shape from its fixed vertices, so moving them afterwards leaves
  // dents. One run finds their places, a second traces through them.
  if (options.movableIndices?.length && !options.findingPlaces) {
    const movableNodes = new Set(options.movableIndices);
    const placed = await slideLineTwice(locations, raster, { ...options, findingPlaces: true });
    const settled = locations.slice();
    const scale = metersPerPixel(locations[0][1], raster.zoom);
    const line = placed.map((point) => project(point.loc, raster.zoom));
    // Where the line is `metres` along from point k, in `direction`.
    const along = (k, direction, metres) => {
      let left = metres / scale,
        i = k;
      while (i + direction >= 0 && i + direction < line.length) {
        const [a, b] = [line[i], line[i + direction]];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (length >= left)
          return [a[0] + ((b[0] - a[0]) * left) / length, a[1] + ((b[1] - a[1]) * left) / length];
        left -= length;
        i += direction;
      }
      return null;
    };
    for (const [k, point] of placed.entries()) {
      if (!movableNodes.has(point.nodeIndex)) continue;
      settled[point.nodeIndex] = point.loc;
      // At a T, the side band's heat pulls the middle towards it. Where the line
      // runs straight and only ends of other ways join it, the node belongs on
      // the through band, whose centre shows clearly away from the junction.
      const original = locations[point.nodeIndex];
      if (
        !otherWaysEndAt(original, options.otherWays || []) ||
        !(options.otherWays || []).some((way) => way.some((o) => o[0] === original[0] && o[1] === original[1]))
      )
        continue;
      const before = along(k, -1, THROUGH_BAND_METERS),
        after = along(k, 1, THROUGH_BAND_METERS);
      if (!before || !after) continue;
      const here = line[k];
      const turn = turnDegrees(
        [here[0] - before[0], here[1] - before[1]],
        [after[0] - here[0], after[1] - here[1]]
      );
      if (turn > THROUGH_BAND_MAX_TURN_DEGREES) continue;
      const length = Math.hypot(after[0] - before[0], after[1] - before[1]) || 1;
      const ux = (after[0] - before[0]) / length,
        uy = (after[1] - before[1]) / length;
      // Across the chord, the through band follows a parabola fitted to the line
      // further out on both sides: on a curving road the chord itself runs
      // inside the bend, and would pull the node off the band.
      const samples = [
        before,
        after,
        along(k, -1, THROUGH_BAND_FIT_METERS),
        along(k, 1, THROUGH_BAND_FIT_METERS),
      ]
        .filter(Boolean)
        .map((p) => {
          const [px, py] = [p[0] - before[0], p[1] - before[1]];
          return [px * ux + py * uy, py * ux - px * uy];
        });
      const x = (here[0] - before[0]) * ux + (here[1] - before[1]) * uy;
      const [a, b, c] = samples.length > 2 ? fitParabola(samples) : [0, 0, 0];
      const y = a + b * x + c * x * x;
      settled[point.nodeIndex] = unproject(
        [before[0] + ux * x - uy * y, before[1] + uy * x + ux * y],
        raster.zoom
      );
    }
    // A node only moves onto heat: without any, nothing says where it belongs.
    // Other ways' geometry and the line's course alone can lead into the dark.
    for (const i of movableNodes)
      if (sampleDensity(raster, project(settled[i], raster.zoom)) < MOVE_FIXED_MIN_HEAT)
        settled[i] = locations[i];
    // The other ways share those vertices, and move with them.
    const movedTo = new Map(locations.map((loc, i) => [loc.join(), settled[i]]));
    const otherWays = (options.otherWays || []).map((way) =>
      way.map((loc) => movedTo.get(loc.join()) ?? loc)
    );
    return slideLineTwice(settled, raster, { ...options, movableIndices: [], otherWays });
  }
  const half = (offset) => (value) => options.onProgress?.(offset + value / 2);
  let first = await slideLine(locations, raster, { ...options, onProgress: half(0) });
  if (first.length > 1000) return first;
  const fixed = new Set(options.fixedIndices || []);
  const limited = new Set(options.limitedIndices || []);
  // Drawn points next to a junction that found no trail, while the line
  // further on is on it: near the other way its heat is masked, so they are
  // the drawing's approach to the junction, not a part without heat. Drop
  // them and slide again, so the trail is traced into the junction.
  const stubs = junctionStubs(first, locations, fixed, options.otherWays || []);
  if (stubs.size) {
    const kept = locations.flatMap((_, i) => (stubs.has(i) ? [] : [i]));
    const position = new Map(kept.map((i, k) => [i, k]));
    const remap = (indices) => (indices || []).flatMap((i) => (position.has(i) ? [position.get(i)] : []));
    const again = await slideLine(
      kept.map((i) => locations[i]),
      raster,
      {
        ...options,
        fixedIndices: remap(options.fixedIndices),
        limitedIndices: remap(options.limitedIndices),
        onProgress: half(0),
      }
    );
    first = Object.assign(
      again.map((record) => ({ ...record, nodeIndex: record.nodeIndex === null ? null : kept[record.nodeIndex] })),
      { skipped: again.skipped }
    );
  }
  // What the first pass left as drawn stays as drawn: its vertices are fixed
  // and its sections are not traced again (no points are added there).
  const second = await slideLine(
    first.map((record) => record.loc),
    raster,
    {
      ...options,
      fixedIndices: first.flatMap((record, i) =>
        fixed.has(record.nodeIndex) || record.drawn ? [i] : []
      ),
      untracedSections: first.flatMap((record, i) => (record.untraced ? [i] : [])),
      holdBends: false,
      // Its vertices are already on the trail: re-centre them a little, never
      // climb to another part of the band (on a tight bend, the normal from
      // the first pass's dense points can point anywhere).
      alignMeters: SECOND_PASS_ALIGN_METERS,
      limitedIndices: first.flatMap((record, i) =>
        limited.has(record.nodeIndex) ? [i] : []
      ),
      limitedOrigins: Object.fromEntries(
        first.flatMap((record, i) =>
          limited.has(record.nodeIndex) ? [[i, locations[record.nodeIndex]]] : []
        )
      ),
      onProgress: half(0.5),
    }
  );
  // Smoothing clears the trace's short hooks, but pulls the line inside bends;
  // centring then brings it back onto the ridge.
  const smoothed = smoothLine(
    second.map((record) => ({
      loc: record.loc,
      nodeIndex: record.nodeIndex === null ? null : first[record.nodeIndex].nodeIndex,
      drawn: record.drawn,
    })),
    raster
  );
  const otherWays = options.otherWays || [];
  const movable = new Set(options.movableIndices || []);
  const free = new Map();
  const isJunction = (loc) => otherWays.some((way) => way.some((o) => o[0] === loc[0] && o[1] === loc[1]));
  if (movable.size) {
    const depth = bandDepth(raster);
    const depthAt = ([x, y]) => {
      const px = Math.max(0, Math.min(raster.width - 2, x - raster.x)),
        py = Math.max(0, Math.min(raster.height - 2, y - raster.y));
      const ix = Math.floor(px),
        iy = Math.floor(py),
        fx = px - ix,
        fy = py - iy,
        i = iy * raster.width + ix;
      return (
        (depth[i] * (1 - fx) + depth[i + 1] * fx) * (1 - fy) +
        (depth[i + raster.width] * (1 - fx) + depth[i + raster.width + 1] * fx) * fy
      );
    };
    const heatAt = (point) => sampleDensity(raster, point);
    // Junctions slide along the way they share, to the intersection detected
    // on the heatmap, one node per intersection. Free ends climb the heat.
    const scale = metersPerPixel(locations[0][1], raster.zoom);
    const reach = MOVE_FIXED_METERS / scale;
    const tracking = await trackingSurface(raster, scale, {
      yield: async () => {},
      signal: options.signal,
    });
    const claimed = new Map();
    for (const point of detectJunctions(raster, tracking, scale)) {
      let best = null,
        bestDistance = reach;
      for (const record of smoothed) {
        if (!movable.has(record.nodeIndex) || !isJunction(record.loc)) continue;
        const [x, y] = project(record.loc, raster.zoom);
        const distance = Math.hypot(x - point[0], y - point[1]);
        if (distance < bestDistance) {
          best = record;
          bestDistance = distance;
        }
      }
      if (best && (!claimed.has(best) || bestDistance < claimed.get(best).distance))
        claimed.set(best, { point, distance: bestDistance });
    }
    // The line's course past a node, leaving out the node's own surroundings.
    // At the line's end, its direction carried on past the end. A node that
    // stays ends it: the line passes there, wherever the heat beyond it goes.
    const stays = (record) => fixed.has(record.nodeIndex) && !movable.has(record.nodeIndex);
    const courseAt = (k) => {
      const pixels = smoothed.map((record) => project(record.loc, raster.zoom));
      const walk = (direction) => {
        let along = 0,
          i = k;
        while (
          i + direction >= 0 &&
          i + direction < pixels.length &&
          along < COURSE_METERS / scale &&
          !(i !== k && stays(smoothed[i]))
        ) {
          along += Math.hypot(
            pixels[i + direction][0] - pixels[i][0],
            pixels[i + direction][1] - pixels[i][1]
          );
          i += direction;
        }
        return pixels[i];
      };
      const before = walk(-1),
        after = walk(1);
      const past = (from) => {
        const length = Math.hypot(pixels[k][0] - from[0], pixels[k][1] - from[1]) || 1;
        return [
          pixels[k][0] + ((pixels[k][0] - from[0]) / length) * reach,
          pixels[k][1] + ((pixels[k][1] - from[1]) / length) * reach,
        ];
      };
      if (k === 0) return [past(after), after];
      if (k === pixels.length - 1) return [before, past(before)];
      return [before, after];
    };
    const original = smoothed.map((record) => record.loc);
    // In a merged hairpin the middle of the band can be nearer the opposite leg:
    // a node must stay on its own stretch of the line.
    const originalPixels = original.map((loc) => project(loc, raster.zoom));
    const alongLine = [0];
    for (let k = 1; k < originalPixels.length; k++)
      alongLine.push(
        alongLine[k - 1] +
          Math.hypot(
            originalPixels[k][0] - originalPixels[k - 1][0],
            originalPixels[k][1] - originalPixels[k - 1][1]
          )
      );
    const landsOnOtherStretch = (target, k) => {
      const point = project(target, raster.zoom);
      const moved = Math.hypot(point[0] - originalPixels[k][0], point[1] - originalPixels[k][1]);
      for (let j = 1; j < originalPixels.length; j++) {
        if (Math.abs(alongLine[j] - alongLine[k]) <= OWN_STRETCH_METERS / scale) continue;
        if (distanceToSegment(point, originalPixels[j - 1], originalPixels[j]) < moved) return true;
      }
      return false;
    };
    for (const [k, record] of smoothed.entries()) {
      if (!movable.has(record.nodeIndex)) continue;
      if (isJunction(original[k]) && otherWaysEndAt(original[k], otherWays)) {
        // On the intersection detected on the heatmap, if there is one close by.
        const detected = claimed.get(record);
        // Only where the line really turns at it: a line running straight past
        // an intersection rides onto the ridge with its node instead of bending.
        const course = courseAt(k);
        const inner = k > 0 && k < smoothed.length - 1;
        const turnsHere =
          turnDegrees(
            [originalPixels[k][0] - course[0][0], originalPixels[k][1] - course[0][1]],
            [course[1][0] - originalPixels[k][0], course[1][1] - originalPixels[k][1]]
          ) >= JUNCTION_MAX_TURN_DEGREES;
        if (
          detected &&
          detected.distance <= JUNCTION_SNAP_METERS / scale &&
          (inner
            ? turnsHere
            : distanceToSegment(detected.point, course[0], course[1]) * scale <= COURSE_SIDEWAYS_METERS)
        ) {
          record.loc = unproject(detected.point, raster.zoom);
          continue;
        }
        let target = climbBand(raster, record.loc, depthAt, () => MOVE_FIXED_MIN_GAIN);
        if (target && landsOnOtherStretch(target, k)) target = null;
        // Between the legs of a hairpin the bands merge and the band is deepest,
        // but the heat dips: the node would leave its trail.
        if (
          target &&
          sampleDensity(raster, project(target, raster.zoom)) <
            MOVE_FIXED_KEEP_HEAT * sampleDensity(raster, project(record.loc, raster.zoom))
        )
          target = null;
        if (k === 0 || k === smoothed.length - 1) record.loc = target ?? record.loc;
        else free.set(record.nodeIndex, target);
        continue;
      }
      const moved = isJunction(original[k])
        ? slideJunction(
            raster,
            record.loc,
            alongOtherWay(original[k], otherWays, raster.zoom, reach),
            courseAt(k)
          )
        : climbBand(
            raster,
            record.loc,
            heatAt,
            (value) => value * 0.01,
            RIDGE_MAX_RISE * hottestHeat(raster, record.loc)
          );
      record.loc = moved ?? record.loc;
    }
  }
  const result = centreOnBand(smoothed, raster, fixed, otherWays, locations, free);
  result.skipped = first.skipped;
  return result;
}

// Smooth the slid line's turns: the heatmap is too coarse to show the curve of
// a bend, and the traced corners look wrong on the map. Each free stretch
// (between vertices that stay as drawn, `drawn`, and the ends) is resampled
// every SMOOTH_STEP_METERS and smoothed by SMOOTH_PASSES rounds of moving
// each sample halfway to its neighbours' average (a few metres of
// rounding), with the stretch's ends pinned. If a sample loses more than half
// of its heat (it left the trail), the stretch is smoothed half as much, up to
// three times, else left as traced. The curve is then simplified finely
// (SMOOTH_TOLERANCE_METERS), so bends get many points and straight parts few;
// original vertices of the stretch are reused, in order, for the nearest
// points, so their OSM nodes are kept.
const SMOOTH_STEP_METERS = 1.5;
const SMOOTH_PASSES = 24;
const SMOOTH_TOLERANCE_METERS = 0.4;
const SMOOTH_MIN_HEAT = 0.5;
function smoothLine(records, raster) {
  const zoom = raster.zoom;
  const scale = metersPerPixel(records[0].loc[1], zoom);
  const step = SMOOTH_STEP_METERS / scale;
  const pinned = records.map(
    (record, k) => k === 0 || k === records.length - 1 || Boolean(record.drawn)
  );
  const result = [records[0]];
  for (let from = 0; from < records.length - 1; ) {
    let to = from + 1;
    while (!pinned[to]) to++;
    const run = records.slice(from, to + 1);
    result.push(...smoothRun(run, raster, step, scale).slice(1));
    from = to;
  }
  return result;
}

function smoothRun(run, raster, step, scale) {
  if (run.length < 3) return run;
  const zoom = raster.zoom;
  const points = run.map((record) => project(record.loc, zoom));
  // Resample along the line; remember where each original point falls.
  const samples = [points[0]],
    at = [0];
  for (let k = 1; k < points.length; k++) {
    const [a, b] = [points[k - 1], points[k]];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(length / step));
    for (let s = 1; s <= n; s++)
      samples.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
    at.push(samples.length - 1);
  }
  const heat = samples.map((p) => sampleDensity(raster, p) * SMOOTH_MIN_HEAT);
  let smooth = null;
  for (let passes = SMOOTH_PASSES; passes >= SMOOTH_PASSES / 8 && !smooth; passes /= 2) {
    let current = samples.map((p) => p.slice());
    for (let pass = 0; pass < passes; pass++) {
      const next = current.map((p) => p.slice());
      for (let i = 1; i < current.length - 1; i++)
        for (const axis of [0, 1])
          next[i][axis] =
            current[i][axis] / 2 + (current[i - 1][axis] + current[i + 1][axis]) / 4;
      current = next;
    }
    if (current.every((p, i) => sampleDensity(raster, p) >= heat[i])) smooth = current;
  }
  if (!smooth) return run;
  const keep = simplifyKeep(smooth, SMOOTH_TOLERANCE_METERS / scale, raster);
  const kept = smooth.flatMap((p, i) => (keep[i] ? [i] : []));
  // Reuse the original vertices (their OSM nodes) for the nearest kept points,
  // in order; the run's two ends keep theirs.
  const owner = new Map([
    [0, run[0].nodeIndex],
    [kept[kept.length - 1], run[run.length - 1].nodeIndex],
  ]);
  let next = 1;
  for (let k = 1; k < run.length - 1; k++) {
    if (run[k].nodeIndex === null) continue;
    let best = -1;
    for (let j = next; j < kept.length - 1; j++)
      if (best === -1 || Math.abs(kept[j] - at[k]) < Math.abs(kept[best] - at[k])) best = j;
    if (best === -1) break;
    if (!owner.has(kept[best])) owner.set(kept[best], run[k].nodeIndex);
    next = best + 1;
  }
  return kept.map((i, j) => ({
    loc: j === 0 ? run[0].loc : j === kept.length - 1 ? run[run.length - 1].loc : unproject(smooth[i], zoom),
    nodeIndex: owner.get(i) ?? null,
    drawn: j === 0 ? run[0].drawn : j === kept.length - 1 ? run[run.length - 1].drawn : undefined,
  }));
}
