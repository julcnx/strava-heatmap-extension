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
  const version = browser.runtime.getManifest().version;
  const params = new URLSearchParams(window.location.search);
  const reason = params.get('reason');

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

  // Set store URL based on browser
  const storeUrl = isFirefox() ? STORE_URLS.firefox : STORE_URLS.chrome;
  const rateLink = document.querySelector('.actions a[href="#rate"]');
  if (rateLink) {
    rateLink.href = storeUrl;
  }
});
