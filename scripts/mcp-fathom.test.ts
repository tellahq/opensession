import { describe, expect, test } from "bun:test";
import { delta, FathomClient, parseNumeric, previousRange, sanitizeError, tools, validateRange } from "./mcp-fathom";

const site = { id: "ABC123", name: "Example", timezone: "America/New_York" };
const totals = [{ visits: "10", uniques: "8", pageviews: "20", avg_duration: "12.5", bounce_rate: "40.25" }];
const trend = [{ timestamp: "2026-08-01 00:00:00", visits: "10", uniques: "8", pageviews: "20", avg_duration: "12.5", bounce_rate: "40.25" }];

function json(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function mockClient(handler: (url: URL, init: RequestInit) => Response | Promise<Response>, options: Record<string, unknown> = {}) {
  return new FathomClient("test-token-never-real", "ABC123", { fetch: ((input: string | URL | Request, init?: RequestInit) => handler(new URL(String(input)), init ?? {})) as typeof fetch, ...options });
}

describe("Fathom MCP contracts", () => {
  test("publishes four strictly closed tools", () => {
    expect(tools.map((tool) => tool.name)).toEqual(["list_sites", "traffic_summary", "traffic_breakdown", "current_visitors"]);
    expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
  });

  test("validates Gregorian dates, ordering, and range cap", () => {
    expect(validateRange("2024-02-29", "2024-03-01")).toEqual({ from: "2024-02-29", to: "2024-03-01" });
    expect(() => validateRange("2023-02-29", "2023-03-01")).toThrow("not a valid date");
    expect(() => validateRange("2024-03-02", "2024-03-01")).toThrow("must not be after");
    expect(() => validateRange("2024-01-01", "2025-01-01")).toThrow("cannot exceed 366");
  });

  test("computes deterministic prior periods and clamps leap day", () => {
    expect(previousRange({ from: "2026-08-10", to: "2026-08-16" }, "previous_period")).toEqual({ from: "2026-08-03", to: "2026-08-09" });
    expect(previousRange({ from: "2024-02-29", to: "2024-03-01" }, "previous_year")).toEqual({ from: "2023-02-28", to: "2023-03-01" });
  });

  test("parses finite numeric strings and preserves absent values", () => {
    expect(parseNumeric("12.50", "visits")).toBe(12.5);
    expect(parseNumeric(null, "visits")).toBeNull();
    expect(() => parseNumeric("NaN", "visits")).toThrow("invalid numeric");
    expect(() => parseNumeric("9007199254740992", "visits")).toThrow("out-of-range");
  });

  test("defines zero-baseline comparison semantics", () => {
    expect(delta(5, 0)).toEqual({ absolute: 5, percent: null, status: "new" });
    expect(delta(0, 0)).toEqual({ absolute: 0, percent: 0, status: "unchanged" });
    expect(delta(15, 10)).toEqual({ absolute: 5, percent: 50, status: "increase" });
  });
});

describe("FathomClient", () => {
  test("pins site lookup and uses only GET with bearer auth", async () => {
    let seen: { url: URL; init: RequestInit } | undefined;
    const client = mockClient((url, init) => { seen = { url, init }; return json(site); });
    expect(await client.call("list_sites", {})).toEqual({ sites: [site], pinned_site_id: "ABC123" });
    expect(seen?.url.toString()).toBe("https://api.usefathom.com/v1/sites/ABC123");
    expect(seen?.init.method).toBe("GET");
    expect((seen?.init.headers as Record<string, string>).Authorization).toBe("Bearer test-token-never-real");
    await expect(client.call("list_sites", { site_id: "OTHER" })).rejects.toThrow("Unexpected argument");
  });

  test("builds exact summary totals/trend queries and caches successful single-flight calls", async () => {
    const urls: string[] = [];
    let aggregationCalls = 0;
    const client = mockClient((url) => {
      urls.push(url.toString());
      if (url.pathname.endsWith("/sites/ABC123")) return json(site);
      aggregationCalls++;
      return json(url.searchParams.has("date_grouping") ? trend : totals);
    });
    const args = { date_from: "2026-08-01", date_to: "2026-08-07", granularity: "day" };
    const [first, second] = await Promise.all([client.call("traffic_summary", args), client.call("traffic_summary", args)]);
    expect(first).toEqual(second);
    expect(aggregationCalls).toBe(2);
    expect(urls.some((value) => value.includes("aggregates=visits%2Cuniques%2Cpageviews%2Cavg_duration%2Cbounce_rate") && value.includes("date_from=2026-08-01+00%3A00%3A00") && value.includes("date_to=2026-08-07+23%3A59%3A59"))).toBe(true);
    expect(urls.some((value) => value.includes("date_grouping=day"))).toBe(true);
  });

  test("builds safe breakdown grouping/filter and joins comparison ranks", async () => {
    const urls: URL[] = [];
    const client = mockClient((url) => {
      urls.push(url);
      if (url.pathname.endsWith("/sites/ABC123")) return json(site);
      if (url.searchParams.get("date_from")?.startsWith("2026-08-01")) return json([{ pathname: "/a", visits: "9" }, { pathname: "/new", visits: "3" }]);
      return json([{ pathname: "/a", visits: "6" }, { pathname: "/gone", visits: "2" }]);
    });
    const result = await client.call("traffic_breakdown", {
      date_from: "2026-08-01", date_to: "2026-08-07", dimension: "page", compare: "previous_period", path: "/pricing", limit: 10,
    }) as any;
    expect(result.rows[0]).toMatchObject({ key: "/a", rank: 1, value: 9, prior_rank: 1, prior_value: 6, absolute: 3, percent: 50 });
    expect(result.rows[1]).toMatchObject({ key: "/new", prior_rank: null, prior_value: null, absolute: null, percent: null, status: "unavailable" });
    expect(result.dropped).toEqual([{ key: "/gone", prior_rank: 2, prior_value: 2 }]);
    const report = urls.find((url) => url.pathname.endsWith("/aggregations"))!;
    expect(report.searchParams.get("field_grouping")).toBe("pathname");
    expect(report.searchParams.get("sort_by")).toBe("visits:desc");
    expect(JSON.parse(report.searchParams.get("filters")!)).toEqual([{ property: "pathname", operator: "is", value: "/pricing" }]);
  });

  test("retries only 429/503 and honors bounded Retry-After", async () => {
    let calls = 0;
    const waits: number[] = [];
    const client = mockClient(() => {
      calls++;
      if (calls < 3) return new Response("busy", { status: calls === 1 ? 429 : 503, headers: { "retry-after": calls === 1 ? "2" : "999" } });
      return json({ total: 4 });
    }, { sleep: async (milliseconds: number) => { waits.push(milliseconds); }, random: () => 0 });
    expect(await client.call("current_visitors", {})).toEqual({ total: 4 });
    expect(waits).toEqual([2000, 5000]);

    let unauthorizedCalls = 0;
    const unauthorized = mockClient(() => { unauthorizedCalls++; return new Response("no", { status: 401 }); });
    await expect(unauthorized.call("current_visitors", {})).rejects.toThrow("returned 401");
    expect(unauthorizedCalls).toBe(1);
  });

  test("does not cache failures and passes a timeout signal", async () => {
    let calls = 0;
    const client = mockClient((_url, init) => {
      calls++;
      expect(init.signal).toBeDefined();
      if (calls === 1) throw new DOMException("timed out with secret-token-abcdefghijklmnopqrstuvwxyz", "AbortError");
      return json({ total: 1 });
    });
    await expect(client.call("current_visitors", {})).rejects.toThrow("Fathom request failed");
    expect(await client.call("current_visitors", {})).toEqual({ total: 1 });
    expect(calls).toBe(2);
  });

  test("caps detailed live output and reports truncation", async () => {
    const content = Array.from({ length: 51 }, (_, index) => ({ hostname: "example.com", pathname: `/p${index}`, total: index }));
    const client = mockClient(() => json({ total: 51, content, referrers: [] }));
    const result = await client.call("current_visitors", { detailed: true }) as any;
    expect(result.content).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  test("rejects malformed payloads, invalid filters, and oversized trend combinations", async () => {
    const client = mockClient((url) => url.pathname.endsWith("/sites/ABC123") ? json(site) : json([{ visits: "oops" }]));
    await expect(client.call("traffic_breakdown", { date_from: "2026-08-01", date_to: "2026-08-02", dimension: "page", path: "not-a-path" })).rejects.toThrow("path must begin");
    await expect(client.call("traffic_summary", { date_from: "2026-01-01", date_to: "2026-01-08", granularity: "hour" })).rejects.toThrow("limited to 7 days");
  });

  test("redacts and truncates secrets in errors", () => {
    const secret = "abcdefghijklmnopqrstuvwxyz1234567890";
    const output = sanitizeError(new Error(`Authorization: Bearer ${secret} https://x.test?a=1&token=${secret} ${"x".repeat(400)}`));
    expect(output).not.toContain(secret);
    expect(output.length).toBeLessThanOrEqual(300);
  });
});
