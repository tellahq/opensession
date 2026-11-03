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
import { writeFile } from "fs/promises";
import { statePath } from "./paths";
import {
  cachedJsonFileCopy,
  loadJsonFileCopy,
  loadJsonFileShared,
  publishJsonFile,
} from "./shared/json-file-cache";

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

/** The loaded feeds file, without I/O. Loaded at import and refreshed in the
 * background, so a hand edit applies within a second without a restart. */
export function readConfigFeeds(): ConfigFeed[] {
  try {
    const raw = cachedJsonFileCopy<{ feeds?: unknown }>(STORE_PATH);
    return Array.isArray(raw?.feeds) ? (raw.feeds as ConfigFeed[]) : [];
  } catch {
    return [];
  }
}

async function readConfigFeedsFresh(): Promise<ConfigFeed[]> {
  try {
    const raw = await loadJsonFileCopy<{ feeds?: unknown }>(STORE_PATH);
    return Array.isArray(raw?.feeds) ? (raw.feeds as ConfigFeed[]) : [];
  } catch {
    return [];
  }
}

async function writeConfigFeeds(feeds: ConfigFeed[]): Promise<void> {
  const value = { feeds };
  await writeFile(STORE_PATH, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  publishJsonFile(STORE_PATH, value);
}

// Read-modify-write cycles span awaits; one at a time so two concurrent
// edits cannot drop each other's change.
let mutation: Promise<unknown> = Promise.resolve();
function mutateFeeds<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutation.then(fn, fn);
  mutation = run.catch(() => {});
  return run;
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

export async function upsertConfigFeed(
  input: unknown,
): Promise<{ ok: true } | { error: string }> {
  const feed = validateConfigFeed(input);
  if ("error" in feed) return feed;
  return mutateFeeds(async () => {
    const feeds = (await readConfigFeedsFresh()).filter(
      (f) => f.id !== feed.id,
    );
    feeds.push(feed);
    await writeConfigFeeds(feeds);
    return { ok: true as const };
  });
}

export function removeConfigFeed(
  id: string,
): Promise<{ ok: true } | { error: string }> {
  return mutateFeeds(async () => {
    const feeds = await readConfigFeedsFresh();
    const next = feeds.filter((f) => f.id !== id);
    if (next.length === feeds.length) return { error: `No feed "${id}"` };
    await writeConfigFeeds(next);
    return { ok: true as const };
  });
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

await loadJsonFileShared(STORE_PATH).catch(() => undefined);
