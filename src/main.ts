import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
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
  console.error('Usage: node dist/main.js login');
  console.error('Usage: node dist/main.js serve');
  process.exitCode = 2;
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
