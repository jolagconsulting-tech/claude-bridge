// MCP tool surface exposed to the Claude.ai conversation.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { config } from './paths.mjs';
import { startRun, waitFor, getRun, stopRun, activeRunIds } from './runner.mjs';
import {
  isPaused, pauseReason, pause, resume, listSessions, readPending, resolvePending, getActiveRuns,
} from './state.mjs';
import { listProjects } from './projects.mjs';
import { tailAudit } from './audit.mjs';

const text = (s) => ({ content: [{ type: 'text', text: s }] });

function formatRun(run) {
  if (!run) return 'No such run.';
  const L = [];
  L.push(`## Run ${run.run_id} — ${run.status.toUpperCase()}`);
  L.push(`project: \`${run.project ?? '?'}\` (${run.project_dir})`);
  L.push(`session: ${run.session_id} (${run.resumed ? 'continued' : 'new'})`);
  if (run.duration_ms != null) L.push(`turns: ${run.turns} · ${(run.duration_ms / 1000).toFixed(1)}s · $${(run.cost_usd ?? 0).toFixed(4)}`);

  if (run.status === 'running') {
    L.push('\n**Still running in the background.** Call `check_run` with this run_id.');
  }

  if (run.blocked_actions?.length) {
    L.push('\n### ⛔ NEEDS HUMAN CONFIRMATION');
    L.push('The session was blocked from these actions and did not attempt to work around them:');
    for (const b of run.blocked_actions) {
      L.push(`\n- **[${b.id}]** _${b.category}_ — this action ${b.reason}.`);
      L.push(`  - tool: \`${b.tool}\``);
      if (b.attempted) L.push(`  - attempted: \`\`\`\n${b.attempted}\n\`\`\``);
      L.push(`  - status: ${b.status}`);
    }
    L.push('\nRelay these to the human. Once handled, call `resolve_confirmation` and send the next instruction.');
  }

  if (run.files_changed?.length) {
    L.push(`\n### Files changed (${run.files_changed.length})`);
    for (const f of run.files_changed) {
      L.push(`\n**${f.path}** — ${f.status}, +${f.lines_added}/-${f.lines_removed}`);
      L.push('```diff');
      L.push(f.diff.trim());
      L.push('```');
    }
  } else if (run.status !== 'running') {
    L.push('\n### Files changed\n_None._');
  }

  if (run.commands_run?.length) {
    L.push(`\n### Commands run (${run.commands_run.length})`);
    for (const c of run.commands_run) {
      L.push(`\n\`$ ${c.command}\`${c.failed ? '  ← **FAILED**' : ''}`);
      if (c.output?.trim()) {
        L.push('```');
        L.push(c.output.trim());
        L.push('```');
      }
    }
  }

  if (run.errors?.length) {
    L.push('\n### Errors');
    for (const e of run.errors) L.push(`- ${e}`);
  }

  L.push('\n### Session report');
  L.push(run.summary?.trim() || '_(no final message)_');
  return L.join('\n');
}

export function createServer() {
  const cfg = config();
  const server = new McpServer(
    { name: 'claude-bridge', version: '0.1.0' },
    {
      instructions:
        'Bridge to a live Claude Code session on the user\'s machine. `run_claude_code` sends an ' +
        'instruction and returns what actually happened: diffs, command output, errors. The session ' +
        'is continuous — later calls keep the context and file state of earlier ones. Ordinary dev ' +
        'work runs fully autonomously. Actions touching live secrets, real external accounts, ' +
        'deploys, real data deletion, cost, or anything outside the project directory are blocked ' +
        'and returned as "needs human confirmation" — relay those to the human rather than retrying.',
    }
  );

  server.registerTool(
    'run_claude_code',
    {
      title: 'Run Claude Code',
      description:
        'Send an instruction to the continuing Claude Code session in the project directory and get ' +
        'back a structured report of what it did: files changed with diffs, commands run with output, ' +
        'errors, and anything blocked pending human confirmation. Context and file state carry over ' +
        'between calls. Long runs return status "running" with a run_id — poll it with check_run.',
      inputSchema: {
        prompt: z.string().min(1).describe('The instruction for Claude Code. Be specific; no human is watching the session.'),
        project: z.string().optional()
          .describe('Registered project NAME to run against (see bridge_status for the list). Omit to use the default. This is a name, never a path — directories must be registered by a human at the machine before the bridge can reach them.'),
        wait_seconds: z.number().int().min(5).max(3600).optional()
          .describe(`How long to wait before returning a partial "running" result (default ${cfg.defaultWaitSeconds}).`),
        new_session: z.boolean().optional()
          .describe("Start a fresh session for this project instead of continuing it. Discards that project's accumulated context; other projects are unaffected."),
      },
    },
    async ({ prompt, project, wait_seconds, new_session }) => {
      const run = startRun({ prompt, project, newSessionRequested: !!new_session });
      if (run.paused) {
        return text(
          `## ⏸ BRIDGE PAUSED\n\nThe human operator has paused the bridge (${run.reason}, at ${run.at}).\n` +
          'Nothing was run. The bridge stays paused until they resume it with `npm run bridge -- resume`.'
        );
      }
      if (run.providerRefused) {
        return text(`## ⛔ PROVIDER REFUSED\n\n${run.message}\n\nNothing was run.`);
      }
      if (run.busy) {
        return text(
          `## ⏳ PROJECT ALREADY RUNNING\n\nA run is already in flight for \`${run.project}\` ` +
          `(run_id \`${run.runId}\`, started ${run.startedAt}).\n\n` +
          (run.orphaned
            ? `⚠ That run is **orphaned** (pid ${run.pid}): it survived a bridge restart, so it is still ` +
              `working in the project but its output is no longer being captured and \`check_run\` cannot ` +
              `reach it. A human needs to decide whether to let it finish or stop it: \`kill ${run.pid}\`.\n\n`
            : '') +
          'Nothing new was started. Two runs against one project would resume the same session in ' +
          'parallel and corrupt its history, so the bridge serialises them per project.\n\n' +
          `Use \`check_run\` with \`${run.runId}\` to follow it, \`stop_run\` to kill it, or send this ` +
          'instruction to a different project — other projects run concurrently without restriction.'
        );
      }
      if (run.unknownProject) {
        return text(
          `## ⛔ PROJECT NOT REGISTERED\n\n${run.message}\n\n` +
          (run.available.length ? `**Registered projects:** ${run.available.map((n) => `\`${n}\``).join(', ')}\n\n` : '') +
          'Nothing was run. Registering a project is deliberately a local-only step — relay this to the human ' +
          'if a new directory needs to be added.'
        );
      }
      const result = await waitFor(run.run_id, wait_seconds ?? cfg.defaultWaitSeconds);
      return text(formatRun(result));
    }
  );

  server.registerTool(
    'check_run',
    {
      title: 'Check run',
      description: 'Get the current or final result of a run started by run_claude_code.',
      inputSchema: {
        run_id: z.string().describe('The run_id returned by run_claude_code.'),
        wait_seconds: z.number().int().min(0).max(3600).optional()
          .describe('Optionally wait up to this long for the run to finish before returning.'),
      },
    },
    async ({ run_id, wait_seconds }) => {
      const result = wait_seconds ? await waitFor(run_id, wait_seconds) : getRun(run_id);
      return text(formatRun(result));
    }
  );

  server.registerTool(
    'bridge_status',
    {
      title: 'Bridge status',
      description: 'Current state of the bridge: paused or live, project directory, session, active runs, and outstanding confirmations.',
      inputSchema: {},
    },
    async () => {
      const pending = readPending();
      const active = getActiveRuns();
      const projects = listProjects();
      const sessions = new Map(listSessions().map((s) => [s.project, s]));

      const L = [
        `## Bridge status: ${isPaused() ? '⏸ PAUSED' : '▶ live'}`,
        isPaused() ? `Reason: ${pauseReason().reason} (since ${pauseReason().at})` : '',
        '',
        `### Registered projects (${projects.length})`,
      ].filter(Boolean);

      if (!projects.length) {
        L.push('_None. A human must register one at the machine: `bridge project add <name> <path>`_');
      } else {
        for (const p of projects) {
          const s = sessions.get(p.name);
          const bits = [
            s ? `session ${s.session_id.slice(0, 8)}… (${s.turns || 0} turns${s.last_used_at ? `, last used ${s.last_used_at}` : ''})` : 'no session yet',
            p.is_default ? '**default**' : '',
            p.exists ? '' : '⚠ directory missing',
          ].filter(Boolean);
          L.push(`- \`${p.name}\` — ${p.path}`);
          L.push(`  ${bits.join(' · ')}`);
        }
        L.push('');
        L.push('Pass `project: "<name>"` to `run_claude_code` to target one; omit it for the default.');
      }

      L.push('');
      L.push(`Active runs: ${active.length ? active.map((a) => `${a.run_id} (${a.project}, pid ${a.pid}, since ${a.started_at})`).join('; ') : 'none'}`);
      L.push(`In-process runs: ${activeRunIds().join(', ') || 'none'}`);
      L.push(`Outstanding confirmations: ${pending.length}`);
      for (const p of pending) L.push(`  - [${p.id}] ${p.project ? `(${p.project}) ` : ''}${p.category}: this action ${p.reason}`);
      return text(L.join('\n'));
    }
  );

  server.registerTool(
    'list_pending_confirmations',
    {
      title: 'List pending confirmations',
      description: 'Every action the policy guard blocked that is still waiting on a human decision.',
      inputSchema: { include_resolved: z.boolean().optional() },
    },
    async ({ include_resolved }) => {
      const pending = readPending({ includeResolved: !!include_resolved });
      if (!pending.length) return text('No pending confirmations.');
      return text(pending.map((p) => [
        `### [${p.id}] ${p.category} — ${p.status}`,
        `At ${p.at} · run ${p.run_id} · tool \`${p.tool}\``,
        `This action ${p.reason}.`,
        p.tool_input?.command ? '```\n' + p.tool_input.command + '\n```' : (p.detail ? `Target: \`${p.detail}\`` : ''),
        p.note ? `Note: ${p.note}` : '',
      ].filter(Boolean).join('\n')).join('\n\n'));
    }
  );

  server.registerTool(
    'resolve_confirmation',
    {
      title: 'Resolve confirmation',
      description:
        'Record the human decision on a blocked action. Use "done_by_human" when the human performed ' +
        'it themselves, "rejected" when it should not happen. This does NOT execute the action — the ' +
        'bridge never performs blocked actions.',
      inputSchema: {
        id: z.string().describe('The confirmation id, e.g. from list_pending_confirmations.'),
        decision: z.enum(['done_by_human', 'rejected']),
        note: z.string().optional().describe('What the human did or decided, so the audit log records it.'),
      },
    },
    async ({ id, decision, note }) => {
      const updated = resolvePending(id, decision, note);
      if (!updated) return text(`No confirmation with id ${id}.`);
      return text(
        `Confirmation [${id}] marked **${decision}**.${note ? ` Note: ${note}` : ''}\n\n` +
        'Send the next instruction with `run_claude_code` — tell the session what the human did so it can carry on.'
      );
    }
  );

  server.registerTool(
    'stop_run',
    {
      title: 'Stop run',
      description: 'Immediately kill an in-flight run. Does not pause the bridge; further calls still work.',
      inputSchema: { run_id: z.string() },
    },
    async ({ run_id }) => text(stopRun(run_id) ? `Run ${run_id} killed.` : `Run ${run_id} is not active in this process.`)
  );

  server.registerTool(
    'read_audit_log',
    {
      title: 'Read audit log',
      description: 'Tail the timestamped audit trail of every tool call, command, and blocked action.',
      inputSchema: {
        lines: z.number().int().min(1).max(1000).optional(),
        run_id: z.string().optional(),
      },
    },
    async ({ lines, run_id }) => {
      const entries = tailAudit(lines ?? 60, run_id ?? null);
      if (!entries.length) return text('Audit log is empty.');
      return text('```json\n' + entries.map((e) => JSON.stringify(e)).join('\n') + '\n```');
    }
  );

  return server;
}

export { formatRun };
