/**
 * Structured durable memory for interactive Open Session runs.
 *
 * This server is never mounted for automations. Workflow calls additionally
 * deny every mutating tool in workflow-mcp.ts so untrusted delegated text
 * cannot persist instructions into later runs.
 */

import { z } from "zod";
import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import {
  ensureMemoryV2Ready,
  memoryRolloutMode,
  type MemoryRecord,
  type MemoryState,
} from "../../server/memory-v2";
import {
  MemoryIdsInputSchema,
  MemoryKindSchema,
  MemoryListInputSchema,
  MemoryReadInputSchema,
  MemoryScopeKindSchema,
  MemorySummarySchema,
  MemoryUpdateInputSchema,
  StoreMemoryInputSchema,
  memoryContractError,
} from "./memory-contract";
import {
  addSessionMemory,
  archiveMemories,
  forgetSessionMemory,
  invalidateMemorySnapshot,
  listSessionMemory,
  renderSessionMemoryNote,
  searchSessionMemory,
  sessionMemoryScopes,
  type MemoryScope,
} from "../../server/session-memory";

export interface MemoryToolContext {
  user?: string;
  repos: () => string[];
  sessionId?: string;
  /** Team memory affects everyone. Only a server-verified privileged context
   * may grant this; model-authored arguments can never enable it. */
  allowTeamWrites?: boolean;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function scopesFor(ctx: MemoryToolContext): MemoryScope[] {
  return sessionMemoryScopes({ user: ctx.user, repos: ctx.repos() });
}

function writableScope(
  ctx: MemoryToolContext,
  kind: "repo" | "user" | "team",
  repo?: string,
): MemoryScope | string {
  const scopes = scopesFor(ctx);
  if (kind === "team" && !ctx.allowTeamWrites) {
    return "Team memory affects every teammate. Add or pin it from Memory settings.";
  }
  if (kind === "repo") {
    const scope = repo
      ? scopes.find(
          (candidate) => candidate.kind === "repo" && candidate.label === repo,
        )
      : scopes.find((candidate) => candidate.kind === "repo");
    if (scope) return scope;
    return repo
      ? `This session does not span repo "${repo}".`
      : "This session has no repo scope. Use user or team memory.";
  }
  return (
    scopes.find((candidate) => candidate.kind === kind) ||
    "This session has no user scope. Use repo memory."
  );
}

function visibleScopeKeys(ctx: MemoryToolContext): string[] {
  return scopesFor(ctx).map((scope) => scope.key);
}

function compactRecord(record: MemoryRecord): string {
  const qualifiers = [record.kind, record.tier, record.state, record.scopeKey];
  if (!record.lastConfirmedAt) qualifiers.push("needs review");
  if (record.expiresAt) qualifiers.push(`expires ${record.expiresAt}`);
  return `[${record.id}] (${qualifiers.join(", ")}) ${record.summary}`;
}

function canRead(ctx: MemoryToolContext, record: MemoryRecord): boolean {
  return visibleScopeKeys(ctx).includes(record.scopeKey);
}

function overlap(left: string, right: string): number {
  const tokens = (value: string) =>
    new Set(value.toLowerCase().match(/[a-z0-9_.\/-]{3,}/g) || []);
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T | string {
  const result = schema.safeParse(value);
  return result.success ? result.data : memoryContractError(result.error);
}

export function createMemoryMcpServer(ctx: MemoryToolContext) {
  if (memoryRolloutMode() !== "v2") return createLegacyMemoryMcpServer(ctx);
  let storesThisRun = 0;
  const tools = [
    tool(
      "store_memory",
      "Store one durable, non-obvious fact. The summary is compact and retrieval-only by default; " +
        "supporting evidence belongs in details. Do not store task progress, completion reports, PR " +
        "history, incident narration, or facts already documented in the repo. Status requires expiry. " +
        "Team writes require a separately verified privilege.",
      {
        summary: MemorySummarySchema,
        kind: MemoryKindSchema,
        scope: MemoryScopeKindSchema,
        repo: z.string().trim().min(1).optional(),
        details: z.string().trim().max(20_000).optional(),
        tags: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
        expiresAt: z.string().datetime({ offset: true }).optional(),
        supersedes: z.array(z.string().trim().min(1)).max(20).optional(),
      },
      async (args) => {
        const input = parse(StoreMemoryInputSchema, args);
        if (typeof input === "string")
          return text(`Memory not stored: ${input}.`);
        if (storesThisRun >= 1) {
          return text(
            "This run already stored one memory candidate. Return any additional durable facts " +
              "to the person for review instead of growing memory automatically.",
          );
        }
        const scope = writableScope(ctx, input.scope, input.repo);
        if (typeof scope === "string") return text(scope);
        const { store } = await ensureMemoryV2Ready();
        const related = store
          .findRelatedCandidates({
            scopeKey: scope.key,
            summary: input.summary,
            details: input.details,
            tags: input.tags,
          })
          .filter(
            (candidate) =>
              overlap(candidate.record.summary, input.summary) >= 0.6,
          );
        if (related.length && !input.supersedes?.length) {
          return text(
            "A closely related memory already exists. Update or supersede it instead of appending:\n" +
              related
                .map((candidate) => `- ${compactRecord(candidate.record)}`)
                .join("\n"),
          );
        }
        const create = {
          scopeKey: scope.key,
          summary: input.summary,
          details: input.details,
          kind: input.kind,
          tier: "retrievable" as const,
          source: { type: "agent-verified" as const, sessionId: ctx.sessionId },
          expiresAt: input.expiresAt,
          tags: input.tags,
        };
        const entry = input.supersedes?.length
          ? store.supersede({ ...create, supersedes: input.supersedes })
          : store.create(create);
        storesThisRun += 1;
        invalidateMemorySnapshot(ctx.sessionId);
        return text(
          `Stored ${compactRecord(entry)}. Supporting details remain retrieval-only.`,
        );
      },
    ),
    tool(
      "search_memory",
      "Search this session's memory scopes. Returns compact summaries only; use read_memory for details.",
      {
        query: z.string().trim().min(1).max(500),
        kind: MemoryKindSchema.optional(),
        scope: MemoryScopeKindSchema.optional(),
        state: z
          .enum(["active", "archived", "expired", "superseded"])
          .optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      async (args) => {
        const { store } = await ensureMemoryV2Ready();
        const allowed = scopesFor(ctx).filter(
          (scope) => !args.scope || scope.kind === args.scope,
        );
        const page = store.search(args.query, {
          scopeKeys: allowed.map((scope) => scope.key),
          kinds: args.kind ? [args.kind] : undefined,
          states: args.state ? [args.state] : undefined,
          cursor: args.cursor,
          limit: args.limit ?? 10,
          includeDetails: false,
        });
        if (!page.items.length)
          return text(`No memory matches "${args.query}".`);
        return text(
          [
            ...page.items.map((record) => `- ${compactRecord(record)}`),
            page.nextCursor ? `Next cursor: ${page.nextCursor}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    ),
    tool(
      "read_memory",
      "Read full supporting details for selected memory ids returned by search_memory or list_memory.",
      { ids: MemoryReadInputSchema.shape.ids },
      async (args) => {
        const parsed = parse(MemoryReadInputSchema, args);
        if (typeof parsed === "string")
          return text(`Cannot read memory: ${parsed}.`);
        const { store } = await ensureMemoryV2Ready();
        const lines: string[] = [];
        let bytes = 0;
        let omitted = 0;
        for (const id of parsed.ids) {
          const record = store.get(id);
          if (!record || !canRead(ctx, record)) {
            const line = `[${id}] Not found in this session's scopes.`;
            lines.push(line);
            bytes += Buffer.byteLength(line, "utf8");
            continue;
          }
          const line = `${compactRecord(record)}${record.details ? `\n${record.details}` : ""}`;
          const cost = Buffer.byteLength(line, "utf8") + (lines.length ? 2 : 0);
          if (bytes + cost > 16_000) {
            omitted += 1;
            continue;
          }
          lines.push(line);
          bytes += cost;
        }
        if (omitted)
          lines.push(
            `${omitted} requested ${omitted === 1 ? "record was" : "records were"} omitted to keep this result under 16 KB.`,
          );
        return text(lines.join("\n\n"));
      },
    ),
    tool(
      "list_memory",
      "List a bounded page of compact memory summaries. Details are omitted.",
      {
        query: MemoryListInputSchema.shape.query,
        kind: MemoryListInputSchema.shape.kind,
        scope: MemoryListInputSchema.shape.scope,
        state: MemoryListInputSchema.shape.state,
        review: MemoryListInputSchema.shape.review,
        cursor: MemoryListInputSchema.shape.cursor,
        limit: MemoryListInputSchema.shape.limit,
      },
      async (args) => {
        const input = parse(MemoryListInputSchema, args);
        if (typeof input === "string")
          return text(`Cannot list memory: ${input}.`);
        const { store } = await ensureMemoryV2Ready();
        const allowed = scopesFor(ctx).filter(
          (scope) => !input.scope || scope.kind === input.scope,
        );
        const filters = {
          scopeKeys: allowed.map((scope) => scope.key),
          kinds: input.kind ? [input.kind] : undefined,
          states:
            input.state === "all"
              ? ([
                  "active",
                  "archived",
                  "expired",
                  "superseded",
                ] as MemoryState[])
              : input.state
                ? [input.state]
                : undefined,
          confirmed:
            input.review === "confirmed"
              ? true
              : input.review === "needs_review"
                ? false
                : undefined,
        };
        const page = input.query
          ? store.search(input.query, {
              ...filters,
              cursor: input.cursor,
              limit: input.limit ?? 20,
              includeDetails: false,
            })
          : store.list(filters, {
              cursor: input.cursor,
              limit: input.limit ?? 20,
            });
        const items = page.items;
        if (!items.length) return text("No memories match these filters.");
        return text(
          [
            ...items.map((record) => `- ${compactRecord(record)}`),
            page.nextCursor ? `Next cursor: ${page.nextCursor}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    ),
    tool(
      "update_memory",
      "Update one memory in place. Keep the summary atomic and put evidence in details.",
      {
        id: MemoryUpdateInputSchema.shape.id,
        summary: MemoryUpdateInputSchema.shape.summary,
        kind: MemoryUpdateInputSchema.shape.kind,
        details: MemoryUpdateInputSchema.shape.details,
        tags: MemoryUpdateInputSchema.shape.tags,
        expiresAt: MemoryUpdateInputSchema.shape.expiresAt,
      },
      async (args) => {
        const input = parse(MemoryUpdateInputSchema, args);
        if (typeof input === "string")
          return text(`Memory not updated: ${input}.`);
        const { store } = await ensureMemoryV2Ready();
        const current = store.get(input.id);
        if (!current || !canRead(ctx, current))
          return text(
            `Memory [${input.id}] was not found in this session's scopes.`,
          );
        if (current.scopeKey === "workspace" && !ctx.allowTeamWrites)
          return text("Team memory can only be changed from Memory settings.");
        const entry = store.update(input.id, {
          summary: input.summary,
          kind: input.kind,
          details: input.details,
          tags: input.tags,
          expiresAt: input.expiresAt,
        });
        invalidateMemorySnapshot(ctx.sessionId);
        return text(`Updated ${compactRecord(entry)}.`);
      },
    ),
    ...(["archive", "restore", "confirm"] as const).map((action) =>
      tool(
        `${action}_memory`,
        action === "archive"
          ? "Archive memories without deleting them. Archived records stop appearing in active retrieval."
          : action === "restore"
            ? "Restore archived memories to active or expired state."
            : "Confirm that memories remain accurate, refreshing their verification timestamp.",
        { ids: MemoryIdsInputSchema.shape.ids },
        async (args) => {
          const { store } = await ensureMemoryV2Ready();
          const changed: MemoryRecord[] = [];
          const missing: string[] = [];
          for (const id of args.ids) {
            const current = store.get(id);
            if (!current || !canRead(ctx, current)) {
              missing.push(id);
              continue;
            }
            if (current.scopeKey === "workspace" && !ctx.allowTeamWrites) {
              missing.push(id);
              continue;
            }
            if (action === "restore" && current.state !== "archived") {
              missing.push(id);
              continue;
            }
            if (
              action === "archive" &&
              current.state !== "active" &&
              current.state !== "expired"
            ) {
              missing.push(id);
              continue;
            }
            changed.push(store[action](id));
          }
          invalidateMemorySnapshot(ctx.sessionId);
          return text(
            [
              ...changed.map(
                (record) =>
                  `${action === "confirm" ? "Confirmed" : action === "archive" ? "Archived" : "Restored"} [${record.id}].`,
              ),
              missing.length
                ? `Not found or not writable: ${missing.join(", ")}.`
                : "",
            ]
              .filter(Boolean)
              .join("\n") || "Nothing changed.",
          );
        },
      ),
    ),
    tool(
      "forget_memory",
      "Permanently delete one memory. Prefer archive_memory because deletion cannot be recovered.",
      { id: z.string().trim().min(1), confirm: z.literal(true) },
      async (args) => {
        const { store } = await ensureMemoryV2Ready();
        const current = store.get(args.id);
        if (!current || !canRead(ctx, current))
          return text(
            `Memory [${args.id}] was not found in this session's scopes.`,
          );
        if (current.scopeKey === "workspace" && !ctx.allowTeamWrites)
          return text("Team memory can only be deleted from Memory settings.");
        if (current.state !== "archived")
          return text("Archive this memory before deleting it permanently.");
        store.delete(args.id);
        invalidateMemorySnapshot(ctx.sessionId);
        return text(`Permanently deleted [${args.id}].`);
      },
    ),
  ];

  return createSdkMcpServer({
    name: "opensession-memory",
    version: "2.0.0",
    tools,
  });
}

function createLegacyMemoryMcpServer(ctx: MemoryToolContext) {
  const currentScopes = () => scopesFor(ctx);
  const tools = [
    tool(
      "store_memory",
      "Store a durable fact in the legacy memory store.",
      {
        text: z.string().trim().min(1),
        scope: z.enum(["repo", "user", "team"]).optional(),
        repo: z.string().optional(),
        supersedes: z.array(z.string()).optional(),
      },
      async (args) => {
        const kind = args.scope || "repo";
        const scopes = currentScopes();
        const target =
          kind === "repo"
            ? args.repo
              ? scopes.find(
                  (scope) => scope.kind === "repo" && scope.label === args.repo,
                )
              : scopes.find((scope) => scope.kind === "repo")
            : scopes.find((scope) => scope.kind === kind);
        if (!target)
          return text("That memory scope is not available in this session.");
        if (target.kind === "team" && !ctx.allowTeamWrites) {
          return text(
            "Team memory affects every teammate. Add it from Memory settings.",
          );
        }
        const entry = await addSessionMemory(
          target,
          args.text,
          ctx.user || "session",
          {
            supersedes: args.supersedes,
            scopes,
          },
        );
        invalidateMemorySnapshot(ctx.sessionId);
        return text(
          `Remembered [${entry.id}] in ${target.kind}: ${entry.text}`,
        );
      },
    ),
    tool(
      "search_memory",
      "Search the legacy memory visible to this session.",
      {
        query: z.string().trim().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
      async (args) => {
        const hits = await searchSessionMemory(currentScopes(), args.query, {
          limit: args.limit,
        });
        return text(
          hits.length
            ? hits
                .map(
                  (hit) =>
                    `- [${hit.entry.id}] (${hit.scope.kind}) ${hit.entry.text}`,
                )
                .join("\n")
            : "No matching memory.",
        );
      },
    ),
    tool(
      "list_memory",
      "List a bounded set of legacy memory summaries.",
      { limit: z.number().int().min(1).max(50).optional() },
      async (args) => {
        const entries = (await listSessionMemory(currentScopes()))
          .flatMap(({ scope, entries }) =>
            entries.map((entry) => ({ scope, entry })),
          )
          .slice(0, args.limit ?? 20);
        return text(
          entries.length
            ? entries
                .map(
                  ({ scope, entry }) =>
                    `- [${entry.id}] (${scope.kind}) ${entry.text}`,
                )
                .join("\n")
            : "No memory in this session's scopes.",
        );
      },
    ),
    tool(
      "supersede_memory",
      "Archive obsolete legacy memories without deleting them.",
      { ids: z.array(z.string()).min(1).max(50) },
      async (args) => {
        const writableScopes = currentScopes().filter(
          (scope) => ctx.allowTeamWrites || scope.kind !== "team",
        );
        const result = await archiveMemories(writableScopes, args.ids);
        invalidateMemorySnapshot(ctx.sessionId);
        return text(`Archived ${result.archived.length} memories.`);
      },
    ),
    tool(
      "forget_memory",
      "Permanently remove one legacy memory.",
      { id: z.string().trim().min(1) },
      async (args) => {
        const writableScopes = currentScopes().filter(
          (scope) => ctx.allowTeamWrites || scope.kind !== "team",
        );
        const result = await forgetSessionMemory(writableScopes, args.id);
        invalidateMemorySnapshot(ctx.sessionId);
        return text(result.ok ? `Forgot [${args.id}].` : result.error);
      },
    ),
  ];
  return createSdkMcpServer({
    name: "opensession-memory",
    version: "1.0.0",
    tools,
  });
}

/** Legacy prompt seam retained until all run paths switch to prompt-aware v2 retrieval. */
export async function renderMemoryNoteFor(
  ctx: MemoryToolContext,
): Promise<string> {
  return renderSessionMemoryNote(scopesFor(ctx), { tools: true });
}
