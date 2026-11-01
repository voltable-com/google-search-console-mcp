# Search Console MCP

## Usage (caller's view)

The caller is the Cursor agent, plus the person who logs in once. The agent does not import this package. It calls nine tools. The person runs login in a terminal, then Cursor starts the same program as a stdio server.

Create a Google Cloud desktop OAuth client, enable the Search Console API, and download the client JSON outside the repo. The consent screen uses only `https://www.googleapis.com/auth/webmasters`.

`GSC_OAUTH_CLIENT_FILE` points at that JSON. The token file defaults to `~/.local/share/gsc-mcp/token.json`. `GSC_TOKEN_FILE` overrides the token path. Neither file lives in the repo. `.cursor/mcp.json` holds the path, not the secret.

```json
{
  "mcpServers": {
    "gsc": {
      "command": "node",
      "args": ["dist/main.js", "serve"],
      "env": {
        "GSC_OAUTH_CLIENT_FILE": "/home/toni/.config/gsc-mcp/client.json"
      }
    }
  }
}
```

Login is not a tool. Run it before the server, and restart the server after a later login. The running process reads the token file once, at startup. stdout stays empty. stderr gets the Google URL and a one-line status. A second login replaces the token file. If the command crashes while writing, the previous token file stays current.

```text
node dist/main.js login
```

The server starts even when the token file is missing, so Cursor can list tools. A tool call with no usable token returns `not_logged_in` and the text below. The host marks that result as an error.

```json
{ "code": "not_logged_in", "message": "Run node dist/main.js login" }
```

A token file that still stores `https://www.googleapis.com/auth/webmasters.readonly` returns that same failure before any Search Console HTTP call. Run `node dist/main.js login` again, then restart the server.

`list_sites` takes no arguments. `permissionLevel` is one of `siteOwner`, `siteFullUser`, `siteRestrictedUser`, or `siteUnverifiedUser`, confirmed from the sites resource this session. The parser still accepts any string, so a new level does not drop the property. Pass `siteUrl` to the other tools unchanged. A URL-prefix property ends with a slash. A domain property looks like `sc-domain:example.com`.

```json
{
  "sites": [
    { "siteUrl": "https://www.example.com/", "permissionLevel": "siteOwner" },
    { "siteUrl": "sc-domain:example.com", "permissionLevel": "siteFullUser" }
  ]
}
```

`search_analytics` reads one property. Dates are inclusive `YYYY-MM-DD` calendar dates in Pacific Time. The server does not shift them. `dimensions` group the rows. Filters are AND. `date` and `hour` can group rows and cannot appear in a filter. The page defaults to 25 rows and cannot exceed 100. The server asks Google for one spare row. `nextStartRow` is `startRow` plus `rowLimit` only when that spare row comes back. Otherwise `nextStartRow` is null, including when the kept row count equals `rowLimit`. Pass `nextStartRow` back as `startRow` for the next page. An empty page past the end is a successful call with zero rows. Date grouping sorts oldest first. Every other grouping sorts by clicks, highest first. Google returns top rows, not every matching row. `ctr` is a fraction from 0 to 1. `incomplete` is null when Google sends no freshness marker. It is an object with a `date` string when the marker is `first_incomplete_date`, and an object with an `hour` string when the marker is `first_incomplete_hour`.

```json
{
  "siteUrl": "https://www.example.com/",
  "startDate": "2026-09-01",
  "endDate": "2026-09-30",
  "dimensions": ["query", "page"],
  "type": "web",
  "filters": [
    { "dimension": "device", "expression": "MOBILE" },
    { "dimension": "page", "operator": "contains", "expression": "/docs" }
  ],
  "aggregationType": "byPage",
  "rowLimit": 25,
  "startRow": 0,
  "dataState": "final"
}
```

```json
{
  "responseAggregationType": "byPage",
  "startRow": 0,
  "rowLimit": 25,
  "nextStartRow": null,
  "incomplete": null,
  "rows": [
    {
      "dimensions": {
        "query": "example docs",
        "page": "https://www.example.com/docs"
      },
      "clicks": 12,
      "impressions": 340,
      "ctr": 0.035,
      "position": 4.2
    }
  ]
}
```

`inspect_url` reports the indexed URL. It does not fetch the live page. `inspectionUrl` is an absolute `http` or `https` URL under the property. `languageCode` is an optional BCP-47 tag. When it is omitted, the request omits it and Google uses `en-US`. `verdict` of `PASS` means valid, `FAIL` means error, and `NEUTRAL` means excluded. `coverageState` is Google's text, copied through. `referringUrls`, `sitemaps`, AMP `issues`, and rich-result `items` each keep Google's order and hold at most 20 entries. `referringUrlCount`, `sitemapCount`, `issueCount`, and `itemCount` are the full counts before those caps. The counts are not fields on `UrlInspectionResult`. `amp` is null when Google omits `ampResult`. Otherwise it carries `verdict`, `ampUrl`, `robotsTxtState`, `indexingState`, `ampIndexStatusVerdict`, `lastCrawlTime`, `pageFetchState`, `issues` of `message` plus `severity`, and `issueCount`. The result has no mobile usability object.

```json
{
  "siteUrl": "https://www.example.com/",
  "inspectionUrl": "https://www.example.com/docs",
  "languageCode": "en-US"
}
```

```json
{
  "inspectionResultLink": "https://search.google.com/search-console/inspect",
  "index": {
    "verdict": "PASS",
    "coverageState": "Submitted and indexed",
    "robotsTxtState": "ALLOWED",
    "indexingState": "INDEXING_ALLOWED",
    "pageFetchState": "SUCCESSFUL",
    "lastCrawlTime": "2026-09-20T15:01:23Z",
    "googleCanonical": "https://www.example.com/docs",
    "userCanonical": "https://www.example.com/docs",
    "crawledAs": "MOBILE",
    "sitemaps": ["https://www.example.com/sitemap.xml"],
    "sitemapCount": 1,
    "referringUrls": ["https://www.example.com/"],
    "referringUrlCount": 1
  },
  "amp": null,
  "richResults": {
    "verdict": "PASS",
    "items": [{ "type": "Recipe", "name": "Example", "issues": [] }],
    "itemCount": 1
  }
}
```

`request_inspection` asks Google to crawl and index one URL under the property. It takes the same `siteUrl`, `inspectionUrl`, and optional `languageCode` as `inspect_url`. Google accepts the request, which does not confirm a crawl. `inspectionResultLink` opens the request result in Search Console; `siteUrl` and `inspectionUrl` echo the request. The outcome appears after Google recrawls; read it with `inspect_url`.

```json
{
  "siteUrl": "https://www.example.com/",
  "inspectionUrl": "https://www.example.com/docs"
}
```

```json
{
  "inspectionResultLink": "https://search.google.com/search-console/inspect",
  "siteUrl": "https://www.example.com/",
  "inspectionUrl": "https://www.example.com/docs"
}
```

`list_sitemaps` lists sitemaps for one property. Pass `sitemapIndex`, the index URL, to list that index's children. Timestamps are Google's strings, or null when Google omits them. `type` and each contents `type` are Google's strings, copied through. `submit_sitemap` submits a sitemap and `remove_sitemap` deletes one.

```json
{
  "siteUrl": "sc-domain:example.com",
  "sitemapIndex": "https://www.example.com/sitemap.xml"
}
```

```json
{
  "sitemaps": [
    {
      "path": "https://www.example.com/sitemap.xml",
      "lastSubmitted": "2026-09-01T00:00:00.000Z",
      "lastDownloaded": "2026-09-02T00:00:00.000Z",
      "isPending": false,
      "isSitemapsIndex": true,
      "type": "sitemap",
      "warnings": 0,
      "errors": 0,
      "contents": [{ "type": "web", "submitted": 10, "indexed": 8 }]
    }
  ]
}
```

`add_site` adds one Search Console property. `siteUrl` is a URL-prefix that ends with a slash, or a domain property `sc-domain:` plus a host with no slash. Adding the property does not verify it. This tool does not submit a sitemap.

```json
{ "siteUrl": "sc-domain:example.com" }
```

The result echoes `siteUrl`.

```json
{ "siteUrl": "sc-domain:example.com" }
```

`remove_site` deletes the Search Console property `siteUrl` from this Google account. Copy `siteUrl` from `list_sites`. Deleting a domain property leaves a URL-prefix property for the same host in place. This tool does not remove individual URLs from Google Search. `outcome` `removed` means Google accepted the delete. `outcome` `already_absent` means Google returned HTTP 404.

```json
{ "siteUrl": "sc-domain:example.com", "outcome": "removed" }
```

`submit_sitemap` submits one sitemap for one property. Copy `siteUrl` from `list_sites`. `path` is an absolute http or https URL, the same string `list_sitemaps` returns as `path`. A port is allowed. Submitting the same sitemap again returns the same `siteUrl` and `path`.

```json
{
  "siteUrl": "sc-domain:example.com",
  "path": "https://www.example.com/sitemap.xml"
}
```

The result echoes `siteUrl` and `path`.

`remove_sitemap` deletes the sitemap `path` from the property `siteUrl`. Copy `path` from `list_sitemaps`. Deleting the sitemap does not remove the listed URLs from Google Search. `outcome` `removed` means Google accepted the delete. `outcome` `already_absent` means Google returned HTTP 404.

```json
{
  "siteUrl": "sc-domain:example.com",
  "path": "https://www.example.com/sitemap.xml",
  "outcome": "removed"
}
```

URL removal from Google Search is absent. The Indexing API stays out.

Other failures use the same JSON shape with `code` of `invalid_args`, `not_in_property`, `google_http`, or `bad_response`. Messages name the next action. They never include a token, a client secret, or a raw response body.

## Serve over HTTPS

`serve-http` exposes the same nine tools as one streamable HTTP endpoint, for hosts that connect by URL instead of spawning a process. `GSC_HTTP_PORT` picks the port (default 8097). The server binds `127.0.0.1` only and answers `403` to any other `Host` or `Origin`, so it is reached through a reverse proxy.

```text
GSC_HTTP_PORT=8097 node dist/main.js serve-http
```

On mini.local the build lives in `/srv/gsc-mcp` and systemd runs it as `gsc-mcp.service` (`deploy/gsc-mcp.service`). nginx serves it at `https://mini.local/mcp/gsc/`. The client JSON and token file sit in `toni`'s home there. Google refresh tokens go stale; rerun `login` on the workstation and copy `token.json` over, then restart the service, because the process reads the token file once at startup. Or sign in from the browser, described next, and no restart is needed.

### Browser login (server)

`serve-http` can complete Google sign-in in any browser instead of the workstation CLI using a **paste-back** redirect login. The login client is the same installed `GSC_OAUTH_CLIENT_FILE` the CLI uses: installed clients accept a loopback redirect on any port, and Google only requires the token exchange's `redirect_uri` to match the authorize one byte-for-byte, so nobody has to listen on that port. Google Cloud Console rejects `*.local` redirect URIs and mini has no public hostname, so the authorize link ends on `http://127.0.0.1:41799/`, an address nothing binds: after consent the browser tab shows a connection-error page, and the user copies the full address from the bar and pastes it into the login form.

```text
GSC_OAUTH_CLIENT_FILE=/home/toni/.config/gsc-mcp/client.json   # the installed client, loopback redirects need no registration
GSC_LOGIN_URL=https://mini.local/mcp/gsc/login/                # this page's public URL
node dist/main.js serve-http
```

Open `https://mini.local/mcp/gsc/login/`, follow the sign-in link and sign in; the browser lands on an error page, by design. Copy the FULL address from the bar, paste it into the form and submit. The server checks the pasted address against the pending state, exchanges the code with `redirect_uri=http://127.0.0.1:41799/`, and on success writes the token file (mode `0600`) and the running process adopts the refresh token immediately; tools work without a restart. `not_logged_in` messages then name the login page instead of the CLI. The token file keeps the `client` field naming the kind that minted it; browser login mints `desktop`, like the CLI, and a file without it loads as desktop. Without `GSC_LOGIN_URL` or a readable `GSC_OAUTH_CLIENT_FILE` the server behaves exactly as before and the login page answers `503` naming both. The CLI `login` command is unchanged.
