/**
 * Feed registry: external-object feeds (videos; eventually Plain
 * tickets, any MCP/API) rendered as sidebar bands.
 *
 * A feed is a *project* in product terms — the non-git kind. A registered repo
 * (worktree.ts REPOS) is the other kind. Both are sources of work that own a
 * sidebar band and whose contents resolve to workspaces, which is why feed
 * items adopt a workspace rather than inventing a parallel container. See
 * CONCEPTS.md.
 *
 * A feed contributes a
 * descriptor (band identity + lanes) and a provider (listItems). Items
 * resolve into workspaces via resolveExternalWorkspace (workspace-resolve.ts)
 * keyed `<refKind>-<itemId>`, and the linkage is stamped as a generic
 * `externalRefs` entry — never a new one-off foreign-key field per source.
 * Design doc: the feeds design.
 *
 * Registration is lazy (ensureFeedsRegistered from the routes) so this module
 * has no import-time side effects; providers whose backing connection is
 * absent (e.g. no backing MCP server / no OAuth grant yet) simply don't
 * register, which hides the band. MCP-backed feeds are per-viewer: items are
 * fetched on the requesting user's grant and cached per user.
 */
import type { ExternalRef } from "./types";
import {
  dotGet,
  readConfigFeeds,
  type ConfigFeed,
  type FeedContextSpec,
  type FeedPanelSpec,
} from "./feeds-config";

export type { ExternalRef, FeedContextSpec, FeedPanelSpec };

export interface FeedItem {
  /** Stable external id (e.g. `vid_…`); becomes ExternalRef.id. */
  id: string;
  title: string;
  preview?: string;
  /** Key into the descriptor's lanes; absent = the feed renders flat. */
  lane?: string;
  /** Sort timestamp (ms). Feeds return newest-first regardless. */
  ts?: number;
  /** Canonical external link (view page). */
  url?: string;
  thumbnail?: string;
  /** Source-specific extras the frontend may use (e.g. embedUrl, editUrl). */
  meta?: Record<string, unknown>;
}

/**
 * One filter control on a feed band (the feeds design — e.g. a video feed
 * filtering by tag/playlist on its list tool, configurable per
 * project/plugin). `key` is the LIST-TOOL ARGUMENT the selected value is
 * passed as; options are static or resolved from another MCP tool on the
 * viewer's grant (e.g. a list_tags tool).
 */
export interface FeedFilterSpec {
  key: string;
  label: string;
  /** "arg" (default): the selected value is passed as this list-tool
   *  argument (e.g. tagIds/playlistId). "meta": filtered client-side
   *  against item.meta (plain assignee/labels). */
  mode?: "arg" | "meta";
  /** meta mode: dot-path into item.meta. Arrays match when SOME element's
   *  option-value path equals the selection; null/undefined matches the
   *  reserved "__unassigned__" option value. */
  field?: string;
  /** Static options (prepended before derived/fetched ones). */
  options?: { value: string; label: string }[];
  /** arg mode: resolve options from another MCP tool on the viewer's grant. */
  optionsFrom?: {
    server: string;
    tool: string;
    args?: Record<string, unknown>;
    /** Dot-path to the option array in the tool result. */
    path?: string;
    map: { value: string; label: string };
  };
  /** meta mode: derive options from the items' field values — paths applied
   *  to each element (arrays) or the value itself. */
  optionsFromItems?: { value: string; label: string };
}

export interface FeedLane {
  key: string;
  label: string;
  /** CSS color for the row dot of items in this lane. */
  dot?: string;
}

export interface FeedDescriptor {
  /** Feed id — also the RepoTile/brand icon key (e.g. "posthog"). */
  id: string;
  /** Band title in the sidebar. */
  title: string;
  /** ExternalRef.kind stamped on adopted workspaces (usually = id). */
  refKind: string;
  lanes?: FeedLane[];
  /** Brand tile background for the band header. */
  tileBg?: string;
  /**
   * External MCP servers (mcp-config.json names) sessions in this feed's
   * workspaces get — their session allowlist defaults to exactly this list,
   * so a feed-item session never sees Plain/Stripe/WorkOS tools. Names not
   * (yet) in mcp-config are skipped by filterMcpServers, so declaring a
   * future server is safe and lights up when it's added.
   */
  mcpServers?: string[];
  /** Web panel the workspace tab renders for this feed's items
   *  (`{id}`-templated iframe URL + header links). */
  panel?: FeedPanelSpec;
  /** Lane whose count shows as the collapsed band's attention badge
   *  (e.g. plain's Urgent lane). */
  attentionLane?: string;
  /** Filter controls the band header offers; values feed the list tool. */
  filters?: FeedFilterSpec[];
  /** Sort options for the band (first = default). Values: "recent" |
   *  "oldest" | "title" | "meta:<dot-path>" (numeric desc). Absent = the
   *  built-in recent/oldest/title trio. */
  sortOptions?: { value: string; label: string }[];
  /** Extra meta dot-paths the sidebar's text search matches besides
   *  title/preview (e.g. plain's customer name/email). */
  searchMeta?: string[];
  /** Session context: tool called with the item id at session start,
   *  result injected into the opening prompt ({id}-templated args). */
  context?: FeedContextSpec;
  /** True for config-declared feeds (editable/deletable in the UI). */
  fromConfig?: boolean;
}

export interface FeedProvider {
  descriptor: FeedDescriptor;
  /** `ctx.user`: the requesting viewer — MCP-backed feeds run on THEIR
   *  grant (workspace grant fallback), so the band is per-viewer.
   *  `ctx.args`: selected filter values (descriptor.filters keys only),
   *  merged into the backing list-tool call. */
  listItems(ctx?: {
    user?: string;
    args?: Record<string, string>;
  }): Promise<FeedItem[]>;
  /** Plugin-level session context for one item (the code sibling of the
   *  descriptor's declarative `context` spec — for sources that aren't an
   *  HTTP MCP tool call, e.g. Slack channel history via the Web API).
   *  Returned string is injected verbatim into the opening prompt. */
  contextForRef?(id: string, user?: string): Promise<string | null>;
}

interface FeedEntry {
  provider: FeedProvider;
  /** Items cached per viewer (feeds can be per-user — MCP grants). */
  cache: Map<string, { items: FeedItem[]; ts: number }>;
}

// Parked on globalThis like the other state modules so a hot reload (dev)
// keeps the registry; the systemd flow restarts the whole process anyway.
const registry: Map<string, FeedEntry> = ((globalThis as any).__osFeeds ??=
  new Map<string, FeedEntry>());

const ITEMS_TTL = 60_000;

export function registerFeed(provider: FeedProvider): void {
  registry.set(provider.descriptor.id, { provider, cache: new Map() });
}

/** Config feed → provider: items via one MCP tool call on the viewer's
 *  grant, fields picked by dot-path mapping (the feeds design W3). */
function configFeedProvider(cf: ConfigFeed): FeedProvider {
  return {
    descriptor: {
      id: cf.id,
      title: cf.title,
      refKind: cf.refKind,
      ...(cf.tileBg ? { tileBg: cf.tileBg } : {}),
      ...(cf.mcpServers?.length ? { mcpServers: cf.mcpServers } : {}),
      ...(cf.panel ? { panel: cf.panel } : {}),
      ...(cf.context ? { context: cf.context } : {}),
      ...(Array.isArray(cf.filters) && cf.filters.length
        ? { filters: cf.filters as FeedFilterSpec[] }
        : {}),
      fromConfig: true,
    },
    async listItems(ctx?: { user?: string }): Promise<FeedItem[]> {
      const { callMcpTool } = await import("./mcp-client");
      const raw = await callMcpTool<unknown>(
        cf.items.server,
        cf.items.tool,
        cf.items.args || {},
        ctx?.user,
      );
      const arr = dotGet(raw, cf.items.path);
      if (!Array.isArray(arr)) return [];
      const m = cf.items.map;
      return arr
        .map((it): FeedItem | null => {
          const idRaw = dotGet(it, m.id);
          const titleRaw = dotGet(it, m.title);
          const id =
            typeof idRaw === "string"
              ? idRaw
              : typeof idRaw === "number"
                ? String(idRaw)
                : "";
          const title =
            typeof titleRaw === "string"
              ? titleRaw
              : typeof titleRaw === "number"
                ? String(titleRaw)
                : "";
          if (!id || !title) return null;
          const tsRaw = m.ts ? dotGet(it, m.ts) : undefined;
          const ts =
            typeof tsRaw === "number"
              ? tsRaw
              : typeof tsRaw === "string"
                ? Date.parse(tsRaw) || undefined
                : undefined;
          return {
            id,
            title,
            ...(m.preview && typeof dotGet(it, m.preview) === "string"
              ? { preview: dotGet(it, m.preview) as string }
              : {}),
            ...(ts ? { ts } : {}),
            ...(m.url && typeof dotGet(it, m.url) === "string"
              ? { url: dotGet(it, m.url) as string }
              : {}),
            ...(m.thumbnail && typeof dotGet(it, m.thumbnail) === "string"
              ? { thumbnail: dotGet(it, m.thumbnail) as string }
              : {}),
          };
        })
        .filter((x): x is FeedItem => !!x)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    },
  };
}

/** Overlay ~/.opensession-feeds.json entries onto the registry: add/update
 *  config feeds, drop removed ones. Code feeds (registered directly) win on
 *  id collision. Called by every read path so edits apply without restart. */
function syncConfigFeeds(): void {
  const config = readConfigFeeds();
  const configIds = new Set(config.map((f) => f.id));
  for (const [id, entry] of registry)
    if ((entry as any).fromConfig && !configIds.has(id)) registry.delete(id);
  for (const cf of config) {
    const existing = registry.get(cf.id);
    if (existing && !(existing as any).fromConfig) continue; // code feed wins
    const entry: FeedEntry = {
      provider: configFeedProvider(cf),
      cache: existing?.cache ?? new Map(),
    };
    (entry as any).fromConfig = true;
    registry.set(cf.id, entry);
  }
}

export function listFeedDescriptors(): FeedDescriptor[] {
  syncConfigFeeds();
  return [...registry.values()].map((e) => e.provider.descriptor);
}

/** Items for one feed, cached ~60s per viewer (every open browser polls). */
export async function getFeedItems(
  feedId: string,
  user?: string,
  args?: Record<string, string>,
): Promise<FeedItem[] | null> {
  syncConfigFeeds();
  const entry = registry.get(feedId);
  if (!entry) return null;
  const key = `${user || ""}\u0000${JSON.stringify(args || {})}`;
  const cached = entry.cache.get(key);
  if (cached && Date.now() - cached.ts < ITEMS_TTL) return cached.items;
  const items = await entry.provider.listItems({ user, args });
  entry.cache.set(key, { items, ts: Date.now() });
  return items;
}

// Filter-option lists resolved via MCP (e.g. tag lists), cached briefly.
const filterOptionsCache = new Map<
  string,
  { options: { value: string; label: string }[]; ts: number }
>();
const FILTER_OPTIONS_TTL = 5 * 60_000;

/** Options for one of a feed's filter controls, on the viewer's grant. */
export async function getFeedFilterOptions(
  feedId: string,
  filterKey: string,
  user?: string,
): Promise<{ value: string; label: string }[] | null> {
  syncConfigFeeds();
  const spec = registry
    .get(feedId)
    ?.provider.descriptor.filters?.find((f) => f.key === filterKey);
  if (!spec) return null;
  if (spec.options) return spec.options;
  if (!spec.optionsFrom) return [];
  const cacheKey = `${feedId}\u0000${filterKey}\u0000${user || ""}`;
  const cached = filterOptionsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < FILTER_OPTIONS_TTL)
    return cached.options;
  const { callMcpTool } = await import("./mcp-client");
  const { dotGet } = await import("./feeds-config");
  const raw = await callMcpTool<unknown>(
    spec.optionsFrom.server,
    spec.optionsFrom.tool,
    spec.optionsFrom.args || {},
    user,
  );
  const arr = dotGet(raw, spec.optionsFrom.path);
  const options = Array.isArray(arr)
    ? arr
        .map((o) => ({
          value: String(dotGet(o, spec.optionsFrom!.map.value) ?? ""),
          label: String(dotGet(o, spec.optionsFrom!.map.label) ?? ""),
        }))
        .filter((o) => o.value && o.label)
    : [];
  filterOptionsCache.set(cacheKey, { options, ts: Date.now() });
  return options;
}

/** Drop a feed's cached items (all viewers) — mutations that change the
 *  list (e.g. Plain mark-done) call this so the next poll refetches. */
export function invalidateFeedCache(feedId: string): void {
  registry.get(feedId)?.cache.clear();
}

/**
 * The MCP allowlist for a session whose workspace carries these refs: the
 * union of the matching feeds' declared servers. Returns undefined when no
 * matching feed declares any — callers then leave the session unrestricted
 * (an EMPTY allowlist would be normalized back to "all servers" by
 * run-session, so "scoped" is only expressible as a non-empty list).
 */
export async function feedMcpServersForRefs(
  refs: Array<{ kind: string }>,
): Promise<string[] | undefined> {
  await ensureFeedsRegistered();
  syncConfigFeeds();
  const out = new Set<string>();
  for (const entry of registry.values()) {
    const d = entry.provider.descriptor;
    if (!d.mcpServers?.length) continue;
    if (refs.some((r) => r.kind === d.refKind))
      for (const s of d.mcpServers) out.add(s);
  }
  return out.size ? [...out] : undefined;
}

/**
 * The opening-context block for a session whose workspace carries these refs:
 * names the linked objects, adds the scratch-dir note for scratch sessions,
 * and for video refs appends the video's metadata + chapters + transcript
 * excerpt (the Plain ticket-context analogue). Used by BOTH create paths and
 * the first prompt of prompt-less creates (tab-strip "+" siblings) — a session
 * in a feed workspace must get this no matter how it was born. Returns null
 * when there's nothing to say. Callers wrap it (wrapContext) themselves.
 */
export async function externalRefsOpeningContext(
  refs: ExternalRef[] | undefined,
  opts: { scratch?: boolean; user?: string } = {},
): Promise<string | null> {
  if (!refs?.length) return null;
  const lines = refs
    .map(
      (r) =>
        `- ${r.kind} ${r.id}${r.title ? ` — "${r.title}"` : ""}${r.url ? ` (${r.url})` : ""}`,
    )
    .join("\n");
  let out = `This session belongs to a workspace linked to external object(s):\n${lines}`;
  if (opts.scratch)
    out +=
      "\n\nYour working directory is a scratch space (not a git repo) — download media, run ffmpeg, write files there freely. Use the available MCP tools for the linked service when the task concerns the object itself. IMPORTANT — showing media: when your work produces a video or image you want seen, print `OPENSESSION_VIDEO: /abs/path.mp4` or `OPENSESSION_IMAGE: /abs/path.png` on its own line, or name the absolute path in your own message text — either one renders it inline. A path that only turns up in tool output still attaches, but stays folded away, so don't rely on that for the artifact that matters. Media that never appears as a path/URL/marker at all is invisible to the user (local files must exist on disk).";
  // Generic per-feed context (the feeds design — posthog dashboards
  // etc.): the descriptor's context tool called with the item id, result
  // injected as a JSON excerpt. Declarative — no per-feed code.
  await ensureFeedsRegistered();
  syncConfigFeeds();
  for (const r of refs) {
    const entry = [...registry.values()].find(
      (e) => e.provider.descriptor.refKind === r.kind,
    );
    const desc = entry?.provider.descriptor;
    // Plugin hook first (code feeds), declarative spec second.
    if (entry?.provider.contextForRef) {
      try {
        const text = await entry.provider.contextForRef(r.id, opts.user);
        if (text) out += `\n\n${desc!.title} context for ${r.id}:\n\n${text}`;
      } catch (e) {
        console.error(
          `[feeds] plugin context failed for ${r.kind} ${r.id}:`,
          e,
        );
      }
      continue;
    }
    const ctxSpec = desc?.context;
    if (!ctxSpec) continue;
    try {
      const { callMcpTool } = await import("./mcp-client");
      const args = Object.fromEntries(
        Object.entries(ctxSpec.args || {}).map(([k, v]) => [
          k,
          typeof v === "string" ? v.replaceAll("{id}", r.id) : v,
        ]),
      );
      const raw = await callMcpTool<unknown>(
        ctxSpec.server,
        ctxSpec.tool,
        args,
        opts.user,
      );
      const text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 1);
      const cap = ctxSpec.maxChars || 6_000;
      out += `\n\n${desc!.title} context for ${r.id}${text.length > cap ? ` (first ${cap} chars — use the ${ctxSpec.server} MCP tools for the rest)` : ""}:\n\n${text.slice(0, cap)}`;
    } catch (e) {
      console.error(`[feeds] context lookup failed for ${r.kind} ${r.id}:`, e);
    }
  }
  return out;
}

// Agents whose getFeed() has been consulted. NOT a single boot-wide latch:
// agents load up to ~15s after boot, and a feeds request in that window used
// to freeze the registry without them for the whole process lifetime (the
// "sidebar shows slack-channel, no channels" regression, 2026-07-29). Each
// call registers only agents not seen before, so existing entries keep their
// per-user item caches.
const feedAgentsSeen = new Set<string>();
let scratchSweepDone = false;
/** Idempotently register the code-feed providers (called from the routes):
 *  every loaded AgentModule with a getFeed() contribution (the W4 plugin
 *  seam). Config feeds overlay separately (syncConfigFeeds). */
export async function ensureFeedsRegistered(): Promise<void> {
  try {
    const { getAgents } = await import("./agents-registry");
    for (const a of getAgents()) {
      if (!a.getFeed || feedAgentsSeen.has(a.name)) continue;
      feedAgentsSeen.add(a.name);
      try {
        const provider = a.getFeed();
        if (provider) registerFeed(provider);
      } catch (e) {
        console.error(`[feeds] ${a.name}.getFeed() failed:`, e);
      }
    }
  } catch {}
  if (scratchSweepDone) return;
  scratchSweepDone = true;
  // Once per boot: sweep scratch dirs whose workspace is gone (deleted
  // workspaces clean up inline in deleteWorkspace; this catches dirs from
  // before that hook and workspace-less creates). 14-day grace on mtime.
  sweepOrphanScratchDirs().catch(() => {});
}

const SCRATCH_ORPHAN_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

async function sweepOrphanScratchDirs(): Promise<void> {
  const { readdirSync, rmSync, statSync, existsSync } = await import("fs");
  const { stateDir } = await import("./paths");
  const { getWorkspace } = await import("./workspaces");
  const root = stateDir("scratch");
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    try {
      if (getWorkspace(entry)) continue;
      const full = `${root}/${entry}`;
      if (Date.now() - statSync(full).mtimeMs < SCRATCH_ORPHAN_GRACE_MS)
        continue;
      rmSync(full, { recursive: true, force: true });
      console.log(`[feeds] Swept orphan scratch dir ${entry}`);
    } catch {}
  }
}
