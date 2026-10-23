# Search Console MCP

## Usage (caller's view)

The caller is the Cursor agent, plus the person who logs in once. The agent does not import this package. It calls four tools. The person runs login in a terminal, then Cursor starts the same program as a stdio server.

Create a Google Cloud desktop OAuth client, enable the Search Console API, and download the client JSON outside the repo. The consent screen uses only `https://www.googleapis.com/auth/webmasters.readonly`.

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

`list_sitemaps` lists sitemaps for one property. Pass `sitemapIndex`, the index URL, to list that index's children. Timestamps are Google's strings, or null when Google omits them. `type` and each contents `type` are Google's strings, copied through. This tool does not submit or delete sitemaps.

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

Other failures use the same JSON shape with `code` of `invalid_args`, `not_in_property`, `google_http`, or `bad_response`. Messages name the next action. They never include a token, a client secret, or a raw response body.
