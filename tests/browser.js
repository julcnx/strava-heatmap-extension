import { setupSlide } from '../src/clients/www.openstreetmap.org/slide.js';
import { recolorGrayPNG } from './gray-palette.js';

const output = document.getElementById('result');
const messages = [];
function assert(condition, message) {
  if (!condition) throw new Error(message);
  messages.push(`PASS: ${message}`);
}

function makeNode(id, loc, tags = {}) {
  return { type: 'node', id, loc, tags, move: (loc) => makeNode(id, loc, tags) };
}
function makeWay(id, nodes, tags) {
  return {
    type: 'way',
    id,
    nodes,
    tags,
    geometry: () => 'line',
    isClosed: () => false,
    update: (attrs) => makeWay(id, attrs.nodes, tags),
  };
}
class Graph {
  constructor(entities) {
    this.entities = new Map(entities.map((entity) => [entity.id, entity]));
  }
  hasEntity(id) {
    return this.entities.get(id);
  }
  replace(entity) {
    return new Graph(
      [...this.entities.values()].filter((e) => e.id !== entity.id).concat(entity)
    );
  }
  parentWays(node) {
    return [...this.entities.values()].filter(
      (e) => e.type === 'way' && e.nodes.includes(node.id)
    );
  }
  parentRelations() {
    return [];
  }
}

try {
  const xml = new DOMParser().parseFromString(
    await (await fetch('../temp/lineInput.osc')).text(),
    'application/xml'
  );
  const nodes = [...xml.querySelectorAll('node')].map((node) =>
    makeNode(`n${node.getAttribute('id')}`, [
      Number(node.getAttribute('lon')),
      Number(node.getAttribute('lat')),
    ])
  );
  const way = makeWay(
    'w-1',
    [...xml.querySelectorAll('nd')].map((nd) => `n${nd.getAttribute('ref')}`),
    { highway: 'track' }
  );
  const before = new Graph([...nodes, way]);
  let graph = before,
    sourceList,
    entered,
    committed = 0,
    validated = 0,
    nextID = -1000;
  let forceFallback = false;
  let palette = 'hot';
  let authenticated = true,
    editable = true,
    inIntro = false;
  let selectedIDs = ['w-1'],
    activeMode,
    closedMenus = 0,
    straightenCalls = 0;
  let lastKeypress;
  const bindings = new Map();
  const keybinding = {
    on(key, callback) {
      bindings.set(key, callback);
      return this;
    },
    off(key) {
      bindings.delete(key);
      return this;
    },
    clear() {
      bindings.clear();
      return this;
    },
  };
  keybinding.on('S', () => {
    straightenCalls++;
  });
  // Match iD's shifted-before-unshifted priority, including its S fallback.
  // Focus/modifier/repeat safeguards are deliberately left to the real adapter.
  document.addEventListener('keydown', (event) => {
    const key = event.key.toUpperCase();
    const callback = (event.shiftKey && bindings.get(`⇧${key}`)) || bindings.get(key);
    lastKeypress = callback?.(event);
  });
  function pressKey(init = {}, target = document) {
    lastKeypress = undefined;
    const event = new KeyboardEvent('keydown', {
      key: 'S',
      code: 'KeyS',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    return { event, task: lastKeypress };
  }
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (url, options) => {
    const parsed = new URL(url, location.href);
    if (parsed.hostname !== 'content-a.strava.com') return nativeFetch(url, options);
    const [, color, z, x, y] = parsed.pathname.match(
      /\/globalheat\/[^/]+\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.png$/
    );
    if (forceFallback && z === '15') return new Response('', { status: 404 });
    const response = await nativeFetch(
      new URL(`../temp/${z}_${x}_${y}.png`, import.meta.url),
      options
    );
    if (color !== 'gray' || !response.ok) return response;
    return new Response(recolorGrayPNG(await response.arrayBuffer()), {
      headers: { 'Content-Type': 'image/png' },
    });
  };
  // Current iD exports osmNode as a class. A callable factory mock would hide
  // regressions where the operation forgets to use `new` for added vertices.
  class TestOsmNode {
    constructor({ loc }) {
      Object.assign(this, makeNode(`n${nextID--}`, loc));
    }
  }
  window.iD = { osmNode: TestOsmNode, uiCmd: (code) => code };
  const source = {
    id: 'strava-heatmap-all',
    name: () => 'All Sports',
    offset: () => [0, 0],
    url: ([x, y, z]) =>
      `https://content-a.strava.com/identified/globalheat/all/${palette}/${z}/${x}/${y}.png?v=19`,
  };
  sourceList = [source];
  const mode = {
    id: 'select',
    selectedIDs: () => selectedIDs,
    operations: () => [{ id: 'delete' }],
  };
  activeMode = mode;
  const errors = [];
  const flash = () => {};
  flash.duration = () => flash;
  flash.label = (append) => {
    append({ text: (text) => errors.push(text) });
    return flash;
  };
  const context = {
    graph: () => graph,
    mode: () => activeMode,
    inIntro: () => inIntro,
    editable: () => editable,
    keybinding: () => keybinding,
    background: () => ({ overlayLayerSources: () => sourceList }),
    container: () => ({ node: () => document.getElementById('editor') }),
    connection: () => ({ isDataLoaded: () => true }),
    hasHiddenConnections: () => false,
    ui: () => ({
      flash,
      closeEditMenu: () => {
        closedMenus++;
      },
    }),
    validator: () => ({ validate: () => validated++ }),
    on: (_, callback) => {
      entered = callback;
    },
    perform: (action) => {
      graph = action(graph);
      committed++;
    },
  };
  await setupSlide(context, () => authenticated);
  entered();
  const operation = mode.operations().find((op) => op.id === 'slide');
  assert(
    mode.operations().filter((op) => op.id === 'slide').length === 1,
    'operation registered exactly once'
  );
  assert(
    document.getElementById('iD-operation-slide'),
    'provided icon installed as native SVG symbol'
  );
  assert(!operation.disabled(), 'eligible selected line can slide');
  assert(
    operation.keys[0] === '⇧S' && operation.tooltip().includes('Shift+S'),
    'menu shortcut metadata and tooltip show Shift+S'
  );
  const title = document.createElement('span');
  operation.title({
    text: (text) => {
      title.textContent = text;
    },
  });
  assert(title.textContent === 'Slide', 'native iD title callback renders correctly');
  const running = operation();
  assert(document.querySelector('dialog[open]'), 'progress dialog opens');
  await running;
  assert(!errors.length, `operation succeeded without errors (${errors.join('; ')})`);
  assert(committed === 1 && validated === 1, 'one undoable edit with validation');
  assert(
    graph.hasEntity('w-1').nodes.length === 45,
    'production tracing and cleanup produce the expected 45-node result'
  );
  const insertedNodes = graph
    .hasEntity('w-1')
    .nodes.filter((id) => !before.hasEntity(id))
    .map((id) => graph.hasEntity(id));
  assert(
    insertedNodes.length === 35 &&
      insertedNodes.every((node) => node instanceof TestOsmNode),
    'inserted vertices use the iD node class constructor'
  );
  assert(
    nodes[0].loc.every((v, i) => v === graph.hasEntity(nodes[0].id).loc[i]),
    'first endpoint unchanged'
  );
  assert(
    nodes.at(-1).loc.every((v, i) => v === graph.hasEntity(nodes.at(-1).id).loc[i]),
    'last endpoint unchanged'
  );
  assert(!document.querySelector('dialog'), 'progress dialog cleaned up');
  const hotLocations = graph.hasEntity('w-1').nodes.map((id) => graph.hasEntity(id).loc);
  graph = before;
  palette = 'gray';
  await operation();
  assert(
    committed === 2 &&
      !errors.length &&
      JSON.stringify(
        graph.hasEntity('w-1').nodes.map((id) => graph.hasEntity(id).loc)
      ) === JSON.stringify(hotLocations),
    'a real non-monotonic gray palette produces exactly the same geometry as hot'
  );
  graph = before;
  forceFallback = true;
  await operation();
  assert(
    committed === 3 && !errors.length,
    'missing zoom-15 tiles correctly fall back to zoom 14'
  );
  assert(
    graph.hasEntity('w-1').nodes.length > 10,
    'parent fallback also inserts curve vertices'
  );
  graph = before;
  sourceList = [source, { ...source, id: 'strava-heatmap-run', name: () => 'Running' }];
  const cancelled = operation();
  assert(
    document.querySelector('dialog select'),
    'multiple overlays offer an activity choice'
  );
  [...document.querySelectorAll('dialog button')]
    .find((button) => button.textContent === 'Cancel')
    .click();
  await cancelled;
  assert(committed === 3 && graph === before, 'cancellation makes no edit');
  assert(!document.querySelector('dialog'), 'cancelled dialog cleaned up');

  sourceList = [source];
  forceFallback = false;
  palette = 'hot';
  const shortcut = pressKey();
  assert(
    shortcut.event.defaultPrevented && document.querySelector('dialog[open]'),
    'Shift+S starts Slide on the selected line'
  );
  pressKey({ repeat: true });
  pressKey();
  await shortcut.task;
  assert(
    committed === 4 && !errors.length && straightenCalls === 0 && closedMenus === 1,
    'shortcut closes the menu, runs once, and never invokes native Straighten'
  );
  graph = before;

  for (const tag of ['input', 'textarea', 'select']) {
    const field = document.createElement(tag);
    document.getElementById('editor').append(field);
    const key = pressKey({}, field);
    assert(
      !key.event.defaultPrevented && committed === 4 && !document.querySelector('dialog'),
      `Shift+S does not interrupt typing in ${tag}`
    );
    field.remove();
  }
  const text = document.createElement('div');
  text.contentEditable = 'true';
  const child = document.createElement('span');
  text.append(child);
  document.getElementById('editor').append(text);
  assert(
    !pressKey({}, child).event.defaultPrevented && committed === 4,
    'Shift+S does not interrupt inherited contenteditable text'
  );
  text.remove();
  for (const init of [
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { ctrlKey: true, altKey: true },
    { repeat: true },
    { isComposing: true },
  ]) {
    assert(
      !pressKey(init).event.defaultPrevented && committed === 4,
      `modified, repeating or composing shortcut is ignored: ${JSON.stringify(init)}`
    );
  }

  activeMode = { id: 'draw-line' };
  assert(
    !pressKey().event.defaultPrevented && committed === 4,
    'Slide shortcut does not interfere with drawing mode'
  );
  activeMode = mode;
  selectedIDs = [nodes[0].id];
  assert(
    !pressKey().event.defaultPrevented && committed === 4,
    'Slide shortcut ignores an ineligible selection'
  );
  selectedIDs = ['w-1'];
  editable = false;
  assert(
    !pressKey().event.defaultPrevented && committed === 4,
    'Slide shortcut is inactive when the map is not editable'
  );
  editable = true;
  inIntro = true;
  assert(
    !pressKey().event.defaultPrevented && committed === 4,
    'Slide shortcut is inactive during the walkthrough'
  );
  inIntro = false;
  authenticated = false;
  assert(
    pressKey().event.defaultPrevented &&
      committed === 4 &&
      errors.at(-1).includes('Log into Strava'),
    'disabled shortcut explains missing authentication without editing'
  );
  errors.length = 0;
  authenticated = true;
  sourceList = [];
  assert(
    pressKey().event.defaultPrevented &&
      committed === 4 &&
      errors.at(-1).includes('Enable a Strava heatmap'),
    'disabled shortcut explains the missing overlay without editing'
  );
  errors.length = 0;
  sourceList = [source];
  pressKey({ shiftKey: false, key: 's' });
  assert(
    straightenCalls === 1 && committed === 4,
    'unshifted S remains assigned to native Straighten'
  );

  keybinding.clear();
  activeMode = { id: 'browse' };
  entered();
  assert(bindings.has('⇧S'), 'shortcut rebinds after UI restart enters browse mode');
  activeMode = mode;
  selectedIDs = [nodes[1].id, nodes[3].id];
  entered();
  entered();
  const partial = pressKey();
  await partial.task;
  assert(
    committed === 5 &&
      !errors.length &&
      closedMenus === 2 &&
      graph.hasEntity(nodes[0].id) === before.hasEntity(nodes[0].id) &&
      graph.hasEntity(nodes.at(-1).id) === before.hasEntity(nodes.at(-1).id),
    'rebound shortcut resolves the current vertex range and leaves unselected nodes alone'
  );
  assert(
    mode.operations().filter((op) => op.id === 'slide').length === 1 &&
      bindings.has('⇧S'),
    'repeated mode entries do not duplicate the operation or shortcut'
  );
  output.textContent = messages.join('\n');
  document.body.dataset.passed = 'true';
} catch (error) {
  output.textContent = `${messages.join('\n')}\nFAIL: ${error.stack}`;
  document.body.dataset.passed = 'false';
}
