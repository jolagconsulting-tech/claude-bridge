#!/usr/bin/env node
// PreToolUse hook — the enforcement point.
//
// Claude Code runs this before every tool call in the bridged session. Returning
// "allow" is what gives the session its autonomy (no prompts, no waiting);
// returning "deny" stops the action, records it for human confirmation, and
// tells the model not to route around it.
//
// It also takes a pre-edit snapshot of every file about to be modified, which is
// what lets the bridge report real diffs afterwards.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BRIDGE_HOME, SNAPSHOT_DIR, ensureDirs } from '../src/paths.mjs';
import { classifyToolUse, denialMessage, resolvePath } from '../src/policy.mjs';
import { isPaused, addPending, pauseReason } from '../src/state.mjs';
import { audit } from '../src/audit.mjs';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function respond(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function snapshot(toolName, toolInput, ctx, runId) {
  if (!WRITE_TOOLS.has(toolName)) return;
  const p = toolInput.file_path || toolInput.notebook_path;
  const abs = resolvePath(p, ctx);
  if (!abs) return;
  try {
    const dir = path.join(SNAPSHOT_DIR, runId);
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, 'manifest.jsonl');
    // Only snapshot the first time a path is touched in this run, so the diff
    // spans the whole run rather than just the last edit.
    if (fs.existsSync(manifestPath)) {
      const seen = fs.readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean)
        .some((l) => { try { return JSON.parse(l).path === abs; } catch { return false; } });
      if (seen) return;
    }
    const key = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 16);
    const snapPath = path.join(dir, `${key}.pre`);
    const existed = fs.existsSync(abs);
    if (existed) fs.copyFileSync(abs, snapPath);
    else fs.writeFileSync(snapPath, '');
    fs.appendFileSync(manifestPath, JSON.stringify({ path: abs, snap: snapPath, existed }) + '\n');
  } catch {
    // A failed snapshot must not block real work; the diff is just less precise.
  }
}

async function main() {
  ensureDirs();
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    // Fail closed: an unclassifiable action is treated as one needing a human.
    return respond('deny', 'BRIDGE GUARD: could not read hook input, so this action could not be checked against policy. Blocked. Stop and report this to the caller.');
  }

  // The boundary comes ONLY from the env vars the runner set on this specific
  // claude process. There is deliberately no fallback to runtime.json: that is
  // one shared file, so with two runs in flight it holds whichever started
  // last — and falling back to it could enforce project B's boundary on project
  // A's run, which is worse than failing. Absent env means deny.
  const projectDir = process.env.CLAUDE_BRIDGE_PROJECT_DIR;
  const runId = process.env.CLAUDE_BRIDGE_RUN_ID || 'unknown';
  const projectName = process.env.CLAUDE_BRIDGE_PROJECT || null;

  if (!projectDir) {
    return respond('deny', 'BRIDGE GUARD: this run carries no project boundary (CLAUDE_BRIDGE_PROJECT_DIR is unset), so nothing can be checked against policy. Blocked. Stop and report this to the caller.');
  }
  const ctx = { projectDir, bridgeHome: BRIDGE_HOME };
  const toolName = input.tool_name || 'unknown';
  const toolInput = input.tool_input || {};

  // Kill switch: honoured mid-flight, not just at run start.
  if (isPaused()) {
    const { reason } = pauseReason();
    audit({ run_id: runId, kind: 'blocked_paused', tool: toolName, input: toolInput });
    return respond(
      'deny',
      `BRIDGE PAUSED — the human operator has stopped the bridge (${reason}). ` +
      'Do not attempt any further tool calls. Stop now and summarise what you had done so far.'
    );
  }

  const verdict = classifyToolUse({ toolName, toolInput, ctx });

  if (verdict.decision === 'deny') {
    const record = addPending({
      run_id: runId,
      project: projectName,
      session_id: input.session_id || null,
      tool: toolName,
      category: verdict.category,
      reason: verdict.reason,
      detail: verdict.detail,
      tool_input: toolInput,
    });
    audit({
      run_id: runId,
      project: projectName,
      kind: 'blocked',
      tool: toolName,
      category: verdict.category,
      reason: verdict.reason,
      detail: verdict.detail,
      pending_id: record.id,
    });
    return respond('deny', denialMessage(verdict));
  }

  snapshot(toolName, toolInput, ctx, runId);
  audit({
    run_id: runId,
    project: projectName,
    kind: 'tool_allowed',
    tool: toolName,
    summary: toolName === 'Bash'
      ? String(toolInput.command || '').slice(0, 500)
      : String(toolInput.file_path || toolInput.notebook_path || toolInput.pattern || '').slice(0, 500),
  });
  return respond('allow', 'bridge guard: within autonomy policy');
}

// Fail closed. If the guard cannot run, nothing runs.
main().catch((err) => {
  try { audit({ kind: 'guard_error', error: String(err && err.stack || err) }); } catch {}
  respond('deny', `BRIDGE GUARD: policy check failed to run (${String(err && err.message || err)}). Blocked as a precaution. Stop and report this to the caller.`);
});
