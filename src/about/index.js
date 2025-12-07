const MESSAGES = {
  install: 'Welcome to the extension!',
  update: 'Successfully updated!',
};

const STORE_URLS = {
  chrome:
    'https://chromewebstore.google.com/detail/strava-heatmap/eglbcifjafncknmpmnelckombmgddlco/reviews',
  firefox: 'https://addons.mozilla.org/en-US/firefox/addon/strava-heatmap/reviews/',
};

function isFirefox() {
  return navigator.userAgent.includes('Firefox');
}

document.addEventListener('DOMContentLoaded', () => {
  const manifest = browser.runtime.getManifest();
  const version = manifest.version;
  const name = manifest.name;
  const params = new URLSearchParams(window.location.search);
  const reason = params.get('reason');

  // Set title and heading from manifest
  document.getElementById('page-title').textContent = name;
  document.getElementById('page-heading').textContent = name;

  // Set message
  let message = '';
  if (reason === 'install') {
    message = `${MESSAGES.install}<div class="version">v${version}</div>`;
  } else if (reason === 'update') {
    message = `${MESSAGES.update}<div class="version">v${version}</div>`;
  } else {
    message = `<div class="version">v${version}</div>`;
  }
  document.getElementById('message').innerHTML = message;

  // Update version-dependent links
  const readmeLink = document.querySelector('a[href*="#readme"]');
  if (readmeLink) {
    readmeLink.href = `https://github.com/julcnx/strava-heatmap-extension/blob/v${version}/README.md`;
  }

  const changelogLink = document.querySelector('a[href*="#changelog"]');
  if (changelogLink) {
    changelogLink.href = `https://github.com/julcnx/strava-heatmap-extension/blob/v${version}/CHANGELOG.md`;
  }

  // Set store URL based on browser
  const storeUrl = isFirefox() ? STORE_URLS.firefox : STORE_URLS.chrome;
  const rateLink = document.querySelector('.actions a[href="#rate"]');
  if (rateLink) {
    rateLink.href = storeUrl;
  }
});
