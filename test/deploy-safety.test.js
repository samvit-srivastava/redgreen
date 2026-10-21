// "Suggest a verified fix" works in every mode (demo shop RED → GREEN without GitHub mode), and a server that is
// reachable from other machines without a password keeps code-running features and settings locked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
async function withServer({ args = [], env = {} }, fn) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-dep-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const { REDGREEN_ALLOW_REPO_CODE, REDGREEN_PASSWORD, HOST, ...base } = process.env;
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), ...args], { env: { ...base, PORT: String(port), REDGREEN_DATA: data, GEMMA_BASE_URL: 'http://127.0.0.1:9/v1', ...env }, stdio: 'ignore' });
  const call = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `localhost:${port}`, 'content-type': 'application/json', ...headers } }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch { return b; } })() })); });
    r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    for (let t = 0; t < 60; t++) { try { await call('GET', '/healthz'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    await fn(call, data);
  } finally { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); }
}

test('plain npm start: "Suggest a verified fix" can be switched on (demo shop can go GREEN); "Open PRs" still needs GitHub mode', async () => {
  await withServer({}, async (call, data) => {
    const r = await call('POST', '/api/bot/settings', { tryFix: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'bot-config.json'), 'utf8')).tryFix, true);
    assert.equal((await call('GET', '/api/bot')).json.tryFix, true);
    assert.equal((await call('POST', '/api/bot/settings', { openPrs: true })).status, 403);
  });
});

test('public server (HOST=0.0.0.0) without a password: GitHub mode, bot and settings stay locked even if requested', async () => {
  await withServer({ args: ['--allow-repo-code'], env: { HOST: '0.0.0.0' } }, async (call) => {
    assert.equal((await call('GET', '/api/status')).json.githubMode.enabled, false);
    assert.equal((await call('POST', '/api/issues', { url: 'https://github.com/a/b/issues/1' })).status, 403);
    assert.equal((await call('POST', '/api/bot/token', { token: 'x'.repeat(30) })).status, 403);
    assert.equal((await call('POST', '/api/bot/settings', { tryFix: true })).status, 403);
    assert.equal((await call('POST', '/api/model', { provider: 'gemini', baseUrl: 'http://169.254.169.254/' })).status, 403);
  });
});

test('public server WITH a password: requests need it, and then GitHub mode works as requested', async () => {
  await withServer({ args: ['--allow-repo-code'], env: { HOST: '0.0.0.0', REDGREEN_PASSWORD: 's3cret-pass' } }, async (call) => {
    assert.equal((await call('GET', '/api/status')).status, 401);
    const auth = { authorization: 'Basic ' + Buffer.from('x:s3cret-pass').toString('base64') };
    const st = await call('GET', '/api/status', null, auth);
    assert.equal(st.status, 200); assert.equal(st.json.githubMode.enabled, true);
    assert.equal((await call('GET', '/api/status', null, { authorization: 'Basic ' + Buffer.from('x:wrong-pass!').toString('base64') })).status, 401);
  });
});
