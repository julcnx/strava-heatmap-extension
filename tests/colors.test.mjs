import assert from 'node:assert/strict';
import test from 'node:test';
import { PALETTES } from '../src/clients/common/palettes.js';
import { injectHeatmapColorFilters } from '../src/clients/www.openstreetmap.org/colors.js';

// A minimal DOM lets the test exercise the production filter definitions
// without requiring a browser or copying their implementation.
function createElement(namespaceURI, localName) {
  return {
    namespaceURI,
    localName,
    style: {},
    attributes: {},
    children: [],
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    appendChild(child) {
      this.children.push(child);
    },
  };
}

// Float-only evaluation hides the regression: faint RGB is lost when a browser
// stores premultiplied intermediate surfaces at 8-bit precision.
function renderWithByteSurfaces(filter, intensity) {
  let previous = [intensity, intensity, intensity, 255];
  const results = new Map();
  const clamp = (value) => Math.min(1, Math.max(0, value));
  for (const { localName, attributes, children } of filter.children) {
    // Branches must read their named input, not whichever mask ran last.
    const input = attributes.in ? results.get(attributes.in) : previous;
    // Matrix and transfer formulas operate on unassociated color, even though
    // the stored input has already suffered premultiplied byte rounding.
    const straight = input.map((value, channel) =>
      channel === 3 ? value / 255 : input[3] ? value / input[3] : 0
    );
    let output;
    if (localName === 'feColorMatrix') {
      // Evaluate the emitted matrix so changing its alpha row changes the
      // simulated result, rather than merely failing a structural assertion.
      assert.equal(attributes.type, 'matrix');
      const matrix = attributes.values.split(' ').map(Number);
      output = [0, 1, 2, 3].map((row) => clamp(
        straight.reduce(
          (sum, value, column) => sum + value * matrix[row * 5 + column],
          matrix[row * 5 + 4]
        )
      ));
    } else if (localName === 'feComponentTransfer') {
      // Missing component functions are identity mappings; table interpolation
      // matters because unpremultiplication need not land on an integer index.
      output = [...straight];
      for (const child of children) {
        assert.equal(child.attributes.type, 'table');
        const channel = 'RGBA'.indexOf(child.localName.slice(-1));
        const table = child.attributes.tableValues.split(' ').map(Number);
        const position = straight[channel] * (table.length - 1);
        const index = Math.min(Math.floor(position), table.length - 2);
        output[channel] = table[index] +
          (table[index + 1] - table[index]) * (position - index);
      }
    } else {
      // Compositing consumes premultiplied values directly; unpremultiplying
      // here would incorrectly give the renderer another chance to retain RGB.
      assert.equal(localName, 'feComposite');
      assert.equal(attributes.operator, 'in');
      const mask = results.get(attributes.in2)[3] / 255;
      previous = input.map((value) => Math.round(value * mask));
      continue;
    }
    // Quantize at every primitive boundary, not just at final output: this is
    // where the original filter loses the faint-track color.
    previous = output.map((value, channel) =>
      Math.round(value * (channel === 3 ? 1 : output[3]) * 255)
    );
    if (attributes.result) results.set(attributes.result, previous);
  }
  return previous;
}

test('palette filters preserve color and opacity on 8-bit intermediate surfaces', (t) => {
  // Restore any existing DOM global so this test does not affect other tests.
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const body = createElement(null, 'body');
  globalThis.document = { body, createElementNS: createElement };
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });
  injectHeatmapColorFilters();

  // Correct math is not enough if CSS cannot resolve the injected filters or
  // their hidden container changes the page layout.
  const [svg] = body.children;
  assert.equal(body.children.length, 1);
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(svg.id, 'strava-heatmap-filters');
  assert.deepEqual(svg.attributes, { width: '0', height: '0' });
  assert.equal(svg.style.position, 'absolute');
  assert.equal(svg.children.length, Object.keys(PALETTES).length);

  // Cover every palette: the visibility of precision loss varies by ramp.
  for (const [index, [name, ramp]] of Object.entries(PALETTES).entries()) {
    const filter = svg.children[index];
    assert.equal(filter.id, `strava-heatmap-${name}`);
    assert.equal(filter.attributes['color-interpolation-filters'], 'sRGB');
    const bytes = Buffer.from(ramp, 'hex');
    assert.equal(bytes.length, 256 * 4);
    // Check ramp fidelity independently of filter topology, allowing color and
    // alpha to live in either shared or separate transfer primitives.
    const channels = filter.children
      .filter(({ localName }) => localName === 'feComponentTransfer')
      .flatMap(({ children }) => children);
    assert.equal(channels.length, 4);
    channels.forEach((channel, offset) => {
      assert.equal(channel.localName, `feFunc${'RGBA'[offset]}`);
      const values = channel.attributes.tableValues.split(' ').map(Number);
      assert.equal(values.length, 256);
      values.forEach((value, intensity) => {
        assert.equal(value, Number((bytes[intensity * 4 + offset] / 255).toFixed(4)));
      });
    });

    // The palette itself is the oracle, not the filter implementation. Include
    // the lowest intensities, where premature premultiplication erases RGB.
    for (let intensity = 0; intensity < 256; intensity++) {
      const rgba = [...bytes.subarray(intensity * 4, intensity * 4 + 4)];
      const expected = rgba.map((value, channel) =>
        channel === 3 ? value : Math.round(value * rgba[3] / 255)
      );
      assert.deepEqual(renderWithByteSurfaces(filter, intensity), expected,
        `${name} intensity ${intensity} must survive premultiplied intermediates`);
    }
  }
});
