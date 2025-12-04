import { showNotification } from './notifications.js';

let authNotificationId = null;

export async function redirectComplete(tabId, sender) {
  try {
    const tab = await browser.tabs.get(tabId);
    await browser.tabs.update(tabId, { active: true });
    if (sender?.tab?.id && sender.tab.id !== tabId) {
      await browser.tabs.remove(sender.tab.id);
    }

    // Clear auth notification if it exists
    if (authNotificationId) {
      await browser.notifications.clear(authNotificationId);
      authNotificationId = null;
    }

    console.debug(
      `[StravaHeatmapExt] Redirect complete, login returned to tab ${tabId}.`
    );
  } catch (err) {
    console.warn(
      `[StravaHeatmapExt] Original tab ${tabId} no longer exists or cannot be activated.`,
      err
    );
  }
}

export async function openLogin(tabId) {
  // Show notification
  authNotificationId = await showNotification({
    message:
      'Connecting to Strava... This tab will close automatically once fully authenticated.',
    iconGray: true,
    autoClose: false,
  });

  // Open Strava login
  await browser.tabs.create({
    url: `https://www.strava.com/dashboard?redirect=${encodeURIComponent(
      `/maps/global-heatmap?tabId=${tabId}`
    )}`,
  });
}
