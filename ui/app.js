// RedGreen dashboard. Renders only what the server reports; never invents results.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const getJSON = (p) => fetch(p).then((r) => r.json());
const secs = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

let state = null;          // current view state
let tryFixSetting = false;
let lastStatus = null; // reproduce-only unless switched on in the Bot page
let running = false, tick = null;

/* ---------- tiny JS highlighter (tokenise raw, escape per token) ---------- */
const KW = /^(import|from|export|function|const|let|var|return|if|else|new|throw|true|false|null|undefined|for|of|await|async)$/;
function hl(code) {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const [t, c, s, n, f, w] = m;
    out += c ? `<span class="c">${esc(c)}</span>` : s ? `<span class="s">${esc(s)}</span>` : n ? `<span class="nm">${n}</span>`
      : f ? (KW.test(f) ? `<span class="k">${f}</span>` : `<span class="f">${esc(f)}</span>`) : KW.test(w) ? `<span class="k">${w}</span>` : esc(w);
    last = m.index + t.length;
  }
  return out + esc(code.slice(last));
}
const codeBlock = (c) => `<pre><code>${hl(String(c ?? '').trim())}</code></pre>`;
const diffBlock = (d, live) => { let n = 0; return `<pre class="diff${live ? ' live' : ''}"><code>${String(d).split('\n').map((l) => {
  const i = `style="--i:${n++}"`;
  if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('@@')) return `<span class="hd">${esc(l)}</span>`;
  if (l.startsWith('+')) return `<span class="add" ${i}>${esc(l)}</span>`;
  if (l.startsWith('-')) return `<span class="del" ${i}>${esc(l)}</span>`;
  return `<span>${esc(l)}</span>`;
}).join('')}</code></pre>`; };
const assertion = (out = '') => ({
  actual: (out.match(/actual:\s*([^\n,]+)/) || out.match(/Received:\s*([^\n]+)/))?.[1]?.trim(),
  expected: (out.match(/expected:\s*([^\n,]+)/) || out.match(/Expected:\s*([^\n]+)/))?.[1]?.trim(),
});

/* ---------- status badges ---------- */
async function loadStatus() {
  try {
    const s = await getJSON('/api/status');
    tryFixSetting = !!s.tryFix;
    const b = $('#modelBadge');
    if (s.model.ok) {
      b.className = 'badge on';
      b.innerHTML = `<i class="dot"></i><span><strong>${esc(prettyModel(s.model.model))}</strong> ${s.model.provider === 'gemini' ? 'via the Gemini API' : s.model.local ? 'running on this laptop' : 'on a remote endpoint'}</span>`;
      b.title = `${s.model.model} at ${s.model.baseUrl}`;
    } else {
      b.className = 'badge down';
      b.innerHTML = `<i class="dot"></i><span>Model not connected. <a href="#/model">Open model settings</a></span>`;
      b.title = s.model.error;
    }
    const iso = s.sandbox.permissionModel.startsWith('--');
    $('#sbxBadge').innerHTML = `<span>${iso ? 'Tests run sealed: read-only, no processes' : 'Tests run without file isolation'}, ${s.sandbox.timeoutMs / 1000} s limit</span>`;
    $('#sbxBadge').title = `Node ${s.sandbox.node}, ${s.sandbox.permissionModel}`;
    const bb = $('#botBadge');
    if (s.bot?.enabled) {
      bb.hidden = false; bb.className = 'badge ' + (s.bot.current ? 'on' : '');
      bb.innerHTML = s.bot.current ? `<i class="dot"></i><span>Bot working on <strong>${esc(s.bot.current.repo)}#${s.bot.current.number}</strong></span>` : `<i class="dot"></i><span>${s.bot.kind === 'app' ? `GitHub App live on ${s.bot.repos.length} ${s.bot.repos.length === 1 ? 'repo' : 'repos'}` : `Bot watching ${s.bot.repos.map(esc).join(', ')}`}</span>`;
      bb.title = `Label an issue "${s.bot.label}" or comment /redgreen`;
    } else bb.hidden = true;
    lastStatus = s;
    const sys = $('#sysBtn');
    sys.className = 'sys ' + (s.model.ok ? 'on' : s.model.checking ? '' : 'down');
    $('#sysTxt').textContent = s.model.ok ? `${prettyModel(s.model.model)} · ${s.model.provider === 'gemini' ? 'Gemini API' : s.model.local ? 'local' : 'remote'}` : s.model.checking ? 'Checking model' : 'Model offline';
    statusReady();
  } catch {
    $('#sysBtn').className = 'sys down'; $('#sysTxt').textContent = 'Server unreachable'; statusReady(); $('#modelBadge').className = 'badge down'; $('#modelBadge').innerHTML = '<i class="dot"></i><span>RedGreen server unreachable</span>'; }
}
function prettyModel(id) {
  const m = id.match(/gemma[-_ ]?(\d+)[-_ ]?([a-z]?\d+[a-z]?)?/i);
  return m ? `Gemma ${m[1]}${m[2] ? ' ' + m[2].toUpperCase() : ''}` : id;
}

/* ---------- sidebar ---------- */
const VERDICT = {
  fixed_verified: { pip: 'green', text: 'Fix verified' },
  reproduced: { pip: 'red', text: 'Reproduced' },
  reproduced_not_fixed: { pip: 'red', text: 'Reproduced, no verified fix' },
  not_reproduced: { pip: 'amber', text: 'Could not reproduce' },
};
async function loadLists() {
  if (!$('#reports') && !$('#recent')) return;
  const [reports, runs] = await Promise.all([getJSON('/api/reports'), getJSON('/api/runs')]);
  if ($('#recent')) {
    const gh = reports.filter((r) => r.kind === 'github').slice(0, 6);
    $('#recent').innerHTML = gh.length ? gh.map((r, i) => `<button class="icard" data-report="${esc(r.id)}" style="--i:${i}"><span class="irepo">${esc(r.repo)}</span><span class="ititle">${esc(r.description)}</span><span class="iwhen">Loaded ${clock(r.savedAt)}</span></button>`).join('') : '<p class="muted">Issues you reproduce will show up here.</p>';
  }
  if (!$('#reports')) return;
  $('#reports').innerHTML = reports.length ? reports.map((r) => `<li><button data-report="${esc(r.id)}" aria-current="${state?.report?.id === r.id && !state.savedRun}">
      <i class="pip ${r.kind === 'github' ? 'gh' : 'ink'}"></i><span><span class="t">${esc(r.description)}</span><span class="m">${r.kind === 'github' ? esc(r.repo) : `${r.sample ? 'Scripted sample' : clock(r.savedAt)}, ${r.events} events${r.screenshot ? ', screenshot' : ''}`}</span></span></button></li>`).join('')
    : '<li class="empty">No reports yet. Use the demo shop and press “Report bug”.</li>';
  $('#runs').innerHTML = runs.length ? runs.slice(0, 12).map((r) => `<li><button data-run="${esc(r.id)}" aria-current="${state?.savedRun === r.id}">
      <i class="pip ${VERDICT[r.verdict]?.pip || ''}"></i><span><span class="t">${VERDICT[r.verdict]?.text || esc(r.verdict)}</span><span class="m">${clock(r.startedAt)}</span></span></button></li>`).join('')
    : '<li class="empty">No runs yet.</li>';
}
document.addEventListener('click', (e) => {
  if (running) return;
  const r = e.target.closest('[data-report]'); if (r) return openReport(r.dataset.report);
  const run = e.target.closest('[data-run]'); if (run) return openRun(run.dataset.run);
});

/* ---------- GitHub issues ---------- */
async function loadIssue(form) {
  const input = form.querySelector('input'), err = form.querySelector('.gherr'), btn = form.querySelector('button');
  err.textContent = ''; btn.disabled = true; btn.textContent = 'Loading';
  try {
    const r = await fetch('/api/issues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: input.value }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    input.value = '';
    await openReport(j.id);
    if (form.id === 'ghIntro') setTimeout(() => analyze(j.id), 400); // "Reproduce it" starts right away
  } catch (e) { err.textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = form.id === 'ghSide' ? 'Load' : 'Reproduce it'; }
}
document.addEventListener('submit', (e) => { const f = e.target.closest('.ghform'); if (f) { e.preventDefault(); if (!running) loadIssue(f); } });

/* ---------- views ---------- */
function setTab(name) {
  if (name !== 'home') { document.body.classList.remove('on-home'); scopeStop?.(); scopeStop = null; } document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name)); }

let scopeStop = null;
function home() {
  setTab('home');
  document.body.classList.add('on-home');
  $('#main').innerHTML = `<section class="h4">
    <div class="scope">
      <canvas id="scopeCv" aria-hidden="true"></canvas>
      <div class="scope-ui" aria-hidden="true"><span>CH1 · issue</span><span>CH2 · your code</span></div>
      <div class="scope-copy">
        <h1 class="mega"><span class="ln r" data-t="NO PROOF,">NO PROOF,</span><span class="ln g" data-t="NO FIX.">NO FIX.</span></h1>
        <p class="tag4">RedGreen turns a GitHub issue into a <b>check that fails on your code</b>. Gemma 4 writes it. Your machine proves it.</p>
        <div class="ctas"><a class="btn4 hot magnet" href="#/reproduce"><span>Reproduce an issue</span></a><a class="btn4 magnet" href="#/github"><span>Add to GitHub</span></a></div>
      </div>
      <div class="scroll-hint" aria-hidden="true">scroll</div>
    </div>


    <div class="split">
      <a class="half red" href="#/reproduce"><span class="k">CH1</span><b>FAILS</b><p>on the code as it is. Expected <i>3 results</i>, got <i>0</i>. Only a failure that matches the issue counts.</p><span class="go4">Reproduce →</span></a>
      <a class="half green" href="#/github"><span class="k">CH2</span><b>PASSES</b><p>only when a fix makes that same check pass and nothing else breaks. Optional, and never pushed without you.</p><span class="go4">Configure →</span></a>
    </div>

    <div class="story s4">
      <div class="story-text">
        <article data-step="1"><span class="sn3">01 / ISSUE</span><h2>“The total is wrong.”</h2><p>A maintainer comments <code>/redgreen</code> or adds the <code>redgreen</code> label. That's the whole setup.</p></article>
        <article data-step="2"><span class="sn3">02 / FIND</span><h2>Clone. Serve. Search.</h2><p>RedGreen clones the repo, runs the site or its tests, and picks the files the issue is about with keyword search you can see.</p></article>
        <article data-step="3"><span class="sn3">03 / READ</span><h2>Gemma 4 looks at it.</h2><p>The issue, the code, and a real screenshot of the page. It writes browser steps or a test. Issue text is data, never instructions.</p></article>
        <article data-step="4"><span class="sn3 red">04 / PROVE</span><h2>Red, or it didn't happen.</h2><p>The check runs for real and must fail the way the issue says. Then the proof lands on the issue: steps, real output, where to look.</p></article>
      </div>
    </div>

    <div class="finale">
      <h2 class="mega2">PROVE&nbsp;IT.</h2>
      <p>Install RedGreen on your repos. Gemma 4 on your laptop, or your own Gemini API key.</p>
      <div class="ctas"><a class="btn4 hot magnet" href="#/github"><span>Set up the GitHub app</span></a><a class="btn4 magnet" href="#/model"><span>Bring your own key</span></a></div>
      <footer class="foot4"><span>Open source · Apache-2.0</span><a href="https://github.com/samvit-srivastava/redgreen" target="_blank" rel="noopener">github.com/samvit-srivastava/redgreen</a></footer>
    </div>
  </section>`;
  const vis = $('#vis') || {dataset:{}};
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { vis.dataset.stage = e.target.dataset.step; document.querySelectorAll('.story-text article').forEach((a) => a.classList.toggle('on', a === e.target)); } }), { rootMargin: '-45% 0px -45% 0px' });
  document.querySelectorAll('.story-text article').forEach((a) => io.observe(a));
  document.querySelectorAll('.magnet').forEach((b) => {
    b.addEventListener('pointermove', (e) => { const r = b.getBoundingClientRect(); b.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * 0.2}px, ${(e.clientY - r.top - r.height / 2) * 0.3}px)`; });
    b.addEventListener('pointerleave', () => { b.style.transform = ''; });
  });
  scopeStop?.(); scopeStop = runScope($('#scopeCv'));
}

function tickerLines() {
  return ['✗ expect .result count 3 · actual 0', '✓ repo cloned, site served', '✓ existing tests pass, they do not catch this bug', '✗ AssertionError: 0 !== 3', '✓ Gemma 4 E4B · local', '✓ search.js · index.html · articles.json', '✗ Reproduced in a real browser', '✓ patch verified: same check passes']
    .map((t) => `<span class="${t[0] === '✗' ? 'r' : 'g'}">${esc(t)}</span>`).join('');
}

// Oscilloscope: phosphor trace sweeping a grid; the pointer bends the signal. Red until the beam has "proof".
function runScope(cv) {
  if (!cv) return () => {};
  const ctx = cv.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w, h, dpr, raf, t = 0, mx = 0.5, my = 0.5;
  const trail = [];
  const resize = () => { dpr = Math.min(2, devicePixelRatio || 1); w = cv.clientWidth; h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  const onMove = (e) => { const r = cv.getBoundingClientRect(); mx = (e.clientX - r.left) / r.width; my = (e.clientY - r.top) / r.height; };
  resize(); addEventListener('resize', resize); cv.parentElement.addEventListener('pointermove', onMove);
  const sig = (x, k) => {
    const base = Math.sin(x * 9 + k * 2) * 0.18 + Math.sin(x * 23 - k * 3) * 0.06;
    const bump = Math.exp(-Math.pow((x - mx) * 7, 2)) * (my - 0.5) * 1.6;           // pointer bends the wave
    const glitch = -Math.exp(-Math.pow((x - 0.62) * 22, 2)) * 0.22;                     // the bug: one clean dip
    return base + bump + glitch;
  };
  const frame = () => {
    t += 0.016;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(120,160,190,0.07)'; ctx.lineWidth = 1;
    const gx = w / 12, gy = h / 8;
    ctx.beginPath(); for (let i = 1; i < 12; i++) { ctx.moveTo(i * gx, 0); ctx.lineTo(i * gx, h); } for (let j = 1; j < 8; j++) { ctx.moveTo(0, j * gy); ctx.lineTo(w, j * gy); } ctx.stroke();
    const sweep = (t * 0.22) % 1.15;
    const proven = sweep > 1.0;
    const col = proven ? '47,214,124' : '255,91,75';
    ctx.lineWidth = 2.4; ctx.shadowBlur = 18; ctx.shadowColor = `rgba(${col},0.9)`; ctx.strokeStyle = `rgba(${col},0.95)`;
    ctx.beginPath();
    const end = Math.min(1, sweep);
    for (let x = 0; x <= end; x += 0.003) { const y = h * (0.5 + sig(x, t) * 0.55); x === 0 ? ctx.moveTo(x * w, y) : ctx.lineTo(x * w, y); }
    ctx.stroke(); ctx.shadowBlur = 0;
    const bx = end * w, by = h * (0.5 + sig(end, t) * 0.55);
    ctx.fillStyle = `rgba(${col},1)`; ctx.beginPath(); ctx.arc(bx, by, 4, 0, 6.3); ctx.fill();
    raf = requestAnimationFrame(frame);
  };
  if (reduce) { frame(); cancelAnimationFrame(raf); } else frame();
  return () => { cancelAnimationFrame(raf); removeEventListener('resize', resize); };
}

function replayCard() {
  return `<figure class="replay" aria-label="A real exchange on GitHub: an issue, then RedGreen's reply">
    <div class="gh-card issue-card">
      <div class="gh-head"><span class="state">Open</span><b>Search finds nothing when the query has a capital letter</b></div>
      <p>Search for "Dark Mode". Expected <b>3 results</b>, the page shows <b>No results</b>.</p>
      <div class="cmt"><span class="who">maintainer</span> commented <code>/redgreen</code></div>
    </div>
    <div class="gh-card bot-card">
      <div class="gh-head"><span class="avatar"><i class="l r"></i><i class="l g"></i></span><b>redgreen</b><span class="botpill">bot</span></div>
      <h3><i class="dotred"></i>Reproduced</h3>
      <pre class="mini"><span class="ok">✓ open /help</span><span class="ok">✓ type "Dark Mode" into #search</span><span class="bad">✗ expect .result count to be 3</span><span class="bad">   actual: 0</span></pre>
      <p class="small where">Where to look: <code>search.js</code> · <code>matchArticle()</code></p>
    </div>
    <figcaption>Example of what RedGreen posts on an issue</figcaption>
  </figure>`;
}

function reproducePage() {
  setTab('reproduce');
  $('#main').innerHTML = `<section class="pg repro2">
    <h1 class="pg-h">Reproduce a bug</h1>
    <p class="pg-sub">Paste an issue from a website or JavaScript project. RedGreen clones it, Gemma 4 writes a check, and it only counts if the check fails.</p>
    <form class="ghform huge" id="ghIntro">
      <label for="ghUrlIntro" class="sr">GitHub issue URL</label>
      <div class="ghrow"><input id="ghUrlIntro" type="url" placeholder="https://github.com/owner/repo/issues/1" required autofocus><button type="submit">Reproduce it</button></div>
      <p class="gherr" role="alert"></p>
    </form>
    <h2 class="sec-h">Recent issues</h2>
    <div class="icards" id="recent"></div>
  </section>`;
  loadLists();
}

async function modelPage() {
  setTab('');
  const m = await getJSON('/api/model');
  const st = m.status || {};
  $('#main').innerHTML = `<section class="pg model2">
    <h1 class="pg-h">Model</h1>
    <p class="pg-sub">RedGreen uses Gemma 4. Run it on this computer with LM Studio, or bring your own Google AI Studio key to use Gemma 4 through the Gemini API (that's how a deployed RedGreen works).</p>
    <div class="mnow ${st.ok ? 'ok' : 'bad'}"><i></i><span>${st.ok ? `Using <b>${esc(st.model)}</b> ${st.provider === 'gemini' ? 'through the Gemini API' : 'on this computer'}` : esc(st.error || 'Not connected')}</span></div>
    <div class="choices">
      <label class="choice ${m.provider === 'lmstudio' ? 'sel' : ''}"><input type="radio" name="prov" value="lmstudio" ${m.provider === 'lmstudio' ? 'checked' : ''}>
        <b>On this computer</b><span>LM Studio with Gemma 4 loaded. Private and free; code never leaves the machine.</span>
        <input id="baseUrl" class="field" value="${esc(m.baseUrl || 'http://localhost:1234/v1')}" aria-label="LM Studio server URL"></label>
      <label class="choice ${m.provider === 'gemini' ? 'sel' : ''}"><input type="radio" name="prov" value="gemini" ${m.provider === 'gemini' ? 'checked' : ''}>
        <b>Gemini API</b><span>Your own key from <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>. Stored only on this server, never shown again.</span>
        <select id="gModel" class="field">${m.geminiModels.map((x) => `<option ${x === m.geminiModel ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <input id="gKey" class="field" type="password" autocomplete="off" placeholder="${m.hasGeminiKey ? 'Key saved. Paste a new one to replace it' : 'Paste your API key'}">
        ${m.hasGeminiKey ? '<button type="button" class="btn small" id="rmKey">Remove saved key</button>' : ''}</label>
    </div>
    <button class="cta-main" id="saveModel" type="button">Save</button>
    <p class="gherr" id="modelErr"></p>
  </section>`;
  document.querySelectorAll('input[name=prov]').forEach((r) => r.addEventListener('change', () => document.querySelectorAll('.choice').forEach((c) => c.classList.toggle('sel', c.contains(document.querySelector('input[name=prov]:checked'))))));
  const save = async (extra = {}) => {
    const btn = $('#saveModel'); btn.disabled = true; btn.textContent = 'Checking';
    const body = { provider: document.querySelector('input[name=prov]:checked').value, geminiModel: $('#gModel').value, baseUrl: $('#baseUrl').value, ...extra };
    if ($('#gKey').value) body.geminiKey = $('#gKey').value;
    const r = await fetch('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json();
    btn.disabled = false; btn.textContent = 'Save';
    if (!r.ok) { $('#modelErr').textContent = j.error; return; }
    loadStatus(); modelPage();
  };
  $('#saveModel').addEventListener('click', () => save());
  $('#rmKey')?.addEventListener('click', () => save({ removeKey: true }));
}

function historyPage() {
  setTab('history');
  $('#main').innerHTML = `<section class="pg hist2">
    <h1 class="pg-h">History</h1>
    <div class="hcols">
      <section><h2 class="sec-h">Issues and reports</h2><ul id="reports" class="list big"></ul></section>
      <section><h2 class="sec-h">Runs</h2><ul id="runs" class="list big"></ul></section>
    </div>
  </section>`;
  loadLists();
}

function shell(report, savedRun) {
  state = { report, savedRun, stages: {}, live: null, steps: [], tryFix: tryFixSetting };
  const gh = report.kind === 'github';
  const when = report.sample ? 'Scripted sample' : `Reported at ${clock(report.savedAt)}`;
  const metaLine = gh
    ? `<a href="${esc(report.issue.url)}" target="_blank" rel="noopener">${esc(report.repo.owner)}/${esc(report.repo.repo)} issue #${report.repo.number}</a>, opened by ${esc(report.issue.author || 'unknown')}. Loaded at ${clock(report.savedAt)}.${savedRun ? ` Showing a saved run from ${clock(savedRun.startedAt)}.` : ''}`
    : null;
  $('#main').innerHTML = `
  <div class="rhead">
    <div><p class="quote">${esc(report.description)}</p>
      <p class="rmeta">${gh ? metaLine : `${when} with ${report.events.length} captured events${report.screenshot ? ' and a screenshot' : ''}. ${report.redactions} private ${report.redactions === 1 ? 'value' : 'values'} removed before saving.${savedRun ? ` Showing a saved run from ${clock(savedRun.startedAt)}.` : ''}`}</p></div>
    ${savedRun ? `<button class="go" id="go" data-again="1">Run again</button>` : `<button class="go" id="go"><span class="lamps" aria-hidden="true"><i class="l r"></i><i class="l g"></i></span>${state.tryFix ? 'Reproduce and fix' : 'Reproduce'}</button>`}
  </div>
  <div id="notice"></div>
  <section class="proof" id="proof" aria-live="polite">
    <div class="side-p" id="pRed"><div class="lamp"></div><div class="cap">On the code as it is</div><div class="verdictword">Waiting</div><div class="fact">Gemma's check must fail here.</div></div>
    <div class="wire" aria-hidden="true"><svg viewBox="0 0 84 28" preserveAspectRatio="none"><path class="base" d="M4 14 H70"/><path class="flow" d="M4 14 H70"/><path class="head" d="M66 5 L80 14 L66 23 Z"/></svg></div>
    <div class="side-p" id="pGreen"><div class="lamp"></div><div class="cap">${state.tryFix === false ? 'Where to look' : "After Gemma's patch"}</div><div class="verdictword">Waiting</div><div class="fact">${state.tryFix === false ? 'Found after the bug is reproduced.' : 'The same test must pass here.'}</div></div>
  </section>
  <ol class="track" id="track">
    ${[gh ? 'Clone and search' : 'Evidence', gh ? 'Repo tests' : 'Existing tests', 'Reproduce', state.tryFix ? 'Patch' : 'Where to look', state.tryFix ? 'Verify' : 'Report'].map((l, i) => `<li data-k="${i}"><span class="n">${i + 1}</span><span class="lbl">${l}</span><span class="tm">&nbsp;</span></li>`).join('')}
  </ol>
  <div class="cols">
    <div>
      ${gh ? `<section class="sect"><h3>The issue <small>untrusted text, read as data</small></h3><div class="body issue">${esc(report.issue.body || '(no description)')}</div></section>
      <section class="sect" id="pageSect" hidden><h3>The live page <small>Gemma 4 sees this screenshot</small></h3><div class="body shot"><img id="pageShot" alt="Screenshot of the site as cloned from GitHub"></div></section>
      <section class="sect"><h3>Files Gemma will read <small>chosen by keyword search, not AI</small></h3><ol class="files" id="files"><li class="empty">Found after the repo is cloned.</li></ol></section>` : `<section class="sect"><h3>What the user did <small>captured, private values removed</small></h3><ol class="tl" id="tl">${timeline(report)}</ol>
        ${report.screenshot ? `<div class="body shot"><p>Screenshot the user attached. Gemma 4 reads it.</p><img src="${report.screenshot}" alt="Screenshot attached to the bug report"></div>` : ''}</section>`}
      <section class="sect" id="hypSect" hidden><h3>Gemma's diagnosis</h3><div class="body hyp" id="hyp"></div></section>
    </div>
    <div>
      <section class="sect" id="outSect" hidden><h3 id="outTitle">Verified fix</h3><div class="body out" id="out"></div></section>
      <section class="sect"><h3>What Gemma tried <small>every result below is a real test run</small></h3><ol class="att" id="att"><li><i class="mk"></i><div><h4>Not started</h4><p class="sub">Press “${state.tryFix ? 'Reproduce and fix' : 'Reproduce'}” to begin.</p></div></li></ol></section>
    </div>
  </div>`;
  $('#go').addEventListener('click', () => analyze(report.id));
  loadLists();
}

function timeline(report, cited = []) {
  return report.events.map((e) => {
    const bad = e.type !== 'action';
    let what = '';
    if (e.type === 'action') {
      const args = (e.args || []).map((a) => typeof a === 'object' ? (a.name || a.id || '{…}') : JSON.stringify(a)).join(', ');
      const st = e.stateAfter || {};
      what = `<code>${esc(e.name)}(${esc(args)})</code><div class="st">${st.error ? 'Error: ' + esc(st.error) : `Total after: <b>$${Number(st.total).toFixed(2)}</b>${st.discount ? `, discount $${Number(st.discount).toFixed(2)}` : ''}`}</div>`;
    } else if (e.type === 'network.failed') {
      let msg = e.responseBody || e.error || ''; try { msg = JSON.parse(msg).error || msg; } catch {}
      what = `Request failed: <code>${esc(e.method)} ${esc(new URL(e.url, location.href).pathname)}</code> returned ${e.status}<div class="st">${esc(msg).slice(0, 180)}</div>`;
    } else what = `${e.type === 'uncaught' ? 'Crash' : 'Console error'}: ${esc(e.message)}`;
    const c = cited.includes(e.id);
    return `<li class="${bad ? 'bad' : ''} ${c ? 'cited' : ''}"><span class="at">${(e.t_ms / 1000).toFixed(1)}s</span><i class="nd"></i><div class="what">${what}${c ? '<span class="cite">cited by Gemma</span>' : ''}</div></li>`;
  }).join('');
}

/* ---------- proof bar + track ---------- */
function setPanel(id, cls, word, fact, ignite) {
  const p = $(id); if (!p) return;
  p.className = 'side-p ' + cls + (ignite ? ' ignite' : '');
  $('.verdictword', p).textContent = word;
  $('.fact', p).innerHTML = fact;
  $('#proof').classList.toggle('has-red', $('#pRed').classList.contains('red'));
  $('#proof').classList.toggle('has-green', $('#pGreen').classList.contains('green'));
}
function stage(k, cls, tm) {
  const li = $(`#track [data-k="${k}"]`); if (!li) return;
  li.className = cls;
  if (tm !== undefined) $('.tm', li).textContent = tm;
}
function addTime(k, ms) { state.stages[k] = (state.stages[k] || 0) + ms; stage(k, $(`#track [data-k="${k}"]`).className, secs(state.stages[k])); }

/* ---------- step rendering ---------- */
let liveMode = false;
function attempt(html) {
  const att = $('#att'); if (att.dataset.started !== '1') { att.innerHTML = ''; att.dataset.started = '1'; }
  $('#liveAtt')?.remove(); att.insertAdjacentHTML('beforeend', html);
  if (liveMode) att.lastElementChild.classList.add('enter');
}
const chip = (r) => `<span class="chip ${r.passed ? 'pass' : 'fail'}"><b>${r.passed ? 'PASS' : 'FAIL'}</b>${esc(r.file.replace('test/', ''))}${r.file === 'browser steps' || r.file === 'repo tests' ? '' : `, ${r.pass} passed, ${r.fail} failed`}</span>`;
const outBlock = (r, label = 'Test output') => `<details><summary>${label}</summary><pre>${esc(r.output.trim())}</pre></details>`;

function render(s, live) {
  liveMode = live;
  switch (s.type) {
    case 'evidence': stage(0, 'done', 'ready'); break;
    case 'prepare':
      if (s.stage === 'ready') { stage(0, 'done', secs(s.durationMs || 0)); attempt(`<li><i class="mk info"></i><div><h4>Repo ready</h4><p class="sub">${esc(s.note)}${s.sha ? `, commit ${esc(s.sha)}` : ''}</p></div></li>`); }
      else { stage(0, 'now', s.stage === 'install' ? 'installing' : 'cloning'); attempt(`<li id="liveAtt"><i class="mk live"></i><div><h4>${esc(s.note)}</h4><p class="sub">${s.stage === 'install' ? 'npm, with install scripts turned off' : 'shallow clone from GitHub'}</p></div></li>`); }
      break;
    case 'page':
      if ($('#pageSect')) { $('#pageSect').hidden = false; $('#pageShot').src = s.screenshot; if (live) $('#pageSect').classList.add('reveal'); }
      break;
    case 'located':
      state.files = s.files;
      $('#files').innerHTML = s.files.map((f, i) => `<li style="--i:${i}"><div class="fp"><code>${esc(f.path)}</code><span class="sc">${f.lines} lines</span></div><div class="tags">${f.terms.map((t) => `<span>${esc(t)}</span>`).join('')}</div></li>`).join('');
      if (live) $('#files').classList.add('live');
      break;
    case 'baseline':
      if (s.none) { stage(1, 'done', 'none'); attempt(`<li><i class="mk info"></i><div><h4>No automated tests in this repo</h4><p class="sub">The browser check is the proof.</p></div></li>`); break; }
      stage(1, s.result.passed ? 'done' : 'red', secs(s.result.durationMs));
      attempt(`<li><i class="mk ${s.result.passed ? 'info' : 'fail'}"></i><div><h4>${s.result.passed ? (s.result.pass ? `${state.report.kind === 'github' ? 'The repo\'s' : 'Your'} ${s.result.pass} existing tests pass` : 'The existing tests pass') : 'The existing tests already fail'}</h4>
        <p class="sub">${s.result.passed ? 'So they do not catch this bug.' : 'Fix those first; results below may be unreliable.'}</p><div class="res">${chip(s.result)}</div>${outBlock(s.result)}</div></li>`);
      break;
    case 'model.start': {
      const k = s.phase === 'reproduce' ? 2 : 3;
      stage(k, 'now');
      if (s.phase === 'reproduce') setPanel('#pRed', 'busy', 'Writing', `Gemma is writing a test from the evidence <span class="tick" id="tick">0 s</span>`);
      else $('#proof').classList.add('flowing'), setPanel('#pGreen', 'busy', 'Patching', `Gemma is rewriting the code <span class="tick" id="tick">0 s</span>`);
      if (live) {
        const t0 = Date.now(); clearInterval(tick);
        tick = setInterval(() => { const el = $('#tick'); if (el) el.textContent = Math.round((Date.now() - t0) / 1000) + ' s'; }, 250);
        attempt(`<li id="liveAtt"><i class="mk live"></i><div><h4>${s.phase === 'reproduce' ? 'Writing a reproduction test' : 'Proposing a patch'}</h4><p class="sub">Attempt ${s.attempt} of 3, on this laptop</p></div></li>`);
      }
      break; }
    case 'model.error':
      clearInterval(tick);
      attempt(`<li><i class="mk fail"></i><div><h4>Model error</h4><p class="why">${esc(s.error)}</p></div></li>`);
      break;
    case 'repro.rejected':
      clearInterval(tick); addTime(2, s.durationMs || 0);
      attempt(`<li><i class="mk warn"></i><div><h4>Test rejected</h4><p class="sub">Attempt ${s.attempt}, ${secs(s.durationMs || 0)}</p><p class="why">${esc(s.reason)}</p>${s.result ? `<div class="res">${chip(s.result)}</div>` : ''}<details><summary>${s.proposal?.steps ? "Gemma's browser steps" : "Gemma's test"}</summary>${proposalBody(s.proposal, s.result?.assertionFailure?.step)}</details></div></li>`);
      break;
    case 'repro.confirmed': {
      clearInterval(tick); addTime(2, s.durationMs || 0); stage(2, 'red');
      const af = s.result.assertionFailure;
      const a = af ? { expected: (s.proposal.steps?.[af.step - 1]?.value) || af.expected, actual: String(af.actual).replace(/^"|"$/g, '') } : assertion(s.result.output);
      setPanel('#pRed', 'red', 'Fails', a.expected ? `Expected <b>${esc(money(a.expected))}</b>, got <b>${esc(money(a.actual))}</b>. Bug reproduced.` : 'Bug reproduced by a failing test.', live);
      attempt(`<li><i class="mk fail"></i><div><h4>${s.proposal.steps ? 'Bug reproduced in a real browser' : 'Bug reproduced: the test fails on your code'}</h4><p class="sub">Attempt ${s.attempt}, ${secs(s.durationMs)}</p><div class="res">${chip(s.result)}</div>
        <details open><summary>${s.proposal.steps ? 'Browser steps, written by Gemma and run by RedGreen' : 'Reproduction test, written by Gemma'}</summary>${proposalBody(s.proposal, af?.step)}</details>${outBlock(s.result, s.proposal.steps ? 'Browser run log' : 'Failure output')}</div></li>`);
      if (s.result.screenshot && $('#pageShot')) { state.failShot = s.result.screenshot; }
      state.cause = s.proposal.hypothesis;
      $('#hypSect').hidden = false;
      $('#hyp').innerHTML = `<p>${esc(s.proposal.hypothesis)}</p><dl class="ev"><dt>Expected</dt><dd class="exp">${esc(s.proposal.expected)}</dd><dt>Actual</dt><dd class="act">${esc(s.proposal.actual)}</dd><dt>Evidence</dt><dd>${(s.proposal.evidence_ids || []).map((x) => state.report.kind === 'github' ? `“${esc(x)}”` : esc(x)).join(', ') || 'none cited'}</dd></dl>`;
      if ($('#tl')) $('#tl').innerHTML = timeline(state.report, s.proposal.evidence_ids || []);
      if (live && $('#tl')) { $('#tl').classList.add('live'); [...$('#tl').querySelectorAll('li.cited')].forEach((li, i) => li.style.setProperty('--i', i)); }
      if (live) $('#hypSect').classList.add('reveal');
      break; }
    case 'fix.rejected':
      clearInterval(tick); addTime(3, s.durationMs || 0);
      for (const r of s.results || []) addTime(4, r.durationMs);
      attempt(`<li><i class="mk warn"></i><div><h4>Patch rejected</h4><p class="sub">Attempt ${s.attempt}, ${secs(s.durationMs || 0)}</p><p class="why">${esc(s.reason)}</p>${(s.results || []).length ? `<div class="res">${s.results.map(chip).join('')}</div>` : ''}${s.diff ? `<details><summary>Rejected change</summary>${diffBlock(s.diff)}</details>` : ''}</div></li>`);
      break;
    case 'fix.verified': {
      clearInterval(tick); addTime(3, s.durationMs || 0); stage(3, 'done');
      for (const r of s.results) addTime(4, r.durationMs);
      stage(4, 'green');
      const existing = s.results[1];
      $('#proof').classList.remove('flowing');
      const sameWhat = s.results[0].file === 'browser steps' ? 'Same browser check passes.' : 'Same test passes.';
      setPanel('#pGreen', 'green', 'Passes', !existing ? `${sameWhat} This repo has no other tests to run.` : `${sameWhat} ${existing.note ? 'No new failures in the repo\'s tests.' : existing.pass ? `All ${existing.pass} existing tests still pass.` : 'The existing tests still pass.'}`, live);
      if (live) { const p = $('#proof'); p.classList.remove('celebrate'); void p.offsetWidth; p.classList.add('celebrate'); }
      attempt(`<li><i class="mk ok"></i><div><h4>Patch verified</h4><p class="sub">Attempt ${s.attempt}, ${secs(s.durationMs)}</p><div class="res">${s.results.map(chip).join('')}</div>${outBlock(s.results[0], 'Passing output')}</div></li>`);
      state.verified = s;
      if (s.before && s.after) state.shots = { before: s.before, after: s.after };
      break; }
    case 'fatal':
      clearInterval(tick);
      $('#notice').innerHTML = `<div class="notice err">${esc(s.error)}</div>`;
      break;
  }
}
const stepText = (st) => {
  const t = st.target ? `<code>${esc(st.target)}</code>` : '';
  const v = st.value ? `<b>${esc(st.value)}</b>` : '';
  return ({ goto: `Open ${v || 'the page'}`, click: `Click ${t}`, fill: `Type ${v} into ${t}`, select: `Choose ${v} in ${t}`, press: `Press ${v}`, wait: `Wait ${v} ms`,
    expect_text: `Expect ${t || 'the page'} to show ${v}`, expect_value: `Expect ${t} to equal ${v}`, expect_visible: `Expect ${t} to be visible`, expect_hidden: `Expect ${t} to be hidden`,
    expect_count: `Expect ${v} of ${t}`, expect_no_errors: 'Expect no JavaScript errors' })[st.action] || esc(st.action);
};
const stepsBlock = (steps, failedAt) => `<ol class="steps">${steps.map((st, i) => `<li class="${st.action.startsWith('expect') ? 'ex' : ''} ${failedAt === i + 1 ? 'bad' : ''}">${stepText(st)}</li>`).join('')}</ol>`;
const proposalBody = (p, failedAt) => p?.steps ? stepsBlock(p.steps, failedAt) : codeBlock(p?.test_code);
const money = (v) => /^-?\d+(\.\d+)?$/.test(v) ? '$' + Number(v).toFixed(2) : v;

function finish(verdict, runId) {
  clearInterval(tick); $('#proof')?.classList.remove('flowing');
  if (verdict === 'not_reproduced') {
    stage(2, 'red');
    setPanel('#pRed', 'amber', 'Unproven', 'No test failed for the reported reason. Nothing was changed.');
    setPanel('#pGreen', '', 'Skipped', 'No patch without a failing test.');
  } else if (verdict === 'reproduced') {
    stage(3, 'done', state.files?.length ? `${state.files.length} files` : 'done'); stage(4, 'done', 'ready');
    const where = (state.files || []).slice(0, 2).map((f) => `<code>${esc(f.path)}</code>`).join(' and ');
    $('#pGreen .cap').textContent = 'Where to look';
    setPanel('#pGreen', 'amber', 'Located', `${where ? `Start in ${where}. ` : ''}${state.cause ? esc(state.cause).slice(0, 180) : 'See the diagnosis below.'}`, true);
  } else if (verdict === 'reproduced_not_fixed') {
    setPanel('#pGreen', 'amber', 'No fix', 'No patch passed. Your code is unchanged.');
  }
  if (runId) showOutcome(runId, verdict);
  loadLists();
}

async function showOutcome(runId, verdict) {
  const md = await fetch(`/api/runs/${runId}/pr.md`).then((r) => r.text());
  const v = state.verified;
  const sect = $('#outSect'); sect.hidden = false; sect.classList.add('reveal');
  $('#outTitle').textContent = v ? 'Verified fix' : verdict === 'reproduced' ? 'Bug report with proof' : 'Report for the maintainer';
  const patch = v ? `${v.diff}\n` : '';
  $('#out').innerHTML = `
    ${state.shots ? `<div class="ba"><figure><img src="${state.shots.before}" alt="The page before the patch, with the bug"><figcaption><i class="pip red"></i>Before the patch</figcaption></figure><figure><img src="${state.shots.after}" alt="The page after the patch"><figcaption><i class="pip green"></i>After the patch</figcaption></figure></div>` : ''}
    ${v ? `<p class="change"><b>What changed:</b> ${esc((v.proposal.change && v.proposal.change.length < 180 && !/[{};]\s*\S/.test(v.proposal.change)) ? v.proposal.change : (v.proposal.root_cause || v.proposal.change || '').slice(0, 400))}</p>${diffBlock(v.diff, true)}` : (verdict === 'reproduced' ? '<p>The bug is proven by a failing check. RedGreen did not change any code; the report below has the check, where to look, and the real output, ready for a developer.</p>' : '<p>The bug is reproduced by a failing test, but no patch was verified. The report below includes the test so a person can take it from here.</p>')}
    <div class="actions" style="margin-top:12px">
      <button class="btn" id="copyPr">${v ? 'Copy PR description' : 'Copy report'}</button>
      <a class="btn" href="/api/runs/${esc(runId)}/pr.md" download="redgreen-${esc(runId)}.md">Download report</a>
      ${v ? `<a class="btn" id="dlPatch" download="redgreen-${esc(runId)}.diff">Download patch</a>` : ''}
      ${state.report.kind === 'github' ? `<button class="btn" id="postGh">Post result to the GitHub issue</button>` : ''}
    </div>
    <details><summary>Preview PR description</summary><pre>${esc(md)}</pre></details>`;
  $('#postGh')?.addEventListener('click', async (e) => {
    const btn = e.target; btn.disabled = true; btn.textContent = 'Posting';
    const r = await fetch(`/api/bot/post/${runId}`, { method: 'POST' }); const j = await r.json();
    if (r.ok) { btn.outerHTML = `<a class="btn" href="${esc(j.url)}" target="_blank" rel="noopener">Posted. View on GitHub</a>`; } else { btn.disabled = false; btn.textContent = 'Post result to the GitHub issue'; $('#notice').innerHTML = `<div class="notice err">${esc(j.error)}</div>`; }
  });
  $('#copyPr').onclick = () => navigator.clipboard.writeText(md).then(() => { $('#copyPr').textContent = 'Copied'; });
  if (v) $('#dlPatch').href = URL.createObjectURL(new Blob([patch], { type: 'text/x-diff' }));
}

/* ---------- actions ---------- */
const swap = (fn) => {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve(fn());
  const t = document.startViewTransition(fn);
  t.finished.catch(() => {}); t.ready.catch(() => {}); // a newer click can skip this transition; that's fine
  return t.updateCallbackDone;
};
async function openReport(id, push = true) { const r = await getJSON('/api/reports/' + encodeURIComponent(id)); if (push) history.pushState(null, '', '#/report/' + id); setTab(r.kind === 'github' ? 'reproduce' : 'history'); await swap(() => shell(r, null)); }
async function openRun(id, push = true) {
  const run = await getJSON('/api/runs/' + encodeURIComponent(id));
  if (push) history.pushState(null, '', '#/run/' + id); setTab('history');
  const report = await getJSON('/api/reports/' + encodeURIComponent(run.reportId));
  await swap(() => shell(report, { id: run.id, startedAt: run.startedAt }));
  state.savedRun = run.id;
  for (const s of run.steps) render(s, false);
  finish(run.verdict, run.id);
}
function analyze(id) {
  if (running) return;
  shell(state.report, null); // fresh view: clears timers, panels and attempts from any previous run
  running = true;
  const go = $('#go'); go.disabled = true; go.lastChild.textContent = 'Working';
  const es = new EventSource('/api/analyze/' + encodeURIComponent(id));
  es.onmessage = (m) => {
    const s = JSON.parse(m.data);
    if (s.type === 'done') { es.close(); running = false; go.disabled = false; go.lastChild.textContent = 'Run again'; finish(s.verdict, s.runId); return; }
    render(s, true);
  };
  es.onerror = () => { es.close(); running = false; clearInterval(tick); go.disabled = false; go.lastChild.textContent = 'Try again';
    $('#notice').innerHTML = '<div class="notice err">Lost the connection to the RedGreen server. Check the terminal running it, then try again.</div>'; };
}

/* ---------- GitHub bot page ---------- */
async function botView() {
  setTab('github');
  const b = await getJSON('/api/bot');
  state = null;
  const isApp = b.kind === 'app' && b.enabled;
  const installs = b.installations || [];
  const s1 = isApp, s2 = isApp && installs.length > 0;
  const repoItems = isApp
    ? (installs.map((r) => `<li><span class="rdot"></span><a href="https://github.com/${esc(r.repo)}/issues" target="_blank" rel="noopener">${esc(r.repo)}</a><span class="muted">by @${esc(r.account || '')}</span></li>`).join('') || '<li class="muted">Not installed anywhere yet.</li>')
    : ((b.repos || []).map((r) => `<li><span class="rdot"></span><a href="https://github.com/${esc(r)}/issues" target="_blank" rel="noopener">${esc(r)}</a><button class="btn small" data-unwatch="${esc(r)}">Remove</button></li>`).join('') || '<li class="muted">No repos yet.</li>');
  const act = (b.activity || []).slice(0, 12).map((a) => `<li><span class="at">${clock(a.at)}</span><span>${esc(a.msg)}</span></li>`).join('') || '<li class="muted">Nothing yet. Activity shows up here as the app works.</li>';
  await swap(() => { $('#main').innerHTML = `
  <section class="pg gh2">
    <div class="gh-hero">
      <div>
        <h1 class="pg-h">RedGreen for GitHub</h1>
        <p class="pg-sub">An app anyone can add to their repos, like any GitHub app. Label an issue <code>redgreen</code> or comment <code>/redgreen</code>; it replies with a failing check and where to look.</p>
      </div>
      <div class="gh-status ${isApp ? 'live' : ''}">
        <span class="lamps"><i class="l r"></i><i class="l g"></i></span>
        <div><b>${isApp ? 'Live' : 'Not set up'}</b><span>${isApp ? `as @${esc(b.login)}${b.current ? ` · working on ${esc(b.current.repo)}#${b.current.number}` : ''}` : 'Two clicks to go live'}</span></div>
      </div>
    </div>
    ${!b.githubMode ? `<div class="notice err">${esc(b.error)}</div>` : ''}

    <ol class="steps2">
      <li class="${s1 ? 'done' : 'now'}">
        <span class="sn">${s1 ? '✓' : '1'}</span>
        <div class="sc"><h3>Create the app</h3>
          ${s1 ? `<p><b>${esc(b.appName || 'RedGreen')}</b> exists on GitHub. This computer is its worker: it checks every repo the app is installed on and runs Gemma 4 locally.</p>`
               : `<p>GitHub fills in everything and sends the keys straight back here. Nothing to type.</p><button class="cta-main" id="createApp" type="button">Create RedGreen on GitHub</button>`}
          <p class="gherr" id="appErr">${b.githubMode && b.appConfigured && !b.enabled && b.error ? esc(b.error) : ''}</p>
        </div>
      </li>
      <li class="${s2 ? 'done' : s1 ? 'now' : ''}">
        <span class="sn">${s2 ? '✓' : '2'}</span>
        <div class="sc"><h3>Install it on repos</h3>
          <p>Pick repos on GitHub's own install screen. Share the same link with anyone who wants RedGreen on theirs.</p>
          ${isApp ? `<a class="${s2 ? 'cta-alt' : 'cta-main'}" href="${esc(b.installUrl)}" target="_blank" rel="noopener">${s2 ? 'Add more repos' : 'Install RedGreen on a repo'}</a>` : '<span class="muted">Available after step 1.</span>'}
          ${s2 ? `<ul class="repos2">${repoItems}</ul>` : ''}
        </div>
      </li>
      <li class="${s2 ? 'now' : ''}">
        <span class="sn">3</span>
        <div class="sc"><h3>Trigger it on an issue</h3>
          <div class="trigger"><span class="label-chip">redgreen</span><span class="or">or comment</span><code class="cmt-chip">/redgreen</code></div>
          <p class="muted">Only people with write access can trigger it, because it runs the repo's code on this computer. On a fork, point it upstream: <code>/redgreen https://github.com/owner/project/issues/42</code></p>
        </div>
      </li>
    </ol>

    <div class="gh-cols">
      <section class="panel2"><h2 class="sec-h">What it may do</h2>
        <label class="switch"><input type="checkbox" id="tryFix" ${b.tryFix ? 'checked' : ''}><span class="sw"></span><span><b>Suggest a verified fix</b><small>Only when the patch makes the failing check pass. Off: it only reproduces.</small></span></label>
        <label class="switch"><input type="checkbox" id="openPrs" ${b.openPrs ? 'checked' : ''} ${b.enabled && b.tryFix ? '' : 'disabled'}><span class="sw"></span><span><b>Open pull requests</b><small>For verified fixes only. Off by default.</small></span></label>
      </section>
      <section class="panel2"><h2 class="sec-h">Activity</h2><ul class="act2">${act}</ul></section>
    </div>

    <details class="adv"><summary>Advanced: use an existing app or a personal token</summary>
      <div class="advbody">
        <form id="appForm" class="appform"><input id="appId" inputmode="numeric" placeholder="App ID" required><label class="file"><input id="appKey" type="file" accept=".pem" required><span>Choose .pem key</span></label><button type="submit" class="btn">Save</button></form>
        ${isApp ? '<button class="btn small" id="removeApp" type="button">Remove app credentials</button>' : ''}
        ${b.kind === 'token' ? `<p>Personal token connected as <b>@${esc(b.login)}</b>. <button class="btn small" id="disconnect">Disconnect</button></p><form id="repoForm" class="ghrow"><input id="repoIn" placeholder="owner/repo" required><button type="submit" class="btn">Add repo</button></form>${b.kind === 'token' ? `<ul class="repos2">${repoItems}</ul>` : ''}`
          : isApp ? '' : `<form id="tokForm" class="ghrow"><input id="tok" type="password" autocomplete="off" placeholder="github_pat_…" required><button type="submit" class="btn">Use token</button></form>`}
        <p class="gherr" id="tokErr"></p>
      </div>
    </details>
  </section>`; });
  const post = (url, body, method = 'POST') => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ ok: r.ok, j: await r.json() }));
  $('#appForm')?.addEventListener('submit', async (e) => {
    e.preventDefault(); const f = $('#appKey').files[0]; if (!f) return;
    const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Checking';
    const { ok, j } = await post('/api/bot/app', { appId: $('#appId').value, privateKey: await f.text() });
    btn.disabled = false; btn.textContent = 'Save';
    if (!ok) $('#appErr').textContent = j.error; else { botView(); loadStatus(); }
  });
  $('#createApp')?.addEventListener('click', async () => {
    const { action, manifest } = await getJSON('/api/bot/manifest-form');
    const f = document.createElement('form'); f.method = 'post'; f.action = action;
    const i = document.createElement('input'); i.type = 'hidden'; i.name = 'manifest'; i.value = manifest; f.appendChild(i);
    document.body.appendChild(f); f.submit();
  });
  $('#appKey')?.addEventListener('change', (e) => { e.target.nextElementSibling.textContent = e.target.files[0]?.name || 'Choose .pem key'; });
  $('#removeApp')?.addEventListener('click', async () => { await post('/api/bot/app', null, 'DELETE'); botView(); loadStatus(); });
  $('#tokForm')?.addEventListener('submit', async (e) => { e.preventDefault(); const { ok, j } = await post('/api/bot/token', { token: $('#tok').value }); $('#tok').value = ''; if (!ok) $('#tokErr').textContent = j.error; else { botView(); loadStatus(); } });
  $('#disconnect')?.addEventListener('click', async () => { await post('/api/bot/token', null, 'DELETE'); botView(); loadStatus(); });
  $('#repoForm')?.addEventListener('submit', async (e) => { e.preventDefault(); const { ok, j } = await post('/api/bot/repos', { repo: $('#repoIn').value }); if (!ok) $('#tokErr').textContent = j.error; else { botView(); loadStatus(); } });
  $('#openPrs')?.addEventListener('change', (e) => post('/api/bot/settings', { openPrs: e.target.checked }));
  $('#tryFix')?.addEventListener('change', async (e) => { tryFixSetting = e.target.checked; await post('/api/bot/settings', { tryFix: e.target.checked }); botView(); });
  document.querySelectorAll('[data-unwatch]').forEach((btn) => btn.addEventListener('click', async () => { const [o, r] = btn.dataset.unwatch.split('/'); await post(`/api/bot/repos/${o}/${r}`, null, 'DELETE'); botView(); loadStatus(); }));
}


/* ---------- follow bot runs live ---------- */
let botCase = null;
function followBot() {
  const es = new EventSource('/api/live');
  es.onmessage = async (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'bot.start') {
      if (running) return; // the person is busy with their own run
      botCase = ev.caseId; running = true;
      await openReport(ev.caseId);
      const go = $('#go'); if (go) { go.disabled = true; go.lastChild.textContent = 'Bot is working'; }
      $('#notice').innerHTML = `<div class="notice">The GitHub bot picked up this issue on ${esc(ev.repo)}. Following its run live.</div>`;
      loadStatus();
      return;
    }
    if (!botCase || ev.caseId !== botCase) return;
    if (ev.type === 'done') { running = false; botCase = null; const go = $('#go'); if (go) { go.disabled = false; go.lastChild.textContent = 'Run again'; } finish(ev.verdict, ev.runId); loadStatus(); return; }
    render(ev, true);
  };
}

/* ---------- router + splash ---------- */
function route() {
  if (running) return;
  const h = location.hash;
  let m;
  if ((m = h.match(/^#\/report\/(\w+)/))) return openReport(m[1], false);
  if ((m = h.match(/^#\/run\/(\w+)/))) return openRun(m[1], false);
  if (h.startsWith('#/reproduce')) return swap(reproducePage);
  if (h.startsWith('#/history')) return swap(historyPage);
  if (h.startsWith('#/model')) return modelPage();
  if (h.startsWith('#/github') || h.startsWith('#bot')) {
    const err = h === '#bot-error';
    if (h.startsWith('#bot')) history.replaceState(null, '', '#/github');
    return botView().then(() => { if (err && $('#appErr')) $('#appErr').textContent = 'GitHub did not finish creating the app. Try again.'; });
  }
  return swap(home);
}
window.addEventListener('hashchange', route);
window.addEventListener('pointermove', (e) => { document.body.style.setProperty('--mx', e.clientX + 'px'); document.body.style.setProperty('--my', e.clientY + 'px'); }, { passive: true });
window.addEventListener('popstate', route);
$('#sysBtn').addEventListener('click', () => { const p = $('#sysPop'); p.hidden = !p.hidden; $('#sysBtn').setAttribute('aria-expanded', String(!p.hidden)); });
document.addEventListener('click', (e) => { if (!e.target.closest('.sys-wrap')) { $('#sysPop').hidden = true; $('#sysBtn').setAttribute('aria-expanded', 'false'); } });

const splashStart = Date.now();
let splashGone = false;
function statusReady() {
  if (splashGone) return;
  splashGone = true;
  const sp = $('#splash'); const msg = $('#spMsg');
  if (msg) msg.textContent = lastStatus?.model?.ok ? 'Gemma 4 ready' : 'Ready';
  setTimeout(() => { sp.classList.add('done'); setTimeout(() => sp.remove(), 700); }, Math.max(0, 1500 - (Date.now() - splashStart)));
}
setTimeout(statusReady, 4500); // never hold the page hostage

route(); loadStatus(); followBot(); setInterval(loadStatus, 10000);
