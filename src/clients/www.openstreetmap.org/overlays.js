import { getHashParams } from '../common/hash.js';

const overlaysHelpVar = `--overlays-help`;
const overlaysSummaryVar = `--overlays-summary`;
const overlaysHiddenClass = 'overlays-hidden';
const storageKeyLastUsed = 'overlays-last-used';

export function bindOverlaysShortcuts(context) {
  const keybinding = context.keybinding();

  keybinding.on(iD.uiCmd('⇧Q'), function (d3_event) {
    d3_event.stopImmediatePropagation();
    d3_event.preventDefault();
    toggleOverlaysVisibility();
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

  keybinding.on(iD.uiCmd('⇧G'), function (d3_event) {
    d3_event.stopImmediatePropagation();
    d3_event.preventDefault();

    var changeset = new iD.osmChangeset().update({ id: undefined });
    var coreHistory = context.history();
    var changes = coreHistory.changes(iD.actionDiscardTags(coreHistory.difference(), {}));
    var jxon = changeset.osmChangeJXON(changes);

    var gpx = convertJxonToGpx(jxon);

    // Trigger client-side download
    var blob = new Blob([gpx], { type: 'application/gpx+xml' });
    var url = URL.createObjectURL(blob);

    var a = document.createElement('a');
    a.href = url;
    a.download = 'changes.gpx';
    document.body.appendChild(a);
    a.click();

    // Cleanup
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  });
}

function convertJxonToGpx(jxon) {
  const fixedTimestamp = new Date().toISOString(); // or hardcoded like "2025-07-21T00:00:00Z"

  const graph = context.history().graph();
  const { create, modify } = jxon.osmChange;
  const nodes = (create.node || []).concat(modify.node || []);

  const ways = nodes.reduce((acc, node) => {
    const id = `n${node['@id']}`;
    const set = graph._parentWays[id];
    if (set) {
      set.forEach((wayId) => {
        if (!acc.includes(wayId)) acc.push(wayId);
      });
    }
    return acc;
  }, []);

  if (ways.length === 0) return;

  const trksegs = ways
    .reduce((acc, wayId) => {
      const childNodes = graph._childNodes[wayId];
      if (childNodes) {
        const trkpts = childNodes
          .map((node) => {
            const [lon, lat] = node.loc;
            return `<trkpt lat="${lat}" lon="${lon}"><time>${fixedTimestamp}</time></trkpt>`;
          })
          .join('\n      ');
        acc.push(`<trkseg>\n      ${trkpts}\n    </trkseg>`);
      }
      return acc;
    }, [])
    .join('\n    ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="iD-change-export" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Created Ways</name>
    ${trksegs}
  </trk>
</gpx>`;
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
  const status = document.body.classList.contains(overlaysHiddenClass)
    ? 'Hidden'
    : 'Visible';
  document.body.style.setProperty(overlaysSummaryVar, `"${status}"`);
}

function updateOverlaysHelpText() {
  const helpText = [
    'ℹ️ Use [Shift+Q] to toggle the visibility of all overlays.',
    'Previously used overlays persist between sessions.',
  ]
    .join(' ')
    .trim();

  document.body.style.setProperty(overlaysHelpVar, `"${helpText}"`);
}

function toggleOverlaysVisibility(forceVisible) {
  const body = document.body;
  if (forceVisible === true) {
    body.classList.remove(overlaysHiddenClass);
  } else {
    body.classList.toggle(overlaysHiddenClass);
  }
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
        console.warn(`[StravaHeatmapExt] Missing overlay source for restoration: ${id}`);
      }
    });
}
