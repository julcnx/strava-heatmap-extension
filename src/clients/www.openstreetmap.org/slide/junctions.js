// Detect where trails meet on the Strava heatmap (from unpaved-app's segments.js).
// The heat is thresholded on the contrast-normalised tracking surface, so faint
// trails count as much as bright roads, and thinned to a one-pixel skeleton:
// pixels with three or more branches are junctions. The skeleton's typical
// noise is cleaned first: short spurs, and clusters of junctions where a blurred
// crossing thins into a small triangle.
const JUNCTION_DEFAULTS = Object.freeze({
  minDensity: 0.025, // absolute heat floor: fainter pixels are noise, however contrasted
  minContrast: 0.45, // share of the neighbourhood maximum a trail pixel must reach
  spurMeters: 30, // dead-end branches shorter than this are skeleton noise
  junctionMeters: 15, // junctions closer than this are one blurred crossing
  bridgeMeters: 60, // a dead end this close ahead of another trail joins it
});

const NEIGHBOURS = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

// Morphological closing with a 3×3 square: fills one-pixel holes and notches
// in the mask, which would otherwise thin into tiny loops and spurs.
function close(mask, width, height) {
  // A 3×3 dilation or erosion, as a row pass then a column pass. The outer
  // ring stays 0.
  const morph = (source, dilate) => {
    const row = new Uint8Array(source.length);
    const out = new Uint8Array(source.length);
    for (let y = 0; y < height; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        row[i] = dilate
          ? source[i - 1] | source[i] | source[i + 1]
          : source[i - 1] & source[i] & source[i + 1];
      }
    }
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        out[i] = dilate
          ? row[i - width] | row[i] | row[i + width]
          : row[i - width] & row[i] & row[i + width];
      }
    }
    return out;
  };
  return morph(morph(mask, true), false);
}

// Zhang–Suen thinning, in place: peel boundary pixels off the mask in two
// alternating sub-passes until only a one-pixel-wide, connected skeleton is left.
function thin(mask, width, height) {
  // Only set pixels can be removed, so each pass revisits just those
  let pixels = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) if (mask[y * width + x]) pixels.push(y * width + x);
  }
  const offsets = NEIGHBOURS.map(([dx, dy]) => dy * width + dx);
  const p = new Uint8Array(8); // N, NE, E, SE, S, SW, W, NW
  const remove = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pass of [0, 1]) {
      remove.length = 0;
      for (const i of pixels) {
        if (!mask[i]) continue;
        let count = 0;
        for (let k = 0; k < 8; k++) count += p[k] = mask[i + offsets[k]];
        if (count < 2 || count > 6) continue;
        let transitions = 0;
        for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) transitions++;
        if (transitions !== 1) continue;
        const [n, , e, , s, , w] = p;
        if (pass === 0 ? (n && e && s) || (e && s && w) : (n && e && w) || (n && s && w))
          continue;
        remove.push(i);
      }
      for (const i of remove) mask[i] = 0;
      if (remove.length) changed = true;
    }
    pixels = pixels.filter((i) => mask[i]);
  }
}

// Number of separate skeleton branches around pixel i (0→1 transitions around
// its 8-ring). Unlike a plain neighbour count, this is not fooled by the
// diagonal staircases of a thinned line.
function branches(mask, width, i) {
  let transitions = 0;
  for (let k = 0; k < 8; k++) {
    const [ax, ay] = NEIGHBOURS[k],
      [bx, by] = NEIGHBOURS[(k + 1) % 8];
    if (!mask[i + ay * width + ax] && mask[i + by * width + bx]) transitions++;
  }
  return transitions;
}

// Walk the skeleton into { nodes, edges }. Points are raster-local pixels.
function buildGraph(skeleton, width, height) {
  // Pixel index → node id; a Map, since node pixels are few and the area large
  const nodeAt = new Map();
  const nodeOf = (i) => nodeAt.get(i) ?? -1;
  const nodes = [];
  const addNode = (pixels) => {
    const id = nodes.length;
    let sx = 0,
      sy = 0;
    for (const i of pixels) {
      nodeAt.set(i, id);
      sx += i % width;
      sy += Math.floor(i / width);
    }
    nodes.push({ point: [sx / pixels.length, sy / pixels.length], edges: new Set(), pixels });
    return id;
  };
  const inside = (x, y) => x > 0 && y > 0 && x < width - 1 && y < height - 1;

  // Junctions (3+ branches) and endpoints (1 branch). Adjacent junction pixels
  // form one node, since a crossing thins into a small cluster of them.
  const isNode = new Uint8Array(skeleton.length);
  for (let i = 0; i < skeleton.length; i++) {
    if (skeleton[i] && inside(i % width, Math.floor(i / width))) {
      const b = branches(skeleton, width, i);
      if (b === 1 || b >= 3) isNode[i] = b;
    }
  }
  for (let i = 0; i < skeleton.length; i++) {
    if (!isNode[i] || nodeOf(i) !== -1) continue;
    const pixels = [i];
    nodeAt.set(i, -2);
    for (let k = 0; k < pixels.length; k++) {
      const j = pixels[k];
      for (const [dx, dy] of NEIGHBOURS) {
        const n = j + dy * width + dx;
        if (isNode[n] >= 3 && isNode[j] >= 3 && nodeOf(n) === -1) {
          nodeAt.set(n, -2);
          pixels.push(n);
        }
      }
    }
    addNode(pixels);
  }

  // From every node, walk each unvisited branch until another node.
  const visited = new Uint8Array(skeleton.length);
  const edges = new Set();
  const step = (i, start, length) => {
    // Prefer edge-adjacent neighbours: on a staircase the diagonal would skip
    // a pixel that is then left over as a phantom branch.
    let best = -1;
    for (const k of [0, 2, 4, 6, 1, 3, 5, 7]) {
      const [dx, dy] = NEIGHBOURS[k];
      const x = (i % width) + dx,
        y = Math.floor(i / width) + dy;
      if (!inside(x, y)) continue;
      const n = y * width + x;
      if (!skeleton[n]) continue;
      // Reaching a node ends the walk, except the start node right after leaving it
      if (nodeOf(n) >= 0 && (nodeOf(n) !== start || length > 2)) return n;
      if (nodeOf(n) >= 0) continue;
      if (!visited[n] && best === -1) best = n;
    }
    return best;
  };
  for (const node of [...nodes]) {
    const start = nodeOf(node.pixels[0]);
    for (const pixel of node.pixels) {
      for (const [dx, dy] of NEIGHBOURS) {
        const first = pixel + dy * width + dx;
        if (!skeleton[first] || visited[first] || nodeOf(first) >= 0) continue;
        const points = [];
        let i = first,
          end = -1;
        while (i !== -1) {
          if (nodeOf(i) >= 0) {
            end = nodeOf(i);
            break;
          }
          visited[i] = 1;
          points.push([i % width, Math.floor(i / width)]);
          i = step(i, start, points.length);
        }
        // A walk that dies out (raster border, leftover pixels) ends in a
        // new endpoint; short ones are pruned as spurs later.
        if (end === -1) end = addNode([points.length ? pointIndex(points.at(-1), width) : first]);
        connect(nodes, edges, start, end, points);
      }
    }
  }
  return { nodes, edges };
}

const pointIndex = ([x, y], width) => y * width + x;

function connect(nodes, edges, a, b, points) {
  const edge = { a, b, points };
  edges.add(edge);
  nodes[a].edges.add(edge);
  nodes[b].edges.add(edge);
  return edge;
}

function disconnect(nodes, edges, edge) {
  edges.delete(edge);
  nodes[edge.a].edges.delete(edge);
  nodes[edge.b].edges.delete(edge);
}

const degree = (node) => {
  let d = 0;
  for (const edge of node.edges) d += edge.a === edge.b ? 2 : 1;
  return d;
};

function lengthOf(edge, nodes) {
  const points = [nodes[edge.a].point, ...edge.points, nodes[edge.b].point];
  let length = 0;
  for (let i = 1; i < points.length; i++)
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return length;
}

// Remove skeleton noise until stable. Lengths are in pixels.
function clean({ nodes, edges }, spur, junction) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of [...edges]) {
      if (!edges.has(edge)) continue;
      const a = nodes[edge.a],
        b = nodes[edge.b];
      const length = lengthOf(edge, nodes);
      // Short dead end hanging off a junction
      const spurEdge =
        (degree(a) === 1 && degree(b) >= 3) || (degree(b) === 1 && degree(a) >= 3);
      // Small loop: a crossing that thinned into a ring
      const smallLoop = edge.a === edge.b && length < spur * 2;
      if ((spurEdge && length < spur) || smallLoop) {
        disconnect(nodes, edges, edge);
        changed = true;
      } else if (edge.a !== edge.b && degree(a) >= 3 && degree(b) >= 3 && length < junction) {
        // Two junctions of one blurred crossing: merge b into a
        disconnect(nodes, edges, edge);
        a.point = [(a.point[0] + b.point[0]) / 2, (a.point[1] + b.point[1]) / 2];
        for (const other of [...b.edges]) {
          disconnect(nodes, edges, other);
          connect(
            nodes,
            edges,
            other.a === edge.b ? edge.a : other.a,
            other.b === edge.b ? edge.a : other.b,
            other.points
          );
        }
        changed = true;
      }
    }
    // Join the two edges at every node that is no longer a junction
    for (let id = 0; id < nodes.length; id++) {
      const node = nodes[id];
      if (node.edges.size !== 2 || degree(node) !== 2) continue;
      const [e1, e2] = [...node.edges];
      const into = e1.b === id ? e1.points : [...e1.points].reverse();
      const out = e2.a === id ? e2.points : [...e2.points].reverse();
      const from = e1.b === id ? e1.a : e1.b;
      const to = e2.a === id ? e2.b : e2.a;
      disconnect(nodes, edges, e1);
      disconnect(nodes, edges, e2);
      connect(nodes, edges, from, to, [...into, node.point, ...out]);
      changed = true;
    }
  }
}

// Connect dead ends to the trail they run into. Next to a bright road the
// contrast normalisation hides a faint trail's last metres, so a side trail
// stops short of the road instead of meeting it at a junction. Only targets
// ahead of the dead end (in the direction it was heading) qualify.
function bridge({ nodes, edges }, radius) {
  // Grid of edge points and nodes, so each dead end only looks at nearby
  // cells. Edge points are tracked by identity: splitting an edge keeps the
  // point objects, only their owner changes.
  const grid = new Map();
  const cellOf = (p) => `${Math.floor(p[0] / radius)},${Math.floor(p[1] / radius)}`;
  const index = (p, nodeId) => {
    const key = cellOf(p);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push([p, nodeId]);
  };
  const owner = new Map();
  for (const edge of edges) {
    for (const p of edge.points) {
      owner.set(p, edge);
      index(p, -1);
    }
  }
  nodes.forEach((node, id) => node.edges.size && index(node.point, id));

  for (let id = 0; id < nodes.length; id++) {
    const node = nodes[id];
    if (node.edges.size !== 1 || degree(node) !== 1) continue;
    const [own] = node.edges;
    const far = own.a === id ? own.b : own.a;
    const inward = own.a === id ? own.points.slice(0, 6) : own.points.slice(-6).reverse();
    const back = inward.at(-1) ?? nodes[far].point;
    const heading = [node.point[0] - back[0], node.point[1] - back[1]];
    let best = null,
      bestDistance = radius;
    const cx = Math.floor(node.point[0] / radius),
      cy = Math.floor(node.point[1] / radius);
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (const [point, nodeId] of grid.get(`${gx},${gy}`) ?? []) {
          if (nodeId === -1) {
            const edge = owner.get(point);
            if (!edge || edge === own) continue;
          } else if (nodeId === id || nodeId === far || !nodes[nodeId].edges.size) continue;
          const dx = point[0] - node.point[0],
            dy = point[1] - node.point[1];
          const distance = Math.hypot(dx, dy);
          if (distance < bestDistance && dx * heading[0] + dy * heading[1] > 0) {
            best = nodeId === -1 ? { point } : { node: nodeId };
            bestDistance = distance;
          }
        }
      }
    }
    if (!best) continue;
    let target = best.node;
    if (target === undefined) {
      // Split the trail that was hit at the closest point
      const edge = owner.get(best.point);
      const k = edge.points.indexOf(best.point);
      disconnect(nodes, edges, edge);
      target = nodes.length;
      nodes.push({ point: best.point, edges: new Set(), pixels: [] });
      owner.delete(best.point);
      index(best.point, target);
      for (const part of [
        connect(nodes, edges, edge.a, target, edge.points.slice(0, k)),
        connect(nodes, edges, target, edge.b, edge.points.slice(k + 1)),
      ]) {
        for (const p of part.points) owner.set(p, part);
      }
    }
    connect(nodes, edges, id, target, []);
  }
}

// Trail pixels of one raster: bright enough, both absolutely and relative to
// the neighbourhood, then closed.
function trailMask(raster, tracking) {
  const { width, height } = raster;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] =
      raster.coverage[i] &&
      raster.density[i] >= JUNCTION_DEFAULTS.minDensity &&
      tracking.density[i] >= JUNCTION_DEFAULTS.minContrast
        ? 1
        : 0;
  }
  return close(mask, width, height);
}

// The junctions on `raster`, in projected pixels. `scale`: metres per pixel.
export function detectJunctions(raster, tracking, scale) {
  const { width, height } = raster;
  const skeleton = trailMask(raster, tracking);
  thin(skeleton, width, height);
  const graph = buildGraph(skeleton, width, height);
  const spur = JUNCTION_DEFAULTS.spurMeters / scale,
    junction = JUNCTION_DEFAULTS.junctionMeters / scale;
  clean(graph, spur, junction);
  bridge(graph, JUNCTION_DEFAULTS.bridgeMeters / scale);
  clean(graph, spur, junction);
  return graph.nodes
    .filter((node) => degree(node) >= 3)
    .map((node) => [node.point[0] + raster.x, node.point[1] + raster.y]);
}
