// Builds gallery.html: a single offline page to review the screenshots of one run.

export const escapeHtml = (value) => String(value ?? '')
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderGallery(project, shots) {
  const cards = shots.map((shot, index) => {
    const src = escapeHtml(encodeURIComponent(shot.file));
    const title = escapeHtml(shot.title || 'Screen');
    const path = escapeHtml((shot.clicksBefore ?? []).map((c) => c.label).filter(Boolean).slice(-3).join(' → '));
    return `<figure data-text="${title.toLowerCase()} ${path.toLowerCase()}">
<button type="button" data-src="${src}" aria-label="Open screenshot ${index + 1}"><img loading="lazy" src="${src}" alt="${title}"></button>
<figcaption><b><i>${index + 1}</i>${title}</b><span>${path || '&nbsp;'}</span></figcaption>
</figure>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(project)} · screenshots</title>
<style>
:root{--bg:#f1f5f9;--card:#fff;--ink:#0f172a;--muted:#64748b;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#161f33;--ink:#e2e8f0;--muted:#94a3b8;--accent:#818cf8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,"Segoe UI","Nirmala UI",sans-serif}
header{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:16px 28px;background:var(--card);box-shadow:0 1px 8px #0002}
h1{margin:0;font-size:19px}header small{color:var(--muted);font-size:13px;margin-left:10px;font-weight:400}
input{width:min(320px,100%);padding:9px 14px;border:1px solid #8884;border-radius:99px;background:var(--bg);color:var(--ink)}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:20px;padding:28px}
figure{margin:0;padding:12px;background:var(--card);border-radius:16px;box-shadow:0 2px 14px #0000001a}
figure button{all:unset;display:block;width:100%;cursor:zoom-in;border-radius:10px;overflow:hidden;background:#8881}
figure button:focus-visible{outline:3px solid var(--accent)}
figure img{display:block;width:100%;height:360px;object-fit:contain}
figcaption{margin-top:10px}figcaption b{display:flex;gap:8px;align-items:center}
figcaption i{flex:none;min-width:24px;padding:0 6px;border-radius:99px;background:var(--accent);color:#fff;font:600 12px/22px system-ui;text-align:center}
figcaption span{display:block;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
dialog{width:100vw;height:100vh;max-width:none;max-height:none;border:0;padding:24px;background:#020617ee;color:#fff}
dialog[open]{display:flex;flex-direction:column;align-items:center;gap:12px}
dialog .view{flex:1;min-height:0;width:100%;overflow:auto;text-align:center}
dialog img{max-width:100%;max-height:100%;object-fit:contain}
dialog nav button{margin:0 5px;padding:8px 18px;border:0;border-radius:99px;background:#fff2;color:#fff;cursor:pointer}
</style>
</head>
<body>
<header><h1>${escapeHtml(project)}<small>${shots.length} screenshot${shots.length === 1 ? '' : 's'}</small></h1>
<input type="search" placeholder="Search screens…" aria-label="Search screens"></header>
<main>
${cards}
</main>
<dialog><div class="view"><img alt=""></div><nav><button data-step="-1">← Previous</button><button data-close>Close (Esc)</button><button data-step="1">Next →</button></nav></dialog>
<script>
const box = document.querySelector('dialog'), big = box.querySelector('img');
const shown = () => [...document.querySelectorAll('figure:not([hidden]) button')];
let at = 0;
const show = (i) => { const list = shown(); at = (i + list.length) % list.length; big.src = list[at].dataset.src; };
document.querySelector('main').addEventListener('click', (e) => {
  const button = e.target.closest('button'); if (!button) return;
  show(shown().indexOf(button)); box.showModal();
});
box.addEventListener('click', (e) => {
  if (e.target.dataset.step) show(at + Number(e.target.dataset.step));
  else if ('close' in e.target.dataset) box.close();
});
document.addEventListener('keydown', (e) => {
  if (!box.open) return;
  if (e.key === 'ArrowRight') show(at + 1);
  if (e.key === 'ArrowLeft') show(at - 1);
});
document.querySelector('input').addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase();
  for (const card of document.querySelectorAll('figure')) card.hidden = !card.dataset.text.includes(query);
});
</script>
</body>
</html>
`;
}
