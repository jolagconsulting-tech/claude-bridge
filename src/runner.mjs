// Spawns and supervises the bridged Claude Code session, parses its
// stream-json output into a structured result, and reconstructs real diffs from
// the pre-edit snapshots taken by the guard hook.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

import {
  config, ensureDirs, writeRuntime, CLAUDE_SETTINGS, BRIDGE_HOME, SNAPSHOT_DIR,
} from './paths.mjs';
import {
  isPaused, pauseReason, getSession, setSession, newSession, saveRun, loadRun,
  readPending, addPending, addActiveRun, removeActiveRun, getLiveActiveRuns,
} from './state.mjs';
import { resolveProject } from './projects.mjs';
import {
  pinnedProviderSettings, resolveBridgeModel, scrubProviderEnv, isClaudeModel, isAnthropicMessageId,
} from './provider-pin.mjs';
import { audit } from './audit.mjs';

const RUNS = new Map();

const POLICY_PROMPT = `
You are running inside CLAUDE-BRIDGE: a remote bridge that lets a Claude.ai chat
conversation drive this Claude Code session. There is NO human watching this
session live, and no one can answer a question mid-run.

Work autonomously. Read and write files, run builds, tests and linters, install
dependencies, use local/scratch databases, and use git locally (add, commit,
branch, merge, stash) without asking for permission. Do not stop to ask whether
you should proceed with ordinary development work — just do it.

A policy guard blocks a small set of actions outright: live credentials and .env
values, anything that touches a real external account (GitHub, Supabase,
Netlify, cloud providers, DNS, billing), anything that deploys or makes
something publicly live, deletion of real data, anything irreversible or with
real-world cost, and anything outside the project directory.

If the guard blocks you, that is not a bug and not something to work around.
Never look for an alternative route to a blocked action. Stop that thread of
work, complete everything else you can safely finish, and then report it.

REPORTING BLOCKED WORK — this part is mechanical and required. Whenever you were
stopped by the guard, OR you decided not to attempt something because it falls in
those categories, end your final message with one line per item, in exactly this
form, one per line, nothing else on the line:

NEEDS-HUMAN: <category> :: <the exact action, e.g. the literal command> :: <why it is needed>

Use one of these for <category>: secrets, external_account, deploy_or_publish,
destructive_data, outside_project, irreversible_or_cost, system_modification.
These lines are parsed by the bridge and shown to the human as decisions to make,
so emit them even when you already explained the same thing in prose. If nothing
was blocked or declined, emit no such lines.

Your final message is read by another AI, not a person at a terminal. Make it a
precise report: what you changed and why, what you verified and how, what
failed, and what should happen next. State facts, not reassurance.
`.trim();

/** The settings file that installs the guard hook into the child session. */
function writeClaudeSettings(model) {
  ensureDirs();
  // The hook command string is executed through a shell, so the path — which
  // contains spaces on this machine — must be quoted.
  const guard = path.join(BRIDGE_HOME, 'hooks', 'guard.mjs');
  const settings = {
    // Provider pin: Anthropic's API and a Claude model, overriding whatever the
    // user-level settings route interactive Claude Code to. See provider-pin.mjs.
    ...pinnedProviderSettings(model),
    hooks: {
      PreToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: `node ${JSON.stringify(guard)}`, timeout: 30 }] },
      ],
    },
  };
  // Written atomically: concurrent starts would otherwise let one claude read a
  // half-written settings file and come up with no guard installed.
  const tmp = `${CLAUDE_SETTINGS}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, CLAUDE_SETTINGS);
  return CLAUDE_SETTINGS;
}

function truncate(s, n) {
  if (s == null) return '';
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > n ? `${str.slice(0, n)}\n… [truncated, ${str.length - n} more chars]` : str;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n');
  }
  return String(content ?? '');
}

// --- diff reconstruction ----------------------------------------------------

function buildDiffs(runId, projectDir, maxChars) {
  const dir = path.join(SNAPSHOT_DIR, runId);
  const manifestPath = path.join(dir, 'manifest.jsonl');
  if (!fs.existsSync(manifestPath)) return [];

  const entries = fs.readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const out = [];
  for (const e of entries) {
    const rel = path.relative(projectDir, e.path) || e.path;
    const existsNow = fs.existsSync(e.path);
    let status = 'modified';
    if (!e.existed && existsNow) status = 'created';
    else if (e.existed && !existsNow) status = 'deleted';

    let diff = '';
    try {
      const current = existsNow ? e.path : '/dev/null';
      diff = execFileSync(
        'diff',
        ['-u', '-L', `a/${rel}`, '-L', `b/${rel}`, e.snap, current],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
      );
    } catch (err) {
      // diff exits 1 when files differ — that is the normal path.
      diff = err.stdout ? String(err.stdout) : `[diff unavailable: ${err.message}]`;
    }

    if (!diff.trim()) continue; // touched but unchanged

    const added = (diff.match(/^\+(?!\+\+)/gm) || []).length;
    const removed = (diff.match(/^-(?!--)/gm) || []).length;
    out.push({ path: rel, status, lines_added: added, lines_removed: removed, diff: truncate(diff, maxChars) });
  }
  return out;
}

// --- run lifecycle ----------------------------------------------------------

export function startRun({ prompt, project = null, newSessionRequested = false }) {
  const cfg = config();
  ensureDirs();

  if (isPaused()) {
    const { reason, at } = pauseReason();
    return { paused: true, reason, at };
  }

  // Only a registered project name resolves to a directory. An unknown name or
  // a path is refused here, before anything is spawned.
  let target;
  try {
    target = resolveProject(project);
  } catch (err) {
    audit({ kind: 'project_rejected', requested: project ?? null, error: err.message });
    return { unknownProject: true, message: err.message, available: err.available ?? [] };
  }

  // One run per project at a time. Two concurrent runs would resume the SAME
  // claude session id in parallel and corrupt that project's conversation
  // history. Different projects run concurrently without restriction.
  const busy = [...RUNS.values()].find((r) => r.project === target.name && r.status === 'running');
  if (busy) {
    audit({ kind: 'run_rejected_busy', project: target.name, existing_run: busy.run_id });
    return { busy: true, project: target.name, runId: busy.run_id, startedAt: busy.started_at };
  }

  // Also consult the on-disk record. Children are spawned detached, so a run
  // from a PREVIOUS server process can still be alive and working in this
  // project — invisible to the in-memory map above.
  const orphan = getLiveActiveRuns().find((r) => r.project === target.name && !RUNS.has(r.run_id));
  if (orphan) {
    audit({ kind: 'run_rejected_orphan', project: target.name, existing_run: orphan.run_id, pid: orphan.pid });
    return {
      busy: true, orphaned: true, project: target.name,
      runId: orphan.run_id, startedAt: orphan.started_at, pid: orphan.pid,
    };
  }

  // Refuse outright rather than run on anything but a Claude model.
  let model;
  try {
    model = resolveBridgeModel(cfg.model);
  } catch (err) {
    audit({ kind: 'run_refused_provider', project: target.name, error: err.message });
    return { providerRefused: true, message: err.message };
  }

  const runId = crypto.randomBytes(6).toString('hex');
  let sess = getSession(target.name);
  if (!sess || newSessionRequested || sess.project_dir !== target.path) {
    sess = newSession(target.name, target.path);
  }

  writeRuntime({ projectDir: target.path, project: target.name, runId, sessionId: sess.session_id });
  const settingsPath = writeClaudeSettings(model);

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'acceptEdits',
    '--settings', settingsPath,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--append-system-prompt', POLICY_PROMPT,
  ];
  args.push('--model', model);
  if (sess.started) args.push('--resume', sess.session_id);
  else args.push('--session-id', sess.session_id);

  const run = {
    run_id: runId,
    session_id: sess.session_id,
    project: target.name,
    project_dir: target.path,
    prompt,
    started_at: new Date().toISOString(),
    status: 'running',
    resumed: !!sess.started,
    summary: '',
    tools_used: [],
    commands_run: [],
    files_changed: [],
    errors: [],
    blocked_actions: [],
    stderr: '',
    cost_usd: null,
    turns: null,
    duration_ms: null,
  };
  RUNS.set(runId, run);

  audit({ run_id: runId, kind: 'run_start', session_id: sess.session_id, project: target.name, project_dir: target.path, prompt: truncate(prompt, 2000), resumed: run.resumed });

  const child = spawn('claude', args, {
    cwd: target.path,
    detached: true, // own process group, so we can kill the whole tree
    stdio: ['ignore', 'pipe', 'pipe'],
    // The guard hook reads its project boundary from these, NOT from the shared
    // runtime.json — two runs against different projects would otherwise race
    // on that one file and the guard could enforce the wrong boundary.
    env: {
      // Routing variables stripped: a server started from a shell that exports
      // ANTHROPIC_BASE_URL/OPENROUTER_* must not hand them to the run.
      ...scrubProviderEnv(process.env),
      CLAUDE_BRIDGE_RUN_ID: runId,
      CLAUDE_BRIDGE_PROJECT_DIR: target.path,
      CLAUDE_BRIDGE_PROJECT: target.name,
    },
  });

  run._child = child;
  addActiveRun({ run_id: runId, project: target.name, pid: child.pid, started_at: run.started_at });

  const killTree = (signal = 'SIGTERM') => {
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
  };
  run._kill = killTree;

  // Hard ceiling on wall-clock time.
  const hardTimer = setTimeout(() => {
    run.status = 'timeout';
    run.errors.push(`Run exceeded BRIDGE_MAX_RUN_SECONDS (${cfg.maxRunSeconds}s) and was killed.`);
    killTree('SIGKILL');
  }, cfg.maxRunSeconds * 1000);

  // Kill switch honoured mid-flight.
  const pauseTimer = setInterval(() => {
    if (isPaused()) {
      run.status = 'killed';
      run.errors.push(`Bridge was paused mid-run (${pauseReason().reason}); the session was stopped.`);
      killTree('SIGKILL');
    }
  }, 1000);

  child.stderr.on('data', (d) => { run.stderr += d.toString(); });

  // The bridge is pinned to Anthropic. If anything slips through anyway, stop
  // the run immediately instead of letting it work on another provider.
  const providerMismatch = (reason) => {
    if (run.status === 'provider_mismatch') return;
    run.status = 'provider_mismatch';
    run.errors.push(
      `PROVIDER MISMATCH: ${reason}. The bridge is pinned to Anthropic's API; ` +
      'this run was stopped rather than continue on another provider.'
    );
    audit({ run_id: runId, project: target.name, kind: 'provider_mismatch', reason });
    run._kill?.('SIGKILL');
  };

  const rl = readline.createInterface({ input: child.stdout });
  const pendingToolUses = new Map();

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // Non-JSON on stdout is usually the CLI complaining before it can emit a
      // proper stream (bad flags, auth prompts, crashes). Keep it — it is often
      // the only explanation available when the run then exits non-zero.
      run._stdoutNoise = ((run._stdoutNoise || '') + line + '\n').slice(-4000);
      return;
    }
    // Ring buffer of recent events, surfaced only if the run fails with no
    // other detail, so a silent exit is still diagnosable.
    (run._tail ??= []).push(`${msg.type}${msg.subtype ? '/' + msg.subtype : ''}`);
    if (run._tail.length > 40) run._tail.shift();

    if (msg.type === 'system' && msg.subtype && /error|denied|fail/i.test(msg.subtype)) {
      run.errors.push(`system/${msg.subtype}: ${truncate(JSON.stringify(msg), 600)}`);
    }

    if (msg.type === 'system' && msg.subtype === 'init') {
      if (msg.session_id) run.session_id = msg.session_id;
      run.model = msg.model ?? null;
      if (msg.model && !isClaudeModel(msg.model)) providerMismatch(`session initialised on model "${msg.model}"`);
      return;
    }

    if (msg.type === 'assistant') {
      // Tripwire: every real model reply must be a Claude model with an
      // Anthropic msg_ id. OpenRouter replies carry other model names and gen-
      // ids. Synthetic entries are Claude Code's own messages, not API replies.
      const m = msg.message?.model;
      if (m && m !== '<synthetic>') {
        if (!isClaudeModel(m)) providerMismatch(`reply came from model "${m}"`);
        else if (msg.message?.id && !isAnthropicMessageId(msg.message.id)) {
          providerMismatch(`reply id "${String(msg.message.id).slice(0, 12)}" is not an Anthropic msg_ id`);
        }
      }
      for (const c of msg.message?.content ?? []) {
        if (c.type === 'text' && c.text?.trim()) run.summary = c.text;
        if (c.type === 'tool_use') {
          run.tools_used.push(c.name);
          pendingToolUses.set(c.id, { name: c.name, input: c.input });
        }
      }
      return;
    }

    if (msg.type === 'user') {
      for (const c of msg.message?.content ?? []) {
        if (c.type !== 'tool_result') continue;
        const use = pendingToolUses.get(c.tool_use_id);
        if (!use) continue;
        pendingToolUses.delete(c.tool_use_id);
        const output = textOf(c.content);
        if (use.name === 'Bash') {
          const entry = {
            command: use.input?.command ?? '',
            failed: !!c.is_error,
            output: truncate(output, cfg.maxOutputChars),
          };
          run.commands_run.push(entry);
          audit({ run_id: runId, kind: 'command', command: entry.command, failed: entry.failed, output: truncate(output, 4000) });
        }
        if (c.is_error && use.name !== 'Bash') {
          run.errors.push(`${use.name}: ${truncate(output, 800)}`);
        }
      }
      return;
    }

    if (msg.type === 'result') {
      if (typeof msg.result === 'string' && msg.result.trim()) run.summary = msg.result;
      const foreign = Object.keys(msg.modelUsage || {}).filter((k) => !isClaudeModel(k));
      if (foreign.length) providerMismatch(`usage was billed to non-Claude model(s): ${foreign.join(', ')}`);
      run.cost_usd = msg.total_cost_usd ?? null;
      run.turns = msg.num_turns ?? null;
      run.duration_ms = msg.duration_ms ?? null;
      if (msg.is_error) {
        // The result message carries the real reason across several fields.
        // Reporting only `subtype` produced the nonsense "error result
        // (success)" — subtype describes the turn, not the failure.
        const facts = [];
        if (msg.api_error_status) facts.push(`api_error_status=${msg.api_error_status}`);
        if (msg.subtype) facts.push(`subtype=${msg.subtype}`);
        if (msg.stop_reason) facts.push(`stop_reason=${msg.stop_reason}`);
        if (msg.terminal_reason) facts.push(`terminal_reason=${msg.terminal_reason}`);
        const detail = typeof msg.result === 'string' && msg.result.trim() ? msg.result.trim() : '';
        run.errors.push(
          `Claude Code returned an error result${facts.length ? ` (${facts.join(', ')})` : ''}` +
          (detail ? `: ${truncate(detail, 1500)}` : ' — the result message carried no error text.')
        );
      }
      run._sawResult = true;
    }
  });

  run.promise = new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(hardTimer);
      clearInterval(pauseTimer);
      removeActiveRun(runId);

      // The guard catches attempted actions. This catches the other half: work
      // the session declined to even attempt because it knew the policy. Both
      // need to reach the human as an explicit decision.
      const normalize = (s) => String(s || '').toLowerCase().replace(/['"`]/g, '').replace(/\s+/g, ' ').trim();
      const alreadyRecorded = readPending({ runId, includeResolved: true })
        .map((p) => normalize(p.tool_input?.command ?? p.detail));

      for (const m of String(run.summary || '').matchAll(/^\s*NEEDS-HUMAN:\s*([^:\n]+?)\s*::\s*([\s\S]+?)\s*::\s*(.+?)\s*$/gm)) {
        const [, category, action, why] = m;
        // The guard may already have recorded this same action when the session
        // attempted it; don't show the human the same decision twice.
        const key = normalize(action);
        if (key && alreadyRecorded.some((seen) => seen.includes(key) || key.includes(seen))) continue;
        alreadyRecorded.push(key);
        addPending({
          run_id: runId,
          session_id: run.session_id,
          tool: 'declared',
          category: category.trim(),
          reason: `was declined by the session: ${why.trim()}`,
          detail: action.trim(),
          tool_input: { command: action.trim() },
        });
      }
      // Keep the prose report clean now that the lines are structured.
      run.summary = String(run.summary || '').replace(/^\s*NEEDS-HUMAN:.*$/gm, '').trimEnd();

      const blocked = readPending({ runId, includeResolved: true }).map((p) => ({
        id: p.id,
        category: p.category,
        reason: p.reason,
        tool: p.tool,
        attempted: truncate(p.tool_input?.command ?? p.detail ?? '', 600),
        status: p.status,
      }));
      run.blocked_actions = blocked;

      run.files_changed = buildDiffs(runId, run.project_dir, cfg.maxOutputChars);

      if (run.status === 'running') {
        if (isPaused()) {
          // The operator hit the kill switch from the CLI; the child was killed
          // out from under us before the poller below noticed.
          run.status = 'killed';
          run.errors.push(`Bridge was paused mid-run (${pauseReason().reason}); the session was stopped. Work completed before that point is reported above.`);
        } else if (blocked.some((b) => b.status === 'pending')) run.status = 'paused_needs_confirmation';
        else if (code === 0 && run._sawResult) run.status = 'completed';
        else run.status = 'error';
      }

      if (code !== 0 && run.status === 'error') {
        const clues = [];
        if (run.stderr?.trim()) clues.push(`stderr: ${truncate(run.stderr.trim(), 1500)}`);
        if (run._stdoutNoise?.trim()) clues.push(`non-JSON stdout: ${truncate(run._stdoutNoise.trim(), 800)}`);
        if (!run._sawResult) clues.push('the process never emitted a final result message, so it died mid-stream');
        if (run._tail?.length) clues.push(`last stream events: ${run._tail.slice(-12).join(' → ')}`);
        if (!clues.length) clues.push('no stderr, no stdout noise and a complete stream — the failure is described in the result message above');

        run.errors.push(
          (code === null
            ? 'The claude process was killed before finishing.'
            : `claude exited with code ${code}.`) + ' ' + clues.join(' | ')
        );
      }

      run.finished_at = new Date().toISOString();
      run.tools_used = [...new Set(run.tools_used)];

      // Mark the session resumable ONLY if claude actually got far enough to
      // emit a result — i.e. the session really exists on its side.
      //
      // Marking it started after a failed first run meant every later call
      // passed --resume for an id claude had never created, so the project's
      // session failed forever with no way back. If a resume attempt dies
      // without a result, clear the flag so the next call opens a fresh
      // session instead of retrying a broken one.
      const sess2 = getSession(target.name);
      if (sess2 && sess2.session_id === run.session_id) {
        const reallyStarted = sess2.started ? run._sawResult : !!run._sawResult;
        setSession(target.name, {
          ...sess2,
          started: reallyStarted,
          turns: (sess2.turns || 0) + 1,
          last_run: runId,
          last_used_at: run.finished_at,
        });
        if (sess2.started && !run._sawResult) {
          audit({
            run_id: runId, project: target.name, kind: 'session_reset',
            reason: 'resume produced no result message; the session id looks unusable, so the next run will start fresh',
            session_id: run.session_id,
          });
          run.errors.push(
            'This session could not be resumed and produced no result. It has been marked unusable — ' +
            'the next call against this project will start a fresh session automatically.'
          );
        }
      }

      saveRun(publicView(run));
      audit({
        run_id: runId, kind: 'run_end', status: run.status, exit_code: code,
        files_changed: run.files_changed.map((f) => f.path),
        commands: run.commands_run.length, blocked: blocked.length, cost_usd: run.cost_usd,
      });
      resolve(run);
    });

    child.on('error', (err) => {
      clearTimeout(hardTimer);
      clearInterval(pauseTimer);
      removeActiveRun(runId);
      run.status = 'error';
      run.errors.push(`Failed to launch claude: ${err.message}`);
      run.finished_at = new Date().toISOString();
      saveRun(publicView(run));
      audit({ run_id: runId, kind: 'run_error', error: err.message });
      resolve(run);
    });
  });

  return run;
}

export function publicView(run) {
  const {
    run_id, session_id, project, project_dir, prompt, status, started_at, finished_at,
    summary, tools_used, commands_run, files_changed, errors, blocked_actions,
    cost_usd, turns, duration_ms, resumed, model,
  } = run;
  return {
    run_id, session_id, project, project_dir, status, resumed,
    started_at, finished_at: finished_at ?? null,
    prompt: truncate(prompt, 1000),
    summary, tools_used: [...new Set(tools_used)],
    commands_run, files_changed, errors, blocked_actions,
    cost_usd, turns, duration_ms, model: model ?? null,
  };
}

export async function waitFor(runId, seconds) {
  const run = RUNS.get(runId);
  if (!run) return loadRun(runId);
  const timeout = new Promise((r) => setTimeout(() => r('__timeout__'), Math.max(1, seconds) * 1000));
  const winner = await Promise.race([run.promise, timeout]);
  if (winner === '__timeout__') {
    return { ...publicView(run), status: 'running', note: 'Still running. Call check_run with this run_id for the final result; work continues in the background.' };
  }
  return publicView(run);
}

export function getRun(runId) {
  const run = RUNS.get(runId);
  return run ? publicView(run) : loadRun(runId);
}

export function stopRun(runId) {
  const run = RUNS.get(runId);
  if (!run || !run._kill) return false;
  run.status = 'killed';
  run.errors.push('Run was stopped on request.');
  run._kill('SIGKILL');
  audit({ run_id: runId, kind: 'run_stopped' });
  return true;
}

export function activeRunIds() {
  return [...RUNS.values()].filter((r) => r.status === 'running').map((r) => r.run_id);
}
