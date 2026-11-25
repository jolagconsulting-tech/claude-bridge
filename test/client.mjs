// Manual end-to-end client: talks to the running bridge exactly the way a
// remote MCP client does.
//   node test/client.mjs                          → list tools
//   node test/client.mjs "do the thing"           → run_claude_code
//   node test/client.mjs --tool bridge_status     → call any tool with no args
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../src/paths.mjs';

const cfg = config();
const base = process.env.BRIDGE_URL || `http://127.0.0.1:${cfg.port}/mcp`;

const args = process.argv.slice(2);
const transport = new StreamableHTTPClientTransport(new URL(base), {
  requestInit: { headers: { Authorization: `Bearer ${cfg.token}` } },
});

const client = new Client({ name: 'bridge-test-client', version: '0.1.0' });
await client.connect(transport);

if (args[0] === '--tool') {
  const res = await client.callTool({ name: args[1], arguments: {} }, undefined, { timeout: 900_000 });
  console.log(res.content.map((c) => c.text).join('\n'));
} else if (args.length) {
  const res = await client.callTool(
    { name: 'run_claude_code', arguments: { prompt: args.join(' '), wait_seconds: 600 } },
    undefined,
    { timeout: 900_000 }
  );
  console.log(res.content.map((c) => c.text).join('\n'));
} else {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(`${t.name.padEnd(28)} ${t.description.slice(0, 90)}…`);
}

await client.close();
process.exit(0);
