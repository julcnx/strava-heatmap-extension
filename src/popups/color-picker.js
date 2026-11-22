import { COLOR_OPTIONS, getSwatch } from '../clients/common/layers.js';

let nextId = 0;

function createSwatch(color) {
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.backgroundImage = getSwatch(color);
  return swatch;
}

// A dropdown showing each color as a swatch of its palette. The selected color
// is in the returned element's dataset.value, empty until one is picked.
export function createColorPicker(selected, changeCallback) {
  const picker = document.createElement('div');
  picker.className = 'color-picker';
  picker.dataset.value = selected ?? '';
  const selectedIndex = COLOR_OPTIONS.findIndex(([value]) => value === selected);
  const selectedLabel = COLOR_OPTIONS[selectedIndex]?.[1];

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'color-button';
  button.classList.toggle('invalid', selectedIndex === -1);
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', `Color: ${selectedLabel ?? 'none'}`);
  if (selectedIndex === -1) {
    button.append('Pick a color');
  } else {
    button.append(createSwatch(selected), selectedLabel);
  }

  const list = document.createElement('ul');
  list.className = 'color-list';
  list.tabIndex = -1;
  list.hidden = true;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Color');

  let active = 0;
  const options = COLOR_OPTIONS.map(([value, label], index) => {
    const option = document.createElement('li');
    option.id = `color-option-${nextId++}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(value === selected));
    option.append(createSwatch(value), label);
    option.onmouseenter = () => setActive(index);
    option.onclick = () => pick(index);
    list.append(option);
    return option;
  });

  function setActive(index) {
    active = Math.max(0, Math.min(options.length - 1, index));
    options.forEach((option, i) => option.classList.toggle('active', i === active));
    options[active].scrollIntoView({ block: 'nearest' });
    list.setAttribute('aria-activedescendant', options[active].id);
  }

  // Below the button, moved up as needed to stay inside the popup
  function open() {
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const { left, bottom, width } = button.getBoundingClientRect();
    const top = Math.min(bottom + 2, window.innerHeight - list.offsetHeight - 4);
    list.style.left = `${left}px`;
    list.style.top = `${Math.max(4, top)}px`;
    list.style.width = `${width}px`;
    setActive(selectedIndex);
    list.focus();
  }

  function close() {
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  function pick(index) {
    close();
    button.focus();
    picker.dataset.value = COLOR_OPTIONS[index][0];
    changeCallback();
  }

  button.onclick = open;
  button.onkeydown = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    open();
  };
  list.onblur = close;
  list.onkeydown = (event) => {
    const actions = {
      ArrowDown: () => setActive(active + 1),
      ArrowUp: () => setActive(active - 1),
      Home: () => setActive(0),
      End: () => setActive(options.length - 1),
      Enter: () => pick(active),
      ' ': () => pick(active),
      Escape: () => button.focus(), // closes the list, not the popup
    };
    if (!actions[event.key]) return;
    event.preventDefault();
    actions[event.key]();
  };

  picker.append(button, list);
  return picker;
}
