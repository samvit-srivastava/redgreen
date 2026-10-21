// GitHub mode: fetch an issue, clone the repo, detect how its tests run. No AI here.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function parseIssueUrl(url) {
  const m = String(url).trim().match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/issues\/(\d+)/i);
  if (!m) {
    if (/^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/i.test(String(url).trim())) throw new Error('That is a repository link. Open the issue you want reproduced and paste its URL, like https://github.com/owner/repo/issues/12');
    throw new Error('Paste a GitHub issue URL like https://github.com/owner/repo/issues/12');
  }
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

const GH_HEADERS = (token = process.env.GITHUB_TOKEN) => ({ 'User-Agent': 'redgreen', Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });

export async function fetchIssue({ owner, repo, number }, token) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`, { headers: GH_HEADERS(token) });
  if (res.status === 404) throw new Error(`Issue not found (or the repo is private): ${owner}/${repo}#${number}`);
  if (res.status === 403) throw new Error('GitHub rate limit reached. Set GITHUB_TOKEN and restart, or try again later.');
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const j = await res.json();
  if (j.pull_request) throw new Error('That URL is a pull request, not an issue.');
  let comments = [];
  if (j.comments > 0) {
    const c = await fetch(j.comments_url + '?per_page=5', { headers: GH_HEADERS(token) });
    if (c.ok) comments = (await c.json()).map((x) => ({ author: x.user?.login, body: String(x.body || '').slice(0, 2000) }));
  }
  return { title: j.title, body: String(j.body || '').slice(0, 6000), state: j.state, author: j.user?.login, labels: (j.labels || []).map((l) => l.name), url: j.html_url, comments };
}

export function run(cmd, args, { cwd, timeoutMs = 120000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env || process.env, shell: false, windowsHide: true });
    let out = '';
    const cap = (d) => { if (out.length < 200000) out += d.toString(); };
    child.stdout.on('data', cap); child.stderr.on('data', cap);
    const t = setTimeout(() => { child.kill('SIGKILL'); out += `\n[redgreen] killed after ${timeoutMs}ms`; }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: out + String(e) }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

export async function cloneRepo({ owner, repo }, dest, token) {
  fs.rmSync(dest, { recursive: true, force: true });
  const auth = token ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from('x-access-token:' + token).toString('base64')}`] : [];
  const r = await run('git', [...auth, 'clone', '-c', 'core.autocrlf=false', '--depth', '1', '--quiet', `https://github.com/${owner}/${repo}.git`, dest], { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error('git clone failed: ' + r.out.slice(-400));
  const head = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: dest });
  return head.out.trim();
}

// Run npm through node directly (no shell) so it works on Windows too.
export const npmCli = () => [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find((p) => p && /npm-cli\.js$/.test(p) && fs.existsSync(p)) || null;

// Decide how this repo runs tests. Supported: node:test, vitest, jest, mocha (JavaScript).
export function detectProject(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) throw new Error('No package.json at the repo root. RedGreen currently supports JavaScript (Node) projects.');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const testScript = pkg.scripts?.test || '';
  let runner = null;
  if (deps.vitest || /\bvitest\b/.test(testScript)) runner = 'vitest';
  else if (deps.jest || /\bjest\b/.test(testScript)) runner = 'jest';
  else if (deps.mocha || /\bmocha\b/.test(testScript)) runner = 'mocha';
  else if (/node\s+(--test|.*\btest)/.test(testScript) || fs.existsSync(path.join(dir, 'test'))) runner = 'node';
  if (!runner) throw new Error(`Could not tell how this repo runs tests (test script: "${testScript || 'none'}"). Supported: node:test, Vitest, Jest, Mocha.`);
  const esm = pkg.type === 'module';
  const needsInstall = Object.keys(deps).length > 0;
  return { name: pkg.name || path.basename(dir), runner, esm, testScript, needsInstall, testDir: ['test', 'tests', '__tests__'].find((d) => fs.existsSync(path.join(dir, d))) || 'test' };
}

export async function installDeps(dir) {
  const cli = npmCli();
  if (!cli) throw new Error('npm not found next to node');
  const hasLock = fs.existsSync(path.join(dir, 'package-lock.json'));
  // --ignore-scripts: dependencies never get to run install hooks on this machine.
  const r = await run(process.execPath, [cli, hasLock ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, timeoutMs: 300000 });
  if (r.code !== 0) throw new Error('npm install failed: ' + r.out.slice(-600));
}

// Refuse repos that are too big to clone and install on a laptop (e.g. microsoft/vscode), with a clear message.
export async function repoTooBig({ owner, repo }, token, limitMb = Number(process.env.REDGREEN_MAX_REPO_MB || 150)) {
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: GH_HEADERS(token) });
    if (!r.ok) return null;
    const j = await r.json();
    const mb = Math.round((j.size || 0) / 1024);
    return mb > limitMb ? `${owner}/${repo} is about ${mb} MB. That's too large to clone, install and run here (limit ${limitMb} MB). RedGreen works best on small and medium projects.` : null;
  } catch { return null; }
}
