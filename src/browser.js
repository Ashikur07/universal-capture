// Finds Chrome / Edge, starts it, and talks to it with the DevTools protocol.
// The connection uses private pipes (--remote-debugging-pipe), not a network port,
// so other programs and websites cannot connect to the capture browser.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './config.js';

export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    const apps = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe'];
    return apps.flatMap((app) => roots.map((root) => path.win32.join(root, app)));
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
  const dirs = (env.PATH ?? '').split(':').filter(Boolean);
  return names.flatMap((name) => dirs.map((dir) => path.posix.join(dir, name)));
}

export function findBrowser(custom) {
  if (custom) {
    if (!fs.existsSync(custom)) throw new UserError(`BROWSER_PATH does not exist: ${custom}`);
    return custom;
  }
  const found = browserCandidates().find((file) => fs.existsSync(file));
  if (!found) throw new UserError('Chrome, Edge or Chromium was not found. Set BROWSER_PATH in the .env file.');
  return found;
}

export function launchBrowser({ executable, profileDir, headless }) {
  // CAPTURE_BROWSER_ARGS is only for automated test machines (for example --no-sandbox in CI).
  const extra = (process.env.CAPTURE_BROWSER_ARGS ?? '').split(' ').filter(Boolean);
  const child = spawn(executable, [
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    ...(headless ? ['--headless=new'] : ['--new-window']),
    ...extra,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  // "detached" keeps Ctrl+C from killing the browser before the program has cleaned up.
  return { child, connection: connectPipe(child) };
}

const closedError = () => new Error('Browser closed.');

export function connectPipe(child, timeoutMs = 15000) {
  const [writer, reader] = [child.stdio[3], child.stdio[4]];
  const pending = new Map();
  const listeners = [];
  let nextId = 0;
  let open = true;
  let buffered = [];

  const close = () => {
    if (!open) return;
    open = false;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(closedError());
    }
    pending.clear();
    listeners.forEach((listener) => listener({ method: 'closed' }));
  };

  const receive = (raw) => {
    const message = JSON.parse(raw);
    if (!message.id) {
      listeners.forEach((listener) => listener(message));
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };

  // Messages end with a zero byte and can arrive in many pieces.
  reader.on('data', (chunk) => {
    let start = 0;
    let end = chunk.indexOf(0, start);
    while (end !== -1) {
      buffered.push(chunk.subarray(start, end));
      const raw = Buffer.concat(buffered).toString('utf8');
      buffered = [];
      receive(raw);
      start = end + 1;
      end = chunk.indexOf(0, start);
    }
    if (start < chunk.length) buffered.push(chunk.subarray(start));
  });
  for (const stream of [reader, writer]) {
    stream.on('error', close);
    stream.on('close', close);
  }
  child.on('exit', close);
  child.on('error', close);

  return {
    get isOpen() { return open; },
    on: (listener) => listeners.push(listener),
    send(method, params = {}, sessionId) {
      if (!open) return Promise.reject(closedError());
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        // A page showing an alert box stops answering, so never wait forever.
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        writer.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
      });
    },
  };
}
