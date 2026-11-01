import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { publishToken, readWebClient, scopeGranted, SCOPE, tokenFilePath, type TokenStore } from './token.js';

export type WebExchangeResult = { refreshToken: string; grantedScope: string } | { error: string };

export type CodeExchange = (code: string, redirectUri: string) => Promise<WebExchangeResult>;

export type WebLoginDeps = {
  env: NodeJS.ProcessEnv;
  store: TokenStore;
  exchange?: CodeExchange;
  now?: () => number;
};

export type WebLogin = {
  tryHandle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
};

const PENDING_TTL_MS = 10 * 60_000;
const PENDING_CAP = 16;
const PREFIX = '/mcp/gsc';

const DONE_TEXT = 'Login complete. You can close this tab.';
const FAILED = {
  mismatch: { status: 400, text: 'Login failed: expired-or-mismatch. Open the sign-in page again and try once more.' },
  denied: { status: 200, text: 'Login failed: denied. You can close this tab.' },
  exchange: { status: 200, text: 'Login failed: exchange-failed. Open the sign-in page again and try once more.' },
  scope: { status: 200, text: 'Login failed: scope-not-granted. Google did not grant the Search Console scope.' },
} as const;

function endText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(text);
}

function notConfiguredText(redirect: string | undefined): string {
  const registered = redirect !== undefined && redirect !== '' ? redirect : '<GSC_LOGIN_REDIRECT_URL unset>';
  return `Web login is not configured. Set GSC_OAUTH_WEB_CLIENT_FILE to the downloaded Web OAuth client JSON, and GSC_LOGIN_REDIRECT_URL to the registered redirect URI, exactly: ${registered}`;
}

function defaultExchange(client: { clientId: string; clientSecret: string }, redirectUri: string): CodeExchange {
  return async (code, redirect) => {
    const oauth = new OAuth2Client({ clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: redirect });
    try {
      const exchanged = await oauth.getToken({ code, redirect_uri: redirect });
      const refreshToken = exchanged.tokens.refresh_token;
      if (typeof refreshToken !== 'string' || refreshToken === '') return { error: 'missing refresh token' };
      return { refreshToken, grantedScope: exchanged.tokens.scope ?? '' };
    } catch {
      return { error: 'token exchange failed' };
    }
  };
}

export function openWebLogin(deps: WebLoginDeps): WebLogin {
  const now = deps.now ?? Date.now;
  const pending = new Map<string, number>();

  function begin(): string {
    const cutoff = now();
    for (const [state, expiresAt] of pending) {
      if (expiresAt <= cutoff) pending.delete(state);
    }
    while (pending.size >= PENDING_CAP) {
      const oldest = pending.keys().next();
      if (oldest.done === true) break;
      pending.delete(oldest.value);
    }
    const state = randomBytes(16).toString('hex');
    pending.set(state, now() + PENDING_TTL_MS);
    return state;
  }

  // Single-use is structural: Map.delete hands a state out exactly once.
  function consume(state: string): boolean {
    const expiresAt = pending.get(state);
    if (expiresAt === undefined) return false;
    pending.delete(state);
    return expiresAt > now();
  }

  function configuredRedirect(): string | null {
    const redirect = deps.env.GSC_LOGIN_REDIRECT_URL;
    return redirect !== undefined && redirect !== '' ? redirect : null;
  }

  async function handleSignIn(response: ServerResponse): Promise<void> {
    const redirect = configuredRedirect();
    const client = await readWebClient(deps.env.GSC_OAUTH_WEB_CLIENT_FILE);
    if (redirect === null || !client.ok) {
      endText(response, 503, notConfiguredText(deps.env.GSC_LOGIN_REDIRECT_URL));
      return;
    }
    const state = begin();
    const oauth = new OAuth2Client({ clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: redirect });
    const authorizeUrl = oauth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [SCOPE],
      state,
      redirect_uri: redirect,
    });
    response.writeHead(302, {
      location: authorizeUrl,
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end();
  }

  async function handleCallback(url: URL, response: ServerResponse): Promise<void> {
    const redirect = configuredRedirect();
    if (redirect === null) {
      endText(response, 503, notConfiguredText(deps.env.GSC_LOGIN_REDIRECT_URL));
      return;
    }
    const state = url.searchParams.get('state');
    if (state === null || !consume(state)) {
      endText(response, FAILED.mismatch.status, FAILED.mismatch.text);
      return;
    }
    if (url.searchParams.get('error') !== null) {
      endText(response, FAILED.denied.status, FAILED.denied.text);
      return;
    }
    const code = url.searchParams.get('code');
    if (code === null || code === '') {
      endText(response, FAILED.mismatch.status, FAILED.mismatch.text);
      return;
    }
    const client = await readWebClient(deps.env.GSC_OAUTH_WEB_CLIENT_FILE);
    if (!client.ok) {
      endText(response, 503, notConfiguredText(deps.env.GSC_LOGIN_REDIRECT_URL));
      return;
    }
    try {
      // The byte-exact configured constant, never a request-derived value.
      const exchanged = await (deps.exchange ?? defaultExchange(client, redirect))(code, redirect);
      if ('error' in exchanged) {
        endText(response, FAILED.exchange.status, FAILED.exchange.text);
        return;
      }
      if (!scopeGranted(exchanged.grantedScope)) {
        endText(response, FAILED.scope.status, FAILED.scope.text);
        return;
      }
      await publishToken(tokenFilePath(deps.env), exchanged.refreshToken, SCOPE, 'web');
      deps.store.adopt({
        refreshToken: exchanged.refreshToken,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
      });
      endText(response, 200, DONE_TEXT);
    } catch {
      endText(response, FAILED.exchange.status, FAILED.exchange.text);
    }
  }

  async function tryHandle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.method !== 'GET') return false;
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      return false;
    }
    let pathname = url.pathname;
    if (pathname.startsWith(PREFIX)) pathname = pathname.slice(PREFIX.length) || '/';
    if (pathname === '/login' || pathname === '/login/') {
      await handleSignIn(response);
      return true;
    }
    if (pathname === '/login/callback') {
      await handleCallback(url, response);
      return true;
    }
    return false;
  }

  return { tryHandle };
}
