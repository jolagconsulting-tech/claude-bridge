# Contributing

Thanks for taking a look. This is a small project and small, focused changes are the easiest to review and accept.

## Before you open a pull request

Run the tests:

```bash
npm test
```

All suites should pass. They need no network access, no tunnel, and no running bridge — they use temporary directories and never touch your real registry or `.env`.

## Changing the policy

`src/policy.mjs` decides what the bridged session may do on someone's machine without asking them first. It is the one file where a mistake is a security bug rather than a bug.

**Add a case to `test/policy.test.mjs` before you change a rule.** Cover both directions: what must still be allowed, and what must still be blocked. A rule that only widens what's permitted, with no test showing what it still refuses, won't be merged.

If you're unsure whether a command is caught, check it without running anything:

```bash
npm run bridge -- policy "the command here"
```

## Keep changes small

One concern per pull request. A change to the policy, a change to the transport, and a README rewrite are three pull requests, not one. Say in the description what you changed and how you checked it.

## Never include real data

Issues, pull requests, tests and fixtures are public and permanent. Don't include:

- tokens, API keys, or `.env` contents — `BRIDGE_TOKEN` grants command execution on the machine it came from. If you paste one anywhere, rotate it (see [SECURITY.md](SECURITY.md));
- audit log excerpts without reading them first — `logs/audit.jsonl` contains the commands that were run and their output;
- absolute paths from your own machine, client or employer project names, internal hostnames, or tunnel URLs.

Use placeholder names in tests and fixtures. The existing ones (`example-app`, `example.com`, `/Users/dev/...`) are the house style — please follow it.

## Security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md) for how to report privately.
