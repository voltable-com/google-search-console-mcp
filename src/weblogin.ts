import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { publishToken, readDesktopClient, scopeGranted, SCOPE, tokenFilePath, type TokenStore } from './token.js';

export type WebExchangeResult = { refreshToken: string; grantedScope: string } | { error: string };

export type Exchange = (code: string) => Promise<WebExchangeResult>;

export type WebLoginDeps = {
  env: NodeJS.ProcessEnv;
  store: TokenStore;
  exchange?: Exchange;
  now?: () => number;
};

export type WebLogin = {
  tryHandle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
};

const PREFIX = '/mcp/gsc';
const LOOPBACK_REDIRECT = 'http://127.0.0.1:41799/';
const SLOT_TTL_MS = 15 * 60_000;
const MAX_BODY_BYTES = 8 * 1024;
const NOT_CONFIGURED =
  "Web login is not configured. Set GSC_LOGIN_URL to this page's public URL and GSC_OAUTH_CLIENT_FILE to the installed Google OAuth client JSON.";

type Slot = { state: string; expiresAt: number };

type DesktopClient = { clientId: string; clientSecret: string };

function esc(value: string): string {
  return value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function isForm(request: IncomingMessage): boolean {
  const header = request.headers['content-type'] ?? '';
  return header.split(';')[0]?.trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

async function readForm(request: IncomingMessage): Promise<{ ok: true; params: URLSearchParams } | { ok: false; tooLarge: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return { ok: false, tooLarge: true };
    chunks.push(chunk);
  }
  return { ok: true, params: new URLSearchParams(Buffer.concat(chunks).toString('utf8')) };
}

const defaultExchange = (client: DesktopClient): Exchange => async (code) => {
  const oauth = new OAuth2Client({
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUri: LOOPBACK_REDIRECT,
  });
  try {
    const exchanged = await oauth.getToken({ code, redirect_uri: LOOPBACK_REDIRECT });
    const refreshToken = exchanged.tokens.refresh_token;
    const grantedScope = exchanged.tokens.scope;
    return {
      refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
      grantedScope: typeof grantedScope === 'string' ? grantedScope : '',
    };
  } catch {
    return { error: 'token exchange failed' };
  }
};

export function openWebLogin(deps: WebLoginDeps): WebLogin {
  const now = deps.now ?? Date.now;
  let slot: Slot | null = null;

  function endText(response: ServerResponse, status: number, text: string): void {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(text);
  }

  function endHtml(response: ServerResponse, body: string): void {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><meta charset="utf-8"><title>Search Console sign-in</title>${body}`);
  }

  function pasteForm(pathname: string): string {
    return (
      `<form method="post" action="${esc(pathname)}">` +
      `<p><input name="url" size="90" placeholder="${esc(LOOPBACK_REDIRECT)}?code=...&amp;state=..."></p>` +
      `<p><button type="submit">Paste address</button></p></form>`
    );
  }

  function failedPage(pathname: string, reason: string): string {
    return `<p>Login failed: ${esc(reason)}.</p><p><a href="${esc(pathname)}">Sign in again</a></p>`;
  }

  function mismatchPage(pathname: string): string {
    return (
      '<p>The pasted address does not match the sign-in in progress. Copy the FULL address from the browser bar and paste it again.</p>' +
      pasteForm(pathname) +
      `<p><a href="${esc(pathname)}">Start a new sign-in</a></p>`
    );
  }

  async function configure(response: ServerResponse): Promise<DesktopClient | null> {
    const loginUrl = deps.env.GSC_LOGIN_URL;
    if (loginUrl === undefined || loginUrl === '') {
      endText(response, 503, NOT_CONFIGURED);
      return null;
    }
    const client = await readDesktopClient(deps.env.GSC_OAUTH_CLIENT_FILE);
    if (!client.ok) {
      endText(response, 503, `${NOT_CONFIGURED} ${client.message}`);
      return null;
    }
    return client;
  }

  async function handleGet(pathname: string, response: ServerResponse): Promise<void> {
    const client = await configure(response);
    if (client === null) return;
    const nowMs = now();
    if (slot !== null && slot.expiresAt <= nowMs) slot = null;
    if (slot === null) slot = { state: randomBytes(16).toString('hex'), expiresAt: nowMs + SLOT_TTL_MS };
    const oauth = new OAuth2Client({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: LOOPBACK_REDIRECT,
    });
    const authUrl = oauth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [SCOPE],
      state: slot.state,
      redirect_uri: LOOPBACK_REDIRECT,
    });
    endHtml(
      response,
      `<p><a href="${esc(authUrl)}">Sign in with Google</a></p>` +
        '<p>Open the link and sign in. The browser lands on an error page; copy the FULL address from the bar and paste it below.</p>' +
        pasteForm(pathname),
    );
  }

  async function handlePost(pathname: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const client = await configure(response);
    if (client === null) return;
    if (slot !== null && slot.expiresAt <= now()) slot = null;
    if (slot === null) {
      endHtml(response, `<p>No login in progress.</p><p><a href="${esc(pathname)}">Start a new sign-in</a></p>`);
      return;
    }
    const body = await readForm(request);
    if (!body.ok) {
      request.destroy();
      endText(response, 413, 'Login form too large.');
      return;
    }
    const pasted = body.params.get('url') ?? '';
    const expectedState = slot.state;
    let parsed: URL;
    try {
      parsed = new URL(pasted);
    } catch {
      endHtml(response, mismatchPage(pathname));
      return;
    }
    if (parsed.origin !== 'http://127.0.0.1:41799' || parsed.pathname !== '/') {
      endHtml(response, mismatchPage(pathname));
      return;
    }
    if (parsed.searchParams.get('state') !== expectedState) {
      endHtml(response, mismatchPage(pathname));
      return;
    }
    const error = parsed.searchParams.get('error');
    if (error !== null) {
      slot = null;
      endHtml(response, `<p>Google denied the sign-in (${esc(error)}).</p><p><a href="${esc(pathname)}">Sign in again</a></p>`);
      return;
    }
    const code = parsed.searchParams.get('code');
    if (code === null || code === '') {
      endHtml(response, mismatchPage(pathname));
      return;
    }
    slot = null;
    const exchange = deps.exchange ?? defaultExchange(client);
    const result = await exchange(code);
    if ('error' in result) {
      endHtml(response, failedPage(pathname, result.error));
      return;
    }
    if (result.refreshToken === '') {
      endHtml(response, failedPage(pathname, 'Google returned no refresh token'));
      return;
    }
    if (!scopeGranted(result.grantedScope)) {
      endHtml(response, failedPage(pathname, 'Google did not grant the Search Console scope'));
      return;
    }
    try {
      await publishToken(tokenFilePath(deps.env), result.refreshToken, SCOPE, 'desktop');
    } catch {
      endHtml(response, failedPage(pathname, 'the token file could not be written'));
      return;
    }
    deps.store.adopt({ refreshToken: result.refreshToken, clientId: client.clientId, clientSecret: client.clientSecret });
    endHtml(response, '<p>Login complete. You can close this tab.</p>');
  }

  async function tryHandle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') return false;
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      return false;
    }
    let pathname = url.pathname;
    if (pathname.startsWith(PREFIX)) pathname = pathname.slice(PREFIX.length) || '/';
    if (pathname !== '/login' && pathname !== '/login/') return false;
    if (method === 'POST') {
      if (!isForm(request)) return false;
      await handlePost(url.pathname, request, response);
      return true;
    }
    await handleGet(url.pathname, response);
    return true;
  }

  return { tryHandle };
}
