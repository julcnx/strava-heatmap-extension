import '../../lib/browser-polyfill.min.js';

import {
  createContextMenu,
  onContextMenuClicked,
  updateContextMenuAuth,
} from './context-menu.js';
import {
  expireCredentials,
  requestCredentials,
  resetCredentials,
} from './credentials.js';
import { showInstalledNotification } from './installs.js';
import { resetLayerPresets } from './layers.js';
import { checkPermissions } from './permissions.js';
import { redirectComplete, openLogin } from './tabs.js';

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

async function main() {
  console.log('[StravaHeatmapExt] Extension starting...');

  browser.action.onClicked.addListener(onActionClicked);
  browser.contextMenus.onClicked.addListener(onContextMenuClicked);
  browser.runtime.onMessage.addListener(onMessage);
  browser.runtime.onInstalled.addListener(onInstalled);
  browser.runtime.onStartup.addListener(onStartup);

  console.log('[StravaHeatmapExt] Extension started successfully');
}

main();
