# Security policy

## Reporting a vulnerability

**Please report privately, not as a public issue.**

Use GitHub's **Report a vulnerability** button on this repository's **Security** tab. That opens a private advisory visible only to the maintainers.

Please don't open a public issue, discussion or pull request for a security problem until it has been fixed. A public report here is a working description of how to reach someone else's machine.

Useful things to include: what an attacker would need (network position, a token, a registered project), what they'd get, and the smallest reproduction you have. A proof of concept is welcome but never required.

## What this tool is, in security terms

This bridge deliberately lets a remote AI **run commands and modify files on the host machine**, without a human approving each action. The guard in `src/policy.mjs` and `hooks/guard.mjs` is a best-effort policy, not a sandbox. Please read the Security warning at the top of the [README](README.md) before deploying it anywhere.

Findings that are especially worth reporting:

- any way to reach the MCP endpoint without the token;
- any way to make `/authorize` deliver the token to a host outside the redirect_uri allowlist;
- any way to make the guard **allow** an action in a blocked category, or to run against a directory that was never registered;
- any way to make the guard fail **open** rather than closed.

## If your token leaks

`BRIDGE_TOKEN` is the only thing between the public internet and command execution on your machine. If it has been exposed — pasted into a screenshot, a log, an issue, a commit — treat it as a full compromise of that machine and rotate it at once.

`npm run bridge -- token` prints the current token, so output containing it should be treated as a secret too.

There is no rotate subcommand. Rotating is manual:

1. `npm run bridge -- stop "token rotation"` — pauses the bridge and kills anything in flight.
2. Remove the connector from Claude.ai so the old URL stops being used.
3. Edit `BRIDGE_TOKEN` in `.env` to a new random value — or delete `.env` and re-run `npm run bridge -- init <project-dir>`, which generates a fresh one. (`bridge init` will not overwrite an existing `.env`.)
4. Restart the server. The token is read from `.env` once at startup, so a restart is required for the new value to take effect.
5. `npm run bridge -- resume`, then add the connector again with the new URL from `npm run bridge -- token`.

Afterwards, read `logs/audit.jsonl` for the exposure window. It records every tool call, every command with its output, every blocked action, and every rejected authentication attempt with the caller's IP and user agent — which is what tells you whether the token was actually used.
