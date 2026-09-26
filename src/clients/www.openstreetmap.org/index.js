import { setupAuthStatusChangeListener } from '../common/auth.js';
import { parseLayerPresets, setupLayerPresetsChangeListener } from '../common/layers.js';
import { injectHeatmapColorFilters } from './colors.js';
import { restoreiDContainer, setupiDCoreContextListener } from './id.js';
import { applyImagery } from './imagery.js';
import { setupOverlaysListeners } from './overlays.js';

async function main() {
  const script = document.querySelector('script#strava-heatmap-client');

  const version = script.dataset.version;

  let authenticated = script.dataset.authenticated === 'true';
  let layerPresets = parseLayerPresets(script.dataset.layers);

  injectHeatmapColorFilters();

  setupiDCoreContextListener(async (context) => {
    window.context = context; // DEBUG
    console.log(
      '[StravaHeatmapExt] iD context initialization callback triggered',
      context
    );

    // make sure ui fully loaded
    await context.ui().ensureLoaded();

    await applyImagery(context, layerPresets, authenticated, version);

    await setupOverlaysListeners(context);

    setupAuthStatusChangeListener(async (newAuthenticated) => {
      authenticated = newAuthenticated;
      await applyImagery(context, layerPresets, authenticated, version);
    });

    setupLayerPresetsChangeListener(async (layers) => {
      layerPresets = parseLayerPresets(layers);
      await applyImagery(context, layerPresets, authenticated, version);
    });

    // ensure document is focused to listen to keyboard events
    document.body.setAttribute('tabindex', '0');
    document.body.focus();
  });

  restoreiDContainer();
}

main();
