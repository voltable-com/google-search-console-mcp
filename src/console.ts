import * as z from 'zod/v4';
import type { TokenSource } from './token.js';

declare const siteUrlBrand: unique symbol;
declare const sitemapUrlBrand: unique symbol;
declare const inspectionUrlBrand: unique symbol;
declare const isoDateBrand: unique symbol;
declare const countryCodeBrand: unique symbol;

export type SiteUrl = string & { readonly [siteUrlBrand]: 'SiteUrl' };
export type SitemapUrl = string & { readonly [sitemapUrlBrand]: 'SitemapUrl' };
export type InspectionUrl = string & { readonly [inspectionUrlBrand]: 'InspectionUrl' };
export type IsoDate = string & { readonly [isoDateBrand]: 'IsoDate' };
export type CountryCode = string & { readonly [countryCodeBrand]: 'CountryCode' };

export const SEARCH_TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
export const GROUP_DIMENSIONS = ['country', 'device', 'page', 'query', 'searchAppearance', 'date', 'hour'] as const;
export type GroupDimension = (typeof GROUP_DIMENSIONS)[number];
export const AGGREGATION_TYPES = ['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'] as const;
export type AggregationType = (typeof AGGREGATION_TYPES)[number];
export const DATA_STATES = ['final', 'all', 'hourly_all'] as const;
export type DataState = (typeof DATA_STATES)[number];
export const OPERATORS = ['equals', 'contains', 'notContains', 'notEquals', 'includingRegex', 'excludingRegex'] as const;
export type Operator = (typeof OPERATORS)[number];
export const DEVICE_NAMES = ['DESKTOP', 'MOBILE', 'TABLET'] as const;
export type DeviceName = (typeof DEVICE_NAMES)[number];

export type Filter =
  | { dimension: 'device'; operator: Operator; expression: DeviceName }
  | { dimension: 'country'; operator: 'equals' | 'notEquals'; expression: CountryCode }
  | {
      dimension: 'country';
      operator: 'contains' | 'notContains' | 'includingRegex' | 'excludingRegex';
      expression: string;
    }
  | { dimension: 'page' | 'query' | 'searchAppearance'; operator: Operator; expression: string };

const ROW_LIMIT_DEFAULT = 25;
const ROW_LIMIT_MAX = 100;
const LIST_CAP = 20;
const FILTER_EXPRESSION_MAX = 4096;
const ERROR_MESSAGE_LIMIT = 200;
const SITES_URL = 'https://www.googleapis.com/webmasters/v3/sites';
const INSPECT_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

const SITE_URL_PATTERN = /^(https?:\/\/\S+\/|sc-domain:[^\s/]+)$/;

const LIST_SITES_DESCRIPTION =
  '`list_sites` takes no arguments. `permissionLevel` is one of `siteOwner`, `siteFullUser`, `siteRestrictedUser`, or `siteUnverifiedUser`, confirmed from the sites resource this session. The parser still accepts any string, so a new level does not drop the property. Pass `siteUrl` to the other tools unchanged. A URL-prefix property ends with a slash. A domain property looks like `sc-domain:example.com`.';

const SEARCH_ANALYTICS_DESCRIPTION =
  '`search_analytics` reads one property. Dates are inclusive `YYYY-MM-DD` calendar dates in Pacific Time. The server does not shift them. `dimensions` group the rows. Filters are AND. `date` and `hour` can group rows and cannot appear in a filter. The page defaults to 25 rows and cannot exceed 100. The server asks Google for one spare row. `nextStartRow` is `startRow` plus `rowLimit` only when that spare row comes back. Otherwise `nextStartRow` is null, including when the kept row count equals `rowLimit`. Pass `nextStartRow` back as `startRow` for the next page. An empty page past the end is a successful call with zero rows. Date grouping sorts oldest first. Every other grouping sorts by clicks, highest first. Google returns top rows, not every matching row. `ctr` is a fraction from 0 to 1. `incomplete` is null when Google sends no freshness marker. It is an object with a `date` string when the marker is `first_incomplete_date`, and an object with an `hour` string when the marker is `first_incomplete_hour`.';

const INSPECT_URL_DESCRIPTION =
  '`inspect_url` reports the indexed URL. It does not fetch the live page. `inspectionUrl` is an absolute `http` or `https` URL under the property. `languageCode` is an optional BCP-47 tag. When it is omitted, the request omits it and Google uses `en-US`. `verdict` of `PASS` means valid, `FAIL` means error, and `NEUTRAL` means excluded. `coverageState` is Google\'s text, copied through. `referringUrls`, `sitemaps`, AMP `issues`, and rich-result `items` each keep Google\'s order and hold at most 20 entries. `referringUrlCount`, `sitemapCount`, `issueCount`, and `itemCount` are the full counts before those caps. The counts are not fields on `UrlInspectionResult`. `amp` is null when Google omits `ampResult`. Otherwise it carries `verdict`, `ampUrl`, `robotsTxtState`, `indexingState`, `ampIndexStatusVerdict`, `lastCrawlTime`, `pageFetchState`, `issues` of `message` plus `severity`, and `issueCount`. The result has no mobile usability object.';

const LIST_SITEMAPS_DESCRIPTION =
  '`list_sitemaps` lists sitemaps for one property. Pass `sitemapIndex`, the index URL, to list that index\'s children. Timestamps are Google\'s strings, or null when Google omits them. `type` and each contents `type` are Google\'s strings, or null when Google omits them. `warnings`, `errors`, and each contents `submitted` and `indexed` are counts, zero when Google omits them. `submit_sitemap` submits a sitemap and `remove_sitemap` deletes one.';

const ADD_SITE_DESCRIPTION =
  '`add_site` adds one Search Console property. `siteUrl` is a URL-prefix that ends with a slash, or a domain property `sc-domain:` plus a host with no slash. Adding the property does not verify it. This tool does not submit a sitemap.';

const REMOVE_SITE_DESCRIPTION =
  '`remove_site` deletes the Search Console property `siteUrl` from this Google account. Copy `siteUrl` from `list_sites`. Deleting a domain property leaves a URL-prefix property for the same host in place. This tool does not remove individual URLs from Google Search. `outcome` `removed` means Google accepted the delete. `outcome` `already_absent` means Google returned HTTP 404.';

const SUBMIT_SITEMAP_DESCRIPTION =
  '`submit_sitemap` submits one sitemap for one property. Copy `siteUrl` from `list_sites`. `path` is an absolute http or https URL, the same string `list_sitemaps` returns as `path`. A port is allowed. Submitting the same sitemap again returns the same `siteUrl` and `path`.';

const REMOVE_SITEMAP_DESCRIPTION =
  '`remove_sitemap` deletes the sitemap `path` from the property `siteUrl`. Copy `path` from `list_sitemaps`. Deleting the sitemap does not remove the listed URLs from Google Search. `outcome` `removed` means Google accepted the delete. `outcome` `already_absent` means Google returned HTTP 404.';

const SITEMAP_PATH_MESSAGE = 'Pass an absolute http or https URL with no username or password.';

export type FailureCode = 'invalid_args' | 'not_logged_in' | 'not_in_property' | 'google_http' | 'bad_response';

export type ToolResult<T> = { ok: true; value: T } | { ok: false; code: FailureCode; message: string };

export type Site = { siteUrl: SiteUrl; permissionLevel: string };

export type SiteList = { sites: readonly Site[] };

export type AnalyticsRow = {
  dimensions: { [K in GroupDimension]?: string };
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type Incomplete = { date: string } | { hour: string } | null;

export type AnalyticsPage = {
  responseAggregationType: string;
  startRow: number;
  rowLimit: number;
  nextStartRow: number | null;
  incomplete: Incomplete;
  rows: readonly AnalyticsRow[];
};

export type IndexStatus = {
  verdict: string;
  coverageState: string;
  robotsTxtState: string;
  indexingState: string;
  pageFetchState: string;
  lastCrawlTime: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  crawledAs: string | null;
  sitemaps: readonly string[];
  sitemapCount: number;
  referringUrls: readonly string[];
  referringUrlCount: number;
};

export type AmpStatus = {
  verdict: string;
  ampUrl: string | null;
  robotsTxtState: string;
  indexingState: string;
  ampIndexStatusVerdict: string;
  lastCrawlTime: string | null;
  pageFetchState: string;
  issues: readonly { message: string; severity: string }[];
  issueCount: number;
};

export type RichResultItem = {
  type: string;
  name: string;
  issues: readonly { message: string; severity: string }[];
};

export type Inspection = {
  inspectionResultLink: string;
  index: IndexStatus;
  amp: AmpStatus | null;
  richResults: { verdict: string; items: readonly RichResultItem[]; itemCount: number } | null;
};

export type SitemapContent = { type: string | null; submitted: number; indexed: number };

export type Sitemap = {
  path: string;
  lastSubmitted: string | null;
  lastDownloaded: string | null;
  isPending: boolean;
  isSitemapsIndex: boolean;
  type: string | null;
  warnings: number;
  errors: number;
  contents: readonly SitemapContent[];
};

export type SitemapList = { sitemaps: readonly Sitemap[] };

export type RemovalOutcome = 'removed' | 'already_absent';
export type AddedSite = { siteUrl: SiteUrl };
export type SubmittedSitemap = { siteUrl: SiteUrl; path: SitemapUrl };
export type RemovedSite = { siteUrl: SiteUrl; outcome: RemovalOutcome };
export type RemovedSitemap = { siteUrl: SiteUrl; path: SitemapUrl; outcome: RemovalOutcome };

type UnsignedRequest =
  | { method: 'GET'; url: string }
  | { method: 'POST'; url: string; body: unknown }
  | { method: 'PUT'; url: string }
  | { method: 'DELETE'; url: string };

export type WireRequest = UnsignedRequest & { authorization: string };

type EmptyBody = { kind: 'empty' };
type DeleteBody = { kind: 'empty' } | { kind: 'absent' };

export type WireResponse = { status: number; text: string };

export type Http = (request: WireRequest) => Promise<WireResponse>;

export type ConsoleDeps = {
  tokens: TokenSource;
  http?: Http;
};

type Tool<Value> = {
  description: string;
  inputSchema: z.ZodType;
  run(args: unknown): Promise<ToolResult<Value>>;
};

export type Catalog = {
  list_sites: Tool<SiteList>;
  search_analytics: Tool<AnalyticsPage>;
  inspect_url: Tool<Inspection>;
  list_sitemaps: Tool<SitemapList>;
  add_site: Tool<AddedSite>;
  remove_site: Tool<RemovedSite>;
  submit_sitemap: Tool<SubmittedSitemap>;
  remove_sitemap: Tool<RemovedSitemap>;
};

type AnalyticsWireBody = {
  startDate: string;
  endDate: string;
  dimensions?: readonly GroupDimension[];
  type?: SearchType;
  dimensionFilterGroups?: readonly [
    {
      groupType: 'and';
      filters: readonly { dimension: string; operator: Operator; expression: string }[];
    },
  ];
  aggregationType?: AggregationType;
  rowLimit: number;
  startRow: number;
  dataState?: DataState;
};

type ParsedAnalytics = {
  siteUrl: SiteUrl;
  startDate: IsoDate;
  endDate: IsoDate;
  dimensions: readonly GroupDimension[];
  type?: SearchType;
  filters: readonly Filter[];
  aggregationType?: AggregationType;
  rowLimit: number;
  startRow: number;
  dataState?: DataState;
};

type CalendarDay = { year: number; month: number; day: number };

type LooseCountryOperator = 'contains' | 'notContains' | 'includingRegex' | 'excludingRegex';

const operatorSchema = z.enum(OPERATORS).default('equals');

const textFilter = (dimension: 'page' | 'query' | 'searchAppearance') =>
  z.strictObject({
    dimension: z.literal(dimension),
    operator: operatorSchema,
    expression: z.string().min(1).max(FILTER_EXPRESSION_MAX),
  });

const filterSchema = z.discriminatedUnion('dimension', [
  z.strictObject({
    dimension: z.literal('device'),
    operator: operatorSchema,
    expression: z.enum(DEVICE_NAMES),
  }),
  z.strictObject({
    dimension: z.literal('country'),
    operator: operatorSchema,
    expression: z.string().min(1).max(FILTER_EXPRESSION_MAX),
  }),
  textFilter('page'),
  textFilter('query'),
  textFilter('searchAppearance'),
]);

const searchAnalyticsSchema = z
  .strictObject({
    siteUrl: z.string().regex(SITE_URL_PATTERN),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dimensions: z.array(z.enum(GROUP_DIMENSIONS)).optional(),
    type: z.enum(SEARCH_TYPES).optional(),
    filters: z.array(filterSchema).optional(),
    aggregationType: z.enum(AGGREGATION_TYPES).optional(),
    rowLimit: z.int().min(1).max(ROW_LIMIT_MAX).default(ROW_LIMIT_DEFAULT),
    startRow: z.int().min(0).default(0),
    dataState: z.enum(DATA_STATES).optional(),
  })
  .superRefine((value, ctx) => {
    const message = analyticsConflict(value);
    if (message !== null) ctx.addIssue({ code: 'custom', message, input: value });
  });

const listSitesSchema = z.strictObject({});

const inspectUrlSchema = z.strictObject({
  siteUrl: z.string().regex(SITE_URL_PATTERN),
  inspectionUrl: z.string().regex(/^https?:\/\/\S+$/),
  languageCode: z.string().min(1).optional(),
});

const listSitemapsSchema = z.strictObject({
  siteUrl: z.string().regex(SITE_URL_PATTERN),
  sitemapIndex: z.string().min(1).optional(),
});

const siteWriteSchema = z.strictObject({
  siteUrl: z.string(),
});

const sitemapWriteSchema = z.strictObject({
  siteUrl: z.string(),
  path: z.string(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSiteUrl(value: string): value is SiteUrl {
  return SITE_URL_PATTERN.test(value);
}

function isInspectionUrl(value: string): value is InspectionUrl {
  if (!/^https?:\/\/\S+$/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.username === '' && url.password === '' && url.port === '' && (url.protocol === 'http:' || url.protocol === 'https:');
}

function isSitemapUrl(value: string): value is SitemapUrl {
  if (/\s/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' && url.username === '' && url.password === '';
}

function isIsoDate(value: string): value is IsoDate {
  return calendarDay(value) !== null;
}

function isCountryCode(value: string): value is CountryCode {
  return /^[A-Z]{3}$/.test(value);
}

function isLooseCountryOperator(operator: Operator): operator is LooseCountryOperator {
  return (
    operator === 'contains' ||
    operator === 'notContains' ||
    operator === 'includingRegex' ||
    operator === 'excludingRegex'
  );
}

function calendarDay(value: string): CalendarDay | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  if (yearText === undefined || monthText === undefined || dayText === undefined) return null;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

function compareDays(left: CalendarDay, right: CalendarDay): number {
  if (left.year !== right.year) return left.year - right.year;
  if (left.month !== right.month) return left.month - right.month;
  return left.day - right.day;
}

function invalidArgs(message: string | undefined): ToolResult<never> {
  return { ok: false, code: 'invalid_args', message: message ?? 'Check the arguments.' };
}

function badResponse(): ToolResult<never> {
  return {
    ok: false,
    code: 'bad_response',
    message: 'Search Console returned a response the server could not read. Retry the call.',
  };
}

function issueMessage(issues: readonly { message: string }[]): string | undefined {
  return issues[0]?.message;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function countField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value);
  return null;
}

function requiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== 'string') return null;
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): { ok: true; value: string | null } | { ok: false } {
  if (!Object.hasOwn(record, key) || record[key] === undefined || record[key] === null) return { ok: true, value: null };
  if (typeof record[key] !== 'string') return { ok: false };
  return { ok: true, value: record[key] };
}

function stringList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    items.push(item);
  }
  return items;
}

function cap<T>(items: readonly T[]): { kept: T[]; count: number } {
  return { kept: items.slice(0, LIST_CAP), count: items.length };
}

function analyticsConflict(value: {
  startDate: string;
  endDate: string;
  dimensions?: readonly string[] | undefined;
  type?: string | undefined;
  filters?: readonly { dimension: string; operator: Operator; expression: string }[] | undefined;
  aggregationType?: string | undefined;
  dataState?: string | undefined;
}): string | null {
  const start = calendarDay(value.startDate);
  const end = calendarDay(value.endDate);
  if (start === null) return 'Use a real calendar date for startDate.';
  if (end === null) return 'Use a real calendar date for endDate.';
  if (compareDays(start, end) > 0) return 'Use a startDate on or before endDate.';
  const dimensions = value.dimensions ?? [];
  const seen = new Set<string>();
  for (const dimension of dimensions) {
    if (seen.has(dimension)) return `Remove the repeated ${dimension} dimension.`;
    seen.add(dimension);
  }
  if (dimensions.includes('hour') && value.dataState !== 'hourly_all') {
    return 'Set dataState to hourly_all when grouping by hour.';
  }
  const filters = value.filters ?? [];
  for (const filter of filters) {
    if (filter.dimension !== 'country') continue;
    if (filter.operator !== 'equals' && filter.operator !== 'notEquals') continue;
    if (!/^[A-Za-z]{3}$/.test(filter.expression)) {
      return 'Use a three-letter country code when the operator is equals or notEquals.';
    }
  }
  if (value.aggregationType === 'byProperty') {
    const pageUsed = dimensions.includes('page') || filters.some((filter) => filter.dimension === 'page');
    if (pageUsed) return 'Remove page grouping and page filters when aggregationType is byProperty.';
    if (value.type === 'discover' || value.type === 'googleNews') {
      return 'Use a search type other than discover or googleNews when aggregationType is byProperty.';
    }
  }
  if (value.aggregationType === 'byNewsShowcasePanel') {
    const typeOk = value.type === 'discover' || value.type === 'googleNews';
    const appearance = filters.filter((filter) => filter.dimension === 'searchAppearance');
    const showcase = appearance.filter((filter) => filter.operator === 'equals' && filter.expression === 'NEWS_SHOWCASE');
    const pageUsed = dimensions.includes('page') || filters.some((filter) => filter.dimension === 'page');
    if (!typeOk || showcase.length !== 1 || appearance.length !== 1 || pageUsed) {
      return 'Use type discover or googleNews, one searchAppearance filter equal to NEWS_SHOWCASE, and no page grouping or page filter for byNewsShowcasePanel.';
    }
  }
  return null;
}

function toFilter(filter: z.output<typeof filterSchema>): Filter | null {
  if (filter.dimension === 'device' || filter.dimension === 'page' || filter.dimension === 'query' || filter.dimension === 'searchAppearance') {
    return filter;
  }
  if (filter.operator === 'equals' || filter.operator === 'notEquals') {
    const expression = filter.expression.toUpperCase();
    if (!isCountryCode(expression)) return null;
    return { dimension: 'country', operator: filter.operator, expression };
  }
  if (!isLooseCountryOperator(filter.operator)) return null;
  return { dimension: 'country', operator: filter.operator, expression: filter.expression };
}

function parseAnalytics(raw: unknown): ToolResult<ParsedAnalytics> {
  const parsed = searchAnalyticsSchema.safeParse(raw);
  if (!parsed.success) return invalidArgs(issueMessage(parsed.error.issues));
  const siteUrl = isSiteUrl(parsed.data.siteUrl) ? parsed.data.siteUrl : null;
  const startDate = isIsoDate(parsed.data.startDate) ? parsed.data.startDate : null;
  const endDate = isIsoDate(parsed.data.endDate) ? parsed.data.endDate : null;
  if (siteUrl === null || startDate === null || endDate === null) {
    return invalidArgs('Check siteUrl, startDate, and endDate.');
  }
  const filters: Filter[] = [];
  for (const filter of parsed.data.filters ?? []) {
    const branded = toFilter(filter);
    if (branded === null) return invalidArgs('Check the filters.');
    filters.push(branded);
  }
  const value: ParsedAnalytics = {
    siteUrl,
    startDate,
    endDate,
    dimensions: parsed.data.dimensions ?? [],
    filters,
    rowLimit: parsed.data.rowLimit,
    startRow: parsed.data.startRow,
  };
  if (parsed.data.type !== undefined) value.type = parsed.data.type;
  if (parsed.data.aggregationType !== undefined) value.aggregationType = parsed.data.aggregationType;
  if (parsed.data.dataState !== undefined) value.dataState = parsed.data.dataState;
  return { ok: true, value };
}

function analyticsBody(args: ParsedAnalytics): AnalyticsWireBody {
  const body: AnalyticsWireBody = {
    startDate: args.startDate,
    endDate: args.endDate,
    // One spare row distinguishes a full page from the last page.
    rowLimit: args.rowLimit + 1,
    startRow: args.startRow,
  };
  if (args.dimensions.length > 0) body.dimensions = args.dimensions;
  if (args.type !== undefined) body.type = args.type;
  if (args.aggregationType !== undefined) body.aggregationType = args.aggregationType;
  if (args.dataState !== undefined) body.dataState = args.dataState;
  if (args.filters.length > 0) {
    body.dimensionFilterGroups = [
      {
        groupType: 'and',
        filters: args.filters.map((filter) => ({
          dimension: filter.dimension,
          operator: filter.operator,
          expression: filter.expression,
        })),
      },
    ];
  }
  return body;
}

function siteResourceUrl(site: SiteUrl): string {
  return `${SITES_URL}/${encodeURIComponent(site)}`;
}

function analyticsUrl(site: SiteUrl): string {
  return `${siteResourceUrl(site)}/searchAnalytics/query`;
}

function parseRow(dimensions: readonly GroupDimension[], value: unknown): AnalyticsRow | null {
  if (!isRecord(value)) return null;
  const rawKeys = value.keys;
  const keys = rawKeys === undefined || rawKeys === null ? [] : rawKeys;
  if (!Array.isArray(keys) || keys.length !== dimensions.length) return null;
  const record: AnalyticsRow['dimensions'] = {};
  for (let index = 0; index < dimensions.length; index += 1) {
    const name = dimensions[index];
    const key = keys[index];
    if (name === undefined || typeof key !== 'string') return null;
    record[name] = key;
  }
  const clicks = finiteNumber(value.clicks);
  const impressions = finiteNumber(value.impressions);
  const ctr = finiteNumber(value.ctr);
  const position = finiteNumber(value.position);
  if (clicks === null || impressions === null || ctr === null || position === null) return null;
  return { dimensions: record, clicks, impressions, ctr, position };
}

function incompleteFrom(dataState: DataState | undefined, metadata: unknown): Incomplete {
  switch (dataState) {
    case undefined:
    case 'final':
      return null;
    case 'all':
      return freshness(metadata, 'first_incomplete_date', 'date');
    case 'hourly_all':
      return freshness(metadata, 'first_incomplete_hour', 'hour');
    default: {
      const exhaustive: never = dataState;
      return exhaustive;
    }
  }
}

function freshness(metadata: unknown, key: string, field: 'date' | 'hour'): Incomplete {
  if (!isRecord(metadata)) return null;
  const value = metadata[key];
  if (typeof value !== 'string') return null;
  if (field === 'date') return { date: value };
  return { hour: value };
}

function parseAnalyticsPage(args: ParsedAnalytics, json: unknown): ToolResult<AnalyticsPage> {
  if (!isRecord(json) || typeof json.responseAggregationType !== 'string') return badResponse();
  const rawRows = json.rows === undefined ? [] : json.rows;
  if (!Array.isArray(rawRows)) return badResponse();
  const rows: AnalyticsRow[] = [];
  for (const entry of rawRows) {
    const row = parseRow(args.dimensions, entry);
    if (row === null) return badResponse();
    rows.push(row);
  }
  const overflow = rows.length > args.rowLimit;
  return {
    ok: true,
    value: {
      responseAggregationType: json.responseAggregationType,
      startRow: args.startRow,
      rowLimit: args.rowLimit,
      nextStartRow: overflow ? args.startRow + args.rowLimit : null,
      incomplete: incompleteFrom(args.dataState, json.metadata),
      rows: overflow ? rows.slice(0, args.rowLimit) : rows,
    },
  };
}

async function queryAnalytics(deps: ConsoleDeps, raw: unknown): Promise<ToolResult<AnalyticsPage>> {
  const parsed = parseAnalytics(raw);
  if (!parsed.ok) return parsed;
  const sent = await send(deps, {
    method: 'POST',
    url: analyticsUrl(parsed.value.siteUrl),
    body: analyticsBody(parsed.value),
  });
  if (!sent.ok) return sent;
  return parseAnalyticsPage(parsed.value, sent.value);
}

function parseSiteList(json: unknown): ToolResult<SiteList> {
  if (!isRecord(json)) return badResponse();
  if (json.siteEntry === undefined) return { ok: true, value: { sites: [] } };
  if (!Array.isArray(json.siteEntry)) return badResponse();
  const sites: Site[] = [];
  for (const entry of json.siteEntry) {
    if (!isRecord(entry) || typeof entry.siteUrl !== 'string' || typeof entry.permissionLevel !== 'string') {
      return badResponse();
    }
    if (!isSiteUrl(entry.siteUrl)) return badResponse();
    sites.push({ siteUrl: entry.siteUrl, permissionLevel: entry.permissionLevel });
  }
  return { ok: true, value: { sites } };
}

async function querySites(deps: ConsoleDeps): Promise<ToolResult<SiteList>> {
  const sent = await send(deps, { method: 'GET', url: SITES_URL });
  if (!sent.ok) return sent;
  return parseSiteList(sent.value);
}

function urlBelongsToProperty(site: SiteUrl, page: InspectionUrl): boolean {
  if (site.startsWith('sc-domain:')) {
    const domain = site.slice('sc-domain:'.length).toLowerCase();
    const host = new URL(page).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }
  return page.startsWith(site);
}

function readIssues(value: unknown): { message: string; severity: string }[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const issues: { message: string; severity: string }[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.issueMessage !== 'string' || typeof entry.severity !== 'string') return null;
    issues.push({ message: entry.issueMessage, severity: entry.severity });
  }
  return issues;
}

function parseIndex(value: unknown): IndexStatus | null {
  if (!isRecord(value)) return null;
  const verdict = requiredString(value, 'verdict');
  const coverageState = requiredString(value, 'coverageState');
  const robotsTxtState = requiredString(value, 'robotsTxtState');
  const indexingState = requiredString(value, 'indexingState');
  const pageFetchState = requiredString(value, 'pageFetchState');
  if (verdict === null || coverageState === null || robotsTxtState === null || indexingState === null || pageFetchState === null) {
    return null;
  }
  const lastCrawlTime = optionalString(value, 'lastCrawlTime');
  const googleCanonical = optionalString(value, 'googleCanonical');
  const userCanonical = optionalString(value, 'userCanonical');
  const crawledAs = optionalString(value, 'crawledAs');
  if (!lastCrawlTime.ok || !googleCanonical.ok || !userCanonical.ok || !crawledAs.ok) return null;
  const sitemaps = stringList(value.sitemap);
  const referringUrls = stringList(value.referringUrls);
  if (sitemaps === null || referringUrls === null) return null;
  const cappedSitemaps = cap(sitemaps);
  const cappedReferring = cap(referringUrls);
  return {
    verdict,
    coverageState,
    robotsTxtState,
    indexingState,
    pageFetchState,
    lastCrawlTime: lastCrawlTime.value,
    googleCanonical: googleCanonical.value,
    userCanonical: userCanonical.value,
    crawledAs: crawledAs.value,
    sitemaps: cappedSitemaps.kept,
    sitemapCount: cappedSitemaps.count,
    referringUrls: cappedReferring.kept,
    referringUrlCount: cappedReferring.count,
  };
}

function parseAmp(value: unknown): { ok: true; value: AmpStatus | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isRecord(value)) return { ok: false };
  const verdict = requiredString(value, 'verdict');
  const robotsTxtState = requiredString(value, 'robotsTxtState');
  const indexingState = requiredString(value, 'indexingState');
  const ampIndexStatusVerdict = requiredString(value, 'ampIndexStatusVerdict');
  const pageFetchState = requiredString(value, 'pageFetchState');
  if (
    verdict === null ||
    robotsTxtState === null ||
    indexingState === null ||
    ampIndexStatusVerdict === null ||
    pageFetchState === null
  ) {
    return { ok: false };
  }
  const ampUrl = optionalString(value, 'ampUrl');
  const lastCrawlTime = optionalString(value, 'lastCrawlTime');
  if (!ampUrl.ok || !lastCrawlTime.ok) return { ok: false };
  const issues = readIssues(value.issues);
  if (issues === null) return { ok: false };
  const capped = cap(issues);
  return {
    ok: true,
    value: {
      verdict,
      ampUrl: ampUrl.value,
      robotsTxtState,
      indexingState,
      ampIndexStatusVerdict,
      lastCrawlTime: lastCrawlTime.value,
      pageFetchState,
      issues: capped.kept,
      issueCount: capped.count,
    },
  };
}

function readRichItems(value: unknown): RichResultItem[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const items: RichResultItem[] = [];
  for (const detected of value) {
    if (!isRecord(detected) || typeof detected.richResultType !== 'string') return null;
    const nested = detected.items === undefined || detected.items === null ? [] : detected.items;
    if (!Array.isArray(nested)) return null;
    for (const item of nested) {
      if (!isRecord(item) || typeof item.name !== 'string') return null;
      const issues = readIssues(item.issues);
      if (issues === null) return null;
      items.push({ type: detected.richResultType, name: item.name, issues });
    }
  }
  return items;
}

function parseRich(value: unknown): { ok: true; value: Inspection['richResults'] } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isRecord(value) || typeof value.verdict !== 'string') return { ok: false };
  const items = readRichItems(value.detectedItems);
  if (items === null) return { ok: false };
  const capped = cap(items);
  return { ok: true, value: { verdict: value.verdict, items: capped.kept, itemCount: capped.count } };
}

function parseInspection(json: unknown): ToolResult<Inspection> {
  if (!isRecord(json) || !isRecord(json.inspectionResult)) return badResponse();
  const result = json.inspectionResult;
  const inspectionResultLink = requiredString(result, 'inspectionResultLink');
  if (inspectionResultLink === null) return badResponse();
  const index = parseIndex(result.indexStatusResult);
  if (index === null) return badResponse();
  const amp = parseAmp(result.ampResult);
  if (!amp.ok) return badResponse();
  const richResults = parseRich(result.richResultsResult);
  if (!richResults.ok) return badResponse();
  return {
    ok: true,
    value: { inspectionResultLink, index, amp: amp.value, richResults: richResults.value },
  };
}

async function queryInspection(deps: ConsoleDeps, raw: unknown): Promise<ToolResult<Inspection>> {
  const parsed = inspectUrlSchema.safeParse(raw);
  if (!parsed.success) return invalidArgs(issueMessage(parsed.error.issues));
  const siteUrl = isSiteUrl(parsed.data.siteUrl) ? parsed.data.siteUrl : null;
  const inspectionUrl = isInspectionUrl(parsed.data.inspectionUrl) ? parsed.data.inspectionUrl : null;
  if (siteUrl === null || inspectionUrl === null) {
    return invalidArgs('Use an absolute http or https inspectionUrl with no username, password, or port.');
  }
  if (!urlBelongsToProperty(siteUrl, inspectionUrl)) {
    return {
      ok: false,
      code: 'not_in_property',
      message: 'inspectionUrl is not under siteUrl. Pass a siteUrl from list_sites.',
    };
  }
  const body: { inspectionUrl: InspectionUrl; siteUrl: SiteUrl; languageCode?: string } = { inspectionUrl, siteUrl };
  if (parsed.data.languageCode !== undefined) body.languageCode = parsed.data.languageCode;
  const sent = await send(deps, { method: 'POST', url: INSPECT_URL, body });
  if (!sent.ok) return sent;
  return parseInspection(sent.value);
}

function sitemapsUrl(site: SiteUrl, sitemapIndex: string | undefined): string {
  const base = `${siteResourceUrl(site)}/sitemaps`;
  if (sitemapIndex === undefined) return base;
  return `${base}?sitemapIndex=${encodeURIComponent(sitemapIndex)}`;
}

function sitemapResourceUrl(site: SiteUrl, path: SitemapUrl): string {
  return `${siteResourceUrl(site)}/sitemaps/${encodeURIComponent(path)}`;
}

function parseContents(value: unknown): SitemapContent[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const contents: SitemapContent[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const entryType = optionalString(entry, 'type');
    if (!entryType.ok) return null;
    const submitted = countField(entry, 'submitted');
    const indexed = countField(entry, 'indexed');
    if (submitted === null || indexed === null) return null;
    contents.push({ type: entryType.value, submitted, indexed });
  }
  return contents;
}

function parseSitemap(value: unknown): Sitemap | null {
  if (!isRecord(value) || typeof value.path !== 'string') return null;
  const type = optionalString(value, 'type');
  if (!type.ok) return null;
  if (typeof value.isPending !== 'boolean' || typeof value.isSitemapsIndex !== 'boolean') return null;
  const warnings = countField(value, 'warnings');
  const errors = countField(value, 'errors');
  if (warnings === null || errors === null) return null;
  const lastSubmitted = optionalString(value, 'lastSubmitted');
  const lastDownloaded = optionalString(value, 'lastDownloaded');
  if (!lastSubmitted.ok || !lastDownloaded.ok) return null;
  const contents = parseContents(value.contents);
  if (contents === null) return null;
  return {
    path: value.path,
    lastSubmitted: lastSubmitted.value,
    lastDownloaded: lastDownloaded.value,
    isPending: value.isPending,
    isSitemapsIndex: value.isSitemapsIndex,
    type: type.value,
    warnings,
    errors,
    contents,
  };
}

function parseSitemapList(json: unknown): ToolResult<SitemapList> {
  if (!isRecord(json)) return badResponse();
  if (json.sitemap === undefined) return { ok: true, value: { sitemaps: [] } };
  if (!Array.isArray(json.sitemap)) return badResponse();
  const sitemaps: Sitemap[] = [];
  for (const entry of json.sitemap) {
    const sitemap = parseSitemap(entry);
    if (sitemap === null) return badResponse();
    sitemaps.push(sitemap);
  }
  return { ok: true, value: { sitemaps } };
}

async function querySitemaps(deps: ConsoleDeps, raw: unknown): Promise<ToolResult<SitemapList>> {
  const parsed = listSitemapsSchema.safeParse(raw);
  if (!parsed.success) return invalidArgs(issueMessage(parsed.error.issues));
  if (!isSiteUrl(parsed.data.siteUrl)) return invalidArgs('Check siteUrl.');
  const sent = await send(deps, { method: 'GET', url: sitemapsUrl(parsed.data.siteUrl, parsed.data.sitemapIndex) });
  if (!sent.ok) return sent;
  return parseSitemapList(sent.value);
}

function googleErrorMessage(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !isRecord(parsed.error) || typeof parsed.error.message !== 'string') return null;
    if (parsed.error.message === '') return null;
    return parsed.error.message.slice(0, ERROR_MESSAGE_LIMIT);
  } catch {
    return null;
  }
}

function transportFailure(): ToolResult<never> {
  return {
    ok: false,
    code: 'google_http',
    message: 'The Search Console request failed before a response. Retry the call.',
  };
}

function statusFailure(response: WireResponse): ToolResult<never> | null {
  if (response.status >= 200 && response.status < 300) return null;
  const detail = googleErrorMessage(response.text);
  const suffix = detail === null ? '' : `: ${detail}`;
  return {
    ok: false,
    code: 'google_http',
    message: `Google Search Console returned HTTP ${response.status}${suffix}. Retry the call.`,
  };
}

function parseJsonBody(response: WireResponse | null): ToolResult<unknown> {
  if (response === null) return transportFailure();
  const failed = statusFailure(response);
  if (failed !== null) return failed;
  try {
    const value: unknown = JSON.parse(response.text);
    return { ok: true, value };
  } catch {
    return badResponse();
  }
}

function parseEmptyBody(response: WireResponse | null): ToolResult<EmptyBody> {
  if (response === null) return transportFailure();
  const failed = statusFailure(response);
  if (failed !== null) return failed;
  if (response.text !== '') return badResponse();
  return { ok: true, value: { kind: 'empty' } };
}

function parseDeleteBody(response: WireResponse | null): ToolResult<DeleteBody> {
  if (response === null) return transportFailure();
  // A missing property or sitemap is a completed delete. A missing PUT target is not.
  if (response.status === 404) return { ok: true, value: { kind: 'absent' } };
  return parseEmptyBody(response);
}

function interpret(method: UnsignedRequest['method'], response: WireResponse | null): ToolResult<unknown> {
  switch (method) {
    case 'GET':
    case 'POST':
      return parseJsonBody(response);
    case 'PUT':
      return parseEmptyBody(response);
    case 'DELETE':
      return parseDeleteBody(response);
    default: {
      const exhaustive: never = method;
      return exhaustive;
    }
  }
}

function signed(request: UnsignedRequest, authorization: string): WireRequest {
  switch (request.method) {
    case 'GET':
      return { method: 'GET', url: request.url, authorization };
    case 'POST':
      return { method: 'POST', url: request.url, body: request.body, authorization };
    case 'PUT':
      return { method: 'PUT', url: request.url, authorization };
    case 'DELETE':
      return { method: 'DELETE', url: request.url, authorization };
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

async function callHttp(http: Http, request: WireRequest): Promise<WireResponse | null> {
  try {
    const response = await http(request);
    logStatus(request.method, request.url, response.status);
    return response;
  } catch {
    return null;
  }
}

function send(deps: ConsoleDeps, request: Extract<UnsignedRequest, { method: 'GET' | 'POST' }>): Promise<ToolResult<unknown>>;
function send(deps: ConsoleDeps, request: Extract<UnsignedRequest, { method: 'PUT' }>): Promise<ToolResult<EmptyBody>>;
function send(deps: ConsoleDeps, request: Extract<UnsignedRequest, { method: 'DELETE' }>): Promise<ToolResult<DeleteBody>>;
async function send(deps: ConsoleDeps, request: UnsignedRequest): Promise<ToolResult<unknown>> {
  const http = deps.http ?? nodeHttp;
  const firstToken = await deps.tokens.accessToken();
  if (!firstToken.ok) return { ok: false, code: 'not_logged_in', message: firstToken.message };
  const first = await callHttp(http, signed(request, `Bearer ${firstToken.token}`));
  if (first !== null && first.status === 401) {
    const secondToken = await deps.tokens.refresh();
    if (!secondToken.ok) return { ok: false, code: 'not_logged_in', message: secondToken.message };
    const second = await callHttp(http, signed(request, `Bearer ${secondToken.token}`));
    if (second !== null && second.status === 401) {
      return { ok: false, code: 'not_logged_in', message: deps.tokens.loginHint() };
    }
    return interpret(request.method, second);
  }
  return interpret(request.method, first);
}

async function nodeHttp(request: WireRequest): Promise<WireResponse> {
  const headers = new Headers();
  headers.set('authorization', request.authorization);
  const init: RequestInit = { method: request.method, headers };
  switch (request.method) {
    case 'GET':
    case 'PUT':
    case 'DELETE':
      break;
    case 'POST':
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(request.body);
      break;
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
  const response = await fetch(request.url, init);
  return { status: response.status, text: await response.text() };
}

function removalOutcome(body: DeleteBody): RemovalOutcome {
  switch (body.kind) {
    case 'empty':
      return 'removed';
    case 'absent':
      return 'already_absent';
    default: {
      const exhaustive: never = body;
      return exhaustive;
    }
  }
}

function parseSiteWrite(raw: unknown): ToolResult<SiteUrl> {
  const parsed = siteWriteSchema.safeParse(raw);
  if (!parsed.success) return invalidArgs(issueMessage(parsed.error.issues));
  if (!isSiteUrl(parsed.data.siteUrl)) return invalidArgs('Check siteUrl.');
  return { ok: true, value: parsed.data.siteUrl };
}

function parseSitemapWrite(raw: unknown): ToolResult<{ siteUrl: SiteUrl; path: SitemapUrl }> {
  const parsed = sitemapWriteSchema.safeParse(raw);
  if (!parsed.success) return invalidArgs(issueMessage(parsed.error.issues));
  if (!isSiteUrl(parsed.data.siteUrl)) return invalidArgs('Check siteUrl.');
  if (!isSitemapUrl(parsed.data.path)) return invalidArgs(SITEMAP_PATH_MESSAGE);
  return { ok: true, value: { siteUrl: parsed.data.siteUrl, path: parsed.data.path } };
}

async function addSite(deps: ConsoleDeps, raw: unknown): Promise<ToolResult<AddedSite>> {
  const parsed = parseSiteWrite(raw);
  if (!parsed.ok) return parsed;
  const sent = await send(deps, { method: 'PUT', url: siteResourceUrl(parsed.value) });
  if (!sent.ok) return sent;
  return { ok: true, value: { siteUrl: parsed.value } };
}

async function removeSite(deps: ConsoleDeps, raw: unknown): Promise<ToolResult<RemovedSite>> {
  const parsed = parseSiteWrite(raw);
  if (!parsed.ok) return parsed;
  const sent = await send(deps, { method: 'DELETE', url: siteResourceUrl(parsed.value) });
  if (!sent.ok) return sent;
  return { ok: true, value: { siteUrl: parsed.value, outcome: removalOutcome(sent.value) } };
}

async function submitSitemap(deps: ConsoleDeps, raw: unknown): Promise<ToolResult<SubmittedSitemap>> {
  const parsed = parseSitemapWrite(raw);
  if (!parsed.ok) return parsed;
  const sent = await send(deps, { method: 'PUT', url: sitemapResourceUrl(parsed.value.siteUrl, parsed.value.path) });
  if (!sent.ok) return sent;
  return { ok: true, value: { siteUrl: parsed.value.siteUrl, path: parsed.value.path } };
}

async function removeSitemap(deps: ConsoleDeps, raw: unknown): Promise<ToolResult<RemovedSitemap>> {
  const parsed = parseSitemapWrite(raw);
  if (!parsed.ok) return parsed;
  const sent = await send(deps, {
    method: 'DELETE',
    url: sitemapResourceUrl(parsed.value.siteUrl, parsed.value.path),
  });
  if (!sent.ok) return sent;
  return {
    ok: true,
    value: { siteUrl: parsed.value.siteUrl, path: parsed.value.path, outcome: removalOutcome(sent.value) },
  };
}

function logStatus(method: string, url: string, status: number): void {
  console.error(method, url, status);
}

export function toolCatalog(deps: ConsoleDeps): Catalog {
  return {
    list_sites: {
      description: LIST_SITES_DESCRIPTION,
      inputSchema: listSitesSchema,
      async run(args: unknown) {
        const parsed = listSitesSchema.safeParse(args);
        if (!parsed.success) return invalidArgs(issueMessage(parsed.error.issues));
        return querySites(deps);
      },
    },
    search_analytics: {
      description: SEARCH_ANALYTICS_DESCRIPTION,
      inputSchema: searchAnalyticsSchema,
      run(args: unknown) {
        return queryAnalytics(deps, args);
      },
    },
    inspect_url: {
      description: INSPECT_URL_DESCRIPTION,
      inputSchema: inspectUrlSchema,
      run(args: unknown) {
        return queryInspection(deps, args);
      },
    },
    list_sitemaps: {
      description: LIST_SITEMAPS_DESCRIPTION,
      inputSchema: listSitemapsSchema,
      run(args: unknown) {
        return querySitemaps(deps, args);
      },
    },
    add_site: {
      description: ADD_SITE_DESCRIPTION,
      inputSchema: siteWriteSchema,
      run(args: unknown) {
        return addSite(deps, args);
      },
    },
    remove_site: {
      description: REMOVE_SITE_DESCRIPTION,
      inputSchema: siteWriteSchema,
      run(args: unknown) {
        return removeSite(deps, args);
      },
    },
    submit_sitemap: {
      description: SUBMIT_SITEMAP_DESCRIPTION,
      inputSchema: sitemapWriteSchema,
      run(args: unknown) {
        return submitSitemap(deps, args);
      },
    },
    remove_sitemap: {
      description: REMOVE_SITEMAP_DESCRIPTION,
      inputSchema: sitemapWriteSchema,
      run(args: unknown) {
        return removeSitemap(deps, args);
      },
    },
  };
}
