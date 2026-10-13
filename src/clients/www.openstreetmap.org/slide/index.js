/**
 * iD integration for Strava Slide.
 *
 * This module is the only one that talks to the editor. Its responsibilities:
 *   * register Slide in iD's context menu and on Shift+S,
 *   * show the progress / heatmap-chooser dialog,
 *   * run the pipeline: tiles.js (download) → png.js (decode, via tiles.js) →
 *     algorithm.js (fit the line to the heatmap) → action.js (graph edit), and
 *   * guard against races: the user editing while Slide runs, and iD
 *     rebuilding its UI with node IDs that Slide just deleted.
 *
 * iD (the openstreetmap.org editor) exposes itself as window.iD and drives
 * everything through a `context` object — context.graph(), context.mode(),
 * context.perform(), context.keybinding() and so on. We only use that public
 * surface, so nothing here depends on iD's internals.
 */
import { createHeatmapRaster, slideLineTwice } from './algorithm.js';
import {
  cleanSlideResult,
  createSlideAction,
  getSlideSelection,
  fixedIndices,
  isStructure,
  protectedIndices,
  selectionUnchanged,
} from './action.js';
import { loadSlideTiles, slideTileURL } from './tiles.js';

// iD expects menu labels to be functions that append text to a d3 selection;
// giving the function a toString() keeps the plain text usable in tooltips,
// flash messages and log output.
function label(text) {
  const append = (selection) => selection.text(text);
  append.toString = () => text;
  return append;
}

// Put the Slide icon into a hidden SVG sprite as a <symbol>. iD renders
// operation icons with <use href="#iD-operation-slide">, the same ID its own
// operations use, which is how our entry claims the native icon slot in the
// context menu. The icon itself uses currentColor, so it follows iD's theme.
async function installIcon() {
  if (document.getElementById('iD-operation-slide')) return;
  const url = new URL('../../../../icons/slide.svg', import.meta.url);
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load the Slide icon.');
  const svg = new DOMParser().parseFromString(
    await response.text(),
    'image/svg+xml'
  ).documentElement;
  const ns = 'http://www.w3.org/2000/svg';
  const sprite = document.createElementNS(ns, 'svg');
  sprite.setAttribute('class', 'strava-slide-sprite');
  sprite.setAttribute('aria-hidden', 'true');
  const symbol = document.createElementNS(ns, 'symbol');
  symbol.id = 'iD-operation-slide';
  symbol.setAttribute('viewBox', svg.getAttribute('viewBox'));
  for (const child of [...svg.children]) symbol.append(document.importNode(child, true));
  sprite.append(symbol);
  document.body.append(sprite);
}

// Modal dialog with a progress bar. When several Strava heatmap overlays are
// enabled, the user first picks which activity to follow (chooseSource());
// with exactly one overlay that step is skipped. Returns small controls for
// the caller: chooseSource(), update(text, value) and close().
function showProgress(context, controller, sources) {
  const dialog = document.createElement('dialog');
  dialog.className = 'strava-slide-dialog';
  const heading = document.createElement('h3');
  heading.textContent = 'Strava Slide';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Loading heatmap…';
  const progress = document.createElement('progress');
  progress.max = 1;
  progress.value = 0;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => controller.abort());
  // Modal dialogs suppress iD's global event handling (its keyboard shortcuts
  // would fire while typing, and map gestures would leak through). Suppress
  // those events here instead of letting them reach iD.
  for (const type of ['click', 'pointerdown', 'pointerup', 'mousedown', 'keydown']) {
    dialog.addEventListener(type, (event) => event.stopPropagation());
  }
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    controller.abort();
  });
  dialog.append(heading, status, progress, cancel);
  heading.id = 'strava-slide-heading';
  dialog.setAttribute('aria-labelledby', heading.id);
  context.container().node().append(dialog);
  dialog.showModal();
  const chooseSource = () =>
    sources.length === 1
      ? Promise.resolve(sources[0])
      : new Promise((resolve, reject) => {
          status.textContent = 'Choose the activity heatmap to follow:';
          progress.hidden = true;
          const select = document.createElement('select');
          select.setAttribute('aria-label', 'Heatmap activity');
          sources.forEach((source, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = source.name();
            select.append(option);
          });
          const start = document.createElement('button');
          start.type = 'button';
          start.textContent = 'Slide';
          dialog.insertBefore(select, cancel);
          dialog.insertBefore(start, cancel);
          const abort = () => reject(new DOMException('Slide cancelled.', 'AbortError'));
          controller.signal.addEventListener('abort', abort, { once: true });
          start.addEventListener(
            'click',
            () => {
              controller.signal.removeEventListener('abort', abort);
              select.remove();
              start.remove();
              progress.hidden = false;
              resolve(sources[Number(select.value)]);
            },
            { once: true }
          );
        });
  return {
    chooseSource,
    update(text, value) {
      status.textContent = text;
      progress.value = value;
    },
    close() {
      dialog.close();
      dialog.remove();
    },
  };
}

// Called once by the extension after iD has booted. `isAuthenticated` reports
// the Strava login state of the extension (the tile requests would come back
// 401 without it).
function isEmptyPresetSearch(target) {
  return (
    target instanceof HTMLInputElement &&
    target.matches('.preset-search-input') &&
    !target.value
  );
}

export async function setupSlide(context, isAuthenticated) {
  await installIcon();
  let busy = false;
  const shortcut = window.iD.uiCmd('⇧S');

  // Create the iD operation ("Slide") for the given selected IDs. iD asks
  // available()/disabled() whenever the context menu opens or a shortcut is
  // pressed; running the operation performs the whole pipeline. `ids` is
  // captured at that moment so undo/redo and partial-way selections always refer
  // to the selection the user actually acted on.
  function createOperation(ids) {
    const operation = async () => {
      if (operation.disabled()) return;
      // Snapshot the graph: everything is computed against this state, and
      // action.js refuses to apply the edit if it no longer matches.
      const graph = context.graph();
      const selection = getSlideSelection(graph, ids);
      const controller = new AbortController();
      const sources = heatmapSources();
      busy = true;
      let progress;
      try {
        progress = showProgress(context, controller, sources);
        const source = await progress.chooseSource();
        const locations = selection.nodes.map((node) => node.loc);
        // 1. Tiles: downloaded and decoded to ordered heat density (tiles.js /
        //    png.js), buffered by the widest search radius the algorithm uses.
        const loaded = await loadSlideTiles(
          locations,
          source,
          controller.signal,
          (value) => progress.update('Loading heatmap…', value * 0.35)
        );
        progress.update('Following heatmap density…', 0.35);
        // 2. Merge the tiles into one raster and 3. fit the line to it. Fixed
        //    indices (tagged nodes, junctions) are passed along so they stay
        //    put; endpoints are always fixed inside slideLine() itself.
        const raster = createHeatmapRaster(loaded.tiles, loaded.zoom, loaded.bounds);
        const result = await slideLineTwice(locations, raster, {
          fixedIndices: fixedIndices(graph, selection),
          // Untagged junctions and the range ends may move, but no further
          // than the normal snap radius.
          limitedIndices: [
            0,
            selection.nodes.length - 1,
            ...protectedIndices(graph, selection),
          ],
          signal: controller.signal,
          onProgress: (value) =>
            progress.update('Following heatmap density…', 0.35 + value * 0.65),
        });
        if (!selectionUnchanged(graph, context.graph(), selection)) {
          throw new Error('The line changed while Slide was running. Please try again.');
        }
        if (!context.editable() || !isAuthenticated()) {
          throw new Error(
            'The editor or Strava session is no longer available. Please try again.'
          );
        }
        // 4. Clean up duplicate vertices (action.js holds the rules) and turn
        //    the result into an undoable graph edit.
        const cleaned = cleanSlideResult(graph, selection, result);
        const action = createSlideAction(
          graph,
          selection,
          cleaned,
          (attrs) => new window.iD.osmNode(attrs)
        );
        // iD rebuilds its select-mode operations synchronously on history
        // changes. Drop IDs of cleaned-up selected vertices first, so it never
        // dereferences a deleted node. Range endpoints (and the way) survive.
        const retained = new Set(
          cleaned
            .filter((point) => point.nodeIndex !== null)
            .map((point) => selection.nodes[point.nodeIndex].id)
        );
        const mode = context.mode();
        let previousSelection;
        if (mode?.id === 'select') {
          const current = mode.selectedIDs();
          const selected = current.filter(
            (id) => !selection.nodes.some((node) => node.id === id) || retained.has(id)
          );
          if (selected.length !== current.length) {
            previousSelection = current.slice();
            mode.selectedIDs(selected);
          }
        }
        try {
          context.perform(action, 'Slide along Strava heatmap');
        } catch (error) {
          // If the action failed, no node was deleted — restore the old
          // selection so the user's context is not lost.
          if (
            previousSelection &&
            previousSelection.every((id) => context.graph().hasEntity(id))
          ) {
            mode.selectedIDs(previousSelection);
          }
          throw error;
        }
        context.validator().validate();
        if (result.skipped) {
          const sections = result.skipped === 1 ? 'section' : 'sections';
          context
            .ui()
            .flash.duration(7000)
            .label(
              label(
                `${result.skipped} ${sections} without a usable heatmap trail left as drawn.`
              )
            )();
        } else {
          // Brief confirmation, like iD's own operations (behavior/operation.js).
          context
            .ui()
            .flash.duration(2000)
            .iconName('#iD-operation-slide')
            .iconClass('operation')
            .label(label('Slid along Strava heatmap.'))();
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.warn('[StravaHeatmapExt] Slide failed:', error);
          context
            .ui()
            .flash.duration(7000)
            .iconName('#iD-operation-slide')
            .iconClass('operation disabled strava-slide-error')
            .label(label(error.message || 'Slide failed. No edits were applied.'))();
        }
      } finally {
        controller.abort();
        progress?.close();
        busy = false;
      }
    };
    operation.id = 'slide';
    operation.keys = [shortcut];
    operation.title = label('Slide');
    operation.annotation = () => 'Slide along Strava heatmap';
    operation.available = () => Boolean(getSlideSelection(context.graph(), ids));
    // Preconditions, each mapped to a message the user can act on. They are
    // re-evaluated on every menu render because the state can change while
    // the menu is open (login, enabled overlays, downloaded data …).
    operation.disabled = () => {
      if (busy) return 'Slide is already running.';
      const selection = getSlideSelection(context.graph(), ids);
      if (!selection) return 'Select one open line, or vertices on the same open line.';
      if (context.inIntro() || !context.editable())
        return 'Slide is unavailable outside normal editing mode.';
      if (!isAuthenticated()) return 'Log into Strava using the extension first.';
      const sources = heatmapSources();
      if (!sources.length) return 'Enable a Strava heatmap overlay first.';
      for (const source of sources) {
        try {
          slideTileURL(source, 0, 0, 15);
        } catch (error) {
          return error.message;
        }
        if (source.offset?.().some((value) => value !== 0))
          return 'Reset the heatmap imagery offset before sliding.';
      }
      if (selection.nodes.length > 1000)
        return 'Select a shorter section (at most 1000 vertices).';
      if (isStructure(selection.way)) return 'Slide does not move bridges or tunnels.';
      const connection = context.connection();
      if (
        selection.nodes.some((node) => connection && !connection.isDataLoaded(node.loc))
      ) {
        return 'Download the OSM data around the line before sliding.';
      }
      if (selection.nodes.some((node) => context.hasHiddenConnections(node.id))) {
        return 'Show connected map features before sliding.';
      }
      return false;
    };
    operation.tooltip = () =>
      // While disabled, iD shows the reason instead of the tooltip text.
      operation.disabled() ||
      'Slide the selected line or vertex range along the Strava heatmap (Shift+S). Undo restores them.';
    return operation;
  }

  // The extension registers each Strava overlay as a background layer whose id
  // starts with "strava-heatmap-"; those are the candidate heatmap sources, and
  // the user picks one in the dialog when several are enabled.
  function heatmapSources() {
    return context
      .background()
      .overlayLayerSources()
      .filter((source) => source.id.startsWith('strava-heatmap-'));
  }

  // Shift+S handler. iD's bundled operation registry cannot be extended from
  // the outside, so the shortcut is bound here and runs the operation directly
  // (see attach() for the matching context-menu integration).
  function keypress(event) {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      busy ||
      !event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    )
      return;
    const target = event.target;
    if (
      target instanceof Element &&
      !isEmptyPresetSearch(target) &&
      (target.isContentEditable ||
        target.closest('input, textarea, select, [role="textbox"]'))
    )
      return;
    const mode = context.mode();
    if (mode?.id !== 'select' || !context.editable() || context.inIntro()) return;
    // Resolve the current selection/graph at keypress time, not when the menu
    // was opened: undo, selection changes and partial-way ranges must work too.
    const operation = createOperation(mode.selectedIDs().slice());
    if (!operation.available()) {
      // Say why, like iD does for its own unavailable operations, except while
      // typing into the preset search (a capital S is just a letter there).
      if (!isEmptyPresetSearch(target)) {
        context
          .ui()
          .flash.duration(4000)
          .iconName('#iD-operation-slide')
          .iconClass('operation disabled strava-slide-error')
          .label(
            label('Slide works on a line, or on two or more vertices of one line.')
          )();
      }
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (operation.disabled()) {
      // Same refusal style as iD's own operations (behavior/operation.js).
      context
        .ui()
        .flash.duration(4000)
        .iconName('#iD-operation-slide')
        .iconClass('operation disabled strava-slide-error')
        .label(label(operation.tooltip()))();
      return;
    }
    context.ui().closeEditMenu();
    return operation();
  }

  // iD closes over its bundled operation registry. Extending window.iD alone
  // does not register a new operation. Wrap each select mode's public accessor
  // instead, so the native edit menu positions, renders and invokes Slide.
  const wrapped = new WeakSet();
  // Hook a fresh select mode: bind ⇧S and splice Slide into the operations iD
  // renders in the context menu (just before "Delete", with the line tools).
  function attach() {
    // The context binding gives ⇧S priority over native S (Straighten), while
    // leaving unshifted S untouched. ui.restart() clears bindings and enters
    // browse mode, so rebind on EVERY mode entry, including an already-wrapped
    // select mode, rather than only on first selection.
    context.keybinding().off(shortcut).on(shortcut, keypress);
    const mode = context.mode();
    if (mode?.id !== 'select' || !mode.operations || wrapped.has(mode)) return;
    const original = mode.operations;
    mode.operations = function (...args) {
      const operations = original.apply(this, args);
      const slide = createOperation(mode.selectedIDs().slice());
      if (!slide.available() || operations.some((op) => op.id === 'slide'))
        return operations;
      // Next to Straighten, its closest relative; iD keeps Copy/Downgrade/Delete
      // grouped last, so fall back to just before Copy.
      const straighten = operations.findIndex((op) => op.id === 'straighten');
      const copy = operations.findIndex((op) => op.id === 'copy');
      const index =
        straighten >= 0 ? straighten + 1 : copy >= 0 ? copy : operations.length;
      const result = operations.slice();
      result.splice(index, 0, slide);
      return result;
    };
    wrapped.add(mode);
  }
  // After drawing a line, iD focuses the empty preset search, and its
  // keybinding ignores keys typed in inputs. Like iD's own undo hack there,
  // treat ⇧S as Slide until something is typed into that search.
  document.addEventListener(
    'keydown',
    (event) => {
      if (isEmptyPresetSearch(event.target) && event.key.toLowerCase() === 's')
        keypress(event);
    },
    true
  );
  context.on('enter.strava-slide', attach);
  attach();
}
