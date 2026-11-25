// Registry tests, run against a throwaway CONFIG_DIR so the real registry is
// never touched. The security-relevant cases are the rejections.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-projects-'));
process.env.BRIDGE_HOME_OVERRIDE = tmp;
process.env.BRIDGE_PROJECT_DIR = ''; // no legacy seeding during tests

const projA = path.join(tmp, 'alpha');
const projB = path.join(tmp, 'beta');
fs.mkdirSync(projA); fs.mkdirSync(projB);

// Point the registry at the temp dir by overriding CONFIG_DIR through cwd-free
// module state: projects.mjs reads CONFIG_DIR from paths.mjs, so we stub the
// file location by monkey-patching after import.
const projects = await import('../src/projects.mjs');
const paths = await import('../src/paths.mjs');

let pass = 0;
const failures = [];
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else failures.push(`${label}${extra ? ' — ' + extra : ''}`);
};
const throws = (label, fn, match) => {
  try { fn(); failures.push(`${label} — expected a throw, got none`); }
  catch (err) {
    if (match && !match.test(err.message)) failures.push(`${label} — wrong message: ${err.message}`);
    else pass++;
  }
};

// Redirect the registry file into the temp dir.
const regFile = path.join(tmp, 'projects.json');
fs.writeFileSync(regFile, JSON.stringify({ version: 1, default: null, projects: {} }, null, 2));
const origRead = fs.readFileSync;
const origWrite = fs.writeFileSync;
fs.readFileSync = (p, ...a) => origRead(p === projects.REGISTRY_FILE ? regFile : p, ...a);
fs.writeFileSync = (p, ...a) => origWrite(p === projects.REGISTRY_FILE ? regFile : p, ...a);

// --- registration -----------------------------------------------------------
projects.registerProject('alpha', projA);
projects.registerProject('beta', projB);
const list = projects.listProjects();
check('two projects registered', list.length === 2, `got ${list.length}`);
check('first registration becomes default', list.find((p) => p.name === 'alpha')?.is_default === true);

// --- resolution -------------------------------------------------------------
check('resolves by name', projects.resolveProject('alpha').path === fs.realpathSync(projA));
check('name lookup is case-insensitive', projects.resolveProject('ALPHA').name === 'alpha');
check('omitting a project uses the default', projects.resolveProject(null).name === 'alpha');
check('resolves the other project independently', projects.resolveProject('beta').path === fs.realpathSync(projB));

// --- the security boundary --------------------------------------------------
// Anything that is not a registered name must be refused, and a path must be
// refused *as a path* rather than being validated and possibly let through.
throws('unregistered name refused', () => projects.resolveProject('not-registered'), /not a registered project/i);
throws('absolute path refused', () => projects.resolveProject('/etc'), /looks like a filesystem path/i);
throws('relative path refused', () => projects.resolveProject('./alpha'), /looks like a filesystem path/i);
throws('traversal refused', () => projects.resolveProject('../../etc/passwd'), /looks like a filesystem path/i);
throws('home-relative path refused', () => projects.resolveProject('~/secrets'), /looks like a filesystem path/i);
throws('windows-style path refused', () => projects.resolveProject('C:\\Windows'), /looks like a filesystem path/i);
throws('a real but unregistered dir is still refused', () => projects.resolveProject(tmp), /looks like a filesystem path/i);

// --- registration guards ----------------------------------------------------
throws('refuses filesystem root', () => projects.registerProject('root', '/'), /system or home root/i);
throws('refuses home directory', () => projects.registerProject('home', os.homedir()), /system or home root/i);
throws('refuses nonexistent dir', () => projects.registerProject('ghost', path.join(tmp, 'nope')), /No such directory/i);
throws('refuses a file', () => {
  const f = path.join(tmp, 'file.txt'); fs.writeFileSync(f, 'x');
  projects.registerProject('afile', f);
}, /Not a directory/i);
throws('refuses invalid name', () => projects.registerProject('bad name!', projA), /Invalid project name/i);
throws('refuses duplicate path under a new name', () => projects.registerProject('alpha2', projA), /already registered/i);

// --- default handling -------------------------------------------------------
projects.setDefaultProject('beta');
check('default can be changed', projects.resolveProject(null).name === 'beta');
projects.removeProject('beta');
check('removing the default reassigns it', projects.resolveProject(null).name === 'alpha');
check('removed project no longer resolves', (() => {
  try { projects.resolveProject('beta'); return false; } catch { return true; }
})());

fs.readFileSync = origRead;
fs.writeFileSync = origWrite;
fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n✗ ${failures.length} registry test failure(s), ${pass} passed:\n`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ all ${pass} registry tests passed`);
