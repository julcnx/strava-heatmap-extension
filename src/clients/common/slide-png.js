// Strava stores heat levels as ordered 8-bit PNG palette indices. The palette
// colors are presentation, not density: even the palette called "gray" is
// non-monotonic in brightness. Decode the indices before any canvas conversion
// (which also rounds premultiplied colors/alpha and discards the indices).
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Slide cancelled.', 'AbortError');
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export async function decodeHeatmapPNG(bytes, signal) {
  checkAbort(signal);
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (bytes.length < 33 || SIGNATURE.some((value, i) => bytes[i] !== value)) {
    throw new Error('The heatmap response is not a PNG image.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width,
    height,
    palette,
    alpha,
    ended = false;
  const compressed = [];
  for (let offset = 8; offset < bytes.length; ) {
    if (offset + 12 > bytes.length) throw new Error('Truncated heatmap PNG.');
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12)
      throw new Error('Truncated heatmap PNG chunk.');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (width !== undefined || length !== 13)
        throw new Error('Invalid heatmap PNG header.');
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (
        !width ||
        !height ||
        width * height > 4000000 ||
        data[8] !== 8 ||
        data[9] !== 3 ||
        data[10] ||
        data[11] ||
        data[12]
      ) {
        throw new Error(
          'Unsupported heatmap PNG. Expected a non-interlaced, indexed 8-bit Strava tile.'
        );
      }
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      alpha = data;
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
    offset += length + 12;
  }
  // Do not silently interpret an arbitrary/reordered image palette as heat.
  // Strava's 256-entry palette has opacity increasing with its heat index.
  if (
    !ended ||
    !width ||
    !compressed.length ||
    palette?.length !== 768 ||
    alpha?.length !== 256 ||
    alpha[0] !== 0 ||
    alpha[255] !== 255 ||
    alpha.some((value, i) => i && value < alpha[i - 1])
  ) {
    throw new Error(
      'Unsupported heatmap density encoding. Expected Strava’s ordered 256-level palette.'
    );
  }
  if (typeof DecompressionStream !== 'function') {
    throw new Error(
      'Slide needs a browser with PNG decompression support. Please update your browser.'
    );
  }
  const expectedLength = (width + 1) * height;
  const raw = new Uint8Array(expectedLength);
  const stream = new Blob(compressed)
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const abort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  let offset = 0;
  try {
    while (true) {
      checkAbort(signal);
      const { value, done } = await reader.read();
      checkAbort(signal);
      if (done) break;
      if (offset + value.length > expectedLength) {
        await reader.cancel();
        throw new Error('Heatmap PNG has too many decompressed pixels.');
      }
      raw.set(value, offset);
      offset += value.length;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  if (offset !== expectedLength)
    throw new Error('Heatmap PNG has incomplete pixel data.');
  const indices = new Uint8Array(width * height);
  const density = new Float32Array(indices.length);
  for (let y = 0; y < height; y++) {
    checkAbort(signal);
    const row = y * (width + 1),
      filter = raw[row];
    if (filter > 4) throw new Error('Invalid heatmap PNG filter.');
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const a = x ? indices[i - 1] : 0;
      const b = y ? indices[i - width] : 0;
      const c = x && y ? indices[i - width - 1] : 0;
      const prediction =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? Math.floor((a + b) / 2)
                : paeth(a, b, c);
      indices[i] = (raw[row + x + 1] + prediction) & 255;
      density[i] = indices[i] / 255;
    }
  }
  return { width, height, density };
}
