import { lineBounds, metersPerPixel } from '../common/slide.js';
import { decodeHeatmapPNG } from '../common/slide-png.js';

export const SLIDE_ZOOM = 15;

// Preserve the selected activity AND palette. Density is decoded directly from
// PNG indices, not from display colors. Existing DNR supplies cookies and CORS.
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

async function decodeTile(blob, z, x, y, signal) {
  const decoded = await decodeHeatmapPNG(await blob.arrayBuffer(), signal);
  return { z, x, y, ...decoded };
}

export async function loadSlideTiles(locations, source, signal, onProgress) {
  const zoom = SLIDE_ZOOM;
  const padding = Math.ceil(28 / metersPerPixel(locations[0][1], zoom)) + 3;
  const bounds = lineBounds(locations, zoom, padding);
  if ((bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY) > 4000000) {
    throw new Error('Slide area is too large. Select a shorter section of the line.');
  }
  const minX = Math.floor(bounds.minX / 512),
    maxX = Math.floor(bounds.maxX / 512);
  const minY = Math.floor(bounds.minY / 512),
    maxY = Math.floor(bounds.maxY / 512);
  if ((maxX - minX + 1) * (maxY - minY + 1) > 16) {
    throw new Error('Slide needs too many tiles. Select a shorter section of the line.');
  }
  const cache = new Map();
  const load = (z, x, y) => {
    const key = `${z}/${x}/${y}`;
    if (!cache.has(key))
      cache.set(
        key,
        (async () => {
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
              return await load(z - 1, Math.floor(x / 2), Math.floor(y / 2));
            }
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
  return { tiles: [...new Set(await Promise.all(requests))], bounds, zoom };
}
