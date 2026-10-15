// Slide lab: run Strava Slide on an OSM way outside iD, to test and tune the
// algorithm on real lines.
//
//   npm run slide-lab                      → server on http://localhost:8765, then
//                                            open scripts/slide-lab.html (file://)
//   npm run slide-lab -- 223115682 438832711 → render .slide-lab/out/<id>.png
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
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import {
  createHeatmapRaster,
  project,
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
    .filter((e) => e.type === 'way' && e.id !== selection.way.id && e.tags.highway)
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
  return {
    wayId,
    activity,
    tags: selection.way.tags,
    original: locations,
    fixed,
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

// --- CLI and web page ------------------------------------------------------------

const args = process.argv.slice(2);
const activity = args.find((a) => a.startsWith('--activity='))?.split('=')[1] || 'all';
const wayIds = args.filter((a) => /^\d+$/.test(a));

// Imported by a debugging script: export only.
const main = import.meta.url === pathToFileURL(process.argv[1]).href;

if (!main) {
  // Nothing to run.
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
        } else if ((m = url.pathname.match(/^\/slide\/(\d+)\.(json|png)$/))) {
          const run = await slide(m[1], url.searchParams.get('activity') || 'all', {
            moveEnds: url.searchParams.get('moveEnds') === '1',
          });
          if (m[2] === 'png') {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(render(run));
          } else {
            const { raster, ...rest } = run;
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
