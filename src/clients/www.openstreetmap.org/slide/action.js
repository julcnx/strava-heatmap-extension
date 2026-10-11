// iD graph selection and undoable edits for Slide.
// Select one open linear way, or an unambiguous range of vertices on one way.
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

export function protectedIndices(graph, selection) {
  return selection.nodes.flatMap((node, i) =>
    Object.keys(node.tags).length ||
    graph.parentWays(node).length > 1 ||
    graph.parentRelations(node).length
      ? [i]
      : []
  );
}

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

export function createSlideAction(before, selection, result, nodeFactory) {
  const originals = result.filter((point) => point.nodeIndex !== null);
  if (
    originals.length !== selection.nodes.length ||
    originals.some((point, i) => point.nodeIndex !== i) ||
    result.some(
      (point) =>
        !Array.isArray(point.loc) ||
        point.loc.length !== 2 ||
        !point.loc.every(Number.isFinite)
    )
  ) {
    throw new Error('Invalid Slide result. No edits were applied.');
  }
  const protectedNodes = new Set([
    0,
    selection.nodes.length - 1,
    ...protectedIndices(before, selection),
  ]);
  for (const point of originals) {
    const node = selection.nodes[point.nodeIndex];
    if (
      protectedNodes.has(point.nodeIndex) &&
      point.loc.some((v, i) => v !== node.loc[i])
    ) {
      throw new Error('Slide attempted to move a protected node. No edits were applied.');
    }
  }
  const count = selection.way.nodes.length - selection.nodes.length + result.length;
  if (count > 2000)
    throw new Error('Result exceeds the OSM way node limit. Slide a shorter section.');
  // Allocate each new ID once. Undo/redo must not allocate different vertices.
  const nodes = result.map((point) =>
    point.nodeIndex === null
      ? nodeFactory({ loc: point.loc })
      : selection.nodes[point.nodeIndex].move(point.loc)
  );
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
    return graph.replace(selection.way.update({ nodes: ids }));
  };
}
