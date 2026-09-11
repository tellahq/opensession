/**
 * `opensession-charts` — the feedback loop for ```vega-lite fences.
 *
 * A chart in a transcript is a Vega-Lite spec in a fence; the web client
 * renders it live (frontend/lib/vega-chart.ts). Nothing here is needed to
 * draw one. What the fence cannot do is say why it did not draw: like a
 * mermaid fence, a spec that fails to compile stays a code block, and a
 * spec with ten thousand rows inline is a transcript nobody can scroll. So
 * `make_chart` compiles the same spec with the same library, reports errors
 * and warnings with the paths vega-lite gives, moves big data into a session
 * asset the client's loader is allowed to fetch, and returns the fence to
 * paste.
 *
 * Held to the automation in-process bar, so automations carry it too: the
 * only write is to the calling session's own asset storage (the same place
 * opensession-report writes), nothing is read, and no path, URL or command is
 * accepted. External URLs in a spec are rejected here because the client
 * refuses to load them anyway.
 */

import type { LoggerInterface } from "vega";
import { compile, type TopLevelSpec } from "vega-lite";
import { z } from "zod";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import { writeAsset } from "./session-assets";

/** A spec bigger than this is not a chart, whatever else it is. */
export const MAX_SPEC_BYTES = 512 * 1024;
/** Inline data past this leaves the transcript for a session asset. */
export const INLINE_DATA_LIMIT = 48 * 1024;
/** Where offloaded data lands in the session's assets. */
export const CHART_ASSET_DIR = "charts";

const ASSET_URL_RE = /^\/api\/sessions\/[^/?#]+\/assets\/raw\/[^?#]+/;

type Json = Record<string, unknown>;

export type ChartResult =
  | {
      ok: true;
      /** The fence, ready to paste into a reply. */
      fence: string;
      warnings: string[];
      /** Asset path the data was moved to, when it was. */
      dataAsset?: string;
    }
  | { ok: false; errors: string[] };

/** The raw route the client's loader accepts, for an asset of `sessionId`. */
export function chartAssetUrl(sessionId: string, path: string): string {
  const rel = path.split("/").map(encodeURIComponent).join("/");
  return `/api/sessions/${encodeURIComponent(sessionId)}/assets/raw/${rel}`;
}

function isObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Every `url` a spec would load, with the path it sits at. */
function urlsIn(node: unknown, at = "$", found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((item, i) => urlsIn(item, `${at}[${i}]`, found));
  } else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "url" && typeof value === "string")
        found.push(`${at}.url = ${value}`);
      else urlsIn(value, `${at}.${key}`, found);
    }
  }
  return found;
}

/**
 * The fence body: the spec pretty-printed, except that each data row stays
 * on one line. Pretty rows at two-space indent turn fifty rows into five
 * hundred lines, and the point of the fence is that a person can still read
 * the spec around them.
 */
export function formatChartFence(spec: Json): string {
  const rows = new Map<string, unknown[]>();
  const pluck = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(pluck);
    if (!isObject(node)) return node;
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "values" && Array.isArray(value)) {
        const token = `\u0000rows${rows.size}\u0000`;
        rows.set(token, value);
        out[key] = token;
      } else out[key] = pluck(value);
    }
    return out;
  };
  let text = JSON.stringify(pluck(spec), null, 2);
  for (const [token, values] of rows) {
    const indent = /^([ \t]*)"values": /m.exec(
      text.slice(0, text.indexOf(JSON.stringify(token))),
    );
    const pad = "  ".repeat((indent?.[1].length ?? 0) / 2 + 1);
    const body =
      values.length === 0
        ? "[]"
        : `[\n${values.map((row) => pad + JSON.stringify(row)).join(",\n")}\n${pad.slice(2)}]`;
    text = text.replace(JSON.stringify(token), body);
  }
  return "```vega-lite\n" + text + "\n```";
}

/** Collects what vega-lite says while compiling; a spec it rejects throws,
 *  a spec it merely dislikes warns here. */
class CapturingLogger implements LoggerInterface {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  level(): number;
  level(_: number): this;
  level(_?: number): number | this {
    return _ === undefined ? 0 : this;
  }
  error(...args: readonly unknown[]): this {
    this.errors.push(args.map(String).join(" "));
    return this;
  }
  warn(...args: readonly unknown[]): this {
    this.warnings.push(args.map(String).join(" "));
    return this;
  }
  info(): this {
    return this;
  }
  debug(): this {
    return this;
  }
}

function slugify(name: string | undefined): string {
  const slug = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "chart";
}

interface MakeChartDeps {
  writeAsset: (
    sessionId: string,
    path: string,
    data: Buffer,
    description?: string,
  ) => Promise<unknown>;
  now?: () => number;
}

export async function makeChart(
  input: {
    sessionId: string;
    spec: unknown;
    data?: unknown[];
    title?: string;
    name?: string;
  },
  deps: MakeChartDeps = { writeAsset },
): Promise<ChartResult> {
  let spec: unknown = input.spec;
  if (typeof spec === "string") {
    try {
      spec = JSON.parse(spec);
    } catch (error) {
      return {
        ok: false,
        errors: [`spec is not valid JSON: ${(error as Error).message}`],
      };
    }
  }
  if (!isObject(spec))
    return { ok: false, errors: ["spec must be a Vega-Lite JSON object."] };
  spec = { ...spec };
  const chart = spec as Json;
  if (input.data) chart.data = { values: input.data };
  if (input.title && chart.title === undefined) chart.title = input.title;
  delete chart.$schema;

  const size = Buffer.byteLength(JSON.stringify(chart));
  if (size > MAX_SPEC_BYTES)
    return {
      ok: false,
      errors: [
        `spec is ${Math.round(size / 1024)} KB; the limit is ${MAX_SPEC_BYTES / 1024} KB. Aggregate the data before charting it.`,
      ],
    };

  const errors: string[] = [];
  for (const url of urlsIn(chart)) {
    const value = url.slice(url.indexOf(" = ") + 3);
    if (!ASSET_URL_RE.test(value))
      errors.push(
        `${url}: charts load only this session's assets (/api/sessions/<id>/assets/raw/…). Put the data in \`data.values\` or the \`data\` argument instead.`,
      );
  }
  if (errors.length) return { ok: false, errors };

  const logger = new CapturingLogger();
  try {
    // The spec is untrusted JSON; vega-lite validates the grammar itself and
    // throws on what it cannot compile, which is the result reported here.
    compile(chart as unknown as TopLevelSpec, { logger });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  errors.push(...logger.errors);
  if (errors.length) return { ok: false, errors };
  const warnings = logger.warnings;

  let dataAsset: string | undefined;
  const data = chart.data;
  if (
    size > INLINE_DATA_LIMIT &&
    isObject(data) &&
    Array.isArray(data.values)
  ) {
    const stamp = (deps.now ?? Date.now)().toString(36);
    dataAsset = `${CHART_ASSET_DIR}/${slugify(input.name ?? input.title)}-${stamp}.json`;
    await deps.writeAsset(
      input.sessionId,
      dataAsset,
      Buffer.from(JSON.stringify(data.values)),
      `Data for the ${input.title ?? input.name ?? "chart"} chart`,
    );
    const { values: _values, ...rest } = data;
    chart.data = { ...rest, url: chartAssetUrl(input.sessionId, dataAsset) };
  }
  if (Buffer.byteLength(JSON.stringify(chart)) > INLINE_DATA_LIMIT)
    return {
      ok: false,
      errors: [
        `the spec is still over ${INLINE_DATA_LIMIT / 1024} KB without its top-level data. Move layered or nested datasets to the top-level \`data\` so they can be offloaded, or aggregate first.`,
      ],
    };
  return { ok: true, fence: formatChartFence(chart), warnings, dataAsset };
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function createChartsMcpServer(
  ctx: { sessionId: string },
  deps?: MakeChartDeps,
) {
  const tools = [
    tool(
      "make_chart",
      "Turn a Vega-Lite spec into the ```vega-lite fence that renders as an interactive chart (tooltips, zoom, brushing) in this session. Compiles the spec with the same library the client uses and returns errors with their paths instead of a silent code block; large inline data is moved to a session asset the chart loads from. Paste the returned fence verbatim into your reply, on its own lines. Keep specs small and readable: aggregate first, use `data.values` (or the data argument) rather than external URLs, and omit width so the chart fills the column.",
      {
        spec: z
          .union([z.record(z.string(), z.unknown()), z.string()])
          .describe(
            "The Vega-Lite spec (JSON object or JSON string). `data.values` holds inline rows unless `data` is given separately.",
          ),
        data: z
          .array(z.unknown())
          .optional()
          .describe(
            "Rows for the chart, set as `data.values`. Convenient when the spec is authored without data.",
          ),
        title: z
          .string()
          .optional()
          .describe("Chart title, used when the spec has none."),
        name: z
          .string()
          .optional()
          .describe(
            "Short name for the data asset if the rows are offloaded (default: derived from the title).",
          ),
      },
      async (args) => {
        const result = await makeChart(
          { sessionId: ctx.sessionId, ...args },
          deps,
        );
        if (!result.ok)
          return text(
            `The spec did not compile. Fix these and try again:\n- ${result.errors.join("\n- ")}`,
          );
        const notes: string[] = [];
        if (result.dataAsset)
          notes.push(
            `Data (${args.data?.length ?? "inline"} rows) was saved to the session asset ${result.dataAsset}; the fence loads it from there.`,
          );
        if (result.warnings.length)
          notes.push(`Warnings:\n- ${result.warnings.join("\n- ")}`);
        return text(
          [
            "Compiled. Paste this fence into your reply exactly as returned:",
            "",
            result.fence,
            ...(notes.length ? ["", ...notes] : []),
          ].join("\n"),
        );
      },
    ),
  ];
  return createSdkMcpServer({
    name: "opensession-charts",
    version: "1.0.0",
    tools,
  });
}
