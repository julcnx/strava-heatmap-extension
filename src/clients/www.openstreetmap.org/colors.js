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

  // Keep intensity opaque until lookup: premultiplying faint RGB by intensity
  // can lose its color precision on 8-bit filter surfaces.
  const matrix = document.createElementNS(SVG_NS, 'feColorMatrix');
  matrix.setAttribute('type', 'matrix');
  matrix.setAttribute('values', '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1');
  matrix.setAttribute('result', 'intensity');
  filter.appendChild(matrix);

  // Color lookup must stay independent of opacity to retain faint-track RGB
  // until the final composite.
  const transfer = document.createElementNS(SVG_NS, 'feComponentTransfer');
  transfer.setAttribute('in', 'intensity');
  transfer.setAttribute('result', 'palette-color');
  ['R', 'G', 'B'].forEach((component, offset) => {
    const func = document.createElementNS(SVG_NS, `feFunc${component}`);
    func.setAttribute('type', 'table');
    func.setAttribute('tableValues', channel(offset));
    transfer.appendChild(func);
  });
  filter.appendChild(transfer);

  // Opacity also depends on the original intensity, not the mapped color.
  // Zero RGB prevents this separate mask from carrying color precision errors.
  const alphaMatrix = document.createElementNS(SVG_NS, 'feColorMatrix');
  alphaMatrix.setAttribute('in', 'intensity');
  alphaMatrix.setAttribute('type', 'matrix');
  alphaMatrix.setAttribute('values', '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0');
  filter.appendChild(alphaMatrix);

  // Strava's ramp alpha, rather than tile alpha or intensity alone, determines
  // how much of the basemap should show through.
  const alphaTransfer = document.createElementNS(SVG_NS, 'feComponentTransfer');
  const alpha = document.createElementNS(SVG_NS, 'feFuncA');
  alpha.setAttribute('type', 'table');
  alpha.setAttribute('tableValues', channel(3));
  alphaTransfer.appendChild(alpha);
  alphaTransfer.setAttribute('result', 'palette-alpha');
  filter.appendChild(alphaTransfer);

  // Apply opacity only after color lookup, so intermediate rounding cannot
  // turn low-intensity tracks black before their palette color is known.
  const composite = document.createElementNS(SVG_NS, 'feComposite');
  composite.setAttribute('in', 'palette-color');
  composite.setAttribute('in2', 'palette-alpha');
  composite.setAttribute('operator', 'in');
  filter.appendChild(composite);

  return filter;
}
