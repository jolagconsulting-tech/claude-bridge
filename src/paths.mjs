// Central path + config resolution. Everything (server, CLI, hooks) resolves
// BRIDGE_HOME from its own location on disk so no environment plumbing is needed.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export const BRIDGE_HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Read once per process. loadRegistry() calls this on every request, and the
// checkout lives under ~/Desktop, which macOS TCC can revoke access to while
// the process is running — that turned a mid-life permission change into an
// EPERM on every single request instead of a one-time startup failure.
let envLoaded = false;
let envLoadError = null;

/** Why .env could not be read, if it could not. */
export function getEnvLoadError() { return envLoadError; }

// STATE_DIR may be set in .env, and the exports below are evaluated at import
// time — so the file has to be read before them, not lazily inside config().
// loadEnv never clobbers an already-set variable, so the later calls are no-ops.
loadEnv();

/**
 * Runtime state deliberately lives outside BRIDGE_HOME.
 *
 * A checkout under ~/Desktop, ~/Documents, or iCloud Drive is both sync-managed
 * and TCC-protected, and writes there can fail with a transient EPERM at any
 * moment regardless of file permissions. One such EPERM on pending.jsonl, raised
 * inside a child-exit handler, took the whole server down mid-run. Application
 * Support is neither synced nor protected. Override with BRIDGE_STATE_DIR.
 */
export const STATE_DIR = path.resolve(process.env.BRIDGE_STATE_DIR || defaultStateDir());

function defaultStateDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'claude-bridge', 'state');
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'claude-bridge');
}

export const LOG_DIR = path.join(BRIDGE_HOME, 'logs');
export const SNAPSHOT_DIR = path.join(BRIDGE_HOME, 'snapshots');
export const CONFIG_DIR = path.join(BRIDGE_HOME, 'config');
export const RUNS_DIR = path.join(STATE_DIR, 'runs');

export const PAUSE_FILE = path.join(STATE_DIR, 'PAUSED');
export const SESSIONS_DIR = path.join(STATE_DIR, 'sessions');
export const PENDING_FILE = path.join(STATE_DIR, 'pending.jsonl');
export const ACTIVE_FILE = path.join(STATE_DIR, 'active-run.json');
export const SERVER_PID_FILE = path.join(STATE_DIR, 'server.pid');
export const RUNTIME_FILE = path.join(CONFIG_DIR, 'runtime.json');
export const CLAUDE_SETTINGS = path.join(CONFIG_DIR, 'claude-settings.json');
export const AUDIT_LOG = path.join(LOG_DIR, 'audit.jsonl');

export function ensureDirs() {
  for (const d of [STATE_DIR, LOG_DIR, SNAPSHOT_DIR, CONFIG_DIR, RUNS_DIR, SESSIONS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** Load .env from the bridge home without clobbering already-set env vars. */
export function loadEnv() {
  if (envLoaded) return;
  const envPath = path.join(BRIDGE_HOME, '.env');
  if (!fs.existsSync(envPath)) { envLoaded = true; return; }

  // Never throw from here. This runs at import time, so an unreadable .env
  // would take down every tool that imports this module — including the
  // self-check whose entire job is to notice that .env became unreadable.
  // Record the reason and continue: callers that genuinely need a value (the
  // server needs BRIDGE_TOKEN) still fail closed on their own checks.
  let contents;
  try {
    contents = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    envLoadError = `${err.code || 'error'}: ${err.message}`;
    envLoaded = true;
    console.warn(`[bridge] could not read .env — ${envLoadError}`);
    return;
  }

  for (const raw of contents.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
  envLoaded = true;
}

export function config() {
  loadEnv();
  const projectDir = path.resolve(
    process.env.BRIDGE_PROJECT_DIR || path.join(os.homedir(), 'Desktop')
  );
  return {
    projectDir,
    token: process.env.BRIDGE_TOKEN || '',
    port: Number(process.env.BRIDGE_PORT || 8787),
    host: process.env.BRIDGE_HOST || '127.0.0.1',
    model: process.env.BRIDGE_MODEL || '',
    maxRunSeconds: Number(process.env.BRIDGE_MAX_RUN_SECONDS || 1800),
    defaultWaitSeconds: Number(process.env.BRIDGE_DEFAULT_WAIT_SECONDS || 240),
    maxOutputChars: Number(process.env.BRIDGE_MAX_OUTPUT_CHARS || 4000),
  };
}

/**
 * Runtime facts the hook subprocesses need. Written by the runner immediately
 * before each spawn; hooks read it since they get no arguments of their own.
 *
 * This one is deliberately NOT softened into a warning the way the bookkeeping
 * writes in state.mjs are. If it fails, a stale file from a previous run stays
 * behind and the guard scopes the next run to the wrong project directory —
 * so the throw must reach startRun and abort the run before anything spawns.
 */
export function writeRuntime(obj) {
  ensureDirs();
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(obj, null, 2));
}

/**
 * Record the pid of the serving process so anything outside this process can
 * find it (and signal it). Written once the listener is bound rather than at
 * startup, so the file's presence means "serving", not merely "launched".
 */
export function writeServerPid(pid = process.pid) {
  try {
    ensureDirs();
    fs.writeFileSync(SERVER_PID_FILE, `${pid}\n`);
  } catch (err) {
    // Bookkeeping for the CLI's benefit. Serving without a discoverable pid is
    // worse for `bridge kill` than it is for the chat on the other end.
    console.warn(`[bridge] could not write ${SERVER_PID_FILE}: ${err.code || ''} ${err.message}`);
  }
}

/**
 * Drop the pid file on a clean exit, but only when it still names us: a
 * replacement server may already have claimed it, and stealing the file back
 * would point every reader at a process that is on its way out.
 */
export function clearServerPid(pid = process.pid) {
  try {
    if (Number(fs.readFileSync(SERVER_PID_FILE, 'utf8').trim()) !== pid) return;
    fs.unlinkSync(SERVER_PID_FILE);
  } catch {
    // Shutdown must not hang on bookkeeping.
  }
}

export function readRuntime() {
  try {
    return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
  } catch {
    return { projectDir: config().projectDir, runId: 'unknown' };
  }
}
