import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { toolCatalog, type Http, type WireRequest, type WireResponse } from '../dist/console.js';
import {
  openTokenStore,
  SCOPE,
  TOKEN_PARTIAL_SUFFIX,
  type AccessToken,
  type TokenSource,
} from '../dist/token.js';

const SITE = 'https://www.example.com/';
const ANALYTICS_URL =
  'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fwww.example.com%2F/searchAnalytics/query';

function isAccessToken(value: string): value is AccessToken {
  return value.length > 0;
}

function accessToken(value: string): AccessToken {
  if (!isAccessToken(value)) throw new Error('empty access token');
  return value;
}

function tokens(first: string, refreshed = first): TokenSource {
  return {
    async accessToken() {
      return { ok: true, token: accessToken(first) };
    },
    async refresh() {
      return { ok: true, token: accessToken(refreshed) };
    },
  };
}

function harness(respond: (request: WireRequest, index: number) => WireResponse) {
  const calls: WireRequest[] = [];
  const http: Http = async (request) => {
    const index = calls.length;
    calls.push(request);
    return respond(request, index);
  };
  return { calls, catalog: toolCatalog({ tokens: tokens('token-a', 'token-b'), http }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function analyticsArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    siteUrl: SITE,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    ...extra,
  };
}

function metric(keys: string[], clicks = 12): Record<string, unknown> {
  return { keys, clicks, impressions: 340, ctr: 0.035, position: 4.2 };
}

function analyticsJson(rows: readonly unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ responseAggregationType: 'byPage', rows, ...extra });
}

function many(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${prefix}-${index}`);
}

const MINIMAL_INSPECTION = JSON.stringify({
  inspectionResult: {
    inspectionResultLink: 'https://search.google.com/search-console/inspect',
    indexStatusResult: {
      verdict: 'PASS',
      coverageState: 'Submitted and indexed',
      robotsTxtState: 'ALLOWED',
      indexingState: 'INDEXING_ALLOWED',
      pageFetchState: 'SUCCESSFUL',
    },
  },
});

test('search analytics posts the encoded property URL', async () => {
  const { calls, catalog } = harness(() => ({ status: 200, text: analyticsJson([]) }));
  const prefixed = await catalog.search_analytics.run(analyticsArgs());
  assert.equal(prefixed.ok, true, JSON.stringify(prefixed));
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.url, ANALYTICS_URL);
  const domain = await catalog.search_analytics.run(analyticsArgs({ siteUrl: 'sc-domain:example.com' }));
  assert.equal(domain.ok, true, JSON.stringify(domain));
  assert.equal(
    calls[1]?.url,
    'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query',
  );
});

test('search analytics body uses type, one and group, and a wire rowLimit of one more than asked', async () => {
  const { calls, catalog } = harness(() => ({ status: 200, text: analyticsJson([]) }));
  const result = await catalog.search_analytics.run(
    analyticsArgs({
      dimensions: ['query', 'page'],
      type: 'web',
      filters: [
        { dimension: 'device', expression: 'MOBILE' },
        { dimension: 'page', operator: 'contains', expression: '/docs' },
        { dimension: 'country', operator: 'equals', expression: 'usa' },
        { dimension: 'country', operator: 'contains', expression: 'us' },
      ],
      aggregationType: 'byPage',
      rowLimit: 10,
      startRow: 5,
      dataState: 'final',
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls[0]?.body, {
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    dimensions: ['query', 'page'],
    type: 'web',
    dimensionFilterGroups: [
      {
        groupType: 'and',
        filters: [
          { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
          { dimension: 'page', operator: 'contains', expression: '/docs' },
          { dimension: 'country', operator: 'equals', expression: 'USA' },
          { dimension: 'country', operator: 'contains', expression: 'us' },
        ],
      },
    ],
    aggregationType: 'byPage',
    rowLimit: 11,
    startRow: 5,
    dataState: 'final',
  });
  const defaults = await catalog.search_analytics.run(analyticsArgs());
  assert.equal(defaults.ok, true, JSON.stringify(defaults));
  assert.deepEqual(calls[1]?.body, {
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    rowLimit: 26,
    startRow: 0,
  });
});

test('search analytics rows are dimension records zipped from keys', async () => {
  const { catalog } = harness(() => ({
    status: 200,
    text: analyticsJson([metric(['https://www.example.com/docs', 'example docs'], 12)]),
  }));
  const result = await catalog.search_analytics.run(analyticsArgs({ dimensions: ['page', 'query'], rowLimit: 25 }));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.value.rows.length, 1);
  const row = result.value.rows[0];
  assert.ok(row);
  assert.deepEqual(row.dimensions, { page: 'https://www.example.com/docs', query: 'example docs' });
  assert.equal(Object.hasOwn(row, 'keys'), false);
  assert.equal(row.clicks, 12);
  assert.equal(row.impressions, 340);
  assert.equal(row.ctr, 0.035);
  assert.equal(row.position, 4.2);
  assert.equal(JSON.stringify(result.value).includes('"keys"'), false);
});

test('nextStartRow is set only when the spare row is present, and null when the page is short or exact', async () => {
  const pages = [3, 2, 1];
  let index = 0;
  const { calls, catalog } = harness(() => {
    const count = pages[index] ?? 0;
    index += 1;
    const rows = Array.from({ length: count }, (_unused, rowIndex) => metric([`query-${rowIndex}`], rowIndex + 1));
    return { status: 200, text: analyticsJson(rows) };
  });
  const spare = await catalog.search_analytics.run(
    analyticsArgs({ dimensions: ['query'], rowLimit: 2, startRow: 10 }),
  );
  assert.equal(spare.ok, true, JSON.stringify(spare));
  if (!spare.ok) return;
  assert.equal(spare.value.nextStartRow, 12);
  assert.deepEqual(
    spare.value.rows.map((row) => row.dimensions.query),
    ['query-0', 'query-1'],
  );
  const exact = await catalog.search_analytics.run(
    analyticsArgs({ dimensions: ['query'], rowLimit: 2, startRow: 10 }),
  );
  assert.equal(exact.ok, true, JSON.stringify(exact));
  if (!exact.ok) return;
  assert.equal(exact.value.rows.length, 2);
  assert.equal(exact.value.nextStartRow, null);
  const short = await catalog.search_analytics.run(
    analyticsArgs({ dimensions: ['query'], rowLimit: 2, startRow: 10 }),
  );
  assert.equal(short.ok, true, JSON.stringify(short));
  if (!short.ok) return;
  assert.equal(short.value.rows.length, 1);
  assert.equal(short.value.nextStartRow, null);
  const firstBody = calls[0]?.body;
  assert.ok(isRecord(firstBody));
  assert.equal(firstBody.rowLimit, 3);
});

test('an unknown analytics key does not call HTTP', async () => {
  const { calls, catalog } = harness(() => ({ status: 200, text: analyticsJson([]) }));
  const unknown = await catalog.search_analytics.run(analyticsArgs({ searchType: 'web' }));
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, 'invalid_args');
  const dateFilter = await catalog.search_analytics.run(
    analyticsArgs({ filters: [{ dimension: 'date', expression: '2026-09-01' }] }),
  );
  assert.equal(dateFilter.ok, false);
  if (!dateFilter.ok) assert.equal(dateFilter.code, 'invalid_args');
  const hour = await catalog.search_analytics.run(analyticsArgs({ dimensions: ['hour'] }));
  assert.equal(hour.ok, false);
  if (!hour.ok) assert.equal(hour.code, 'invalid_args');
  const tooMany = await catalog.search_analytics.run(analyticsArgs({ rowLimit: 101 }));
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.equal(tooMany.code, 'invalid_args');
  assert.equal(calls.length, 0);
});

test('not_in_property does not call HTTP', async () => {
  const { calls, catalog } = harness(() => ({ status: 200, text: MINIMAL_INSPECTION }));
  const prefix = await catalog.inspect_url.run({
    siteUrl: SITE,
    inspectionUrl: 'https://other.example/docs',
  });
  assert.equal(prefix.ok, false);
  if (!prefix.ok) assert.equal(prefix.code, 'not_in_property');
  const domain = await catalog.inspect_url.run({
    siteUrl: 'sc-domain:example.com',
    inspectionUrl: 'https://example.com.evil.com/docs',
  });
  assert.equal(domain.ok, false);
  if (!domain.ok) assert.equal(domain.code, 'not_in_property');
  const capital = await catalog.inspect_url.run({
    siteUrl: SITE,
    inspectionUrl: 'https://WWW.example.com/docs',
  });
  assert.equal(capital.ok, false);
  if (!capital.ok) assert.equal(capital.code, 'not_in_property');
  assert.equal(calls.length, 0);
});

test('inspection caps referring URLs, sitemaps, AMP issues, and rich items at 20 and reports the full counts', async () => {
  const referring = many('https://ref.example', 21);
  const sitemaps = many('https://sitemap.example', 21);
  const { catalog } = harness(() => ({
    status: 200,
    text: JSON.stringify({
      inspectionResult: {
        inspectionResultLink: 'https://search.google.com/search-console/inspect',
        indexStatusResult: {
          verdict: 'PASS',
          coverageState: 'Submitted and indexed',
          robotsTxtState: 'ALLOWED',
          indexingState: 'INDEXING_ALLOWED',
          pageFetchState: 'SUCCESSFUL',
          lastCrawlTime: '2026-09-20T15:01:23Z',
          googleCanonical: 'https://www.example.com/docs',
          userCanonical: 'https://www.example.com/docs',
          crawledAs: 'MOBILE',
          sitemap: sitemaps,
          referringUrls: referring,
        },
        ampResult: {
          verdict: 'PASS',
          ampUrl: 'https://www.example.com/docs/amp',
          robotsTxtState: 'ALLOWED',
          indexingState: 'INDEXING_ALLOWED',
          ampIndexStatusVerdict: 'PASS',
          lastCrawlTime: '2026-09-20T15:01:23Z',
          pageFetchState: 'SUCCESSFUL',
          issues: Array.from({ length: 21 }, (_unused, index) => ({
            issueMessage: `amp-issue-${index}`,
            severity: 'ERROR',
          })),
        },
        richResultsResult: {
          verdict: 'PASS',
          detectedItems: [
            {
              richResultType: 'Recipe',
              items: Array.from({ length: 21 }, (_unused, index) => ({ name: `item-${index}`, issues: [] })),
            },
          ],
        },
        mobileUsabilityResult: {
          verdict: 'FAIL',
          issues: [{ issueMessage: 'MOBILE_USABILITY_CANARY', severity: 'ERROR' }],
        },
      },
    }),
  }));
  const result = await catalog.inspect_url.run({ siteUrl: SITE, inspectionUrl: 'https://www.example.com/docs' });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const value = result.value;
  assert.deepEqual(value.index.referringUrls, referring.slice(0, 20));
  assert.equal(value.index.referringUrlCount, 21);
  assert.deepEqual(value.index.sitemaps, sitemaps.slice(0, 20));
  assert.equal(value.index.sitemapCount, 21);
  assert.ok(value.amp);
  assert.equal(value.amp.issueCount, 21);
  assert.equal(value.amp.issues.length, 20);
  assert.equal(value.amp.issues[0]?.message, 'amp-issue-0');
  assert.equal(value.amp.issues[19]?.message, 'amp-issue-19');
  assert.equal(Object.hasOwn(value.amp.issues[0] ?? {}, 'issueMessage'), false);
  assert.ok(value.richResults);
  assert.equal(value.richResults.itemCount, 21);
  assert.equal(value.richResults.items.length, 20);
  assert.equal(value.richResults.items[0]?.type, 'Recipe');
  assert.equal(value.richResults.items[0]?.name, 'item-0');
  assert.equal(value.richResults.items[19]?.name, 'item-19');
});

test('the inspection value has no mobile usability field', async () => {
  const { catalog } = harness(() => ({
    status: 200,
    text: JSON.stringify({
      inspectionResult: {
        inspectionResultLink: 'https://search.google.com/search-console/inspect',
        indexStatusResult: {
          verdict: 'NEUTRAL',
          coverageState: 'Excluded',
          robotsTxtState: 'ALLOWED',
          indexingState: 'INDEXING_ALLOWED',
          pageFetchState: 'SUCCESSFUL',
        },
        mobileUsabilityResult: { verdict: 'FAIL', detail: 'MOBILE_USABILITY_CANARY' },
      },
    }),
  }));
  const result = await catalog.inspect_url.run({ siteUrl: SITE, inspectionUrl: 'https://www.example.com/docs' });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(Object.hasOwn(result.value, 'mobileUsability'), false);
  assert.equal(Object.hasOwn(result.value, 'mobileUsabilityResult'), false);
  assert.equal(JSON.stringify(result.value).includes('MOBILE_USABILITY_CANARY'), false);
  assert.equal(JSON.stringify(result.value).includes('mobileUsability'), false);
});

test('a 401 refreshes once and the second request uses the new access token', async () => {
  const { calls, catalog } = harness((_request, index) => {
    if (index === 0) return { status: 401, text: '{"error":{"message":"expired"},"access_token":"SECRET_ACCESS"}' };
    return { status: 200, text: '{"siteEntry":[]}' };
  });
  const result = await catalog.list_sites.run({});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.authorization, 'Bearer token-a');
  assert.equal(calls[1]?.authorization, 'Bearer token-b');
  assert.equal(JSON.stringify(result).includes('SECRET_ACCESS'), false);
  const again = harness(() => ({ status: 401, text: '{"error":{"message":"expired"}}' }));
  const denied = await again.catalog.list_sites.run({});
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, 'not_logged_in');
  assert.equal(again.calls.length, 2);
});

test('a domain property matches the host and its subdomains', async () => {
  const { calls, catalog } = harness((request) => {
    assert.deepEqual(request.body, {
      siteUrl: 'sc-domain:Example.COM',
      inspectionUrl: 'https://WWW.Example.COM/docs',
    });
    return { status: 200, text: MINIMAL_INSPECTION };
  });
  const result = await catalog.inspect_url.run({
    siteUrl: 'sc-domain:Example.COM',
    inspectionUrl: 'https://WWW.Example.COM/docs',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect');
  if (result.ok) {
    assert.equal(result.value.amp, null);
    assert.equal(result.value.richResults, null);
    assert.equal(result.value.index.sitemapCount, 0);
    assert.equal(result.value.index.referringUrlCount, 0);
  }
});

test('an inspection URL with a port or username does not call HTTP', async () => {
  const { calls, catalog } = harness(() => ({ status: 200, text: MINIMAL_INSPECTION }));
  const port = await catalog.inspect_url.run({
    siteUrl: SITE,
    inspectionUrl: 'https://www.example.com:8443/docs',
  });
  const user = await catalog.inspect_url.run({
    siteUrl: SITE,
    inspectionUrl: 'https://user:secret@www.example.com/docs',
  });
  assert.equal(port.ok, false);
  assert.equal(user.ok, false);
  if (!port.ok) assert.equal(port.code, 'invalid_args');
  if (!user.ok) assert.equal(user.code, 'invalid_args');
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(user).includes('secret'), false);
});

test('list_sites keeps an unknown permission level and rejects a bad property', async () => {
  const { catalog } = harness((_request, index) => {
    if (index === 0) {
      return {
        status: 200,
        text: JSON.stringify({
          siteEntry: [
            { siteUrl: SITE, permissionLevel: 'siteOwner' },
            { siteUrl: 'sc-domain:example.com', permissionLevel: 'futureLevel' },
          ],
        }),
      };
    }
    return { status: 200, text: JSON.stringify({ siteEntry: [{ siteUrl: 'https://example.com', permissionLevel: 'siteOwner' }] }) };
  });
  const listed = await catalog.list_sites.run({});
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (listed.ok) {
    assert.deepEqual(
      listed.value.sites.map((site) => ({ siteUrl: site.siteUrl, permissionLevel: site.permissionLevel })),
      [
        { siteUrl: SITE, permissionLevel: 'siteOwner' },
        { siteUrl: 'sc-domain:example.com', permissionLevel: 'futureLevel' },
      ],
    );
  }
  const bad = await catalog.list_sites.run({});
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, 'bad_response');
});

test('list_sitemaps copies Google fields and encodes sitemapIndex', async () => {
  const { calls, catalog } = harness(() => ({
    status: 200,
    text: JSON.stringify({
      sitemap: [
        {
          path: 'https://www.example.com/sitemap.xml',
          lastSubmitted: '2026-09-01T00:00:00.000Z',
          isPending: false,
          isSitemapsIndex: true,
          type: 'sitemap',
          warnings: 0,
          errors: 0,
          contents: [{ type: 'web', submitted: 10, indexed: 8 }],
        },
      ],
    }),
  }));
  const result = await catalog.list_sitemaps.run({
    siteUrl: 'sc-domain:example.com',
    sitemapIndex: 'https://www.example.com/sitemap.xml',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(
    calls[0]?.url,
    'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps?sitemapIndex=https%3A%2F%2Fwww.example.com%2Fsitemap.xml',
  );
  if (result.ok) {
    assert.deepEqual(result.value.sitemaps, [
      {
        path: 'https://www.example.com/sitemap.xml',
        lastSubmitted: '2026-09-01T00:00:00.000Z',
        lastDownloaded: null,
        isPending: false,
        isSitemapsIndex: true,
        type: 'sitemap',
        warnings: 0,
        errors: 0,
        contents: [{ type: 'web', submitted: 10, indexed: 8 }],
      },
    ]);
  }
});

test('a google error message omits the rest of the body and a thrown request omits the token', async () => {
  const { catalog } = harness(() => ({
    status: 403,
    text: '{"error":{"message":"forbidden"},"refresh_token":"SECRET_REFRESH"}',
  }));
  const denied = await catalog.list_sites.run({});
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.code, 'google_http');
    assert.equal(denied.message.includes('403'), true);
    assert.equal(denied.message.includes('forbidden'), true);
    assert.equal(denied.message.includes('SECRET_REFRESH'), false);
  }
  const thrown = toolCatalog({
    tokens: tokens('token-a'),
    http: async (request) => {
      throw new Error(`socket ${request.authorization}`);
    },
  });
  const failed = await thrown.list_sites.run({});
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.code, 'google_http');
    assert.equal(failed.message.includes('token-a'), false);
    assert.equal(failed.message.includes('Bearer'), false);
  }
  const garbled = toolCatalog({
    tokens: tokens('token-a'),
    http: async () => ({ status: 200, text: 'not-json' }),
  });
  const unreadable = await garbled.list_sites.run({});
  assert.equal(unreadable.ok, false);
  if (!unreadable.ok) {
    assert.equal(unreadable.code, 'bad_response');
    assert.equal(unreadable.message.includes('not-json'), false);
  }
});

test('incomplete is a date for all, an hour for hourly_all, and null for final', async () => {
  const bodies = [
    analyticsJson([], { metadata: { first_incomplete_date: '2026-09-28' } }),
    analyticsJson([], { metadata: { first_incomplete_hour: '2026-09-28T01' } }),
    analyticsJson([], { metadata: { first_incomplete_date: '2026-09-28' } }),
  ];
  let index = 0;
  const { catalog } = harness(() => ({ status: 200, text: bodies[index++] ?? analyticsJson([]) }));
  const all = await catalog.search_analytics.run(analyticsArgs({ dataState: 'all' }));
  const hourly = await catalog.search_analytics.run(
    analyticsArgs({ dataState: 'hourly_all', dimensions: ['hour'] }),
  );
  const final = await catalog.search_analytics.run(analyticsArgs({ dataState: 'final' }));
  assert.equal(all.ok, true, JSON.stringify(all));
  assert.equal(hourly.ok, true, JSON.stringify(hourly));
  assert.equal(final.ok, true, JSON.stringify(final));
  if (!all.ok || !hourly.ok || !final.ok) return;
  assert.deepEqual(all.value.incomplete, { date: '2026-09-28' });
  assert.deepEqual(hourly.value.incomplete, { hour: '2026-09-28T01' });
  assert.equal(final.value.incomplete, null);
});

test('a partial sibling is never read into a tool error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gsc-partial-'));
  const canary = 'partial-canary-tool-77ab';
  const tokenFile = join(dir, 'token.json');
  const calls: string[] = [];
  try {
    await writeFile(
      `${tokenFile}${TOKEN_PARTIAL_SUFFIX}`,
      JSON.stringify({ refreshToken: canary, scope: SCOPE, leak: canary }),
    );
    await writeFile(join(dir, 'client.json'), JSON.stringify({ installed: { client_id: 'id', client_secret: 'secret' } }));
    const http: Http = async () => {
      calls.push('called');
      return { status: 200, text: '{}' };
    };
    const catalog = toolCatalog({
      tokens: openTokenStore({
        GSC_TOKEN_FILE: tokenFile,
        GSC_OAUTH_CLIENT_FILE: join(dir, 'client.json'),
      }),
      http,
    });
    const result = await catalog.list_sites.run({});
    assert.equal(calls.length, 0);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'not_logged_in');
      assert.equal(result.message, 'Run node dist/main.js login');
    }
    assert.equal(JSON.stringify(result).includes(canary), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const DOMAIN = 'sc-domain:example.com';
const SITEMAP_PORT = 'https://www.example.com:8443/sitemap.xml';

function resourceUrl(site: string): string {
  return `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}`;
}

function sitemapWireUrl(site: string, path: string): string {
  return `${resourceUrl(site)}/sitemaps/${encodeURIComponent(path)}`;
}

function assertWrite(request: WireRequest | undefined, method: 'PUT' | 'DELETE', url: string): void {
  assert.ok(request);
  assert.equal(request.method, method);
  assert.equal(request.url, url);
  assert.equal(Object.hasOwn(request, 'body'), false);
}

test('add_site and remove_site send the encoded property and no body', async () => {
  const { calls, catalog } = harness(() => ({ status: 200, text: '' }));
  const extra = await catalog.add_site.run({ siteUrl: DOMAIN, confirm: true });
  assert.equal(extra.ok, false);
  if (!extra.ok) assert.equal(extra.code, 'invalid_args');
  assert.equal(calls.length, 0);
  const added = await catalog.add_site.run({ siteUrl: DOMAIN });
  assert.equal(added.ok, true, JSON.stringify(added));
  if (added.ok) assert.deepEqual(added.value, { siteUrl: DOMAIN });
  assertWrite(calls[0], 'PUT', resourceUrl(DOMAIN));
  const removed = await catalog.remove_site.run({ siteUrl: DOMAIN });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  if (removed.ok) assert.deepEqual(removed.value, { siteUrl: DOMAIN, outcome: 'removed' });
  assertWrite(calls[1], 'DELETE', resourceUrl(DOMAIN));
  assert.equal(calls.length, 2);
});

test('submit_sitemap and remove_sitemap accept a port and send no body', async () => {
  const { calls, catalog } = harness(() => ({ status: 200, text: '' }));
  const submitted = await catalog.submit_sitemap.run({ siteUrl: DOMAIN, path: SITEMAP_PORT });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  if (submitted.ok) assert.deepEqual(submitted.value, { siteUrl: DOMAIN, path: SITEMAP_PORT });
  assertWrite(calls[0], 'PUT', sitemapWireUrl(DOMAIN, SITEMAP_PORT));
  const removed = await catalog.remove_sitemap.run({ siteUrl: DOMAIN, path: SITEMAP_PORT });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  if (removed.ok) {
    assert.deepEqual(removed.value, { siteUrl: DOMAIN, path: SITEMAP_PORT, outcome: 'removed' });
  }
  assertWrite(calls[1], 'DELETE', sitemapWireUrl(DOMAIN, SITEMAP_PORT));
  assert.equal(calls.length, 2);
  const user = await catalog.submit_sitemap.run({
    siteUrl: DOMAIN,
    path: 'https://user:secret@www.example.com/sitemap.xml',
  });
  assert.equal(user.ok, false);
  if (!user.ok) {
    assert.equal(user.code, 'invalid_args');
    assert.equal(user.message, 'Pass an absolute http or https URL with no username or password.');
  }
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(user).includes('secret'), false);
});

test('a non-empty 2xx write is bad_response', async () => {
  const { calls, catalog } = harness(() => ({ status: 200, text: '{}' }));
  const added = await catalog.add_site.run({ siteUrl: DOMAIN });
  const removed = await catalog.remove_site.run({ siteUrl: DOMAIN });
  const submitted = await catalog.submit_sitemap.run({ siteUrl: DOMAIN, path: SITEMAP_PORT });
  const sitemap = await catalog.remove_sitemap.run({ siteUrl: DOMAIN, path: SITEMAP_PORT });
  for (const result of [added, removed, submitted, sitemap]) {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'bad_response');
      assert.equal(result.message.includes('{}'), false);
    }
  }
  assert.equal(calls.length, 4);
  assertWrite(calls[0], 'PUT', resourceUrl(DOMAIN));
  assertWrite(calls[1], 'DELETE', resourceUrl(DOMAIN));
  assertWrite(calls[2], 'PUT', sitemapWireUrl(DOMAIN, SITEMAP_PORT));
  assertWrite(calls[3], 'DELETE', sitemapWireUrl(DOMAIN, SITEMAP_PORT));
});

test('DELETE 404 is already_absent and PUT 404 is google_http', async () => {
  const { calls, catalog } = harness((request) => {
    if (request.method === 'DELETE') return { status: 404, text: '{"error":{"message":"NOT_FOUND_CANARY"}}' };
    return { status: 404, text: '' };
  });
  const added = await catalog.add_site.run({ siteUrl: DOMAIN });
  const removed = await catalog.remove_site.run({ siteUrl: DOMAIN });
  const submitted = await catalog.submit_sitemap.run({ siteUrl: DOMAIN, path: SITEMAP_PORT });
  const sitemap = await catalog.remove_sitemap.run({ siteUrl: DOMAIN, path: SITEMAP_PORT });
  assert.equal(added.ok, false);
  if (!added.ok) {
    assert.equal(added.code, 'google_http');
    assert.equal(added.message.includes('404'), true);
  }
  assert.equal(submitted.ok, false);
  if (!submitted.ok) assert.equal(submitted.code, 'google_http');
  assert.equal(removed.ok, true, JSON.stringify(removed));
  if (removed.ok) assert.equal(removed.value.outcome, 'already_absent');
  assert.equal(sitemap.ok, true, JSON.stringify(sitemap));
  if (sitemap.ok) assert.equal(sitemap.value.outcome, 'already_absent');
  assert.equal(JSON.stringify(removed).includes('NOT_FOUND_CANARY'), false);
  assert.equal(JSON.stringify(sitemap).includes('NOT_FOUND_CANARY'), false);
  assert.equal(calls.length, 4);
  assertWrite(calls[0], 'PUT', resourceUrl(DOMAIN));
  assertWrite(calls[1], 'DELETE', resourceUrl(DOMAIN));
  assertWrite(calls[2], 'PUT', sitemapWireUrl(DOMAIN, SITEMAP_PORT));
  assertWrite(calls[3], 'DELETE', sitemapWireUrl(DOMAIN, SITEMAP_PORT));
});
