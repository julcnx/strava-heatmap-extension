/**
 * Get the extension name with appropriate suffix based on build type
 * @returns {string} Extension name with [DEV] or [BUILD] suffix as appropriate
 */
export function getExtensionName() {
  const manifest = browser.runtime.getManifest();
  const name = manifest.name;

  // If already has [DEV] suffix, return as-is
  if (name.endsWith('[DEV]')) {
    return name;
  }

  // If not in production mode and no [DEV] suffix, add [BUILD]
  if (!manifest.update_url) {
    return `${name} [BUILD]`;
  }

  // Production mode - return name as-is
  return name;
}

/**
 * Check if extension is in development mode
 * @returns {boolean}
 */
export function isDevelopment() {
  return browser.runtime.getManifest().name.endsWith('[DEV]');
}

/**
 * Check if extension is in build mode
 * @returns {boolean}
 */
export function isBuild() {
  const manifest = browser.runtime.getManifest();
  return !manifest.name.endsWith('[DEV]') && !manifest.update_url;
}

/**
 * Check if extension is in production mode
 * @returns {boolean}
 */
export function isProduction() {
  return Boolean(browser.runtime.getManifest().update_url);
}
