import { setupAuthStatusChangeListener } from '../common/auth.js';
import { parseLayerPresets, setupLayerPresetsChangeListener, getLayerConfigs } from '../common/layers.js';

async function waitForBikeRouterDe(maxAttempts = 50, interval = 100) {
  for (let i = 0; i < maxAttempts; i++) {
    if (window.BR && typeof window.BR.Export === 'function') {
      console.log('[StravaHeatmapExt] bikerouter.de API detected');
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('[StravaHeatmapExt] Timeout waiting for bikerouter.de API');
}

function addOneOverlay(name, url) {
  L.DomUtil.get('layer_url').value = url;
  L.DomUtil.get('layer_name').value = name;
  L.DomUtil.get('custom_layers_add_overlay').click();
}

async function applyOverlays(layerPresets, authenticated, version) {
  console.log('[StravaHeatmapExt] Applying overlays to bikerouter.de', { layerPresets, authenticated });

  const layerConfigs = getLayerConfigs(layerPresets, authenticated, version, true);

  for (const config of layerConfigs) {
    const overlay = {
      name: config.name,
      tileUrls: config.template,
    };
    
    addOneOverlay(config.name, config.template);
    console.log('[StravaHeatmapExt] Added overlay:', overlay);
  }

}

async function main() {
  const script = document.querySelector('script#strava-heatmap-client');

  const version = script.dataset.version;

  let authenticated = script.dataset.authenticated === 'true';
  let layerPresets = parseLayerPresets(script.dataset.layers);

  console.log('[StravaHeatmapExt] Initializing bikerouter.de integration', {
    version,
    authenticated,
    layerPresets,
  });


  try {
    // Wait for gpx.studio API to be available
    await waitForBikeRouterDe();

    // Apply initial overlays
    await applyOverlays(layerPresets, authenticated, version);

    // // Listen for authentication status changes
    // setupAuthStatusChangeListener(async (newAuthenticated) => {
    //   console.log('[StravaHeatmapExt] Authentication status changed:', newAuthenticated);
    //   authenticated = newAuthenticated;
    //   await applyOverlays(layerPresets, authenticated, version);
    // });

    // // Listen for layer preset changes
    // setupLayerPresetsChangeListener(async (layers) => {
    //   console.log('[StravaHeatmapExt] Layer presets changed:', layers);
    //   layerPresets = parseLayerPresets(layers);
    //   await applyOverlays(layerPresets, authenticated, version);
    // });
  } catch (error) {
    console.error('[StravaHeatmapExt] Failed to initialize bikerouter.de integration:', error);
  }
}

main();
