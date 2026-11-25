# CLAUDE-BRIDGE

## Why use this

- Keep working from the Claude.ai chat, wherever you are, while Claude Code does the hands-on work in a project folder on your own machine.
- Every run comes back with what actually happened — real diffs, the commands it ran with their output, and any errors — rather than a summary you have to take on trust.
- Ordinary development work (edits, builds, tests, installing dependencies, local git) runs without stopping to ask. Risky things — deploys, live secrets, real external accounts, deleting data — are refused and handed back to you to decide.
- The session is continuous, so you can work across many messages without re-explaining the project each time.
- A kill switch stops everything mid-run, and every action is appended to an audit log you can read afterwards.

Before you expose it to the internet, read the **Security warning** below: this tool lets a remote AI run commands on your machine.

## What it is

A remote MCP server that lets a **Claude.ai chat conversation drive a real Claude Code session** on the machine it runs on.

The chat sends an instruction; Claude Code executes it in a project directory you registered; the chat gets back what actually happened — diffs, command output, errors — with no human relaying screenshots.

The session is **continuous**: call five, ten, fifty times and each one inherits the context and file state left by the last, the same as a normal working session. Multiple projects can be registered, each with its own session.

> ## ⚠️ Security warning — read before running this
>
> **This tool gives a remote AI the ability to run commands and modify files on your computer, with no human approving each action.** That is the whole point of it, and it is not safe by default. Understand all of the following before you start it:
>
> - It opens an **HTTP endpoint that you must expose to the public internet** (via a tunnel) so Claude.ai can reach it. A single shared token is the *only* thing standing between anyone on the internet and code execution on your machine. If that token leaks, so does your machine.
> - `/authorize` **auto-approves OAuth requests without asking a human** (see [The OAuth shim](#the-oauth-shim)). The redirect_uri allowlist is what prevents the token being delivered to a stranger.
> - The policy in `src/policy.mjs` is a **best-effort guardrail, not a sandbox.** It is a set of pattern rules on commands. Treat it as a way to prevent accidents, not as a boundary that defeats a determined attacker or a prompt injection.
> - The bridged session **inherits the environment of the shell that started the server**, including any API keys in it.
> - Anything the session reads — source files, dependencies, issue text — is **untrusted input that can carry a prompt injection** aimed at this bridge.
> - Run it against a **project you could afford to lose**, on an account without broad credentials, and stop the tunnel when you are not using it.
>
> The audit log and the kill switch exist because the policy can be wrong. Know where both are before you expose the endpoint.

---

## The autonomy line

**Runs without asking:** reading and writing files, builds, tests, linters, installing dependencies, local and scratch databases, git inside the local repo (add, commit, branch, merge, stash).

**Never runs — returns "needs human confirmation" instead:**

| Category | Examples |
|---|---|
| `secrets` | reading or writing `.env` with live values, `~/.ssh`, keychain, printing an API key |
| `external_account` | `gh repo create`, `supabase link`, `netlify env:set`, `aws`, `terraform apply` |
| `deploy_or_publish` | `git push`, `npm publish`, `docker push`, any production deploy |
| `destructive_data` | `git reset --hard`, `DROP TABLE`, connecting to a remote database, `rm -rf src` |
| `outside_project` | anything reading or writing outside the project directory of the run |
| `irreversible_or_cost` | mutating HTTP calls to external services |
| `system_modification` | `sudo`, `launchctl`, `ssh user@host`, `crontab` |

When one of these comes up the bridge **pauses that thread of work and says so**, with the exact command and why it wanted to run it. It never performs the action, and it never silently skips it. You decide, do it yourself if you want it done, then tell the chat to carry on.

`rm -rf node_modules`, `rm -rf dist` and similar build-output cleanup are allowed — the policy distinguishes scratch directories from real source.

---

## Setup

Requires Node.js and the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (`claude`) installed and logged in.

```bash
npm install
npm run bridge -- init /absolute/path/to/your/project
```

That writes `.env` with a freshly generated token, and sets `BRIDGE_PROJECT_DIR`. Nothing in `.env` is ever committed — it is gitignored.

Register the project directories the bridge is allowed to work in. **A directory is unreachable through the bridge unless a human registers it here, at the machine** — the MCP tool takes a registered *name*, never a path:

```bash
npm run bridge -- project add myapp /absolute/path/to/myapp
npm run bridge -- project add myapi /absolute/path/to/myapi
npm run bridge -- project default myapp
npm run bridge -- project                 # list what's registered
```

The directory from `bridge init` is registered automatically on first run, so a single-project setup needs no `project add` at all. The registry lives in `config/projects.json` (gitignored; see `config/projects.example.json` for the format).

Start it:

```bash
npm start
```

Expose it (Claude.ai only connects to remote servers, so a tunnel is required):

```bash
brew install cloudflared   # one time
npm run tunnel
```

The tunnel prints a `https://<random>.trycloudflare.com` hostname. The connector URL to paste into Claude.ai is that hostname plus your token and `/mcp`:

```
https://<random>.trycloudflare.com/<BRIDGE_TOKEN>/mcp
```

`npm run bridge -- token` prints the token. Add it in Claude.ai under **Settings → Connectors → Add custom connector**.

> The quick-tunnel hostname changes every restart. For a stable URL, use a named Cloudflare tunnel or an ngrok reserved domain.

`scripts/tunnel.sh` finds `cloudflared` via `$CLOUDFLARED`, then your `PATH`, then `/opt/homebrew/bin/cloudflared` — set `CLOUDFLARED` if yours is somewhere else.

### Stable URL with a named Cloudflare tunnel (optional, macOS)

Two scripts exist for running the bridge behind a hostname that doesn't change. Both are optional; the quick tunnel above needs neither.

**`scripts/setup-named-tunnel.sh <hostname>`** — run once, by you, interactively. It:

1. runs `cloudflared tunnel login` (opens a browser against *your* Cloudflare account) unless `~/.cloudflared/cert.pem` already exists;
2. creates a tunnel named `$BRIDGE_TUNNEL_NAME` (default `claude-bridge`) if it doesn't exist yet;
3. **overwrites `~/.cloudflared/config.yml`** so that hostname routes to `http://127.0.0.1:$BRIDGE_PORT`;
4. creates the DNS record with `cloudflared tunnel route dns`;
5. prints the connector URL, and a `launchctl kickstart` hint using `$BRIDGE_LAUNCHD_LABEL`.

It creates real resources in your Cloudflare account, which is why it is a manual step and not something the bridge does for you. **Prerequisite:** the zone must already be active on Cloudflare nameservers — a named tunnel resolves through `<UUID>.cfargotunnel.com`, which only exists inside Cloudflare's edge, so a CNAME from a third-party DNS provider cannot reach it. If step 4 fails, everything else is still configured; re-run it once the zone is active.

**`scripts/tunnel-service.sh`** — the long-running tunnel process. It waits for the bridge's own `/health` to answer, then runs the named tunnel if `~/.cloudflared/config.yml` exists and the tunnel resolves, and otherwise falls back to a quick tunnel so you are not offline while the named one is being set up. Either way it writes the current public URL to `cloudflared.url` in the state directory, so nothing has to scrape a log to find out where the bridge is.

Environment variables these two read:

| Variable | Default | Used for |
|---|---|---|
| `CLOUDFLARED` | `cloudflared` on `PATH`, else `/opt/homebrew/bin/cloudflared` | path to the binary |
| `BRIDGE_TUNNEL_NAME` | `claude-bridge` | the named tunnel to create and run |
| `BRIDGE_LAUNCHD_LABEL` | `com.example.claude-bridge-tunnel` | only the restart hint that gets printed |
| `BRIDGE_STATE_DIR` | `~/Library/Application Support/claude-bridge/state` | where `cloudflared.url` is written |
| `BRIDGE_PORT` | `8787`, read from `.env` | the local port to tunnel to |

Two things this repo does **not** ship, so that you know what you'd be wiring up yourself:

- **No launchd plist.** `tunnel-service.sh` is written to be run by a launchd agent, and `BRIDGE_LAUNCHD_LABEL` only affects a printed hint — you create the agent yourself. The script also runs fine in the foreground.
- **Nothing writes `tunnel.url`.** `bridge doctor`'s `public_http` check reads `tunnel.url` in the state directory, while these scripts write `cloudflared.url`. Until you create `tunnel.url` yourself, that one check reports `no tunnel.url recorded`.

### Authentication

The token is accepted three ways — use whichever your client supports:

- `Authorization: Bearer <token>`
- `X-Bridge-Token: <token>`
- in the URL path: `https://host/<token>/mcp` — the reliable option for clients that can't set custom headers

Everything except `/health` and the OAuth endpoints requires it. Rejected attempts are logged with IP and user agent.

### The OAuth shim

Claude.ai will not accept a connector that only wants a bearer token. Before it ever calls `/mcp` it probes for OAuth discovery documents and abandons the connection if they 401 — the symptom is *"Couldn't register with … sign-in service"*. So [`src/oauth.mjs`](src/oauth.mjs) answers the handshake:

| Endpoint | Spec | Behaviour |
|---|---|---|
| `/.well-known/oauth-protected-resource` (+ path suffix) | RFC 9728 | points at this server as its own auth server |
| `/.well-known/oauth-authorization-server` (+ path suffix) | RFC 8414 | advertises the endpoints below, PKCE S256 |
| `/register` | RFC 7591 | dynamic registration, accepts any client |
| `/authorize` | OAuth 2.1 | **auto-approves** and redirects with a code |
| `/token` | OAuth 2.1 | exchanges the code for `BRIDGE_TOKEN` |

**This does not add a second way in.** `/token` hands back the same `BRIDGE_TOKEN`, and `/mcp` still accepts only that value — the shim is a handshake wrapper in front of unchanged auth.

Authorization codes are single-use with a 5-minute TTL, and PKCE is verified when the client uses it.

**`/authorize` approves without asking a human**, because no human is watching. What stops a stranger who finds your hostname is the **redirect_uri allowlist** — the token can only be delivered to `claude.ai` / `claude.com` / `anthropic.com` (or loopback, for local clients like MCP Inspector). An untrusted `redirect_uri` gets a 400, never a redirect, so this cannot be turned into an open redirect that leaks the token. Add hosts with `BRIDGE_OAUTH_REDIRECT_HOSTS` in `.env` if you need another client.

Every registration, authorization and token issuance is written to the audit log with the caller's IP.

Verify the whole flow, including a real MCP call with the issued token:

```bash
node test/oauth-flow.mjs https://<your-tunnel-host>
```

---

## Tools the chat gets

| Tool | What it does |
|---|---|
| `run_claude_code` | Send an instruction. Returns diffs, commands + output, errors, and anything blocked. |
| `check_run` | Poll a run that's still going. |
| `bridge_status` | Paused or live, project dir, session, active run, outstanding confirmations. |
| `list_pending_confirmations` | Everything waiting on a human decision. |
| `resolve_confirmation` | Record that you handled it (`done_by_human`) or that it shouldn't happen (`rejected`). |
| `stop_run` | Kill an in-flight run. |
| `read_audit_log` | Tail the audit trail. |

### Long runs

`run_claude_code` waits `BRIDGE_DEFAULT_WAIT_SECONDS` (default 240s) and then returns `status: running` with a `run_id`. **The work keeps going.** The chat polls `check_run`. This keeps tool calls under tunnel and proxy idle timeouts instead of hanging.

---

## The kill switch

```bash
npm run bridge -- stop "reason"     # pause the bridge AND kill anything in flight
npm run bridge -- resume
```

`stop` writes a lock file and kills the running process group. The lock is checked in two places: before any new run starts, and by the policy hook **before every single tool call** — so a run already in progress stops at its next action rather than finishing whatever it was doing. Any `run_claude_code` call while paused returns "BRIDGE PAUSED" without executing.

`npm run bridge -- kill` kills the current run but leaves the bridge live.

---

## Audit trail

Everything lands in `logs/audit.jsonl`, timestamped and append-only: every tool call allowed, every command with its output, every blocked action with its category, every pause/resume/kill, every rejected auth attempt.

```bash
npm run bridge -- logs 50
npm run bridge -- logs 50 -f
```

Per-run results are kept as JSON in `$BRIDGE_STATE_DIR/runs/<run_id>.json`.

## Where state lives

Session ids, the pause lock, pending confirmations and run results are kept
outside this checkout — `~/Library/Application Support/claude-bridge/state` on
macOS, `$XDG_STATE_HOME/claude-bridge` elsewhere. Override with
`BRIDGE_STATE_DIR`.

They used to live in `./state`, which breaks when the checkout sits under a
sync-managed or TCC-protected location — `~/Desktop`, `~/Documents`, iCloud
Drive. Writes into those can fail with `EPERM` at any moment regardless of file
permissions. One such failure on `pending.jsonl`, raised inside a child-exit
handler where an uncaught throw kills the process, is enough to take the server
down mid-run while the tunnel stays up in front of it — after which every call
returns connection-refused until someone notices.

Two things changed alongside the move: the bookkeeping writes in `src/state.mjs`
now log a warning and carry on rather than throwing (`tryWrite`), and the server
keeps serving through an uncaught exception instead of exiting silently.
`writeRuntime` is the deliberate exception — it still throws, because a stale
runtime file would scope the guard to the wrong project.

---

## Operator commands

```bash
npm run bridge -- status                    # state, session, active run, pending
npm run bridge -- pending [--all]           # what's awaiting a decision
npm run bridge -- resolve <id> done_by_human|rejected [note]
npm run bridge -- policy "some command"     # dry-run a command against the policy
npm run bridge -- project [add|remove|default]   # manage registered projects
npm run bridge -- doctor                    # run the self-check now
npm run bridge -- token
```

`policy` is the fastest way to check a rule without running anything:

```
$ npm run bridge -- policy "git push origin main"
BLOCKED (deploy_or_publish) — this action pushes commits to a remote
```

---

## How it works

![Claude.ai chat reaches a tunnel over HTTPS with a token, which reaches the bridge server; every tool call passes through the policy guard, which either allows it to run in Claude Code inside a registered project folder or blocks it and reports back that a human is needed. Everything is appended to the audit log, and a kill switch pauses the bridge.](docs/how-it-works.svg)

In more detail, including how the child session is spawned:

```
Claude.ai chat
   │  MCP over HTTPS (token auth)
   ▼
tunnel ──► src/server.mjs ──► src/runner.mjs
                                   │  spawns:
                                   │    claude -p --output-format stream-json
                                   │           --resume <session-id>
                                   │           --permission-mode acceptEdits
                                   │           --settings <installs the guard hook>
                                   ▼
                            Claude Code session in the registered project dir
                                   │  every tool call first goes through
                                   ▼
                            hooks/guard.mjs ──► src/policy.mjs
                                   allow → runs, and the file is snapshotted
                                   deny  → blocked, recorded, reported
```

**The guard hook is the single decision point.** Claude Code calls it before every tool use. Returning `allow` is what grants the autonomy — no prompts, no waiting. Returning `deny` blocks the action, writes a pending-confirmation record, and tells the model plainly not to look for a way around it.

The hook **fails closed**: if the policy check can't run, the action is blocked.

Diffs are real, not reconstructed from the model's claims — the hook snapshots each file immediately before it's modified, and the runner diffs the snapshot against the final state after the run.

**Wrapper scripts are resolved, not trusted.** `npm run seed:remote` looks harmless; if it expands to `bash scripts/seed-remote.sh` and that script POSTs to production, inspecting the command line alone would miss it. The policy follows the indirection — package scripts, `bash foo.sh`, `./foo.sh` — up to three levels deep, and classifies what will actually run. Whole-line comments are stripped first so prose in a script can't trip a rule.

Package-runner prefixes are normalized away before matching, so `npx supabase db push`, `bunx wrangler deploy` and `NODE_ENV=production npx netlify deploy` are caught by the same rules as their bare forms. `sudo` is deliberately not stripped — it has its own rule.

Blocked work reaches you through two channels, deduplicated: actions the session *attempted* (caught mechanically by the hook) and actions it *declined to attempt* because it knew the policy (declared in its final report and parsed out by the runner). Without the second, a session that pre-emptively complied would report `COMPLETED` while quietly leaving work undone.

The child session runs with `--strict-mcp-config` and an empty MCP config, so it cannot reach any MCP servers configured elsewhere on this machine (Supabase, Netlify, Zapier and so on).

---

## Tuning the policy

All of it lives in [`src/policy.mjs`](src/policy.mjs), which is the only file you should need to edit:

- `BLOCK_RULES` — per-segment regex rules, the bulk of the policy
- `WHOLE_COMMAND_RULES` — rules that need the unsplit command line (e.g. `curl … | sh`)
- `READONLY_ALLOW` — safe read-only forms of otherwise-blocked CLIs
- `SECRET_FILE` / `PLACEHOLDER_FILE` — what counts as a live-credentials file
- `SCRATCH_DIR` — what's safe to `rm -rf`

Commands are split on `&&`, `||`, `;`, `|` and newlines and each segment is checked independently, so `npm run build && git push` is caught.

**Add a test case to `test/policy.test.mjs` before changing a rule:**

```bash
npm test          # policy, registry, legacy-seed and provider checks
```

---

## Files

```
src/policy.mjs      what's allowed and what needs a human   ← tune here
src/runner.mjs      spawns claude, parses the stream, builds diffs
src/mcp.mjs         the seven MCP tools
src/server.mjs      HTTP transport + token auth
src/oauth.mjs       the OAuth discovery/handshake shim
src/projects.mjs    the project registry (local-only registration)
src/state.mjs       pause lock, session, pending confirmations
src/paths.mjs       path + .env resolution
src/selfcheck.mjs   the health checks behind `bridge doctor`
hooks/guard.mjs     PreToolUse enforcement + pre-edit snapshots
bin/bridge.mjs      operator CLI / kill switch
scripts/tunnel.sh   expose the local port with a Cloudflare quick tunnel
test/policy.test.mjs
test/client.mjs     manual client for driving the bridge from a terminal
```

---

## Security notes

See also the **Security warning** at the top of this README — this section is the operational detail behind it.

- The token is the only thing between the public internet and code execution on this machine. Don't paste the connector URL anywhere but Claude.ai's connector settings, and treat it like a password: it is one.
- `.env`, `config/projects.json` and `logs/` are gitignored. The token lives in `.env` and the audit log can contain command output — **don't commit either**, and check before pushing a fork.
- The bridged session inherits this shell's environment, including any API keys in it. The policy blocks *printing* them, but a determined prompt-injection in a file the session reads is a real risk — which is what the audit log and kill switch are for.
- The policy is pattern-based. It is written to stop plausible accidents, not to withstand an adversary who knows it is there. Don't rely on it to protect anything you could not afford to lose.
- Register only the projects you actually want reachable. The registered directory is the boundary the whole policy is written against, and registration can only happen locally, at the machine.
- Stop the tunnel when you're not using it, and run `npm run bridge -- stop "reason"` to pause the bridge and kill anything in flight.

---

## License

MIT — see [LICENSE](LICENSE).

Built by JOLAG Consulting FZE.
