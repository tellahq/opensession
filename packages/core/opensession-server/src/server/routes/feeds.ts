/**
 * Project and feed routes.
 *
 * `/api/projects` is the union view — every source of work, repo-backed and
 * feed-backed alike (see projects.ts and CONCEPTS.md). `/api/feeds` is the
 * feed registry underneath it, which the feed-authoring UI still needs
 * because only feeds are declarable as config.
 *
 * Read-only surface: the descriptors say which bands exist, the items
 * endpoint feeds one band. Mutations stay on each source's own routes
 * (e.g. /api/plain/*).
 */
import type { RouteContext } from "./context";
import {
  ensureFeedsRegistered,
  getFeedItems,
  listFeedDescriptors,
} from "../feeds";
import { listProjects } from "../projects";
import { conditionalJsonResponse } from "../http-json";

export async function handleFeedsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;

  // Every project, both kinds. Feeds register lazily, so ensure that first
  // or a cold server reports repos only.
  if (path === "/api/projects" && req.method === "GET") {
    await ensureFeedsRegistered();
    return Response.json({ projects: listProjects() });
  }

  if (path === "/api/feeds" && req.method === "GET") {
    await ensureFeedsRegistered();
    return Response.json({ feeds: listFeedDescriptors() });
  }

  // Create/update a config-declared feed ("any MCP is a project" —
  // the feeds design W3). Body = a ConfigFeed; id is the upsert key.
  if (path === "/api/feeds" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    const { upsertConfigFeed } = await import("../feeds-config");
    const result = upsertConfigFeed(body);
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json(result);
  }

  // Sample tool call for the New-project form's mapping suggester: runs the
  // named tool once on the signed-in user's grant and returns the raw JSON
  // (truncated) so the client can propose the items path + field mapping.
  if (path === "/api/feeds/preview" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      server?: string;
      tool?: string;
      args?: Record<string, unknown>;
    } | null;
    if (!body?.server || !body?.tool)
      return Response.json(
        { error: "server and tool required" },
        { status: 400 },
      );
    try {
      const { callMcpTool } = await import("../mcp-client");
      const raw = await callMcpTool<unknown>(
        body.server,
        body.tool,
        body.args || {},
        ctx.authUser?.login || ctx.authUser?.name || undefined,
      );
      const text = JSON.stringify(raw);
      return text.length > 60_000
        ? Response.json({ truncated: true, sample: text.slice(0, 60_000) })
        : Response.json({ result: raw });
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 502 });
    }
  }

  const feedDelMatch = path.match(/^\/api\/feeds\/([^/]+)$/);
  if (feedDelMatch && req.method === "DELETE") {
    const { removeConfigFeed } = await import("../feeds-config");
    const result = removeConfigFeed(decodeURIComponent(feedDelMatch[1]));
    if ("error" in result) return Response.json(result, { status: 404 });
    return Response.json(result);
  }

  // Options for one of a feed's filter controls (resolved via MCP on the
  // viewer's grant, e.g. tags via list_tags).
  const filterOptsMatch = path.match(
    /^\/api\/feeds\/([^/]+)\/filters\/([^/]+)\/options$/,
  );
  if (filterOptsMatch && req.method === "GET") {
    await ensureFeedsRegistered();
    try {
      const { getFeedFilterOptions } = await import("../feeds");
      const options = await getFeedFilterOptions(
        decodeURIComponent(filterOptsMatch[1]),
        decodeURIComponent(filterOptsMatch[2]),
        ctx.authUser?.login || ctx.authUser?.name || undefined,
      );
      if (!options)
        return Response.json({ error: "Unknown filter" }, { status: 404 });
      return Response.json({ options });
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 502 });
    }
  }

  const itemsMatch = path.match(/^\/api\/feeds\/([^/]+)\/items$/);
  if (itemsMatch && req.method === "GET") {
    await ensureFeedsRegistered();
    const feedId = decodeURIComponent(itemsMatch[1]);
    try {
      // Selected filter values ride as f_<key> query params; only keys the
      // descriptor declares as arg-mode filters reach the list tool.
      const desc = listFeedDescriptors().find((d) => d.id === feedId);
      const args: Record<string, string> = {};
      for (const spec of desc?.filters || []) {
        if (spec.mode === "meta") continue;
        const v = url.searchParams.get(`f_${spec.key}`);
        if (v) args[spec.key] = v;
      }
      // Per-viewer: MCP-backed feeds run on the signed-in user's grant.
      const items = await getFeedItems(
        feedId,
        ctx.authUser?.login || ctx.authUser?.name || undefined,
        Object.keys(args).length ? args : undefined,
      );
      if (!items)
        return Response.json({ error: "Unknown feed" }, { status: 404 });
      return conditionalJsonResponse(req, { items });
    } catch (e: any) {
      console.error(`[feeds] Items fetch failed for ${feedId}:`, e);
      return Response.json(
        { error: e?.message || "Feed fetch failed" },
        { status: 502 },
      );
    }
  }

  return undefined;
}
