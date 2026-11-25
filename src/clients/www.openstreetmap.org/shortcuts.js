// Lists the extension's shortcuts in iD's keyboard shortcuts panel (`?`).
// The panel's rows are translation keys iD cannot resolve for us, so a column
// is appended to its Editing tab with the same markup instead, whenever the
// panel is opened.
const SHORTCUTS = [
  ['⇧', 'Q', 'Toggle all overlays, including the Strava heatmap'],
  ['⇧', 'W', 'Toggle the OpenStreetMap data'],
  ['⇧', 'S', 'Slide the selected line along the Strava heatmap'],
];

function column() {
  const table = document.createElement('table');
  table.className = 'shortcut-column strava-heatmap-shortcuts';
  const section = table.insertRow();
  section.className = 'shortcut-row';
  section.insertCell();
  const title = document.createElement('h3');
  title.textContent = 'Strava Heatmap extension';
  const header = section.insertCell();
  header.className = 'shortcut-section';
  header.append(title);
  for (const [modifier, key, description] of SHORTCUTS) {
    const row = table.insertRow();
    row.className = 'shortcut-row';
    const keys = row.insertCell();
    keys.className = 'shortcut-keys';
    const wrapper = document.createElement('div');
    const modifierKey = document.createElement('kbd');
    modifierKey.className = 'modifier';
    modifierKey.textContent = window.iD.uiCmd.display(modifier);
    const plus = document.createElement('span');
    plus.textContent = '+';
    const shortcutKey = document.createElement('kbd');
    shortcutKey.className = 'shortcut';
    shortcutKey.textContent = key;
    wrapper.append(modifierKey, plus, shortcutKey);
    keys.append(wrapper);
    const text = row.insertCell();
    text.className = 'shortcut-desc';
    text.textContent = description;
  }
  return table;
}

// iD appends each modal as a direct child of the editor container; its content
// can render later (the shortcut data loads asynchronously), so watch inside a
// new modal only until its Editing tab appears.
export function setupShortcutsHelp(context) {
  const container = context.container().node();
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element) || !node.classList.contains('shaded')) continue;
        const inject = () => {
          const tab = node.querySelector('.modal-shortcuts .shortcut-tab-editing');
          if (!tab) return false;
          if (!tab.querySelector('.strava-heatmap-shortcuts')) tab.append(column());
          return true;
        };
        if (inject()) continue;
        const observer = new MutationObserver(() => inject() && observer.disconnect());
        observer.observe(node, { childList: true, subtree: true });
      }
    }
  }).observe(container, { childList: true });
}
