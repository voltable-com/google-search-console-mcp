import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCOPE, type Adopted, type TokenResult, type TokenStore } from '../dist/token.js';
import { openWebLogin, type CodeExchange } from '../dist/weblogin.js';

const REDIRECT = 'https://mini.local/mcp/gsc/login/callback';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

type Harness = {
  base: string;
  dir: string;
  tokenFile: string;
  events: string[];
  adopted: Adopted[];
  close(): Promise<void>;
};

function recordingStore(events: string[], adopted: Adopted[], tokenFile: string): TokenStore {
  return {
    async accessToken(): Promise<TokenResult> {
      return { ok: false, message: 'unused' };
    },
    async refresh(): Promise<TokenResult> {
      return { ok: false, message: 'unused' };
    },
    loginHint() {
      return 'Open the sign-in page in a browser to sign in';
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
  opts: { webClientFile?: string | null; redirectUrl?: string | null; exchange?: CodeExchange; now?: () => number } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'gsc-weblogin-'));
  const tokenFile = join(dir, 'token.json');
  let webFile = join(dir, 'client-web.json');
  if (opts.webClientFile === null) {
    webFile = '';
  } else if (typeof opts.webClientFile === 'string') {
    webFile = opts.webClientFile;
  } else {
    await writeFile(webFile, JSON.stringify({ web: { client_id: 'web-id', client_secret: 'web-secret' } }));
  }
  const env: NodeJS.ProcessEnv = {
    GSC_TOKEN_FILE: tokenFile,
    GSC_OAUTH_WEB_CLIENT_FILE: webFile,
    GSC_LOGIN_REDIRECT_URL: REDIRECT,
  };
  if (opts.webClientFile === null) delete env.GSC_OAUTH_WEB_CLIENT_FILE;
  if (opts.redirectUrl === null) delete env.GSC_LOGIN_REDIRECT_URL;
  const events: string[] = [];
  const adopted: Adopted[] = [];
  const webLogin = openWebLogin({
    env,
    store: recordingStore(events, adopted, tokenFile),
    ...(opts.exchange === undefined ? {} : { exchange: opts.exchange }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
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
    async close() {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(closed.resolve);
      await closed.promise;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function beginLogin(base: string, path = '/login/'): Promise<string> {
  const signin = await fetch(base + path, { redirect: 'manual' });
  return new URL(signin.headers.get('location') ?? 'https://accounts.google.com/', 'https://accounts.google.com')
    .searchParams.get('state') ?? '';
}

test('GET /login/ and /mcp/gsc/login/ redirect to Google with the configured redirect_uri', async () => {
  const h = await harness();
  try {
    for (const path of ['/login/', '/mcp/gsc/login/', '/login']) {
      const response = await fetch(h.base + path, { redirect: 'manual' });
      assert.equal(response.status, 302);
      const location = response.headers.get('location') ?? '';
      assert.match(location, /^https:\/\/accounts\.google\.com\//);
      assert.match(location, /client_id=web-id/);
      assert.match(location, /state=[0-9a-f]{32}/);
      assert.match(location, /prompt=consent/);
      assert.match(location, /access_type=offline/);
      assert.match(location, /scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fwebmasters/);
      assert.match(location, /redirect_uri=https%3A%2F%2Fmini\.local%2Fmcp%2Fgsc%2Flogin%2Fcallback/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  } finally {
    await h.close();
  }
});

test('non-GET requests and non-login paths are not handled', async () => {
  const h = await harness();
  try {
    const post = await fetch(h.base + '/login/', { method: 'POST' });
    assert.equal(post.status, 404);
    assert.equal(await post.text(), 'mcp-stub');
    const initialize = await fetch(h.base + '/initialize');
    assert.equal(initialize.status, 404);
    assert.equal(await initialize.text(), 'mcp-stub');
    const postCallback = await fetch(h.base + '/mcp/gsc/login/callback?code=code-1&state=st', { method: 'POST' });
    assert.equal(postCallback.status, 404);
    assert.equal(await postCallback.text(), 'mcp-stub');
  } finally {
    await h.close();
  }
});

test('the callback exchanges the code with the configured redirect, publishes the file, then adopts', async () => {
  for (const callbackPath of ['/login/callback', '/mcp/gsc/login/callback']) {
    const seen: [string, string][] = [];
    const exchange: CodeExchange = async (code, redirectUri) => {
      seen.push([code, redirectUri]);
      return { refreshToken: 'rt-web', grantedScope: SCOPE };
    };
    const h = await harness({ exchange });
    try {
      const state = await beginLogin(h.base);
      const done = await fetch(`${h.base}${callbackPath}?code=code-1&state=${state}`);
      assert.equal(done.status, 200);
      assert.equal(await done.text(), 'Login complete. You can close this tab.');
      assert.equal(done.headers.get('cache-control'), 'no-store');
      assert.deepEqual(seen, [['code-1', REDIRECT]]);
      const stored = JSON.parse(await readFile(h.tokenFile, 'utf8'));
      assert.deepEqual(stored, { refreshToken: 'rt-web', scope: SCOPE, client: 'web' });
      assert.equal((await stat(h.tokenFile)).mode & 0o777, 0o600);
      assert.deepEqual(h.adopted, [{ refreshToken: 'rt-web', clientId: 'web-id', clientSecret: 'web-secret' }]);
      assert.equal(h.events[0], `adopt:${JSON.stringify(stored)}`);
    } finally {
      await h.close();
    }
  }
});

test('replaying the same state fails and the exchange runs once', async () => {
  let count = 0;
  const exchange: CodeExchange = async () => {
    count += 1;
    return { refreshToken: 'rt-web', grantedScope: SCOPE };
  };
  const h = await harness({ exchange });
  try {
    const state = await beginLogin(h.base, '/mcp/gsc/login/');
    const first = await fetch(`${h.base}/mcp/gsc/login/callback?code=code-1&state=${state}`);
    assert.equal(first.status, 200);
    const replay = await fetch(`${h.base}/mcp/gsc/login/callback?code=code-1&state=${state}`);
    assert.equal(replay.status, 400);
    assert.match(await replay.text(), /expired-or-mismatch/);
    assert.equal(count, 1);
    assert.deepEqual(JSON.parse(await readFile(h.tokenFile, 'utf8')), {
      refreshToken: 'rt-web',
      scope: SCOPE,
      client: 'web',
    });
  } finally {
    await h.close();
  }
});

test('an unknown state fails without exchanging and writes no token file', async () => {
  let count = 0;
  const exchange: CodeExchange = async () => {
    count += 1;
    return { refreshToken: 'rt-x', grantedScope: SCOPE };
  };
  const h = await harness({ exchange });
  try {
    const response = await fetch(`${h.base}/login/callback?code=code-1&state=${'0'.repeat(32)}`);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /expired-or-mismatch/);
    assert.equal(count, 0);
    await assert.rejects(() => stat(h.tokenFile), { code: 'ENOENT' });
  } finally {
    await h.close();
  }
});

test('a pending session past the TTL fails without exchanging', async () => {
  let clock = 1_700_000_000_000;
  let count = 0;
  const exchange: CodeExchange = async () => {
    count += 1;
    return { refreshToken: 'rt-x', grantedScope: SCOPE };
  };
  const h = await harness({ exchange, now: () => clock });
  try {
    const state = await beginLogin(h.base);
    clock += 10 * 60_000 + 1;
    const response = await fetch(`${h.base}/mcp/gsc/login/callback?code=code-1&state=${state}`);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /expired-or-mismatch/);
    assert.equal(count, 0);
  } finally {
    await h.close();
  }
});

test("Google's error parameter answers the denied page without an exchange", async () => {
  let count = 0;
  const exchange: CodeExchange = async () => {
    count += 1;
    return { refreshToken: 'rt-x', grantedScope: SCOPE };
  };
  const h = await harness({ exchange });
  try {
    const state = await beginLogin(h.base);
    const response = await fetch(`${h.base}/mcp/gsc/login/callback?error=access_denied&state=${state}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /denied/);
    assert.equal(count, 0);
    await assert.rejects(() => stat(h.tokenFile), { code: 'ENOENT' });
  } finally {
    await h.close();
  }
});

test('a read-only grant answers scope-not-granted and leaves the file unchanged', async () => {
  const exchange: CodeExchange = async () => ({ refreshToken: 'rt-bad', grantedScope: READONLY_SCOPE });
  const h = await harness({ exchange });
  try {
    const before = { refreshToken: 'first-refresh', scope: SCOPE, client: 'web' };
    await writeFile(h.tokenFile, JSON.stringify(before));
    const state = await beginLogin(h.base);
    const response = await fetch(`${h.base}/mcp/gsc/login/callback?code=code-1&state=${state}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /scope-not-granted/);
    assert.deepEqual(JSON.parse(await readFile(h.tokenFile, 'utf8')), before);
    assert.deepEqual(h.adopted, []);
  } finally {
    await h.close();
  }
});

test('a failing exchange answers the exchange-failed page and leaves the file unchanged', async () => {
  const exchange: CodeExchange = async () => ({ error: 'redirect_uri_mismatch' });
  const h = await harness({ exchange });
  try {
    const before = { refreshToken: 'first-refresh', scope: SCOPE, client: 'web' };
    await writeFile(h.tokenFile, JSON.stringify(before));
    const state = await beginLogin(h.base);
    const response = await fetch(`${h.base}/login/callback?code=code-1&state=${state}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /exchange-failed/);
    assert.deepEqual(JSON.parse(await readFile(h.tokenFile, 'utf8')), before);
    assert.deepEqual(h.adopted, []);
  } finally {
    await h.close();
  }
});

test('missing web configuration answers 503 naming the env vars and the exact redirect', async () => {
  const noClient = await harness({ webClientFile: null });
  try {
    const response = await fetch(noClient.base + '/login/');
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.match(text, /GSC_OAUTH_WEB_CLIENT_FILE/);
    assert.match(text, /GSC_LOGIN_REDIRECT_URL/);
    assert.ok(text.includes(REDIRECT));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const callback = await fetch(`${noClient.base}/mcp/gsc/login/callback?code=c&state=s`);
    assert.equal(callback.status, 400);
  } finally {
    await noClient.close();
  }
  const noRedirect = await harness({ redirectUrl: null });
  try {
    const response = await fetch(noRedirect.base + '/mcp/gsc/login/');
    assert.equal(response.status, 503);
    assert.match(await response.text(), /GSC_LOGIN_REDIRECT_URL/);
  } finally {
    await noRedirect.close();
  }
  const dir = await mkdtemp(join(tmpdir(), 'gsc-weblogin-'));
  try {
    const desktopFile = join(dir, 'client.json');
    await writeFile(desktopFile, JSON.stringify({ installed: { client_id: 'i', client_secret: 's' } }));
    const wrongType = await harness({ webClientFile: desktopFile });
    try {
      const response = await fetch(wrongType.base + '/login/');
      assert.equal(response.status, 503);
      assert.match(await response.text(), /GSC_OAUTH_WEB_CLIENT_FILE/);
    } finally {
      await wrongType.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
