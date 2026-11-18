// The `studio` MCP server an agent CLI starts (stdio). It holds no state and no file access of its own: it lists
// the app's tools and forwards each call to the running app with the turn's token.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const API = process.env.STUDIO_API ?? '';
const TOKEN = process.env.STUDIO_AGENT_TOKEN ?? '';

async function call(path: string, init?: { method?: string; body?: unknown }) {
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json', 'x-agent-token': TOKEN },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

const server = new Server({ name: 'studio', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => call('/agent/tools'));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await call('/agent/call', { method: 'POST', body: { name: req.params.name, args: req.params.arguments ?? {} } });
  } catch (e) {
    return { content: [{ type: 'text', text: `Video Studio is not answering: ${(e as Error).message}` }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
