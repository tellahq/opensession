import type { RouteContext } from "./context";
import {
  AMBIENT_MEMORY_BUDGET_BYTES,
  DuplicateMemoryError,
  ensureMemoryV2Ready,
  MEMORY_KINDS,
  MEMORY_STATES,
  MemoryNotFoundError,
  memoryRolloutMode,
  renderAmbientMemory,
  RETRIEVED_MEMORY_BUDGET_BYTES,
  type MemoryKind,
  type MemoryFilters,
  type MemoryRecord,
  type MemoryState,
} from "../memory-v2";
import {
  addSessionMemory,
  archiveMemories,
  describeScope,
  forgetSessionMemory,
  invalidateMemorySnapshot,
  listAllMemory,
  restoreMemory,
  updateMemoryEntry,
  type MemoryScope,
} from "../session-memory";
import { REPOS } from "../worktree";
import { requireWorkspaceAdmin } from "../workspace-auth";
import { configuredIdentity } from "../config";
import { webAuthRequired } from "../web-auth";

function canAccessMemoryScope(ctx: RouteContext, scopeKey: string): boolean {
  if (!webAuthRequired()) return true;
  const team = configuredIdentity().team;
  const login = ctx.authUser?.login?.trim().toLowerCase();
  if (!login) return false;
  const explicitAdmin = team.some(
    (member) =>
      member.admin === true && member.github?.trim().toLowerCase() === login,
  );
  if (explicitAdmin) return true;
  if (scopeKey === "workspace" || scopeKey.startsWith("repo-")) return true;
  if (scopeKey.startsWith("user-")) {
    const slackId = scopeKey.slice("user-".length);
    return team.some(
      (member) =>
        member.github?.trim().toLowerCase() === login &&
        member.slackId === slackId,
    );
  }
  // Private Slack channel membership is not present in the identity roster.
  // Only an explicit workspace administrator may inspect those scopes here.
  return false;
}

function summaryRecord(record: MemoryRecord) {
  return {
    id: record.id,
    scopeKey: record.scopeKey,
    summary: record.summary,
    hasDetails: !!record.details,
    kind: record.kind,
    tier: record.tier,
    state: record.state,
    source: record.source,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastConfirmedAt: record.lastConfirmedAt,
    expiresAt: record.expiresAt,
    supersedes: record.supersedes,
    supersededBy: record.supersededBy,
    tags: record.tags,
    retrievalCount: record.retrievalCount,
    lastRetrievedAt: record.lastRetrievedAt,
  };
}

function validKind(value: unknown): value is MemoryKind {
  return (
    typeof value === "string" && MEMORY_KINDS.includes(value as MemoryKind)
  );
}

function validState(value: unknown): value is MemoryState {
  return (
    typeof value === "string" && MEMORY_STATES.includes(value as MemoryState)
  );
}

function errorResponse(error: unknown): Response {
  if (error instanceof DuplicateMemoryError) {
    return Response.json(
      { error: error.message, existingId: error.existingId },
      { status: 409 },
    );
  }
  if (error instanceof MemoryNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  return Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 400 },
  );
}

function requireStatusExpiry(
  kind: MemoryKind,
  expiresAt: unknown,
  requireFuture = false,
): void {
  if (
    kind === "status" &&
    (typeof expiresAt !== "string" || !expiresAt.trim())
  ) {
    throw new Error("Status memories require expiresAt.");
  }
  if (
    requireFuture &&
    kind === "status" &&
    typeof expiresAt === "string" &&
    Date.parse(expiresAt) <= Date.now()
  ) {
    throw new Error("Status memory expiresAt must be in the future.");
  }
}

export async function handleMemoryRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;
  if (!path.startsWith("/api/memory")) return undefined;
  const denied = requireWorkspaceAdmin(ctx);
  if (denied) return denied;
  if (memoryRolloutMode() !== "v2") return handleLegacyMemoryRoutes(ctx);

  try {
    const { store } = await ensureMemoryV2Ready();
    store.expireDue();

    if (path === "/api/memory/scopes" && req.method === "GET") {
      const stats = store.stats();
      const visibleStats = stats.scopes.filter((scope) =>
        canAccessMemoryScope(ctx, scope.scopeKey),
      );
      const pinned: MemoryRecord[] = [];
      let pinnedCursor: string | undefined;
      while (visibleStats.length) {
        const page = store.list(
          {
            states: ["active"],
            tiers: ["pinned"],
            scopeKeys: visibleStats.map((scope) => scope.scopeKey),
          },
          { cursor: pinnedCursor, limit: 100 },
        );
        pinned.push(...page.items);
        pinnedCursor = page.nextCursor;
        if (!pinnedCursor || pinned.length >= 2_000) break;
      }
      const ambient = renderAmbientMemory(pinned, {
        scopeKeys: visibleStats.map((scope) => scope.scopeKey),
      });
      const byKey = new Map(
        visibleStats.map((scope) => [scope.scopeKey, scope]),
      );
      const keys = new Set([
        "workspace",
        ...Object.keys(REPOS).map((repo) => `repo-${repo}`),
        ...visibleStats.map((scope) => scope.scopeKey),
      ]);
      const scopes = [...keys]
        .filter((key) => canAccessMemoryScope(ctx, key))
        .map((key) => ({ scope: describeScope(key), stats: byKey.get(key) }))
        .filter(
          (
            item,
          ): item is typeof item & { scope: NonNullable<typeof item.scope> } =>
            !!item.scope,
        )
        .map(({ scope, stats: scopeStats }) => ({
          scope,
          count: scopeStats?.total ?? 0,
          pinnedCount: scopeStats?.pinned ?? 0,
          reviewCount: scopeStats?.review ?? 0,
          ambientChars: scopeStats?.ambientSummaryChars ?? 0,
        }));
      return Response.json({
        scopes,
        stats: {
          mode: "v2",
          ambientBudgetBytes: AMBIENT_MEMORY_BUDGET_BYTES,
          retrievalBudgetBytes: RETRIEVED_MEMORY_BUDGET_BYTES,
          ambientUsedBytes: ambient.bytes,
          reviewCount: visibleStats.reduce(
            (sum, scope) => sum + scope.review,
            0,
          ),
        },
      });
    }

    if (path === "/api/memory" && req.method === "GET") {
      const scopeKey = url.searchParams.get("scopeKey") || undefined;
      if (scopeKey && !describeScope(scopeKey)) {
        return Response.json({ error: "invalid scopeKey" }, { status: 400 });
      }
      if (scopeKey && !canAccessMemoryScope(ctx, scopeKey)) {
        return Response.json({ error: "entry not found" }, { status: 404 });
      }
      const kindParam = url.searchParams.get("kind") || undefined;
      const stateParam = url.searchParams.get("state") || undefined;
      if (kindParam && !validKind(kindParam)) {
        return Response.json({ error: "invalid kind" }, { status: 400 });
      }
      if (stateParam && !validState(stateParam)) {
        return Response.json({ error: "invalid state" }, { status: 400 });
      }
      const kind = kindParam as MemoryKind | undefined;
      const state = stateParam as MemoryState | undefined;
      const review = url.searchParams.get("review");
      const visibleKeys = store
        .stats()
        .scopes.filter((scope) => canAccessMemoryScope(ctx, scope.scopeKey))
        .map((scope) => scope.scopeKey);
      if (!scopeKey && !visibleKeys.length) {
        return Response.json({ items: [] });
      }
      const filters: MemoryFilters = {
        scopeKeys: scopeKey ? [scopeKey] : visibleKeys,
        kinds: kind ? [kind] : undefined,
        states: state ? [state] : undefined,
        confirmed:
          review === "needs_review"
            ? false
            : review === "confirmed"
              ? true
              : undefined,
      };
      const page = {
        cursor: url.searchParams.get("cursor") || undefined,
        limit: Number(url.searchParams.get("limit")) || 20,
      };
      const query = url.searchParams.get("q")?.trim();
      const result = query
        ? store.search(query, { ...filters, ...page, includeDetails: false })
        : store.list(filters, page);
      return Response.json({
        items: result.items.map(summaryRecord),
        nextCursor: result.nextCursor,
      });
    }

    if (path === "/api/memory" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const scopeKey = String(body?.scopeKey || "");
      if (!describeScope(scopeKey)) throw new Error("Invalid scopeKey.");
      if (!canAccessMemoryScope(ctx, scopeKey)) {
        return Response.json({ error: "entry not found" }, { status: 404 });
      }
      if (!validKind(body?.kind)) throw new Error("Invalid memory kind.");
      requireStatusExpiry(body.kind, body.expiresAt, true);
      const now = new Date();
      const entry = store.create(
        {
          scopeKey,
          summary: String(body?.summary || body?.text || ""),
          details: typeof body?.details === "string" ? body.details : undefined,
          kind: body.kind,
          tier: "retrievable",
          source: {
            type: "settings",
            actor: ctx.authUser?.login || ctx.authUser?.name,
          },
          lastConfirmedAt: now.toISOString(),
          expiresAt:
            typeof body?.expiresAt === "string" ? body.expiresAt : undefined,
          tags: Array.isArray(body?.tags) ? body.tags.map(String) : undefined,
        },
        now,
      );
      invalidateMemorySnapshot();
      return Response.json({ entry: summaryRecord(entry) });
    }

    if (path === "/api/memory/merge" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const ids: string[] = Array.isArray(body?.ids)
        ? [...new Set<string>(body.ids.map(String))]
        : [];
      const scopeKey = String(body?.scopeKey || "");
      if (!describeScope(scopeKey) || ids.length < 2 || ids.length > 50) {
        throw new Error("scopeKey and two to fifty ids are required.");
      }
      if (!canAccessMemoryScope(ctx, scopeKey)) {
        return Response.json({ error: "entry not found" }, { status: 404 });
      }
      if (!validKind(body?.kind)) throw new Error("Invalid memory kind.");
      requireStatusExpiry(body.kind, body.expiresAt, true);
      const originals = ids.map((id) => store.get(id));
      if (originals.some((entry) => !entry || entry.scopeKey !== scopeKey)) {
        throw new Error(
          "Every merged memory must exist in the selected scope.",
        );
      }
      const now = new Date();
      const entry = store.supersede(
        {
          scopeKey,
          summary: String(body?.summary || ""),
          kind: body.kind,
          tier: "retrievable",
          source: {
            type: "settings",
            actor: ctx.authUser?.login || ctx.authUser?.name,
          },
          lastConfirmedAt: now.toISOString(),
          expiresAt:
            typeof body?.expiresAt === "string" ? body.expiresAt : undefined,
          supersedes: ids,
          tags: [...new Set(originals.flatMap((record) => record?.tags ?? []))],
        },
        now,
      );
      invalidateMemorySnapshot();
      return Response.json({ entry: summaryRecord(entry) });
    }

    const recordMatch = path.match(/^\/api\/memory\/([^/]+)$/);
    if (recordMatch) {
      const id = decodeURIComponent(recordMatch[1]);
      const record = store.get(id);
      if (!record) throw new MemoryNotFoundError(id);
      if (!canAccessMemoryScope(ctx, record.scopeKey)) {
        return Response.json({ error: "entry not found" }, { status: 404 });
      }
      const queryScope = url.searchParams.get("scopeKey");
      if (queryScope && record.scopeKey !== queryScope) {
        return Response.json({ error: "entry not found" }, { status: 404 });
      }

      if (req.method === "GET") return Response.json({ entry: record });
      if (req.method === "PATCH") {
        const body = await req.json().catch(() => null);
        if (body?.scopeKey && body.scopeKey !== record.scopeKey) {
          return Response.json({ error: "entry not found" }, { status: 404 });
        }
        const now = new Date();
        let entry: MemoryRecord;
        switch (body?.action) {
          case "pin":
            store.confirm(id, now);
            entry = store.update(id, { tier: "pinned" }, now);
            break;
          case "unpin":
            entry = store.update(id, { tier: "retrievable" }, now);
            break;
          case "confirm":
            entry = store.confirm(id, now);
            break;
          case "archive":
            entry = store.archive(id, now);
            break;
          case "restore":
            entry = store.restore(id, now);
            break;
          default: {
            const nextKind = body?.kind === undefined ? record.kind : body.kind;
            if (!validKind(nextKind)) throw new Error("Invalid memory kind.");
            requireStatusExpiry(
              nextKind,
              body?.expiresAt === undefined ? record.expiresAt : body.expiresAt,
            );
            entry = store.update(
              id,
              {
                summary: body?.summary,
                details: body?.details,
                kind: body?.kind,
                expiresAt: body?.expiresAt,
                tags: Array.isArray(body?.tags)
                  ? body.tags.map(String)
                  : undefined,
              },
              now,
            );
            break;
          }
        }
        invalidateMemorySnapshot();
        return Response.json({ entry: summaryRecord(entry) });
      }
      if (req.method === "DELETE") {
        if (url.searchParams.get("confirm") !== "true") {
          throw new Error("confirm=true is required for permanent deletion.");
        }
        if (record.state !== "archived") {
          throw new Error(
            "Archive this memory before deleting it permanently.",
          );
        }
        store.delete(id);
        invalidateMemorySnapshot();
        return Response.json({ ok: true });
      }
    }
  } catch (error) {
    return errorResponse(error);
  }

  return undefined;
}

function legacySummaryEntry(
  scope: MemoryScope,
  entry: {
    id: string;
    text: string;
    by: string;
    at: string;
    archivedAt?: string;
  },
) {
  return {
    id: entry.id,
    scopeKey: scope.key,
    summary:
      entry.text.length > 400 ? `${entry.text.slice(0, 399)}…` : entry.text,
    hasDetails: entry.text.length > 400,
    kind: "reference",
    tier: "pinned",
    state: entry.archivedAt ? "archived" : "active",
    source: { type: "agent-verified" },
    createdAt: entry.at,
    updatedAt: entry.at,
    tags: ["legacy"],
  };
}

async function handleLegacyMemoryRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;
  const all = async () =>
    (await listAllMemory(Object.keys(REPOS))).filter((item) =>
      canAccessMemoryScope(ctx, item.scope.key),
    );
  if (path === "/api/memory/scopes" && req.method === "GET") {
    const scoped = await all();
    return Response.json({
      scopes: scoped.map(({ scope, entries }) => ({
        scope,
        count: entries.length,
        pinnedCount: entries.filter((entry) => !entry.archivedAt).length,
        reviewCount: entries.filter((entry) => !entry.archivedAt).length,
        ambientChars: entries.reduce(
          (sum, entry) => sum + entry.text.length,
          0,
        ),
      })),
      stats: {
        mode: "legacy",
        ambientBudgetBytes: 60_000,
        retrievalBudgetBytes: 60_000,
        ambientUsedBytes: scoped.reduce(
          (sum, item) =>
            sum +
            item.entries
              .filter((entry) => !entry.archivedAt)
              .reduce(
                (entrySum, entry) =>
                  entrySum + Buffer.byteLength(entry.text, "utf8"),
                0,
              ),
          0,
        ),
        reviewCount: scoped.reduce((sum, item) => sum + item.entries.length, 0),
      },
    });
  }
  if (path === "/api/memory" && req.method === "GET") {
    const scopeKey = url.searchParams.get("scopeKey");
    const scoped = (await all()).filter(
      (item) => !scopeKey || item.scope.key === scopeKey,
    );
    const query = url.searchParams.get("q")?.toLowerCase();
    const state = url.searchParams.get("state") || "active";
    const kind = url.searchParams.get("kind");
    const review = url.searchParams.get("review");
    if (
      (kind && kind !== "reference") ||
      state === "expired" ||
      state === "superseded" ||
      review === "confirmed"
    ) {
      return Response.json({ items: [] });
    }
    const items = scoped.flatMap(({ scope, entries }) =>
      entries
        .filter((entry) =>
          state === "archived" ? !!entry.archivedAt : !entry.archivedAt,
        )
        .filter((entry) => !query || entry.text.toLowerCase().includes(query))
        .map((entry) => legacySummaryEntry(scope, entry)),
    );
    const offset = Number(url.searchParams.get("cursor")) || 0;
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit")) || 20, 1),
      50,
    );
    return Response.json({
      items: items.slice(offset, offset + limit),
      nextCursor:
        offset + limit < items.length ? String(offset + limit) : undefined,
    });
  }
  if (path === "/api/memory" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const scope = describeScope(String(body?.scopeKey || ""));
    if (!scope)
      return Response.json({ error: "invalid scopeKey" }, { status: 400 });
    if (!canAccessMemoryScope(ctx, scope.key)) {
      return Response.json({ error: "entry not found" }, { status: 404 });
    }
    const entry = await addSessionMemory(
      scope,
      String(body?.summary || body?.text || ""),
      "settings",
    );
    invalidateMemorySnapshot();
    return Response.json({ entry: legacySummaryEntry(scope, entry) });
  }
  if (path === "/api/memory/merge" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const scope = describeScope(String(body?.scopeKey || ""));
    const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
    if (!scope || ids.length < 2)
      return Response.json(
        { error: "scopeKey and ids required" },
        { status: 400 },
      );
    if (!canAccessMemoryScope(ctx, scope.key)) {
      return Response.json({ error: "entry not found" }, { status: 404 });
    }
    const entry = await addSessionMemory(
      scope,
      String(body?.summary || ""),
      "settings",
      {
        supersedes: ids,
        scopes: [scope],
      },
    );
    invalidateMemorySnapshot();
    return Response.json({ entry: legacySummaryEntry(scope, entry) });
  }
  const match = path.match(/^\/api\/memory\/([^/]+)$/);
  if (!match) return undefined;
  const id = decodeURIComponent(match[1]);
  const scopeKey =
    url.searchParams.get("scopeKey") ||
    (req.method === "PATCH"
      ? String(
          (
            await req
              .clone()
              .json()
              .catch(() => null)
          )?.scopeKey || "",
        )
      : "");
  const scope = describeScope(scopeKey);
  if (!scope)
    return Response.json({ error: "invalid scopeKey" }, { status: 400 });
  const scoped = (await all()).find((item) => item.scope.key === scope.key);
  const current = scoped?.entries.find((entry) => entry.id === id);
  if (!current)
    return Response.json({ error: "entry not found" }, { status: 404 });
  if (req.method === "GET") {
    return Response.json({
      entry: { ...legacySummaryEntry(scope, current), details: current.text },
    });
  }
  if (req.method === "PATCH") {
    const body = await req.json().catch(() => null);
    if (body?.action === "archive") await archiveMemories([scope], [id]);
    else if (body?.action === "restore") await restoreMemory([scope], id);
    else if (!body?.action && typeof body?.summary === "string") {
      await updateMemoryEntry(scope.key, id, body.summary);
    }
    invalidateMemorySnapshot();
    const updated =
      (await all())
        .find((item) => item.scope.key === scope.key)
        ?.entries.find((entry) => entry.id === id) || current;
    return Response.json({ entry: legacySummaryEntry(scope, updated) });
  }
  if (req.method === "DELETE") {
    if (url.searchParams.get("confirm") !== "true") {
      return Response.json(
        { error: "confirm=true is required for permanent deletion" },
        { status: 400 },
      );
    }
    if (!current.archivedAt) {
      return Response.json(
        { error: "Archive this memory before deleting it permanently" },
        { status: 400 },
      );
    }
    const result = await forgetSessionMemory([scope], id);
    if (!result.ok)
      return Response.json({ error: result.error }, { status: 404 });
    invalidateMemorySnapshot();
    return Response.json({ ok: true });
  }
  return undefined;
}
