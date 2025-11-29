const TITLES = {
  install: 'Welcome to the extension!',
  update: 'Extension Updated!',
};

const FEEDBACK =
  'Need help or want to report an issue? Right-click the extension icon in the top-right corner. Can’t see it? Click the puzzle icon and pin it.';

export async function showInstalledNotification(reason) {
  if (reason === 'install' || reason === 'update') {
    browser.tabs.create({ url: `src/about/index.html?reason=${reason}` });
  }
}
