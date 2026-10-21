// Guided tour: press the Tour button (or open #/?tour). Arrow keys / Space move, Esc exits.
const STEPS = [
  { hash: '#/', sel: '.scope-copy', title: 'No proof, no fix', text: 'RedGreen turns a GitHub issue into a check that fails on your code.' },
  { hash: '#/', sel: '.split', title: 'Red first, green only if you want', text: 'A reproduction must fail the way the issue says. A fix counts only when that same check passes.' },
  { hash: '#/', sel: '.s4', title: 'How it works', text: 'Issue → clone and serve → Gemma 4 reads the code and the page → a real check runs.' },
  { hash: '#/reproduce', sel: '#ghIntro', title: 'Reproduce from the website', text: 'Paste any GitHub issue, for a website or a JavaScript project.' },
  { hash: '#/reproduce', sel: '#recent', title: 'Recent issues', text: 'Every issue you run is kept here.' },
  { hash: '#/github', sel: '.gh-hero', title: 'RedGreen for GitHub', text: 'Install it on any repo in one click, like any GitHub bot.' },
  { hash: '#/github', sel: '.steps2, .gh-cols', title: 'Trigger', text: 'Comment /redgreen or add the redgreen label. The bot replies with the proof.' },
  { hash: '#/github', sel: '.panel2, .switch', title: 'Reproduce only, by default', text: 'Fixes are opt-in. Nothing touches your code without you.' },
  { hash: '#/history', sel: 'main .pg, main', title: 'History', text: 'Every report and every run, red or green.' },
  { hash: '#/model', sel: '.choices', title: 'Gemma 4, your way', text: 'Local Gemma 4 E4B in LM Studio, or your own Gemma API key when deployed.' },
  { hash: '#/', sel: '.finale', title: 'Prove it', text: 'Open source, Apache 2.0. Proof first, then the fix.' },
];

let i = -1, ui, box;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function find(sel) {
  for (let t = 0; t < 30; t++) { const el = document.querySelector(sel); if (el && el.getBoundingClientRect().height) return el; await wait(100); }
  return document.querySelector('main');
}
function place(el) {
  const r = el.getBoundingClientRect(), pad = 10;
  const top = Math.max(70, r.top - pad), h = Math.min(innerHeight - top - 16, r.bottom + pad - top);
  Object.assign(box.style, { top: top + 'px', left: Math.max(6, r.left - pad) + 'px', width: Math.min(innerWidth - 12, r.width + pad * 2) + 'px', height: Math.max(40, h) + 'px' });
}
async function go(n) {
  if (n < 0 || n >= STEPS.length) return end();
  i = n; const s = STEPS[i];
  if (location.hash.replace(/\?.*/, '') !== s.hash) { location.hash = s.hash; await wait(450); }
  const el = await find(s.sel);
  const r0 = el.getBoundingClientRect(); const room = innerHeight - 90; scrollTo({ top: scrollY + r0.top - (r0.height < room ? (innerHeight - r0.height) / 2 : 90), behavior: 'instant' }); await wait(120); place(el);
  ui.querySelector('.tr-n').textContent = `${i + 1} / ${STEPS.length}`;
  ui.querySelector('.tr-t').textContent = s.title;
  ui.querySelector('.tr-p').textContent = s.text;
  ui.querySelector('.tr-next').textContent = i === STEPS.length - 1 ? 'Finish' : 'Next →';
  ui.querySelector('.tr-bar i').style.width = ((i + 1) / STEPS.length * 100) + '%';
  ui.classList.add('on'); box.classList.add('on');
}
function end() { i = -1; ui?.classList.remove('on'); box?.classList.remove('on'); }
function key(e) {
  if (i < 0) return;
  if (e.key === 'Escape') end();
  else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); go(i + 1); }
  else if (e.key === 'ArrowLeft') go(i - 1);
}
export function startTour() {
  if (!ui) {
    box = document.createElement('div'); box.className = 'tr-box';
    ui = document.createElement('div'); ui.className = 'tr-card';
    ui.innerHTML = `<div class="tr-bar"><i></i></div><span class="tr-n"></span><h3 class="tr-t"></h3><p class="tr-p"></p>
      <div class="tr-act"><button type="button" class="tr-skip">Exit</button><button type="button" class="tr-back">← Back</button><button type="button" class="tr-next">Next →</button></div>`;
    document.body.append(box, ui);
    ui.querySelector('.tr-next').onclick = () => go(i + 1);
    ui.querySelector('.tr-back').onclick = () => go(i - 1);
    ui.querySelector('.tr-skip').onclick = end;
    addEventListener('keydown', key);
    addEventListener('resize', () => { if (i >= 0) find(STEPS[i].sel).then(place); });
  }
  go(0);
}
