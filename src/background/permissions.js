import { showNotification } from './notifications.js';

const REQUIRED_ORIGINS = [
  '*://www.strava.com/*',
  '*://content-a.strava.com/*',
  '*://gpx.studio/*',
  '*://www.openstreetmap.org/*',
];

export async function checkPermissions(showSuccess = false) {
  console.log('[StravaHeatmapExt] Checking permissions...', {
    origins: REQUIRED_ORIGINS,
  });

  let has;
  try {
    has = await browser.permissions.contains({
      origins: REQUIRED_ORIGINS,
    });
  } catch (e) {
    console.error('[StravaHeatmapExt] permissions.contains failed', {
      error: e,
      origins: REQUIRED_ORIGINS,
    });
    return false;
  }

  console.log('[StravaHeatmapExt] Permissions.contains result:', has);

  if (!has) {
    console.log('[StravaHeatmapExt] Missing permissions; showing notification.');
    await showNotification({
      message:
        'Please enable access to all sites in the extension settings to allow the extension to function properly.',
      iconGray: true,
      autoClose: false,
      // onClick: () => requestPermissions(),
    });
    console.log('[StravaHeatmapExt] Notification displayed.');
  } else {
    console.log('[StravaHeatmapExt] All required permissions present.');
    if (showSuccess) {
      await showNotification({
        message: 'All required permissions are granted.',
      });
    }
  }

  return has;
}

async function requestPermissions() {
  try {
    const granted = await browser.permissions.request({
      origins: REQUIRED_ORIGINS,
    });
    console.log('[StravaHeatmapExt] Host permissions request result:', granted);
    return granted;
  } catch (e) {
    console.error('[StravaHeatmapExt] Host permissions request failed:', e);
    return false;
  }
}
