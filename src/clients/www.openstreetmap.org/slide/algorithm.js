// Editor-independent, dependency-free raster conflation for Slide.
// Coordinates are [longitude, latitude].
// Unlike an active contour, an ordered, corridor-constrained shortest path has no
// bending force pulling it out of a narrow hairpin. Original vertices are ordered
// waypoints; simplification happens only after the density ridge has been traced.
const TILE_SIZE = 512;
const EARTH_CIRCUMFERENCE = 40075016.68557849;

// Share search limits with the tile loader: widening a search is only useful
// when the surrounding imagery has actually been downloaded.
export const SLIDE_DEFAULTS = Object.freeze({
  searchRadiusMeters: 24,
  maxSearchRadiusMeters: 80,
  snapRadiusMeters: 18,
  maxSnapRadiusMeters: 60,
  simplifyMeters: 2,
  contrastRadiusMeters: 12,
});

export function project(loc, zoom = 15) {
  const size = TILE_SIZE * 2 ** zoom;
  const lat = (Math.max(-85.05112878, Math.min(85.05112878, loc[1])) * Math.PI) / 180;
  return [
    ((loc[0] + 180) / 360) * size,
    ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * size,
  ];
}

export function unproject(point, zoom = 15) {
  const size = TILE_SIZE * 2 ** zoom;
  return [
    (point[0] / size) * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * point[1]) / size))) * 180) / Math.PI,
  ];
}

export function metersPerPixel(latitude, zoom = 15) {
  return (
    (EARTH_CIRCUMFERENCE * Math.cos((latitude * Math.PI) / 180)) / (TILE_SIZE * 2 ** zoom)
  );
}

export function lineBounds(locations, zoom, padding) {
  const points = locations.map((loc) => project(loc, zoom));
  return {
    minX: Math.floor(Math.min(...points.map((p) => p[0])) - padding),
    minY: Math.floor(Math.min(...points.map((p) => p[1])) - padding),
    maxX: Math.ceil(Math.max(...points.map((p) => p[0])) + padding),
    maxY: Math.ceil(Math.max(...points.map((p) => p[1])) + padding),
  };
}

function blur(data, width, height) {
  // Small separable Gaussian: discriminate the center of clipped/white ridges
  // without washing out tight turns or neighboring paths.
  const kernel = [0.0545, 0.2442, 0.4026, 0.2442, 0.0545];
  const temp = new Float32Array(data.length);
  const output = new Float32Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let k = -2; k <= 2; k++) {
        temp[y * width + x] +=
          data[y * width + Math.max(0, Math.min(width - 1, x + k))] * kernel[k + 2];
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let k = -2; k <= 2; k++) {
        output[y * width + x] +=
          temp[Math.max(0, Math.min(height - 1, y + k)) * width + x] * kernel[k + 2];
      }
    }
  }
  return output;
}

// Tiles may have different zooms and physical image sizes. Always sample the
// highest-resolution available tile, and interpolate parent tiles at their true
// geographic scale. Missing pixels remain missing, never fabricated as heat.
export function createHeatmapRaster(tiles, zoom = 15, bounds) {
  if (!tiles.length) throw new Error('No heatmap tiles are available.');
  const extents = tiles.map((tile) => {
    const scale = TILE_SIZE * 2 ** (zoom - tile.z);
    return { tile, scale, x: tile.x * scale, y: tile.y * scale };
  });
  bounds ||= {
    minX: Math.floor(Math.min(...extents.map((e) => e.x))),
    minY: Math.floor(Math.min(...extents.map((e) => e.y))),
    maxX: Math.ceil(Math.max(...extents.map((e) => e.x + e.scale))),
    maxY: Math.ceil(Math.max(...extents.map((e) => e.y + e.scale))),
  };
  const width = bounds.maxX - bounds.minX + 1;
  const height = bounds.maxY - bounds.minY + 1;
  if (width < 2 || height < 2 || width * height > 4000000) {
    throw new Error('Slide area is too large. Select a shorter section of the line.');
  }
  const density = new Float32Array(width * height);
  const coverage = new Uint8Array(width * height);
  extents.sort((a, b) => b.tile.width / b.scale - a.tile.width / a.scale);
  for (const { tile, scale, x: tx, y: ty } of extents) {
    if (
      tile.density
        ? tile.density.length !== tile.width * tile.height
        : !tile.data || tile.data.length !== tile.width * tile.height * 4
    ) {
      throw new Error('Invalid heatmap tile pixels.');
    }
    const value = (x, y) => {
      if (tile.density) return tile.density[y * tile.width + x];
      const i = (y * tile.width + x) * 4;
      // Legacy RGBA input is only useful for known monotonic palettes such as
      // hot. Live tiles use decoded palette-index density, never luminance.
      return (
        (((0.2126 * tile.data[i] +
          0.7152 * tile.data[i + 1] +
          0.0722 * tile.data[i + 2]) /
          255) *
          tile.data[i + 3]) /
        255
      );
    };
    for (
      let y = Math.max(bounds.minY, Math.ceil(ty));
      y < Math.min(bounds.maxY + 1, ty + scale);
      y++
    ) {
      for (
        let x = Math.max(bounds.minX, Math.ceil(tx));
        x < Math.min(bounds.maxX + 1, tx + scale);
        x++
      ) {
        const index = (y - bounds.minY) * width + x - bounds.minX;
        if (coverage[index]) continue;
        // Image samples live at pixel centers, not at the tile's upper-left
        // pixel edges. This also avoids a half-pixel shift in parent fallback.
        const px = Math.max(
          0,
          Math.min(tile.width - 1, ((x - tx) / scale) * tile.width - 0.5)
        );
        const py = Math.max(
          0,
          Math.min(tile.height - 1, ((y - ty) / scale) * tile.height - 0.5)
        );
        const x0 = Math.floor(px),
          y0 = Math.floor(py);
        const x1 = Math.min(x0 + 1, tile.width - 1),
          y1 = Math.min(y0 + 1, tile.height - 1);
        const dx = px - x0,
          dy = py - y0;
        density[index] =
          (value(x0, y0) * (1 - dx) + value(x1, y0) * dx) * (1 - dy) +
          (value(x0, y1) * (1 - dx) + value(x1, y1) * dx) * dy;
        coverage[index] = 1;
      }
    }
  }
  // Remove the flat image background without amplifying almost-empty tiles.
  let floor = 1;
  for (let i = 0; i < density.length; i++) {
    if (coverage[i]) floor = Math.min(floor, density[i]);
  }
  for (let i = 0; i < density.length; i++) {
    density[i] = Math.max(0, (density[i] - floor) / Math.max(0.1, 1 - floor));
  }
  return {
    width,
    height,
    x: bounds.minX,
    y: bounds.minY,
    zoom,
    density: blur(density, width, height),
    coverage,
  };
}

export function sampleDensity(raster, point) {
  const x = point[0] - raster.x,
    y = point[1] - raster.y;
  if (x < 0 || y < 0 || x >= raster.width - 1 || y >= raster.height - 1) return 0;
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    dx = x - x0,
    dy = y - y0;
  const i = y0 * raster.width + x0;
  return (
    (raster.density[i] * (1 - dx) + raster.density[i + 1] * dx) * (1 - dy) +
    (raster.density[i + raster.width] * (1 - dx) +
      raster.density[i + raster.width + 1] * dx) *
      dy
  );
}

function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
    : 0;
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}

class MinHeap {
  items = [];
  push(item) {
    let i = this.items.length;
    this.items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].cost <= item.cost) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = item;
  }
  pop() {
    const first = this.items[0],
      last = this.items.pop();
    if (this.items.length) {
      let i = 0;
      while (i * 2 + 1 < this.items.length) {
        let child = i * 2 + 1;
        if (
          child + 1 < this.items.length &&
          this.items[child + 1].cost < this.items[child].cost
        )
          child++;
        if (this.items[child].cost >= last.cost) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return first;
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Slide cancelled.', 'AbortError');
}

function noSignal(message) {
  const error = new Error(message);
  error.code = 'SLIDE_NO_SIGNAL';
  return error;
}

function isCovered(raster, point) {
  const x = Math.floor(point[0]) - raster.x,
    y = Math.floor(point[1]) - raster.y;
  return (
    x >= 0 &&
    y >= 0 &&
    x < raster.width &&
    y < raster.height &&
    Boolean(raster.coverage[y * raster.width + x])
  );
}

function searchRadii(initial, maximum) {
  const radii = [initial];
  while (radii[radii.length - 1] < maximum) {
    radii.push(Math.min(maximum, radii[radii.length - 1] * 2));
  }
  return radii;
}

async function trackingSurface(raster, scale, options) {
  // Normalize by nearby peaks, not by the brightest road anywhere in a tile.
  // A weak but coherent ridge can then have the same tracking strength as a
  // bright ridge. Keep a small absolute floor so individual quantization specks
  // are not amplified into fully convincing trails.
  const radius = Math.max(1, Math.ceil(SLIDE_DEFAULTS.contrastRadiusMeters / scale));
  const { width, height, density, coverage } = raster;
  const horizontal = new Float32Array(density.length);
  const signal = new Float32Array(density.length);
  const queue = new Int32Array(Math.max(width, height));
  const value = (index) => (coverage[index] ? density[index] : 0);
  for (let y = 0; y < height; y++) {
    if (y % 64 === 0) {
      await options.yield();
      checkAbort(options.signal);
    }
    const row = y * width;
    let head = 0,
      tail = 0,
      next = 0;
    for (let x = 0; x < width; x++) {
      const right = Math.min(width - 1, x + radius);
      while (next <= right) {
        const v = value(row + next);
        while (tail > head && value(row + queue[tail - 1]) <= v) tail--;
        queue[tail++] = next++;
      }
      while (queue[head] < x - radius) head++;
      horizontal[row + x] = value(row + queue[head]);
    }
  }
  let hasSignal = false;
  for (let x = 0; x < width; x++) {
    if (x % 64 === 0) {
      await options.yield();
      checkAbort(options.signal);
    }
    let head = 0,
      tail = 0,
      next = 0;
    for (let y = 0; y < height; y++) {
      const bottom = Math.min(height - 1, y + radius);
      while (next <= bottom) {
        const v = horizontal[next * width + x];
        while (tail > head && horizontal[queue[tail - 1] * width + x] <= v) tail--;
        queue[tail++] = next++;
      }
      while (queue[head] < y - radius) head++;
      const index = y * width + x;
      signal[index] = value(index) / Math.max(0.004, horizontal[queue[head] * width + x]);
      if (signal[index] >= 0.25) hasSignal = true;
    }
  }
  if (!hasSignal) throw noSignal('No usable heatmap trail is visible in this area.');
  return { ...raster, density: signal };
}

function snap(raster, point, radius) {
  let best,
    bestScore = -Infinity;
  for (let y = Math.floor(point[1] - radius); y <= Math.ceil(point[1] + radius); y++) {
    for (let x = Math.floor(point[0] - radius); x <= Math.ceil(point[0] + radius); x++) {
      const distance = Math.hypot(x - point[0], y - point[1]);
      const index = (y - raster.y) * raster.width + x - raster.x;
      if (
        distance > radius ||
        x < raster.x ||
        y < raster.y ||
        x >= raster.x + raster.width ||
        y >= raster.y + raster.height ||
        !raster.coverage[index]
      )
        continue;
      // Filter candidates BEFORE applying the distance penalty. Otherwise a
      // dark unsnapped point can beat a visible weak trail and fail afterwards.
      if (raster.density[index] < 0.25) continue;
      const score = raster.density[index] - 0.12 * (distance / radius) ** 2;
      if (score > bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
  }
  return best;
}

async function trace(raster, start, end, originalStart, originalEnd, radius, options) {
  if (!isCovered(raster, start) || !isCovered(raster, end)) {
    throw new Error('Heatmap coverage is incomplete at an endpoint.');
  }
  const minX = Math.max(
    raster.x,
    Math.floor(Math.min(originalStart[0], originalEnd[0], start[0], end[0]) - radius)
  );
  const minY = Math.max(
    raster.y,
    Math.floor(Math.min(originalStart[1], originalEnd[1], start[1], end[1]) - radius)
  );
  const maxX = Math.min(
    raster.x + raster.width - 1,
    Math.ceil(Math.max(originalStart[0], originalEnd[0], start[0], end[0]) + radius)
  );
  const maxY = Math.min(
    raster.y + raster.height - 1,
    Math.ceil(Math.max(originalStart[1], originalEnd[1], start[1], end[1]) + radius)
  );
  const width = maxX - minX + 1,
    height = maxY - minY + 1;
  const costs = new Float32Array(width * height).fill(Infinity);
  const parents = new Int32Array(width * height).fill(-1);
  const visited = new Uint8Array(width * height);
  const cellCosts = new Float32Array(width * height).fill(Infinity);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = (y - minY) * width + x - minX;
      const j = (y - raster.y) * raster.width + x - raster.x;
      const distance = distanceToSegment([x, y], originalStart, originalEnd);
      if (!raster.coverage[j] || distance > radius) continue;
      cellCosts[i] =
        0.06 + 8 * (1 - raster.density[j]) ** 2 + 0.04 * (distance / radius) ** 2;
    }
  }
  const from = (Math.round(start[1]) - minY) * width + Math.round(start[0]) - minX;
  const to = (Math.round(end[1]) - minY) * width + Math.round(end[0]) - minX;
  if (!Number.isFinite(cellCosts[from]) || !Number.isFinite(cellCosts[to])) {
    throw noSignal('The search corridor does not yet reach the snapped trail.');
  }
  const heap = new MinHeap();
  costs[from] = 0;
  heap.push({ index: from, cost: 0 });
  let iterations = 0;
  while (heap.items.length) {
    const { index } = heap.pop();
    if (visited[index]) continue;
    visited[index] = 1;
    if (index === to) break;
    if (++iterations % 8192 === 0) {
      await options.yield();
      checkAbort(options.signal);
    }
    const x = index % width,
      y = Math.floor(index / width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (
          (!dx && !dy) ||
          x + dx < 0 ||
          y + dy < 0 ||
          x + dx >= width ||
          y + dy >= height
        )
          continue;
        const next = index + dy * width + dx;
        if (visited[next] || !Number.isFinite(cellCosts[next])) continue;
        // Do not diagonally jump across holes in tile coverage/the corridor.
        if (
          dx &&
          dy &&
          (!Number.isFinite(cellCosts[index + dx]) ||
            !Number.isFinite(cellCosts[index + dy * width]))
        )
          continue;
        const cost =
          costs[index] + (Math.hypot(dx, dy) * (cellCosts[index] + cellCosts[next])) / 2;
        if (cost >= costs[next]) continue;
        costs[next] = cost;
        parents[next] = index;
        heap.push({
          index: next,
          cost: cost + 0.06 * Math.hypot(minX + x + dx - end[0], minY + y + dy - end[1]),
        });
      }
    }
  }
  if (!visited[to]) throw noSignal('No continuous heatmap coverage along this section.');
  const points = [];
  for (let i = to; i !== -1; i = parents[i])
    points.push([minX + (i % width), minY + Math.floor(i / width)]);
  points.reverse();
  points[0] = start;
  points[points.length - 1] = end;
  // Evaluate continuity in locally normalized signal, not absolute brightness.
  // A fixed endpoint may be off-trail: allow a bounded approach at either end,
  // but never treat a long dark interior shortcut as a traced trail.
  const support = points.map((p) => sampleDensity(raster, p) >= 0.12);
  const first = support.indexOf(true),
    last = support.lastIndexOf(true);
  let leading = 0,
    trailing = 0,
    gap = 0,
    longestGap = 0,
    dark = 0;
  let supportedLength = 0,
    totalLength = 0;
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1]
    );
    totalLength += length;
    if (support[i] && support[i - 1]) supportedLength += length;
  }
  for (let i = 1; i <= first; i++)
    leading += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1]
    );
  for (let i = last + 1; i < points.length && i > 0; i++)
    trailing += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1]
    );
  for (let i = first; i <= last && i >= 0; i++) {
    if (support[i]) gap = 0;
    else {
      dark++;
      gap += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      longestGap = Math.max(longestGap, gap);
    }
  }
  const maxGap = 12 / options.scale;
  if (
    first === -1 ||
    leading > radius + 2 ||
    trailing > radius + 2 ||
    longestGap > maxGap ||
    dark > Math.max(3, (last - first + 1) * 0.15) ||
    supportedLength < Math.min(20 / options.scale, totalLength * 0.5)
  ) {
    throw noSignal(
      'No continuous nearby heatmap trail found. Add a guide vertex to select the intended trail.'
    );
  }
  return points;
}

function simplify(points, tolerance, raster) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let farthest = -1,
      maxDistance = tolerance;
    for (let i = start + 1; i < end; i++) {
      const distance = distanceToSegment(points[i], points[start], points[end]);
      if (distance > maxDistance) {
        farthest = i;
        maxDistance = distance;
      }
    }
    if (farthest === -1 && end > start + 1) {
      // Douglas–Peucker's geometric error alone can accept a chord that clips
      // a narrow bend. Keep a vertex if its replacement materially leaves the
      // density ridge, even when that chord is within the metric tolerance.
      const a = points[start],
        b = points[end];
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        length = dx * dx + dy * dy;
      // A simplification must not cut across a missing tile corner that the
      // traced grid path avoided. Check the whole chord, not just its ends.
      const steps = Math.max(1, Math.ceil(Math.sqrt(length) * 2));
      for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        if (!isCovered(raster, [a[0] + t * dx, a[1] + t * dy])) {
          farthest = Math.max(
            start + 1,
            Math.min(end - 1, Math.round(start + t * (end - start)))
          );
          break;
        }
      }
      let worstLoss = 0.06;
      for (let i = start + 1; i < end; i++) {
        const p = points[i];
        const t = length
          ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
          : 0;
        const replacement = [a[0] + t * dx, a[1] + t * dy];
        const loss = sampleDensity(raster, p) - sampleDensity(raster, replacement);
        if (loss > worstLoss) {
          farthest = i;
          worstLoss = loss;
        }
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push([start, farthest], [farthest, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// Returns ordered { loc, nodeIndex } records. Every original node has exactly
// one record, so callers can retain node IDs, tags and all existing connections.
export async function slideLine(locations, raster, options = {}) {
  if (
    locations.length < 2 ||
    locations.length > 1000 ||
    locations.some(
      (p) =>
        !Array.isArray(p) ||
        p.length !== 2 ||
        !p.every(Number.isFinite) ||
        Math.abs(p[1]) > 85.05112878 ||
        Math.abs(p[0]) > 180
    )
  ) {
    throw new Error('Slide requires between 2 and 1000 valid line vertices.');
  }
  options = { yield: () => new Promise((resolve) => setTimeout(resolve, 0)), ...options };
  checkAbort(options.signal);
  const scale = metersPerPixel(locations[0][1], raster.zoom);
  const searchMeters = options.searchRadiusMeters ?? SLIDE_DEFAULTS.searchRadiusMeters;
  const snapMeters = options.snapRadiusMeters ?? SLIDE_DEFAULTS.snapRadiusMeters;
  // Explicit radii remain hard limits unless a larger maximum is requested.
  const maxSearchMeters =
    options.maxSearchRadiusMeters ??
    (options.searchRadiusMeters === undefined
      ? SLIDE_DEFAULTS.maxSearchRadiusMeters
      : searchMeters);
  const maxSnapMeters =
    options.maxSnapRadiusMeters ??
    (options.snapRadiusMeters === undefined
      ? Math.min(SLIDE_DEFAULTS.maxSnapRadiusMeters, maxSearchMeters)
      : snapMeters);
  const radius = searchMeters / scale,
    snapRadius = snapMeters / scale;
  // 1.2 m was only about half a zoom-15 pixel (~2.39 m/pixel here), so the old
  // Douglas–Peucker pass retained raster stair-steps as tiny 45°/90° bends.
  // Two meters removes that quantization noise; the density guard protects
  // genuine tight bends. Original vertices remain segment endpoints throughout.
  const tolerance = (options.simplifyMeters ?? SLIDE_DEFAULTS.simplifyMeters) / scale;
  if (!Number.isFinite(tolerance) || tolerance < 0)
    throw new Error('Invalid Slide simplification tolerance.');
  if (
    ![searchMeters, snapMeters, maxSearchMeters, maxSnapMeters].every(Number.isFinite) ||
    !(radius > 0) ||
    !(snapRadius > 0) ||
    snapRadius > radius ||
    maxSearchMeters < searchMeters ||
    maxSnapMeters < snapMeters ||
    maxSnapMeters > maxSearchMeters
  )
    throw new Error('Invalid Slide search radius.');
  options.scale = scale;
  const tracking = await trackingSurface(raster, scale, options);
  const originals = locations.map((loc) => project(loc, raster.zoom));
  const fixed = new Set([0, locations.length - 1, ...(options.fixedIndices || [])]);
  const snapSearches = searchRadii(snapRadius, maxSnapMeters / scale);
  const anchors = [];
  for (let i = 0; i < originals.length; i++) {
    await options.yield();
    checkAbort(options.signal);
    let anchor = fixed.has(i) ? originals[i] : null;
    for (const r of snapSearches) {
      if (anchor) break;
      anchor = snap(tracking, originals[i], r);
    }
    if (!anchor)
      throw noSignal(
        `No nearby heatmap trail within ${maxSnapMeters} m of vertex ${i + 1}. Add a guide vertex closer to the intended trail.`
      );
    anchors.push(anchor);
  }
  const result = [{ loc: locations[0].slice(), nodeIndex: 0 }];
  for (let i = 1; i < originals.length; i++) {
    await options.yield();
    checkAbort(options.signal);
    let path;
    for (const r of searchRadii(radius, maxSearchMeters / scale)) {
      try {
        path = await trace(
          tracking,
          anchors[i - 1],
          anchors[i],
          originals[i - 1],
          originals[i],
          r,
          options
        );
        break;
      } catch (error) {
        if (error.code !== 'SLIDE_NO_SIGNAL' || r === maxSearchMeters / scale)
          throw error;
        await options.yield();
        checkAbort(options.signal);
      }
    }
    const reduced = simplify(path, tolerance, tracking);
    for (let j = 1; j < reduced.length - 1; j++) {
      result.push({ loc: unproject(reduced[j], raster.zoom), nodeIndex: null });
    }
    result.push({
      loc: fixed.has(i) ? locations[i].slice() : unproject(anchors[i], raster.zoom),
      nodeIndex: i,
    });
    options.onProgress?.(i / (originals.length - 1));
  }
  checkAbort(options.signal);
  return result;
}
