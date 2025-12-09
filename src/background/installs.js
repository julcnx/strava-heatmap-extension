import { showNotification } from './notifications.js';

const TITLES = {
  install: 'Welcome to the extension!',
  update: 'Extension Updated!',
};

const FEEDBACK = 'Need help or want to report an issue? Click here for support.';

export async function showInstalledNotification(reason) {
  if (reason === 'install' || reason === 'update') {
    const message = `${TITLES[reason]} ${FEEDBACK}`;

    await showNotification({
      message,
      autoClose: true,
      onClick: () => {
        browser.tabs.create({ url: `src/about/index.html?reason=${reason}` });
      },
    });
  }
}
