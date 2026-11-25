// Runs one capture session: opens the site, watches for changes and saves screenshots.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeUrl, safeName, UserError } from './config.js';
import { findBrowser, launchBrowser } from './browser.js';
import { pageHook, pageProbe } from './page-scripts.js';
import { renderGallery } from './gallery.js';

const POLL_MS = 300;
const MAX_FULL_PAGE_HEIGHT = 12000;
const MOBILE_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version} Mobile Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function record(settings, { rootDir, log = console.log }) {
  const url = normalizeUrl(settings.url);
  const executable = findBrowser(settings.browserPath);
  const host = new URL(url).hostname || 'local-file';
  const project = safeName(settings.projectName || host, 40) || 'site';
  const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-');
  const folder = path.join(settings.outputDir, project, stamp);

  // KEEP_LOGIN keeps one browser profile per project; otherwise the profile is temporary.
  const profileDir = settings.keepLogin
    ? path.join(rootDir, 'profiles', project)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'ucapture-'));
  fs.mkdirSync(profileDir, { recursive: true });

  const state = { done: false, paused: false, manual: false, clicks: [], shots: [] };
  const stop = () => { state.done = true; };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];
  signals.forEach((signal) => process.on(signal, stop));

  let browser;
  try {
    browser = launchBrowser({ executable, profileDir, headless: settings.headless });
    await runSession(browser.connection, { settings, url, folder, project, state, log });
  } finally {
    await closeBrowser(browser);
    if (!settings.keepLogin) removeProfile(profileDir, log);
    signals.forEach((signal) => process.off(signal, stop));
  }
  if (!state.shots.length && fs.existsSync(folder) && !fs.readdirSync(folder).length) fs.rmdirSync(folder);
  return { folder, shots: state.shots };
}

async function closeBrowser(browser) {
  if (!browser) return;
  const { child, connection } = browser;
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', resolve);
  });
  await connection.send('Browser.close').catch(() => {});
  await Promise.race([exited, sleep(5000)]);
  child.kill();
}

/** The temporary profile holds the login session, so it must be removed. */
function removeProfile(profileDir, log) {
  try {
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch {
    log(`Could not delete the temporary browser profile. Please delete it yourself: ${profileDir}`);
  }
}

async function runSession(cdp, { settings, url, folder, project, state, log }) {
  const { view } = settings;
  const pages = new Map();       // targetId -> page
  const sessions = new Map();    // sessionId -> page (the page itself and its frames)
  const attaching = new Set();
  const hookSource = `(${pageHook})(${JSON.stringify(settings.blur)})`;
  let order = 0;
  let following = false;
  let agentVersion = '';

  async function prepare(sessionId) {
    const call = (method, params) => cdp.send(method, params, sessionId);
    await call('Runtime.enable');
    await call('Runtime.addBinding', { name: '__capEvent' });
    await call('Page.enable').catch(() => {});
    await call('Page.addScriptToEvaluateOnNewDocument', { source: hookSource }).catch(() => {});
    await call('Runtime.evaluate', { expression: hookSource });
    // Frames from other websites run separately and have to be attached one by one.
    await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }

  async function fitView(page) {
    const call = (method, params) => cdp.send(method, params, page.sessionId);
    let fit = 1;
    if (!settings.headless) {
      const { result } = await call('Runtime.evaluate', {
        expression: '({ width: screen.availWidth, height: screen.availHeight, extra: outerHeight - innerHeight })',
        returnByValue: true,
      });
      const screen = result.value;
      const extra = Math.min(Math.max(screen.extra, 80), 160);      // title bar and address bar
      fit = Math.min(1, (screen.height - extra) / view.height, (screen.width - 20) / view.width);
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.targetId });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { left: 0, top: 0, width: Math.max(500, Math.ceil(view.width * fit) + 16), height: screen.height },
      });
    }
    if (view.mobile) {
      await call('Emulation.setUserAgentOverride', { userAgent: MOBILE_AGENT.replace('{version}', agentVersion) });
    }
    await call('Emulation.setDeviceMetricsOverride', {
      width: view.width, height: view.height, deviceScaleFactor: view.scale, mobile: view.mobile, scale: fit,
    });
  }

  async function addPage(info) {
    if (info.type !== 'page' || pages.has(info.targetId) || attaching.has(info.targetId)) return null;
    if (/^(devtools|chrome-extension):/.test(info.url)) return null;
    attaching.add(info.targetId);
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
      const page = { targetId: info.targetId, sessionId, order: ++order, frames: new Set() };
      pages.set(info.targetId, page);
      sessions.set(sessionId, page);
      await prepare(sessionId);
      await fitView(page);
      return page;
    } finally {
      attaching.delete(info.targetId);
    }
  }

  function onPageEvent(payload) {
    let data;
    try { data = JSON.parse(payload); } catch { return; }
    if (data.type === 'manual') state.manual = true;
    if (data.type === 'pause') {
      state.paused = !state.paused;
      log(state.paused ? '  ⏸  paused (press F9 to resume)' : '  ▶  resumed');
    }
    if (data.type === 'click' && !state.paused && state.clicks.length < 100) {
      state.clicks.push({ time: new Date().toISOString(), ...data });
    }
  }

  cdp.on(({ method, params, sessionId }) => {
    if (method === 'closed') state.done = true;
    else if (method === 'Target.targetCreated' && following) addPage(params.targetInfo).catch(() => {});
    else if (method === 'Target.targetDestroyed') {
      const page = pages.get(params.targetId);
      if (!page) return;
      pages.delete(params.targetId);
      sessions.delete(page.sessionId);
      if (!pages.size) state.done = true;
    } else if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe') {
      const page = sessions.get(sessionId);
      if (!page) return;
      page.frames.add(params.sessionId);
      sessions.set(params.sessionId, page);
      prepare(params.sessionId).catch(() => {});
    } else if (method === 'Target.detachedFromTarget') {
      const page = sessions.get(params.sessionId);
      if (page?.frames.delete(params.sessionId)) sessions.delete(params.sessionId);
    } else if (method === 'Runtime.bindingCalled' && params.name === '__capEvent') {
      onPageEvent(params.payload);
    }
  });

  try {
    agentVersion = (await cdp.send('Browser.getVersion')).product.split('/')[1];
  } catch {
    throw new UserError('The browser did not start. If a capture window is already open for this project, close it and try again.');
  }

  await cdp.send('Target.setDiscoverTargets', { discover: true });
  let first = null;
  for (let attempt = 0; attempt < 50 && !first && !state.done; attempt++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const info = targetInfos.find((target) => target.type === 'page');
    if (info) first = await addPage(info);
    else await sleep(200);
  }
  if (!first) throw new UserError('No browser window appeared.');
  following = true;

  fs.mkdirSync(folder, { recursive: true });
  const navigation = await cdp.send('Page.navigate', { url }, first.sessionId);
  if (navigation.errorText) log(`  Could not open the link (${navigation.errorText}). Check the URL in your settings.`);

  const parsed = new URL(url);
  log('');
  log(`  Website : ${parsed.protocol === 'file:' ? 'local file' : parsed.origin}`);
  log(`  Screen  : ${settings.device} ${view.width}x${view.height}  (images ${Math.round(view.width * view.scale)} px wide)`);
  log(`  Mode    : ${settings.mode}${settings.fullPage ? ', full page' : ''}${settings.blur ? ', blur on' : ''}${settings.keepLogin ? ', login is kept' : ''}`);
  log(`  Saving  : ${folder}`);
  log('');
  log('  F8 = save now    F9 = pause / resume    Close the browser (or Ctrl+C) to finish');
  log('');

  await watch(cdp, { settings, folder, project, state, pages, log });
}

async function watch(cdp, { settings, folder, project, state, pages, log }) {
  const { view } = settings;
  const startedAt = Date.now();
  let lastState = null;
  let savedState = null;
  let lastHash = null;
  let changedAt = Date.now();
  let busySince = Date.now();

  const probeExpression = `(${pageProbe})(${settings.fullPage}, ${JSON.stringify(settings.blur)})`;

  async function probePage(page) {
    const run = async (sessionId) => (await cdp.send('Runtime.evaluate', { expression: probeExpression, returnByValue: true }, sessionId)).result.value;
    const top = await run(page.sessionId);
    if (!top) return null;
    const frames = (await Promise.all([...page.frames].map((id) => run(id).catch(() => null)))).filter(Boolean);
    return {
      ...top,
      focused: top.focused || frames.some((frame) => frame.focused),
      empty: top.empty && frames.every((frame) => frame.empty),
      state: page.targetId + top.state + frames.map((frame) => frame.state).sort().join(''),
      title: top.title || frames.find((frame) => frame.title)?.title || '',
    };
  }

  /** Follow the tab or popup in use; a newly opened one wins until another one has focus. */
  async function activePage() {
    let chosen = null;
    for (const page of [...pages.values()].sort((a, b) => b.order - a.order)) {
      const probe = await probePage(page).catch(() => null);
      if (!probe?.supported) continue;
      if (!chosen || probe.focused) chosen = { page, probe };
      if (probe.focused) break;
    }
    return chosen;
  }

  async function screenshot(page) {
    const call = (method, params) => cdp.send(method, params, page.sessionId);
    const params = { format: 'png' };
    if (settings.fullPage) {
      const { cssContentSize } = await call('Page.getLayoutMetrics');
      const height = Math.min(Math.max(cssContentSize.height, view.height), MAX_FULL_PAGE_HEIGHT);
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: view.width, height, scale: 1 };
    }
    return Buffer.from((await call('Page.captureScreenshot', params)).data, 'base64');
  }

  function save(image, probe, trigger) {
    const slug = safeName(probe.title, 40);
    const file = `${String(state.shots.length + 1).padStart(3, '0')}${slug ? `_${slug}` : ''}.png`;
    fs.writeFileSync(path.join(folder, file), image);
    state.shots.push({
      file,
      title: probe.title,
      url: probe.url,
      time: new Date().toISOString(),
      trigger,
      clicksBefore: state.clicks.splice(0),
      elements: probe.elements,
    });
    fs.writeFileSync(path.join(folder, 'screens.json'), JSON.stringify({ device: settings.device, view, screens: state.shots }, null, 2));
    fs.writeFileSync(path.join(folder, 'gallery.html'), renderGallery(project, state.shots));
    log(`  saved ${file}${trigger === 'f8' ? '  (F8)' : ''}`);
  }

  while (!state.done && !(settings.seconds && Date.now() - startedAt > settings.seconds * 1000)) {
    await sleep(POLL_MS);
    if (state.done) break;
    if (state.paused && !state.manual) continue;
    try {
      const active = await activePage();
      if (!active) continue;
      const { page, probe } = active;
      // Never take a picture when the user asked for blur and it cannot be applied.
      if (probe.badBlur) throw new UserError(`BLUR is not a valid CSS selector: "${settings.blur}"`);
      if (probe.loading || (probe.empty && !state.manual)) continue;

      const now = Date.now();
      if (probe.state !== lastState) { lastState = probe.state; changedAt = now; }
      if (probe.state === savedState) busySince = now;

      const auto = settings.mode === 'auto' && probe.state !== savedState;
      const settled = auto && now - changedAt >= settings.waitMs;
      const tooBusy = auto && now - busySince >= Math.max(6000, settings.waitMs * 4);
      if (!state.manual && !settled && !tooBusy) continue;

      const byKey = state.manual;
      state.manual = false;      // cleared first, so an F8 pressed during the capture is not lost
      const image = await screenshot(page).catch((error) => { state.manual ||= byKey; throw error; });
      savedState = probe.state;
      busySince = now;

      const hash = createHash('sha1').update(image).digest('hex');
      if (hash === lastHash && !byKey) continue;
      lastHash = hash;
      save(image, probe, byKey ? 'f8' : settled ? 'auto' : 'busy');
    } catch (error) {
      if (error instanceof UserError) throw error;
      // A full disk or a missing folder will not fix itself, so stop and say why.
      if (['ENOSPC', 'EACCES', 'EPERM', 'ENOENT'].includes(error.code)) throw new UserError(`Could not save: ${error.message}`);
      if (!cdp.isOpen) break;
      // Otherwise the page is probably changing right now; try again on the next round.
    }
  }
}
