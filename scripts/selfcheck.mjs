#!/usr/bin/env node
// Entry point for the periodic self-check launchd job, and for `bridge doctor`.
//
// Writes the result where it can be read later, appends to the audit trail, and
// on a NEW failure raises a macOS notification — the missing piece last time was
// not detection but anything that told a human.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { STATE_DIR, ensureDirs } from '../src/paths.mjs';
import { runSelfCheck } from '../src/selfcheck.mjs';
import { audit } from '../src/audit.mjs';

const RESULT_FILE = path.join(STATE_DIR, 'selfcheck.json');

function notify(title, message) {
  // Best effort: a launchd agent in the GUI session can post these.
  execFile('/usr/bin/osascript', [
    '-e',
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
  ], () => {});
}

const result = await runSelfCheck();
ensureDirs();

// Compare against the previous run so a sustained outage notifies once, not
// every 15 minutes, but a newly-broken check always does.
let previousFailed = [];
try { previousFailed = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')).failed ?? []; } catch {}

try { fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2)); } catch {}

if (result.ok) {
  audit({ kind: 'selfcheck', ok: true });
  if (previousFailed.length) notify('Claude Bridge recovered', `Back to normal: ${previousFailed.join(', ')}`);
} else {
  const detail = result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(' | ');
  audit({ kind: 'selfcheck', ok: false, failed: result.failed, detail: detail.slice(0, 500) });
  const isNew = result.failed.some((f) => !previousFailed.includes(f));
  if (isNew) notify('Claude Bridge degraded', result.failed.join(', '));
}

if (process.argv.includes('--print')) {
  for (const c of result.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(16)} ${c.detail}`);
  console.log(`\n  ${result.ok ? 'all checks passed' : 'FAILED: ' + result.failed.join(', ')}${result.paused ? '  (bridge is PAUSED)' : ''}`);
}
process.exit(result.ok ? 0 : 1);
