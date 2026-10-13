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
 * "a point Slide created". slideLine() returns every original vertex in
 * order. This module decides which OSM nodes are moved, which are created,
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
  if (
    start === end ||
    way.geometry(graph) !== 'line' ||
    way.isClosed() ||
    new Set(way.nodes).size !== way.nodes.length
  )
    return null;
  const nodeIDs = way.nodes.slice(start, end + 1);
  const nodes = nodeIDs.map((id) => graph.hasEntity(id));
  if (nodes.some((node) => !node)) return null;
  return { way, start, end, nodes };
}

// Indices (within the selection) of vertices that must never move or be
// deleted: anything carrying tags, used by more than one way (junctions), or
// referenced by a relation. Slide treats them as fixed anchors. The range
// endpoints are protected as well, but separately, because they are special
// even when untagged: they keep the way connected to the rest of the map.
export function protectedIndices(graph, selection) {
  return selection.nodes.flatMap((node, i) =>
    Object.keys(node.tags).length ||
    graph.parentWays(node).length > 1 ||
    graph.parentRelations(node).length
      ? [i]
      : []
  );
}

// Vertices closer together than this are redundant duplicates (1 m is well
// below one zoom-15 pixel of ~2.4 m, so this only ever removes true
// duplicates). Slide-created nodes are removed first; existing OSM nodes are
// removed only when untagged, unused by any other way and not relation
// members — see cleanSlideResult() for the full rules.
const CLOSE_METERS = 1;

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
export function cleanSlideResult(before, selection, result) {
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
    for (let j = i + 1; j < result.length; j++) {
      if (dropped.has(j)) continue;
      if (distanceMeters(result[i].loc, result[j].loc) >= CLOSE_METERS) continue;
      const a = rank(i),
        b = rank(j);
      if (a === Infinity && b === Infinity) continue;
      dropped.add(a < b ? i : j);
    }
  }
  return result.filter((_, index) => !dropped.has(index));
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
  const originals = points.filter((point) => point.nodeIndex !== null);
  for (const point of originals) {
    const node = selection.nodes[point.nodeIndex];
    if (
      protectedNodes.has(point.nodeIndex) &&
      point.loc.some((v, i) => v !== node.loc[i])
    ) {
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
