import '../../lib/browser-polyfill.min.js';

import { createContextMenu, onContextMenuClicked } from './context-menu.js';
import {
  expireCredentials,
  requestCredentials,
  resetCredentials,
} from './credentials.js';
import { showInstalledNotification } from './installs.js';
import { resetLayerPresets } from './layers.js';
import { checkPermissions } from './permissions.js';
import { redirectComplete, openLogin } from './tabs.js';
import { watchTiles } from './tiles.js';

async function onMessage(message, sender) {
  const MESSAGE_HANDLERS = {
    requestCredentials,
    resetCredentials,
    expireCredentials,
    redirectComplete,
    openLogin,
  };

  if (MESSAGE_HANDLERS[message.type]) {
    return MESSAGE_HANDLERS[message.type](message.payload, sender);
  }

  console.warn(`Unknown message received: ${message}`);
  return null;
}

async function onStartup() {
  await checkPermissions();
  await resetLayerPresets();
  await createContextMenu();
  await requestCredentials();
}

async function onInstalled({ reason }) {
  await showInstalledNotification(reason);
  await onStartup();
}

async function onActionClicked(tab) {
  await checkPermissions();

  const { credentials } = await browser.storage.local.get('credentials');
  if (credentials) {
    // do nothing for now, later will open settings popup
  } else {
    await openLogin(tab.id);
  }
}

// disable for now as it can cause issues with popup display
async function showLoginPrompt(tabId) {
  // await browser.action.setPopup({
  //   popup: `src/popups/error.html?tabId=${tabId}`,
  //   tabId,
  // });
  // await browser.action.openPopup();
}

async function onTileExpired(tabId, url, reason) {
  console.log(
    '[StravaHeatmapExt] Detecting expired credentials, requesting new ones.',
    tabId,
    url,
    reason
  );
  await requestCredentials();
  await showLoginPrompt(tabId);
}

async function onTileFallback(tabId, url, reason) {
  console.log('[StravaHeatmapExt] Detected tile fallback:', tabId, url, reason);
  await showLoginPrompt(tabId);
}

async function main() {
  browser.action.onClicked.addListener(onActionClicked);
  browser.contextMenus.onClicked.addListener(onContextMenuClicked);
  browser.runtime.onMessage.addListener(onMessage);
  browser.runtime.onInstalled.addListener(onInstalled);
  browser.runtime.onStartup.addListener(onStartup);

  watchTiles(
    onTileExpired,
    ['*://*.strava.com/identified/globalheat/*/*/*/*/*.png*'],
    [403, 'net::ERR_BLOCKED_BY_ORB', 'NS_BINDING_ABORTED'],
    10000
  );
  watchTiles(
    onTileFallback,
    [
      'https://raw.githubusercontent.com/julcnx/strava-heatmap-extension/refs/heads/*/assets/heatmap-fallback.png*',
    ],
    [200, 304],
    30000
  );
}

main();
