// Remote MCP endpoint. Claude.ai only connects to remote servers, so this
// listens over HTTP and is meant to be exposed through a tunnel.
//
// Auth: a shared token, accepted three ways so it works whichever way the client
// can supply it —
//   Authorization: Bearer <token>
//   X-Bridge-Token: <token>
//   https://host/<token>/mcp        (path prefix — works with clients that
//                                    cannot set custom headers)
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { createServer } from './mcp.mjs';
import { mountOAuth, baseUrl } from './oauth.mjs';
import { listProjects } from './projects.mjs';
import { config, ensureDirs, writeServerPid, clearServerPid } from './paths.mjs';
import { audit } from './audit.mjs';
import { isPaused, pauseReason, reapDeadActiveRuns, getLiveActiveRuns } from './state.mjs';

const cfg = config();
ensureDirs();

if (!cfg.token || cfg.token.length < 16) {
  console.error('FATAL: BRIDGE_TOKEN is missing or shorter than 16 characters.');
  console.error('Run:  npm run bridge -- init   to generate a .env with a token.');
  process.exit(1);
}

// A registered project is the boundary the entire policy is written against.
// Starting with none would leave every call failing, so say so up front.
// (loadRegistry seeds itself from a legacy BRIDGE_PROJECT_DIR on first run.)
const registered = listProjects();
if (registered.length === 0) {
  console.error('FATAL: no projects are registered, so the bridge has nothing it may work in.');
  console.error('Register one at this machine:  npm run bridge -- project add <name> <path>');
  process.exit(1);
}

function tokenMatches(provided) {
  if (!provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(cfg.token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const app = express();
app.set('trust proxy', true);

// Temporary request tracing, enabled with BRIDGE_TRACE=1. Records the raw
// method/path/headers of every inbound request so a client that gets a 404 can
// be told exactly which path it asked for.
if (process.env.BRIDGE_TRACE === '1') {
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      audit({
        kind: 'http_trace',
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - started,
        ua: req.headers['user-agent'],
        accept: req.headers.accept,
        ct: req.headers['content-type'],
        mcp_session: req.headers['mcp-session-id'] || null,
        protocol_version: req.headers['mcp-protocol-version'] || null,
      });
    });
    next();
  });
}

// Pull a token out of the leading path segment and strip it, so that
// /<token>/mcp routes to /mcp.
app.use((req, _res, next) => {
  const m = req.url.match(/^\/([A-Za-z0-9_-]{16,})(\/.*)$/);
  if (m && tokenMatches(m[1])) {
    req.bridgeToken = m[1];
    req.url = m[2];
  }
  next();
});

app.get('/health', (_req, res) => {
  // Public endpoint: never leak filesystem paths or stack traces. An unhandled
  // throw here previously returned an HTML stack trace to the internet, and —
  // worse — made a real degradation look like a generic 500 for days. Report
  // the degradation instead.
  try {
    const projects = listProjects();
    res.json({
      ok: true,
      paused: isPaused(),
      projects: projects.length,
      default_project: projects.find((p) => p.is_default)?.name ?? null,
    });
  } catch (err) {
    audit({ kind: 'health_degraded', error: `${err.code || ''} ${err.message}`.trim() });
    res.status(503).json({
      ok: false,
      degraded: true,
      // A code like EPERM/ENOENT is diagnostic without revealing a path.
      reason: err.code || 'internal_error',
    });
  }
});

// Body parsing must precede the OAuth endpoints: /register is JSON and /token
// is form-encoded per RFC 6749.
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));

// The OAuth handshake layer. Mounted BEFORE the bearer check, because a client
// that has not authenticated yet is exactly who needs to read these.
// This does not change how /mcp authenticates — it still accepts only
// BRIDGE_TOKEN; the token endpoint simply hands that same value out.
mountOAuth(app, cfg.token);

app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const provided = req.bridgeToken || bearer || req.headers['x-bridge-token'] || req.query.token;

  if (!tokenMatches(provided)) {
    audit({ kind: 'auth_rejected', ip: req.ip, path: req.path, ua: req.headers['user-agent'] });
    // RFC 9728: point the client at the resource metadata so it can discover
    // the authorization server rather than simply giving up.
    res.status(401)
      .set('WWW-Authenticate',
        `Bearer realm="claude-bridge", resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`)
      .json({ error: 'unauthorized' });
    return;
  }
  next();
});

// --- Streamable HTTP (current MCP transport), stateless ---------------------
// A fresh server + transport per request keeps this robust behind a tunnel that
// may not pin connections to one process.
app.all('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); });
  try {
    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    audit({ kind: 'transport_error', transport: 'streamable-http', error: String(err?.stack || err) });
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  }
});

// --- Legacy SSE transport, for clients that still speak it ------------------
const sseTransports = new Map();

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  sseTransports.set(transport.sessionId, transport);
  res.on('close', () => sseTransports.delete(transport.sessionId));
  const server = createServer();
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const transport = sseTransports.get(String(req.query.sessionId || ''));
  if (!transport) {
    res.status(400).json({ error: 'unknown sessionId' });
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

// Children are detached, so a previous server's runs may still be alive.
// Clear out dead records and warn loudly about any survivor: it is still
// writing to a project with nothing listening to its output.
const { reaped } = reapDeadActiveRuns();
const orphans = getLiveActiveRuns();

const listener = app.listen(cfg.port, cfg.host, () => {
  writeServerPid();
  const banner = [
    '',
    '  CLAUDE-BRIDGE is listening',
    `    local URL   http://${cfg.host}:${cfg.port}/mcp`,
    `    projects    ${registered.map((p) => (p.is_default ? `${p.name} (default)` : p.name)).join(', ')}`,
    `    state       ${isPaused() ? `PAUSED (${pauseReason().reason})` : 'live'}`,
    '',
    '  Expose it with:  npm run tunnel',
    `  Then give Claude.ai:  https://<tunnel-host>/${cfg.token}/mcp`,
    '',
  ].join('\n');
  console.log(banner);
  if (reaped) console.log(`  (cleared ${reaped} stale active-run record(s))\n`);
  for (const o of orphans) {
    console.log(`  ⚠ ORPHANED RUN still alive: ${o.run_id} (${o.project ?? 'unknown project'}) pid ${o.pid}, since ${o.started_at}`);
    console.log('    It survived a previous server; its output is no longer captured.');
    console.log(`    Inspect: ps -p ${o.pid}    Stop: kill ${o.pid}\n`);
  }
  audit({ kind: 'server_start', port: cfg.port, orphans: orphans.length, reaped });
});

// Last resort behind the targeted guards in state.mjs. The individual writes
// that are known to fail are handled at their call sites; this exists because
// the failure mode when one is missed is disproportionate — the process dies
// inside a child-exit handler, the tunnel stays up in front of a dead origin,
// and every subsequent call gets a connection refused until a human notices.
// Staying up degraded beats that, so log it loudly and keep serving.
process.on('uncaughtException', (err) => {
  console.error(`[bridge] UNCAUGHT: ${err?.stack || err}`);
  console.error('[bridge] still serving — inspect the above, this should not happen.');
  audit({ kind: 'uncaught_exception', error: String(err?.stack || err) });
});

process.on('unhandledRejection', (reason) => {
  console.error(`[bridge] UNHANDLED REJECTION: ${reason?.stack || reason}`);
  audit({ kind: 'unhandled_rejection', error: String(reason?.stack || reason) });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    audit({ kind: 'server_stop', signal: sig });
    clearServerPid();
    listener.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}
