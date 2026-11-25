#!/usr/bin/env node
// Operator CLI — the human's manual control over the bridge.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { BRIDGE_HOME, config, ensureDirs, AUDIT_LOG } from '../src/paths.mjs';
import {
  isPaused, pauseReason, pause, resume, listSessions, clearSession, getActiveRuns, removeActiveRun,
  readPending, resolvePending,
} from '../src/state.mjs';
import { listProjects, registerProject, removeProject, setDefaultProject } from '../src/projects.mjs';
import { tailAudit, audit } from '../src/audit.mjs';
import { classifyCommand } from '../src/policy.mjs';

const [, , cmd, ...rest] = process.argv;
ensureDirs();

function killActive() {
  // Kill every in-flight run, not just one — several can be running at once.
  const runs = getActiveRuns();
  let killed = 0;
  for (const active of runs) {
    if (!active?.pid) continue;
    try { process.kill(-active.pid, 'SIGKILL'); killed++; } catch {
      try { process.kill(active.pid, 'SIGKILL'); killed++; } catch { continue; }
    }
    removeActiveRun(active.run_id);
    audit({ kind: 'cli_kill', pid: active.pid, run_id: active.run_id, project: active.project });
  }
  return killed;
}

const commands = {
  init() {
    const envPath = path.join(BRIDGE_HOME, '.env');
    if (fs.existsSync(envPath)) {
      console.log(`.env already exists at ${envPath} — leaving it alone.`);
      return;
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const projectDir = rest[0] ? path.resolve(rest[0]) : '/absolute/path/to/your/project';
    fs.writeFileSync(envPath, [
      '# Directory the bridged Claude Code session works in. It cannot act outside this.',
      `BRIDGE_PROJECT_DIR=${projectDir}`,
      '',
      '# Shared secret for the remote endpoint. Anyone with this runs code on this machine.',
      `BRIDGE_TOKEN=${token}`,
      '',
      'BRIDGE_PORT=8787',
      'BRIDGE_HOST=127.0.0.1',
      '',
      '# Hard ceiling on a single run, and how long a tool call waits before',
      '# returning a "still running" result the caller can poll.',
      'BRIDGE_MAX_RUN_SECONDS=1800',
      'BRIDGE_DEFAULT_WAIT_SECONDS=240',
      'BRIDGE_MAX_OUTPUT_CHARS=4000',
      '',
      '# Optional: pin a model, e.g. opus / sonnet',
      '# BRIDGE_MODEL=',
      '',
    ].join('\n'));
    console.log(`Wrote ${envPath}`);
    console.log(`Token: ${token}`);
    if (!rest[0]) console.log('\n⚠  Set BRIDGE_PROJECT_DIR to a real path before starting.');
  },

  status() {
    const cfg = config();
    const active = getActiveRuns();
    const pending = readPending();
    const projects = listProjects();
    const sessions = new Map(listSessions().map((s) => [s.project, s]));
    console.log(`state          ${isPaused() ? `PAUSED — ${pauseReason().reason} (${pauseReason().at})` : 'live'}`);
    console.log(`endpoint       http://${cfg.host}:${cfg.port}/mcp`);
    console.log(`active runs    ${active.length ? active.map((a) => `${a.run_id} (${a.project}) pid ${a.pid}`).join(', ') : 'none'}`);
    console.log(`pending        ${pending.length}`);
    for (const p of pending) console.log(`  [${p.id}] ${p.project ? `(${p.project}) ` : ''}${p.category}: this action ${p.reason}`);
    console.log(`projects       ${projects.length}`);
    for (const p of projects) {
      const s = sessions.get(p.name);
      console.log(`  ${p.is_default ? '*' : ' '} ${p.name.padEnd(18)} ${p.path}${p.exists ? '' : '  ⚠ MISSING'}`);
      console.log(`    ${s ? `session ${s.session_id.slice(0, 8)}… ${s.turns || 0} turns` : 'no session yet'}`);
    }
    if (projects.length) console.log('  (* = default, used when a call omits `project`)');
  },

  project() {
    const [sub, ...args] = rest;
    if (sub === 'add') {
      const [name, dir] = args;
      if (!name || !dir) { console.log('usage: bridge project add <name> <path>'); return; }
      try {
        const p = registerProject(name, dir);
        audit({ kind: 'project_registered', name, path: p.path });
        console.log(`registered "${name}" → ${p.path}`);
        console.log('It is now reachable through the bridge as: project: "' + name + '"');
      } catch (err) { console.error(`refused: ${err.message}`); process.exitCode = 1; }
    } else if (sub === 'remove' || sub === 'rm') {
      const [name] = args;
      const removed = removeProject(name);
      if (removed) { clearSession(name); audit({ kind: 'project_removed', name }); console.log(`removed "${name}" (${removed.path}); its session was discarded`); }
      else console.log(`"${name}" is not registered.`);
    } else if (sub === 'default') {
      const [name] = args;
      try { setDefaultProject(name); console.log(`default project is now "${name}"`); }
      catch (err) { console.error(err.message); process.exitCode = 1; }
    } else {
      const projects = listProjects();
      if (!projects.length) { console.log('No projects registered.\n  bridge project add <name> <path>'); return; }
      const sessions = new Map(listSessions().map((s) => [s.project, s]));
      for (const p of projects) {
        const s = sessions.get(p.name);
        console.log(`${p.is_default ? '*' : ' '} ${p.name.padEnd(18)} ${p.path}${p.exists ? '' : '  ⚠ MISSING'}`);
        console.log(`    ${s ? `session ${s.session_id.slice(0, 8)}… · ${s.turns || 0} turns · added ${p.added_at}` : `no session yet · added ${p.added_at}`}`);
      }
      console.log('\n* = default');
    }
  },

  // The kill switch: stop anything in flight AND refuse further work.
  stop() {
    const reason = rest.join(' ') || 'stopped by human';
    pause(reason);
    const killed = killActive();
    audit({ kind: 'cli_stop', reason });
    console.log(`⏸  Bridge PAUSED (${reason}).`);
    console.log(killed ? `   ${killed} in-flight run(s) killed.` : '   No run was in flight.');
    console.log('   Resume with: npm run bridge -- resume');
  },

  pause() { commands.stop(); },

  resume() {
    if (!isPaused()) { console.log('Bridge is already live.'); return; }
    resume();
    audit({ kind: 'cli_resume' });
    console.log('▶  Bridge resumed.');
  },

  kill() {
    const n = killActive();
    console.log(n ? `Killed ${n} in-flight run(s) (bridge stays live).` : 'No run in flight.');
  },

  pending() {
    const all = readPending({ includeResolved: rest.includes('--all') });
    if (!all.length) { console.log('No pending confirmations.'); return; }
    for (const p of all) {
      console.log(`\n[${p.id}] ${p.category} — ${p.status}  (${p.at})`);
      console.log(`  this action ${p.reason}`);
      console.log(`  tool: ${p.tool}`);
      if (p.tool_input?.command) console.log(`  command: ${p.tool_input.command}`);
      else if (p.detail) console.log(`  target: ${p.detail}`);
    }
  },

  resolve() {
    const [id, decision, ...note] = rest;
    if (!id || !['done_by_human', 'rejected'].includes(decision)) {
      console.log('usage: bridge resolve <id> <done_by_human|rejected> [note...]');
      return;
    }
    const r = resolvePending(id, decision, note.join(' '));
    console.log(r ? `[${id}] → ${decision}` : `No confirmation with id ${id}.`);
  },

  logs() {
    const n = Number(rest[0]) || 40;
    if (rest.includes('--follow') || rest.includes('-f')) {
      execFileSync('tail', ['-f', '-n', String(n), AUDIT_LOG], { stdio: 'inherit' });
      return;
    }
    for (const e of tailAudit(n)) console.log(JSON.stringify(e));
  },

  // Dry-run a command against the policy without executing anything.
  policy() {
    const cmdStr = rest.join(' ');
    if (!cmdStr) { console.log('usage: bridge policy "<shell command>"'); return; }
    const cfg = config();
    const hit = classifyCommand(cmdStr, { projectDir: cfg.projectDir, bridgeHome: BRIDGE_HOME });
    if (hit) console.log(`BLOCKED (${hit.cat}) — this action ${hit.why}\n  segment: ${hit.segment}`);
    else console.log('ALLOWED — runs autonomously.');
  },

  async doctor() {
    const { runSelfCheck } = await import('../src/selfcheck.mjs');
    const r = await runSelfCheck();
    for (const c of r.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(16)} ${c.detail}`);
    console.log(`\n  ${r.ok ? 'all checks passed' : 'FAILED: ' + r.failed.join(', ')}${r.paused ? '  (bridge is PAUSED)' : ''}`);
    process.exitCode = r.ok ? 0 : 1;
  },

  token() {
    const cfg = config();
    console.log(cfg.token || '(no BRIDGE_TOKEN set)');
  },

  help() {
    console.log(`
claude-bridge — control the Claude Chat ↔ Claude Code bridge

  bridge init [projectDir]     create .env with a fresh token
  bridge status                show state, projects, sessions, active run, pending

  bridge project               list registered projects
  bridge project add <name> <path>    register a project (LOCAL ONLY — the
                               bridge refuses any directory not added this way)
  bridge project remove <name> unregister and discard its session
  bridge project default <name>       set the project used when a call omits one
  bridge stop [reason]         KILL SWITCH — pause the bridge and kill any run
  bridge resume                lift the pause
  bridge kill                  kill the in-flight run only, stay live
  bridge pending [--all]       list actions awaiting human confirmation
  bridge resolve <id> <done_by_human|rejected> [note]
  bridge logs [n] [-f]         tail the audit trail
  bridge policy "<command>"    dry-run a command against the policy
  bridge doctor                run the self-check now
  bridge token                 print the endpoint token
`);
  },
};

(commands[cmd] || commands.help)();
