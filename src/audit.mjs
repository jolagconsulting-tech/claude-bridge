// Append-only audit trail, written concurrently by the server process and by
// every guard subprocess.
//
// CONCURRENCY: a single O_APPEND write() of a modest line is atomic, so records
// from simultaneous writers interleave cleanly. A large one is not — the kernel
// may split it, and a split record corrupts the line either side of it. Records
// are therefore capped before they are written; an audit trail that loses the
// tail of one command's output is worth far more than one that cannot be parsed.
import fs from 'node:fs';
import { AUDIT_LOG, LOG_DIR } from './paths.mjs';

const MAX_LINE = 3000;

/** JSON.stringify with every long string (at any depth) truncated. */
function stringifyCapped(obj, maxField) {
  return JSON.stringify(obj, (_k, v) =>
    typeof v === 'string' && v.length > maxField
      ? `${v.slice(0, maxField)}…[+${v.length - maxField} chars]`
      : v
  );
}

export function auditLine(event) {
  const entry = { ts: new Date().toISOString(), ...event };
  let line = stringifyCapped(entry, 2000);
  if (line.length > MAX_LINE) line = stringifyCapped(entry, 300);
  if (line.length > MAX_LINE) {
    line = JSON.stringify({
      ts: entry.ts, kind: entry.kind, run_id: entry.run_id, project: entry.project,
      note: `fields elided: record was ${line.length}B, too large to append atomically`,
    });
  }
  return line;
}

export function audit(event) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_LOG, auditLine(event) + '\n');
  } catch {
    // Auditing must never take down a run.
  }
}

export function tailAudit(lines = 100, runId = null) {
  try {
    const all = fs.readFileSync(AUDIT_LOG, 'utf8').split('\n').filter(Boolean);
    const parsed = all.map((l) => {
      try { return JSON.parse(l); } catch { return { raw: l }; }
    });
    const filtered = runId ? parsed.filter((e) => e.run_id === runId) : parsed;
    return filtered.slice(-lines);
  } catch {
    return [];
  }
}
