// Safety rules of the Slide edit (src/clients/www.openstreetmap.org/slide/action.js),
// on a minimal in-memory stand-in for iD's graph. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanSlideResult,
  createSlideAction,
  fixedIndices,
  getSlideSelection,
  isStructure,
} from '../src/clients/www.openstreetmap.org/slide/action.js';

class Node {
  constructor(id, loc, tags = {}) {
    Object.assign(this, { id, loc, tags, type: 'node' });
  }
  move(loc) {
    return new Node(this.id, loc, this.tags);
  }
}
class Way {
  constructor(id, nodes, tags = {}) {
    Object.assign(this, { id, nodes, tags, type: 'way' });
  }
  update({ nodes }) {
    return new Way(this.id, nodes, this.tags);
  }
  isClosed() {
    return this.nodes.length > 2 && this.nodes[0] === this.nodes[this.nodes.length - 1];
  }
  geometry() {
    return this.isClosed() && this.tags.area === 'yes' ? 'area' : 'line';
  }
}
class Graph {
  constructor(entities, relations = {}) {
    this.entities = entities;
    this.relations = relations;
  }
  entity(id) {
    return this.entities[id];
  }
  hasEntity(id) {
    return this.entities[id];
  }
  replace(entity) {
    return new Graph({ ...this.entities, [entity.id]: entity }, this.relations);
  }
  remove(entity) {
    const entities = { ...this.entities };
    delete entities[entity.id];
    return new Graph(entities, this.relations);
  }
  parentWays(node) {
    return Object.values(this.entities).filter(
      (e) => e.type === 'way' && e.nodes.includes(node.id)
    );
  }
  parentRelations(node) {
    return this.relations[node.id] || [];
  }
  childNodes(way) {
    return way.nodes.map((id) => this.entities[id]);
  }
}

// Metres east/north of (0, 0) as [lon, lat].
const at = (east, north) => [east / 111319.49, north / 110574];
let nextId = 0;
const factory = ({ loc }) => new Node(`new${++nextId}`, loc);

// A 110 m line a–b–c whose end `a` is a junction with another 110 m way o.
function junctionCase(junctionTags = {}) {
  const nodes = {
    a: new Node('a', at(0, 0), junctionTags),
    b: new Node('b', at(55, 33)),
    c: new Node('c', at(110, 33)),
    o1: new Node('o1', at(0, -55)),
    o2: new Node('o2', at(0, 55)),
  };
  const way = new Way('w', ['a', 'b', 'c']);
  const graph = new Graph({ ...nodes, w: way, o: new Way('o', ['o1', 'a', 'o2']) });
  return {
    graph,
    selection: { way, start: 0, end: 2, nodes: [nodes.a, nodes.b, nodes.c] },
  };
}

test('fixed vertices: tagged, relation members, junctions, partial-range boundaries', () => {
  const { graph, selection } = junctionCase();
  assert.deepEqual(fixedIndices(graph, selection), [0]); // untagged junction

  const tagged = junctionCase({ ford: 'yes' });
  assert.deepEqual(fixedIndices(tagged.graph, tagged.selection), [0]);

  const member = new Graph(graph.entities, { b: [{ id: 'r' }] });
  assert.deepEqual(fixedIndices(member, selection), [0, 1]);

  const partial = { ...selection, start: 1, nodes: selection.nodes.slice(1) };
  assert.deepEqual(fixedIndices(graph, partial), [0]);
});

test('every junction stays fixed; free line ends are left to the caller', () => {
  const nodes = {
    a: new Node('a', at(0, 0)),
    b: new Node('b', at(100, 0)),
    c: new Node('c', at(200, 0)),
    e: new Node('e', at(300, 0)),
    d: new Node('d', at(400, 0)),
    f: new Node('f', at(200, 25)),
    g: new Node('g', at(100, 300)),
  };
  const road = new Way('road', ['a', 'b', 'c', 'e']);
  const graph = new Graph({
    ...nodes,
    road,
    bridge: new Way('bridge', ['e', 'd'], { bridge: 'yes' }),
    short: new Way('short', ['c', 'f']),
    long: new Way('long', ['b', 'g']),
  });
  const selection = {
    way: road,
    start: 0,
    end: 3,
    nodes: road.nodes.map((id) => nodes[id]),
  };
  assert.deepEqual(fixedIndices(graph, selection), [1, 2, 3]);
  assert.equal(isStructure(new Way('x', [], { tunnel: 'culvert' })), true);
  assert.equal(isStructure(new Way('x', [], { bridge: 'no' })), false);
});

test('moving a junction or a tagged node is refused and nothing is edited', () => {
  const result = [
    { loc: at(2, 3), nodeIndex: 0 },
    { loc: at(55, 30), nodeIndex: 1 },
    { loc: at(110, 33), nodeIndex: 2 },
  ];
  for (const { graph, selection } of [junctionCase(), junctionCase({ ford: 'yes' })]) {
    assert.throws(
      () => createSlideAction(graph, selection, result, factory),
      /protected node/
    );
  }
});

test('vertices closer than 1.5 m merge; Slide-created ones go first', () => {
  const { graph, selection } = junctionCase();
  const result = [
    { loc: at(0, 0), nodeIndex: 0 },
    { loc: at(30, 15), nodeIndex: null },
    { loc: at(55, 33), nodeIndex: 1 },
    { loc: at(56, 33), nodeIndex: null }, // 1 m from b
    { loc: at(110, 33), nodeIndex: 2 },
  ];
  const cleaned = cleanSlideResult(graph, selection, result);
  assert.deepEqual(
    cleaned.map((p) => p.nodeIndex),
    [0, null, 1, 2]
  );
});

test('a vertex turning back by more than 150 degrees is removed', () => {
  const { graph, selection } = junctionCase();
  const result = [
    { loc: at(0, 0), nodeIndex: 0 },
    { loc: at(30, 20), nodeIndex: null },
    { loc: at(40, -60), nodeIndex: null }, // spike
    { loc: at(50, 25), nodeIndex: null },
    { loc: at(55, 33), nodeIndex: 1 },
    { loc: at(110, 33), nodeIndex: 2 },
  ];
  const cleaned = cleanSlideResult(graph, selection, result);
  assert.ok(!cleaned.some((p) => p.loc[1] < 0));
});

test('running along the other way into a junction is trimmed', () => {
  const result = [
    { loc: at(0, 0), nodeIndex: 0 },
    { loc: at(5, 11), nodeIndex: null }, // within 8 m of the other way
    { loc: at(7, 20), nodeIndex: null },
    { loc: at(16, 27), nodeIndex: null },
    { loc: at(55, 33), nodeIndex: 1 },
    { loc: at(110, 33), nodeIndex: 2 },
  ];
  const { graph, selection } = junctionCase();
  const kept = cleanSlideResult(graph, selection, result);
  assert.equal(kept.length, 4);
  assert.deepEqual(kept[0].loc, at(0, 0)); // the junction stays
  assert.deepEqual([...cleanSlideResult(graph, selection, kept)], [...kept]); // idempotent
});

test('a line slid along the way it joins is left as drawn, not trimmed', () => {
  // Example 4 of #43: a path joined to a track at both ends, slid onto the
  // track's heat 5 m beside it. Trimming would leave a straight line.
  const nodes = {
    a: new Node('a', at(0, 0)),
    b: new Node('b', at(-30, -100)),
    c: new Node('c', at(-30, -200)),
    d: new Node('d', at(0, -300)),
    t1: new Node('t1', at(0, 50)),
    t2: new Node('t2', at(0, -350)),
  };
  const path = new Way('path', ['a', 'b', 'c', 'd']);
  const graph = new Graph({
    ...nodes,
    path,
    track: new Way('track', ['t1', 'a', 'd', 't2']),
  });
  const selection = getSlideSelection(graph, ['path']);
  const result = [{ loc: at(0, 0), nodeIndex: 0 }];
  for (let north = -20; north > -300; north -= 20) {
    const nodeIndex = north === -100 ? 1 : north === -200 ? 2 : null;
    result.push({ loc: at(-5, north), nodeIndex });
  }
  result.push({ loc: at(0, -300), nodeIndex: 3 });
  const cleaned = cleanSlideResult(graph, selection, result);
  assert.equal(cleaned.alongOther, 1);
  assert.deepEqual(
    cleaned.map((p) => p.loc),
    selection.nodes.map((node) => node.loc)
  );
  const after = createSlideAction(graph, selection, result, factory)(graph);
  assert.deepEqual(after.entity('path').nodes, ['a', 'b', 'c', 'd']);
  assert.ok(after.hasEntity('b') && after.hasEntity('c'));
});

test('junctions and endpoints are never deleted; untagged duplicates are', () => {
  const { graph, selection } = junctionCase();
  const result = [
    { loc: at(0, 0), nodeIndex: 0 },
    { loc: at(109, 33), nodeIndex: 1 }, // b slid onto c: duplicate
    { loc: at(110, 33), nodeIndex: 2 },
  ];
  const after = createSlideAction(graph, selection, result, factory)(graph);
  assert.deepEqual(after.entity('w').nodes, ['a', 'c']);
  assert.equal(after.hasEntity('b'), undefined);
  assert.ok(after.hasEntity('a') && after.hasEntity('c'));
});

test('closed lines can be slid; the closing node moves as one', () => {
  const nodes = {
    p: new Node('p', at(0, 0)),
    q: new Node('q', at(100, 0)),
    r: new Node('r', at(50, 80)),
  };
  const loop = new Way('loop', ['p', 'q', 'r', 'p'], { highway: 'track' });
  const graph = new Graph({ ...nodes, loop });
  const selection = getSlideSelection(graph, ['loop']);
  assert.ok(selection);
  assert.deepEqual(fixedIndices(graph, selection), []); // untagged closing node may move
  const result = [
    { loc: at(2, 1), nodeIndex: 0 },
    { loc: at(100, 3), nodeIndex: 1 },
    { loc: at(52, 80), nodeIndex: 2 },
    { loc: at(2, 1), nodeIndex: 3 },
  ];
  const after = createSlideAction(graph, selection, result, factory)(graph);
  assert.deepEqual(after.entity('loop').nodes, ['p', 'q', 'r', 'p']);
  assert.deepEqual(after.entity('p').loc, at(2, 1));

  const split = result.map((p, i) => (i === 3 ? { ...p, loc: at(0, 0) } : p));
  assert.throws(() => createSlideAction(graph, selection, split, factory), /closed line/);

  const area = new Way('area', ['p', 'q', 'r', 'p'], { area: 'yes' });
  assert.equal(getSlideSelection(new Graph({ ...nodes, area }), ['area']), null);
});
