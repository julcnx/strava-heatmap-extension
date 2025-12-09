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
