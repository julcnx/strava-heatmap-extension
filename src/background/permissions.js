const REQUIRED_ORIGINS = [
  '*://www.strava.com/*',
  '*://content-a.strava.com/*',
  '*://gpx.studio/*',
  '*://www.openstreetmap.org/*',
];

const NOTIFICATION_ID = 'permissions-notification';

export async function checkPermissions() {
  try {
    console.log('[StravaHeatmapExt] Checking permissions...', {
      origins: REQUIRED_ORIGINS,
    });

    const has = await browser.permissions.contains({
      origins: REQUIRED_ORIGINS,
    });

    console.log('[StravaHeatmapExt] Permissions.contains result:', has);

    if (!has) {
      console.log('[StravaHeatmapExt] Missing permissions; showing notification.', {
        notificationId: NOTIFICATION_ID,
      });
      await showPermissionNotification();
      console.log('[StravaHeatmapExt] Notification displayed.');
    } else {
      console.log('[StravaHeatmapExt] All required permissions present.');
    }

    return has;
  } catch (e) {
    console.error('[StravaHeatmapExt] permissions.contains failed', {
      error: e,
      origins: REQUIRED_ORIGINS,
    });
    return false;
  }
}

function showPermissionNotification() {
  browser.notifications.create(NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/icon-48.png'),
    title: 'Enable Strava Heatmap Site Access',
    message:
      'Please enable access to all sites in the extension settings to allow the extension to function properly.',
    buttons: [{ title: 'Enable Permissions' }],
  });
}

async function requestPermissions() {
  try {
    const granted = await browser.permissions.request({
      origins: REQUIRED_ORIGINS,
    });
    console.log('[StravaHeatmapExt] Host permissions request result:', granted);
    if (granted) {
      await browser.notifications.clear(NOTIFICATION_ID);
      return true;
    } else {
      return false;
    }
  } catch (e) {
    console.error('[StravaHeatmapExt] Host permissions request failed:', e);
    return false;
  }
}
