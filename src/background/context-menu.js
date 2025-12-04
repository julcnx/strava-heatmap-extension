import { resetCredentials, expireCredentials } from './credentials.js';

const isDevelopment = !('update_url' in browser.runtime.getManifest());

const CONTEXT_MENU_ITEMS = [
  {
    id: 'about',
    title: 'About this Extension',
    action: () => browser.tabs.create({ url: `src/about/index.html` }),
  },
  {
    id: 'separator1',
    title: null,
  },
  {
    id: 'logoutStrava',
    title: 'Sign out from Strava',
    action: () => browser.tabs.create({ url: 'https://www.strava.com/logout?ext=true' }),
  },
  {
    id: 'resetCookies',
    title: 'Clear Strava Cookies',
    action: () => resetCredentials(),
    requiresAuth: true,
  },
  ...(isDevelopment
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
  }
}

export async function onContextMenuClicked(info) {
  const clickedItem = CONTEXT_MENU_ITEMS.find(({ id }) => id === info.menuItemId);

  if (clickedItem?.action) {
    await clickedItem.action();
  } else {
    console.warn(`Unknown or invalid context menu item clicked: ${info.menuItemId}`);
  }
}
