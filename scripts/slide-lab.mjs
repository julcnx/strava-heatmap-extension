// Slide lab: run Strava Slide on an OSM way outside iD, to test and tune the
// algorithm on real lines.
//
//   npm run slide-lab                      → server on http://localhost:8765, then
//                                            open scripts/slide-lab.html (file://)
//   npm run slide-lab -- 223115682 438832711 → render .slide-lab/out/<id>.png
//
//   npm run slide-lab:check [-- ids]       → slide every way of the lab list (or
//                                            the given ones) and compare with
//                                            scripts/slide-lab-snapshots.json
//   npm run slide-lab:accept [-- ids]      → record the current results there
//
// Options: --activity=run (default all), --dump (print points in PNG pixels),
// --move-ends (let junction ends move, see slide()), --once (one Slide pass,
// for debugging).
//
// OSM data comes from the public API. Strava tiles come from the web page:
// open it from disk (the extension does not add the Strava cookies for
// localhost pages) in the browser where the extension is logged in; the page
// fetches the tiles the server is missing and uploads them. After that, the
// CLI works on the cached tiles. Optional fallback: put the strava.com cookies
// (`_strava_idcf=…; CloudFront-Key-Pair-Id=…; CloudFront-Policy=…;
// CloudFront-Signature=…`) in .slide-lab/cookies.txt.
// Tiles and OSM data are cached in .slide-lab/ (gitignored): delete
// .slide-lab/osm to reload changed ways.
//
// The pipeline mirrors the operation in src/clients/www.openstreetmap.org/slide/index.js:
// keep both in sync.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import {
  createHeatmapRaster,
  project,
  sampleDensity,
  SLIDE_DEFAULTS,
  slideLine,
  slideLineTwice,
} from '../src/clients/www.openstreetmap.org/slide/algorithm.js';
import {
  cleanSlideResult,
  fixedIndices,
  getSlideSelection,
  isStructure,
} from '../src/clients/www.openstreetmap.org/slide/action.js';
import { loadSlideTiles } from '../src/clients/www.openstreetmap.org/slide/tiles.js';
import { PALETTES } from '../src/clients/common/palettes.js';

const DIR = path.resolve(import.meta.dirname, '..', '.slide-lab');
const PORT = 8765;
const USER_AGENT = 'strava-heatmap-extension slide-lab';

// --- Strava tiles: disk cache in front of fetch --------------------------------

const tileFile = (activity, z, x, y) =>
  path.join(DIR, 'tiles', activity, `${z}`, `${x}`, `${y}.png`);

function cookies() {
  if (process.env.STRAVA_COOKIES) return process.env.STRAVA_COOKIES.trim();
  const file = path.join(DIR, 'cookies.txt');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
}

// Store a tile: its bytes, or null when Strava has no tile there (404/410).
function saveTile(activity, z, x, y, bytes) {
  const file = tileFile(activity, z, x, y);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (bytes) fs.writeFileSync(file, bytes);
  else fs.writeFileSync(`${file}.404`, '');
}

// Tiles not cached yet, collected while sliding, for the page to upload.
let missing = null;

// Returns the tile bytes, null when Strava has no tile there, or undefined
// when it is not cached and there are no cookies (recorded in `missing`).
async function stravaTile(activity, z, x, y) {
  const file = tileFile(activity, z, x, y);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  if (fs.existsSync(`${file}.404`)) return null;
  if (!cookies()) {
    missing?.push({ activity, z, x, y });
    return undefined;
  }
  const url = `https://content-a.strava.com/identified/globalheat/${activity}/grayscale/${z}/${x}/${y}.png?v=20&missing=empty`;
  const response = await originalFetch(url, { headers: { Cookie: cookies() } });
  if (response.status === 404 || response.status === 410) {
    saveTile(activity, z, x, y, null);
    return null;
  }
  if (!response.ok) throw new Error(`Strava tile HTTP ${response.status} (cookies expired?)`);
  const bytes = Buffer.from(await response.arrayBuffer());
  saveTile(activity, z, x, y, bytes);
  return bytes;
}

// tiles.js fetches the tile URLs itself: answer them from the cache. A tile
// that is not cached reads as missing, so the run still lists every tile it
// needs (a missing tile also lists its parent, harmless).
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const match = String(url).match(
    /^https:\/\/content-a\.strava\.com\/identified\/globalheat\/([^/]+)\/grayscale\/(\d+)\/(\d+)\/(\d+)\.png/
  );
  if (!match) return originalFetch(url, options);
  const bytes = await stravaTile(match[1], ...match.slice(2).map(Number));
  return bytes ? new Response(bytes) : new Response(null, { status: 404 });
};

class MissingTiles extends Error {
  constructor(tiles) {
    super(`${tiles.length} Strava tiles not cached: open this way in the slide lab page.`);
    this.tiles = tiles;
  }
}

// --- OSM data: a minimal stand-in for iD's graph -------------------------------

async function osmJSON(urlPath, cacheName) {
  const file = path.join(DIR, 'osm', cacheName);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const response = await originalFetch(`https://api.openstreetmap.org/api/0.6/${urlPath}`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!response.ok) throw new Error(`OSM API HTTP ${response.status} for ${urlPath}`);
  const data = await response.json();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

class Way {
  constructor(id, nodes, tags) {
    Object.assign(this, { id, nodes, tags, type: 'way' });
  }
  isClosed() {
    return this.nodes.length > 2 && this.nodes[0] === this.nodes[this.nodes.length - 1];
  }
  // Simplified iD rule: Slide only needs to tell lines from areas.
  geometry() {
    return this.isClosed() &&
      (this.tags.area === 'yes' ||
        (this.tags.area !== 'no' &&
          !this.tags.highway &&
          !this.tags.barrier &&
          ['building', 'landuse', 'natural', 'leisure', 'amenity'].some((k) => this.tags[k])))
      ? 'area'
      : 'line';
  }
}

class Graph {
  constructor(elements) {
    this.entities = {};
    this.wayParents = {};
    this.relationParents = {};
    for (const e of elements) {
      if (e.type === 'node') {
        this.entities[`n${e.id}`] = {
          id: `n${e.id}`,
          type: 'node',
          loc: [e.lon, e.lat],
          tags: e.tags || {},
        };
      } else if (e.type === 'way') {
        const way = new Way(`w${e.id}`, e.nodes.map((id) => `n${id}`), e.tags || {});
        this.entities[way.id] = way;
        for (const id of new Set(way.nodes)) (this.wayParents[id] ||= []).push(way);
      } else if (e.type === 'relation') {
        for (const m of e.members) {
          if (m.type === 'node') (this.relationParents[`n${m.ref}`] ||= []).push(e);
          if (m.type === 'way') (this.relationParents[`w${m.ref}`] ||= []).push(e);
        }
      }
    }
  }
  entity(id) {
    return this.entities[id];
  }
  hasEntity(id) {
    return this.entities[id];
  }
  parentWays(node) {
    return this.wayParents[node.id] || [];
  }
  parentRelations(node) {
    return this.relationParents[node.id] || [];
  }
  childNodes(way) {
    return way.nodes.map((id) => this.entities[id]);
  }
}

async function loadGraph(wayId) {
  const full = await osmJSON(`way/${wayId}/full.json`, `way-${wayId}.json`);
  const nodes = full.elements.filter((e) => e.type === 'node');
  const pad = 0.0015; // ~150 m, more than the 80 m search radius
  const bbox = [
    Math.min(...nodes.map((n) => n.lon)) - pad,
    Math.min(...nodes.map((n) => n.lat)) - pad,
    Math.max(...nodes.map((n) => n.lon)) + pad,
    Math.max(...nodes.map((n) => n.lat)) + pad,
  ];
  const map = await osmJSON(`map.json?bbox=${bbox.join(',')}`, `map-${wayId}.json`);
  return new Graph(map.elements);
}

// --- Slide pipeline (mirrors index.js) -----------------------------------------

// The line's first and last points stay fixed, like in index.js. `moveEnds`:
// experiment, they may move up to the snap radius, even when they are
// junctions.
export async function slide(wayId, activity, { moveEnds = false, once = false } = {}) {
  const started = Date.now();
  const graph = await loadGraph(wayId);
  const selection = getSlideSelection(graph, [`w${wayId}`]);
  if (!selection) throw new Error('Slide does not support this way (area, repeated node…).');
  if (isStructure(selection.way)) throw new Error('Slide does not move bridges or tunnels.');
  const locations = selection.nodes.map((node) => node.loc);
  // Other highways whose bounding box meets the line's, padded like index.js.
  const padDeg = SLIDE_DEFAULTS.maxSearchRadiusMeters / 111000;
  const lons = locations.map((l) => l[0]),
    lats = locations.map((l) => l[1]);
  const box = [
    Math.min(...lons) - padDeg / Math.cos((lats[0] * Math.PI) / 180),
    Math.min(...lats) - padDeg,
    Math.max(...lons) + padDeg / Math.cos((lats[0] * Math.PI) / 180),
    Math.max(...lats) + padDeg,
  ];
  const others = Object.values(graph.entities)
    .filter(
      (e) =>
        e.type === 'way' &&
        e.id !== selection.way.id &&
        e.tags.highway &&
        (!e.tags.tunnel || e.tags.tunnel === 'no')
    )
    .map((way) => ({
      id: way.id.slice(1),
      label: way.tags.name || way.tags.highway,
      locs: way.nodes.flatMap((id) => (graph.hasEntity(id) ? [graph.entity(id).loc] : [])),
    }))
    .filter(
      ({ locs }) =>
        locs.length &&
        Math.min(...locs.map((l) => l[0])) <= box[2] &&
        Math.max(...locs.map((l) => l[0])) >= box[0] &&
        Math.min(...locs.map((l) => l[1])) <= box[3] &&
        Math.max(...locs.map((l) => l[1])) >= box[1]
    );
  const source = {
    url: ([x, y, z]) =>
      `https://content-a.strava.com/identified/globalheat/${activity}/grayscale/${z}/${x}/${y}.png?v=20&missing=empty`,
  };
  const signal = new AbortController().signal;
  missing = [];
  let loaded;
  try {
    loaded = await loadSlideTiles(locations, source, signal);
  } finally {
    const tiles = missing;
    missing = null;
    // Only z15 tiles: a parent is needed only if its child turns out empty.
    const wanted = tiles.filter((t) => t.z === 15);
    if (tiles.length) throw new MissingTiles(wanted.length ? wanted : tiles);
  }
  const raster = createHeatmapRaster(loaded.tiles, loaded.zoom, loaded.bounds);
  const last = selection.nodes.length - 1;
  const fixed = moveEnds
    ? fixedIndices(graph, selection).filter(
        (i) =>
          (i !== 0 && i !== last) ||
          Object.keys(selection.nodes[i].tags).length ||
          graph.parentRelations(selection.nodes[i]).length
      )
    : [...new Set([0, last, ...fixedIndices(graph, selection)])];
  const result = await (once ? slideLine : slideLineTwice)(locations, raster, {
    fixedIndices: fixed,
    limitedIndices: moveEnds ? [0, last] : [],
    otherWays: others.map((other) => other.locs),
    signal,
  });
  const cleaned = cleanSlideResult(graph, selection, result);
  // Junction ends that moved: in iD, the connected ways would bend with them.
  const movedJunctions = cleaned.flatMap((p) =>
    p.nodeIndex !== null &&
    graph.parentWays(selection.nodes[p.nodeIndex]).length > 1 &&
    (p.loc[0] !== locations[p.nodeIndex][0] || p.loc[1] !== locations[p.nodeIndex][1])
      ? [{ from: locations[p.nodeIndex], to: p.loc }]
      : []
  );
  // Why each fixed vertex stays, for the page's tooltips (the rules of
  // fixedIndices in action.js, and index.js keeping the line's ends).
  const name = (e) =>
    e.tags.name ||
    ['highway', 'waterway', 'railway', 'man_made', 'natural', 'landuse', 'boundary', 'barrier', 'type']
      .filter((k) => e.tags[k])
      .map((k) => `${k}=${e.tags[k]}`)[0] ||
    'untagged';
  const fixedWhy = Object.fromEntries(
    fixed.map((i) => {
      const node = selection.nodes[i];
      const why = [];
      if (i === 0 || i === last) why.push('Line end: ends stay in place for now');
      const tags = Object.entries(node.tags).map(([k, v]) => `${k}=${v}`);
      if (tags.length) why.push(`Tagged node: ${tags.join(', ')}`);
      // An untagged way takes its meaning from its relations (a boundary, an
      // area's outer ring).
      const label = (w) =>
        Object.keys(w.tags).length || !graph.parentRelations(w).length
          ? name(w)
          : `edge of ${graph.parentRelations(w).map((r) => `${r.tags.boundary || r.tags.type} ${r.tags.name || name(r)}`).join(' / ')}`;
      const ways = graph.parentWays(node).filter((w) => w.id !== selection.way.id);
      if (ways.length)
        why.push(`Junction with ${ways.map((w) => `${label(w)} (${w.id.slice(1)})`).join(', ')}`);
      const relations = graph.parentRelations(node);
      if (relations.length)
        why.push(`Member of ${relations.map((r) => `${name(r)} (relation ${r.id})`).join(', ')}`);
      return [i, why];
    })
  );
  return {
    wayId,
    activity,
    tags: selection.way.tags,
    original: locations,
    fixed,
    fixedWhy,
    result: cleaned.map((p) => ({ loc: p.loc, nodeIndex: p.nodeIndex })),
    movedJunctions,
    raw: result.map((p) => ({ loc: p.loc, nodeIndex: p.nodeIndex })),
    others,
    raster,
    stats: {
      pointsBefore: locations.length,
      pointsAfter: cleaned.length,
      fixed: fixed.length,
      skipped: result.skipped || 0,
      movedJunctions: movedJunctions.length,
      alongOther: cleaned.alongOther || 0,
      ms: Date.now() - started,
    },
  };
}

// --- PNG render: heat as the algorithm sees it, plus the lines -----------------

function encodePNG(width, height, rgb) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function render(run) {
  const { raster } = run;
  // Crop to the line plus a margin, scaled so the image is at most ~1400 px.
  const pts = run.original.concat(run.result.map((p) => p.loc)).map((l) => project(l, raster.zoom));
  const margin = 40;
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0])) - raster.x - margin));
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1])) - raster.y - margin));
  const x1 = Math.min(raster.width, Math.ceil(Math.max(...pts.map((p) => p[0])) - raster.x + margin));
  const y1 = Math.min(raster.height, Math.ceil(Math.max(...pts.map((p) => p[1])) - raster.y + margin));
  const scale = Math.max(1, Math.min(6, Math.floor(1400 / Math.max(x1 - x0, y1 - y0))));
  const width = (x1 - x0) * scale,
    height = (y1 - y0) * scale;
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y0 + Math.floor(y / scale)) * raster.width + x0 + Math.floor(x / scale);
      const v = Math.round(255 * Math.sqrt(raster.density[i]));
      const o = (y * width + x) * 3;
      if (raster.coverage[i]) rgb.fill(v, o, o + 3);
      else rgb.set([60, 0, 0], o); // no heatmap tile
    }
  }
  const toPx = (loc) => {
    const p = project(loc, raster.zoom);
    return [(p[0] - raster.x - x0) * scale, (p[1] - raster.y - y0) * scale];
  };
  run.toPx = toPx;
  const dot = (cx, cy, r, color) => {
    for (let y = Math.round(cy - r); y <= cy + r; y++)
      for (let x = Math.round(cx - r); x <= cx + r; x++)
        if (x >= 0 && y >= 0 && x < width && y < height && (x - cx) ** 2 + (y - cy) ** 2 <= r * r)
          rgb.set(color, (y * width + x) * 3);
  };
  const line = (locs, color, r) => {
    for (let i = 1; i < locs.length; i++) {
      const [ax, ay] = toPx(locs[i - 1]),
        [bx, by] = toPx(locs[i]);
      const steps = Math.ceil(Math.hypot(bx - ax, by - ay));
      for (let s = 0; s <= steps; s++)
        dot(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps, r, color);
    }
  };
  for (const other of run.others) line(other.locs, [90, 90, 160], 1);
  line(run.original, [255, 60, 240], 1);
  for (const loc of run.original) dot(...toPx(loc), 2.5, [255, 60, 240]);
  line(run.result.map((p) => p.loc), [125, 255, 58], 1);
  for (const p of run.result) dot(...toPx(p.loc), 2.5, [125, 255, 58]);
  for (const i of run.fixed) dot(...toPx(run.original[i]), 4, [255, 255, 255]);
  for (const { from, to } of run.movedJunctions) {
    line([from, to], [255, 220, 0], 1);
    dot(...toPx(to), 4, [255, 220, 0]);
  }
  return encodePNG(width, height, rgb);
}

// The page's current view, drawn like the page (orange heat on black, the
// same line colours), for Shift+S screenshots: the page cannot read back the
// Strava tiles it shows. `bbox` is [west, south, east, north].
const ORANGE = Buffer.from(PALETTES.orange, 'hex');
// A 5×7 pixel font, just enough to label a screenshot with its way.
const GLYPHS = {
  0: '01110100011001110101110011000101110',
  1: '00100011000010000100001000010001110',
  2: '01110100010000100010001000100011111',
  3: '11110000010000101110000010000111110',
  4: '00010001100101010010111110001000010',
  5: '11111100001111000001000011000101110',
  6: '00110010001000011110100011000101110',
  7: '11111000010001000100010000100001000',
  8: '01110100011000101110100011000101110',
  9: '01110100011000101111000010001001100',
  w: '00000000001000110001101011010101010',
  a: '00000000000111000001011111000101111',
  y: '00000000001000110001011110000101110',
  ' ': '00000000000000000000000000000000000',
};
function label(rgb, width, height, text, size) {
  const pad = 2 * size,
    boxW = text.length * 6 * size + pad * 2 - size,
    boxH = 7 * size + pad * 2;
  for (let y = 0; y < Math.min(boxH, height); y++)
    for (let x = 0; x < Math.min(boxW, width); x++) rgb.fill(0, (y * width + x) * 3, (y * width + x) * 3 + 3);
  [...text].forEach((c, i) => {
    const glyph = GLYPHS[c] || GLYPHS[' '];
    for (let gy = 0; gy < 7; gy++)
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy * 5 + gx] !== '1') continue;
        for (let dy = 0; dy < size; dy++)
          for (let dx = 0; dx < size; dx++) {
            const x = pad + (i * 6 + gx) * size + dx,
              y = pad + gy * size + dy;
            if (x < width && y < height) rgb.fill(255, (y * width + x) * 3, (y * width + x) * 3 + 3);
          }
      }
  });
}
export function renderView(run, bbox, width, height) {
  const { raster } = run;
  const [x0, y0] = project([bbox[0], bbox[3]], raster.zoom),
    [x1, y1] = project([bbox[2], bbox[1]], raster.zoom);
  const toPx = (loc) => {
    const p = project(loc, raster.zoom);
    return [((p[0] - x0) / (x1 - x0)) * width, ((p[1] - y0) / (y1 - y0)) * height];
  };
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = [x0 + ((x + 0.5) / width) * (x1 - x0), y0 + ((y + 0.5) / height) * (y1 - y0)];
      const inside =
        p[0] >= raster.x && p[1] >= raster.y && p[0] < raster.x + raster.width - 1 && p[1] < raster.y + raster.height - 1;
      if (!inside) continue;
      const k = Math.max(0, Math.min(255, Math.round(255 * sampleDensity(raster, p)))) * 4;
      const alpha = ORANGE[k + 3] / 255;
      const o = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) rgb[o + c] = Math.round(ORANGE[k + c] * alpha);
    }
  }
  const dot = (cx, cy, r, color, ring = 0) => {
    for (let y = Math.floor(cy - r); y <= cy + r; y++)
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        if (x >= 0 && y >= 0 && x < width && y < height && d2 <= r * r && (!ring || d2 >= (r - ring) ** 2))
          rgb.set(color, (y * width + x) * 3);
      }
  };
  const line = (locs, color, r, dash = 0) => {
    let along = 0;
    for (let i = 1; i < locs.length; i++) {
      const [ax, ay] = toPx(locs[i - 1]),
        [bx, by] = toPx(locs[i]);
      const steps = Math.ceil(Math.hypot(bx - ax, by - ay));
      for (let s = 0; s <= steps; s++, along++)
        if (!dash || along % (2 * dash) < dash)
          dot(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps, r, color);
    }
  };
  for (const other of run.others) line(other.locs, [61, 139, 255], 1, 6);
  line(run.original, [255, 60, 240], 1.5);
  for (const loc of run.original) dot(...toPx(loc), 5, [255, 60, 240], 1.5);
  // The accepted result of a regression check, under the new one.
  if (run.previous) {
    line(run.previous, [0, 220, 255], 1.5);
    for (const loc of run.previous) dot(...toPx(loc), 5, [0, 220, 255], 1.5);
  }
  line(run.result.map((p) => p.loc), [125, 255, 58], 1.5);
  for (const p of run.result) dot(...toPx(p.loc), 5, [125, 255, 58], 1.5);
  for (const i of run.fixed) dot(...toPx(run.original[i]), 9, [255, 255, 255], 2.5);
  for (const { from, to } of run.movedJunctions) {
    line([from, to], [255, 220, 0], 1.5);
    dot(...toPx(to), 9, [255, 220, 0], 2.5);
  }
  label(rgb, width, height, `way ${run.wayId}`, Math.max(2, Math.round(width / 600)));
  return encodePNG(width, height, rgb);
}

// --- Regression snapshots -------------------------------------------------------

const SNAPSHOTS = path.resolve(import.meta.dirname, 'slide-lab-snapshots.json');
const CHANGE_METERS = 2;

function labWays() {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, 'slide-lab-ways.js'), 'utf8');
  return JSON.parse(source.slice(source.indexOf('['), source.lastIndexOf(']') + 1));
}

// Ground distance from a point to a polyline, in metres.
function distanceToLine(loc, line) {
  const kx = 111320 * Math.cos((loc[1] * Math.PI) / 180),
    ky = 110540;
  let best = Infinity;
  for (let k = 1; k < line.length; k++) {
    const a = [(line[k - 1][0] - loc[0]) * kx, (line[k - 1][1] - loc[1]) * ky],
      b = [(line[k][0] - loc[0]) * kx, (line[k][1] - loc[1]) * ky];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / length)) : 0;
    best = Math.min(best, Math.hypot(a[0] + t * dx, a[1] + t * dy));
  }
  return best;
}

// The point of either line furthest from the other, and that distance.
function furthest(a, b) {
  let worst = { d: 0, loc: a[0] };
  for (const [from, to] of [
    [a, b],
    [b, a],
  ])
    for (const loc of from) {
      const d = distanceToLine(loc, to);
      if (d > worst.d) worst = { d, loc };
    }
  return worst;
}

const rounded = (loc) => loc.map((v) => Math.round(v * 1e7) / 1e7);

async function snapshots(ids, accept) {
  const stored = fs.existsSync(SNAPSHOTS) ? JSON.parse(fs.readFileSync(SNAPSHOTS, 'utf8')) : {};
  const outDir = path.join(DIR, 'check');
  if (!accept) {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
  }
  let changes = 0;
  for (const { id, name } of ids.length ? ids.map((id) => ({ id })) : labWays()) {
    const label = `${id}${name ? ` (${name})` : ''}`;
    let run;
    try {
      run = await slide(id, activity);
    } catch (error) {
      console.log(`ERROR    ${label}: ${error.tiles ? 'heatmap tiles missing, open it in the lab page once' : error.message}`);
      changes++;
      continue;
    }
    const current = {
      original: run.original.map(rounded),
      result: run.result.map((p) => rounded(p.loc)),
      skipped: run.stats.skipped,
      alongOther: run.stats.alongOther,
    };
    if (accept) {
      stored[id] = current;
      console.log(`accepted ${label}: ${current.result.length} points, ${current.skipped} left as drawn`);
      continue;
    }
    const before = stored[id];
    if (!before) {
      console.log(`NEW      ${label}: no snapshot yet (slide-lab:accept to record it)`);
      changes++;
      continue;
    }
    if (JSON.stringify(before.original) !== JSON.stringify(current.original)) {
      console.log(`EDITED   ${label}: the OSM way changed since its snapshot (slide-lab:accept to refresh)`);
      changes++;
      continue;
    }
    const worst = furthest(before.result, current.result);
    const notes = [];
    if (worst.d > CHANGE_METERS) notes.push(`moved up to ${worst.d.toFixed(1)} m`);
    if (before.skipped !== current.skipped)
      notes.push(`left as drawn ${before.skipped} → ${current.skipped}`);
    if (before.alongOther !== current.alongOther)
      notes.push(`along other ${before.alongOther} → ${current.alongOther}`);
    if (!notes.length) {
      console.log(`ok       ${label}`);
      continue;
    }
    changes++;
    // Whole way, and a close-up where it moved most: accepted in cyan, new in lime.
    const shown = { ...run, previous: before.result };
    const all = [...run.original, ...before.result, ...current.result];
    const lons = all.map((l) => l[0]),
      lats = all.map((l) => l[1]);
    const view = (bbox, width) => {
      const kx = Math.cos((lats[0] * Math.PI) / 180);
      const height = Math.round((width * (bbox[3] - bbox[1])) / ((bbox[2] - bbox[0]) * kx));
      return renderView(shown, bbox, width, Math.max(64, Math.min(1400, height)));
    };
    const pad = 0.0002;
    const files = [path.join(outDir, `${id}.png`), path.join(outDir, `${id}-closeup.png`)];
    fs.writeFileSync(
      files[0],
      view([Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad], 1200)
    );
    const c = worst.loc,
      r = 0.00035;
    fs.writeFileSync(files[1], view([c[0] - r * 1.25, c[1] - r, c[0] + r * 1.25, c[1] + r], 700));
    console.log(`CHANGED  ${label}: ${notes.join(', ')}\n         ${files.join('\n         ')}`);
  }
  if (accept) {
    fs.writeFileSync(SNAPSHOTS, JSON.stringify(stored, null, 1) + '\n');
    console.log(`Snapshots saved to ${SNAPSHOTS}`);
  } else {
    console.log(changes ? `${changes} way(s) differ from their snapshot.` : 'All ways match their snapshot.');
    process.exitCode = changes ? 1 : 0;
  }
}

// --- Other versions of Slide, to compare with ------------------------------------

// The lab and Slide at a git ref (tag, branch or commit), extracted once into
// .slide-lab/versions/<commit>, sharing this tile and OSM cache.
const ROOT = path.resolve(import.meta.dirname, '..');
const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const versions = new Map();
function version(ref) {
  const commit = git('rev-parse', '--verify', `${ref}^{commit}`);
  if (!versions.has(commit)) {
    const dir = path.join(DIR, 'versions', commit);
    if (!fs.existsSync(path.join(dir, '.slide-lab'))) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('tar', ['-x', '-C', dir], {
        input: execFileSync('git', ['archive', commit, 'scripts', 'src'], { cwd: ROOT }),
      });
      fs.symlinkSync(DIR, path.join(dir, '.slide-lab'));
    }
    versions.set(
      commit,
      (async () => {
        // Its own fetch hook would hide the tiles this lab lacks.
        const fetch = globalThis.fetch;
        const module = await import(pathToFileURL(path.join(dir, 'scripts', 'slide-lab.mjs')).href);
        globalThis.fetch = fetch;
        return module;
      })()
    );
  }
  return versions.get(commit);
}

// The page's comparison version of a run (beta.2): drawn under this one.
async function compared(wayId, activity, options, ref) {
  if (!ref) return null;
  try {
    const run = await (await version(ref)).slide(wayId, activity, options);
    return { ref, result: run.result, stats: run.stats };
  } catch (error) {
    return { ref, error: error.message };
  }
}

// --- CLI and web page ------------------------------------------------------------

const args = process.argv.slice(2);
const activity = args.find((a) => a.startsWith('--activity='))?.split('=')[1] || 'all';
const wayIds = args.filter((a) => /^\d+$/.test(a));

// Imported by a debugging script: export only.
const main = import.meta.url === pathToFileURL(process.argv[1]).href;

if (!main) {
  // Nothing to run.
} else if (args.includes('--check') || args.includes('--accept')) {
  await snapshots(wayIds, args.includes('--accept'));
} else if (wayIds.length) {
  fs.mkdirSync(path.join(DIR, 'out'), { recursive: true });
  for (const id of wayIds) {
    try {
      const run = await slide(id, activity, {
        moveEnds: args.includes('--move-ends'),
        once: args.includes('--once'),
      });
      const file = path.join(DIR, 'out', `${id}.png`);
      fs.writeFileSync(file, render(run));
      console.log(id, JSON.stringify(run.stats), file);
      if (args.includes('--dump')) {
        // Points in PNG pixel coordinates, to match what the render shows.
        const px = (loc) => run.toPx(loc).map(Math.round).join(',');
        console.log('original', run.original.map((loc, i) => `${i}:${px(loc)}`).join(' '));
        console.log('slid    ', run.raw.map((p) => `${p.nodeIndex ?? '+'}:${px(p.loc)}`).join(' '));
        console.log('result  ', run.result.map((p) => `${p.nodeIndex ?? '+'}:${px(p.loc)}`).join(' '));
      }
    } catch (error) {
      console.log(id, 'ERROR', error.message);
    }
  }
} else {
  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      try {
        let m;
        // The page is opened from file://, a different origin.
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
        } else if (url.pathname === '/area.json') {
          // Roads and paths in the page's view (not cached: always current).
          const bbox = url.searchParams.get('bbox').split(',').map(Number);
          if ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) > 0.01) throw new Error('Zoom in to load ways.');
          const response = await originalFetch(
            `https://api.openstreetmap.org/api/0.6/map.json?bbox=${bbox.join(',')}`,
            { headers: { 'User-Agent': USER_AGENT } }
          );
          if (!response.ok) throw new Error(`OSM API HTTP ${response.status}`);
          const graph = new Graph((await response.json()).elements);
          const ways = Object.values(graph.entities)
            .filter((e) => e.type === 'way' && e.tags.highway)
            .map((way) => ({
              id: way.id.slice(1),
              label: way.tags.name || way.tags.highway,
              locs: way.nodes.flatMap((id) => (graph.hasEntity(id) ? [graph.entity(id).loc] : [])),
            }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(ways));
        } else if (req.method === 'PUT' && url.pathname === '/ways') {
          // The page's list of ways worked on, with their problem tags, saved
          // as a script the page loads (it is opened from file://).
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const ways = JSON.parse(Buffer.concat(chunks));
          fs.writeFileSync(
            path.resolve(import.meta.dirname, 'slide-lab-ways.js'),
            '// Ways tested in the Slide lab, with their problem tags. Written by\n' +
              '// scripts/slide-lab.mjs when the page saves its list.\n' +
              `window.SLIDE_LAB_WAYS = ${JSON.stringify(ways, null, 1)};\n`
          );
          res.writeHead(204);
          res.end();
        } else if (url.pathname === '/palettes.json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(PALETTES));
        } else if (
          req.method === 'POST' &&
          (m = url.pathname.match(/^\/tile\/(\w+)\/(\d+)\/(\d+)\/(\d+)\.png$/))
        ) {
          // Uploaded by the page; an empty body means Strava has no tile there.
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const bytes = Buffer.concat(chunks);
          saveTile(m[1], ...m.slice(2).map(Number), bytes.length ? bytes : null);
          res.writeHead(204);
          res.end();
        } else if ((m = url.pathname.match(/^\/shot\/(\d+)\.png$/))) {
          // Shift+S on the page: the current view as a PNG, also saved to a
          // file (its path in the X-File header).
          const activity = url.searchParams.get('activity') || 'all';
          const options = { moveEnds: url.searchParams.get('moveEnds') === '1' };
          const run = await slide(m[1], activity, options);
          const other = await compared(m[1], activity, options, url.searchParams.get('compare'));
          if (other?.result) run.previous = other.result.map((p) => p.loc);
          const bbox = url.searchParams.get('bbox').split(',').map(Number);
          const [width, height] = ['w', 'h'].map((k) =>
            Math.max(64, Math.min(2400, Math.round(+url.searchParams.get(k))))
          );
          const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
          const file = path.join(DIR, 'shots', `${m[1]}-${stamp}.png`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const png = renderView(run, bbox, width, height);
          fs.writeFileSync(file, png);
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'X-File': file,
            'Access-Control-Expose-Headers': 'X-File',
          });
          res.end(png);
        } else if ((m = url.pathname.match(/^\/slide\/(\d+)\.(json|png)$/))) {
          const activity = url.searchParams.get('activity') || 'all';
          const options = { moveEnds: url.searchParams.get('moveEnds') === '1' };
          const run = await slide(m[1], activity, options);
          if (m[2] === 'png') {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(render(run));
          } else {
            const { raster, ...rest } = run;
            rest.compare = await compared(m[1], activity, options, url.searchParams.get('compare'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(rest));
          }
        } else {
          res.writeHead(404);
          res.end();
        }
      } catch (error) {
        res.writeHead(error.tiles ? 409 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message, missing: error.tiles }));
      }
    })
    .listen(PORT, () =>
      console.log(`Slide lab server on http://localhost:${PORT}: open scripts/slide-lab.html`)
    );
}
