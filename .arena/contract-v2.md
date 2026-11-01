# Contract v2: device-code browser login (replaces redirect flow)

Runtime evidence chain (all observed this session, do not re-litigate):
1. Google Cloud Console REJECTS `https://mini.local/...` redirect URIs: "Invalid Redirect: must end with a public top-level domain" (screenshot-confirmed).
2. mini has no public domain (nginx server_names: `_`, `mini.local`), no letsencrypt certs, and `tailscale cert mini.tailfea6df.ts.net` → "your Tailscale account does not support getting TLS certs". A web-client redirect flow cannot deploy.
3. A TV-and-Limited-Input client WAS created (project gen-lang-client-0227233876… no, gen-lang-client-0227233873; client_id 378244106876-mme72uuqbg7uefqh6ha48hmj11vj0dij) and its Google download is `{"installed":{client_id, project_id, auth_uri, token_uri, client_secret}}` — no redirect_uris. Device flow needs no redirect. This is the deployable login.

## Change

`serve-http` `/login/` becomes a Google **device code flow** page. Remove the redirect-callback machinery entirely (dead for this deployment).

### New flow

- `GET /login/` (GET only, both `/login/` and `/mcp/gsc/login/`):
  - No live pending, or pending expired → `POST https://oauth2.googleapis.com/device/code` (form-encoded: `client_id`, `client_secret`, `scope=https://www.googleapis.com/auth/webmasters`). Response: `device_code, user_code, verification_url (or verification_uri), expires_in, interval`. Store pending slot {deviceCode, userCode, verificationUrl, nextPollAt, expiresAt} (single slot, overwrite on re-begin).
  - If pending exists → poll Google once when `now >= nextPollAt` (respect interval, +5s slack): `POST token_uri` form `grant_type=urn:ietf:params:oauth:grant-type:device_code, device_code, client_id, client_secret`.
    - `authorization_pending` / `slow_down` → keep page, bump nextPollAt (slow_down: +5s).
    - success → verify `refresh_token` present and `scopeGranted(scope)` → `publishToken(tokenFile, refresh_token, SCOPE, 'web')` then `store.adopt({refreshToken, clientId, clientSecret})` → render done page (no meta refresh).
    - `access_denied`/`expired_token`/error → clear slot, failure page with link to restart.
  - Injectable seam for tests: `device?: { start(client): Promise<...>; poll(client, deviceCode): Promise<...> }`.
- Delete `/login/callback` route and the pending Map/single-use machinery it served. Google's device grant already enforces single-use of device_code.

### Config

- `GSC_OAUTH_WEB_CLIENT_FILE` keeps its name; parse BOTH shapes: `{"installed":{client_id,client_secret,...}}` and `{"web":{...}}`; require client_id + client_secret; also capture `token_uri` when `installed` gives it, default `https://oauth2.googleapis.com/token`.
- Drop `GSC_LOGIN_REDIRECT_URL` OAuth usage. Rename env to `GSC_LOGIN_URL` (the login page URL, e.g. `https://mini.local/mcp/gsc/login/`): presence enables web login + drives `loginHint()` ("Open <GSC_LOGIN_URL> in a browser to sign in"); absence keeps CLI text and `/login/` answers 503 naming `GSC_OAUTH_WEB_CLIENT_FILE` + `GSC_LOGIN_URL`.
- `deploy/gsc-mcp.service`: replace the two env lines with `GSC_OAUTH_WEB_CLIENT_FILE=/home/toni/.config/gsc-mcp/client-web.json` and `GSC_LOGIN_URL=https://mini.local/mcp/gsc/login/`.

### token.ts

- `StoredToken.client` keeps `'web' | 'desktop'`; `'web'` = minted by the browser-login client file (`GSC_OAUTH_WEB_CLIENT_FILE`, whatever wrapper shape). `loadCredentials` unchanged except it must tolerate the installed-shape web file via the generalized reader.
- Keep `adopt`, generation guard, `AccessMint` seam, `loginMessage(env)` (now from `GSC_LOGIN_URL`).

### Files

Rewrite `src/weblogin.ts`; trim `src/token.ts` (`readWebClient` generalized, `loginMessage` env rename); `src/main.ts` unchanged wiring except env name if referenced; tests: rewrite `test/weblogin.test.ts` (fake `device` seam; assert device-code POST body, page contains user_code + verification URL + meta refresh, poll-gated by nextPollAt, success order publish-then-adopt, slow_down backoff, access_denied page, expiry re-begin); update `test/token.test.ts` web fixtures to installed-shape + GSC_LOGIN_URL; `test/http.test.ts` 503/403 expectations with new env name. README + AGENTS.md: device-code flow replaces redirect text (one paragraph; mention TV client type + Google download filename `client_secret_*.json` and `scp ... mini.local:.config/gsc-mcp/client-web.json`).

### Acceptance

`npm run test` green; `/login/` still GET-only behind host/origin validators; no new deps; stdlib fetch for the two POSTs; CLI path untouched; no narrating comments.
