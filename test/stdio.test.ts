import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serve(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['dist/main.js', 'serve'], {
    cwd: root,
    env: {},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function session(child: ChildProcessWithoutNullStreams) {
  const stderr: string[] = [];
  child.stderr.on('data', (chunk: Buffer) => {
    stderr.push(chunk.toString('utf8'));
  });
  let buffer = '';
  const waiters: { id: number; resolve: (message: unknown) => void; reject: (error: Error) => void }[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(message) || typeof message.id !== 'number') continue;
      const index = waiters.findIndex((waiter) => waiter.id === message.id);
      const waiter = index === -1 ? undefined : waiters[index];
      if (waiter === undefined) continue;
      waiters.splice(index, 1);
      waiter.resolve(message);
    }
  });
  return {
    stderr,
    send(message: unknown) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    wait(id: number): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for ${id}. stderr: ${stderr.join('')}`));
        }, 5000);
        waiters.push({
          id,
          resolve(message) {
            clearTimeout(timer);
            resolve(message);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
    },
  };
}

test('stdio tools/list names list_sites, search_analytics, inspect_url, and list_sitemaps', async () => {
  const child = serve();
  const client = session(child);
  try {
    const listed = client.wait(2);
    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'gsc-test', version: '0' },
      },
    });
    await client.wait(1);
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const message = await listed;
    assert.ok(isRecord(message));
    assert.equal(message.error, undefined);
    const result = message.result;
    assert.ok(isRecord(result));
    const tools = result.tools;
    assert.ok(Array.isArray(tools));
    const names = tools.map((tool) => {
      assert.ok(isRecord(tool));
      assert.equal(typeof tool.name, 'string');
      return tool.name;
    });
    assert.deepEqual(names, ['list_sites', 'search_analytics', 'inspect_url', 'list_sitemaps']);
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 3000);
    await once(child, 'exit');
    clearTimeout(timer);
  }
});
