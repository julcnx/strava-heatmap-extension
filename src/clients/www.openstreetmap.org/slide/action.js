/**
 * Turn a fitted Slide result into an undoable iD edit.
 *
 * iD models OSM data as a "graph" of entities (nodes, ways, relations).
 * Editing never mutates in place: graph.replace(entity) and
 * graph.remove(entity) return a NEW graph, which is what makes Undo and redo
 * possible. A way stores an ordered list of node IDs, and OSM node IDs are
 * reused across edits so that tags and connections to other ways survive.
 *
 * The contract with algorithm.js is the result record:
 *   { loc: [lon, lat], nodeIndex }
 * nodeIndex identifies the original vertex the point came from; null means
 * "a point Slide created". slideLine() returns original vertices in order,
 * dropping free ones on straight stretches. This module decides which OSM nodes are moved, which are created,
 * and which redundant ones are deleted.
 *
 * Everything needed for the edit (including the new node IDs) is computed up
 * front, so Undo/redo replay the identical change, and any thrown error means
 * NO edit is applied at all.
 */

// Resolve what the user selected into { way, start, end, nodes }, or null when
// Slide cannot safely operate on it. Two selection shapes are accepted:
//   * one way            → the whole line (start = 0, end = last vertex);
//   * two or more nodes  → the vertex range between the first and last
//     selected node, but only when all of them lie on exactly one common way
//     (otherwise the intended range is ambiguous).
// Rejected: empty or closed lines, non-linear geometry (areas, waterway
// relations …), ways that repeat a node ID, and missing entities.
// `nodes` are the graph node objects of that range, in way order.
export function getSlideSelection(graph, ids) {
  if (!ids.length) return null;
  const entities = ids.map((id) => graph.hasEntity(id));
  if (entities.some((entity) => !entity)) return null;
  let way, start, end;
  if (entities.length === 1 && entities[0].type === 'way') {
    way = entities[0];
    start = 0;
    end = way.nodes.length - 1;
  } else if (entities.length >= 2 && entities.every((entity) => entity.type === 'node')) {
    const common = graph
      .parentWays(entities[0])
      .filter((parent) => entities.every((entity) => parent.nodes.includes(entity.id)));
    if (common.length !== 1) return null;
    way = common[0];
    const indices = ids.map((id) => way.nodes.indexOf(id));
    start = Math.min(...indices);
    end = Math.max(...indices);
  } else {
    return null;
  }
  // Closed lines (a loop, not an area) are allowed: their first and last node
  // are the same node, which then stays fixed. Any other repeat is ambiguous.
  const distinct = way.isClosed() ? way.nodes.slice(0, -1) : way.nodes;
  if (
    start === end ||
    way.geometry(graph) !== 'line' ||
    new Set(distinct).size !== distinct.length
  )
    return null;
  const nodeIDs = way.nodes.slice(start, end + 1);
  const nodes = nodeIDs.map((id) => graph.hasEntity(id));
  if (nodes.some((node) => !node)) return null;
  return { way, start, end, nodes };
}

// Bridges and tunnels are mapped to the structure, not to the heat.
export function isStructure(way) {
  return ['bridge', 'tunnel'].some((key) => way.tags[key] && way.tags[key] !== 'no');
}

// Indices (within the selection) of vertices that must not MOVE: tagged nodes
// (a ford, gate or crossing marks a specific spot), relation members,
// junctions (they are mapped where the ways meet, and moving one bends every
// connected way), and the range boundaries of a partial selection, which also
// belong to the unselected rest of the way. index.js also keeps the line's
// free ends in place.
export function fixedIndices(graph, selection) {
  const last = selection.nodes.length - 1;
  return selection.nodes.flatMap((node, i) =>
    Object.keys(node.tags).length ||
    graph.parentWays(node).length > 1 ||
    graph.parentRelations(node).length ||
    (i === 0 && selection.start > 0) ||
    (i === last && selection.end < selection.way.nodes.length - 1)
      ? [i]
      : []
  );
}

export function protectedIndices(graph, selection) {
  return selection.nodes.flatMap((node, i) =>
    Object.keys(node.tags).length ||
    graph.parentWays(node).length > 1 ||
    graph.parentRelations(node).length
      ? [i]
      : []
  );
}

// Vertices closer together than this are redundant (near-duplicates); the
// points of a smoothed turn (see smoothLine in algorithm.js) are spaced more
// widely. Slide-created nodes are
// removed first; existing OSM nodes are removed only when untagged, unused by
// any other way and not relation members — see cleanSlideResult() for the
// full rules. Only vertices within ALONG_LINE_METERS along the line are
// compared, so the two legs of a tight hairpin are never merged.
const CLOSE_METERS = 1.5;
const ALONG_LINE_METERS = 2 * CLOSE_METERS;
// Next to a junction, a slid vertex this close to the other way is still on
// that way's trail: a trail leaving a junction diverges from the other way.
const OVERLAP_METERS = 8;
// Trails only share heat for a short distance from a junction. A slid line
// staying that close to the other way for longer runs along it, on its trail.
const MAX_OVERLAP_METERS = 30;
// A single vertex where the line turns back by more than this is a spike (a
// vertex snapped onto a neighbouring trail): a real switchback traced by Slide
// has a rounded apex made of several gentler vertices.
const SPIKE_TURN_DEGREES = 150;

// Approximate ground distance in metres, using an equirectangular projection
// at the pair's mean latitude. Accurate to far better than 1 % over the tiny
// distances compared here, and much cheaper than a full haversine formula.
function distanceMeters(a, b) {
  const meanLat = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  return Math.hypot(
    (b[0] - a[0]) * Math.cos(meanLat) * 111319.49,
    (b[1] - a[1]) * 110574
  );
}

// Remove redundant vertices: from every pair of result points closer than
// CLOSE_METERS, drop one of them. All pairs are considered — not only
// neighbours — because a slide-created point may sit between two duplicate
// database nodes.
//
// Who may be dropped:
//   * slide-created points (nodeIndex === null) … always;
//   * original vertices … only when unprotected (untagged, not shared with
//     another way, not a relation member);
//   * never the first or last point — the range endpoints must stay.
// Which of a pair is dropped follows `rank`: slide-created < deletable
// original < keep, ties dropping the later point. In other words, Slide
// deletes its own nodes first and only touches existing OSM data when there is
// no alternative, which keeps the changeset small and easy to review.
//
// The function is idempotent — cleaning an already-clean result changes
// nothing — so both index.js and createSlideAction() may call it safely.
// Planar metres around `origin` (equirectangular), for the short distances
// compared below.
function toMeters(loc, origin) {
  return [
    (loc[0] - origin[0]) * Math.cos((origin[1] * Math.PI) / 180) * 111319.49,
    (loc[1] - origin[1]) * 110574,
  ];
}
function nearestOnSegment(p, a, b) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    length = dx * dx + dy * dy;
  const t = length
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
    : 0;
  return { t, point: [a[0] + t * dx, a[1] + t * dy] };
}

// Near a junction both trails share heat, so the slid line may run along the
// other way before reaching the junction, leaving the two ways on top of each
// other. From each junction, drop the slid vertices lying within OVERLAP_METERS
// of the other way (junctions themselves never move, see fixedIndices). When
// the overlap runs further than MAX_OVERLAP_METERS, the line followed the
// other way's trail instead of its own: that stretch is left as drawn rather
// than trimmed, which would otherwise reduce the line to a straight chord. The
// returned points count those stretches in `alongOther`. A vertex that stayed
// where it was drawn (left as drawn, or already on its trail) is the mapper's
// own and ends the overlap: it is never dropped.
function trimJunctionOverlaps(before, selection, result) {
  const protectedIndexes = new Set([
    0,
    selection.nodes.length - 1,
    ...protectedIndices(before, selection),
  ]);
  const removable = (point) =>
    point.nodeIndex === null ||
    (!protectedIndexes.has(point.nodeIndex) &&
      distanceMeters(point.loc, selection.nodes[point.nodeIndex].loc) >= CLOSE_METERS);
  let points = result.map((point) => ({ ...point, loc: point.loc.slice() }));
  let alongOther = 0;
  for (let index = 0; index < selection.nodes.length; index++) {
    const node = selection.nodes[index];
    for (const other of before.parentWays(node)) {
      // Only roads and paths have heat of their own (like otherWays in
      // index.js): a firebreak or a fence along the trail is not another trail.
      if (other.id === selection.way.id || !other.tags.highway) continue;
      if (!points.some((point) => point.nodeIndex === index)) continue;
      const origin = node.loc;
      const line = before.childNodes(other).map((n) => toMeters(n.loc, origin));
      const distance = (loc) =>
        Math.min(
          ...line.slice(1).map((b, k) => {
            const p = toMeters(loc, origin);
            const q = nearestOnSegment(p, line[k], b).point;
            return Math.hypot(p[0] - q[0], p[1] - q[1]);
          })
        );
      for (const step of [-1, 1]) {
        const r = points.findIndex((point) => point.nodeIndex === index);
        let k = r + step;
        while (
          k > 0 &&
          k < points.length - 1 &&
          removable(points[k]) &&
          distance(points[k].loc) < OVERLAP_METERS
        )
          k += step;
        const overlap = Math.abs(k - r) - 1;
        if (overlap <= 0) continue;
        let length = 0;
        for (let m = r; m !== k - step; m += step)
          length += distanceMeters(points[m].loc, points[m + step].loc);
        if (length > MAX_OVERLAP_METERS) {
          alongOther++;
          for (let m = r + step; m !== k; m += step) {
            if (points[m].nodeIndex !== null)
              points[m].loc = selection.nodes[points[m].nodeIndex].loc.slice();
          }
          points = points.filter(
            (point, i) =>
              point.nodeIndex !== null || i <= Math.min(r, k) || i >= Math.max(r, k)
          );
          continue;
        }
        const from = Math.min(r + step, k - step),
          to = Math.max(r + step, k - step);
        points = points.filter((_, i) => i < from || i > to);
      }
    }
  }
  points.alongOther = alongOther;
  return points;
}

export function cleanSlideResult(before, selection, input) {
  const result = trimJunctionOverlaps(before, selection, input);
  const protectedIndexes = new Set([
    0,
    selection.nodes.length - 1,
    ...protectedIndices(before, selection),
  ]);
  const removable = result.map((point, index) =>
    index === 0 || index === result.length - 1
      ? false
      : point.nodeIndex === null
        ? true
        : !protectedIndexes.has(point.nodeIndex)
  );
  // "Deletion rank": slide-created (0) loses to a deletable original (1),
  // which loses to anything protected (Infinity = keep).
  const rank = (index) =>
    !removable[index] ? Infinity : result[index].nodeIndex === null ? 0 : 1;
  const dropped = new Set();
  for (let i = 0; i < result.length; i++) {
    if (dropped.has(i)) continue;
    for (let j = i + 1, along = 0; j < result.length; j++) {
      along += distanceMeters(result[j - 1].loc, result[j].loc);
      if (along > ALONG_LINE_METERS) break;
      if (dropped.has(j)) continue;
      if (distanceMeters(result[i].loc, result[j].loc) >= CLOSE_METERS) continue;
      const a = rank(i),
        b = rank(j);
      if (a === Infinity && b === Infinity) continue;
      dropped.add(a < b ? i : j);
    }
  }
  // Remove spikes, sharpest first, until none are left.
  let kept = result.map((_, index) => index).filter((index) => !dropped.has(index));
  const turn = (a, b, c) => {
    const meanLat = (result[b].loc[1] * Math.PI) / 180;
    const vector = (from, to) => [
      (result[to].loc[0] - result[from].loc[0]) * Math.cos(meanLat),
      result[to].loc[1] - result[from].loc[1],
    ];
    const u = vector(a, b),
      v = vector(b, c);
    const length = Math.hypot(...u) * Math.hypot(...v);
    if (!length) return 0;
    const cosine = (u[0] * v[0] + u[1] * v[1]) / length;
    return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
  };
  for (;;) {
    let spike = -1,
      sharpest = SPIKE_TURN_DEGREES;
    for (let k = 1; k < kept.length - 1; k++) {
      if (!removable[kept[k]]) continue;
      const value = turn(kept[k - 1], kept[k], kept[k + 1]);
      if (value > sharpest) {
        spike = k;
        sharpest = value;
      }
    }
    if (spike === -1) break;
    kept.splice(spike, 1);
  }
  const cleaned = kept.map((index) => result[index]);
  cleaned.alongOther = result.alongOther;
  return cleaned;
}

// Fingerprint of everything else that uses a node: the sorted IDs of its
// parent ways and relations. Used to detect map edits made elsewhere while
// Slide was running.
function connections(graph, node) {
  return [
    graph
      .parentWays(node)
      .map((way) => way.id)
      .sort()
      .join(','),
    graph
      .parentRelations(node)
      .map((relation) => relation.id)
      .sort()
      .join(','),
  ].join(';');
}

// True when the way and every selected node are still the SAME objects with
// the same connections as when the operation started. Slide can take seconds
// (tile downloads, tracing); if the user edits the line meanwhile, the
// precomputed node list is stale, so the action aborts with "try again"
// instead of clobbering newer work.
export function selectionUnchanged(before, after, selection) {
  return (
    after.hasEntity(selection.way.id) === selection.way &&
    selection.nodes.every(
      (node) =>
        after.hasEntity(node.id) === node &&
        connections(before, node) === connections(after, node)
    )
  );
}

// Build the undoable action: a function graph => graph that
//   1. verifies nothing changed while Slide was running,
//   2. moves the retained original nodes and creates nodes for slide-created
//      points (`nodeFactory` allocates their OSM IDs),
//   3. rewrites the way's node list, and
//   4. deletes the original nodes that cleanup dropped.
// `before` is the graph the result was computed against; `selection` comes
// from getSlideSelection(); `result` from slideLine().
export function createSlideAction(before, selection, result, nodeFactory) {
  // Clean once here so the action is self-contained and safe for callers that
  // skipped the index.js-side cleanup.
  const points = cleanSlideResult(before, selection, result);
  const protectedNodes = new Set([
    0,
    selection.nodes.length - 1,
    ...protectedIndices(before, selection),
  ]);
  // The cleaned result must still start and end on the range's endpoints, keep
  // every protected vertex, list original indices in strictly ascending order,
  // and contain only finite coordinates. Anything else means the algorithm
  // misbehaved, so refuse to edit rather than write garbage to the graph.
  const keptIndexes = points
    .filter((point) => point.nodeIndex !== null)
    .map((point) => point.nodeIndex);
  const kept = new Set(keptIndexes);
  if (
    keptIndexes[0] !== 0 ||
    keptIndexes[keptIndexes.length - 1] !== selection.nodes.length - 1 ||
    keptIndexes.some((value, i) => i && value <= keptIndexes[i - 1]) ||
    [...protectedNodes].some((index) => !kept.has(index)) ||
    points.some(
      (point) =>
        !Array.isArray(point.loc) ||
        point.loc.length !== 2 ||
        !point.loc.every(Number.isFinite)
    )
  ) {
    throw new Error('Invalid Slide result. No edits were applied.');
  }
  // A loop's closing node is listed at both ends and must end up in one place.
  const lastIndex = selection.nodes.length - 1;
  if (
    selection.nodes[0].id === selection.nodes[lastIndex].id &&
    points[0].loc.some((v, i) => v !== points[points.length - 1].loc[i])
  ) {
    throw new Error('Invalid Slide result for a closed line. No edits were applied.');
  }
  const originals = points.filter((point) => point.nodeIndex !== null);
  const fixedNodes = new Set(fixedIndices(before, selection));
  for (const point of originals) {
    const node = selection.nodes[point.nodeIndex];
    if (fixedNodes.has(point.nodeIndex) && point.loc.some((v, i) => v !== node.loc[i])) {
      throw new Error('Slide attempted to move a protected node. No edits were applied.');
    }
  }
  // Originals that cleanup dropped: removed from the way below and, when
  // still safe, deleted from the graph so they do not linger as orphans.
  const droppedOriginals = selection.nodes.filter((_, index) => !kept.has(index));
  // OSM ways may reference at most 2000 nodes.
  const count = selection.way.nodes.length - selection.nodes.length + points.length;
  if (count > 2000)
    throw new Error('Result exceeds the OSM way node limit. Slide a shorter section.');
  // Allocate each new ID once. Undo/redo must not allocate different vertices.
  const nodes = points.map((point) =>
    point.nodeIndex === null
      ? nodeFactory({ loc: point.loc })
      : selection.nodes[point.nodeIndex].move(point.loc)
  );
  // Splice the new node IDs into the way. Everything outside the slid range
  // (before `start`, after `end`) keeps its original neighbours untouched.
  const ids = [
    ...selection.way.nodes.slice(0, selection.start),
    ...nodes.map((node) => node.id),
    ...selection.way.nodes.slice(selection.end + 1),
  ];
  return (graph) => {
    if (!selectionUnchanged(before, graph, selection)) {
      throw new Error('The line changed while Slide was running. Please try again.');
    }
    for (const node of nodes) graph = graph.replace(node);
    graph = graph.replace(selection.way.update({ nodes: ids }));
    for (const node of droppedOriginals) {
      // Defensive recheck after the way stopped referencing the node: a tagged,
      // shared or relation-member vertex must never become collateral cleanup.
      if (
        Object.keys(node.tags).length ||
        graph.parentWays(node).length ||
        graph.parentRelations(node).length
      ) {
        throw new Error(
          'Slide cleanup encountered a protected connection. No edits were applied.'
        );
      }
      graph = graph.remove(node);
    }
    return graph;
  };
}
