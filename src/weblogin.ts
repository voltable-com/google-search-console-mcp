import type { IncomingMessage, ServerResponse } from 'node:http';
import { publishToken, readWebClient, scopeGranted, SCOPE, tokenFilePath, type TokenStore } from './token.js';

export type DeviceClient = { clientId: string; clientSecret: string; tokenUri: string };

export type DeviceSession = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
};

export type DevicePollResult =
  | { state: 'pending'; slowDown: boolean }
  | { state: 'granted'; refreshToken: string; grantedScope: string }
  | { state: 'failed'; error: string };

export type DeviceFlow = {
  start(client: DeviceClient): Promise<DeviceSession | { error: string }>;
  poll(client: DeviceClient, deviceCode: string): Promise<DevicePollResult>;
};

export type WebLoginDeps = {
  env: NodeJS.ProcessEnv;
  store: TokenStore;
  device?: DeviceFlow;
  now?: () => number;
};

export type WebLogin = {
  tryHandle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
};

const PREFIX = '/mcp/gsc';
const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const POLL_SLACK_MS = 5_000;
const SLOW_DOWN_MS = 5_000;
const PAGE_REFRESH_SECONDS = 3;

type PendingSlot = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  nextPollAt: number;
  expiresAt: number;
};

type FormResult = { ok: true; json: Record<string, unknown> } | { ok: false; error: string };

async function postForm(url: string, form: Record<string, string>): Promise<FormResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const json: unknown = await response.json().catch(() => null);
    if (typeof json !== 'object' || json === null) return { ok: false, error: 'device flow response malformed' };
    return { ok: true, json: json as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'device flow request failed' };
  }
}

export const defaultDeviceFlow: DeviceFlow = {
  async start(client) {
    const posted = await postForm(DEVICE_CODE_URL, {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      scope: SCOPE,
    });
    if (!posted.ok) return { error: posted.error };
    const deviceCode = posted.json.device_code;
    const userCode = posted.json.user_code;
    const verification = posted.json.verification_url ?? posted.json.verification_uri;
    const expiresIn = Number(posted.json.expires_in);
    const interval = Number(posted.json.interval);
    if (
      typeof deviceCode !== 'string' || deviceCode === '' ||
      typeof userCode !== 'string' || userCode === '' ||
      typeof verification !== 'string' || verification === '' ||
      !Number.isFinite(expiresIn) || !Number.isFinite(interval)
    ) {
      return { error: 'device flow response malformed' };
    }
    return { deviceCode, userCode, verificationUrl: verification, expiresIn, interval };
  },

  async poll(client, deviceCode) {
    const posted = await postForm(client.tokenUri, {
      grant_type: DEVICE_GRANT,
      device_code: deviceCode,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    if (!posted.ok) return { state: 'failed', error: posted.error };
    const body = posted.json;
    const error = body.error;
    if (error === 'authorization_pending') return { state: 'pending', slowDown: false };
    if (error === 'slow_down') return { state: 'pending', slowDown: true };
    if (typeof error === 'string') return { state: 'failed', error };
    const refreshToken = body.refresh_token;
    const grantedScope = body.scope;
    return {
      state: 'granted',
      refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
      grantedScope: typeof grantedScope === 'string' ? grantedScope : '',
    };
  },
};

function esc(value: string): string {
  return value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function openWebLogin(deps: WebLoginDeps): WebLogin {
  const now = deps.now ?? Date.now;
  const flow: DeviceFlow = deps.device ?? defaultDeviceFlow;
  let slot: PendingSlot | null = null;

  function endText(response: ServerResponse, status: number, text: string): void {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(text);
  }

  function endHtml(response: ServerResponse, body: string): void {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><meta charset="utf-8"><title>Search Console sign-in</title>${body}`);
  }

  function failedPage(pathname: string, reason: string): string {
    return `<p>Login failed: ${esc(reason)}.</p><p><a href="${esc(pathname)}">Sign in again</a></p>`;
  }

  function renderPage(response: ServerResponse, pending: PendingSlot): void {
    const url = esc(pending.verificationUrl);
    endHtml(
      response,
      `<meta http-equiv="refresh" content="${PAGE_REFRESH_SECONDS}">` +
        `<p>Open <a href="${url}">${url}</a> on any device and enter this code:</p>` +
        `<p><code style="font-size:2em">${esc(pending.userCode)}</code></p>`,
    );
  }

  async function handleLogin(pathname: string, response: ServerResponse): Promise<void> {
    const loginUrl = deps.env.GSC_LOGIN_URL;
    if (loginUrl === undefined || loginUrl === '') {
      endText(
        response,
        503,
        "Web login is not configured. Set GSC_OAUTH_WEB_CLIENT_FILE to the downloaded Google OAuth client JSON and GSC_LOGIN_URL to this page's public URL, for example https://mini.local/mcp/gsc/login/",
      );
      return;
    }
    const client = await readWebClient(deps.env.GSC_OAUTH_WEB_CLIENT_FILE);
    if (!client.ok) {
      endText(
        response,
        503,
        `Web login is not configured. Set GSC_OAUTH_WEB_CLIENT_FILE to the downloaded Google OAuth client JSON and GSC_LOGIN_URL to this page's public URL. ${client.message}`,
      );
      return;
    }
    const deviceClient: DeviceClient = { clientId: client.clientId, clientSecret: client.clientSecret, tokenUri: client.tokenUri };
    const nowMs = now();
    if (slot !== null && slot.expiresAt <= nowMs) slot = null;
    if (slot === null) {
      const started = await flow.start(deviceClient);
      if ('error' in started) {
        endText(response, 503, `Web login is unavailable: ${started.error}. Open the sign-in page again and try once more.`);
        return;
      }
      slot = {
        deviceCode: started.deviceCode,
        userCode: started.userCode,
        verificationUrl: started.verificationUrl,
        intervalMs: started.interval * 1000,
        nextPollAt: nowMs + started.interval * 1000 + POLL_SLACK_MS,
        expiresAt: nowMs + started.expiresIn * 1000,
      };
      renderPage(response, slot);
      return;
    }
    if (nowMs < slot.nextPollAt) {
      renderPage(response, slot);
      return;
    }
    const result = await flow.poll(deviceClient, slot.deviceCode);
    if (result.state === 'pending') {
      slot.nextPollAt = nowMs + slot.intervalMs + POLL_SLACK_MS + (result.slowDown ? SLOW_DOWN_MS : 0);
      renderPage(response, slot);
      return;
    }
    if (result.state === 'failed') {
      slot = null;
      endHtml(response, failedPage(pathname, result.error));
      return;
    }
    if (result.refreshToken === '') {
      slot = null;
      endHtml(response, failedPage(pathname, 'Google returned no refresh token'));
      return;
    }
    if (!scopeGranted(result.grantedScope)) {
      slot = null;
      endHtml(response, failedPage(pathname, 'Google did not grant the Search Console scope'));
      return;
    }
    try {
      await publishToken(tokenFilePath(deps.env), result.refreshToken, SCOPE, 'web');
    } catch {
      slot = null;
      endHtml(response, failedPage(pathname, 'the token file could not be written'));
      return;
    }
    slot = null;
    deps.store.adopt({ refreshToken: result.refreshToken, clientId: client.clientId, clientSecret: client.clientSecret });
    endHtml(response, '<p>Login complete. You can close this tab.</p>');
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
    if (pathname !== '/login' && pathname !== '/login/') return false;
    await handleLogin(url.pathname, response);
    return true;
  }

  return { tryHandle };
}
