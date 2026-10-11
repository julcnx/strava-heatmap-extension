// Optional real-browser smoke test. Uses Node 22's built-in WebSocket and Chrome
// DevTools Protocol, not a browser automation dependency or a user's profile.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const mime = {
  '.js': 'text/javascript',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.css': 'text/css',
  '.osc': 'application/xml',
};
const server = createServer(async (request, response) => {
  try {
    const path = resolve(
      root,
      `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`
    );
    if (!path.startsWith(root.replace(/\/$/, '') + sep))
      throw new Error('Outside fixture root');
    const body = await readFile(path);
    response.writeHead(200, {
      'Content-Type': mime[extname(path)] || 'application/octet-stream',
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(
  resolve(process.env.OPENCODE_TEMP_DIR || tmpdir(), 'slide-browser-')
);
const binary =
  process.env.CHROME_BIN ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'chromium');
const chrome = spawn(
  binary,
  [
    '--headless',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }
);
let socket;
const pending = new Map();
let nextID = 0;
const watchdog = setTimeout(() => {
  console.error('Browser smoke test timed out.');
  chrome.kill();
}, 60000);
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    chrome.stderr.on('data', (data) => {
      output += data.toString();
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    chrome.once('error', reject);
    chrome.once('exit', () =>
      reject(new Error('Chrome exited before DevTools was ready.'))
    );
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const handlers = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handlers?.reject(new Error(message.error.message));
    else handlers?.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const handlers of pending.values())
      handlers.reject(new Error('Browser disconnected.'));
    pending.clear();
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextID;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send(
    'Page.navigate',
    { url: `http://127.0.0.1:${server.address().port}/tests/browser.html` },
    sessionId
  );
  const evaluation = await send(
    'Runtime.evaluate',
    {
      expression: `new Promise(resolve => {
      const check = () => {
        if (!document.body?.dataset.passed) return;
        observer.disconnect();
        resolve({ passed: document.body.dataset.passed === 'true', text: document.getElementById('result').textContent });
      };
      const observer = new MutationObserver(check);
      observer.observe(document, { subtree: true, attributes: true, childList: true });
      check();
    })`,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId
  );
  const result = evaluation.result.value;
  if (!result?.passed) throw new Error(result?.text || JSON.stringify(evaluation));
  console.log(result.text);
  const previewTarget = await send('Target.createTarget', { url: 'about:blank' });
  const preview = await send('Target.attachToTarget', {
    targetId: previewTarget.targetId,
    flatten: true,
  });
  await send('Page.enable', {}, preview.sessionId);
  await send(
    'Page.navigate',
    {
      url: `http://127.0.0.1:${server.address().port}/tests/preview.html`,
    },
    preview.sessionId
  );
  async function previewResult(example) {
    const evaluation = await send(
      'Runtime.evaluate',
      {
        expression: `new Promise(resolve => {
        const check = () => {
          if (!document.body?.dataset.ready && !document.body?.dataset.error) return;
          observer.disconnect();
          resolve({ error: document.body.dataset.error,
            text: document.getElementById('status').textContent,
            referenceDisabled: document.getElementById('reference').disabled,
            previousDisabled: document.getElementById('reported').disabled,
            exportDisabled: document.getElementById('export').disabled });
        };
        const observer = new MutationObserver(check);
        observer.observe(document, { subtree: true, attributes: true, childList: true });
        const example = ${JSON.stringify(example ?? null)};
        if (example) {
          const select = document.getElementById('example');
          select.value = example;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        check();
      })`,
        awaitPromise: true,
        returnByValue: true,
      },
      preview.sessionId
    );
    const result = evaluation.result.value;
    if (!result || result.error || result.exportDisabled) {
      throw new Error(result?.error || JSON.stringify(evaluation));
    }
    return result;
  }
  const originalPreview = await previewResult();
  if (!originalPreview.text.includes('45 output nodes'))
    throw new Error(originalPreview.text);
  console.log('PASS: original example renders with the cleaned 45-node result');
  const straightPreview = await previewResult('straight');
  if (
    !straightPreview.text.includes('54 output nodes') ||
    !straightPreview.referenceDisabled ||
    straightPreview.previousDisabled
  ) {
    throw new Error(JSON.stringify(straightPreview));
  }
  console.log(
    'PASS: straight-passage example renders with 54 nodes, prior-output overlay and OSC export'
  );
  await send('Browser.close').catch(() => {});
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  socket?.close();
  chrome.kill();
  chrome.stderr.destroy();
  server.closeAllConnections();
  server.close();
  // Leave this explicitly isolated profile for diagnostics; never touch the
  // user's browser profile, or recursively remove an environment-chosen path.
}
