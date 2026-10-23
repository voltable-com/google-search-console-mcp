import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { OAuth2Client } from 'google-auth-library';

export const READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly' as const;
export const TOKEN_PARTIAL_SUFFIX = '.partial';
const REFRESH_SKEW_MS = 60_000;
const LOGIN_MESSAGE = 'Run node dist/main.js login';
const CLIENT_FILE_MESSAGE = 'Set GSC_OAUTH_CLIENT_FILE to a Desktop OAuth client JSON file.';
const WEB_CLIENT_MESSAGE = 'GSC_OAUTH_CLIENT_FILE is a Web client. Create a Desktop client.';
const INSTALLED_FIELDS_MESSAGE =
  'GSC_OAUTH_CLIENT_FILE must include installed.client_id and installed.client_secret.';

declare const accessTokenBrand: unique symbol;
export type AccessToken = string & { readonly [accessTokenBrand]: 'AccessToken' };

export type StoredToken = {
  refreshToken: string;
  scope: typeof READONLY_SCOPE;
};

export type TokenResult = { ok: true; token: AccessToken } | { ok: false; message: string };

export type TokenSource = {
  accessToken(): Promise<TokenResult>;
  refresh(): Promise<TokenResult>;
};

export type OAuthExchange = {
  start(redirectUri: string): Promise<{ refreshToken: string } | { error: string }>;
};

type DesktopClient =
  | { ok: true; clientId: string; clientSecret: string }
  | { ok: false; message: string };

type StoredRead = { ok: true; token: StoredToken } | { ok: false; message: string };

type Loaded =
  | { ok: true; refreshToken: string; clientId: string; clientSecret: string }
  | { ok: false; message: string };

type CachedAccess = { token: AccessToken; expiresAt: number };

type Loopback = {
  redirectUri: string;
  state: string;
  close(): Promise<void>;
  waitForCode(): Promise<string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAccessToken(value: string): value is AccessToken {
  return value.length > 0;
}

function tokenFilePath(env: NodeJS.ProcessEnv): string {
  const override = env.GSC_TOKEN_FILE;
  if (override !== undefined && override !== '') return override;
  const home = env.HOME !== undefined && env.HOME !== '' ? env.HOME : homedir();
  return join(home, '.local', 'share', 'gsc-mcp', 'token.json');
}

function ignoredPartialPath(tokenFile: string): string {
  return `${tokenFile}${TOKEN_PARTIAL_SUFFIX}`;
}

async function readStoredToken(file: string): Promise<StoredRead> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { ok: false, message: LOGIN_MESSAGE };
  }
  let json: unknown;
  try {
    const parsed: unknown = JSON.parse(text);
    json = parsed;
  } catch {
    return { ok: false, message: LOGIN_MESSAGE };
  }
  if (!isRecord(json)) return { ok: false, message: LOGIN_MESSAGE };
  const refreshToken = json.refreshToken;
  if (typeof refreshToken !== 'string' || refreshToken === '') return { ok: false, message: LOGIN_MESSAGE };
  if (json.scope !== READONLY_SCOPE) return { ok: false, message: LOGIN_MESSAGE };
  return { ok: true, token: { refreshToken, scope: READONLY_SCOPE } };
}

async function readDesktopClient(file: string | undefined): Promise<DesktopClient> {
  if (file === undefined || file === '') return { ok: false, message: CLIENT_FILE_MESSAGE };
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { ok: false, message: CLIENT_FILE_MESSAGE };
  }
  let json: unknown;
  try {
    const parsed: unknown = JSON.parse(text);
    json = parsed;
  } catch {
    return { ok: false, message: CLIENT_FILE_MESSAGE };
  }
  if (!isRecord(json)) return { ok: false, message: CLIENT_FILE_MESSAGE };
  if (!isRecord(json.installed)) {
    if (isRecord(json.web)) return { ok: false, message: WEB_CLIENT_MESSAGE };
    return { ok: false, message: CLIENT_FILE_MESSAGE };
  }
  const clientId = json.installed.client_id;
  const clientSecret = json.installed.client_secret;
  if (typeof clientId !== 'string' || clientId === '' || typeof clientSecret !== 'string' || clientSecret === '') {
    return { ok: false, message: INSTALLED_FIELDS_MESSAGE };
  }
  return { ok: true, clientId, clientSecret };
}

async function loadCredentials(tokenFile: string, clientFile: string | undefined): Promise<Loaded> {
  const stored = await readStoredToken(tokenFile);
  if (!stored.ok) return stored;
  const client = await readDesktopClient(clientFile);
  if (!client.ok) return client;
  return {
    ok: true,
    refreshToken: stored.token.refreshToken,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
  };
}

async function publishStoredToken(file: string, token: StoredToken): Promise<void> {
  const partial = ignoredPartialPath(file);
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(partial, 'w', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify({ refreshToken: token.refreshToken, scope: token.scope }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  // A crash before this rename leaves the previous token file as the current file.
  await rename(partial, file);
}

function endText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(text);
}

function bindLoopback(): Promise<Loopback> {
  const state = randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    let resolveCode: (code: string) => void = () => {};
    let rejectCode: (error: Error) => void = () => {};
    const codePromise = new Promise<string>((resolveWait, rejectWait) => {
      resolveCode = resolveWait;
      rejectCode = rejectWait;
    });
    let settled = false;
    const finish = (error: Error | null, code?: string): void => {
      if (settled) return;
      settled = true;
      if (error !== null) rejectCode(error);
      else if (code !== undefined) resolveCode(code);
    };
    const server = createHttpServer((request, response) => {
      let url: URL;
      try {
        url = new URL(request.url ?? '/', 'http://127.0.0.1');
      } catch {
        endText(response, 400, 'Login failed. You can close this tab.');
        return;
      }
      if (url.pathname !== '/') {
        endText(response, 404, 'Not found.');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error === null && (code === null || code === '')) {
        endText(response, 404, 'Not found.');
        return;
      }
      if (url.searchParams.get('state') !== state) {
        endText(response, 400, 'Login failed. You can close this tab.');
        finish(new Error('The login redirect did not match this session. Run node dist/main.js login'));
        return;
      }
      if (error !== null || code === null || code === '') {
        endText(response, 200, 'Login failed. You can close this tab.');
        finish(new Error('Google denied the login. Run node dist/main.js login'));
        return;
      }
      endText(response, 200, 'Login complete. You can close this tab.');
      finish(null, code);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not bind the login redirect on 127.0.0.1.'));
        return;
      }
      resolve({
        redirectUri: `http://127.0.0.1:${address.port}/`,
        state,
        async close() {
          server.closeAllConnections();
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) rejectClose(error);
              else resolveClose();
            });
          });
        },
        waitForCode: () => codePromise,
      });
    });
  });
}

function tryOpen(url: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const child = spawn('xdg-open', [url], { stdio: 'ignore' });
    child.once('error', finish);
    child.once('spawn', () => {
      child.unref();
      finish();
    });
  });
}

async function loginWithGoogle(client: DesktopClient & { ok: true }, loopback: Loopback, tokenFile: string): Promise<void> {
  const oauth = new OAuth2Client({
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUri: loopback.redirectUri,
  });
  const authUrl = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [READONLY_SCOPE],
    state: loopback.state,
    redirect_uri: loopback.redirectUri,
  });
  console.error(authUrl);
  await tryOpen(authUrl);
  const code = await loopback.waitForCode();
  let refreshToken: string | null | undefined;
  try {
    const exchanged = await oauth.getToken({ code, redirect_uri: loopback.redirectUri });
    refreshToken = exchanged.tokens.refresh_token;
  } catch {
    console.error('Google did not return a refresh token. Run node dist/main.js login');
    throw new Error('token exchange failed');
  }
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    console.error('Google did not return a refresh token. Run node dist/main.js login');
    throw new Error('missing refresh token');
  }
  await publishStoredToken(tokenFile, { refreshToken, scope: READONLY_SCOPE });
  console.error('Logged in. Restart the server if it is already running.');
}

export function openTokenStore(env: NodeJS.ProcessEnv): TokenSource {
  const loaded = loadCredentials(tokenFilePath(env), env.GSC_OAUTH_CLIENT_FILE);
  let cached: CachedAccess | null = null;
  let inflight: Promise<TokenResult> | null = null;

  async function mint(): Promise<TokenResult> {
    const credentials = await loaded;
    if (!credentials.ok) return { ok: false, message: credentials.message };
    try {
      const client = new OAuth2Client({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
      });
      client.setCredentials({ refresh_token: credentials.refreshToken });
      const refreshed = await client.refreshAccessToken();
      const access = refreshed.credentials.access_token;
      if (typeof access !== 'string' || !isAccessToken(access)) return { ok: false, message: LOGIN_MESSAGE };
      const expiry = refreshed.credentials.expiry_date;
      const expiresAt = typeof expiry === 'number' ? expiry : Date.now();
      cached = { token: access, expiresAt };
      return { ok: true, token: access };
    } catch {
      cached = null;
      return { ok: false, message: LOGIN_MESSAGE };
    }
  }

  function refresh(): Promise<TokenResult> {
    if (inflight !== null) return inflight;
    cached = null;
    const pending = mint().finally(() => {
      if (inflight === pending) inflight = null;
    });
    inflight = pending;
    return pending;
  }

  function accessToken(): Promise<TokenResult> {
    if (cached !== null && cached.expiresAt - Date.now() > REFRESH_SKEW_MS) {
      return Promise.resolve({ ok: true, token: cached.token });
    }
    return refresh();
  }

  return { accessToken, refresh };
}

export async function login(env: NodeJS.ProcessEnv, oauth?: OAuthExchange): Promise<void> {
  const client = await readDesktopClient(env.GSC_OAUTH_CLIENT_FILE);
  if (!client.ok) {
    console.error(client.message);
    throw new Error(client.message);
  }
  const tokenFile = tokenFilePath(env);
  const loopback = await bindLoopback();
  try {
    if (oauth !== undefined) {
      const result = await oauth.start(loopback.redirectUri);
      if ('error' in result || result.refreshToken === '') {
        const message = 'error' in result ? result.error : 'Google did not return a refresh token. Run node dist/main.js login';
        console.error(message);
        throw new Error(message);
      }
      await publishStoredToken(tokenFile, { refreshToken: result.refreshToken, scope: READONLY_SCOPE });
      console.error('Logged in. Restart the server if it is already running.');
      return;
    }
    await loginWithGoogle(client, loopback, tokenFile);
  } finally {
    await loopback.close();
  }
}
