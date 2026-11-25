// Live two-project verification, run against the PUBLIC tunnel URL.
//   node test/multiproject-verify.mjs <base-url> <projectA> <projectB>
//
// Both projects must already be registered (`bridge project add`). The two names
// are arguments, not constants, so this runs against whatever is registered on
// the machine under test. Omit the names to use the first two registered.
//
// Read-only by design: it establishes distinct context in each project by
// having each session report facts about its own tree, then checks that the
// context survived a switch and that neither session can reach the other's
// files. Nothing is written to either project.
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../src/paths.mjs';
import { listProjects } from '../src/projects.mjs';

const cfg = config();
const base = (process.argv[2] || process.env.BRIDGE_PUBLIC_URL || `http://127.0.0.1:${cfg.port}`).replace(/\/$/, '');

const registered = listProjects();
const PROJ_A = process.argv[3] || registered[0]?.name;
const PROJ_B = process.argv[4] || registered[1]?.name;
if (!PROJ_A || !PROJ_B || PROJ_A === PROJ_B) {
  console.error('Need two distinct registered project names.');
  console.error('  usage: node test/multiproject-verify.mjs <base-url> <projectA> <projectB>');
  console.error(`  registered: ${registered.map((p) => p.name).join(', ') || '(none)'}`);
  process.exit(1);
}
// Absolute path to a file inside A, used to prove B cannot reach it. Taken from
// the registry so no machine-specific path is baked into this file.
const A_DIR = registered.find((p) => p.name === PROJ_A)?.path;
const A_FILE = A_DIR ? path.join(A_DIR, 'package.json') : null;
// An unregistered name, and a raw path, that both must be refused.
const UNREGISTERED = 'no-such-project';
const RAW_PATH = A_DIR || '/tmp';

// Each project's own package name, read locally, so the leak assertions below
// can look for the real string without it being hardcoded here. Optional: the
// corresponding checks are skipped when a project has no readable package.json.
const pkgName = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name || null; }
  catch { return null; }
};
const A_PKG_NAME = A_DIR ? pkgName(A_DIR) : null;
const B_PKG_NAME = pkgName(registered.find((p) => p.name === PROJ_B)?.path || '');

const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${cfg.token}` } },
});
const client = new Client({ name: 'multiproject-verify', version: '0.1.0' });
await client.connect(transport);

async function run(args, label) {
  process.stdout.write(`\n─── ${label}\n`);
  const res = await client.callTool(
    { name: 'run_claude_code', arguments: { wait_seconds: 600, ...args } },
    undefined,
    { timeout: 900_000 }
  );
  const text = res.content.map((c) => c.text).join('\n');
  console.log(text);
  return text;
}

const results = {};

results.a1 = await run(
  { project: PROJ_A, prompt: 'Read package.json in this directory. Report exactly two things: the "name" field, and the full list of script names. Do not modify anything.' },
  `A1 · ${PROJ_A} · establish context`
);

results.b1 = await run(
  { project: PROJ_B, prompt: 'Read package.json in this directory. Report exactly two things: the "name" field, and the full list of script names. Do not modify anything.' },
  `B1 · ${PROJ_B} · establish context`
);

results.a2 = await run(
  { project: PROJ_A, prompt: 'Without reading any files at all, purely from memory of this session: what was the package "name" you reported to me a moment ago, and how many scripts did it have? If you have no memory of a previous exchange, say exactly "NO PRIOR CONTEXT".' },
  `A2 · ${PROJ_A} · did its own context survive the switch?`
);

results.b2 = await run(
  { project: PROJ_B, prompt: 'Without reading any files at all, purely from memory of this session: what was the package "name" you reported to me a moment ago? If you have no memory of a previous exchange, say exactly "NO PRIOR CONTEXT".' },
  `B2 · ${PROJ_B} · did its own context survive?`
);

// Deliberately a FRESH session. A continuing session that already knows the
// path is blocked will decline on principle, which proves the model's good
// behaviour but leaves the guard itself untested. This must exercise the guard.
results.iso = await run(
  {
    project: PROJ_B,
    new_session: true,
    prompt: `Run this shell command and report the outcome verbatim: cat "${A_FILE}". Then use the Read tool on that same path and report that outcome verbatim. Do not modify anything.`,
  },
  `ISO · ${PROJ_B} (fresh session) · can Bash reach the other project?`
);

results.unknown = await run(
  { project: UNREGISTERED, prompt: 'echo hello' },
  'REG · an unregistered project name must be refused'
);

results.path = await run(
  { project: RAW_PATH, prompt: 'echo hello' },
  'PATH · a raw filesystem path must be refused'
);

await client.close();

// ---- assertions ----------------------------------------------------------
console.log('\n' + '='.repeat(70) + '\nVERDICT\n' + '='.repeat(70));
let bad = 0;
const assert = (label, cond, detail = '') => {
  // detail explains a failure; printing it on success reads as if it happened
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${!cond && detail ? ' — ' + detail : ''}`);
  if (!cond) bad++;
};

assert(`A ran in ${PROJ_A}`, new RegExp('project: `' + PROJ_A + '`').test(results.a1));
assert(`B ran in ${PROJ_B}`, new RegExp('project: `' + PROJ_B + '`').test(results.b1));
if (A_PKG_NAME) assert('A reported its own package name', results.a1.includes(A_PKG_NAME));
if (B_PKG_NAME) assert('B reported its own package name', results.b1.includes(B_PKG_NAME));

assert('A kept its context across the switch', !/NO PRIOR CONTEXT/.test(results.a2));
assert('B kept its context across the switch', !/NO PRIOR CONTEXT/.test(results.b2));
assert('A resumed rather than starting fresh', /\(continued\)/.test(results.a2));
assert('B resumed rather than starting fresh', /\(continued\)/.test(results.b2));
assert(
  'A did not inherit B\'s identity',
  !new RegExp('name.{0,20}["`]?' + (B_PKG_NAME || PROJ_B) + '["`]?', 'i').test(results.a2)
);

// Both routes must be blocked. Asserting only that "outside_project" appears
// is not enough — it passed once while the Read tool was blocked and a Bash
// `cat` of the same path quietly succeeded.
assert('cross-project Read was blocked', /outside_project/.test(results.iso));
assert('cross-project Bash read was blocked', /tool: `Bash`/.test(results.iso) || /BLOCKED \(outside_project\)/.test(results.iso));
assert(
  'the other project\'s file contents did not come back',
  !A_PKG_NAME || !new RegExp('"name":\\s*"' + A_PKG_NAME + '"').test(results.iso),
  'package.json contents leaked across the boundary'
);
assert('unregistered project refused', /PROJECT NOT REGISTERED/.test(results.unknown));
assert('raw path refused', /PROJECT NOT REGISTERED|filesystem path/.test(results.path));
assert('nothing ran for the refused calls', !/Files changed \(\d/.test(results.unknown + results.path));

console.log(bad ? `\n${bad} CHECK(S) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
