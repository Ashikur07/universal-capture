// Code that runs inside the web page. Each function is sent to the browser as text,
// so it must be self-contained: no imports and no outside variables.

/** Reports clicks and the F8 / F9 keys, and applies the optional blur. Typed values are never reported. */
export function pageHook(blurSelector) {
  if (window.__capHooked) return;
  window.__capHooked = true;
  const send = (data) => window.__capEvent?.(JSON.stringify(data));

  window.__capBlur = () => {
    if (!blurSelector || !document.documentElement || document.getElementById('__cap-blur')) return;
    const style = document.createElement('style');
    style.id = '__cap-blur';
    style.textContent = `${blurSelector} { filter: blur(9px) !important; }`;
    document.documentElement.appendChild(style);
  };
  window.__capBlur();
  document.addEventListener('DOMContentLoaded', window.__capBlur);

  document.addEventListener('pointerdown', (event) => {
    const origin = event.composedPath()[0];
    if (!(origin instanceof Element)) return;
    const el = origin.closest('button, a, input, select, textarea, label, [role="button"]') ?? origin;
    const typed = el.matches('input, textarea, select') || el.isContentEditable;
    const label = typed
      ? el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || el.tagName
      : el.innerText || el.getAttribute('aria-label') || el.tagName;
    const r = el.getBoundingClientRect();
    send({
      type: 'click',
      label: String(label).trim().replace(/\s+/g, ' ').slice(0, 60),
      tag: el.tagName.toLowerCase(),
      inFrame: window !== window.top,
      point: { x: Math.round(event.clientX), y: Math.round(event.clientY) },
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }, true);

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'F8' && event.key !== 'F9') return;
    event.preventDefault();
    if (!event.repeat) send({ type: event.key === 'F8' ? 'manual' : 'pause' });
  }, true);
}

/** Describes what is on screen, so that changes can be noticed. */
export function pageProbe(ignoreScroll, blurSelector) {
  window.__capBlur?.();          // some apps rebuild the page and remove added styles
  let badBlur = false;
  if (blurSelector) {
    try { document.querySelector(blurSelector); } catch { badBlur = true; }
  }

  const parts = [];
  const elements = [];
  let heading = '';
  let content = 0;

  const visit = (doc, isTop) => {
    const body = doc.body;
    if (!body) return;
    const win = doc.defaultView;
    const roots = [body];
    const all = [];
    for (let i = 0; i < roots.length; i++) {          // include open shadow roots
      for (const el of roots[i].querySelectorAll('*')) {
        all.push(el);
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    const text = (body.innerText ?? '').trim() + roots.slice(1).map((r) => r.textContent.trim()).join(' ');
    // Running clocks and countdowns should not count as a new screen.
    parts.push(text.replace(/\d{1,2}:\d{2}(:\d{2})?/g, '#').replace(/\b\d+\s?(s|sec|secs|seconds)\b/gi, '#'));

    let pictures = 0;
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'img' || tag === 'svg' || tag === 'canvas' || tag === 'video') pictures++;
      if (tag === 'img') parts.push(el.complete ? (el.currentSrc || '').slice(-60) : 'loading');
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        // only the length of a typed value is used, never the value itself
        parts.push([el.type, (el.value ?? '').length, el.checked ? 1 : 0].join(':'));
      }
      if (!ignoreScroll && el.scrollTop > 0) parts.push(`scroll:${Math.round(el.scrollTop / 150)}`);
      if (el.open === true || el.getAttribute('aria-expanded') === 'true') parts.push(`open:${tag}`);
      if (tag === 'iframe') {
        try { if (el.contentDocument) visit(el.contentDocument, false); } catch { /* other origin: handled separately */ }
      }
      if (isTop && elements.length < 150 && el.matches('button, a, input, select, textarea, [role="button"], h1, h2, h3, label')) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > win.innerHeight) continue;
        if (blurSelector && !badBlur && el.closest(blurSelector)) continue;     // blurred text is not saved either
        const typed = el.matches('input, textarea, select');
        const label = typed ? el.getAttribute('placeholder') || el.type : el.innerText || el.getAttribute('aria-label') || '';
        elements.push({
          tag,
          label: String(label).trim().replace(/\s+/g, ' ').slice(0, 60),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        });
      }
    }
    if (!ignoreScroll && win.scrollY > 0) parts.push(`page:${Math.round(win.scrollY / 150)}`);
    content += text.length + pictures;
    if (!heading) {
      const found = [...body.querySelectorAll('h1, h2')]
        .find((h) => h.offsetParent && !(blurSelector && !badBlur && h.closest(blurSelector)));
      heading = found?.innerText ?? '';
    }
  };

  visit(document, true);
  return {
    state: JSON.stringify([location.href, parts]),
    empty: content === 0,
    loading: document.readyState === 'loading',
    focused: document.hasFocus(),
    supported: ['http:', 'https:', 'file:'].includes(location.protocol),
    // query strings and #fragments often hold tokens, so they are not saved
    url: `${location.protocol}//${location.host}${location.pathname}`,
    title: heading.trim() || document.title,
    elements,
    badBlur,
  };
}
