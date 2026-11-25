// Walks the full OAuth handshake the way Claude.ai does, then uses the issued
// token to make a real MCP call. Run against the public tunnel URL:
//   node test/oauth-flow.mjs https://<host>.trycloudflare.com
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
};

// 1. protected resource metadata (RFC 9728)
const prm = await fetch(`${base}/.well-known/oauth-protected-resource`).then((r) => r.json());
ok('protected-resource metadata', Array.isArray(prm.authorization_servers), prm.authorization_servers?.[0]);

// 2. authorization server metadata (RFC 8414)
const asm = await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`).then((r) => r.json());
ok('authorization-server metadata', !!asm.authorization_endpoint && !!asm.token_endpoint);
ok('advertises dynamic registration', !!asm.registration_endpoint);
ok('advertises PKCE S256', (asm.code_challenge_methods_supported || []).includes('S256'));

// 3. dynamic client registration (RFC 7591)
const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
const reg = await fetch(asm.registration_endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'oauth-flow-test', redirect_uris: [redirectUri] }),
}).then((r) => r.json());
ok('dynamic client registration', !!reg.client_id, reg.client_id);

// 4. authorize with PKCE — expect a 302 carrying code + state
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(8).toString('hex');
const authUrl = new URL(asm.authorization_endpoint);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('client_id', reg.client_id);
authUrl.searchParams.set('redirect_uri', redirectUri);
authUrl.searchParams.set('state', state);
authUrl.searchParams.set('code_challenge', challenge);
authUrl.searchParams.set('code_challenge_method', 'S256');

const authRes = await fetch(authUrl, { redirect: 'manual' });
const location = authRes.headers.get('location') || '';
const returned = new URL(location || 'https://x.invalid');
const code = returned.searchParams.get('code');
ok('authorize redirects (302)', authRes.status === 302, `status ${authRes.status}`);
ok('authorize returns a code', !!code);
ok('authorize echoes state', returned.searchParams.get('state') === state);

// 5. token exchange
const tok = await fetch(asm.token_endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: reg.client_id, code_verifier: verifier,
  }),
}).then((r) => r.json());
ok('token exchange returns access_token', !!tok.access_token);
ok('token_type is Bearer', tok.token_type === 'Bearer');

// 6. the code must not be reusable
const replay = await fetch(asm.token_endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }),
});
ok('authorization code is single-use', replay.status === 400);

// 7. wrong PKCE verifier must be rejected
const a2 = await fetch(authUrl, { redirect: 'manual' });
const code2 = new URL(a2.headers.get('location')).searchParams.get('code');
const badPkce = await fetch(asm.token_endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: code2, redirect_uri: redirectUri, code_verifier: 'wrong-verifier' }),
});
ok('bad PKCE verifier rejected', badPkce.status === 400);

// 8. redirect_uri allowlist blocks token exfiltration
const evil = new URL(asm.authorization_endpoint);
evil.searchParams.set('redirect_uri', 'https://evil.example.com/steal');
evil.searchParams.set('response_type', 'code');
const evilRes = await fetch(evil, { redirect: 'manual' });
ok('untrusted redirect_uri refused', evilRes.status === 400, `status ${evilRes.status}`);

// 9. the issued token actually works on the MCP endpoint
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } },
});
const client = new Client({ name: 'oauth-flow-test', version: '0.1.0' });
await client.connect(transport);
const { tools } = await client.listTools();
ok('MCP call with OAuth-issued token', tools.length > 0, `${tools.length} tools`);
await client.close();

console.log(process.exitCode ? '\nFAILED' : '\nfull OAuth handshake works end to end');
process.exit(process.exitCode || 0);
