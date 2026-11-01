import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { hostHeaderValidation, originValidation, toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node';
import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolCatalog, type Catalog, type ToolResult } from './console.js';
import { login, openTokenStore, type TokenSource } from './token.js';

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const command = argv[2];
  if (command === 'login') {
    try {
      await login(env);
    } catch {
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'serve') {
    serveStdio(createServer);
    return;
  }
  if (command === 'serve-http') {
    serveHttp(env);
    return;
  }
  console.error('Usage: node dist/main.js login');
  console.error('Usage: node dist/main.js serve');
  console.error('Usage: GSC_HTTP_PORT=<port> node dist/main.js serve-http');
  process.exitCode = 2;
}

const DEFAULT_HTTP_PORT = 8097;

// Served on loopback behind mini.local's nginx, which forwards Host $host and no Origin header.
const ALLOWED_HOSTNAMES = ['mini.local', '127.0.0.1', 'localhost', '[::1]'];
const ALLOWED_ORIGINS = ['mini.local'];

function serveHttp(env: NodeJS.ProcessEnv): void {
  const port = Number(env.GSC_HTTP_PORT ?? DEFAULT_HTTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`GSC_HTTP_PORT must be a port number, got ${JSON.stringify(env.GSC_HTTP_PORT)}`);
    process.exitCode = 2;
    return;
  }
  const handler = createMcpHandler(() => createServer());
  const nodeHandler = toNodeHandler(handler);
  const validateHost = hostHeaderValidation(ALLOWED_HOSTNAMES);
  const validateOrigin = originValidation(ALLOWED_ORIGINS);
  createHttpServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    void nodeHandler(req as NodeIncomingMessageLike, res);
  })
    .listen(port, '127.0.0.1', () => {
      console.error(`gsc-mcp http listening on 127.0.0.1:${port}`);
    });
}

let processTokens: TokenSource | undefined;

function createServer(): McpServer {
  // The stdio entry may build a probe server and then the connection server.
  processTokens ??= openTokenStore(process.env);
  const server = new McpServer({ name: 'gsc', version: '1.0.0' });
  register(server, toolCatalog({ tokens: processTokens }));
  return server;
}

function isCatalogKey(catalog: Catalog, name: string): name is keyof Catalog {
  return Object.hasOwn(catalog, name);
}

function register(server: McpServer, catalog: Catalog): void {
  for (const name of Object.keys(catalog)) {
    if (!isCatalogKey(catalog, name)) continue;
    const tool = catalog[name];
    server.registerTool(name, { description: tool.description, inputSchema: tool.inputSchema }, async (args) =>
      toMcp(await tool.run(args)),
    );
  }
}

function toMcp(result: ToolResult<unknown>): CallToolResult {
  const text = result.ok ? JSON.stringify(result.value) : JSON.stringify({ code: result.code, message: result.message });
  if (result.ok) return { content: [{ type: 'text', text }] };
  return { isError: true, content: [{ type: 'text', text }] };
}

function startedAsCli(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return fileURLToPath(import.meta.url) === resolve(entry);
}

if (startedAsCli()) {
  await main(process.argv, process.env);
}
