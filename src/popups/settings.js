import Sortable from '../../lib/sortablejs@1.15.0.esm.min.js';

import { createColorPicker } from './color-picker.js';
import { openLogout } from '../background/tabs.js';
import { getDocUrl, getExtensionName } from '../extension.js';

import {
  formatLayerPresets,
  getLayerPresets,
  setLayerPresets,
  DEFAULT_LAYER_PRESETS,
  validateLayerPresets,
} from '../background/layers.js';

import { ACTIVITY_OPTIONS } from '../clients/common/layers.js';

const MAX_LAYERS = 8;

function createActivitySelect(selected, disabled) {
  const select = document.createElement('select');
  select.className = 'activity';
  select.setAttribute('aria-label', 'Activity');
  select.classList.toggle('invalid', selected === undefined);

  const placeholder = document.createElement('option');
  placeholder.textContent = 'Pick an activity';
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.selected = selected === undefined;
  select.appendChild(placeholder);

  ACTIVITY_OPTIONS.forEach(([groupLabel, activities]) => {
    const optgroup = document.createElement('optgroup');
    optgroup.label = `📂 ${groupLabel}`;
    select.appendChild(optgroup);
    activities.forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      if (disabled.includes(value)) option.disabled = true;
      if (value === selected) option.selected = true;
      optgroup.appendChild(option);
    });
  });
  return select;
}

function createLayerItem(
  layer,
  index,
  disabledActivities,
  removeCallback,
  changeCallback
) {
  const li = document.createElement('li');
  li.className = 'layer';
  li.dataset.index = index;

  const dragHandle = document.createElement('span');
  dragHandle.className = 'drag-handle';
  dragHandle.textContent = '⠿';
  // not a <button>: Firefox cannot drag those
  dragHandle.tabIndex = 0;
  dragHandle.setAttribute('role', 'button');
  dragHandle.setAttribute('aria-label', 'Move layer: drag, or use the up and down arrow keys');
  dragHandle.onkeydown = (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (event.key === 'ArrowUp') li.previousElementSibling?.before(li);
    else li.nextElementSibling?.after(li);
    dragHandle.focus();
    changeCallback();
  };

  const activitySelect = createActivitySelect(layer.activity, disabledActivities);
  activitySelect.onchange = () => changeCallback();
  const colorPicker = createColorPicker(layer.color, () => changeCallback());

  const deleteButton = document.createElement('button');
  deleteButton.className = 'layer-remove';
  deleteButton.setAttribute('aria-label', 'Remove layer');
  deleteButton.onclick = () => removeCallback(index);

  li.appendChild(dragHandle);
  li.appendChild(activitySelect);
  li.appendChild(colorPicker);
  li.appendChild(deleteButton);

  return li;
}

async function renderLayers(layers) {
  const list = document.getElementById('layer-list');
  // Drawing the list again must not lose the keyboard focus
  const focused = document.activeElement;
  const focusedIndex = [...list.children].indexOf(focused?.closest('.layer'));
  list.innerHTML = '';

  layers.forEach((layer, i) => {
    const item = createLayerItem(
      layer,
      i,
      layers.map((l) => l.activity).filter((a) => a !== layer.activity),
      async (index) => {
        layers.splice(index, 1);
        await renderLayers(layers);
      },
      async () => {
        const current = getCurrentLayers();
        await renderLayers(current);
      }
    );
    list.appendChild(item);
  });

  if (focusedIndex !== -1) {
    list.children[Math.min(focusedIndex, layers.length - 1)]
      .querySelector(`.${focused.classList[0]}`)
      .focus();
  }

  const layerPresets = await getLayerPresets();
  const hasValidChanges =
    validateLayerPresets(layers) &&
    formatLayerPresets(layers) !== formatLayerPresets(layerPresets);

  document.querySelector('#layer-list .layer-remove').disabled = layers.length === 1;
  document.getElementById('add-layer').disabled = layers.length >= MAX_LAYERS;

  document.getElementById('apply-settings').disabled = !hasValidChanges;
}

function getCurrentLayers() {
  const items = [...document.querySelectorAll('#layer-list .layer')];
  return items.map((item) => {
    return {
      activity: item.querySelector('.activity').value || undefined,
      color: item.querySelector('.color-picker').dataset.value || undefined,
    };
  });
}

document.getElementById('settings-title').textContent = getExtensionName();
document.getElementById('version').textContent = `v${browser.runtime.getManifest().version}`;

document.addEventListener('DOMContentLoaded', async () => {
  const layerPresets = await getLayerPresets();
  await renderLayers(layerPresets);

  const { credentials } = await browser.storage.local.get('credentials');
  const loginStatus = document.getElementById('login-status');
  loginStatus.textContent = credentials
    ? 'Logged in to Strava'
    : 'Not logged in to Strava';
  loginStatus.classList.toggle('logged-in', Boolean(credentials));
  document.getElementById('sign-out').hidden = !credentials;

  document.getElementById('sign-out').addEventListener('click', async () => {
    await openLogout();
    window.close();
  });

  document.getElementById('help').addEventListener('click', async () => {
    await browser.tabs.create({ url: getDocUrl('README.md') });
    window.close();
  });

  const list = document.getElementById('layer-list');
  Sortable.create(list, {
    handle: '.drag-handle',
    animation: 150,
    onEnd: async () => {
      const current = getCurrentLayers();
      await renderLayers(current);
    },
  });

  document.getElementById('close-settings').addEventListener('click', async () => {
    window.close();
  });

  document.getElementById('add-layer').addEventListener('click', async () => {
    const current = getCurrentLayers();
    if (current.length < MAX_LAYERS) {
      current.push({ activity: undefined, color: undefined });
      await renderLayers(current);
    }
  });

  document.getElementById('reset-settings').addEventListener('click', async () => {
    await renderLayers([...DEFAULT_LAYER_PRESETS]);
  });

  document.getElementById('apply-settings').addEventListener('click', async () => {
    const current = getCurrentLayers();
    if (current.length >= 1) {
      await setLayerPresets(current);
      window.close();
    }
  });
});
