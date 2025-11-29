const CONTEXT_MENU_ITEMS = [
  {
    id: 'about',
    title: 'About Extension',
    action: () => browser.tabs.create({ url: `src/about/index.html` }),
  },
];

export async function createContextMenu() {
  try {
    // Clear existing menu
    await browser.contextMenus.removeAll();

    // Create submenus dynamically
    const menuPromises = CONTEXT_MENU_ITEMS.map(({ id, title }) => {
      return browser.contextMenus.create({
        id,
        title,
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

export async function onContextMenuClicked(info) {
  const clickedItem = CONTEXT_MENU_ITEMS.find(({ id }) => id === info.menuItemId);

  if (clickedItem?.action) {
    await clickedItem.action();
  } else {
    console.warn(`Unknown or invalid context menu item clicked: ${info.menuItemId}`);
  }
}
