#!/usr/bin/env bun

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE = "https://api.usefathom.com/v1";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SITE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AGGREGATES = [
  "visits",
  "uniques",
  "pageviews",
  "avg_duration",
  "bounce_rate",
] as const;
const BREAKDOWN_METRICS = ["visits", "uniques", "pageviews"] as const;
const GRANULARITIES = ["hour", "day", "month", "year"] as const;
const COMPARISONS = ["none", "previous_period", "previous_year"] as const;
const DIMENSIONS = {
  page: "pathname",
  entry_page: "entry_page",
  exit_page: "exit_page",
  referrer_domain: "referrer_hostname",
  referrer_source: "referrer_source",
  utm_campaign: "utm_campaign",
  utm_source: "utm_source",
  utm_medium: "utm_medium",
  utm_content: "utm_content",
  utm_term: "utm_term",
} as const;
const MAX_RANGE_DAYS = 366;
const MAX_TREND_BUCKETS = 400;
const MAX_CACHE_ENTRIES = 100;
const REQUEST_TIMEOUT_MS = 15_000;

type Args = Record<string, unknown>;
type DateRange = { from: string; to: string };
type Metric = (typeof AGGREGATES)[number];
type BreakdownMetric = (typeof BREAKDOWN_METRICS)[number];
type Comparison = (typeof COMPARISONS)[number];
type Dimension = keyof typeof DIMENSIONS;
type Fetch = typeof fetch;

type ClientOptions = {
  fetch?: Fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
};

const dateProperties = {
  date_from: {
    type: "string",
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    description: "First site-local calendar date, inclusive.",
  },
  date_to: {
    type: "string",
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    description: "Last site-local calendar date, inclusive.",
  },
  compare: { type: "string", enum: COMPARISONS, default: "none" },
} as const;

export const tools = [
  {
    name: "list_sites",
    description:
      "Return metadata for the single Fathom site pinned by FATHOM_SITE_ID.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "traffic_summary",
    description:
      "Return accurate traffic totals and a trend for an inclusive site-local date range, optionally compared with a prior period.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...dateProperties,
        granularity: { type: "string", enum: GRANULARITIES, default: "day" },
      },
      required: ["date_from", "date_to"],
    },
  },
  {
    name: "traffic_breakdown",
    description:
      "Return a bounded traffic breakdown by page, referrer, or campaign, optionally compared with a prior period.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...dateProperties,
        dimension: { type: "string", enum: Object.keys(DIMENSIONS) },
        metric: { type: "string", enum: BREAKDOWN_METRICS, default: "visits" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        path: {
          type: "string",
          minLength: 1,
          maxLength: 2048,
          description: "Optional exact pathname filter beginning with /.",
        },
      },
      required: ["date_from", "date_to", "dimension"],
    },
  },
  {
    name: "current_visitors",
    description:
      "Return the current visitor count and optionally top pages and referrers (capped at 50 each).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { detailed: { type: "boolean", default: false } },
    },
  },
] as const;

function oneOf<T extends readonly string[]>(
  value: unknown,
  values: T,
): value is T[number] {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}

function strictArgs(raw: unknown, allowed: readonly string[]): Args {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Arguments must be an object");
  const args = raw as Args;
  const unexpected = Object.keys(args).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`Unexpected argument: ${unexpected}`);
  return args;
}

function parseDate(value: unknown, name: string): Date {
  if (typeof value !== "string" || !DATE_RE.test(value))
    throw new Error(`${name} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw new Error(`${name} is not a valid date`);
  return date;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
function inclusiveDays(range: DateRange): number {
  return (
    Math.round(
      (parseDate(range.to, "date_to").getTime() -
        parseDate(range.from, "date_from").getTime()) /
        86_400_000,
    ) + 1
  );
}

export function validateRange(dateFrom: unknown, dateTo: unknown): DateRange {
  const from = parseDate(dateFrom, "date_from");
  const to = parseDate(dateTo, "date_to");
  if (from > to) throw new Error("date_from must not be after date_to");
  const range = { from: formatDate(from), to: formatDate(to) };
  if (inclusiveDays(range) > MAX_RANGE_DAYS)
    throw new Error(`Date range cannot exceed ${MAX_RANGE_DAYS} days`);
  return range;
}

function priorYear(value: string): string {
  const date = parseDate(value, "date");
  const year = date.getUTCFullYear() - 1;
  const month = date.getUTCMonth();
  const candidate = new Date(Date.UTC(year, month, date.getUTCDate()));
  return formatDate(
    candidate.getUTCMonth() === month
      ? candidate
      : new Date(Date.UTC(year, month + 1, 0)),
  );
}

export function previousRange(
  range: DateRange,
  comparison: Comparison,
): DateRange | null {
  if (comparison === "none") return null;
  if (comparison === "previous_year")
    return { from: priorYear(range.from), to: priorYear(range.to) };
  const previousTo = addDays(parseDate(range.from, "date_from"), -1);
  return {
    from: formatDate(addDays(previousTo, 1 - inclusiveDays(range))),
    to: formatDate(previousTo),
  };
}

export function parseNumeric(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    throw new Error(`Fathom returned an invalid numeric value for ${field}`);
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER)
    throw new Error(
      `Fathom returned an out-of-range numeric value for ${field}`,
    );
  return number;
}

export function delta(current: number | null, previous: number | null) {
  if (current === null || previous === null)
    return { absolute: null, percent: null, status: "unavailable" };
  if (previous === 0)
    return current === 0
      ? { absolute: 0, percent: 0, status: "unchanged" }
      : { absolute: current, percent: null, status: "new" };
  const absolute = current - previous;
  return {
    absolute,
    percent: (absolute / previous) * 100,
    status:
      absolute === 0 ? "unchanged" : absolute > 0 ? "increase" : "decrease",
  };
}

export function sanitizeError(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  text = text.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  text = text.replace(
    /([?&](?:token|key|api_key|access_token)=)[^&\s]+/gi,
    "$1[REDACTED]",
  );
  text = text.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[REDACTED]");
  return text.slice(0, 300);
}

function retryAfter(response: Response, now: number, fallback: number): number {
  const value = response.headers.get("retry-after");
  if (!value) return fallback;
  const seconds = Number(value);
  const requested = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Math.min(
    5_000,
    Math.max(0, Number.isFinite(requested) ? requested : fallback),
  );
}

class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= 2)
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    try {
      return await operation();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

type CacheEntry = { expiresAt: number; promise: Promise<unknown> };

export class FathomClient {
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly semaphore = new Semaphore();
  private site: { id: string; name: string; timezone: string } | null = null;

  constructor(
    private readonly token: string,
    private readonly siteId: string,
    options: ClientOptions = {},
  ) {
    if (!token) throw new Error("FATHOM_API_TOKEN is required");
    if (!SITE_ID_RE.test(siteId))
      throw new Error("FATHOM_SITE_ID must be a valid site ID");
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
    this.random = options.random ?? Math.random;
  }

  private async request(
    path: "/aggregations" | "/current_visitors" | `/sites/${string}`,
    params = new URLSearchParams(),
  ): Promise<unknown> {
    params.sort();
    const key = `${path}?${params}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return structuredClone(await cached.promise);
    }
    this.cache.delete(key);
    const ttl = path.startsWith("/sites/")
      ? 300_000
      : path === "/current_visitors"
        ? 10_000
        : 60_000;
    const promise = this.semaphore.run(async () => {
      const url = `${API_BASE}${path}${params.size ? `?${params}` : ""}`;
      let response: Response | undefined;
      let totalWait = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await this.fetch(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${this.token}`,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch (error) {
          throw new Error(`Fathom request failed: ${sanitizeError(error)}`);
        }
        if (![429, 503].includes(response.status) || attempt === 2) break;
        const fallback = 500 * 2 ** attempt + Math.floor(this.random() * 100);
        const wait = retryAfter(response, this.now(), fallback);
        if (totalWait + wait > 10_000)
          throw new Error(
            `Fathom API returned retryable status ${response.status}; retry budget exceeded`,
          );
        totalWait += wait;
        await this.sleep(wait);
      }
      if (!response?.ok) {
        const body = ((await response?.text().catch(() => "")) ?? "").slice(
          0,
          200,
        );
        throw new Error(
          `Fathom API returned ${response?.status ?? "no response"}${body ? `: ${sanitizeError(body)}` : ""}`,
        );
      }
      return response.json().catch(() => {
        throw new Error("Fathom returned invalid JSON");
      });
    });
    this.cache.set(key, { expiresAt: this.now() + ttl, promise });
    if (this.cache.size > MAX_CACHE_ENTRIES)
      this.cache.delete(this.cache.keys().next().value!);
    try {
      return structuredClone(await promise);
    } catch (error) {
      this.cache.delete(key);
      throw error;
    }
  }

  private async getSite() {
    if (this.site) return this.site;
    const raw = await this.request(`/sites/${encodeURIComponent(this.siteId)}`);
    if (!raw || typeof raw !== "object")
      throw new Error("Fathom returned invalid site metadata");
    const value = raw as Args;
    if (
      value.id !== this.siteId ||
      typeof value.name !== "string" ||
      typeof value.timezone !== "string"
    )
      throw new Error("Fathom returned invalid site metadata");
    this.site = {
      id: this.siteId,
      name: value.name.slice(0, 255),
      timezone: value.timezone.slice(0, 100),
    };
    return this.site;
  }

  private aggregation(
    range: DateRange,
    fields: Record<string, string>,
  ): Promise<unknown> {
    return this.request(
      "/aggregations",
      new URLSearchParams({
        entity: "pageview",
        entity_id: this.siteId,
        date_from: `${range.from} 00:00:00`,
        date_to: `${range.to} 23:59:59`,
        ...fields,
      }),
    );
  }

  async call(name: string, raw: unknown): Promise<unknown> {
    if (name === "list_sites") {
      strictArgs(raw, []);
      return { sites: [await this.getSite()], pinned_site_id: this.siteId };
    }
    if (name === "current_visitors") {
      const args = strictArgs(raw, ["detailed"]);
      if (args.detailed !== undefined && typeof args.detailed !== "boolean")
        throw new Error("detailed must be a boolean");
      const detailed = args.detailed === true;
      const value = await this.request(
        "/current_visitors",
        new URLSearchParams({
          site_id: this.siteId,
          detailed: String(detailed),
        }),
      );
      if (!value || typeof value !== "object")
        throw new Error("Fathom returned invalid current visitor data");
      const record = value as Args;
      const result: Args = {
        total: parseNumeric(String(record.total), "total"),
      };
      if (detailed) {
        const content = normalizeLiveRows(record.content, [
          "hostname",
          "pathname",
        ]);
        const referrers = normalizeLiveRows(record.referrers, [
          "referrer_hostname",
          "referrer_pathname",
        ]);
        result.content = content.rows;
        result.referrers = referrers.rows;
        result.truncated = content.truncated || referrers.truncated;
      }
      return result;
    }
    if (name === "traffic_summary") return this.summary(raw);
    if (name === "traffic_breakdown") return this.breakdown(raw);
    throw new Error(`Unknown tool: ${name}`);
  }

  private async summary(raw: unknown) {
    const args = strictArgs(raw, [
      "date_from",
      "date_to",
      "granularity",
      "compare",
    ]);
    const range = validateRange(args.date_from, args.date_to);
    const granularity = args.granularity ?? "day";
    if (!oneOf(granularity, GRANULARITIES))
      throw new Error(
        `granularity must be one of: ${GRANULARITIES.join(", ")}`,
      );
    if (granularity === "hour" && inclusiveDays(range) > 7)
      throw new Error("hour granularity is limited to 7 days");
    const estimated =
      granularity === "hour"
        ? inclusiveDays(range) * 24
        : granularity === "day"
          ? inclusiveDays(range)
          : granularity === "month"
            ? Math.ceil(inclusiveDays(range) / 28)
            : 2;
    if (estimated > MAX_TREND_BUCKETS)
      throw new Error(`Trend cannot exceed ${MAX_TREND_BUCKETS} buckets`);
    const compare = args.compare ?? "none";
    if (!oneOf(compare, COMPARISONS))
      throw new Error(`compare must be one of: ${COMPARISONS.join(", ")}`);
    const prior = previousRange(range, compare);
    const totalsFields = { aggregates: AGGREGATES.join(",") };
    const [site, totalsRaw, trendRaw, priorRaw] = await Promise.all([
      this.getSite(),
      this.aggregation(range, totalsFields),
      this.aggregation(range, { ...totalsFields, date_grouping: granularity }),
      prior ? this.aggregation(prior, totalsFields) : Promise.resolve(null),
    ]);
    const totals = normalizeMetrics(singleRow(totalsRaw, "summary"));
    const trend = arrayRows(trendRaw, "trend").map((row) => ({
      timestamp: stringField(row, "timestamp"),
      ...normalizeMetrics(row),
    }));
    const result: Args = {
      site,
      period: { ...range, timezone: site.timezone },
      totals,
      trend,
    };
    if (prior && priorRaw) {
      const previous = normalizeMetrics(singleRow(priorRaw, "comparison"));
      result.comparison = {
        kind: compare,
        period: prior,
        totals: previous,
        deltas: Object.fromEntries(
          AGGREGATES.map((metric) => [
            metric,
            delta(totals[metric], previous[metric]),
          ]),
        ),
      };
    }
    return result;
  }

  private async breakdown(raw: unknown) {
    const args = strictArgs(raw, [
      "date_from",
      "date_to",
      "dimension",
      "metric",
      "limit",
      "compare",
      "path",
    ]);
    const range = validateRange(args.date_from, args.date_to);
    if (typeof args.dimension !== "string" || !(args.dimension in DIMENSIONS))
      throw new Error(
        `dimension must be one of: ${Object.keys(DIMENSIONS).join(", ")}`,
      );
    const dimension = args.dimension as Dimension;
    const metric = args.metric ?? "visits";
    if (!oneOf(metric, BREAKDOWN_METRICS))
      throw new Error(`metric must be one of: ${BREAKDOWN_METRICS.join(", ")}`);
    const limit = integer(args.limit, "limit", 10, 100);
    const compare = args.compare ?? "none";
    if (!oneOf(compare, COMPARISONS))
      throw new Error(`compare must be one of: ${COMPARISONS.join(", ")}`);
    if (
      args.path !== undefined &&
      (typeof args.path !== "string" ||
        !args.path.startsWith("/") ||
        args.path.length > 2048)
    )
      throw new Error("path must begin with / and be at most 2048 characters");
    const prior = previousRange(range, compare);
    const field = DIMENSIONS[dimension];
    const fields: Record<string, string> = {
      aggregates: metric,
      field_grouping: field,
      sort_by: `${metric}:desc`,
      limit: String(limit),
    };
    if (args.path)
      fields.filters = JSON.stringify([
        { property: "pathname", operator: "is", value: args.path },
      ]);
    const [site, currentRaw, priorRaw] = await Promise.all([
      this.getSite(),
      this.aggregation(range, fields),
      prior ? this.aggregation(prior, fields) : Promise.resolve(null),
    ]);
    const current = normalizeRanking(currentRaw, field, metric, limit);
    const previous = priorRaw
      ? normalizeRanking(priorRaw, field, metric, limit)
      : [];
    const byKey = new Map(previous.map((row) => [row.key, row]));
    const rows = current.map((row) => {
      const before = byKey.get(row.key);
      byKey.delete(row.key);
      return {
        key: row.key,
        rank: row.rank,
        value: row.value,
        prior_rank: before?.rank ?? null,
        prior_value: before?.value ?? null,
        rank_delta: before ? before.rank - row.rank : null,
        ...delta(row.value, before?.value ?? null),
      };
    });
    return {
      site,
      period: { ...range, timezone: site.timezone },
      dimension,
      metric,
      rows,
      ...(prior
        ? {
            comparison: { kind: compare, period: prior },
            dropped: [...byKey.values()].slice(0, limit).map((row) => ({
              key: row.key,
              prior_rank: row.rank,
              prior_value: row.value,
            })),
          }
        : {}),
    };
  }
}

function integer(
  value: unknown,
  name: string,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > max
  )
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  return value as number;
}
function arrayRows(raw: unknown, name: string): Args[] {
  if (
    !Array.isArray(raw) ||
    raw.some((row) => !row || typeof row !== "object" || Array.isArray(row))
  )
    throw new Error(`Fathom returned an invalid ${name}`);
  return raw as Args[];
}
function singleRow(raw: unknown, name: string): Args {
  const rows = arrayRows(raw, name);
  if (rows.length !== 1) throw new Error(`Fathom returned an invalid ${name}`);
  return rows[0]!;
}
function stringField(row: Args, field: string): string {
  if (typeof row[field] !== "string")
    throw new Error(`Fathom returned an invalid ${field}`);
  return (row[field] as string).slice(0, 300);
}
function normalizeMetrics(row: Args): Record<Metric, number | null> {
  return Object.fromEntries(
    AGGREGATES.map((metric) => [metric, parseNumeric(row[metric], metric)]),
  ) as Record<Metric, number | null>;
}
function normalizeRanking(
  raw: unknown,
  field: string,
  metric: BreakdownMetric,
  limit: number,
) {
  return arrayRows(raw, "breakdown")
    .slice(0, limit)
    .map((row, index) => {
      const value = parseNumeric(row[metric], metric);
      if (value === null)
        throw new Error(`Fathom omitted ${metric} from a breakdown row`);
      return { key: stringField(row, field), rank: index + 1, value };
    });
}
function normalizeLiveRows(raw: unknown, fields: string[]) {
  if (!Array.isArray(raw)) return { rows: [], truncated: false };
  const rows = arrayRows(raw, "current visitor rows")
    .slice(0, 50)
    .map((row) =>
      Object.fromEntries([
        ...fields.map((field) => [field, stringField(row, field)]),
        ["total", parseNumeric(String(row.total), "total")],
      ]),
    );
  return { rows, truncated: raw.length > 50 };
}

export function createFathomServer(client: FathomClient): Server {
  const server = new Server(
    { name: "opensession-fathom", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await client.call(request.params.name, request.params.arguments),
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: sanitizeError(error) }],
        isError: true,
      };
    }
  });
  return server;
}

export async function startFathomServer(): Promise<void> {
  const client = new FathomClient(
    process.env.FATHOM_API_TOKEN ?? "",
    process.env.FATHOM_SITE_ID ?? "",
  );
  await createFathomServer(client).connect(new StdioServerTransport());
}

if (import.meta.main) {
  try {
    await startFathomServer();
  } catch (error) {
    console.error(`Fathom MCP configuration error: ${sanitizeError(error)}`);
    process.exitCode = 1;
  }
}
