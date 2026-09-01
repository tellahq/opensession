/**
 * Config-declared feeds — the feeds design W3, "any MCP is a project".
 *
 * A feed/project defined as data instead of code: which MCP server backs it,
 * which tool lists its items and how fields map onto FeedItem, and (optional)
 * a web-panel template for the workspace tab. Stored in
 * ~/.opensession-feeds.json; the feeds registry overlays these beside the
 * code feeds (the video feed stays the code-feed reference implementation until it,
 * too, migrates to an entry here).
 *
 * Example entry:
 * {
 *   "id": "video-library", "title": "Video library", "refKind": "video-library", "tileBg": "#625df5",
 *   "mcpServers": ["video-library"],
 *   "items": {
 *     "server": "video-library", "tool": "list_videos", "args": { "limit": 30 },
 *     "path": "videos",
 *     "map": { "id": "id", "title": "name", "preview": "description",
 *              "ts": "updatedAt", "url": "links.viewPage" }
 *   },
 *   "panel": {
 *     "label": "Video",
 *     "embedUrlTemplate": "https://www.video-library.com/embed/{id}",
 *     "links": [{ "label": "Open", "hrefTemplate": "https://www.video-library.com/share/{id}" }]
 *   }
 * }
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { statePath } from "./paths";

const STORE_PATH = statePath(".opensession-feeds.json");

export interface FeedPanelSpec {
  /** Tab label ("Video", "Conversation", …). */
  label: string;
  /** Custom frontend component key (e.g. "slack-channel") instead of an
   *  iframe — the panel registry in FeedWebPane.tsx maps it. */
  component?: string;
  /** Iframe URL; `{id}` is replaced with the item id. */
  embedUrlTemplate?: string;
  /** Header links; `{id}` replaced likewise. */
  links?: { label: string; hrefTemplate: string }[];
}

/** Per-feed session context: called with the item id at session start and
 *  injected into the opening prompt. String arg values get `{id}` replaced
 *  with the item id (works inside exec-style command strings too). */
export interface FeedContextSpec {
  server: string;
  tool: string;
  args?: Record<string, unknown>;
  /** Injected excerpt cap (default 6000 chars). */
  maxChars?: number;
}

export interface ConfigFeed {
  id: string;
  title: string;
  refKind: string;
  tileBg?: string;
  /** MCP allowlist for sessions in this feed's workspaces. */
  mcpServers?: string[];
  items: {
    /** MCP server name in mcp-config.json. */
    server: string;
    /** Tool that lists the items. */
    tool: string;
    args?: Record<string, unknown>;
    /** Dot-path to the item array in the tool result ("" = result itself). */
    path?: string;
    /** FeedItem field → dot-path into each raw item. */
    map: {
      id: string;
      title: string;
      preview?: string;
      ts?: string;
      url?: string;
      thumbnail?: string;
    };
  };
  panel?: FeedPanelSpec;
  context?: FeedContextSpec;
  /** Band filter specs (same shape as FeedFilterSpec in feeds.ts). */
  filters?: unknown[];
}

export function readConfigFeeds(): ConfigFeed[] {
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    return Array.isArray(raw?.feeds) ? raw.feeds : [];
  } catch {
    return [];
  }
}

function writeConfigFeeds(feeds: ConfigFeed[]): void {
  writeFileSync(STORE_PATH, JSON.stringify({ feeds }, null, 2) + "\n", {
    mode: 0o600,
  });
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export function validateConfigFeed(
  input: unknown,
): ConfigFeed | { error: string } {
  const f = input as Partial<ConfigFeed>;
  if (!f || typeof f !== "object") return { error: "Invalid feed" };
  if (!f.id || !ID_RE.test(f.id)) return { error: "id must be a short slug" };
  if (!f.title?.trim()) return { error: "title required" };
  const refKind = (f.refKind || f.id).trim();
  if (!ID_RE.test(refKind)) return { error: "refKind must be a short slug" };
  const items = f.items;
  if (!items?.server?.trim() || !items?.tool?.trim())
    return { error: "items.server and items.tool required" };
  if (!items.map?.id || !items.map?.title)
    return { error: "items.map.id and items.map.title required" };
  return {
    id: f.id,
    title: f.title.trim(),
    refKind,
    ...(f.tileBg ? { tileBg: f.tileBg } : {}),
    ...(f.mcpServers?.length
      ? { mcpServers: f.mcpServers.map(String) }
      : { mcpServers: [items.server] }),
    items: {
      server: items.server.trim(),
      tool: items.tool.trim(),
      ...(items.args && typeof items.args === "object"
        ? { args: items.args }
        : {}),
      ...(items.path ? { path: String(items.path) } : {}),
      map: items.map,
    },
    ...(f.panel?.label && (f.panel?.embedUrlTemplate || f.panel?.component)
      ? {
          panel: {
            label: f.panel.label,
            ...(f.panel.component ? { component: f.panel.component } : {}),
            ...(f.panel.embedUrlTemplate
              ? { embedUrlTemplate: f.panel.embedUrlTemplate }
              : {}),
            ...(f.panel.links?.length ? { links: f.panel.links } : {}),
          },
        }
      : {}),
    ...(f.context?.server && f.context?.tool
      ? {
          context: {
            server: f.context.server,
            tool: f.context.tool,
            ...(f.context.args ? { args: f.context.args } : {}),
            ...(f.context.maxChars ? { maxChars: f.context.maxChars } : {}),
          },
        }
      : {}),
    ...(Array.isArray(f.filters) && f.filters.length
      ? { filters: f.filters }
      : {}),
  };
}

export function upsertConfigFeed(
  input: unknown,
): { ok: true } | { error: string } {
  const feed = validateConfigFeed(input);
  if ("error" in feed) return feed;
  const feeds = readConfigFeeds().filter((f) => f.id !== feed.id);
  feeds.push(feed);
  writeConfigFeeds(feeds);
  return { ok: true };
}

export function removeConfigFeed(id: string): { ok: true } | { error: string } {
  const feeds = readConfigFeeds();
  const next = feeds.filter((f) => f.id !== id);
  if (next.length === feeds.length) return { error: `No feed "${id}"` };
  writeConfigFeeds(next);
  return { ok: true };
}

/** `a.b.c` getter over a raw tool-result object. */
export function dotGet(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  let cur: any = obj;
  for (const seg of path.split(".")) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}
