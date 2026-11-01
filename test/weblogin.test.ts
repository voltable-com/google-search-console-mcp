import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCOPE, type Adopted, type TokenResult, type TokenStore } from '../dist/token.js';
import {
  defaultDeviceFlow,
  openWebLogin,
  type DeviceClient,
  type DeviceFlow,
  type DevicePollResult,
  type DeviceSession,
} from '../dist/weblogin.js';

const LOGIN_URL = 'https://mini.local/mcp/gsc/login/';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const POLL_DELAY_MS = 5 * 1000 + 5_000;

function session(overrides: Partial<DeviceSession> = {}): DeviceSession {
  return {
    deviceCode: 'device-1',
    userCode: 'ABCD-EFGH',
    verificationUrl: 'https://www.google.com/device',
    expiresIn: 300,
    interval: 5,
    ...overrides,
  };
}

function fakeDevice(sessions: DeviceSession[]) {
  const starts: DeviceClient[] = [];
  const pollCalls: string[] = [];
  const results: DevicePollResult[] = [];
  let index = 0;
  return {
    starts,
    pollCalls,
    queue(...next: DevicePollResult[]) {
      results.push(...next);
    },
    async start(client: DeviceClient): Promise<DeviceSession | { error: string }> {
      starts.push(client);
      const next = sessions[Math.min(index, sessions.length - 1)] ?? session();
      index += 1;
      return { ...next };
    },
    async poll(_client: DeviceClient, deviceCode: string): Promise<DevicePollResult> {
      pollCalls.push(deviceCode);
      const next = results.shift();
      return next ?? { state: 'pending', slowDown: false };
    },
  };
}

type FakeDevice = ReturnType<typeof fakeDevice>;

function clock(startMs = 1_700_000_000_000) {
  let ms = startMs;
  return {
    now: () => ms,
    advance: (deltaMs: number) => {
      ms += deltaMs;
    },
  };
}

function recordingStore(events: string[], adopted: Adopted[], tokenFile: string): TokenStore {
  return {
    async accessToken(): Promise<TokenResult> {
      return { ok: false, message: 'unused' };
    },
    async refresh(): Promise<TokenResult> {
      return { ok: false, message: 'unused' };
    },
    loginHint() {
      return `Open ${LOGIN_URL} in a browser to sign in`;
    },
    adopt(c: Adopted) {
      try {
        events.push(`adopt:${readFileSync(tokenFile, 'utf8')}`);
      } catch {
        events.push('adopt:no-file');
      }
      adopted.push(c);
    },
  };
}

async function harness(
  opts: {
    webClientFile?: string | null;
    loginUrl?: string | null;
    device?: FakeDevice;
    time?: ReturnType<typeof clock>;
  } = {},
): Promise<{
  base: string;
  dir: string;
  tokenFile: string;
  events: string[];
  adopted: Adopted[];
  device: FakeDevice;
  time: ReturnType<typeof clock>;
  close(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'gsc-weblogin-'));
  const tokenFile = join(dir, 'token.json');
  let webFile = join(dir, 'client-web.json');
  if (opts.webClientFile === null) {
    webFile = '';
  } else if (typeof opts.webClientFile === 'string') {
    webFile = opts.webClientFile;
  } else {
    await writeFile(
      webFile,
      JSON.stringify({ installed: { client_id: 'web-id', client_secret: 'web-secret', token_uri: 'https://oauth2.test/token' } }),
    );
  }
  const env: NodeJS.ProcessEnv = {
    GSC_TOKEN_FILE: tokenFile,
    GSC_OAUTH_WEB_CLIENT_FILE: webFile,
    GSC_LOGIN_URL: LOGIN_URL,
  };
  if (opts.webClientFile === null) delete env.GSC_OAUTH_WEB_CLIENT_FILE;
  if (opts.loginUrl === null) delete env.GSC_LOGIN_URL;
  const events: string[] = [];
  const adopted: Adopted[] = [];
  const device = opts.device ?? fakeDevice([session()]);
  const time = opts.time ?? clock();
  const webLogin = openWebLogin({ env, store: recordingStore(events, adopted, tokenFile), device, now: time.now });
  const server: Server = createServer((req, res) => {
    void webLogin.tryHandle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('mcp-stub');
      }
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not bind');
  return {
    base: `http://127.0.0.1:${address.port}`,
    dir,
    tokenFile,
    events,
    adopted,
    device,
    time,
    async close() {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(closed.resolve);
      await closed.promise;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('GET /login/ begins the device flow and renders the user code behind no-store', async () => {
  for (const path of ['/login/', '/mcp/gsc/login/', '/login']) {
    const h = await harness();
    try {
      const response = await fetch(h.base + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const page = await response.text();
      assert.match(page, /<meta http-equiv="refresh" content="3">/);
      assert.match(page, /ABCD-EFGH/);
      assert.match(page, /https:\/\/www\.google\.com\/device/);
      assert.deepEqual(h.device.starts, [{ clientId: 'web-id', clientSecret: 'web-secret', tokenUri: 'https://oauth2.test/token' }]);
      assert.deepEqual(h.device.pollCalls, []);
    } finally {
      await h.close();
    }
  }
});

test('polling waits for nextPollAt and pending keeps the page', async () => {
  const h = await harness();
  try {
    const first = await (await fetch(h.base + '/login/')).text();
    assert.match(first, /ABCD-EFGH/);
    await fetch(h.base + '/login/');
    assert.equal(h.device.pollCalls.length, 0);
    assert.equal(h.device.starts.length, 1);
    h.time.advance(POLL_DELAY_MS - 1);
    await fetch(h.base + '/login/');
    assert.equal(h.device.pollCalls.length, 0);
    h.time.advance(1);
    await fetch(h.base + '/login/');
    assert.deepEqual(h.device.pollCalls, ['device-1']);
    const page = await (await fetch(h.base + '/login/')).text();
    assert.match(page, /ABCD-EFGH/);
    assert.equal(h.device.pollCalls.length, 1);
    h.time.advance(POLL_DELAY_MS - 1);
    await fetch(h.base + '/login/');
    assert.equal(h.device.pollCalls.length, 1);
    h.time.advance(1);
    await fetch(h.base + '/login/');
    assert.equal(h.device.pollCalls.length, 2);
  } finally {
    await h.close();
  }
});

test('a granted poll publishes the token file, then adopts', async () => {
  const device = fakeDevice([session()]);
  device.queue({ state: 'granted', refreshToken: 'refresh-web', grantedScope: SCOPE });
  const h = await harness({ device });
  try {
    await fetch(h.base + '/mcp/gsc/login/');
    h.time.advance(POLL_DELAY_MS);
    const response = await fetch(h.base + '/mcp/gsc/login/');
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.match(page, /Login complete/);
    assert.doesNotMatch(page, /meta http-equiv="refresh"/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(h.events, [`adopt:{"refreshToken":"refresh-web","scope":"${SCOPE}","client":"web"}`]);
    assert.deepEqual(h.adopted, [{ refreshToken: 'refresh-web', clientId: 'web-id', clientSecret: 'web-secret' }]);
    assert.equal(await readFile(h.tokenFile, 'utf8'), JSON.stringify({ refreshToken: 'refresh-web', scope: SCOPE, client: 'web' }));
  } finally {
    await h.close();
  }
});

test('slow_down backs the next poll off by five more seconds', async () => {
  const device = fakeDevice([session()]);
  device.queue({ state: 'pending', slowDown: true }, { state: 'granted', refreshToken: 'refresh-web', grantedScope: SCOPE });
  const h = await harness({ device });
  try {
    await fetch(h.base + '/login/');
    h.time.advance(POLL_DELAY_MS);
    await fetch(h.base + '/login/');
    assert.equal(h.device.pollCalls.length, 1);
    h.time.advance(POLL_DELAY_MS + 5_000 - 1);
    await fetch(h.base + '/login/');
    assert.equal(h.device.pollCalls.length, 1);
    h.time.advance(1);
    const page = await (await fetch(h.base + '/login/')).text();
    assert.equal(h.device.pollCalls.length, 2);
    assert.match(page, /Login complete/);
  } finally {
    await h.close();
  }
});

test('access_denied answers the failed page with a restart link and re-begins', async () => {
  const device = fakeDevice([session(), session({ deviceCode: 'device-2', userCode: 'WWXX-YYZZ' })]);
  device.queue({ state: 'failed', error: 'access_denied' });
  const h = await harness({ device });
  try {
    await fetch(h.base + '/mcp/gsc/login/');
    h.time.advance(POLL_DELAY_MS);
    const failed = await (await fetch(h.base + '/mcp/gsc/login/')).text();
    assert.match(failed, /access_denied/);
    assert.match(failed, /<a href="\/mcp\/gsc\/login\/">Sign in again<\/a>/);
    await fetch(h.base + '/mcp/gsc/login/');
    assert.equal(h.device.starts.length, 2);
    assert.equal(h.device.pollCalls.length, 1);
    const restarted = await (await fetch(h.base + '/mcp/gsc/login/')).text();
    assert.match(restarted, /WWXX-YYZZ/);
  } finally {
    await h.close();
  }
});

test('an expired slot re-begins with a fresh device code', async () => {
  const device = fakeDevice([session(), session({ deviceCode: 'device-2', userCode: 'WWXX-YYZZ' })]);
  const h = await harness({ device });
  try {
    await fetch(h.base + '/login/');
    h.time.advance(300 * 1000);
    const page = await (await fetch(h.base + '/login/')).text();
    assert.equal(h.device.starts.length, 2);
    assert.equal(h.device.pollCalls.length, 0);
    assert.match(page, /WWXX-YYZZ/);
    assert.doesNotMatch(page, /ABCD-EFGH/);
  } finally {
    await h.close();
  }
});

test('a read-only grant answers the scope failure and writes no token file', async () => {
  const device = fakeDevice([session()]);
  device.queue({ state: 'granted', refreshToken: 'refresh-web', grantedScope: READONLY_SCOPE });
  const h = await harness({ device });
  try {
    await fetch(h.base + '/login/');
    h.time.advance(POLL_DELAY_MS);
    const page = await (await fetch(h.base + '/login/')).text();
    assert.match(page, /Login failed/);
    assert.match(page, /scope/);
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.adopted, []);
    assert.equal(await readFile(h.tokenFile, 'utf8').catch(() => null), null);
  } finally {
    await h.close();
  }
});

test('a granted poll without a refresh token answers the failed page', async () => {
  const device = fakeDevice([session()]);
  device.queue({ state: 'granted', refreshToken: '', grantedScope: SCOPE });
  const h = await harness({ device });
  try {
    await fetch(h.base + '/login/');
    h.time.advance(POLL_DELAY_MS);
    const page = await (await fetch(h.base + '/login/')).text();
    assert.match(page, /no refresh token/);
    assert.deepEqual(h.events, []);
  } finally {
    await h.close();
  }
});

test('non-GET requests, removed callback, and non-login paths are not handled', async () => {
  const h = await harness();
  try {
    const post = await fetch(h.base + '/login/', { method: 'POST' });
    assert.equal(post.status, 404);
    assert.equal(await post.text(), 'mcp-stub');
    const callback = await fetch(h.base + '/mcp/gsc/login/callback?code=code-1&state=st');
    assert.equal(callback.status, 404);
    assert.equal(await callback.text(), 'mcp-stub');
    const other = await fetch(h.base + '/login/extra');
    assert.equal(other.status, 404);
    assert.equal(h.device.starts.length, 0);
  } finally {
    await h.close();
  }
});

test('missing web configuration answers 503 naming both env vars', async () => {
  const noLoginUrl = await harness({ loginUrl: null });
  try {
    const response = await fetch(noLoginUrl.base + '/mcp/gsc/login/');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text();
    assert.match(text, /GSC_OAUTH_WEB_CLIENT_FILE/);
    assert.match(text, /GSC_LOGIN_URL/);
    assert.equal(noLoginUrl.device.starts.length, 0);
  } finally {
    await noLoginUrl.close();
  }
  const noClient = await harness({ webClientFile: null });
  try {
    const response = await fetch(noClient.base + '/login/');
    assert.equal(response.status, 503);
    assert.match(await response.text(), /GSC_OAUTH_WEB_CLIENT_FILE/);
  } finally {
    await noClient.close();
  }
  const dir = await mkdtemp(join(tmpdir(), 'gsc-weblogin-'));
  try {
    const junkFile = join(dir, 'junk.json');
    await writeFile(junkFile, '{"note":"no client here"}');
    const junk = await harness({ webClientFile: junkFile });
    try {
      const response = await fetch(junk.base + '/login/');
      assert.equal(response.status, 503);
      assert.match(await response.text(), /GSC_OAUTH_WEB_CLIENT_FILE/);
    } finally {
      await junk.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('defaultDeviceFlow posts form-encoded requests to the device and token endpoints', async () => {
  const client: DeviceClient = { clientId: 'cid', clientSecret: 'sec', tokenUri: 'https://oauth2.test/token' };
  const calls: { url: string; contentType: string; body: URLSearchParams }[] = [];
  const replies: unknown[] = [
    { device_code: 'dc-1', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: '300', interval: '5' },
    { error: 'authorization_pending' },
    { error: 'slow_down' },
    { refresh_token: 'rt-1', scope: SCOPE },
    { device_code: 'dc-2', user_code: 'WXYZ-1234', verification_uri: 'https://oauth2.googleapis.com/activate', expires_in: 600, interval: 10 },
    'not json',
    { error: 'expired_token' },
  ];
  let rejectNext = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    if (rejectNext) {
      rejectNext = false;
      throw new TypeError('network down');
    }
    calls.push({
      url: String(input),
      contentType: init?.headers?.['content-type'] ?? '',
      body: new URLSearchParams(init?.body ?? ''),
    });
    const payload = replies.shift();
    return new Response(payload === undefined ? '{}' : JSON.stringify(payload), { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    assert.deepEqual(await defaultDeviceFlow.start(client), {
      deviceCode: 'dc-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://www.google.com/device',
      expiresIn: 300,
      interval: 5,
    });
    assert.equal(calls[0]?.url, DEVICE_CODE_URL);
    assert.equal(calls[0]?.contentType, 'application/x-www-form-urlencoded');
    assert.equal(calls[0]?.body.get('client_id'), 'cid');
    assert.equal(calls[0]?.body.get('client_secret'), 'sec');
    assert.equal(calls[0]?.body.get('scope'), SCOPE);

    assert.deepEqual(await defaultDeviceFlow.poll(client, 'dc-1'), { state: 'pending', slowDown: false });
    assert.equal(calls[1]?.url, 'https://oauth2.test/token');
    assert.equal(calls[1]?.contentType, 'application/x-www-form-urlencoded');
    assert.equal(calls[1]?.body.get('grant_type'), GRANT);
    assert.equal(calls[1]?.body.get('device_code'), 'dc-1');
    assert.equal(calls[1]?.body.get('client_id'), 'cid');
    assert.equal(calls[1]?.body.get('client_secret'), 'sec');
    assert.deepEqual(await defaultDeviceFlow.poll(client, 'dc-1'), { state: 'pending', slowDown: true });
    assert.deepEqual(await defaultDeviceFlow.poll(client, 'dc-1'), { state: 'granted', refreshToken: 'rt-1', grantedScope: SCOPE });

    assert.deepEqual(await defaultDeviceFlow.start(client), {
      deviceCode: 'dc-2',
      userCode: 'WXYZ-1234',
      verificationUrl: 'https://oauth2.googleapis.com/activate',
      expiresIn: 600,
      interval: 10,
    });
    assert.deepEqual(await defaultDeviceFlow.poll(client, 'dc-2'), { state: 'failed', error: 'device flow response malformed' });
    assert.deepEqual(await defaultDeviceFlow.poll(client, 'dc-2'), { state: 'failed', error: 'expired_token' });
    rejectNext = true;
    assert.deepEqual(await defaultDeviceFlow.poll(client, 'dc-2'), { state: 'failed', error: 'device flow request failed' });
  } finally {
    globalThis.fetch = original;
  }
});
