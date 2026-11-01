import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = 18797;
const url = `http://127.0.0.1:${port}/mcp/gsc`;

function serveHttp(): ChildProcessByStdio<null, null, Readable> {
  return spawn(process.execPath, ['dist/main.js', 'serve-http'], {
    cwd: root,
    env: { GSC_HTTP_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

async function rpc(body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
}

function postWithHost(hostHeader: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const req = request(
    {
      host: '127.0.0.1',
      port,
      path: '/mcp/gsc',
      method: 'POST',
      headers: { host: hostHeader, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    },
    (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    },
  );
  req.on('error', reject);
  req.end(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }));
  return promise;
}

async function jsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  const frame = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(frame?.slice(6) ?? text);
}

async function waitForServer(child: ChildProcessByStdio<null, null, Readable>): Promise<void> {
  const started = once(child.stderr, 'data').then(() => 'started' as const);
  const exited = once(child, 'exit').then(() => 'exited' as const);
  const outcome = await Promise.race([started, exited]);
  if (outcome !== 'started') throw new Error('serve-http exited before listening');
}

test('serve-http answers tools/list with the catalog names and rejects rebinding hosts', async () => {
  const child = serveHttp();
  try {
    await waitForServer(child);

    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    assert.equal(init.status, 200);
    const initBody = (await jsonBody(init)) as { result?: { serverInfo?: { name?: string } } };
    assert.equal(initBody.result?.serverInfo?.name, 'gsc');

    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(list.status, 200);
    const listBody = (await jsonBody(list)) as { result?: { tools?: { name: string }[] } };
    assert.deepEqual(
      listBody.result?.tools?.map((tool) => tool.name),
      ['list_sites', 'search_analytics', 'inspect_url', 'list_sitemaps', 'add_site', 'remove_site', 'submit_sitemap', 'remove_sitemap'],
    );

    const rebinding = await postWithHost('evil.example');
    assert.equal(rebinding, 403);
  } finally {
    child.kill();
  }
});
