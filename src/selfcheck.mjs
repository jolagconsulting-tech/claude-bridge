// Periodic self-check.
//
// Exists because a real degradation stayed invisible for days: macOS revoked
// the running server's access to its own .env, every request started returning
// 500, and nothing noticed — the tunnel was healthy, so from outside the box
// looked up. These are the cheap checks that would have caught it within
// minutes, plus the ones for the failure modes next door.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BRIDGE_HOME, STATE_DIR, AUDIT_LOG, config, getEnvLoadError } from './paths.mjs';
import { listProjects } from './projects.mjs';
import { isPaused } from './state.mjs';
import { loadRecentRuns, providerVerdict, describeVerdict } from './provider-health.mjs';

const run = promisify(execFile);
const TUNNEL_URL_FILE = path.join(STATE_DIR, 'tunnel.url');

async function check(name, fn) {
  try {
    const detail = await fn();
    return { name, ok: true, detail: detail ?? 'ok' };
  } catch (err) {
    // fetch() reports every network failure as a bare "fetch failed"; the real
    // reason (ECONNRESET, ETIMEDOUT, UND_ERR_SOCKET, a TLS error...) is on
    // err.cause. Without it a failing public_http is undiagnosable.
    const cause = err.cause
      ? ` (cause: ${[err.cause.code, err.cause.message].filter(Boolean).join(' ')})`
      : '';
    return { name, ok: false, detail: `${err.code ? err.code + ': ' : ''}${err.message}${cause}`.slice(0, 300) };
  }
}

async function httpJson(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

export async function runSelfCheck() {
  const cfg = config();
  const checks = [];

  // The exact failure that went unnoticed for days.
  checks.push(await check('env_readable', () => {
    // Both the deferred error from import-time load, and a fresh read: the
    // permission can be revoked after the process started.
    const deferred = getEnvLoadError();
    if (deferred) throw new Error(deferred);
    const p = path.join(BRIDGE_HOME, '.env');
    const size = fs.readFileSync(p, 'utf8').length;
    if (!size) throw new Error('.env is empty');
    return `${size} bytes`;
  }));

  checks.push(await check('state_writable', () => {
    const probe = path.join(STATE_DIR, '.selfcheck.tmp');
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    return STATE_DIR;
  }));

  checks.push(await check('audit_writable', () => {
    fs.appendFileSync(AUDIT_LOG, '');
    return AUDIT_LOG;
  }));

  // A registered project whose directory has vanished fails every run against
  // it, but is invisible until someone tries.
  checks.push(await check('projects', () => {
    const ps = listProjects();
    if (!ps.length) throw new Error('no projects registered');
    const missing = ps.filter((p) => !p.exists).map((p) => p.name);
    if (missing.length) throw new Error(`directory missing for: ${missing.join(', ')}`);
    return `${ps.length} registered, all present`;
  }));

  checks.push(await check('claude_cli', async () => {
    const { stdout } = await run('claude', ['--version'], { timeout: 20000 });
    return stdout.trim().slice(0, 60);
  }));

  // `claude --version` passes while every real run fails on an expired login
  // or an exhausted quota. The last run's ending is the only zero-cost signal.
  checks.push(await check('provider_access', () => {
    const v = providerVerdict(loadRecentRuns());
    const detail = describeVerdict(v);
    if (!v.ok) throw new Error(detail);
    return detail;
  }));

  checks.push(await check('local_http', async () => {
    const j = await httpJson(`http://127.0.0.1:${cfg.port}/health`, 10000);
    if (!j.ok) throw new Error(`health reported not ok: ${JSON.stringify(j).slice(0, 120)}`);
    return `${j.projects} projects`;
  }));

  // The end users actually depend on. Local can be fine while this is not.
  checks.push(await check('public_http', async () => {
    let url;
    try { url = fs.readFileSync(TUNNEL_URL_FILE, 'utf8').trim(); } catch { throw new Error('no tunnel.url recorded'); }
    if (!url) throw new Error('tunnel.url is empty');
    const j = await httpJson(`${url}/health`, 25000);
    if (!j.ok) throw new Error('public health reported not ok');
    return url;
  }));

  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    at: new Date().toISOString(),
    paused: isPaused(),
    checks,
    failed: failed.map((c) => c.name),
  };
}
