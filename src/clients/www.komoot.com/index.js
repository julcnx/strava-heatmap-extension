import { setupAuthStatusChangeListener } from '../common/auth.js';
import {
  parseLayerPresets,
  setupLayerPresetsChangeListener,
  getLayerConfigs
} from '../common/layers.js';

const SOURCE_PREFIX = 'strava-source-';
const LAYER_PREFIX = 'strava-layer-';
const BEFORE_ID = 'heatmap-layer-all_sports';
const WATCHDOG_INTERVAL_MS = 1000;

let currentMap = null;
let authenticated = false;
let layerPresets = [];
let version = null;
let applying = false;

/* -----------------------------
   Helpers
----------------------------- */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForScriptData(maxAttempts = 50, interval = 100) {
  for (let i = 0; i < maxAttempts; i++) {
    const script = document.querySelector('script#strava-heatmap-client');
    if (script) return script;
    await sleep(interval);
  }
  throw new Error('[StravaHeatmapExt] Script data not found');
}

async function waitForKomootMap(maxAttempts = 100, interval = 200) {
  for (let i = 0; i < maxAttempts; i++) {
    if (window.__kcpMap && typeof window.__kcpMap.addSource === 'function') {
      return window.__kcpMap;
    }
    await sleep(interval);
  }
  throw new Error('[StravaHeatmapExt] Komoot map not found');
}

/* -----------------------------
   Layer management
----------------------------- */

function getOurLayerIds(map) {
  const style = map?.getStyle?.();
  if (!style?.layers) return [];
  return style.layers
    .filter(l => l.id.startsWith(LAYER_PREFIX))
    .map(l => l.id);
}

function removeExistingLayers(map) {
  const style = map?.getStyle?.();
  if (!style) return;

  if (style.layers) {
    for (const layer of [...style.layers].reverse()) {
      if (layer.id.startsWith(LAYER_PREFIX) && map.getLayer(layer.id)) {
        try { map.removeLayer(layer.id); } catch (e) { /* ignore */ }
      }
    }
  }

  if (style.sources) {
    for (const sourceId of Object.keys(style.sources)) {
      if (sourceId.startsWith(SOURCE_PREFIX) && map.getSource(sourceId)) {
        try { map.removeSource(sourceId); } catch (e) { /* ignore */ }
      }
    }
  }
}

function applyOverlays(map) {
  if (applying) return;
  // We don't trust isStyleLoaded() — it can return false when the style is
  // actually ready to receive layers (tile/sprite loading flips it). Just
  // check that we have a style object and let try/catch + the watchdog handle
  // edge cases.
  if (!map?.getStyle?.()) {
    console.log('[StravaHeatmapExt] applyOverlays skipped: no style yet');
    return;
  }

  applying = true;

  try {
    const layerConfigs = getLayerConfigs(
      layerPresets,
      authenticated,
      version,
      true
    );

    console.log(
      '[StravaHeatmapExt] Applying overlays to Komoot',
      `(${layerConfigs.length} layer${layerConfigs.length === 1 ? '' : 's'})`
    );

    removeExistingLayers(map);

    // beforeId is only valid if that target layer actually exists on the
    // current style. On Komoot it usually doesn't.
    const beforeId = map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;

    for (const config of layerConfigs) {
      const sourceId = `${SOURCE_PREFIX}${config.id}`;
      const layerId = `${LAYER_PREFIX}${config.id}`;

      map.addSource(sourceId, {
        type: 'raster',
        tiles: [config.template],
        tileSize: 256,
        maxzoom: config.zoomExtent[1]
      });

      const layerSpec = {
        id: layerId,
        type: 'raster',
        source: sourceId,
        paint: { 'raster-opacity': 0.5 }
      };

      if (beforeId) {
        map.addLayer(layerSpec, beforeId);
      } else {
        map.addLayer(layerSpec);
      }

      console.log('[StravaHeatmapExt] Added:', layerId);
    }
  } catch (err) {
    console.error('[StravaHeatmapExt] Overlay injection failed', err);
    // Don't rethrow — the watchdog will retry next tick.
  } finally {
    applying = false;
  }
}

/* -----------------------------
   Map lifecycle
----------------------------- */

function attachMapListeners(map) {
  // Fires on setStyle (basemap change). Does NOT fire on initial load in
  // mapbox/maplibre — that's why we also listen to 'load' below and try
  // immediately in handleMapReplacement.
  map.on('style.load', () => {
    console.log('[StravaHeatmapExt] style.load fired');
    applyOverlays(map);
  });

  // Fires once when the map first becomes fully loaded. Catches the case
  // where we attached listeners before the initial load completed.
  map.on('load', () => {
    console.log('[StravaHeatmapExt] load fired');
    applyOverlays(map);
  });
}

function handleMapReplacement() {
  if (!window.__kcpMap) return;
  if (window.__kcpMap === currentMap) return;

  currentMap = window.__kcpMap;
  console.log('[StravaHeatmapExt] New Komoot map detected');

  attachMapListeners(currentMap);
  // Try immediately. If the style isn't ready yet, applyOverlays will bail
  // out cleanly and one of the event handlers (or the watchdog) will catch
  // the next opportunity.
  applyOverlays(currentMap);
}

function watchdog() {
  if (!currentMap || applying) return;

  const expected = getLayerConfigs(layerPresets, authenticated, version, true);
  if (expected.length === 0) return; // nothing to display, nothing to check

  const present = getOurLayerIds(currentMap);
  if (present.length === expected.length) return;

  console.log(
    '[StravaHeatmapExt] Watchdog: expected',
    expected.length,
    'layers, found',
    present.length,
    '— re-applying'
  );
  applyOverlays(currentMap);
}

function startMapWatcher() {
  handleMapReplacement();

  setInterval(() => {
    handleMapReplacement();
    watchdog();
  }, WATCHDOG_INTERVAL_MS);
}

/* -----------------------------
   Main
----------------------------- */

async function main() {
  try {
    const script = await waitForScriptData();

    version = script.dataset.version;
    authenticated = script.dataset.authenticated === 'true';
    layerPresets = parseLayerPresets(script.dataset.layers);

    console.log('[StravaHeatmapExt] Initializing Komoot integration', {
      version,
      authenticated,
      layerPresets
    });

    await waitForKomootMap();
    startMapWatcher();

    setupAuthStatusChangeListener((newAuthenticated) => {
      authenticated = newAuthenticated;
      if (currentMap) applyOverlays(currentMap);
    });

    setupLayerPresetsChangeListener((layers) => {
      layerPresets = parseLayerPresets(layers);
      if (currentMap) applyOverlays(currentMap);
    });
  } catch (error) {
    console.error('[StravaHeatmapExt] Initialization failed:', error);
  }
}

main();
