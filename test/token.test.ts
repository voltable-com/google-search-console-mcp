import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { toolCatalog, type Http } from '../dist/console.js';
import {
  login,
  openTokenStore,
  SCOPE,
  TOKEN_PARTIAL_SUFFIX,
  type AccessMint,
  type Adopted,
  type OAuthExchange,
} from '../dist/token.js';

const CLIENT_JSON = JSON.stringify({
  installed: { client_id: 'test-client', client_secret: 'test-secret' },
});

const READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

async function tempEnv(): Promise<{ dir: string; env: NodeJS.ProcessEnv; tokenFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'gsc-token-'));
  const tokenFile = join(dir, 'token.json');
  const clientFile = join(dir, 'client.json');
  await writeFile(clientFile, CLIENT_JSON);
  const env: NodeJS.ProcessEnv = {
    GSC_TOKEN_FILE: tokenFile,
    GSC_OAUTH_CLIENT_FILE: clientFile,
  };
  return { dir, env, tokenFile };
}

function exchange(refreshToken: string, seen: string[], grantedScope = SCOPE): OAuthExchange {
  return {
    async start(redirectUri: string) {
      seen.push(redirectUri);
      return { refreshToken, grantedScope };
    },
  };
}

test('two successful logins leave one token file mode 0o600 with the second refresh token', async () => {
  const { dir, env, tokenFile } = await tempEnv();
  try {
    const seen: string[] = [];
    await login(env, exchange('first-refresh', seen));
    await login(env, exchange('second-refresh', seen));
    const names = (await readdir(dir)).filter((name) => name.includes('token'));
    assert.deepEqual(names, ['token.json']);
    const info = await stat(tokenFile);
    assert.equal(info.mode & 0o777, 0o600);
    const parsed: unknown = JSON.parse(await readFile(tokenFile, 'utf8'));
    assert.deepEqual(parsed, { refreshToken: 'second-refresh', scope: SCOPE, client: 'desktop' });
    assert.match(seen[0] ?? '', /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.match(seen[1] ?? '', /^http:\/\/127\.0\.0\.1:\d+\/$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed second login leaves the first token file unchanged', async () => {
  const { dir, env, tokenFile } = await tempEnv();
  try {
    await login(env, exchange('first-refresh', []));
    const before = await readFile(tokenFile);
    const failed: OAuthExchange = {
      async start() {
        return { error: 'access_denied' };
      },
    };
    await assert.rejects(() => login(env, failed));
    const after = await readFile(tokenFile);
    assert.deepEqual(after, before);
    const names = (await readdir(dir)).filter((name) => name.includes('token'));
    assert.deepEqual(names, ['token.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a read-only grant leaves the previous token file unchanged', async () => {
  const { dir, env, tokenFile } = await tempEnv();
  try {
    await login(env, exchange('first-refresh', []));
    const before = await readFile(tokenFile);
    await assert.rejects(() => login(env, exchange('second-refresh', [], READONLY_SCOPE)));
    const after = await readFile(tokenFile);
    assert.deepEqual(after, before);
    const names = (await readdir(dir)).filter((name) => name.includes('token'));
    assert.deepEqual(names, ['token.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an empty grant leaves the previous token file unchanged', async () => {
  const { dir, env, tokenFile } = await tempEnv();
  try {
    await login(env, exchange('first-refresh', []));
    const before = await readFile(tokenFile);
    await assert.rejects(() => login(env, exchange('second-refresh', [], '')));
    const after = await readFile(tokenFile);
    assert.deepEqual(after, before);
    const names = (await readdir(dir)).filter((name) => name.includes('token'));
    assert.deepEqual(names, ['token.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a stored read-only scope returns not_logged_in and does not call HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsc-token-'));
  const tokenFile = join(dir, 'token.json');
  const calls: string[] = [];
  const http: Http = async () => {
    calls.push('called');
    return { status: 200, text: '{}' };
  };
  try {
    await writeFile(tokenFile, JSON.stringify({ refreshToken: 'old-refresh', scope: READONLY_SCOPE }));
    const result = await toolCatalog({
      tokens: openTokenStore({ GSC_TOKEN_FILE: tokenFile, GSC_OAUTH_CLIENT_FILE: '' }),
      http,
    }).list_sites.run({});
    assert.equal(calls.length, 0);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'not_logged_in');
      assert.equal(result.message, 'Run node dist/main.js login');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a legacy token file without client mints through the desktop client file', async () => {
  const { dir, env, tokenFile } = await tempEnv();
  try {
    await writeFile(tokenFile, JSON.stringify({ refreshToken: 'old-refresh', scope: SCOPE }));
    const seen: Adopted[] = [];
    const mint: AccessMint = async (c) => {
      seen.push(c);
      return { token: 'access-legacy', expiresAt: Date.now() + 600_000 };
    };
    const store = openTokenStore(env, { mint });
    const result = await store.accessToken();
    assert.equal(result.ok, true);
    assert.deepEqual(seen, [{ refreshToken: 'old-refresh', clientId: 'test-client', clientSecret: 'test-secret' }]);
    assert.equal(store.loginHint(), 'Run node dist/main.js login');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a web client token file without a web client file names the web env var and calls no HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsc-token-'));
  const tokenFile = join(dir, 'token.json');
  const calls: string[] = [];
  const http: Http = async () => {
    calls.push('called');
    return { status: 200, text: '{}' };
  };
  try {
    await writeFile(tokenFile, JSON.stringify({ refreshToken: 'web-refresh', scope: SCOPE, client: 'web' }));
    const result = await toolCatalog({
      tokens: openTokenStore({ GSC_TOKEN_FILE: tokenFile }),
      http,
    }).list_sites.run({});
    assert.equal(calls.length, 0);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'not_logged_in');
      assert.match(result.message, /GSC_OAUTH_WEB_CLIENT_FILE/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a web client token file mints with the web client credentials from either client shape', async () => {
  const { dir, env, tokenFile } = await tempEnv();
  try {
    const installedFile = join(dir, 'client-web-installed.json');
    const webFile = join(dir, 'client-web.json');
    await writeFile(installedFile, JSON.stringify({ installed: { client_id: 'web-id', client_secret: 'web-secret' } }));
    await writeFile(webFile, JSON.stringify({ web: { client_id: 'web-id', client_secret: 'web-secret', token_uri: 'https://oauth2.googleapis.com/token' } }));
    await writeFile(tokenFile, JSON.stringify({ refreshToken: 'web-refresh', scope: SCOPE, client: 'web' }));
    const seen: Adopted[] = [];
    const mint: AccessMint = async (c) => {
      seen.push(c);
      return { token: 'access-web', expiresAt: Date.now() + 600_000 };
    };
    for (const webClientFile of [installedFile, webFile]) {
      const store = openTokenStore({ ...env, GSC_OAUTH_WEB_CLIENT_FILE: webClientFile, GSC_LOGIN_URL: 'https://mini.local/mcp/gsc/login/' }, { mint });
      const result = await store.accessToken();
      assert.equal(result.ok, true);
      assert.equal(store.loginHint(), 'Open https://mini.local/mcp/gsc/login/ in a browser to sign in');
    }
    assert.deepEqual(seen, [
      { refreshToken: 'web-refresh', clientId: 'web-id', clientSecret: 'web-secret' },
      { refreshToken: 'web-refresh', clientId: 'web-id', clientSecret: 'web-secret' },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('adopted credentials mint later requests and a pre-adopt in-flight mint cannot repopulate the cache', async () => {
  const { dir, env, tokenFile } = await tempEnv();
  try {
    await writeFile(tokenFile, JSON.stringify({ refreshToken: 'old-refresh', scope: SCOPE }));
    const seen: Adopted[] = [];
    const gate = Promise.withResolvers<void>();
    const mint: AccessMint = async (c) => {
      seen.push(c);
      if (seen.length === 1) await gate;
      return { token: `access-${seen.length}`, expiresAt: Date.now() + 600_000 };
    };
    const store = openTokenStore(env, { mint });
    const inflight = store.accessToken();
    store.adopt({ refreshToken: 'adopted-refresh', clientId: 'adopted-id', clientSecret: 'adopted-secret' });
    gate.resolve();
    await inflight;
    const after = await store.accessToken();
    assert.equal(after.ok, true);
    if (after.ok) assert.equal(after.token, 'access-2');
    assert.deepEqual(seen, [
      { refreshToken: 'old-refresh', clientId: 'test-client', clientSecret: 'test-secret' },
      { refreshToken: 'adopted-refresh', clientId: 'adopted-id', clientSecret: 'adopted-secret' },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a partial sibling is never read into a tool error', async () => {
  const { dir, env, tokenFile } = await tempEnv();
  const canary = 'partial-canary-9f3c1e';
  const calls: string[] = [];
  const http: Http = async () => {
    calls.push('called');
    return { status: 200, text: '{}' };
  };
  try {
    await writeFile(
      `${tokenFile}${TOKEN_PARTIAL_SUFFIX}`,
      JSON.stringify({ refreshToken: canary, scope: SCOPE, leak: canary }),
    );
    const missingCatalog = toolCatalog({ tokens: openTokenStore(env), http });
    const missing = await missingCatalog.list_sites.run({});
    assert.equal(calls.length, 0);
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.message, 'Run node dist/main.js login');
      assert.equal(missing.message.includes(canary), false);
    }
    assert.equal(JSON.stringify(missing).includes(canary), false);
    const broken = 'broken-token-bytes';
    await writeFile(tokenFile, `{${broken}`);
    const invalid = await toolCatalog({ tokens: openTokenStore(env), http }).list_sites.run({});
    assert.equal(calls.length, 0);
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.message, 'Run node dist/main.js login');
      assert.equal(invalid.message.includes(canary), false);
      assert.equal(invalid.message.includes(broken), false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
