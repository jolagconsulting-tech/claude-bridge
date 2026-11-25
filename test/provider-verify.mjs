// End-to-end proof that a bridge run talks to Anthropic, not OpenRouter.
//   node test/provider-verify.mjs [project] [https://public-url]
//
// [project] is a registered project name; omit it to use the bridge's default.
// [public-url] defaults to BRIDGE_PUBLIC_URL, then to the local listener.
//
// Three independent kinds of evidence, gathered during and after one real run:
//  1. network: the run's process group's live TCP connections, mapped against
//     the current IPs of api.anthropic.com and openrouter.ai;
//  2. protocol: Anthropic replies carry msg_ / toolu_ ids and claude-* models,
//     OpenRouter replies carry gen- / call_ ids and other model names;
//  3. the bridge's own verdict: status, model, and any PROVIDER MISMATCH.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns/promises';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config, STATE_DIR, RUNS_DIR } from '../src/paths.mjs';
import { listProjects } from '../src/projects.mjs';

const cfg = config();
// Project name and public URL are inputs, not constants: pass them as arguments
// or set BRIDGE_PUBLIC_URL. Falls back to the local listener.
const project = process.argv[2] || process.env.BRIDGE_PROJECT
  || listProjects().find((p) => p.is_default)?.name;
if (!project) {
  console.error('No project given and no default registered. Usage: node test/provider-verify.mjs [project] [https://public-url]');
  process.exit(1);
}
const base = (process.argv[3] || process.env.BRIDGE_PUBLIC_URL || `http://127.0.0.1:${cfg.port}`).replace(/\/$/, '');
const ips = async (h) => { try { return (await dns.resolve4(h)); } catch { return []; } };
const ANTH = new Set(await ips('api.anthropic.com'));
const OR = new Set(await ips('openrouter.ai'));
console.log(`api.anthropic.com → ${[...ANTH].join(', ')}\nopenrouter.ai     → ${[...OR].join(', ')}\n`);

const t = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${cfg.token}` } } });
const c = new Client({ name: 'provider-verify', version: '1' }); await c.connect(t);
const call = c.callTool({ name: 'run_claude_code', arguments: { project, wait_seconds: 300, new_session: true,
  prompt: 'Provider verification. Run exactly `sleep 10` with Bash, then reply with the single word VERIFIED. Change nothing.' } },
  undefined, { timeout: 600000 });

// sample the run's process group while it works
const seen = new Map();
const activeFile = path.join(STATE_DIR, 'active-run.json');
let pgid = null; const until = Date.now() + 240000; let done = false;
call.finally(() => { done = true; });
while (!done && Date.now() < until) {
  try { const a = JSON.parse(fs.readFileSync(activeFile, 'utf8')); const r = (Array.isArray(a) ? a : [a]).find((x) => x.project === project); if (r) pgid = r.pid; } catch {}
  if (pgid) {
    try {
      const out = execFileSync('lsof', ['-a', '-g', String(pgid), '-iTCP', '-sTCP:ESTABLISHED', '-nP', '-Fn'], { encoding: 'utf8' });
      for (const line of out.split('\n')) { const m = line.match(/^n.*->\[?([0-9a-f.:]+?)\]?:(\d+)$/); if (m) seen.set(`${m[1]}:${m[2]}`, (seen.get(`${m[1]}:${m[2]}`) || 0) + 1); }
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 700));
}
const res = await call; await c.close();
const text = res.content.map((x) => x.text).join('\n');
const runId = (text.match(/## Run ([0-9a-f]{12})/) || [])[1];
console.log('bridge said:', (text.match(/## Run .*/) || ['?'])[0]);

console.log('\n1) NETWORK — remote endpoints the run process group held open:');
if (!seen.size) console.log('   (none observed)');
let toAnth = 0, toOR = 0;
for (const [ep, n] of seen) { const ip = ep.replace(/:\d+$/, ''); const tag = ANTH.has(ip) ? 'api.anthropic.com' : OR.has(ip) ? 'OPENROUTER.AI' : 'other'; if (tag === 'api.anthropic.com') toAnth++; if (tag === 'OPENROUTER.AI') toOR++; console.log(`   ${ep.padEnd(24)} ${tag}  (${n} samples)`); }

const run = runId ? JSON.parse(fs.readFileSync(path.join(RUNS_DIR, `${runId}.json`), 'utf8')) : null;
console.log('\n2) PROTOCOL — from the run transcript:');
let msgIds = new Set(), toolIds = new Set(), models = new Set();
if (run) {
  const proj = listProjects().find((p) => p.name === project).path;
  const f = path.join(os.homedir(), '.claude', 'projects', proj.replace(/[^A-Za-z0-9]/g, '-'), `${run.session_id}.jsonl`);
  if (fs.existsSync(f)) for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type !== 'assistant' || !e.message?.model || e.message.model === '<synthetic>') continue;
    models.add(e.message.model); msgIds.add(String(e.message.id).slice(0, 4));
    for (const x of e.message.content || []) if (x.type === 'tool_use') toolIds.add(String(x.id).slice(0, 5));
  }
}
console.log(`   models: ${[...models].join(', ') || '(none)'}\n   message id prefixes: ${[...msgIds].join(', ') || '(none)'}\n   tool_use id prefixes: ${[...toolIds].join(', ') || '(none)'}`);
console.log('\n3) BRIDGE VERDICT:', run ? `status=${run.status} model=${run.model} errors=${(run.errors || []).length}` : '(no run record)');
for (const e of run?.errors || []) console.log('   -', String(e).slice(0, 200));

const onAnthropic = toAnth > 0 && toOR === 0 && [...models].length > 0 && [...models].every((m) => /^claude-/.test(m)) && [...msgIds].every((p) => p === 'msg_');
console.log(`\nVERDICT: ${onAnthropic ? 'ON ANTHROPIC — network, protocol and model all agree' : toOR ? 'CONTACTED OPENROUTER' : 'NOT PROVEN (see above)'}`);
process.exit(onAnthropic ? 0 : 1);
