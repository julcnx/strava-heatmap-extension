import { getHashParams } from '../common/hash.js';

const overlaysHelpVar = `--overlays-help`;
const overlaysSummaryVar = `--overlays-summary`;
const overlaysHiddenClass = 'overlays-hidden';
const stravaHiddenClass = 'strava-hidden';
// Strava shown while the other overlays are hidden
const stravaOnlyClass = 'strava-only';
const storageKeyLastUsed = 'overlays-last-used';

export function bindOverlaysShortcuts(context) {
  const keybinding = context.keybinding();

  keybinding.on(iD.uiCmd('⇧Q'), function (d3_event) {
    d3_event.stopImmediatePropagation();
    d3_event.preventDefault();
    toggleOverlaysVisibility();
  });

  keybinding.on(iD.uiCmd('⇧H'), function (d3_event) {
    d3_event.stopImmediatePropagation();
    d3_event.preventDefault();
    toggleStravaVisibility();
  });

  keybinding.on(iD.uiCmd('⇧W'), function (d3_event) {
    d3_event.stopImmediatePropagation();
    d3_event.preventDefault();
    const mode = context.mode();
    if (!mode || !mode.id.startsWith('draw-')) {
      const osmLayer = context.layers().layer('osm');
      osmLayer.enabled(!osmLayer.enabled());
    }
  });

}

export async function setupOverlaysListeners(context) {
  document.addEventListener('change', async (event) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.matches('input[type="checkbox"][name="layers"]')
    ) {
      // Ensure overlays are visible when toggling layer checkboxes
      toggleOverlaysVisibility(true);

      // Save the current overlay state (or empty string if none)
      const hashParams = getHashParams(location);
      const newValue = hashParams.get('overlays') ?? '';

      // Save the last used overlays in local storage
      localStorage.setItem(storageKeyLastUsed, newValue);
    }
  });

  // execute once
  updateOverlaysHelpText();
  updateOverlaySummary();

  await injectOverlaysShortcuts();
}

export function getDefaultOverlaysHash() {
  const hash = getHashParams(location).get('overlays');
  const lastUsed = localStorage.getItem(storageKeyLastUsed);

  return hash ?? lastUsed ?? 'strava-heatmap-all';
}

function updateOverlaySummary() {
  const { classList } = document.body;
  let status = classList.contains(stravaHiddenClass) ? 'Strava hidden' : 'Visible';
  if (classList.contains(overlaysHiddenClass)) {
    status = classList.contains(stravaOnlyClass) ? 'Only Strava' : 'Hidden';
  }
  document.body.style.setProperty(overlaysSummaryVar, `"${status}"`);
}

function updateOverlaysHelpText() {
  const helpText = [
    'ℹ️ Use [Shift+Q] to toggle the visibility of all overlays, [Shift+H] only the Strava heatmap.',
    'Previously used overlays persist between sessions.',
  ]
    .join(' ')
    .trim();

  document.body.style.setProperty(overlaysHelpVar, `"${helpText}"`);
}

function toggleOverlaysVisibility(forceVisible) {
  const { classList } = document.body;
  if (forceVisible === true) {
    classList.remove(overlaysHiddenClass, stravaHiddenClass);
  } else {
    // Strava is on screen: showing the other overlays keeps it there
    if (classList.contains(stravaOnlyClass)) classList.remove(stravaHiddenClass);
    classList.toggle(overlaysHiddenClass);
  }
  classList.remove(stravaOnlyClass);
  updateOverlaySummary();
}

// Only hides the tiles: the layers stay enabled, for Slide and the changeset's
// imagery. The other overlays stay as they are.
function toggleStravaVisibility() {
  const { classList } = document.body;
  classList.toggle(
    classList.contains(overlaysHiddenClass) ? stravaOnlyClass : stravaHiddenClass
  );
  updateOverlaySummary();
}

export async function injectOverlaysShortcuts() {
  await iD.fileFetcher.get('shortcuts');
  const cache = iD.fileFetcher.cache?.();
  const browsingTab = cache?.shortcuts?.find((s) => s.tab === 'browsing');
  const rows = browsingTab?.columns?.[0]?.rows;

  if (!Array.isArray(rows)) {
    console.warn(
      '[StravaHeatmapExt] Shortcuts cache is unavailable or not in expected format.'
    );
    return;
  }

  const targetIndex = rows.findIndex(
    (r) => r.text === 'shortcuts.browsing.display_options.map_data'
  );
  if (targetIndex === -1) return;

  const customShortcuts = [
    {
      modifiers: ['⇧'],
      shortcuts: ['Q'],
      text: 'Toggle Overlays Visibility',
    },
    {
      modifiers: ['⇧'],
      shortcuts: ['H'],
      text: 'Toggle Strava Heatmap Visibility',
    },
    {
      modifiers: ['⇧'],
      shortcuts: ['W'],
      text: 'shortcuts.browsing.display_options.osm_data',
    },
  ];

  rows.splice(targetIndex, 1, ...customShortcuts);
}

export function restoreOverlays(background, overlaysValue) {
  // Turn off all current overlays
  background
    .overlayLayerSources()
    .forEach((layer) => background.toggleOverlayLayer(layer));

  // Turn on the ones from the value
  overlaysValue
    .split(',')
    .filter(Boolean)
    .forEach((id) => {
      const source = background.findSource(id);
      if (source) {
        background.toggleOverlayLayer(source);
      } else {
        // normal after its layer was removed
        console.debug(`[StravaHeatmapExt] Missing overlay source for restoration: ${id}`);
      }
    });
}
