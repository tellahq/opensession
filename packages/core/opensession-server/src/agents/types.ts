/**
 * Interface for agent modules — Open Session's plugin seam
 * (the feeds design W4). A module ("package") can contribute any subset
 * of the five project surfaces:
 *
 *  1. events   — webhook routes via getRoutes() (dispatched by
 *                webhook-server.ts) that fire automations.
 *  2. feed     — a sidebar band of external objects via getFeed(); the
 *                descriptor also carries the workspace panel template and
 *                the session MCP allowlist, so one provider wires the whole
 *                item → workspace → session → tab flow.
 *  3. panels   — declared on the feed descriptor (`panel`), rendered by the
 *                generic FeedWebPane; richer custom panels stay frontend
 *                components bound to the descriptor's refKind (Plain's
 *                ConversationPane is the precedent).
 *  4. tools    — an MCP server entry in mcp-config.json named by the feed
 *                descriptor's mcpServers.
 *  5. resolver — free: resolveExternalWorkspace keys `<refKind>-<id>`.
 *
 * Zero-code projects use ~/.opensession-feeds.json instead (feeds-config.ts);
 * a module is only needed when custom code enters the picture (bespoke item
 * fetching, webhooks, background tasks) — implement getFeed() on the module
 * (see docs/extending.md); extraction to `@opensession/feed-*` packages later
 * is mechanical because this interface is the boundary.
 */
export interface AgentModule {
  /** Display name (e.g. "slack", "linear", "plain") */
  name: string;

  /** Return a map of "METHOD /path" → handler. Example key: "POST /slack/events" */
  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>>;

  /** Called once at startup — restore state, start background tasks */
  startup(): Promise<void>;

  /** Called on graceful shutdown — clean up processes, save state */
  shutdown(): Promise<void>;

  /** Return health info for the combined /health endpoint. May await a
   *  catalog read (automation-backed agents); consumers await it. */
  health(): Record<string, unknown> | Promise<Record<string, unknown>>;

  /**
   * Optional sidebar feed (the feeds design). Called once at feed
   * registration; return null when the module's backing connection isn't
   * configured (hides the band). Import the FeedProvider type from
   * src/server/feeds.
   */
  getFeed?(): import("../server/feeds").FeedProvider | null;
}
