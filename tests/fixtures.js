// Minimal PNG reader for the supplied fixtures. Node built-ins only; no image
// library is shipped with the extension or needed to run the regression tests.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export function readTile(name, bytes) {
  const png = bytes
    ? Buffer.from(bytes)
    : readFileSync(new URL(`../temp/${name}`, import.meta.url));
  const chunks = [];
  let width, height, channels, palette, transparency, indexed;
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const bytes = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(0);
      height = bytes.readUInt32BE(4);
      indexed = bytes[9] === 3;
      channels = bytes[9] === 6 ? 4 : bytes[9] === 2 ? 3 : indexed ? 1 : 0;
      if (bytes[8] !== 8 || !channels || bytes[12])
        throw new Error('Unsupported fixture PNG.');
    }
    if (type === 'IDAT') chunks.push(bytes);
    if (type === 'PLTE') palette = bytes;
    if (type === 'tRNS') transparency = bytes;
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const decoded = new Uint8Array(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const a = x >= channels ? decoded[i - channels] : 0;
      const b = y ? decoded[i - stride] : 0;
      const c = y && x >= channels ? decoded[i - stride - channels] : 0;
      const prediction = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      decoded[i] = (raw[y * (stride + 1) + x + 1] + prediction) & 255;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  const density = indexed ? new Float32Array(width * height) : undefined;
  for (let i = 0; i < width * height; i++) {
    if (density) density[i] = decoded[i] / 255;
    const color = indexed
      ? palette.subarray(decoded[i] * 3, decoded[i] * 3 + 3)
      : decoded.subarray(i * channels, i * channels + 3);
    data.set(color, i * 4);
    data[i * 4 + 3] = indexed
      ? (transparency?.[decoded[i]] ?? 255)
      : channels === 4
        ? decoded[i * channels + 3]
        : 255;
  }
  const [z, x, y] = name.replace('.png', '').split('_').map(Number);
  return { z, x, y, width, height, data, density };
}

export function readLine(name, acceptNode = () => true) {
  const xml = readFileSync(new URL(`../temp/${name}`, import.meta.url), 'utf8');
  const attrs = (text) =>
    Object.fromEntries(
      [...text.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]])
    );
  const nodes = new Map(
    [...xml.matchAll(/<node\b([^>]*)\/?\s*>/g)].map((m) => {
      const a = attrs(m[1]);
      return [a.id, [Number(a.lon), Number(a.lat)]];
    })
  );
  return [...xml.matchAll(/<nd\b([^>]*)\/>/g)]
    .map((m) => attrs(m[1]).ref)
    .filter(acceptNode)
    .map((id) => nodes.get(id));
}

export function pointDistance(point, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1],
      b = line[i];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const length = dx * dx + dy * dy;
    const t = length
      ? Math.max(
          0,
          Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)
        )
      : 0;
    best = Math.min(best, Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy));
  }
  return best;
}

export function sampleLine(line, spacing = 0.5) {
  const result = [];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1],
      b = line[i],
      steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing);
    for (let j = 0; j < steps; j++)
      result.push([
        a[0] + ((b[0] - a[0]) * j) / steps,
        a[1] + ((b[1] - a[1]) * j) / steps,
      ]);
  }
  return result;
}
