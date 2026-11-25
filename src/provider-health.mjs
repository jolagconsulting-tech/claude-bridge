// Provider-level health, read from recent run results — no API request spent.
//
// The self-check's claude_cli check only runs `claude --version`, which passes
// while every real run fails: an expired login (401) or an exhausted quota
// (429) is visible only in how runs end. This reads the saved run results and
// reports the most recent verdict the provider actually gave.
import fs from 'node:fs';
import path from 'node:path';
import { RUNS_DIR } from './paths.mjs';

const DAY = 24 * 60 * 60 * 1000;

// Only lines the runner itself writes about the API outcome count as evidence.
// Tool errors quote file contents and run reports are prose; either can say
// "429" or "rate limit" without the provider having refused anything.
const API_LINE = /^(Claude Code (returned|reported) an error result|claude exited with code|The claude process|system\/)/;
const API_SUMMARY = /^\s*(API Error|Failed to authenticate|Invalid API key|OAuth |Not logged in)/i;

const AUTH = /api_error_status=401|Not logged in|Failed to authenticate|OAuth (session|token)[^\n]*(expired|invalid|could not be refreshed)|authentication_error|invalid x-api-key|Invalid API key/i;
const QUOTA = /api_error_status=429|rate_limit_error|Rate limit exceeded|free-models-per-day|insufficient_quota|credit balance is too low|quota (exceeded|exhausted)/i;

const REACHED_PROVIDER = new Set(['completed', 'paused_needs_confirmation']);

export function classifyRun(run) {
  if (run.status === 'provider_mismatch') return 'provider';
  const evidence = [
    ...(run.errors || []).map(String).filter((e) => API_LINE.test(e)),
    ...(API_SUMMARY.test(String(run.summary || '')) ? [String(run.summary)] : []),
  ].join('\n');
  if (!evidence) return null;
  if (AUTH.test(evidence)) return 'auth';
  if (QUOTA.test(evidence)) return 'quota';
  return null;
}

function evidenceLine(run) {
  const lines = [
    ...(run.errors || []).map(String).filter((e) => API_LINE.test(e) || /PROVIDER MISMATCH/.test(e)),
    ...(API_SUMMARY.test(String(run.summary || '')) ? [String(run.summary)] : []),
  ];
  const hit = lines.find((l) => AUTH.test(l) || QUOTA.test(l) || /PROVIDER MISMATCH/.test(l)) || lines[0] || '';
  return hit.replace(/\s+/g, ' ').slice(0, 160);
}

export function loadRecentRuns(limit = 60) {
  let files;
  try { files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files
    .map((f) => { const p = path.join(RUNS_DIR, f); try { return { p, m: fs.statSync(p).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.m - a.m)
    .slice(0, limit)
    .map(({ p }) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

/**
 * The newest run that says anything about the provider decides the verdict.
 * A success clears an older failure; killed/timed-out runs are skipped because
 * they say nothing about the provider either way.
 */
export function providerVerdict(runs, now = Date.now()) {
  const finished = runs
    .filter((r) => r.finished_at)
    .sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)));
  for (const run of finished) {
    const kind = classifyRun(run);
    const ageMs = now - Date.parse(run.finished_at);
    if (kind) {
      // A daily quota resets on its own. A login and a misrouted provider don't.
      const stale = kind === 'quota' && ageMs > DAY;
      return { ok: stale, kind, stale, run, ageMs, evidence: evidenceLine(run) };
    }
    if (REACHED_PROVIDER.has(run.status)) return { ok: true, kind: null, run, ageMs };
  }
  return { ok: true, kind: null, run: null };
}

function ago(ms) {
  if (ms < 90e3) return `${Math.round(ms / 1e3)}s ago`;
  if (ms < 90 * 60e3) return `${Math.round(ms / 60e3)}m ago`;
  if (ms < 2 * DAY) return `${(ms / 3600e3).toFixed(1)}h ago`;
  return `${(ms / DAY).toFixed(1)}d ago`;
}

export function describeVerdict(v) {
  if (!v.run) return 'no finished runs yet';
  const where = `run ${v.run.run_id} (${v.run.project ?? '?'}, ${ago(v.ageMs)})`;
  if (!v.kind) return `last ${where} reached the provider normally`;
  if (v.stale) return `last provider failure was a quota 429, ${where}; daily quotas reset, no runs since`;
  const label = { auth: 'LOGIN EXPIRED/INVALID (401)', quota: 'QUOTA EXHAUSTED (429)', provider: 'WRONG PROVIDER' }[v.kind];
  const fix = {
    auth: 'log the claude CLI back in',
    quota: 'wait for the quota to reset or raise the limit',
    provider: 'the bridge ran on a non-Anthropic model; check the pinned provider settings',
  }[v.kind];
  return `${label}: ${where}: ${v.evidence} → ${fix}`;
}
