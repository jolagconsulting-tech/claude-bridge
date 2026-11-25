// Backwards compatibility: an install that only ever set BRIDGE_PROJECT_DIR
// must come up with that directory registered and default, with no manual step.
//
// Runs entirely against a temp registry file — the real config/projects.json is
// never read or written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-seed-'));
const legacyDir = path.join(tmp, 'my-legacy-app');
fs.mkdirSync(legacyDir);

// Set before importing so the seed sees it, and so loadEnv() (which only fills
// unset vars) cannot override it from the real .env.
process.env.BRIDGE_PROJECT_DIR = legacyDir;

const projects = await import('../src/projects.mjs');

// Redirect only the registry file to the temp copy.
const regFile = path.join(tmp, 'projects.json');
const origRead = fs.readFileSync;
const origWrite = fs.writeFileSync;
fs.readFileSync = (p, ...a) => origRead(p === projects.REGISTRY_FILE ? regFile : p, ...a);
fs.writeFileSync = (p, ...a) => origWrite(p === projects.REGISTRY_FILE ? regFile : p, ...a);

let pass = 0;
const failures = [];
const check = (label, cond, extra = '') => {
  if (cond) pass++; else failures.push(`${label}${extra ? ' — ' + extra : ''}`);
};

// No registry file exists yet: this is the fresh-upgrade case.
check('no registry file to begin with', !fs.existsSync(regFile));

const list = projects.listProjects();
check('legacy dir was auto-registered', list.length === 1, `got ${list.length}`);
check('named after the directory', list[0]?.name === 'my-legacy-app', list[0]?.name);
check('marked as the default', list[0]?.is_default === true);
check('recorded as seeded, not hand-added', list[0]?.source === 'BRIDGE_PROJECT_DIR');

// The whole point: a call that names no project still resolves.
const resolved = projects.resolveProject(null);
check('resolves with no project specified', resolved.path === fs.realpathSync(legacyDir), resolved.path);

// Seeding must happen once, not re-seed or duplicate on later loads.
projects.registerProject('second', (() => { const d = path.join(tmp, 'second'); fs.mkdirSync(d); return d; })());
check('seed does not re-run once a registry exists', projects.listProjects().length === 2);
check('default is unchanged by a later add', projects.resolveProject(null).name === 'my-legacy-app');

fs.readFileSync = origRead;
fs.writeFileSync = origWrite;
fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n✗ ${failures.length} seed test failure(s), ${pass} passed:\n`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ all ${pass} legacy-seed tests passed`);
