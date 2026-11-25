(async function () {
  console.debug('[StravaHeatmapExt] executing content/inject-client.js');

  function getManifestVersion() {
    try {
      const manifest = browser.runtime.getManifest();
      const manifestVersion = manifest.version;
      console.log(
        `[StravaHeatmapExt] Loaded manifest version ${manifestVersion}`,
        manifest
      );
      return manifestVersion;
    } catch (error) {
      console.error('[StravaHeatmapExt] Error retrieving manifest version:', error);
    }
  }

  async function retrieveLayerPresets() {
    try {
      // Send message to request credentials
      const { layers } = await browser.storage.local.get('layers');
      console.log('[StravaHeatmapExt] Layer presets retrieved.', layers);
      return layers;
    } catch (error) {
      console.error('[StravaHeatmapExt] Error retrieving layer presets:', error);
    }
  }

  async function requestCredentials() {
    try {
      // Send message to request credentials
      const authenticated = await browser.runtime.sendMessage({
        type: 'requestCredentials',
      });
      console.log('[StravaHeatmapExt] Credentials requested.', authenticated);
      return authenticated;
    } catch (error) {
      console.error('[StravaHeatmapExt] Error requesting credentials:', error);
    }
  }

  // dev.gpx.studio (gpx.studio's development deployment) uses the gpx.studio client
  function getClientHost() {
    const host = window.location.host;
    return host === 'dev.gpx.studio' ? 'gpx.studio' : host;
  }

  function injectClientScript(layerPresets, authenticated, manifestVersion) {
    try {
      const host = getClientHost();
      const path = `src/clients/${host}/index.js`;
      const script = document.createElement('script');
      script.id = 'strava-heatmap-client';
      script.src = browser.runtime.getURL(path);
      script.type = 'module';
      script.async = false;
      script.dataset.authenticated = authenticated;
      script.dataset.version = manifestVersion;
      script.dataset.layers = layerPresets;
      script.onload = () => {
        // script.remove();
        console.debug('[StravaHeatmapExt] Injected client script.', path);
      };
      script.onerror = () =>
        console.warn('[StravaHeatmapExt] Failed to inject client script', path);

      // Inject the script as early as possible
      (document.head || document.documentElement).append(script);
    } catch (e) {
      console.error('[StravaHeatmapExt] Unexpected error injecting client script:', e);
    }
  }

  function injectClientCSS() {
    try {
      const host = getClientHost();
      const path = `src/clients/${host}/index.css`;
      const href = browser.runtime.getURL(path);

      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = () => {
        console.debug('[StravaHeatmapExt] Injected client CSS.', path);
      };
      link.onerror = () =>
        console.warn('[StravaHeatmapExt] Failed to inject client CSS', path);

      (document.head || document.documentElement).append(link);
    } catch (e) {
      console.error('[StravaHeatmapExt] Unexpected error injecting client CSS:', e);
    }
  }

  const manifestVersion = getManifestVersion();
  const layerPresets = await retrieveLayerPresets();
  const authenticated = await requestCredentials();

  injectClientScript(layerPresets, authenticated, manifestVersion);
  injectClientCSS();
})();
