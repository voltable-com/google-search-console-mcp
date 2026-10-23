## Learned User Preferences

- Keep the server a small local MCP wrapper around Google's official Search Console API for Cursor. The tools are `list_sites`, `search_analytics`, `inspect_url`, and `list_sitemaps`.
- OAuth uses only `https://www.googleapis.com/auth/webmasters.readonly`. Indexing requests stay out of this server.

## Learned Workspace Facts

- TypeScript stdio server named `gsc`. Commands are `node dist/main.js login` and `node dist/main.js serve`. Dependencies are `@modelcontextprotocol/server`, `google-auth-library` for OAuth, and Zod. `Catalog` in `src/console.ts` is the only tool-name list, and `src/main.ts` registers its keys. `SEARCH_TYPES`, `GROUP_DIMENSIONS`, `AGGREGATION_TYPES`, `DATA_STATES`, `OPERATORS`, and `DEVICE_NAMES` are the only copies of those sets.
- `GSC_OAUTH_CLIENT_FILE` is a Desktop OAuth client JSON outside the repo. The token file defaults to `~/.local/share/gsc-mcp/token.json` (`GSC_TOKEN_FILE` overrides), mode `0600`, and stores the refresh token plus the read-only scope. The process reads it once at startup and caches the access token in memory. A 401 refreshes once. Login leaves stdout empty. A missing token still lets Cursor list tools; calls then return `not_logged_in`. Restart the server after a later login.
- Failures are `invalid_args`, `not_logged_in`, `not_in_property`, `google_http`, and `bad_response`. Messages name the next action and omit tokens, client secrets, and raw response bodies.
- `search_analytics` dates are inclusive `YYYY-MM-DD` in Pacific Time and are passed through unchanged. Filters are `device`, `country`, `page`, `query`, and `searchAppearance`. `date` and `hour` only group rows. Grouping by `hour` requires `dataState` `hourly_all`. Pages default to 25 rows and stop at 100. The wire `rowLimit` is one higher, and `nextStartRow` is set only when that extra row returns. Row `dimensions` are keyed by the requested dimension names.
- `inspect_url` reports the indexed URL. Referring URLs, sitemaps, AMP issues, and rich-result items stay in Google's order, capped at 20, with separate full counts. `list_sitemaps` lists only. `permissionLevel` stays an open string. A URL-prefix property ends with a slash. A domain property looks like `sc-domain:example.com`.
- `origin` is a bare repository on `mini.local`. `gh` is not installed here, so GitHub pull requests are not opened from this checkout. `main` and `origin/main` contain the Search Console MCP server.
