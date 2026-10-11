import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSlideSelection,
  protectedIndices,
  createSlideAction,
  selectionUnchanged,
} from '../src/clients/www.openstreetmap.org/slide-action.js';
import {
  slideTileURL,
  loadSlideTiles,
} from '../src/clients/www.openstreetmap.org/slide-tiles.js';

function node(id, loc, tags = {}) {
  return {
    id,
    type: 'node',
    loc,
    tags,
    move(loc) {
      return node(id, loc, tags);
    },
  };
}

function way(id, nodes, tags = { highway: 'track' }) {
  return {
    id,
    type: 'way',
    nodes,
    tags,
    geometry: () => (tags.area === 'yes' ? 'area' : 'line'),
    isClosed: () => nodes[0] === nodes.at(-1),
    update: (attrs) => way(id, attrs.nodes, tags),
  };
}

class Graph {
  constructor(entities) {
    this.entities = new Map(entities.map((e) => [e.id, e]));
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
  parentRelations(node) {
    return [...this.entities.values()].filter(
      (e) => e.type === 'relation' && e.members.includes(node.id)
    );
  }
}

function fixture() {
  const nodes = Array.from({ length: 5 }, (_, i) => node(`n${i}`, [103 + i / 10000, 1]));
  return new Graph([
    ...nodes,
    way(
      'w1',
      nodes.map((n) => n.id)
    ),
  ]);
}

test('one open line or an unambiguous vertex range is eligible', () => {
  const graph = fixture();
  assert.equal(getSlideSelection(graph, ['w1']).nodes.length, 5);
  const range = getSlideSelection(graph, ['n3', 'n1']);
  assert.equal(range.start, 1);
  assert.equal(range.end, 3);
  assert.deepEqual(
    range.nodes.map((n) => n.id),
    ['n1', 'n2', 'n3']
  );
  assert.equal(getSlideSelection(graph, ['n1']), null);
  assert.equal(getSlideSelection(graph, ['w1', 'n1']), null);
  assert.equal(
    getSlideSelection(graph.replace(way('w2', ['n1', 'n3'])), ['n1', 'n3']),
    null
  );
  assert.equal(
    getSlideSelection(graph.replace(way('w1', ['n1', 'n2', 'n1'])), ['w1']),
    null
  );
  assert.equal(
    getSlideSelection(graph.replace(way('w1', ['n1', 'n2'], { area: 'yes' })), ['w1']),
    null
  );
});

test('tagged, shared and relation-member nodes are protected', () => {
  const graph = fixture()
    .replace(node('n1', [103, 1], { barrier: 'gate' }))
    .replace(way('w2', ['n2', 'n4']))
    .replace({ id: 'r1', type: 'relation', members: ['n3'] });
  assert.deepEqual(
    protectedIndices(graph, getSlideSelection(graph, ['w1'])),
    [1, 2, 3, 4]
  );
});

test('action retains IDs and tags, leaves unselected sections alone, and is redo-stable', () => {
  const graph = fixture();
  const selection = getSlideSelection(graph, ['n1', 'n3']);
  const result = [
    { loc: selection.nodes[0].loc, nodeIndex: 0 },
    { loc: [103.00015, 1.00002], nodeIndex: null },
    { loc: [103.0002, 1.00003], nodeIndex: 1 },
    { loc: selection.nodes[2].loc, nodeIndex: 2 },
  ];
  let allocated = 0;
  const action = createSlideAction(graph, selection, result, ({ loc }) =>
    node(`n-${++allocated}`, loc)
  );
  const edited = action(graph);
  assert.equal(allocated, 1);
  assert.deepEqual(edited.hasEntity('w1').nodes, ['n0', 'n1', 'n-1', 'n2', 'n3', 'n4']);
  assert.deepEqual(edited.hasEntity('w1').tags, { highway: 'track' });
  assert.equal(edited.hasEntity('n0'), graph.hasEntity('n0'));
  assert.equal(edited.hasEntity('n4'), graph.hasEntity('n4'));
  assert.deepEqual(edited.hasEntity('n2').loc, result[2].loc);
  assert.deepEqual(action(graph).hasEntity('w1').nodes, edited.hasEntity('w1').nodes);
  assert.equal(allocated, 1, 'redo never allocates new IDs');
});

test('changed geometry or topology rejects stale asynchronous results', () => {
  const graph = fixture(),
    selection = getSlideSelection(graph, ['w1']);
  const result = selection.nodes.map((node, nodeIndex) => ({ loc: node.loc, nodeIndex }));
  const action = createSlideAction(graph, selection, result, () => assert.fail());
  const moved = graph.replace(graph.hasEntity('n2').move([104, 1]));
  assert.equal(selectionUnchanged(graph, moved, selection), false);
  assert.throws(() => action(moved), /line changed/);
  assert.throws(() => action(graph.replace(way('w2', ['n2', 'n4']))), /line changed/);
  const unrelated = graph.replace(node('n99', [104, 2]));
  assert.equal(selectionUnchanged(graph, unrelated, selection), true);
});

test('action refuses corrupted vertex mapping and movement of protected endpoints', () => {
  const graph = fixture(),
    selection = getSlideSelection(graph, ['w1']);
  const result = selection.nodes.map((node, nodeIndex) => ({ loc: node.loc, nodeIndex }));
  assert.throws(
    () => createSlideAction(graph, selection, result.slice(1), () => assert.fail()),
    /Invalid Slide/
  );
  result[0] = { ...result[0], loc: [104, 1] };
  assert.throws(
    () => createSlideAction(graph, selection, result, () => assert.fail()),
    /protected node/
  );
});

test('live tiles preserve the selected activity, palette and query', () => {
  const source = {
    url: ([x, y, z]) =>
      `https://content-a.strava.com/identified/globalheat/sport_TrailRun/hot/${z}/${x}/${y}.png?v=19&t=123`,
  };
  assert.equal(
    slideTileURL(source, 25845, 16255, 15),
    'https://content-a.strava.com/identified/globalheat/sport_TrailRun/hot/15/25845/16255.png?v=19&t=123'
  );
  assert.throws(
    () => slideTileURL({ url: () => 'https://example.com/fallback.png' }, 0, 0, 15),
    /Log into Strava/
  );
});

test('tile request authentication errors do not silently fall back to coarser tiles', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return { ok: false, status: 403 };
  };
  try {
    const source = {
      url: ([x, y, z]) =>
        `https://content-a.strava.com/identified/globalheat/all/hot/${z}/${x}/${y}.png`,
    };
    await assert.rejects(
      loadSlideTiles(
        [
          [103.943, 1.414],
          [103.9431, 1.4141],
        ],
        source,
        new AbortController().signal
      ),
      /access expired/
    );
    assert.ok(requests.every((url) => url.includes('/15/')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
