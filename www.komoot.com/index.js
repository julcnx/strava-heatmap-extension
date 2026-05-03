import { setupAuthStatusChangeListener } from '../common/auth.js';
import {
  parseLayerPresets,
  setupLayerPresetsChangeListener,
  getLayerConfigs
} from '../common/layers.js';

const SOURCE_PREFIX = 'strava-source-';
const LAYER_PREFIX = 'strava-layer-';

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

    if (script) {
      return script;
    }

    await sleep(interval);
  }

  throw new Error('[StravaHeatmapExt] Script data not found');
}

async function waitForKomootMap(maxAttempts = 100, interval = 200) {
  for (let i = 0; i < maxAttempts; i++) {
    if (
      window.__kcpMap &&
      typeof window.__kcpMap.addSource === 'function'
    ) {
      return window.__kcpMap;
    }

    await sleep(interval);
  }

  throw new Error('[StravaHeatmapExt] Komoot map not found');
}

/* -----------------------------
   Layer management
----------------------------- */

function removeExistingLayers(map) {
  const style = map.getStyle();

  if (!style) return;

  if (style.layers) {
    for (const layer of [...style.layers].reverse()) {
      if (layer.id.startsWith(LAYER_PREFIX)) {
        if (map.getLayer(layer.id)) {
          map.removeLayer(layer.id);
        }
      }
    }
  }

  if (style.sources) {
    for (const sourceId of Object.keys(style.sources)) {
      if (sourceId.startsWith(SOURCE_PREFIX)) {
        if (map.getSource(sourceId)) {
          map.removeSource(sourceId);
        }
      }
    }
  }
}

function applyOverlays(map) {
  if (applying) return;
  if (!map?.isStyleLoaded?.()) return;

  applying = true;

  try {
    console.log('[StravaHeatmapExt] Applying overlays to Komoot');

    const layerConfigs = getLayerConfigs(
      layerPresets,
      authenticated,
      version,
      true
    );

    removeExistingLayers(map);

    for (const config of layerConfigs) {
      const sourceId = `${SOURCE_PREFIX}${config.id}`;
      const layerId = `${LAYER_PREFIX}${config.id}`;

      map.addSource(sourceId, {
        type: 'raster',
        tiles: [config.template],
        tileSize: 256,
        maxzoom: config.zoomExtent[1]
      });

      const test = map.addLayer({
        id: layerId,
        type: 'raster',
        source: sourceId,
        paint: {
          'raster-opacity': 0.5
        },
		beforeId: 'heatmap-layer-all_sports'
      });

      console.log('[StravaHeatmapExt] Added:', layerId, test, __kcpMap.getStyle().layers.map(l => l.id));
    }

  } catch (err) {
    console.error('[StravaHeatmapExt] Overlay injection failed', err);
  } finally {
    applying = false;
  }
}

/* -----------------------------
   Map lifecycle
----------------------------- */

function attachMapListeners(map) {
  map.on('style.load', () => {
    console.log('[StravaHeatmapExt] Style reloaded');
    applyOverlays(map);
  });
}

function handleMapReplacement() {
  if (!window.__kcpMap) return;

  if (window.__kcpMap !== currentMap) {
    currentMap = window.__kcpMap;

    console.log('[StravaHeatmapExt] New Komoot map detected');

    attachMapListeners(currentMap);

    if (currentMap.isStyleLoaded()) {
      applyOverlays(currentMap);
    } else {
      currentMap.once('load', () => applyOverlays(currentMap));
    }
  }
}

function startMapWatcher() {
  handleMapReplacement();

  setInterval(() => {
    handleMapReplacement();
  }, 500);
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

      if (currentMap) {
        applyOverlays(currentMap);
      }
    });

    setupLayerPresetsChangeListener((layers) => {
      layerPresets = parseLayerPresets(layers);

      if (currentMap) {
        applyOverlays(currentMap);
      }
    });

  } catch (error) {
    console.error('[StravaHeatmapExt] Initialization failed:', error);
  }
}

main();