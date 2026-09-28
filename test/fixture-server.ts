import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export type Setup = (server: McpServer) => void;
export type Options = { token?: string; delayMs?: number };

// Stateless test MCP server over real HTTP, optionally requiring a bearer token or stalling.
export async function startServer(setup: Setup, opts: Options = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const http: Server = createServer(async (req, res) => {
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    let raw = '';
    try {
      for await (const chunk of req) raw += chunk;
    } catch {
      return; // client gave up (e.g. the timeout test); nothing to answer
    }
    const mcp = new McpServer({ name: 'fixture', version: '1.0.0' });
    setup(mcp);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => void transport.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp?api_key=secret123`,
    close: () => new Promise((r) => { http.closeAllConnections(); http.close(() => r()); }),
  };
}
