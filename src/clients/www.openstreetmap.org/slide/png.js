/**
 * Decode Strava heatmap PNG tiles into ordered heat density.
 *
 * Slide needs the heat LEVEL of every pixel, not the pixel's colour. Strava
 * has served two encodings over time; both are handled here:
 *
 *   • Grayscale tiles (current, "?v=20"): an 8-bit grayscale PNG whose pixel
 *     value IS the heat intensity — 0 means no recorded activity, brighter
 *     means hotter. Strava no longer ships colours; the extension colorizes
 *     these tiles in the browser with palette filters (see colors.js), and
 *     the selected palette only lives in the tile URL, not in the image.
 *
 *   • Indexed tiles (legacy, "?v=19"): an 8-bit *indexed-colour* PNG where a
 *     pixel stores a palette index and the palette's alpha ramp (the tRNS
 *     chunk) runs from transparent (coldest) to opaque (hottest). That index
 *     is the heat level; the colour is only how the heatmap is displayed.
 *
 * Why not simply draw the tile onto a <canvas> and read back RGBA? The legacy
 * palettes were non-monotonic in brightness (the "gray" palette becomes
 * *darker* again at its hottest levels), so brightness could not be mapped
 * back to heat — the index order had to be preserved. Parsing the PNG
 * ourselves also keeps Slide independent of canvas/ImageBitmap and lets it
 * reject anything that is not a known heat encoding instead of guessing.
 *
 * PNG primer for the code below. A file is an 8-byte signature followed by
 * chunks laid out as "length | type | data | CRC":
 *   IHDR – image header (dimensions, bit depth, colour type)
 *   PLTE – the colour palette (only present in indexed images)
 *   tRNS – per-index transparency (Strava's ordered heat ramp, indexed only)
 *   IDAT – zlib-compressed pixel data
 *   IEND – end marker
 * Pixels are stored one byte per channel, and every row is prefixed by a
 * filter byte describing how that row's bytes were predictively encoded
 * (PNG filters reduce file size; they must be undone here).
 */
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

// Bytes (and channels) per pixel for the colour types Slide understands, all
// at 8 bits per channel:
//   0 grayscale  – current Strava tiles: value = heat
//   2 RGB        – grayscale painted into RGB: red = heat (tolerated)
//   3 indexed    – legacy Strava tiles: palette index = heat
//   4 gray+alpha – like 0, additionally scaled by alpha (tolerated)
//   6 RGBA       – like 2, additionally scaled by alpha (tolerated)
// Only 0 and 3 are served by Strava today; the RGB(A) entries exist so a
// future switch to painted tiles does not break Slide outright.
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

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

// The prediction step of a PNG row filter: 0 none, 1 left neighbour, 2 neighbour
// above, 3 average of both, 4 Paeth. A stored byte equals
// (value + prediction) mod 256, so adding the prediction back restores the
// original value.
function unfilter(filter, a, b, c) {
  if (filter === 0) return 0;
  if (filter === 1) return a;
  if (filter === 2) return b;
  if (filter === 3) return Math.floor((a + b) / 2);
  return paeth(a, b, c);
}

// Decode one heatmap tile. Returns { width, height, density } where density
// is a Float32Array of heat levels 0..1 (see the header for what the pixel
// value means in each supported encoding).
export async function decodeHeatmapPNG(bytes, signal) {
  checkAbort(signal);
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (bytes.length < 33 || SIGNATURE.some((value, i) => bytes[i] !== value)) {
    throw new Error('The heatmap response is not a PNG image.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width,
    height,
    colorType,
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
      colorType = data[9];
      if (
        !width ||
        !height ||
        width * height > 4000000 ||
        data[8] !== 8 || // bit depth: 8 bits per channel
        !CHANNELS[colorType] || // colour type: see CHANNELS above
        data[10] || // compression method: 0 = deflate
        data[11] || // filter method: 0 = adaptive
        data[12] // interlace method: 0 = none (interlaced tiles unsupported)
      ) {
        throw new Error(
          'Unsupported heatmap PNG. Expected a non-interlaced, 8-bit grayscale or indexed Strava tile.'
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
  // Legacy indexed tiles must carry Strava's recognisable heat palette —
  // exactly 256 RGB entries and a 256-step alpha ramp that starts transparent,
  // ends opaque and never decreases. That ramp is the monotonic "heat" ordering
  // the rest of Slide relies on; an arbitrary or reordered palette must not be
  // interpreted as heat. (Grayscale tiles have no palette at all.)
  if (
    !ended ||
    !width ||
    !compressed.length ||
    (colorType === 3 &&
      (palette?.length !== 768 ||
        alpha?.length !== 256 ||
        alpha[0] !== 0 ||
        alpha[255] !== 255 ||
        alpha.some((value, i) => i && value < alpha[i - 1])))
  ) {
    throw new Error(
      'Unsupported heatmap density encoding. Expected Strava’s grayscale tiles or its ordered 256-level palette.'
    );
  }
  if (typeof DecompressionStream !== 'function') {
    throw new Error(
      'Slide needs a browser with PNG decompression support. Please update your browser.'
    );
  }
  // `raw` will hold height rows of (1 filter byte + width × channels bytes).
  const channels = CHANNELS[colorType];
  const expectedLength = (1 + width * channels) * height;
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
  // Undo the per-row PNG filters (see `unfilter`) and collect the samples of
  // every channel. For each colour type Slide supports, the FIRST channel of a
  // pixel carries the heat — the grayscale value, the red channel of painted
  // tiles, or the palette index of legacy tiles.
  const samples = new Uint8Array(width * height * channels);
  const density = new Float32Array(width * height);
  // Alpha-carrying colour types scale their intensity by alpha, so a
  // transparent pixel can never count as heat.
  const alphaChannel = colorType === 4 || colorType === 6 ? channels - 1 : -1;
  for (let y = 0; y < height; y++) {
    checkAbort(signal);
    const row = y * (1 + width * channels),
      filter = raw[row];
    if (filter > 4) throw new Error('Invalid heatmap PNG filter.');
    for (let i = 0; i < width * channels; i++) {
      const at = y * width * channels + i;
      // Neighbours already reconstructed in this and the previous row:
      // a = left, b = above, c = upper-left diagonal.
      const a = i >= channels ? samples[at - channels] : 0;
      const b = y ? samples[at - width * channels] : 0;
      const c = i >= channels && y ? samples[at - width * channels - channels] : 0;
      samples[at] = (raw[row + 1 + i] + unfilter(filter, a, b, c)) & 255;
    }
  }
  // Heat level per pixel: the intensity channel scaled to 0..1. Dividing the
  // alpha product by 255² keeps alpha-carrying tiles in the same range.
  for (let i = 0; i < density.length; i++) {
    const intensity = samples[i * channels];
    density[i] =
      alphaChannel < 0
        ? intensity / 255
        : (intensity * samples[i * channels + alphaChannel]) / 65025;
  }
  return { width, height, density };
}
