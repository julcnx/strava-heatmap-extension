/**
 * Download the heatmap tiles that Slide needs.
 *
 * Slippy-map tiles are 512×512 pixel images addressed by (z, x, y). The
 * projected pixel coordinates produced by algorithm.js live in the same grid
 * at zoom 15, so tile (x, y) covers pixel range [x·512, x·512+512) — which is
 * exactly how loadSlideTiles() turns the line's bounding box into tile
 * indices.
 *
 * Requests are plain fetches: the extension's declarative Net Request rules
 * attach the Strava session cookies to content-a.strava.com, so the tiles
 * come back authenticated without this code handling credentials (hence
 * credentials: 'omit' below, and the strict URL validation in slideTileURL).
 */
import { lineBounds, metersPerPixel, SLIDE_DEFAULTS } from './algorithm.js';
import { decodeHeatmapPNG } from './png.js';

export const SLIDE_ZOOM = 15;

// Ask the enabled heatmap overlay for a tile URL and sanity-check it. We must
// keep BOTH the selected activity (e.g. "run") and the selected palette, and
// both are encoded in the URL path — the tile bytes are interpreted by png.js
// as ordered heat, never as display colours. Anything unexpected is treated
// as "the user is not logged in", because that is the only way a Strava
// overlay source can look here.
export function slideTileURL(source, x, y, zoom) {
  const url = source.url([x, y, zoom]);
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'content-a.strava.com' ||
    !/^\/identified\/globalheat\/[^/]+\/[^/]+\/\d+\/\d+\/\d+\.png$/.test(parsed.pathname)
  ) {
    throw new Error('Log into Strava using the extension before using Slide.');
  }
  return parsed.href;
}

// Fetch one tile and decode it; the result carries its grid position so the
// raster builder can place it correctly.
async function decodeTile(blob, z, x, y, signal) {
  const decoded = await decodeHeatmapPNG(await blob.arrayBuffer(), signal);
  return { z, x, y, ...decoded };
}

// Download every tile around `locations` and return { tiles, bounds, zoom }.
// `bounds` is the padded pixel area from lineBounds(); it is passed on to the
// raster builder so downloaded tiles and raster share one coordinate system.
export async function loadSlideTiles(locations, source, signal, onProgress) {
  const zoom = SLIDE_ZOOM;
  // Pad the line's bounding box by the widest search radius plus the contrast
  // neighbourhood: adaptive widening in the algorithm is only useful when the
  // imagery around the line has actually been downloaded.
  const padding =
    Math.ceil(
      (SLIDE_DEFAULTS.maxSearchRadiusMeters + SLIDE_DEFAULTS.contrastRadiusMeters) /
        metersPerPixel(locations[0][1], zoom)
    ) + 3;
  const bounds = lineBounds(locations, zoom, padding);
  // Upper safety limits: Slide is meant for short sections, and a huge area
  // would stall the editor and hammer Strava's servers.
  if ((bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY) > 4000000) {
    throw new Error('Slide area is too large. Select a shorter section of the line.');
  }
  // Convert the pixel bounding box to tile indices (1 tile = 512 pixels).
  const minX = Math.floor(bounds.minX / 512),
    maxX = Math.floor(bounds.maxX / 512);
  const minY = Math.floor(bounds.minY / 512),
    maxY = Math.floor(bounds.maxY / 512);
  if ((maxX - minX + 1) * (maxY - minY + 1) > 16) {
    throw new Error('Slide needs too many tiles. Select a shorter section of the line.');
  }
  // Memoised loader per (z, x, y): a tile on a corner of the bounding box is
  // requested once, and the parent-tile fallback below shares the cache too.
  const cache = new Map();
  const load = (z, x, y) => {
    const key = `${z}/${x}/${y}`;
    if (!cache.has(key))
      cache.set(
        key,
        (async () => {
          // Each tile gets its own controller so a 20 s timeout cancels just
          // that slow request, while the outer signal cancels the whole batch
          // when the user hits Cancel.
          const controller = new AbortController();
          const abort = () => controller.abort();
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) controller.abort();
          const timeout = setTimeout(abort, 20000);
          try {
            const response = await fetch(slideTileURL(source, x, y, z), {
              signal: controller.signal,
              credentials: 'omit',
            });
            if ((response.status === 404 || response.status === 410) && z === zoom) {
              // No tile at this zoom (Strava has no data there): fall back to
              // the parent tile — half the resolution, four times the area.
              // createHeatmapRaster() knows how to scale parent tiles up so
              // they still land on the right geographic position.
              return await load(z - 1, Math.floor(x / 2), Math.floor(y / 2));
            }
            // A missing child AND parent is an actual coverage hole, not an
            // authentication failure. Keep the remaining tiles usable (the
            // widened buffer may include empty areas). The tracing algorithm
            // never invents heat or crosses these missing pixels.
            if (response.status === 404 || response.status === 410) return null;
            if (response.status === 401 || response.status === 403) {
              throw new Error('Strava access expired. Log in again using the extension.');
            }
            if (!response.ok)
              throw new Error(`Could not load a heatmap tile (HTTP ${response.status}).`);
            return await decodeTile(await response.blob(), z, x, y, controller.signal);
          } catch (error) {
            if (error.name === 'AbortError' && !signal.aborted) {
              throw new Error('Heatmap request timed out. Please try again.');
            }
            throw error;
          } finally {
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
          }
        })()
      );
    return cache.get(key);
  };
  // Request all tiles in parallel and report progress per completed tile.
  let done = 0;
  const requests = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      requests.push(
        load(zoom, x, y).then((tile) => {
          onProgress?.(++done / ((maxX - minX + 1) * (maxY - minY + 1)));
          return tile;
        })
      );
    }
  }
  // null entries (tiles with no data anywhere) are dropped rather than being
  // an error: the padded buffer legitimately includes areas Strava has no
  // heatmap for, and the algorithm never traces through uncovered pixels.
  const tiles = [...new Set((await Promise.all(requests)).filter(Boolean))];
  if (!tiles.length) throw new Error('No heatmap tiles are available in this area.');
  return { tiles, bounds, zoom };
}
