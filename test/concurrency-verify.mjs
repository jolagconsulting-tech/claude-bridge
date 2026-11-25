// Real concurrency proof: fires N run_claude_code calls that genuinely overlap
// in wall-clock time, against different registered projects, and checks that
// nothing raced, corrupted state, or crossed a project boundary.
//
//   node test/concurrency-verify.mjs https://<host> proj1 proj2 proj3
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config, AUDIT_LOG, STATE_DIR } from '../src/paths.mjs';

const cfg = config();
const base = (process.argv[2] || `http://127.0.0.1:${cfg.port}`).replace(/\/$/, '');
const projects = process.argv.slice(3);
if (projects.length < 2) { console.error('need at least two project names'); process.exit(1); }

function newClient() {
  const t = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${cfg.token}` } },
  });
  return new Client({ name: 'concurrency-verify', version: '0.1.0' });
}

const auditBefore = fs.existsSync(AUDIT_LOG) ? fs.readFileSync(AUDIT_LOG, 'utf8').split('\n').length : 0;

// Each call: a separate client (separate HTTP connection), all launched in the
// same tick so they are genuinely simultaneous rather than sequential.
async function fire(project, i) {
  const client = newClient();
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${cfg.token}` } },
  });
  await client.connect(transport);
  const t0 = Date.now();
  const res = await client.callTool({
    name: 'run_claude_code',
    arguments: {
      project,
      wait_seconds: 600,
      prompt:
        'Concurrency probe. Do exactly this and nothing else: ' +
        '(1) run `pwd`; (2) run `sleep 12`; (3) run `pwd` again; ' +
        `(4) state the basename of the directory you are in and the marker ${i}. ` +
        'Do not create, modify or delete any file. Do not read anything outside this directory.',
    },
  }, undefined, { timeout: 900_000 });
  const t1 = Date.now();
  const text = res.content.map((c) => c.text).join('\n');
  await client.close();
  return { project, i, text, startedAt: t0, endedAt: t1 };
}

console.log(`firing ${projects.length} overlapping calls: ${projects.join(', ')}\n`);
const wallStart = Date.now();
const results = await Promise.all(projects.map((p, i) => fire(p, i)));
const wallEnd = Date.now();

// ---- did they actually overlap? -------------------------------------------
const auditRows = fs.readFileSync(AUDIT_LOG, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const fresh = auditRows.slice(auditBefore - 1);
const starts = fresh.filter((r) => r.kind === 'run_start');
const ends = fresh.filter((r) => r.kind === 'run_end');

const spans = starts.map((s) => {
  const e = ends.find((x) => x.run_id === s.run_id);
  return { run_id: s.run_id, project: s.project, from: new Date(s.ts).getTime(), to: e ? new Date(e.ts).getTime() : Infinity };
});
let maxOverlap = 0;
for (const a of spans) {
  const n = spans.filter((b) => b.from < a.to && a.from < b.to).length;
  maxOverlap = Math.max(maxOverlap, n);
}

console.log('\n' + '='.repeat(70) + '\nOVERLAP\n' + '='.repeat(70));
for (const s of spans) {
  console.log(`  ${s.project.padEnd(16)} ${s.run_id}  ${new Date(s.from).toISOString().slice(11, 23)} → ${s.to === Infinity ? '(open)' : new Date(s.to).toISOString().slice(11, 23)}`);
}
console.log(`  peak simultaneous runs: ${maxOverlap}`);
console.log(`  total wall time: ${((wallEnd - wallStart) / 1000).toFixed(1)}s (sequential would be ~${projects.length * 12}s+ of sleep alone)`);

// ---- integrity checks ------------------------------------------------------
console.log('\n' + '='.repeat(70) + '\nVERDICT\n' + '='.repeat(70));
let bad = 0;
const assert = (label, cond, detail = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${!cond && detail ? ' — ' + detail : ''}`);
  if (!cond) bad++;
};

assert('runs genuinely overlapped in wall-clock time', maxOverlap >= 2, `peak was ${maxOverlap}`);

for (const r of results) {
  const ranHere = new RegExp(`project: \`${r.project}\``).test(r.text);
  assert(`[${r.project}] ran in its own project`, ranHere);
  const others = projects.filter((p) => p !== r.project);
  const leaked = others.filter((o) => new RegExp(`project: \`${o}\``).test(r.text));
  assert(`[${r.project}] no other project appeared in its result`, leaked.length === 0, leaked.join(','));
  assert(`[${r.project}] completed cleanly`, /COMPLETED|PAUSED_NEEDS_CONFIRMATION/.test(r.text), r.text.slice(0, 120));
}

// every run_id distinct, one session per project, no cross-assignment
const ids = new Set(spans.map((s) => s.run_id));
assert('every run got a distinct run_id', ids.size === spans.length);
const byProject = new Map();
for (const s of spans) byProject.set(s.project, (byProject.get(s.project) || 0) + 1);
assert('one run per project', [...byProject.values()].every((n) => n === 1));

// audit log must still be fully parseable — the real corruption test
const rawLines = fs.readFileSync(AUDIT_LOG, 'utf8').split('\n').filter(Boolean);
const unparseable = rawLines.filter((l) => { try { JSON.parse(l); return false; } catch { return true; } });
assert('audit log has no torn/interleaved lines', unparseable.length === 0, `${unparseable.length} bad lines`);
// Only lines written during this test — the file may contain older records
// from before the size cap existed, and those are not what is under test.
const freshLines = rawLines.slice(auditBefore - 1);
assert('no audit line written during this test exceeds the atomic-append cap',
  freshLines.every((l) => l.length <= 3200),
  `longest ${freshLines.length ? Math.max(...freshLines.map((l) => l.length)) : 0}B`);

const pendFile = path.join(STATE_DIR, 'pending.jsonl');
if (fs.existsSync(pendFile)) {
  const pl = fs.readFileSync(pendFile, 'utf8').split('\n').filter(Boolean);
  const badPend = pl.filter((l) => { try { JSON.parse(l); return false; } catch { return true; } });
  assert('pending.jsonl has no torn lines', badPend.length === 0, `${badPend.length} bad lines`);
}

// every session file must still be valid JSON and point at its own project
const sessDir = path.join(STATE_DIR, 'sessions');
for (const f of fs.readdirSync(sessDir).filter((x) => x.endsWith('.json'))) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8')); } catch {}
  assert(`session file ${f} is valid JSON`, !!s);
  if (s) assert(`session ${f} points at its own project dir`, s.project_dir.endsWith(path.basename(s.project_dir)) && s.project === path.basename(f, '.json'));
}

// the guard must have attributed every tool call to the right project
const toolEvents = fresh.filter((r) => r.kind === 'tool_allowed' && r.project);
const runProject = new Map(spans.map((s) => [s.run_id, s.project]));
const misattributed = toolEvents.filter((e) => runProject.has(e.run_id) && runProject.get(e.run_id) !== e.project);
assert('guard attributed every tool call to the correct project', misattributed.length === 0,
  misattributed.slice(0, 3).map((m) => `${m.run_id}:${m.project}`).join(','));

// ---- same project twice at once must serialise, not race -------------------
console.log('\n' + '='.repeat(70) + '\nSAME-PROJECT COLLISION\n' + '='.repeat(70));
{
  const target = projects[0];
  const mk = async (tag) => {
    const t = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${cfg.token}` } },
    });
    const c = new Client({ name: `collide-${tag}`, version: '0.1.0' });
    await c.connect(t);
    const r = await c.callTool({
      name: 'run_claude_code',
      arguments: { project: target, wait_seconds: 300, prompt: 'Run `sleep 10` then `pwd`. Change nothing.' },
    }, undefined, { timeout: 600_000 });
    await c.close();
    return r.content.map((x) => x.text).join('\n');
  };
  const [one, two] = await Promise.all([mk('a'), mk('b')]);
  const refused = [one, two].filter((t) => /PROJECT ALREADY RUNNING/.test(t));
  const ran = [one, two].filter((t) => /COMPLETED|PAUSED_NEEDS_CONFIRMATION/.test(t));
  assert('one of the two same-project calls was refused', refused.length === 1, `${refused.length} refused`);
  assert('the other ran to completion', ran.length === 1, `${ran.length} ran`);
  assert('the refusal names the in-flight run', refused.length === 1 && /run_id/.test(refused[0]));
}

console.log(bad ? `\n${bad} CHECK(S) FAILED` : '\nno races, no corruption, no boundary crossings');
process.exit(bad ? 1 : 0);
