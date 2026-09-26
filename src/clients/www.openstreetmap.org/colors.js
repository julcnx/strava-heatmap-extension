import { PALETTES } from '../common/palettes.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Injects one SVG filter per palette, reproducing Strava's colorization of
// grayscale heatmap tiles: the red channel (intensity) indexes a 256-entry RGBA
// ramp. Tiles are matched to their filter in index.css.
export function injectHeatmapColorFilters() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = 'strava-heatmap-filters';
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';

  for (const [name, ramp] of Object.entries(PALETTES)) {
    svg.appendChild(createPaletteFilter(name, ramp));
  }

  document.body.appendChild(svg);
}

function createPaletteFilter(name, ramp) {
  const bytes = ramp.match(/../g).map((hex) => parseInt(hex, 16) / 255);
  const channel = (offset) =>
    bytes
      .filter((_, i) => i % 4 === offset)
      .map((value) => +value.toFixed(4))
      .join(' ');

  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.id = `strava-heatmap-${name}`;
  filter.setAttribute('color-interpolation-filters', 'sRGB');

  // Copy intensity (red) into all channels, including alpha
  const matrix = document.createElementNS(SVG_NS, 'feColorMatrix');
  matrix.setAttribute('type', 'matrix');
  matrix.setAttribute('values', '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0');
  filter.appendChild(matrix);

  // Map intensity through the palette ramp
  const transfer = document.createElementNS(SVG_NS, 'feComponentTransfer');
  ['R', 'G', 'B', 'A'].forEach((component, offset) => {
    const func = document.createElementNS(SVG_NS, `feFunc${component}`);
    func.setAttribute('type', 'table');
    func.setAttribute('tableValues', channel(offset));
    transfer.appendChild(func);
  });
  filter.appendChild(transfer);

  return filter;
}
