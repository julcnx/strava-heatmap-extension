(async function () {
  try {
    console.debug('[StravaHeatmapExt] executing content/strava-logout.js');

    await browser.runtime.sendMessage({ type: 'resetCredentials' });
    console.log('[StravaHeatmapExt] Credentials reset after logout.');
  } catch (error) {
    console.error('[StravaHeatmapExt] Error in strava-logout.js:', error);
  }
})();
