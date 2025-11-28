(function () {
  const RELOAD_FLAG = '__StravaHeatmap_gpxstudio_reloaded';
  const APP_RE = /^\/(?:[^/]+\/)?app\b/;

  const isAppRoute = () => APP_RE.test(location.pathname);

  console.log('[StravaHeatmapExt] GPX.studio route monitor (polling).', {
    host: location.host,
    pathname: location.pathname,
    isApp: isAppRoute(),
  });

  // If we’re already on /app after a hard reload, clear the flag to avoid loops
  if (isAppRoute() && sessionStorage.getItem(RELOAD_FLAG) === '1') {
    console.log('[StravaHeatmapExt] Reload flag found on /app; clearing to avoid loop.');
    sessionStorage.removeItem(RELOAD_FLAG);
    return;
  }

  // Poll for SPA navigation to /app and reload once
  const interval = 250; // ms
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    const alreadyReloaded = sessionStorage.getItem(RELOAD_FLAG) === '1';
    if (isAppRoute()) {
      console.log('[StravaHeatmapExt] /app route detected via polling.', {
        pathname: location.pathname,
        alreadyReloaded,
        ticks,
      });
      if (!alreadyReloaded) {
        sessionStorage.setItem(RELOAD_FLAG, '1');
        location.reload();
      }
      clearInterval(timer);
    }
    // Optional: stop polling after a while to save cycles
    if (ticks > 240) {
      // ~60s
      clearInterval(timer);
      console.log('[StravaHeatmapExt] Stopping route polling (timeout).');
    }
  }, interval);
})();
