import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCOPE, type Adopted, type TokenResult, type TokenStore } from '../dist/token.js';
import { openWebLogin, type WebExchangeResult } from '../dist/weblogin.js';

const LOGIN_URL = 'https://mini.local/mcp/gsc/login/';
const LOOPBACK_ORIGIN = 'http://127.0.0.1:41799';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const GRANTED: WebExchangeResult = { refreshToken: 'refresh-1', grantedScope: SCOPE };

type Clock = { now(): number; advance(deltaMs: number): void };

function clock(startMs = 1_700_000_000_000): Clock {
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

function fakeExchange(results: WebExchangeResult[]) {
  const codes: string[] = [];
  return {
    codes,
    exchange: async (code: string): Promise<WebExchangeResult> => {
      codes.push(code);
      return results.shift() ?? GRANTED;
    },
  };
}

async function harness(
  opts: {
    loginUrl?: string | null;
    clientFile?: string | null;
    results?: WebExchangeResult[];
  } = {},
): Promise<{
  base: string;
  dir: string;
  tokenFile: string;
  events: string[];
  adopted: Adopted[];
  time: Clock;
  get(path: string): Promise<Response>;
  post(path: string, url: string): Promise<Response>;
  postRaw(path: string, body: string, contentType: string): Promise<Response>;
  close(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'gsc-weblogin-'));
  const tokenFile = join(dir, 'token.json');
  const env: NodeJS.ProcessEnv = { GSC_TOKEN_FILE: tokenFile };
  if (opts.clientFile === null) {
    // GSC_OAUTH_CLIENT_FILE stays unset
  } else if (typeof opts.clientFile === 'string') {
    env.GSC_OAUTH_CLIENT_FILE = opts.clientFile;
  } else {
    env.GSC_OAUTH_CLIENT_FILE = join(dir, 'client.json');
    await writeFile(
      env.GSC_OAUTH_CLIENT_FILE,
      JSON.stringify({ installed: { client_id: 'test-client', client_secret: 'test-secret' } }),
    );
  }
  if (opts.loginUrl !== null) env.GSC_LOGIN_URL = LOGIN_URL;
  const events: string[] = [];
  const adopted: Adopted[] = [];
  const time = clock();
  const fake = fakeExchange(opts.results ?? []);
  const webLogin = openWebLogin({ env, store: recordingStore(events, adopted, tokenFile), exchange: fake.exchange, now: time.now });
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
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    dir,
    tokenFile,
    events,
    adopted,
    codes: fake.codes,
    time,
    get: (path) => fetch(`${base}${path}`),
    post: (path, url) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ url }).toString(),
      }),
    postRaw: (path, body, contentType) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': contentType }, body }),
    async close() {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(closed.resolve);
      await closed.promise;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function stateOf(html: string): string {
  const state = /state=([0-9a-f]{32})/.exec(html)?.[1];
  assert.equal(typeof state, 'string', 'begin page carries the state');
  return state as string;
}

function pasted(state: string, query: string): string {
  return `${LOOPBACK_ORIGIN}/?${query}&state=${state}`;
}

test('GET /login/ begins the login with a loopback authorize link and instructions', async () => {
  const h = await harness();
  try {
    const response = await h.get('/mcp/gsc/login/');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.match(html, /client_id=test-client/);
    assert.match(html, /access_type=offline/);
    assert.match(html, /prompt=consent/);
    assert.match(html, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A41799%2F/);
    assert.match(html, /scope=https%3A%2F%2Fwww\.googleapis\.com%2Fauth%2Fwebmasters/);
    assert.match(html, /copy the FULL address from the bar and paste it below/);
    assert.match(html, /name="url"/);
    assert.doesNotMatch(html, /http-equiv/);
  } finally {
    await h.close();
  }
});

test('GET keeps the live slot and does not re-begin', async () => {
  const h = await harness();
  try {
    const first = stateOf(await (await h.get('/login/')).text());
    const second = stateOf(await (await h.get('/login/')).text());
    assert.equal(first, second);
  } finally {
    await h.close();
  }
});

test('an expired slot re-begins with a fresh state on GET', async () => {
  const h = await harness();
  try {
    const first = stateOf(await (await h.get('/login/')).text());
    h.time.advance(15 * 60_000 + 1);
    const second = stateOf(await (await h.get('/login/')).text());
    assert.notEqual(first, second);
  } finally {
    await h.close();
  }
});

test('POST without a live slot answers the no-login page with a restart link', async () => {
  const h = await harness();
  try {
    const response = await h.post('/login/', `${LOOPBACK_ORIGIN}/?code=early&state=whatever`);
    const html = await response.text();
    assert.match(html, /No login in progress\./);
    assert.match(html, /<a href="\/login\/">Start a new sign-in<\/a>/);
    assert.deepEqual(h.codes, []);
  } finally {
    await h.close();
  }
});

test('POST with the wrong state is a mismatch and the slot survives', async () => {
  const h = await harness();
  try {
    const state = stateOf(await (await h.get('/mcp/gsc/login/')).text());
    const mismatch = await h.post('/mcp/gsc/login/', `${LOOPBACK_ORIGIN}/?code=typo&state=${'d'.repeat(32)}`);
    assert.equal(mismatch.status, 200);
    assert.match(await mismatch.text(), /does not match the sign-in in progress/);
    assert.match(mismatch.headers.get('cache-control') ?? '', /no-store/);
    assert.deepEqual(h.codes, []);
    const done = await h.post('/mcp/gsc/login/', pasted(state, 'code=good'));
    assert.match(await done.text(), /Login complete/);
    assert.deepEqual(h.codes, ['good']);
  } finally {
    await h.close();
  }
});

test('POST with a foreign origin or path is a mismatch and the slot survives', async () => {
  const h = await harness();
  try {
    const state = stateOf(await (await h.get('/login/')).text());
    const wrongOrigin = await h.post('/login/', `http://127.0.0.1:8080/?code=x&state=${state}`);
    assert.match(await wrongOrigin.text(), /does not match the sign-in in progress/);
    const wrongPath = await h.post('/login/', `http://127.0.0.1:41799/callback?code=x&state=${state}`);
    assert.match(await wrongPath.text(), /does not match the sign-in in progress/);
    const notAUrl = await h.post('/login/', 'the whole address bar please');
    assert.match(await notAUrl.text(), /does not match the sign-in in progress/);
    assert.deepEqual(h.codes, []);
    const done = await h.post('/login/', pasted(state, 'code=still-works'));
    assert.match(await done.text(), /Login complete/);
  } finally {
    await h.close();
  }
});

test('POST with a Google error clears the slot and answers the denied page', async () => {
  const h = await harness();
  try {
    const state = stateOf(await (await h.get('/login/')).text());
    const denied = await h.post('/login/', `${LOOPBACK_ORIGIN}/?error=access_denied&state=${state}`);
    assert.match(await denied.text(), /Google denied the sign-in/);
    assert.match(denied.headers.get('cache-control') ?? '', /no-store/);
    assert.deepEqual(h.codes, []);
    const again = await h.post('/login/', pasted(state, 'code=too-late'));
    assert.match(await again.text(), /No login in progress\./);
  } finally {
    await h.close();
  }
});

test('a happy POST publishes the desktop token file, then adopts', async () => {
  const h = await harness();
  try {
    const state = stateOf(await (await h.get('/mcp/gsc/login/')).text());
    const response = await h.post('/mcp/gsc/login/', pasted(state, 'code=auth-code'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(await response.text(), /Login complete/);
    assert.deepEqual(h.codes, ['auth-code']);
    const info = await stat(h.tokenFile);
    assert.equal(info.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(h.tokenFile, 'utf8')), { refreshToken: 'refresh-1', scope: SCOPE, client: 'desktop' });
    assert.deepEqual(h.events, [`adopt:${JSON.stringify({ refreshToken: 'refresh-1', scope: SCOPE, client: 'desktop' })}`]);
    assert.deepEqual(h.adopted, [{ refreshToken: 'refresh-1', clientId: 'test-client', clientSecret: 'test-secret' }]);
  } finally {
    await h.close();
  }
});

test('an exchange error answers the failed page and the slot stays cleared', async () => {
  const h = await harness({ results: [{ error: 'token exchange failed' }] });
  try {
    const state = stateOf(await (await h.get('/login/')).text());
    const failed = await h.post('/login/', pasted(state, 'code=once'));
    assert.match(await failed.text(), /Login failed: token exchange failed\./);
    assert.match(failed.headers.get('cache-control') ?? '', /no-store/);
    assert.deepEqual(h.codes, ['once']);
    const again = await h.post('/login/', pasted(state, 'code=once'));
    assert.match(await again.text(), /No login in progress\./);
    assert.deepEqual(h.codes, ['once']);
  } finally {
    await h.close();
  }
});

test('a read-only grant answers the scope failure and writes no token file', async () => {
  const h = await harness({ results: [{ refreshToken: 'refresh-x', grantedScope: READONLY_SCOPE }] });
  try {
    const state = stateOf(await (await h.get('/login/')).text());
    const failed = await h.post('/login/', pasted(state, 'code=ro'));
    assert.match(await failed.text(), /Google did not grant the Search Console scope/);
    assert.equal(h.events.length, 0);
    await assert.rejects(readFile(h.tokenFile, 'utf8'));
  } finally {
    await h.close();
  }
});

test('a grant without a refresh token answers the failed page', async () => {
  const h = await harness({ results: [{ refreshToken: '', grantedScope: SCOPE }] });
  try {
    const state = stateOf(await (await h.get('/login/')).text());
    const failed = await h.post('/login/', pasted(state, 'code=empty'));
    assert.match(await failed.text(), /Google returned no refresh token/);
    assert.equal(h.events.length, 0);
  } finally {
    await h.close();
  }
});

test('an oversized login body answers 413 and the slot survives', async () => {
  const h = await harness();
  try {
    const state = stateOf(await (await h.get('/login/')).text());
    const oversized = await h.post('/login/', `${LOOPBACK_ORIGIN}/?code=${'x'.repeat(9000)}&state=${state}`);
    assert.equal(oversized.status, 413);
    assert.equal(oversized.headers.get('cache-control'), 'no-store');
    const done = await h.post('/login/', pasted(state, 'code=after-413'));
    assert.match(await done.text(), /Login complete/);
    assert.deepEqual(h.codes, ['after-413']);
  } finally {
    await h.close();
  }
});

test('POST without urlencoded content type is not handled', async () => {
  const h = await harness();
  try {
    const response = await h.postRaw('/mcp/gsc/login/', '{"url":"http://127.0.0.1:41799/"}', 'application/json');
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'mcp-stub');
  } finally {
    await h.close();
  }
});

test('non-login paths and other methods are not handled', async () => {
  const h = await harness();
  try {
    assert.equal((await h.get('/mcp/gsc/login/callback')).status, 404);
    assert.equal((await h.get('/mcp/gsc')).status, 404);
    const put = await fetch(`${h.base}/login/`, { method: 'PUT', body: 'url=anything' });
    assert.equal(put.status, 404);
  } finally {
    await h.close();
  }
});

test('GET and POST answer 503 naming GSC_LOGIN_URL and GSC_OAUTH_CLIENT_FILE when unconfigured', async () => {
  const noLoginUrl = await harness({ loginUrl: null });
  try {
    const get = await noLoginUrl.get('/mcp/gsc/login/');
    assert.equal(get.status, 503);
    assert.equal(get.headers.get('cache-control'), 'no-store');
    const getText = await get.text();
    assert.match(getText, /GSC_LOGIN_URL/);
    assert.match(getText, /GSC_OAUTH_CLIENT_FILE/);
    const post = await noLoginUrl.post('/mcp/gsc/login/', `${LOOPBACK_ORIGIN}/?code=x&state=y`);
    assert.equal(post.status, 503);
    assert.equal(post.headers.get('cache-control'), 'no-store');
  } finally {
    await noLoginUrl.close();
  }
  const noClient = await harness({ clientFile: null });
  try {
    const get = await noClient.get('/login/');
    assert.equal(get.status, 503);
    const getText = await get.text();
    assert.match(getText, /GSC_LOGIN_URL/);
    assert.match(getText, /GSC_OAUTH_CLIENT_FILE/);
  } finally {
    await noClient.close();
  }
  const missingClientFile = await harness({ clientFile: join(tmpdir(), 'gsc-weblogin-missing-client.json') });
  try {
    assert.equal((await missingClientFile.get('/login/')).status, 503);
  } finally {
    await missingClientFile.close();
  }
});
