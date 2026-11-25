// ---------------------------------------------------------------------------
// Policy engine: the single decision point for what the bridged Claude Code
// session may do on its own.
//
// Default is ALLOW — ordinary development work (read, write, build, test,
// install deps, local git, local databases) runs with no human in the loop.
// Everything in the categories below is DENIED and surfaced to the caller as
// "needs human confirmation", never silently skipped.
//
// This file is intentionally the one place to tune behaviour. Add patterns to
// BLOCK_RULES to tighten, add to READONLY_ALLOW to loosen a specific command.
// ---------------------------------------------------------------------------
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export const CATEGORY = {
  SECRETS: 'secrets',
  EXTERNAL_ACCOUNT: 'external_account',
  DEPLOY: 'deploy_or_publish',
  DESTRUCTIVE: 'destructive_data',
  OUTSIDE_PROJECT: 'outside_project',
  COST: 'irreversible_or_cost',
  SYSTEM: 'system_modification',
  OBFUSCATION: 'obfuscated_execution',
};

const HOME = os.homedir();

// --- file classification ----------------------------------------------------

// Files that hold live credentials. `.env.example` and friends are fine.
const SECRET_FILE = new RegExp(
  [
    String.raw`(^|/)\.env(\.[A-Za-z0-9_-]+)*$`,
    String.raw`(^|/)\.envrc$`,
    String.raw`(^|/)id_(rsa|dsa|ecdsa|ed25519)$`,
    String.raw`\.(pem|p12|pfx|keystore|jks)$`,
    String.raw`(^|/)[^/]*\.key$`,
    String.raw`(^|/)(credentials|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials)$`,
    String.raw`(^|/)service[-_]?account[^/]*\.json$`,
    String.raw`(^|/)[^/]*(secret|credential)s?[^/]*\.(json|ya?ml|txt)$`,
    String.raw`(^|/)\.(aws|ssh|gnupg)/`,
    String.raw`(^|/)\.config/(gcloud|gh|supabase|netlify|fly|doctl)/`,
  ].join('|'),
  'i'
);

const PLACEHOLDER_FILE = /\.(example|sample|template|dist|md)$|(^|\/)\.env\.(example|sample|template)$/i;

export function isSecretPath(p) {
  if (!p) return false;
  if (PLACEHOLDER_FILE.test(p)) return false;
  return SECRET_FILE.test(p);
}

// Scratch/build output that is safe to delete recursively.
const SCRATCH_DIR =
  /(^|\/)(node_modules|dist|build|out|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|\.vite|\.parcel-cache|coverage|target|__pycache__|\.pytest_cache|\.mypy_cache|tmp|temp|\.venv|venv)(\/|$)/;
const SCRATCH_FILE = /\.(log|tmp|pid|tsbuildinfo)$/;

function isScratch(abs) {
  return SCRATCH_DIR.test(abs) || SCRATCH_FILE.test(abs);
}

/** Is `abs` inside `root` (or equal to it)? */
function isInside(root, abs) {
  if (!root || !abs) return false;
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Paths outside the project that are still safe to touch: the OS temp dirs and
 * the bridge's own working directories.
 */
function isNeutralPath(abs, ctx) {
  if (abs.startsWith('/tmp/') || abs.startsWith('/private/tmp/') || abs.startsWith('/var/folders/')) return true;
  if (ctx.bridgeHome && isInside(ctx.bridgeHome, abs)) return true;
  return false;
}

// Reads of system and library files outside the project are ordinary and safe.
// Anything else outside the project — other repos, dotfiles, browser profiles,
// shell history — is not.
const SYSTEM_READ_ROOTS = [
  '/usr', '/opt', '/Library', '/System', '/etc', '/private/etc', '/bin', '/sbin', '/var/log', '/dev/null',
];

/**
 * Claude Code's own notes for THIS project, at
 * ~/.claude/projects/<slugified-project-path>/ — its session transcripts and
 * memory. These are the session's own working notes rather than user data, so
 * reading them is allowed.
 *
 * Deliberately scoped to the current project's slug: allowing all of
 * ~/.claude/projects would let one project's session read another's
 * transcripts, which is the cross-project boundary this policy exists to keep.
 */
function sessionNotesDir(ctx) {
  if (!ctx.projectDir) return null;
  const slug = ctx.projectDir.replace(/[^A-Za-z0-9]/g, '-');
  return path.join(HOME, '.claude', 'projects', slug);
}

function isOwnSessionNotes(abs, ctx) {
  const dir = sessionNotesDir(ctx);
  return !!dir && isInside(dir, abs);
}

function isSensitiveRead(abs, ctx) {
  if (isInside(ctx.projectDir, abs)) return false;
  if (isNeutralPath(abs, ctx)) return false;
  if (SYSTEM_READ_ROOTS.some((root) => isInside(root, abs))) return false;
  if (isOwnSessionNotes(abs, ctx)) return false;
  return true;
}

export function resolvePath(p, ctx) {
  if (!p) return null;
  let s = String(p).trim();
  if (s.startsWith('~')) s = path.join(HOME, s.slice(1));
  return path.resolve(ctx.projectDir, s);
}

// --- shell parsing ----------------------------------------------------------

/** Split a command line into independently-executed segments. */
function splitSegments(cmd) {
  return String(cmd)
    .split(/\n|&&|\|\||[;|]|\$\(|`/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Strip package-runner prefixes and leading env assignments so that anchored
 * rules see the real command. Without this, `npx supabase db push` and
 * `NODE_ENV=production bunx netlify deploy` slip straight past every `^`-anchored
 * rule. `sudo` is deliberately NOT stripped — it has its own rule.
 */
function stripRunners(segment) {
  let s = segment.trim();
  let prev = null;
  while (s !== prev) {
    prev = s;
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, '');
    s = s.replace(/^(?:time|command|exec|nice(?:\s+-n\s+-?\d+)?)\s+/i, '');
    s = s.replace(/^(?:npx|bunx)\s+(?:(?:--yes|-y|--no-install|--no)\s+)*/i, '');
    s = s.replace(/^(?:npm|pnpm|yarn|bun)\s+(?:dlx|exec|x)\s+(?:--\s+)*/i, '');
  }
  return s;
}

/** Quote-aware tokenizer. Good enough to pull out argv-ish words. */
function tokenize(segment) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// --- rule tables ------------------------------------------------------------

// Checked first: explicitly-safe read-only invocations of otherwise-blocked CLIs.
const READONLY_ALLOW = [
  /^gh\s+(pr\s+(view|list|diff|status|checks)|issue\s+(view|list)|repo\s+view|auth\s+status|--version)/i,
  /^(supabase|netlify|vercel|aws|gcloud|az|heroku|fly|flyctl|railway|stripe|doctl|wrangler)\s+(--version|--help|-h|help)\b/i,
  /^netlify\s+(status|sites:list)\b/i,
  /^supabase\s+(status|--help)\b/i,
  /^git\s+remote\s+(-v|show|get-url)\b/i,
  /^terraform\s+(plan|validate|fmt|version)\b/i,
];

const BLOCK_RULES = [
  // --- live secrets --------------------------------------------------------
  // (Secret *file* references are caught by the token scan in classifyCommand,
  // which understands .env.example and friends. These are the non-path cases.)
  {
    re: /\bsecurity\s+(find-generic-password|find-internet-password|dump-keychain)/i,
    cat: CATEGORY.SECRETS,
    why: 'reads the macOS keychain',
  },
  {
    re: /^(env|printenv|set)\s*$/i,
    cat: CATEGORY.SECRETS,
    why: 'dumps the full environment, which may contain live API keys',
  },
  {
    re: /\b(printenv|echo)\s+\$?\{?[A-Z0-9_]*(SECRET|TOKEN|API_?KEY|PASSWORD|PRIVATE_KEY|CREDENTIAL|ACCESS_KEY|SERVICE_ROLE)/i,
    cat: CATEGORY.SECRETS,
    why: 'prints a credential value into the transcript',
  },
  {
    re: /\bgh\s+(secret|variable)\s+(set|delete)/i,
    cat: CATEGORY.SECRETS,
    why: 'writes a repository secret',
  },

  // --- real external accounts ---------------------------------------------
  {
    re: /^gh\s+(repo\s+(create|delete|edit|rename|archive|fork)|release\s+(create|delete|upload)|workflow\s+run|api\s+(-X\s*(POST|PUT|PATCH|DELETE)|--method\s+(POST|PUT|PATCH|DELETE)))/i,
    cat: CATEGORY.EXTERNAL_ACCOUNT,
    why: 'creates or modifies something in a real GitHub account',
  },
  {
    // Once a project is linked, most `db` subcommands target the hosted
    // database. Only the clearly-local ones are exempt.
    re: /^supabase\s+(projects|orgs|link|secrets|db\s+(?!diff|lint)|functions\s+deploy|storage|branches)/i,
    cat: CATEGORY.EXTERNAL_ACCOUNT,
    why: 'acts against a hosted Supabase project',
  },
  {
    re: /^netlify\s+(deploy|sites:create|sites:delete|env:set|env:import|env:unset|link|unlink|api|functions:invoke)/i,
    cat: CATEGORY.EXTERNAL_ACCOUNT,
    why: 'acts against a real Netlify account or site',
  },
  {
    // `now` is Vercel's legacy CLI name, and also one of the most common
    // variable names in existence. A `\b` boundary matched the assignment
    // `now=due.next` inside a heredoc'd test harness and blocked it as a
    // deploy. Both names must therefore look like an actual invocation —
    // followed by whitespace or end of segment — and `now` must additionally
    // not be the target of an assignment (`now = end`, `now += ms`).
    re: /^(?:vercel|now(?!\s*(?:[-+*/%&|^]|\*\*|<<|>>>?)?=))(?=\s|$)(?!\s+--version)/i,
    cat: CATEGORY.EXTERNAL_ACCOUNT,
    why: 'acts against a real Vercel account',
  },
  {
    re: /^(aws|gcloud|az|doctl|heroku|fly|flyctl|railway|render|stripe|twilio|linode|cloudflared?|hcloud)\b/i,
    cat: CATEGORY.EXTERNAL_ACCOUNT,
    why: 'acts against a real cloud or SaaS account',
  },
  {
    re: /^firebase\s+(deploy|use|projects|functions|hosting)/i,
    cat: CATEGORY.EXTERNAL_ACCOUNT,
    why: 'acts against a real Firebase project',
  },
  {
    re: /^wrangler\s+(deploy|publish|secret|kv|d1|r2)/i,
    cat: CATEGORY.EXTERNAL_ACCOUNT,
    why: 'acts against real Cloudflare resources',
  },
  {
    re: /^(terraform|tofu)\s+(apply|destroy|import|state\s+(rm|mv))/i,
    cat: CATEGORY.EXTERNAL_ACCOUNT,
    why: 'mutates real infrastructure',
  },
  { re: /^pulumi\s+(up|destroy|import)/i, cat: CATEGORY.EXTERNAL_ACCOUNT, why: 'mutates real infrastructure' },
  {
    re: /\b(dig|nslookup)?\s*(cloudflare|route53|namecheap|godaddy)\b.*\b(dns|record)\b/i,
    cat: CATEGORY.EXTERNAL_ACCOUNT,
    why: 'touches DNS configuration',
  },

  // --- deploy / make public ------------------------------------------------
  { re: /^git\s+push\b/i, cat: CATEGORY.DEPLOY, why: 'pushes commits to a remote' },
  {
    re: /^git\s+remote\s+(add|set-url|remove|rename)/i,
    cat: CATEGORY.DEPLOY,
    why: 'changes where this repo pushes to',
  },
  {
    re: /^(npm|pnpm|yarn|bun)\s+publish\b/i,
    cat: CATEGORY.DEPLOY,
    why: 'publishes a package to a public registry',
  },
  { re: /^docker\s+(push|login)\b/i, cat: CATEGORY.DEPLOY, why: 'pushes an image to a real registry' },
  {
    re: /^(pm2|serve|surge|gh-pages)\s+(deploy|publish)/i,
    cat: CATEGORY.DEPLOY,
    why: 'makes something publicly live',
  },

  // --- destructive data ----------------------------------------------------
  {
    re: /^git\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|filter-branch|reflog\s+expire)/i,
    cat: CATEGORY.DESTRUCTIVE,
    why: 'irreversibly discards uncommitted or historical work',
  },
  {
    re: /^git\s+branch\s+-D\b/i,
    cat: CATEGORY.DESTRUCTIVE,
    why: 'force-deletes a branch that may hold unmerged commits',
  },
  {
    // `\b` will not match before a `-`, so anchor the flag on whitespace.
    re: /\b(psql|mysql|mongo|mongosh|redis-cli)\b[^\n]*?(?:\s-h\s+|\s--host[=\s]+)(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)\b)/i,
    cat: CATEGORY.DESTRUCTIVE,
    why: 'connects to a non-local database',
  },
  {
    re: /\b(postgres|postgresql|mysql|mongodb)(\+srv)?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i,
    cat: CATEGORY.DESTRUCTIVE,
    why: 'uses a remote database connection string',
  },
  {
    re: /^(npx\s+)?prisma\s+(migrate\s+(deploy|reset)|db\s+push)/i,
    cat: CATEGORY.DESTRUCTIVE,
    why: 'applies destructive schema changes, potentially to a real database',
  },
  {
    re: /\b(DROP\s+(DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i,
    cat: CATEGORY.DESTRUCTIVE,
    why: 'destroys a database or table contents',
    // A script that stands up its own throwaway cluster (initdb/pg_ctl) or
    // points PGHOST at a local socket dir is dropping a scratch database, not a
    // real one. Tested against the whole command, not the single segment.
    contextUnless: /\b(initdb|pg_ctl)\b|PGHOST=|supabase\s+(start|stop)/i,
  },
  {
    re: /\b(mkfs|shred\b|dd\s+if=|diskutil\s+(erase|reformat))/i,
    cat: CATEGORY.DESTRUCTIVE,
    why: 'destroys data at the device level',
  },

  // --- system modification -------------------------------------------------
  { re: /^(sudo|doas|su)\b/i, cat: CATEGORY.SYSTEM, why: 'runs with elevated privileges' },
  {
    re: /^(launchctl|systemctl|defaults\s+write|scutil|networksetup|csrutil|spctl)\b/i,
    cat: CATEGORY.SYSTEM,
    why: 'changes system or security configuration',
  },
  {
    re: /^chmod\s+(-R\s+)?(777|a\+rwx)\b/i,
    cat: CATEGORY.SYSTEM,
    why: 'grants world-writable permissions',
  },
  {
    re: /^(ssh|scp|sftp|rsync)\s+[^\n]*@/i,
    cat: CATEGORY.SYSTEM,
    why: 'connects to a remote host',
  },
  { re: /^crontab\b/i, cat: CATEGORY.SYSTEM, why: 'installs a persistent scheduled job' },

  // --- irreversible / real-world cost -------------------------------------
  {
    // Long forms, case-insensitive. `-d` is deliberately NOT here: matching it
    // case-insensitively also matched `-D` (curl's dump-headers flag), which
    // flagged read-only requests as mutating.
    re: /^(curl|wget|http|https)\b[^\n]*(-X\s*(POST|PUT|PATCH|DELETE)|--request\s+(POST|PUT|PATCH|DELETE)|--data\b|--post\b|--upload-file\b)/i,
    cat: CATEGORY.COST,
    why: 'sends a mutating HTTP request to an external service',
    unless: /(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)/i,
  },
  {
    // The short data flag, case-SENSITIVE: `-d` sends a body, `-D` dumps
    // response headers and changes nothing.
    re: /^(curl|wget|http|https)\b[^\n]*\s-d[\s=]/,
    cat: CATEGORY.COST,
    why: 'sends a mutating HTTP request to an external service',
    unless: /(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)/i,
  },

  { re: /^eval\b/i, cat: CATEGORY.OBFUSCATION, why: 'evaluates a dynamically-built command' },
];

// Rules that must see the whole command line, because segment-splitting on `|`
// would destroy the very pattern they look for.
const WHOLE_COMMAND_RULES = [
  {
    // Interpreter one-liners that open a credentials file from inside a string,
    // where argument-position analysis cannot see it.
    re: /\b(python3?|node|ruby|perl|php|deno|bun)\b[^\n]*['"`][^'"`\n]*(\.env\b(?!\.(?:example|sample|template))|id_rsa|\.netrc|\.pgpass)/i,
    cat: CATEGORY.SECRETS,
    why: 'opens a live-credentials file from inside an inline script',
  },
  {
    re: /\b(curl|wget)\b[^\n]*\|\s*(ba|z|k)?sh\b/i,
    cat: CATEGORY.OBFUSCATION,
    why: 'pipes a remote script straight into a shell',
  },
  {
    re: /\bbase64\s+(-d|--decode|-D)\b/i,
    cat: CATEGORY.OBFUSCATION,
    why: 'decodes base64, which can hide the real command',
  },
];

// --- command analysis -------------------------------------------------------

function checkRmSegment(segment, ctx) {
  const tokens = tokenize(segment);
  if (!/^(rm|unlink|trash)$/i.test(tokens[0] || '')) return null;
  const flags = tokens.filter((t) => t.startsWith('-')).join('');
  const recursive = /r/i.test(flags);
  const targets = tokens.slice(1).filter((t) => !t.startsWith('-'));
  if (targets.length === 0) return null;

  for (const t of targets) {
    if (/[*?]/.test(t) && (t === '*' || t === '/*' || t === '~/*')) {
      return { cat: CATEGORY.DESTRUCTIVE, why: `deletes everything matching \`${t}\`` };
    }
    const abs = resolvePath(t, ctx);
    if (!abs) continue;
    // `abs` is the project directory itself, or an ancestor of it.
    if (isInside(abs, ctx.projectDir)) {
      return {
        cat: CATEGORY.DESTRUCTIVE,
        why: abs === ctx.projectDir
          ? 'deletes the entire project directory'
          : `deletes \`${abs}\`, which contains the project directory`,
      };
    }
    if (!isInside(ctx.projectDir, abs) && !isNeutralPath(abs, ctx)) {
      return { cat: CATEGORY.OUTSIDE_PROJECT, why: `deletes \`${abs}\`, which is outside the project directory` };
    }
    if (recursive && !isScratch(abs) && isInside(ctx.projectDir, abs)) {
      return {
        cat: CATEGORY.DESTRUCTIVE,
        why: `recursively deletes \`${path.relative(ctx.projectDir, abs) || '.'}\`, which is not a build/scratch directory`,
      };
    }
  }
  return null;
}

/** Writes outside the project via shell redirect or cp/mv destination. */
function checkOutsideWrites(segment, ctx) {
  const redirects = [...segment.matchAll(/>>?\s*("[^"]+"|'[^']+'|[^\s;|&]+)/g)].map((m) =>
    m[1].replace(/^["']|["']$/g, '')
  );
  const tokens = tokenize(segment);
  const dests = [];
  if (/^(cp|mv|install|ln)$/i.test(tokens[0] || '')) {
    const positional = tokens.slice(1).filter((t) => !t.startsWith('-'));
    if (positional.length >= 2) dests.push(positional[positional.length - 1]);
  }
  if (/^(mkdir|touch|tee)$/i.test(tokens[0] || '')) {
    dests.push(...tokens.slice(1).filter((t) => !t.startsWith('-')));
  }

  for (const raw of [...redirects, ...dests]) {
    if (/^&?\d$/.test(raw) || raw === '/dev/null' || raw === '/dev/stdout' || raw === '/dev/stderr') continue;
    const abs = resolvePath(raw, ctx);
    if (!abs) continue;
    if (isSecretPath(abs)) {
      return { cat: CATEGORY.SECRETS, why: `writes to \`${raw}\`, a live-credentials file` };
    }
    if (!isInside(ctx.projectDir, abs) && !isNeutralPath(abs, ctx)) {
      return { cat: CATEGORY.OUTSIDE_PROJECT, why: `writes to \`${abs}\`, which is outside the project directory` };
    }
  }
  return null;
}

// Commands whose path operands are genuinely opened, traversed or copied.
// Broader than FILE_CONSUMING because listing/º stat-ing another project still
// leaks its contents.
// Commands whose FIRST positional argument is a pattern rather than a path.
const PATTERN_COMMANDS = /^(grep|egrep|fgrep|rg|ag|ack|sed|awk|perl)$/i;

/**
 * Regex-specific constructs that effectively never appear in a real filename.
 * Kept deliberately narrow: a path containing brackets or parentheses is
 * unusual but legal, so only unambiguous regex syntax is excluded.
 */
function looksLikeRegex(t) {
  return /\[\^|\.\*|\.\+|\\\.|\(\?|\[\[:|\\[dwsSWD]/.test(t);
}

const PATH_READING =
  /^(cat|bat|less|more|head|tail|open|strings|xxd|od|nl|awk|sed|rg|grep|egrep|fgrep|cp|mv|scp|rsync|tar|zip|unzip|source|\.|python3?|node|ruby|perl|php|deno|bun|jq|yq|vim|vi|nano|emacs|code|diff|shasum|md5|md5sum|ls|find|stat|du|wc|file|tree|realpath|readlink|pbcopy)$/i;

/**
 * Reading outside the project via the shell.
 *
 * The Read tool is checked in classifyToolUse, but that does nothing for
 * `cat /other/project/file` — which is the same disclosure by another route.
 * Without this, outside_project containment only covers writes.
 */
function checkOutsideReads(segment, ctx) {
  const all = tokenize(segment);
  const head = (all[0] || '').replace(/.*\//, '');
  if (!PATH_READING.test(head)) return null;

  // grep/sed/awk take a PATTERN first, not a path. Observed in real use: the
  // regex /_next/static/css/[^"]*\.css was read as an absolute path outside the
  // project and blocked a legitimate command.
  let operands = all.slice(1).filter((t) => !t.startsWith('-'));
  if (PATTERN_COMMANDS.test(head) && operands.length > 1) operands = operands.slice(1);

  for (const t of operands) {
    // Only operands that actually look like paths; a bare word resolves inside
    // the project anyway, and flags/patterns are not paths.
    if (!t.includes('/') && !t.startsWith('~')) continue;
    if (looksLikeRegex(t)) continue;
    const abs = resolvePath(t, ctx);
    if (abs && isSensitiveRead(abs, ctx)) {
      return { cat: CATEGORY.OUTSIDE_PROJECT, why: `reads \`${abs}\`, which is outside the project directory` };
    }
  }
  return null;
}

function checkCd(segment, ctx) {
  const m = segment.match(/^cd\s+("[^"]+"|'[^']+'|[^\s;|&]+)/);
  if (!m) return null;
  const raw = m[1].replace(/^["']|["']$/g, '');
  if (raw === '-') return null;
  const abs = resolvePath(raw, ctx);
  if (!abs) return null; // e.g. a fragment left behind by splitting on `$(`
  if (isOwnSessionNotes(abs, ctx)) return null; // reading its own notes is fine
  if (!isInside(ctx.projectDir, abs) && !isNeutralPath(abs, ctx)) {
    return { cat: CATEGORY.OUTSIDE_PROJECT, why: `changes directory to \`${abs}\`, outside the project` };
  }
  return null;
}

// Commands that actually open and consume the files named in their arguments.
// The secret-path scan is limited to these so that merely *mentioning* a
// filename — `git commit -m "ignore .env"`, `echo ".env" >> .gitignore` — stays
// allowed. Writing a .gitignore that covers .env is the right thing to do and
// must not be blocked.
const FILE_CONSUMING =
  /^(cat|bat|less|more|head|tail|open|strings|xxd|od|nl|awk|sed|rg|grep|egrep|fgrep|cp|mv|scp|rsync|tar|zip|unzip|source|\.|python3?|node|ruby|perl|php|jq|yq|vim|vi|nano|emacs|code|diff|shasum|md5|md5sum|dotenv|env-cmd|pbcopy)$/i;

/**
 * A reference to a live-credentials file as an operand of a command that will
 * read it. Done by token scan rather than regex so that `.env.example`,
 * `.env.local.template` and similar placeholders are correctly let through.
 */
function checkSecretPathTokens(segment, ctx) {
  const all = tokenize(segment);
  const head = (all[0] || '').replace(/.*\//, '');
  // `git add .env` stages secrets; other git subcommands only ever name paths.
  const isGitStage = /^git$/i.test(head) && /^(add|stage)$/i.test(all[1] || '');
  if (!FILE_CONSUMING.test(head) && !isGitStage) return null;

  const tokens = all
    // turn `--env-file=.env` into `.env`
    .map((t) => (t.startsWith('-') && t.includes('=') ? t.slice(t.indexOf('=') + 1) : t))
    .filter((t) => t && !t.startsWith('-') && /[./]/.test(t));

  for (const t of tokens) {
    const abs = resolvePath(t, ctx);
    if (abs && isSecretPath(abs)) {
      return { cat: CATEGORY.SECRETS, why: `references \`${t}\`, which holds live credentials` };
    }
  }
  return null;
}

const MAX_SCRIPT_BYTES = 200_000;

function readIfInProject(p, ctx) {
  const abs = resolvePath(p, ctx);
  if (!abs || !isInside(ctx.projectDir, abs)) return null;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_SCRIPT_BYTES) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Drop whole-line comments so prose in a script cannot trip a rule. */
function stripComments(body) {
  return body.split('\n').filter((l) => !/^\s*(#|\/\/)/.test(l)).join('\n');
}

/**
 * A wrapper script is not a safe command just because its invocation looks
 * harmless. `npm run seed:remote` → `bash scripts/seed-remote.sh` → a POST to
 * production. Resolve the indirection and classify what will actually run.
 */
function checkScriptInvocation(segment, ctx, depth) {
  if (depth >= 3) return null;
  const tokens = tokenize(segment);
  if (!tokens.length) return null;
  const head = (tokens[0] || '').replace(/.*\//, '');
  const targets = [];

  if (/^(bash|sh|zsh|ksh|source)$/i.test(head) || tokens[0] === '.') {
    const t = tokens.slice(1).find((x) => !x.startsWith('-'));
    if (t) targets.push({ file: t, label: t });
  } else if (/\.(sh|bash|zsh)$/i.test(tokens[0]) || tokens[0].startsWith('./')) {
    targets.push({ file: tokens[0], label: tokens[0] });
  } else if (/^(npm|pnpm|yarn|bun)$/i.test(head)) {
    // `npm run x`, `pnpm run x`, and the bare `yarn x` / `bun x` forms.
    const isRun = /^(run|run-script)$/i.test(tokens[1] || '');
    const name = isRun ? tokens[2] : (/^(yarn|pnpm)$/i.test(head) ? tokens[1] : null);
    if (name && !name.startsWith('-')) {
      const pkg = readIfInProject('package.json', ctx);
      let body = null;
      try {
        body = pkg ? (JSON.parse(pkg).scripts || {})[name] : null;
      } catch {
        body = null; // unparseable package.json — nothing to resolve
      }
      // Deliberately outside the try: a crash in classification must never be
      // swallowed into an "allow".
      if (body) {
        const hit = classifyCommand(stripComments(body), ctx, depth + 1);
        if (hit) return { cat: hit.cat, why: `runs the "${name}" package script, which ${hit.why}` };
      }
    }
  }

  for (const { file, label } of targets) {
    const body = readIfInProject(file, ctx);
    if (!body) continue;
    const hit = classifyCommand(stripComments(body), ctx, depth + 1);
    if (hit) return { cat: hit.cat, why: `executes ${label}, which ${hit.why}` };
  }
  return null;
}

// Commands that take a human-written message. Their message body is prose, not
// shell: a commit message describing a fix to the route `/properties/<slug>`
// contains both `>` and absolute-looking paths, and was being read as a
// redirect writing outside the project — blocking an ordinary local commit.
const MESSAGE_COMMANDS =
  /(^|[\s;&|])(git\s+(commit|tag|notes|merge|revert)|jj\s+(describe|commit)|(gh|glab)\s+(pr|issue|release)\s+\w+)/;

/**
 * Blank out message bodies before analysis — but ONLY for commands known to
 * take one. Heredocs are stripped narrowly for the same reason: a heredoc fed
 * to a shell (`bash <<EOF … EOF`) is executable and must still be inspected.
 */
function elideMessageText(command) {
  if (!MESSAGE_COMMANDS.test(command)) return command;
  return String(command)
    .replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?\n\s*\2\b/g, ' HEREDOC_ELIDED ')
    .replace(/(-m|--message)(\s+|=)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, '$1 MSG_ELIDED');
}

export function classifyCommand(rawCommand, ctx, depth = 0) {
  const command = elideMessageText(rawCommand);

  for (const rule of WHOLE_COMMAND_RULES) {
    if (rule.re.test(command)) return { cat: rule.cat, why: rule.why, segment: command };
  }

  for (const raw of splitSegments(command)) {
    // Match against the de-prefixed form, but always report the real segment.
    const segment = stripRunners(raw);
    if (READONLY_ALLOW.some((re) => re.test(segment))) continue;

    for (const rule of BLOCK_RULES) {
      if (!rule.re.test(segment)) continue;
      if (rule.unless && rule.unless.test(segment)) continue;
      if (rule.contextUnless && rule.contextUnless.test(command)) continue;
      return { cat: rule.cat, why: rule.why, segment: raw };
    }

    for (const check of [checkSecretPathTokens, checkRmSegment, checkOutsideWrites, checkOutsideReads, checkCd]) {
      const hit = check(segment, ctx);
      if (hit) return { ...hit, segment: raw };
    }

    const scriptHit = checkScriptInvocation(segment, ctx, depth);
    if (scriptHit) return { ...scriptHit, segment: raw };
  }
  return null;
}

// --- tool-level entry point -------------------------------------------------

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'StrEditor']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead']);

/**
 * @returns {{decision:'allow'|'deny', category?:string, reason?:string, detail?:string}}
 */
export function classifyToolUse({ toolName, toolInput = {}, ctx }) {
  // External MCP servers can reach real accounts; the child session is started
  // with none, so this is belt-and-braces.
  if (toolName.startsWith('mcp__')) {
    return deny(CATEGORY.EXTERNAL_ACCOUNT, `the MCP tool \`${toolName}\` can act on a real external account`, toolName);
  }

  if (toolName === 'Bash' || toolName === 'BashOutput') {
    const command = toolInput.command || '';
    if (!command) return { decision: 'allow' };
    const hit = classifyCommand(command, ctx);
    if (hit) return deny(hit.cat, hit.why, hit.segment || command);
    return { decision: 'allow' };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const p = toolInput.file_path || toolInput.notebook_path || toolInput.path;
    const abs = resolvePath(p, ctx);
    if (abs && isSecretPath(abs)) {
      return deny(CATEGORY.SECRETS, `writes to \`${p}\`, which holds live credentials`, abs);
    }
    if (abs && !isInside(ctx.projectDir, abs) && !isNeutralPath(abs, ctx)) {
      return deny(CATEGORY.OUTSIDE_PROJECT, `writes to \`${abs}\`, which is outside the project directory`, abs);
    }
    return { decision: 'allow' };
  }

  if (READ_TOOLS.has(toolName)) {
    const p = toolInput.file_path || toolInput.notebook_path || toolInput.path || toolInput.pattern;
    const abs = resolvePath(p, ctx);
    if (abs && isSecretPath(abs)) {
      return deny(CATEGORY.SECRETS, `reads \`${p}\`, which holds live credentials`, abs);
    }
    if (abs && isSensitiveRead(abs, ctx)) {
      return deny(CATEGORY.OUTSIDE_PROJECT, `reads \`${abs}\`, which is outside the project directory`, abs);
    }
    return { decision: 'allow' };
  }

  return { decision: 'allow' };
}

function deny(category, reason, detail) {
  return { decision: 'deny', category, reason, detail };
}

/** Human-readable guidance appended to every denial the model sees. */
export function denialMessage({ category, reason, detail }) {
  return [
    `BRIDGE POLICY — BLOCKED (${category}).`,
    `This action ${reason}.`,
    detail ? `Attempted: ${String(detail).slice(0, 400)}` : '',
    'It has been recorded as needing human confirmation and reported to the caller.',
    'Do NOT retry it, do not look for an equivalent way around it, and do not',
    'silently skip it. Stop that line of work, finish anything else you can do',
    'safely, and state plainly in your final message what you were blocked from',
    'doing and why you wanted to do it.',
  ]
    .filter(Boolean)
    .join(' ');
}
