# Contract v3: paste-back browser login (device flow rejected by Google)

Runtime evidence added after contract v2 (all observed):
- Real Google POST to device/code with webmasters AND webmasters.readonly both return HTTP 400 invalid_scope "Invalid device flow scope". Device flow is dead for this API. Delete it.
- Public https hostname for a web-client redirect is blocked on every zero-touch path: no letsencrypt on mini, tailscale account cannot issue ts.net certs, cloudflared unauthenticated, no owned domain resolves to mini (86.121.182.216).
- The project's existing **installed** OAuth client (client.json, already on mini, 0600) accepts loopback redirects http://127.0.0.1:<port>/ (that is how CLI login works today). Google only requires the exchange's redirect_uri to match the authorize one, byte-for-byte; the exchanger does not need to own the loopback port.

## Flow to implement (replaces the device flow in src/weblogin.ts)

`GSC_LOGIN_URL` stays the enable-switch and hint source. Web login now uses `GSC_OAUTH_CLIENT_FILE` (the installed client); `GSC_OAUTH_WEB_CLIENT_FILE`, `readWebClient`, `WebClientCredentials`, device-flow code all deleted (clean cutover, no shims).

Constant: `LOOPBACK_REDIRECT = 'http://127.0.0.1:9/'` (nothing binds it anywhere; the browser tab will show ERR_CONNECTION_REFUSED after consent and the user copies the address bar).

- `GET /login/` (both prefixes, GET-only, behind host/origin validators, no-store):
  - `GSC_LOGIN_URL` unset or desktop client unreadable → 503 text naming `GSC_LOGIN_URL` and `GSC_OAUTH_CLIENT_FILE`.
  - Fresh begin (no live slot): `state = randomBytes(16).hex`, slot {state, expiresAt = now + 15 min}; render HTML page: link to authorize URL (`generateAuthUrl`-equivalent via OAuth2Client or hand-built: access_type=offline, prompt=consent, scope=webmasters, state, redirect_uri=LOOPBACK_REDIRECT) with instructions "open the link and sign in; the browser lands on an error page; copy the FULL address from the bar and paste it below". Page has no meta refresh (a reload must not re-begin silently; the begin button is the form target itself).
  - Live slot present → same page, keep slot.
- `POST /login/` (form field `url` = pasted address): handled ONLY when `GSC_LOGIN_URL` set and path matches login routes; content-type application/x-www-form-urlencoded (do not read body otherwise; cap 8 KiB).
  - No live slot → page "No login in progress" with restart link.
  - Parse with `new URL(pasted)`; require `origin === 'http://127.0.0.1:9'`, `pathname === '/'`, `state` param equals slot.state (else mismatch failure page, slot kept so a typo can be retried).
  - `error` param → clear slot, denied page.
  - `code` present → clear slot FIRST (single-use), then exchange with OAuth2Client(clientId, clientSecret, redirectUri=LOOPBACK_REDIRECT).getToken({code, redirect_uri: LOOPBACK_REDIRECT}); require refresh_token + scopeGranted(scope); `publishToken(tokenFile, refreshToken, SCOPE, 'desktop')`; `store.adopt({refreshToken, clientId, clientSecret})`; done page, no refresh.
  - Exchange failure → failed page (slot stays cleared; restart link).
- Adopt/publish order and generation guard: unchanged from v1/v2 (still correct).

## Seams and tests

- Injectable: `exchange?: (code: string) => Promise<WebExchangeResult>` + `newUrl?: () => URL`-style parse is unnecessary; keep one seam `exchange(code)` replacing OAuth2Client.getToken, default real. `now?` for expiry.
- test/weblogin.test.ts rewrite: begin page contains authorize URL with client_id/state/loopback redirect + instructions; GET reload does NOT re-begin; POST without slot → no-login page; POST wrong state → mismatch, slot survives, exchange not called; POST google error param → denied, slot cleared; happy POST → exchange saw code+loopback redirect, publish-then-adopt order (adopt reads file), token file `client:'desktop'` 0600, done page; exchange error → failed page, slot cleared, second identical POST → no-login; expired slot → re-begin on GET.
- test/token.test.ts: keep web-kind load tests but the web KIND remains in StoredToken for a future real web client? NO: delete `web` kind? Keep the union `'web' | 'desktop'` (token file schema already shipped to mini today is irrelevant, none exists; but StoredToken tolerance already handles absent=desktop). Decision: KEEP the kind field and dual-kind loadCredentials (cheap, already tested), but nothing writes 'web' anymore; drop only readWebClient and its env. Adjust web-mint fixture test accordingly (delete or repoint to desktop path).
- test/http.test.ts: 503 text env names; POST /login/ unconfigured still 503; evil Host 403 for both GET and POST /login/.

## Files

src/weblogin.ts (rewrite), src/token.ts (delete readWebClient/WebClientCredentials/WEB_* messages, keep kind+adopt+guard), src/main.ts untouched, test/weblogin.test.ts, test/token.test.ts, test/http.test.ts, deploy/gsc-mcp.service (drop GSC_OAUTH_WEB_CLIENT_FILE line), README.md + AGENTS.md (paste-back flow prose; mention browser lands on error page by design).

## Acceptance

npm run test green; GET-only rule relaxed ONLY for urlencoded POST on the two login paths with size cap; CLI login path untouched; no new deps; stdlib + google-auth-library only.
