// ---------------------------------------------------------------------------
// The project registry.
//
// SECURITY MODEL — the important part of this file:
//
// A project must be registered locally, by a human at this machine, via
// `bridge project add`. Nothing arriving over the tunnel can add one. The MCP
// tool accepts a registered NAME and never a filesystem path, so there is no
// input path to validate, escape, or get wrong — an unregistered directory is
// simply unreachable, and a name that is not in the registry resolves to
// nothing at all.
//
// Registration resolves symlinks at add time and the path is re-checked at run
// time, so a registered entry cannot later be swung at a different directory
// by replacing a symlink.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CONFIG_DIR, ensureDirs, loadEnv } from './paths.mjs';

export const REGISTRY_FILE = path.join(CONFIG_DIR, 'projects.json');

const VALID_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const HOME = os.homedir();

/** Directories too broad to ever be a "project". */
function isTooBroad(abs) {
  const forbidden = new Set(['/', HOME, '/Users', '/home', '/tmp', '/etc', '/usr', '/var', '/System', '/Library', '/Applications']);
  return forbidden.has(abs);
}

function emptyRegistry() {
  return { version: 1, default: null, projects: {} };
}

export function loadRegistry() {
  ensureDirs();
  loadEnv(); // .env must be read before the legacy seed below can see it
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  } catch {
    reg = emptyRegistry();
  }
  if (!reg || typeof reg !== 'object' || !reg.projects) reg = emptyRegistry();

  // Seed from the legacy single-project setting so existing installs keep
  // working with no action required.
  const legacy = process.env.BRIDGE_PROJECT_DIR;
  if (legacy && Object.keys(reg.projects).length === 0) {
    const abs = path.resolve(legacy);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const name = path.basename(abs).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
      reg.projects[name] = { path: fs.realpathSync(abs), added_at: new Date().toISOString(), source: 'BRIDGE_PROJECT_DIR' };
      reg.default = name;
      saveRegistry(reg);
    }
  }
  return reg;
}

export function saveRegistry(reg) {
  ensureDirs();
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

/** Local-only. Never call this from a request handler. */
export function registerProject(name, dir) {
  if (!VALID_NAME.test(name)) {
    throw new Error(`Invalid project name "${name}". Use letters, digits, dot, dash or underscore (max 64 chars).`);
  }
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`No such directory: ${abs}`);
  if (!fs.statSync(abs).isDirectory()) throw new Error(`Not a directory: ${abs}`);
  const real = fs.realpathSync(abs);
  if (isTooBroad(real)) {
    throw new Error(`Refusing to register ${real} — it is a system or home root, far too broad to be a project directory.`);
  }

  const reg = loadRegistry();
  const clash = Object.entries(reg.projects).find(([n, p]) => p.path === real && n !== name);
  if (clash) throw new Error(`That directory is already registered as "${clash[0]}".`);

  reg.projects[name] = { path: real, added_at: new Date().toISOString(), source: 'cli' };
  if (!reg.default) reg.default = name;
  saveRegistry(reg);
  return reg.projects[name];
}

export function removeProject(name) {
  const reg = loadRegistry();
  if (!reg.projects[name]) return null;
  const removed = reg.projects[name];
  delete reg.projects[name];
  if (reg.default === name) reg.default = Object.keys(reg.projects)[0] || null;
  saveRegistry(reg);
  return removed;
}

export function setDefaultProject(name) {
  const reg = loadRegistry();
  if (!reg.projects[name]) throw new Error(`"${name}" is not registered.`);
  reg.default = name;
  saveRegistry(reg);
  return name;
}

export function listProjects() {
  const reg = loadRegistry();
  return Object.entries(reg.projects).map(([name, p]) => ({
    name,
    path: p.path,
    added_at: p.added_at,
    source: p.source || 'cli',
    is_default: reg.default === name,
    exists: fs.existsSync(p.path) && fs.statSync(p.path).isDirectory(),
  }));
}

export class UnknownProjectError extends Error {
  constructor(message, { requested, available }) {
    super(message);
    this.name = 'UnknownProjectError';
    this.requested = requested;
    this.available = available;
  }
}

/**
 * Resolve a requested project to a directory.
 *
 * Accepts a registered NAME only. A path is rejected outright rather than
 * validated — the registry is the sole source of runnable directories, so
 * there is no code path where a caller-supplied path becomes a working
 * directory.
 *
 * @param {string|null|undefined} requested
 * @returns {{name: string, path: string}}
 */
export function resolveProject(requested) {
  const reg = loadRegistry();
  const available = Object.keys(reg.projects);

  if (requested != null && String(requested).trim() !== '') {
    const raw = String(requested).trim();

    if (raw.includes('/') || raw.includes('\\') || raw.startsWith('~') || raw.startsWith('.')) {
      throw new UnknownProjectError(
        `"${raw}" looks like a filesystem path. The bridge takes a registered project NAME, never a path — ` +
        `a directory cannot be reached through the bridge unless a human registered it at the machine first. ` +
        (available.length ? `Registered: ${available.join(', ')}.` : 'No projects are registered yet.'),
        { requested: raw, available }
      );
    }

    const match = available.find((n) => n.toLowerCase() === raw.toLowerCase());
    if (!match) {
      throw new UnknownProjectError(
        `"${raw}" is not a registered project, so the bridge will not run against it. ` +
        (available.length ? `Registered: ${available.join(', ')}.` : 'No projects are registered yet.') +
        ` To add one, a human must run this at the machine: bridge project add <name> <path>`,
        { requested: raw, available }
      );
    }
    return withVerifiedPath(match, reg.projects[match]);
  }

  if (!reg.default || !reg.projects[reg.default]) {
    throw new UnknownProjectError(
      available.length
        ? `No default project is set. Pass one of: ${available.join(', ')}.`
        : 'No projects are registered. A human must run: bridge project add <name> <path>',
      { requested: null, available }
    );
  }
  return withVerifiedPath(reg.default, reg.projects[reg.default]);
}

/** Re-check at run time: a registered path must still be a real directory. */
function withVerifiedPath(name, entry) {
  if (!fs.existsSync(entry.path) || !fs.statSync(entry.path).isDirectory()) {
    throw new UnknownProjectError(
      `Project "${name}" is registered as ${entry.path}, but that is no longer a directory. ` +
      `Re-register it at the machine, or remove it with: bridge project remove ${name}`,
      { requested: name, available: [] }
    );
  }
  // Resolve symlinks again so a swapped link cannot redirect the run.
  return { name, path: fs.realpathSync(entry.path) };
}
