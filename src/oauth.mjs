// ---------------------------------------------------------------------------
// Minimal OAuth 2.1 shim.
//
// Claude.ai will not talk to a custom connector that only wants a bearer token.
// Before it ever calls /mcp it probes, in order:
//
//   /.well-known/oauth-protected-resource/<path>   (RFC 9728)
//   /.well-known/oauth-protected-resource
//   /.well-known/oauth-authorization-server        (RFC 8414)
//   /register                                      (RFC 7591 dynamic reg)
//
// and gives up if any of them 401s. This module answers those, auto-approves
// the authorization request, and hands back the existing BRIDGE_TOKEN as the
// access token — so the MCP endpoint's auth is completely unchanged. It still
// only ever accepts that one token; this is a handshake wrapper in front of it,
// not a second way in.
//
// NOTE ON TRUST: /authorize approves without asking a human, because no human
// is watching. The thing standing between a stranger and a token is therefore
// the redirect_uri allowlist below — an attacker who finds the hostname cannot
// have the token delivered anywhere except a host on that list.
// ---------------------------------------------------------------------------
import crypto from 'node:crypto';
import { audit } from './audit.mjs';

const CODE_TTL_MS = 5 * 60 * 1000;

// code -> { redirectUri, challenge, method, clientId, expires }
const codes = new Map();
// client_id -> { redirectUris, name }
const clients = new Map();

const DEFAULT_REDIRECT_HOSTS = [
  'claude.ai', 'www.claude.ai',
  'claude.com', 'www.claude.com',
  'anthropic.com', 'console.anthropic.com',
];

function allowedRedirectHosts() {
  const extra = (process.env.BRIDGE_OAUTH_REDIRECT_HOSTS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return [...DEFAULT_REDIRECT_HOSTS, ...extra];
}

/** Public origin as seen by the client, honouring the tunnel's forwarding headers. */
function baseUrl(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function isRedirectAllowed(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  // Local clients (MCP Inspector, Claude Code) legitimately loop back.
  if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')
      && (u.protocol === 'http:' || u.protocol === 'https:')) return true;
  if (u.protocol !== 'https:') return false;
  return allowedRedirectHosts().includes(u.hostname);
}

function sweepExpiredCodes() {
  const now = Date.now();
  for (const [code, rec] of codes) if (rec.expires < now) codes.delete(code);
}

function verifyPkce(rec, verifier) {
  if (!rec.challenge) return true;            // client did not use PKCE
  if (!verifier) return false;
  if (rec.method === 'plain') return verifier === rec.challenge;
  const hash = crypto.createHash('sha256').update(verifier).digest('base64url');
  return hash === rec.challenge;
}

/**
 * Mount the shim. Must be installed BEFORE the bearer-auth middleware, since
 * every one of these endpoints has to be reachable unauthenticated — that is
 * the entire point of discovery.
 *
 * @param app     express app
 * @param token   the BRIDGE_TOKEN handed out as the access token
 */
export function mountOAuth(app, token) {
  // RFC 8414 / RFC 9728 both allow the well-known path to carry the resource's
  // own path suffix, and Claude.ai tries that form first. Match by prefix so
  // /.well-known/oauth-protected-resource/<anything> resolves too.
  app.use((req, res, next) => {
    const p = req.path;
    const base = baseUrl(req);

    if (p === '/.well-known/oauth-protected-resource'
        || p.startsWith('/.well-known/oauth-protected-resource/')) {
      audit({ kind: 'oauth_discovery', doc: 'protected-resource', ip: req.ip, path: p });
      return res.json({
        resource: base,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp'],
      });
    }

    if (p === '/.well-known/oauth-authorization-server'
        || p.startsWith('/.well-known/oauth-authorization-server/')
        || p === '/.well-known/openid-configuration') {
      audit({ kind: 'oauth_discovery', doc: 'authorization-server', ip: req.ip, path: p });
      return res.json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256', 'plain'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        scopes_supported: ['mcp'],
      });
    }

    return next();
  });

  // RFC 7591 dynamic client registration. Accepts anyone; the redirect_uri
  // allowlist is what actually constrains this, not registration.
  app.post('/register', (req, res) => {
    const body = req.body || {};
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    const clientId = `bridge-${crypto.randomBytes(12).toString('hex')}`;
    clients.set(clientId, { redirectUris, name: body.client_name || 'unnamed' });
    audit({
      kind: 'oauth_register', ip: req.ip, client_id: clientId,
      client_name: body.client_name || null, redirect_uris: redirectUris,
    });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: body.client_name || 'claude-bridge client',
    });
  });

  // Auto-approving authorization endpoint.
  app.get('/authorize', (req, res) => {
    sweepExpiredCodes();
    const { redirect_uri: redirectUri, state, code_challenge: challenge,
            code_challenge_method: method, client_id: clientId } = req.query;

    if (!redirectUri) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is required' });
    }
    // Never redirect to an unvetted URI — that would be an open redirect that
    // hands the access token to whoever asked.
    if (!isRedirectAllowed(String(redirectUri))) {
      audit({ kind: 'oauth_authorize_rejected', ip: req.ip, redirect_uri: String(redirectUri) });
      return res.status(400).type('text/plain').send(
        `claude-bridge refused this authorization.\n\n` +
        `redirect_uri: ${redirectUri}\n\n` +
        `Its host is not on the allowlist (${allowedRedirectHosts().join(', ')}).\n` +
        `If this is a client you trust, add its host to BRIDGE_OAUTH_REDIRECT_HOSTS in .env and restart.\n`
      );
    }

    const code = crypto.randomBytes(32).toString('base64url');
    codes.set(code, {
      redirectUri: String(redirectUri),
      challenge: challenge ? String(challenge) : null,
      method: method ? String(method) : 'plain',
      clientId: clientId ? String(clientId) : null,
      expires: Date.now() + CODE_TTL_MS,
    });

    const target = new URL(String(redirectUri));
    target.searchParams.set('code', code);
    if (state) target.searchParams.set('state', String(state));

    audit({ kind: 'oauth_authorize', ip: req.ip, client_id: clientId || null, redirect_uri: String(redirectUri) });
    res.redirect(302, target.toString());
  });

  app.post('/token', (req, res) => {
    sweepExpiredCodes();
    const body = req.body || {};
    const grant = body.grant_type;

    // Refresh is accepted so a client that tries to renew does not break; the
    // bridge token is long-lived, so the same value comes back.
    if (grant === 'refresh_token') {
      audit({ kind: 'oauth_token', ip: req.ip, grant: 'refresh_token' });
      return res.json({ access_token: token, token_type: 'Bearer', scope: 'mcp', refresh_token: token });
    }

    if (grant !== 'authorization_code') {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }

    const rec = codes.get(body.code);
    if (!rec) {
      audit({ kind: 'oauth_token_rejected', ip: req.ip, reason: 'unknown or expired code' });
      return res.status(400).json({ error: 'invalid_grant', error_description: 'unknown or expired code' });
    }
    codes.delete(body.code); // single use

    if (rec.expires < Date.now()) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'code expired' });
    }
    if (body.redirect_uri && body.redirect_uri !== rec.redirectUri) {
      audit({ kind: 'oauth_token_rejected', ip: req.ip, reason: 'redirect_uri mismatch' });
      return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    }
    if (!verifyPkce(rec, body.code_verifier)) {
      audit({ kind: 'oauth_token_rejected', ip: req.ip, reason: 'PKCE verification failed' });
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }

    audit({ kind: 'oauth_token', ip: req.ip, grant: 'authorization_code', client_id: rec.clientId });
    res.json({ access_token: token, token_type: 'Bearer', scope: 'mcp', refresh_token: token });
  });
}

export { baseUrl };
