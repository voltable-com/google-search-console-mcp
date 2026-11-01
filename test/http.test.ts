import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = 18797;
const loginPort = 18798;
const url = `http://127.0.0.1:${port}/mcp/gsc`;

function serveHttp(): ChildProcessByStdio<null, null, Readable> {
  return spawn(process.execPath, ['dist/main.js', 'serve-http'], {
    cwd: root,
    env: { GSC_HTTP_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

async function rpc(body: unknown, targetPort = port): Promise<Response> {
  return fetch(targetPort === port ? url : `http://127.0.0.1:${targetPort}/mcp/gsc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
}

function getWithHost(path: string, hostHeader: string, targetPort = port): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const req = request(
    { host: '127.0.0.1', port: targetPort, path, method: 'GET', headers: { host: hostHeader } },
    (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    },
  );
  req.on('error', reject);
  req.end();
  return promise;
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

function postLoginWithHost(hostHeader: string, targetPort: number): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const req = request(
    {
      host: '127.0.0.1',
      port: targetPort,
      path: '/mcp/gsc/login/',
      method: 'POST',
      headers: { host: hostHeader, 'content-type': 'application/x-www-form-urlencoded' },
    },
    (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    },
  );
  req.on('error', reject);
  req.end('url=http%3A%2F%2F127.0.0.1%3A9%2F%3Fcode%3Dx%26state%3Dy');
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

    assert.equal(await getWithHost('/login/', '127.0.0.1'), 503);
    assert.equal(await getWithHost('/login/', 'evil.example'), 403);
    assert.equal(await getWithHost('/mcp/gsc/login/', 'evil.example'), 403);
  } finally {
    child.kill();
  }
});

test('serve-http answers the unconfigured login page with 503 while MCP routes stay mounted', async () => {
  const child = spawn(process.execPath, ['dist/main.js', 'serve-http'], {
    cwd: root,
    env: { GSC_HTTP_PORT: String(loginPort) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    await waitForServer(child);

    const signin = await fetch(`http://127.0.0.1:${loginPort}/mcp/gsc/login/`);
    assert.equal(signin.status, 503);
    assert.equal(signin.headers.get('cache-control'), 'no-store');
    const text = await signin.text();
    assert.match(text, /GSC_OAUTH_CLIENT_FILE/);
    assert.match(text, /GSC_LOGIN_URL/);

    const signinPost = await fetch(`http://127.0.0.1:${loginPort}/mcp/gsc/login/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'url=http%3A%2F%2F127.0.0.1%3A9%2F%3Fcode%3Dx%26state%3Dy',
    });
    assert.equal(signinPost.status, 503);
    assert.equal(signinPost.headers.get('cache-control'), 'no-store');
    assert.match(await signinPost.text(), /GSC_OAUTH_CLIENT_FILE/);

    const init = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      },
      loginPort,
    );
    assert.equal(init.status, 200);

    assert.equal(await getWithHost('/login/', 'evil.example', loginPort), 403);
    assert.equal(await postLoginWithHost('evil.example', loginPort), 403);
  } finally {
    child.kill();
  }
});
