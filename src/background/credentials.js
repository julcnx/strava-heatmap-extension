import { clearCookies, fetchCookies } from './cookies.js';
import { updateHeatmapRules } from './rules.js';

const STRAVA_COOKIE_URL = 'https://www.strava.com';
const STRAVA_COOKIE_NAMES = [
  '_strava_idcf',
  'CloudFront-Key-Pair-Id',
  'CloudFront-Policy',
  'CloudFront-Signature',
];

const VALIDATION_TILE_URL =
  'https://content-a.strava.com/identified/globalheat/all/hot/8/198/114.png?v=19';

export async function validateCredentials() {
  return new Promise(async (resolve) => {
    try {
      const response = await fetch(`${VALIDATION_TILE_URL}&t=${Date.now()}`);
      resolve(response.ok ? null : `${response.status}`);
    } catch (error) {
      resolve(error.name);
    }
  });
}

export async function requestCredentials(skipValidation = false) {
  let credentials = await fetchCookies(STRAVA_COOKIE_URL, STRAVA_COOKIE_NAMES);
  console.debug('[StravaHeatmapExt] Credentials fetched:', credentials);

  const { credentials: storedCredentials } = await browser.storage.local.get(
    'credentials'
  );

  if (!credentials && storedCredentials) {
    console.debug('[StravaHeatmapExt] Falling back to stored credentials');
    credentials = storedCredentials;
  }

  const rules = await updateHeatmapRules(credentials);
  console.debug('[StravaHeatmapExt] Heatmap rules updated', rules);

  // Validate credentials by attempting to access a protected tile
  if (credentials && !skipValidation) {
    const error = await validateCredentials();
    if (['403'].includes(error)) {
      await clearCookies(STRAVA_COOKIE_URL, STRAVA_COOKIE_NAMES);
      await updateHeatmapRules(null);
      credentials = null;
    }
  }

  // Update local storage only if credentials changed
  if (credentials !== storedCredentials) {
    await browser.storage.local.set({ credentials });
    console.debug('[StravaHeatmapExt] Stored credentials updated', credentials);
  }

  const authenticated = Boolean(credentials);
  updateActionIcon(authenticated);

  return authenticated;
}

export async function resetCredentials() {
  await clearCookies(STRAVA_COOKIE_URL, STRAVA_COOKIE_NAMES);
  await browser.storage.local.set({
    credentials: null,
  });
  console.debug('[StravaHeatmapExt] Credentials cleared');

  return requestCredentials(true);
}

export async function expireCredentials() {
  // Set expired credentials (from a past date)
  const expiredCredentials =
    '_strava_idcf=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJleHAiOjE2MDAwMDAwMDAsImlhdCI6MTYwMDAwMDAwMCwiYXRobGV0ZUlkIjo5OTk5OTk5OSwidGltZXN0YW1wIjoxNjAwMDAwMDAwfQ.invalid; CloudFront-Key-Pair-Id=INVALID; CloudFront-Policy=eyJTdGF0ZW1lbnQiOiBbeyJSZXNvdXJjZSI6Imh0dHBzOi8vKi5zdHJhdmEuY29tLyoiLCJDb25kaXRpb24iOnsiRGF0ZUxlc3NUaGFuIjp7IkFXUzpFcG9jaFRpbWUiOjE2MDAwMDAwMDB9fX1dfQ==; CloudFront-Signature=InvalidSignature';

  await clearCookies(STRAVA_COOKIE_URL, STRAVA_COOKIE_NAMES);
  await browser.storage.local.set({
    credentials: expiredCredentials,
  });

  console.debug('[StravaHeatmapExt] Expired credentials set');

  // Update rules with expired credentials
  await updateHeatmapRules(expiredCredentials);

  // Force validation (which should fail with 403)
  return requestCredentials(false); // Set to false to trigger validation
}

async function updateActionIcon(authenticated) {
  const title = authenticated
    ? '🟢 Strava Heatmap ON:\n\nEnable an overlay to view it.'
    : `🔴 Strava Heatmap OFF:\n\nClick here to log into Strava and view the heatmap.`;

  const color = authenticated ? 'green' : 'red';
  const text = '󠀠';

  await browser.action.setTitle({ title });
  await browser.action.setBadgeBackgroundColor({ color });
  await browser.action.setBadgeText({ text });

  if (authenticated) {
    await browser.action.setPopup({
      popup: 'src/popups/settings.html',
    });
  } else {
    await browser.action.setPopup({ popup: '' });
  }
}
