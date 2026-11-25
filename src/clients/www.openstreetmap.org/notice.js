// One-time notice on using the Strava heatmap for mapping, shown the first
// time a Strava overlay is enabled in iD (visible or hidden: Shift+Q hides all overlays),
// and before Slide runs if it was never acknowledged. Built like iD's own
// privacy notice (ui/splash.js): an iD modal plus a versioned flag in iD's
// preferences, so changing the text below shows it once more.
const NOTICE_VERSION = '1';
const PREF_KEY = 'strava-heatmap-notice-version';

const acknowledged = () => window.iD.prefs(PREF_KEY) === NOTICE_VERSION;

export function setupHeatmapNotice(context, isAuthenticated) {
  const container = context.container().node();
  let open = null; // promise of the notice currently shown
  let dismissed = false; // closed without acknowledging: don't reopen by itself

  function show() {
    if (open) return open;
    open = new Promise((resolve) => {
      const modal = window.iD.uiModal(context.container());
      modal.select('.modal').classed('strava-heatmap-notice', true);
      const content = modal.select('.content').node();
      content.innerHTML = `
        <div class="modal-section header"><h3>Mapping with the Strava heatmap</h3></div>
        <div class="modal-section">
          <p>The heatmap shows where people go, not what exists on the ground or what is
          legally accessible. Use it as a guide alongside imagery, OpenStreetMap public GPS
          traces and local knowledge.</p>
          <p>Always check traced lines before saving, including the results of Strava Slide
          (<kbd>Shift</kbd>+<kbd>S</kbd>). Hide all overlays, including the heatmap, with
          <kbd>Shift</kbd>+<kbd>Q</kbd> to compare them with imagery.</p>
        </div>
        <div class="modal-section buttons cf"><button class="button ok-button action strava-heatmap-notice-ok">I understand</button></div>`;
      let agreed = false;
      content.querySelector('.strava-heatmap-notice-ok').addEventListener('click', () => {
        agreed = true;
        window.iD.prefs(PREF_KEY, NOTICE_VERSION);
        modal.close();
      });
      const node = modal.node();
      // Another iD dialog opening (e.g. "restore changes") removes our dialog
      // box but leaves our backdrop: clear it, and show the notice again once
      // that dialog is closed. That does not count as dismissing it.
      let replaced = false;
      new MutationObserver(() => {
        if (node.isConnected && !node.querySelector('.modal')) {
          replaced = true;
          node.remove();
        }
      }).observe(node, { childList: true });
      new MutationObserver((_, observer) => {
        if (node.isConnected) return;
        observer.disconnect();
        if (!agreed && !replaced) dismissed = true;
        open = null;
        resolve(agreed);
      }).observe(container, { childList: true });
    });
    return open;
  }

  function check() {
    if (acknowledged() || dismissed || open || !isAuthenticated()) return;
    const enabled = context
      .background()
      .overlayLayerSources()
      .some((source) => source.id.startsWith('strava-heatmap-'));
    if (!enabled) return;
    // Don't interrupt drawing, the walkthrough, or another iD dialog (opening
    // a modal closes any open one).
    if (context.mode()?.id.startsWith('draw-') || context.inIntro()) return;
    if (container.querySelector('.shaded')) return;
    show();
  }

  context.background().on('change.strava-heatmap-notice', check);
  context.on('enter.strava-heatmap-notice', check);
  // A dialog that just closed may have been what deferred the notice.
  new MutationObserver(() => setTimeout(check, 250)).observe(container, {
    childList: true,
  });
  check();

  // For Slide: resolves true once the notice is acknowledged (now or before).
  return async () => acknowledged() || show();
}
