import { createHeatmapRaster, slideLine } from '../common/slide.js';
import {
  createSlideAction,
  getSlideSelection,
  protectedIndices,
  selectionUnchanged,
} from './slide-action.js';
import { loadSlideTiles, slideTileURL } from './slide-tiles.js';

function label(text) {
  const append = (selection) => selection.text(text);
  append.toString = () => text;
  return append;
}

async function installIcon() {
  if (document.getElementById('iD-operation-slide')) return;
  const url = new URL('../../../icons/slide.svg', import.meta.url);
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
  // Keep iD's map gestures, click-default suppression and keyboard operations
  // out of the modal (particularly its native activity select control).
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

export async function setupSlide(context, isAuthenticated) {
  await installIcon();
  let busy = false;
  const shortcut = window.iD.uiCmd('⇧S');

  function createOperation(ids) {
    const operation = async () => {
      if (operation.disabled()) return;
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
        const loaded = await loadSlideTiles(
          locations,
          source,
          controller.signal,
          (value) => progress.update('Loading heatmap…', value * 0.35)
        );
        progress.update('Following heatmap density…', 0.35);
        const raster = createHeatmapRaster(loaded.tiles, loaded.zoom, loaded.bounds);
        const result = await slideLine(locations, raster, {
          fixedIndices: protectedIndices(graph, selection),
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
        context.perform(
          createSlideAction(
            graph,
            selection,
            result,
            (attrs) => new window.iD.osmNode(attrs)
          ),
          'Slide along Strava heatmap'
        );
        context.validator().validate();
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.warn('[StravaHeatmapExt] Slide failed:', error);
          context
            .ui()
            .flash.duration(7000)
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
      operation.disabled() ||
      'Slide the selected line or vertex range along the Strava heatmap (Shift+S). Removes small kinks while keeping endpoints and connected/tagged nodes fixed. Undo to restore the line.';
    return operation;
  }

  function heatmapSources() {
    return context
      .background()
      .overlayLayerSources()
      .filter((source) => source.id.startsWith('strava-heatmap-'));
  }

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
      (target.isContentEditable ||
        target.closest('input, textarea, select, [role="textbox"]'))
    )
      return;
    const mode = context.mode();
    if (mode?.id !== 'select' || !context.editable() || context.inIntro()) return;
    // Resolve the current selection/graph at keypress time, not when the menu
    // was opened: undo, selection changes and partial-way ranges must work too.
    const operation = createOperation(mode.selectedIDs().slice());
    if (!operation.available()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (operation.disabled()) {
      context.ui().flash.duration(4000).label(label(operation.tooltip()))();
      return;
    }
    context.ui().closeEditMenu();
    return operation();
  }

  // iD closes over its bundled operation registry. Extending window.iD alone
  // does not register a new operation. Wrap each select mode's public accessor
  // instead, so the native edit menu positions, renders and invokes Slide.
  const wrapped = new WeakSet();
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
      const index = operations.findIndex((op) => op.id === 'delete');
      const result = operations.slice();
      result.splice(index < 0 ? result.length : index, 0, slide);
      return result;
    };
    wrapped.add(mode);
  }
  context.on('enter.strava-slide', attach);
  attach();
}
