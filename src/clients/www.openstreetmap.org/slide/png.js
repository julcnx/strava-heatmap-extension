/**
 * Decode Strava heatmap PNG tiles into ordered heat density.
 *
 * Strava encodes each heatmap tile as an 8-bit *indexed-colour* PNG: a pixel
 * stores a palette index, and the palette's alpha ramp (the tRNS chunk) is
 * ordered from transparent (coldest) to opaque (hottest). That index IS the
 * heat level — the colour is only how the heatmap is displayed.
 *
 * Why not simply draw the tile onto a <canvas> and read back RGBA? The
 * browser converts indexed colour to presentation colour: values are
 * premultiplied by alpha, rounded, and the index order is lost. Some Strava
 * palettes are even non-monotonic in brightness (the "gray" palette becomes
 * *darker* again at the hottest levels), so brightness cannot be mapped back
 * to heat. We therefore parse the PNG ourselves and keep the raw indices.
 *
 * PNG primer for the code below. A file is an 8-byte signature followed by
 * chunks laid out as "length | type | data | CRC":
 *   IHDR – image header (dimensions, bit depth, colour type)
 *   PLTE – the colour palette (256 × RGB for indexed images)
 *   tRNS – per-index transparency (here: Strava's ordered heat ramp)
 *   IDAT – zlib-compressed pixel data
 *   IEND – end marker
 * Indexed images store one palette index per pixel, and every row is prefixed
 * by a filter byte describing how that row's bytes were predictively encoded
 * (PNG filters reduce file size; they must be undone here).
 */
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

// Cooperative cancellation (see algorithm.js): a cancelled decode throws an
// 'AbortError', which the caller treats as "user cancelled", not as a failure.
function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Slide cancelled.', 'AbortError');
}

// The Paeth predictor from the PNG specification: pick the neighbour
// (a = left, b = above, c = upper-left) whose value lies closest to the
// straight-line prediction through the other two.
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Decode one heatmap tile. Returns { width, height, density } where density
// is a Float32Array of heat levels 0..1 (palette index / 255).
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
  // Walk the chunk list; `offset` always sits at a chunk header and steps over
  // length (4) + type (4) + data + CRC (4).
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
        data[8] !== 8 || // bit depth: 8 bits per palette index
        data[9] !== 3 || // colour type: 3 = indexed (palette)
        data[10] || // compression method: 0 = deflate
        data[11] || // filter method: 0 = adaptive
        data[12] // interlace method: 0 = none (interlaced tiles unsupported)
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
  // Refuse to interpret an arbitrary or reordered palette as heat. Strava's
  // encoding is recognisable: exactly 256 RGB entries and a 256-step alpha
  // ramp that starts transparent, ends opaque and never decreases — that ramp
  // is the monotonic "heat" ordering the rest of Slide relies on.
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
  // `raw` will hold height rows of (1 filter byte + width index bytes).
  const expectedLength = (width + 1) * height;
  const raw = new Uint8Array(expectedLength);
  // Inflate the concatenated IDAT data with the browser's built-in
  // DecompressionStream — no dependencies, and streamed so large tiles do not
  // have to be buffered twice.
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
  // Undo the per-row PNG filters. Each byte was stored as
  // (index + prediction of already-decoded neighbours) mod 256, where the
  // prediction depends on the row's filter byte; adding it back recovers the
  // palette indices. Those indices ARE the heat: density = index / 255.
  const indices = new Uint8Array(width * height);
  const density = new Float32Array(indices.length);
  for (let y = 0; y < height; y++) {
    checkAbort(signal);
    const row = y * (width + 1),
      filter = raw[row];
    if (filter > 4) throw new Error('Invalid heatmap PNG filter.');
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      // Neighbours already reconstructed in this and the previous row:
      // a = left, b = above, c = upper-left diagonal.
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
