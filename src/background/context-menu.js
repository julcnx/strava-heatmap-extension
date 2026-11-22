import { resetCredentials, expireCredentials } from './credentials.js';
import { getDocUrl, isDevelopment } from '../extension.js';
import { openLogin, openLogout } from './tabs.js';

const CONTEXT_MENU_ITEMS = [
  {
    id: 'about',
    title: `About this Extension`,
    action: () => browser.tabs.create({ url: `src/about/index.html` }),
  },
  {
    id: 'help',
    title: 'Help',
    action: () => browser.tabs.create({ url: getDocUrl('README.md') }),
  },
  {
    id: 'separator1',
    title: null,
  },
  {
    id: 'account',
    title: 'Log in to Strava',
    titleAuth: 'Sign out from Strava',
    action: async (tab) => {
      const { credentials } = await browser.storage.local.get('credentials');
      return credentials ? openLogout() : openLogin(tab.id);
    },
  },
  {
    id: 'resetCookies',
    title: 'Reset Heatmap Login',
    action: () => resetCredentials(),
    requiresAuth: true,
  },
  ...(isDevelopment()
    ? [
        {
          id: 'expireCookies',
          title: '🤖 Expire Strava Cookies',
          action: () => expireCredentials(),
          requiresAuth: true,
        },
      ]
    : []),
];

export async function createContextMenu() {
  try {
    // Clear existing menu
    await browser.contextMenus.removeAll();

    // Create submenus dynamically
    const menuPromises = CONTEXT_MENU_ITEMS.map(({ id, title }) => {
      return browser.contextMenus.create({
        id,
        title: title || undefined,
        type: title ? 'normal' : 'separator',
        contexts: ['action'],
      });
    });

    // Wait for all context menus to be created
    await Promise.all(menuPromises);
  } catch (error) {
    console.error('Error creating context menu:', error);
  }
}

export async function updateContextMenuAuth(authenticated) {
  // Update menu items based on authentication status
  for (const item of CONTEXT_MENU_ITEMS) {
    if (item.requiresAuth) {
      await browser.contextMenus.update(item.id, {
        enabled: authenticated,
      });
    }
    if (item.titleAuth) {
      await browser.contextMenus.update(item.id, {
        title: authenticated ? item.titleAuth : item.title,
      });
    }
  }
}

export async function onContextMenuClicked(info, tab) {
  const clickedItem = CONTEXT_MENU_ITEMS.find(({ id }) => id === info.menuItemId);

  if (clickedItem?.action) {
    await clickedItem.action(tab);
  } else {
    console.warn(`Unknown or invalid context menu item clicked: ${info.menuItemId}`);
  }
}
