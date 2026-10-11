import {
  createHeatmapRaster,
  lineBounds,
  metersPerPixel,
  project,
  slideLine,
} from '../src/clients/common/slide.js';
import { decodeHeatmapPNG } from '../src/clients/common/slide-png.js';

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const status = document.getElementById('status');
const run = document.getElementById('run');
const download = document.getElementById('export');
const chooser = document.getElementById('tiles');
const example = document.getElementById('example');
const examples = {
  curves: {
    input: 'lineInput.osc',
    reference: 'optimalOutputAfterSlide.osc',
    previous: 'currentOutput.osc',
    tiles: ['14_12922_8127.png', '15_25844_16255.png', '15_25845_16255.png'],
  },
  straight: {
    input: 'lineInput1.osc',
    previous: 'lineOutput1.osc',
    tiles: ['15_25831_16258.png'],
  },
};
let tiles, input, reference, reported, inputDoc, originalNodes, bounds, result;

async function readLine(file) {
  const response = await fetch(`../temp/${file}`);
  if (!response.ok) throw new Error(`Could not load ${file}.`);
  const doc = new DOMParser().parseFromString(await response.text(), 'application/xml');
  const nodeMap = new Map(
    [...doc.querySelectorAll('node')].map((node) => [node.getAttribute('id'), node])
  );
  const nodes = [...doc.querySelectorAll('way nd')].map((nd) =>
    nodeMap.get(nd.getAttribute('ref'))
  );
  return {
    doc,
    nodes,
    locations: nodes.map((node) => [
      Number(node.getAttribute('lon')),
      Number(node.getAttribute('lat')),
    ]),
  };
}

async function readTile(file) {
  const response = await fetch(`../temp/${file}`);
  const bytes = await response.arrayBuffer();
  const decoded = await decodeHeatmapPNG(bytes);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const image = document.createElement('canvas');
  image.width = bitmap.width;
  image.height = bitmap.height;
  image.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  const [z, x, y] = file.replace('.png', '').split('_').map(Number);
  return {
    z,
    x,
    y,
    width: image.width,
    height: image.height,
    image,
    density: decoded.density,
  };
}

function activeTiles() {
  return chooser.value === 'parent' ? tiles.filter((tile) => tile.z === 14) : tiles;
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const tile of activeTiles()
    .slice()
    .sort((a, b) => a.z - b.z)) {
    const size = 512 * 2 ** (15 - tile.z);
    ctx.drawImage(
      tile.image,
      (tile.x * size - bounds.minX) * 3,
      (tile.y * size - bounds.minY) * 3,
      size * 3,
      size * 3
    );
  }
  for (const [id, locations, color] of [
    ['input', input, '#2683ff'],
    ['reference', reference, '#ff28e5'],
    ['reported', reported, '#ff4040'],
    ['output', result?.map((point) => point.loc), '#00ff9f'],
  ]) {
    if (!locations || !document.getElementById(id).checked) continue;
    ctx.beginPath();
    for (let i = 0; i < locations.length; i++) {
      const p = project(locations[i]);
      const x = (p[0] - bounds.minX) * 3,
        y = (p[1] - bounds.minY) * 3;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

async function slide() {
  run.disabled = download.disabled = true;
  example.disabled = chooser.disabled = true;
  try {
    const raster = createHeatmapRaster(activeTiles(), 15, bounds);
    result = await slideLine(input, raster, {
      onProgress: (progress) => {
        status.textContent = `Sliding… ${Math.round(progress * 100)}%`;
      },
    });
    status.textContent = `${input.length} input nodes → ${result.length} output nodes. Endpoints are unchanged.`;
    download.disabled = false;
    draw();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    run.disabled = false;
    example.disabled = chooser.disabled = false;
  }
}

download.addEventListener('click', () => {
  const doc = inputDoc.cloneNode(true);
  const way = doc.querySelector('way');
  for (const nd of [...way.querySelectorAll('nd')]) nd.remove();
  let nextID =
    Math.min(
      ...[...doc.querySelectorAll('node')].map((node) => Number(node.getAttribute('id')))
    ) - 1;
  for (const point of result) {
    let node;
    if (point.nodeIndex !== null) {
      const id = originalNodes[point.nodeIndex].getAttribute('id');
      node = [...doc.querySelectorAll('node')].find(
        (node) => node.getAttribute('id') === id
      );
    } else {
      node = doc.createElement('node');
      node.setAttribute('id', nextID--);
      node.setAttribute('version', '0');
      doc.querySelector('create').insertBefore(node, way);
    }
    node.setAttribute('lon', point.loc[0]);
    node.setAttribute('lat', point.loc[1]);
    const nd = doc.createElement('nd');
    nd.setAttribute('ref', node.getAttribute('id'));
    way.insertBefore(nd, way.querySelector('tag'));
  }
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(doc)], { type: 'application/xml' })
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'outputAfterSlide.osc';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

async function loadExample() {
  run.disabled = download.disabled = example.disabled = chooser.disabled = true;
  status.textContent = 'Loading fixtures…';
  result = undefined;
  delete document.body.dataset.ready;
  delete document.body.dataset.error;
  try {
    const config = examples[example.value];
    const [a, b, images, current] = await Promise.all([
      readLine(config.input),
      config.reference ? readLine(config.reference) : Promise.resolve(null),
      Promise.all(config.tiles.map(readTile)),
      readLine(config.previous).catch(() => null),
    ]);
    input = a.locations;
    inputDoc = a.doc;
    originalNodes = a.nodes;
    reference = b?.locations;
    document.getElementById('reference').disabled = !reference;
    reported = current?.locations;
    document.getElementById('reported').disabled = !reported;
    tiles = images;
    const hasParent = tiles.some((tile) => tile.z === 14);
    chooser.querySelector('option[value="parent"]').disabled = !hasParent;
    if (!hasParent) chooser.value = 'mixed';
    bounds = lineBounds(input, 15, Math.ceil(32 / metersPerPixel(input[0][1])));
    canvas.width = (bounds.maxX - bounds.minX + 1) * 3;
    canvas.height = (bounds.maxY - bounds.minY + 1) * 3;
    await slide();
    document.body.dataset.ready = 'true';
  } catch (error) {
    status.textContent = error.message;
    document.body.dataset.error = error.message;
  } finally {
    example.disabled = chooser.disabled = false;
  }
}

for (const id of ['input', 'reference', 'output', 'reported'])
  document.getElementById(id).addEventListener('change', draw);
run.addEventListener('click', slide);
chooser.addEventListener('change', slide);
example.addEventListener('change', loadExample);
await loadExample();
