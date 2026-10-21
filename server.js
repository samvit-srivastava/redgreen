// RedGreen server: zero dependencies. `node server.js` then open http://localhost:3000
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './src/redact.js';
import { runPipeline } from './src/pipeline.js';
import { runRepoPipeline } from './src/repoPipeline.js';
import { parseIssueUrl, fetchIssue } from './src/github.js';
import { createBot, envConfig } from './src/bot.js';
import { status as modelStatus, modelConfig, applyModelSettings, GEMINI_MODELS } from './src/model.js';
import { sandboxInfo } from './src/sandbox.js';
import { COUPONS } from './fixtures/shop/src/cart.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, 'fixtures', 'shop');
const DATA = process.env.REDGREEN_DATA || path.join(ROOT, 'data');
const REPORTS = path.join(DATA, 'reports');
const RUNS = path.join(DATA, 'runs');
const REPOS = path.join(DATA, 'repos');
// GitHub mode runs a cloned repo's own code (its `npm test`, its runner, and Gemma's patch to it) on this machine.
// Only node:test repro tests can run under the permission model; everything else is outside the sandbox.
// So it is OFF unless explicitly enabled for repos you trust.
const REPO_CODE_ALLOWED = process.env.REDGREEN_ALLOW_REPO_CODE === '1' || process.argv.includes('--allow-repo-code');
const REPO_MODE_OFF = process.env.PUBLIC_URL
  ? 'GitHub mode is turned off on this RedGreen server.'
  : 'GitHub mode is off: it runs the repository\'s own code and tests on this machine, outside the RedGreen sandbox. Only enable it for repos you trust: restart with npm run dev:github (or REDGREEN_ALLOW_REPO_CODE=1).';
fs.mkdirSync(REPORTS, { recursive: true }); fs.mkdirSync(RUNS, { recursive: true });
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2', '.diff': 'text/x-diff; charset=utf-8' };

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const safeId = (s) => /^[a-z0-9_]{3,40}$/i.test(s) ? s : null;
function serveFile(res, base, rel) {
  const p = path.normalize(path.join(base, rel));
  if (!p.startsWith(base + path.sep) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return send(res, 404, { error: 'not found' });
  send(res, 200, fs.readFileSync(p), TYPES[path.extname(p)] || 'application/octet-stream');
}
async function readBody(req, limit = 8_000_000) {
  let size = 0; const chunks = [];
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  for await (const c of req) { size += c.length; if (size > limit) throw fail(413, `body too large (max ${limit} bytes)`); chunks.push(c); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw fail(400, 'invalid JSON body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'JSON body must be an object');
  return body;
}
// Unique, filename-safe ids (time-ordered, plus randomness so two saves in the same millisecond never collide).
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MAX_EVENTS = 5000;
// One corrupt or half-written file must not take down the whole list: skip it (and log once).
const skipped = new Set();
const readJsonSafe = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (!skipped.has(f)) { skipped.add(f); console.warn(`[redgreen] skipping unreadable ${path.basename(f)}: ${e.message}`); } return null; } };
const listJson = (dir, valid) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJsonSafe(path.join(dir, f))).filter((o) => o && typeof o === 'object' && valid(o)).sort((a, b) => (b.savedAt || b.startedAt || '').localeCompare(a.savedAt || a.startedAt || ''));

let busy = false;
const MODEL_CFG = path.join(DATA, 'model-config.json');
const readModelCfg = () => { try { return JSON.parse(fs.readFileSync(MODEL_CFG, 'utf8')); } catch { return {}; } };
applyModelSettings(readModelCfg());
// Optional access password for deployed instances (REDGREEN_PASSWORD). Local use stays open.
const PASSWORD = process.env.REDGREEN_PASSWORD || '';
function authorized(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  return pass.length === PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(PASSWORD));
}

// Local-only API guard. The API can run code (GitHub mode, bot) and store credentials, so it must only be
// driven by RedGreen's own pages, never by another website you happen to have open:
// - Host must be localhost / 127.0.0.1 / [::1] (blocks DNS-rebinding attacks);
// - cross-site requests are refused (Sec-Fetch-Site from modern browsers, Origin for the rest), which stops
//   form-POST / <img> CSRF such as planting a bot token or starting a run.
// Non-browser clients (scripts, tests) send neither header and are unaffected.
// GitHub's redirect back to /api/bot/manifest is a cross-site top-level GET by design; it has its own state check.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
// A deployed instance (PUBLIC_URL) is reached under its public host name; that one is allowed too.
const PUBLIC_HOST = (() => { try { return process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).host.toLowerCase() : null; } catch { return null; } })();
function requestGuard(req, p) {
  if (!p.startsWith('/api/') && !p.startsWith('/shop/api/')) return null;
  const host = String(req.headers.host || '').toLowerCase();
  if (!LOCAL_HOST.test(host) && host !== PUBLIC_HOST) return 'unexpected host';
  if (req.method === 'GET' && p === '/api/bot/manifest') return null;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return `cross-site request (${site})`;
  const origin = req.headers.origin;
  if (origin) {
    let host = null; try { host = new URL(origin).host; } catch {}
    if (host !== req.headers.host) return 'cross-origin request';
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (!authorized(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="RedGreen"', 'Content-Type': 'text/plain' }); return res.end('RedGreen: password required'); }
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const blocked = requestGuard(req, p);
  if (blocked) return send(res, 403, { error: `Refused: ${blocked}. RedGreen's API only accepts requests from its own pages.` });
  try {
    // ---- RedGreen UI
    if (p === '/' || p === '/index.html') return serveFile(res, path.join(ROOT, 'ui'), 'index.html');
    if (p.startsWith('/ui/')) return serveFile(res, path.join(ROOT, 'ui'), p.slice(4));

    // ---- Demo shop (the app under test)
    if (p === '/shop' || p === '/shop/') return serveFile(res, path.join(FIXTURE, 'public'), 'index.html');
    if (p.startsWith('/shop/src/')) return serveFile(res, path.join(FIXTURE, 'src'), p.slice(10));
    if (p.startsWith('/shop/public/')) return serveFile(res, path.join(FIXTURE, 'public'), p.slice(13));
    if (p === '/shop/api/checkout' && req.method === 'POST') {
      // Server-side price check (independent of the client cart module)
      const b = await readBody(req);
      const items = b.items ?? [];
      const okItem = (it) => it && typeof it === 'object' && Number.isFinite(it.price) && it.price >= 0 && Number.isInteger(it.qty) && it.qty >= 0;
      if (!Array.isArray(items) || !items.every(okItem) || !Number.isFinite(b.clientTotal) || (b.coupon != null && typeof b.coupon !== 'string')) return send(res, 400, { error: 'invalid checkout: items must be [{price: number >= 0, qty: integer >= 0}], clientTotal a number' });
      const sub = items.reduce((s, it) => s + it.price * it.qty, 0);
      const expected = Math.round((sub - sub * (COUPONS[b.coupon] ?? 0)) * 100) / 100;
      if (Math.abs(expected - b.clientTotal) > 0.009) return send(res, 422, { error: `Total mismatch: client sent $${Number(b.clientTotal).toFixed(2)}, server computed $${expected.toFixed(2)}` });
      return send(res, 200, { ok: true, charged: expected });
    }

    // ---- API
    if (p === '/api/status') return send(res, 200, { model: await modelStatus(), sandbox: sandboxInfo, busy, githubMode: { enabled: REPO_CODE_ALLOWED, isolation: 'node:test repro tests run under the permission model; the repo\'s own suite and other runners run unsandboxed (temp clone, timeout, minimal env, install scripts disabled)' } });
    if (p === '/api/reports' && req.method === 'POST') {
      const raw = await readBody(req);
      if (raw.schema !== 'redgreen.evidence/v1' || !Array.isArray(raw.events)) return send(res, 400, { error: 'invalid evidence bundle' });
      if (raw.events.length > MAX_EVENTS || !raw.events.every((e) => e && typeof e === 'object' && !Array.isArray(e) && typeof e.type === 'string')) return send(res, 400, { error: `invalid evidence bundle: events must be objects with a "type" (max ${MAX_EVENTS})` });
      if (raw.description != null && typeof raw.description !== 'string') return send(res, 400, { error: 'invalid evidence bundle: description must be a string' });
      // Screenshot is user-approved and kept local; it is excluded from text redaction (regexes would corrupt base64).
      const screenshot = typeof raw.screenshot === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw.screenshot) ? raw.screenshot : null;
      delete raw.screenshot;
      const { value, count } = redact(raw);
      if (screenshot) value.screenshot = screenshot;
      const id = newId('rpt');
      const rec = { ...value, id, redactions: count, savedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(REPORTS, id + '.json'), JSON.stringify(rec, null, 2));
      return send(res, 201, { id, redactions: count });
    }
    if (p === '/api/issues' && req.method === 'POST') {
      // GitHub mode: store the issue as a case; cloning/installing happens when the run starts (streamed live).
      if (!REPO_CODE_ALLOWED) return send(res, 403, { error: REPO_MODE_OFF });
      const { url } = await readBody(req, 10000);
      let ref; try { ref = parseIssueUrl(url); } catch (e) { return send(res, 400, { error: e.message }); }
      let rec; try { rec = await createCase(ref); } catch (e) { return send(res, 502, { error: e.message }); }
      return send(res, 201, { id: rec.id, title: rec.issue.title });
    }
    if (p === '/api/reports' && req.method === 'GET') return send(res, 200, listJson(REPORTS, (r) => typeof r.id === 'string' && Array.isArray(r.events)).map(({ id, description, savedAt, events, redactions, sample, screenshot, kind, repo }) => ({ id, description, savedAt, events: events.length, redactions, sample: !!sample, screenshot: !!screenshot, kind: kind || 'report', repo: repo ? `${repo.owner}/${repo.repo}#${repo.number}` : undefined })));
    let m;
    if ((m = p.match(/^\/api\/reports\/([^/]+)$/))) {
      const id = safeId(m[1]); const f = id && path.join(REPORTS, id + '.json');
      return f && fs.existsSync(f) ? send(res, 200, fs.readFileSync(f, 'utf8')) : send(res, 404, { error: 'not found' });
    }
    if (p === '/api/runs' && req.method === 'GET') return send(res, 200, listJson(RUNS, (r) => typeof r.id === 'string' && typeof r.verdict === 'string').map(({ id, reportId, startedAt, verdict, reason }) => ({ id, reportId, startedAt, verdict, ...(reason ? { reason } : {}) })));
    if ((m = p.match(/^\/api\/runs\/([^/]+)\/patch\.diff$/))) {
      // Verified unified diff + repro test as a new file, for `git apply` from the repo root. Verified runs only.
      const id = safeId(m[1]); const f = id && path.join(RUNS, id + '.json');
      const run = f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
      if (!run || run.verdict !== 'fixed_verified' || !run.patch) return send(res, 404, { error: run ? 'no verified patch for this run' : 'not found' });
      res.writeHead(200, { 'Content-Type': 'text/x-diff; charset=utf-8', 'Content-Disposition': `attachment; filename="redgreen-${run.id}.patch"`, 'Cache-Control': 'no-store' });
      return res.end(run.patch);
    }
    if ((m = p.match(/^\/api\/runs\/([^/]+)(\/pr\.md)?$/))) {
      const id = safeId(m[1]); const f = id && path.join(RUNS, id + '.json');
      if (!f || !fs.existsSync(f)) return send(res, 404, { error: 'not found' });
      if (m[2]) return send(res, 200, JSON.parse(fs.readFileSync(f, 'utf8')).prMarkdown || '# No verified result', 'text/markdown; charset=utf-8');
      return send(res, 200, fs.readFileSync(f, 'utf8'));
    }
    if (p === '/api/bot' || p.startsWith('/api/bot/')) return botApi(req, res, p);
    if (p === '/api/model' && req.method === 'GET') {
      const c = readModelCfg();
      return send(res, 200, { hosted: !!process.env.PUBLIC_URL, provider: modelConfig.provider, geminiModel: modelConfig.geminiModel, geminiModels: GEMINI_MODELS, hasGeminiKey: !!modelConfig.geminiKey, baseUrl: c.baseUrl || modelConfig.baseUrl, status: await modelStatus() });
    }
    if (p === '/api/model' && req.method === 'POST') {
      const b = await readBody(req, 5000);
      const c = readModelCfg();
      if (b.provider === 'gemini' || b.provider === 'lmstudio') c.provider = b.provider;
      if (typeof b.geminiKey === 'string' && b.geminiKey.trim()) {
        const key = b.geminiKey.trim();
        const model = GEMINI_MODELS.includes(b.geminiModel) ? b.geminiModel : (c.geminiModel || GEMINI_MODELS[0]);
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}`, { headers: { 'x-goog-api-key': key } }).catch(() => null);
        if (!r || !r.ok) return send(res, 400, { error: `Google did not accept that key for ${model}${r ? ` (${r.status})` : ''}.` });
        c.geminiKey = key;
      }
      if (b.removeKey) delete c.geminiKey;
      if (GEMINI_MODELS.includes(b.geminiModel)) c.geminiModel = b.geminiModel;
      if (typeof b.baseUrl === 'string' && /^https?:\/\//.test(b.baseUrl)) c.baseUrl = b.baseUrl;
      fs.writeFileSync(MODEL_CFG, JSON.stringify(c, null, 2));
      if (b.removeKey) modelConfig.geminiKey = process.env.GEMINI_API_KEY || '';
      applyModelSettings(c);
      return send(res, 200, { ok: true, status: await modelStatus() });
    }
    if (p === '/api/live') {
      // Bot runs, streamed to any open dashboard so it can follow along live.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      liveClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); liveClients.delete(res); });
      return;
    }
    if ((m = p.match(/^\/api\/analyze\/([^/]+)$/))) {
      // Server-Sent Events stream of pipeline steps
      const id = safeId(m[1]); const f = id && path.join(REPORTS, id + '.json');
      if (!f || !fs.existsSync(f)) return send(res, 404, { error: 'report not found' });
      if (busy) return send(res, 409, { error: 'a run is already in progress' });
      busy = true;
      // If the browser goes away mid-run (tab closed/refreshed), cancel at the next checkpoint so the
      // single run slot is freed instead of returning 409 for minutes.
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const live = () => !res.destroyed && !res.writableEnded;
      res.on('error', () => {}); // a vanished client must never crash the server
      const emit = (ev) => { if (live()) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
      const ping = setInterval(() => { if (live()) res.write(': ping\n\n'); }, 10000);
      try {
        const report = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (report.kind === 'github' && !REPO_CODE_ALLOWED) { emit({ type: 'fatal', error: REPO_MODE_OFF }); return; }
        const fix = !!getBotConfig().tryFix; // reproduce-only unless "Also try a fix" is switched on
        const run = report.kind === 'github'
          ? await runRepoPipeline({ kase: report, reposDir: REPOS, emit, fix, signal: ac.signal })
          : await runPipeline({ report, fixtureDir: FIXTURE, emit, fix, signal: ac.signal });
        fs.writeFileSync(path.join(RUNS, run.id + '.json'), JSON.stringify(run, null, 2));
      } catch (e) {
        if (e.cancelled) console.log(`[redgreen] ${e.message} (report ${id})`);
        else emit({ type: 'fatal', error: e.message });
      } finally { clearInterval(ping); busy = false; res.end(); }
      return;
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    // 413: the rest of the upload is still unread, so close the connection instead of reusing it.
    if (e.status === 413) res.setHeader('Connection', 'close');
    if (!res.headersSent) send(res, e.status || 500, { error: e.message }); else res.end();
  }
});

// ---- shared helpers for the GitHub bot
const liveClients = new Set();
const broadcast = (ev) => { for (const c of liveClients) c.write(`data: ${JSON.stringify(ev)}\n\n`); };
async function createCase(ref, token) {
  // ref = the repo we clone and push to; ref.upstream (optional) = where the issue text lives (fork workflow).
  const src = ref.upstream || ref;
  const fetched = await fetchIssue(src, token);
  // Issue text is untrusted user content: redact it before it is stored or sent to the model.
  const { value: issue, count } = redact(fetched);
  const id = newId('gh');
  const repo = { owner: ref.owner, repo: ref.repo, number: ref.upstream ? ref.upstream.number : ref.number };
  const rec = { schema: 'redgreen.issue/v1', kind: 'github', id, description: issue.title, issue, repo, upstream: ref.upstream || null, events: [], redactions: count, savedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(REPORTS, id + '.json'), JSON.stringify(rec, null, 2));
  return rec;
}
async function runCaseForBot(kase, token) {
  while (busy) await new Promise((r) => setTimeout(r, 2000)); // one run at a time, shared with the dashboard
  busy = true;
  try {
    broadcast({ type: 'bot.start', caseId: kase.id, repo: `${kase.repo.owner}/${kase.repo.repo}` });
    const run = await runRepoPipeline({ kase, reposDir: REPOS, token, fix: !!getBotConfig().tryFix, emit: (ev) => broadcast({ ...ev, caseId: kase.id }) });
    fs.writeFileSync(path.join(RUNS, run.id + '.json'), JSON.stringify(run, null, 2));
    return run;
  } finally { busy = false; }
}
const BOT_STATE = path.join(DATA, 'bot-state.json');
// Bot settings are set from the website and kept ONLY on this machine (git-ignored). The token is never sent back to the browser.
const BOT_CONFIG = path.join(DATA, 'bot-config.json');
const readBotConfig = () => { try { return JSON.parse(fs.readFileSync(BOT_CONFIG, 'utf8')); } catch { return {}; } };
const writeBotConfig = (c) => fs.writeFileSync(BOT_CONFIG, JSON.stringify(c, null, 2), { mode: 0o600 }); // holds a token / private key: owner-only
const envAppKey = () => { try { return process.env.REDGREEN_APP_KEY_FILE ? fs.readFileSync(process.env.REDGREEN_APP_KEY_FILE, 'utf8') : ''; } catch { return ''; } };
const getBotConfig = () => { const env = envConfig(), f = readBotConfig(); return { ...env, tryFix: !!f.tryFix, token: f.token || env.token, repos: f.repos ?? env.repos, allowAccounts: [...new Set([...(env.allowAccounts || []), ...(Array.isArray(f.allowAccounts) ? f.allowAccounts.map((a) => String(a).toLowerCase()) : [])])], openPrs: f.openPrs ?? env.openPrs, appId: f.appId || process.env.REDGREEN_APP_ID || '', privateKey: f.privateKey || envAppKey() }; };
const bot = REPO_CODE_ALLOWED
  ? createBot({ createCase, runCase: runCaseForBot, getConfig: getBotConfig, loadState: () => (fs.existsSync(BOT_STATE) ? readJsonSafe(BOT_STATE) : null), saveState: (st) => fs.writeFileSync(BOT_STATE, JSON.stringify(st, null, 2)) })
  : { status: { enabled: false, repos: [], activity: [], error: REPO_MODE_OFF }, start() {} };

// One-click GitHub App setup: a random, one-time, short-lived state ties GitHub's callback to a setup started here.
let manifestState = null; // { value, exp }
async function botApi(req, res, p) {
  const cfg = getBotConfig();
  const view = () => { const c = getBotConfig(); return { ...bot.status, tryFix: !!c.tryFix, connected: !!(c.token || (c.appId && c.privateKey)), appConfigured: !!(c.appId && c.privateKey), repos: bot.status.kind === 'app' ? bot.status.repos : c.repos, openPrs: !!c.openPrs, githubMode: REPO_CODE_ALLOWED }; };
  if (p === '/api/bot' && req.method === 'GET') return send(res, 200, view());
  // One-click app creation (GitHub "app manifest" flow): GitHub sends back the App ID + key; nothing is typed by hand.
  if (p === '/api/bot/manifest' && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const code = u.searchParams.get('code'), stateParam = u.searchParams.get('state');
    const expected = manifestState; manifestState = null; // one-time
    if (!code || !stateParam || !expected || Date.now() > expected.exp || stateParam.length !== expected.value.length || !crypto.timingSafeEqual(Buffer.from(stateParam), Buffer.from(expected.value))) { res.writeHead(302, { Location: '/#bot-error' }); return res.end(); }
    try {
      const r = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'redgreen' } });
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      const app = await r.json();
      writeBotConfig({ ...readBotConfig(), appId: String(app.id), privateKey: app.pem, appSlug: app.slug });
      await bot.start();
      res.writeHead(302, { Location: '/#bot' }); return res.end();
    } catch (e) { res.writeHead(302, { Location: '/#bot-error' }); return res.end(); }
  }
  if (p === '/api/bot/manifest-form' && req.method === 'GET') {
    manifestState = { value: crypto.randomBytes(24).toString('hex'), exp: Date.now() + 10 * 60_000 };
    const origin = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
    const manifest = {
      name: `RedGreen ${Math.random().toString(36).slice(2, 6)}`,
      url: 'https://github.com/samvit-srivastava/redgreen',
      description: 'Reproduces bugs from GitHub issues with a failing check, using Gemma 4.',
      public: true,
      redirect_url: `${origin}/api/bot/manifest`,
      default_permissions: { issues: 'write', pull_requests: 'write', contents: 'write', metadata: 'read' },
      default_events: [],
    };
    return send(res, 200, { action: `https://github.com/settings/apps/new?state=${manifestState.value}`, manifest: JSON.stringify(manifest) });
  }
  if (!REPO_CODE_ALLOWED) return send(res, 403, { error: REPO_MODE_OFF });
  if (p === '/api/bot/token' && req.method === 'POST') {
    const { token } = await readBody(req, 5000);
    if (getBotConfig().appId) return send(res, 400, { error: 'This RedGreen runs as a GitHub App; remove the app first to use a personal token.' });
    if (typeof token !== 'string' || token.trim().length < 20) return send(res, 400, { error: 'That does not look like a GitHub token.' });
    const r = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token.trim()}`, 'User-Agent': 'redgreen' } });
    if (!r.ok) return send(res, 400, { error: `GitHub rejected the token (${r.status}).` });
    writeBotConfig({ ...readBotConfig(), token: token.trim() });
    await bot.start();
    return send(res, 200, view());
  }
  if (p === '/api/bot/app' && req.method === 'POST') {
    const { appId, privateKey } = await readBody(req, 20000);
    if (!/^\d+$/.test(String(appId || '').trim())) return send(res, 400, { error: 'The App ID is a number, shown on the app\'s settings page.' });
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(String(privateKey || ''))) return send(res, 400, { error: 'Choose the .pem private key file GitHub gave you.' });
    try { const { createAppAuth } = await import('./src/githubApp.js'); await createAppAuth({ appId: String(appId).trim(), privateKey }).info(); }
    catch (e) { return send(res, 400, { error: 'GitHub did not accept this App ID and key: ' + e.message.slice(0, 160) }); }
    writeBotConfig({ ...readBotConfig(), appId: String(appId).trim(), privateKey });
    await bot.start();
    return send(res, 200, view());
  }
  if (p === '/api/bot/app' && req.method === 'DELETE') { const c = readBotConfig(); delete c.appId; delete c.privateKey; writeBotConfig(c); await bot.start(); return send(res, 200, view()); }
  if (p === '/api/bot/token' && req.method === 'DELETE') { const c = readBotConfig(); delete c.token; writeBotConfig(c); await bot.start(); return send(res, 200, view()); }
  if (p === '/api/bot/repos' && req.method === 'POST') {
    const { repo } = await readBody(req, 2000);
    const m = String(repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '').match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!m) return send(res, 400, { error: 'Use the form owner/repo, e.g. samvit-srivastava/tiny-shop' });
    const full = `${m[1]}/${m[2]}`;
    if (!cfg.token) return send(res, 400, { error: 'Connect GitHub first.' });
    const r = await fetch(`https://api.github.com/repos/${full}`, { headers: { Authorization: `Bearer ${cfg.token}`, 'User-Agent': 'redgreen' } });
    if (!r.ok) return send(res, 400, { error: `Can't see ${full} with this token (${r.status}).` });
    const info = await r.json();
    if (!info.permissions?.push) return send(res, 400, { error: `Your token can read ${full} but can't comment there. Fork it and add your fork instead.` });
    const repos = [...new Set([...(getBotConfig().repos || []), info.full_name])];
    writeBotConfig({ ...readBotConfig(), repos });
    return send(res, 200, view());
  }
  let mm;
  if ((mm = p.match(/^\/api\/bot\/repos\/([\w.-]+)\/([\w.-]+)$/)) && req.method === 'DELETE') {
    writeBotConfig({ ...readBotConfig(), repos: (getBotConfig().repos || []).filter((x) => x.toLowerCase() !== `${mm[1]}/${mm[2]}`.toLowerCase()) });
    return send(res, 200, view());
  }
  if (p === '/api/bot/settings' && req.method === 'POST') { const b = await readBody(req, 2000); const c = readBotConfig(); if ('openPrs' in b) c.openPrs = !!b.openPrs; if ('tryFix' in b) c.tryFix = !!b.tryFix; if (!c.tryFix) c.openPrs = false; writeBotConfig(c); return send(res, 200, view()); }
  if ((mm = p.match(/^\/api\/bot\/post\/([\w]+)$/)) && req.method === 'POST') {
    // Post a website run's result to its GitHub issue (same comment the bot writes).
    const runF = path.join(RUNS, mm[1] + '.json');
    if (!fs.existsSync(runF)) return send(res, 404, { error: 'run not found' });
    if (!bot.status.enabled) return send(res, 400, { error: 'Connect GitHub on the Bot page first.' });
    const run = JSON.parse(fs.readFileSync(runF, 'utf8'));
    const kase = readJsonSafe(path.join(REPORTS, run.reportId + '.json'));
    if (!kase || kase.kind !== 'github') return send(res, 400, { error: 'Only GitHub-issue runs can be posted.' });
    const target = kase.upstream ? `${kase.repo.owner}/${kase.repo.repo}` : `${kase.repo.owner}/${kase.repo.repo}`;
    try { await bot.postResult(target, kase.upstream ? kase.botIssue || kase.repo.number : kase.repo.number, kase, run); }
    catch (e) { return send(res, 400, { error: e.message.slice(0, 300) }); }
    return send(res, 200, { ok: true, url: `https://github.com/${target}/issues/${kase.repo.number}` });
  }
  return send(res, 404, { error: 'not found' });
}

let port = PORT, tries = 0;
server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  // Is it RedGreen already? Then just point the person at it instead of failing.
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    if (j && j.sandbox) { console.log(`\nRedGreen is already running → http://localhost:${port}\n(Open that link. To restart it, stop the other terminal first.)\n`); process.exit(0); }
  } catch {}
  if (++tries > 10) { console.error(`No free port found from ${PORT} to ${port}.`); process.exit(1); }
  console.log(`Port ${port} is used by another app; trying ${port + 1}…`);
  port += 1;
  server.listen(port, HOST);
});
server.on('listening', () => {
  bot.start();
  console.log(`RedGreen  → http://localhost:${port}`);
  console.log(`Demo shop → http://localhost:${port}/shop/`);
  console.log(`Model     → ${modelConfig.baseUrl} ${modelConfig.model ? '(' + modelConfig.model + ')' : '(auto-detect Gemma)'}`);
  console.log(`Sandbox   → Node ${sandboxInfo.node}, permission model: ${sandboxInfo.permissionModel}`);
  console.log(`GitHub    → ${REPO_CODE_ALLOWED ? 'GitHub mode on' : 'GitHub mode off (npm run dev:github to enable)'}`);
});
server.listen(PORT, HOST);
