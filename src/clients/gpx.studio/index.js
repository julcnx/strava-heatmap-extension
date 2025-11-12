import { setupAuthStatusChangeListener } from '../common/auth.js';
import { parseLayerPresets, setupLayerPresetsChangeListener, getLayerConfigs } from '../common/layers.js';

async function applyOverlays(layerPresets, authenticated, version) {
  console.log('[StravaHeatmapExt] Applying overlays to gpx.studio', { layerPresets, authenticated });

  await window.gpxstudio.ensureLoaded();

  const layerConfigs = getLayerConfigs(layerPresets, authenticated, version);

  window.gpxstudio.filterOverlays(layerConfigs.map((config) => config.id));

  // Add each layer as an overlay
  for (const config of layerConfigs) {
    const overlay = {
      id: config.id,
      name: config.name,
      tileUrls: [config.template],
      maxZoom: config.zoomExtent[1],
    };
    
    window.gpxstudio.addOrUpdateOverlay(overlay);
    console.log('[StravaHeatmapExt] Added overlay:', overlay);
  }

  console.log('[StravaHeatmapExt] Successfully applied overlays to gpx.studio');
}

async function main() {
  const script = document.querySelector('script#strava-heatmap-client');

  const version = script.dataset.version;

  let authenticated = script.dataset.authenticated === 'true';
  let layerPresets = parseLayerPresets(script.dataset.layers);

  console.log('[StravaHeatmapExt] Initializing gpx.studio integration', {
    version,
    authenticated,
    layerPresets,
  });

  // Apply initial overlays
  await applyOverlays(layerPresets, authenticated, version);

  // Listen for authentication status changes
  setupAuthStatusChangeListener(async (newAuthenticated) => {
    console.log('[StravaHeatmapExt] Authentication status changed:', newAuthenticated);
    authenticated = newAuthenticated;
    await applyOverlays(layerPresets, authenticated, version);
  });

  // Listen for layer preset changes
  setupLayerPresetsChangeListener(async (layers) => {
    console.log('[StravaHeatmapExt] Layer presets changed:', layers);
    layerPresets = parseLayerPresets(layers);
    await applyOverlays(layerPresets, authenticated, version);
  });
}

main();
