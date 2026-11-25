// Durable bridge state: the kill switch, the rolling Claude Code session id,
// pending human-confirmation records, and finished run results.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ensureDirs, PAUSE_FILE, SESSIONS_DIR, PENDING_FILE, ACTIVE_FILE, RUNS_DIR,
} from './paths.mjs';
import { audit } from './audit.mjs';

// --- write failures ---------------------------------------------------------

/**
 * Perform a state write, degrading a filesystem failure to a warning.
 *
 * These writes are bookkeeping. They sit on a run's critical path but nothing
 * about the run's actual work depends on them landing, and several of them are
 * called from child-process event handlers where a throw is an uncaught
 * exception that kills the process outright — which is exactly how a transient
 * EPERM on pending.jsonl took the server down and every project's session with
 * it. Losing one record is recoverable; losing the server is not.
 *
 * Reads are left unguarded: they already return an empty result on failure.
 * writeRuntime in paths.mjs is deliberately excluded — see the note there.
 */
function tryWrite(op, fn, fallback = null) {
  try {
    return fn();
  } catch (err) {
    console.warn(`[bridge] state write failed (${op}): ${err.code || ''} ${err.message}`);
    audit({ kind: 'state_write_failed', op, error_code: err.code || null, error: err.message });
    return fallback;
  }
}

// --- kill switch ------------------------------------------------------------

export function isPaused() {
  return fs.existsSync(PAUSE_FILE);
}

export function pauseReason() {
  try {
    return JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8'));
  } catch {
    return { reason: 'paused', at: null };
  }
}

export function pause(reason = 'paused by human') {
  return tryWrite('pause', () => {
    ensureDirs();
    fs.writeFileSync(PAUSE_FILE, JSON.stringify({ reason, at: new Date().toISOString() }, null, 2));
    return true;
  }, false);
}

export function resume() {
  try { fs.unlinkSync(PAUSE_FILE); return true; } catch { return false; }
}

// --- claude code sessions, one per registered project -----------------------
// Each project keeps its own continuing session, so switching between projects
// and back preserves both sides' accumulated context.

function sessionFile(projectName) {
  return path.join(SESSIONS_DIR, `${projectName}.json`);
}

export function getSession(projectName) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(projectName), 'utf8'));
  } catch {
    return null;
  }
}

export function setSession(projectName, sess) {
  return tryWrite('setSession', () => {
    ensureDirs();
    fs.writeFileSync(sessionFile(projectName), JSON.stringify(sess, null, 2));
    return true;
  }, false);
}

export function newSession(projectName, projectDir) {
  const sess = {
    session_id: crypto.randomUUID(),
    project: projectName,
    project_dir: projectDir,
    created_at: new Date().toISOString(),
    turns: 0,
    started: false, // flips true once claude has actually created the session
  };
  setSession(projectName, sess);
  return sess;
}

export function clearSession(projectName) {
  try { fs.unlinkSync(sessionFile(projectName)); return true; } catch { return false; }
}

/** Every project that has an established session, keyed by project name. */
export function listSessions() {
  try {
    return fs.readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// --- active runs (so the CLI can kill them) ---------------------------------
// Keyed by run_id. A single-object file meant that with two runs in flight the
// second overwrote the first, and whichever finished first then deleted the
// file — leaving `bridge kill` unable to see the run still running.
// All writes come from the one server process, so read-modify-write is safe.

export function getActiveRuns() {
  try {
    const raw = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (raw && raw.run_id) return [raw];        // tolerate the old single-object format
    if (raw && typeof raw === 'object') return Object.values(raw);
    return [];
  } catch {
    return [];
  }
}

/** Is this pid still running? Signal 0 tests existence without delivering. */
export function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/**
 * Active runs whose process is genuinely still alive. Survives a server
 * restart: children are spawned detached, so they outlive their parent and
 * must still be counted when deciding whether a project is busy.
 */
export function getLiveActiveRuns() {
  return getActiveRuns().filter((r) => isPidAlive(r.pid));
}

/** Drop entries whose process is gone. Called at startup. */
export function reapDeadActiveRuns() {
  const all = getActiveRuns();
  const live = all.filter((r) => isPidAlive(r.pid));
  if (live.length !== all.length) {
    tryWrite('reapDeadActiveRuns', () => {
      ensureDirs();
      if (live.length) fs.writeFileSync(ACTIVE_FILE, JSON.stringify(live, null, 2));
      else { try { fs.unlinkSync(ACTIVE_FILE); } catch {} }
    });
  }
  return { reaped: all.length - live.length, live };
}

export function addActiveRun(info) {
  return tryWrite('addActiveRun', () => {
    ensureDirs();
    const runs = getActiveRuns().filter((r) => r.run_id !== info.run_id);
    runs.push(info);
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify(runs, null, 2));
    return true;
  }, false);
}

export function removeActiveRun(runId) {
  return tryWrite('removeActiveRun', () => {
    ensureDirs();
    const runs = getActiveRuns().filter((r) => r.run_id !== runId);
    if (runs.length) fs.writeFileSync(ACTIVE_FILE, JSON.stringify(runs, null, 2));
    else { try { fs.unlinkSync(ACTIVE_FILE); } catch {} }
    return true;
  }, false);
}

// --- pending confirmations --------------------------------------------------

export function addPending(record) {
  const entry = {
    id: crypto.randomBytes(4).toString('hex'),
    at: new Date().toISOString(),
    status: 'pending',
    ...record,
  };
  // Same atomic-append constraint as the audit log: guard subprocesses write
  // here concurrently, and a denied Write tool call carries the whole file
  // content in tool_input, which can be enormous.
  //
  // The record is returned whether or not it persisted: the caller's own reply
  // to the human is built from it, and that reply is more use than nothing if
  // the append is what failed.
  tryWrite('addPending', () => {
    ensureDirs();
    fs.appendFileSync(PENDING_FILE, cappedLine(entry) + '\n');
  });
  return entry;
}

const MAX_PENDING_LINE = 3000;
function cappedLine(entry) {
  const cap = (max) => JSON.stringify(entry, (_k, v) =>
    typeof v === 'string' && v.length > max ? `${v.slice(0, max)}…[+${v.length - max} chars]` : v);
  let line = cap(1500);
  if (line.length > MAX_PENDING_LINE) line = cap(300);
  return line;
}

export function readPending({ runId = null, includeResolved = false } = {}) {
  let entries = [];
  try {
    entries = fs.readFileSync(PENDING_FILE, 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }

  // Later lines with the same id supersede earlier ones (resolution updates).
  const byId = new Map();
  for (const e of entries) byId.set(e.id, { ...(byId.get(e.id) || {}), ...e });
  let out = [...byId.values()];
  if (runId) out = out.filter((e) => e.run_id === runId);
  if (!includeResolved) out = out.filter((e) => e.status === 'pending');
  return out;
}

export function resolvePending(id, status, note) {
  const existing = readPending({ includeResolved: true }).find((e) => e.id === id);
  if (!existing) return null;
  const updated = { ...existing, status, note: note || '', resolved_at: new Date().toISOString() };
  // Null on a failed append, same as an unknown id: a resolution the file never
  // received has not happened, and the caller must not be told that it did.
  return tryWrite('resolvePending', () => {
    ensureDirs();
    fs.appendFileSync(PENDING_FILE, JSON.stringify(updated) + '\n');
    return updated;
  });
}

// --- run results ------------------------------------------------------------

export function saveRun(run) {
  return tryWrite('saveRun', () => {
    ensureDirs();
    fs.writeFileSync(path.join(RUNS_DIR, `${run.run_id}.json`), JSON.stringify(run, null, 2));
    return true;
  }, false);
}

export function loadRun(runId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, `${runId}.json`), 'utf8'));
  } catch {
    return null;
  }
}
