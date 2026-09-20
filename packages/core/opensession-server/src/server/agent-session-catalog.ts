/**
 * The catalog projection of the legacy agent-owned session stores.
 *
 * Slack and Linear sessions are files the agent loops write
 * (`~/.slack-sessions/<channel>-<threadTs>.json`,
 * `~/.linear-sessions/<branch>.json`). The gateway used to discover them by
 * reading those directories on every cold list rebuild. It no longer reads a
 * session directory anywhere: each source file is projected into a namespace
 * of the central catalog documents (`slack-sessions`, `linear-sessions`,
 * keyed by the file's basename), and a cold rebuild pages that namespace.
 *
 * The projection is filled once offline (`bun
 * scripts/seed-session-metadata-catalog.ts`, session-source-scan.ts) and kept
 * current by observation: every targeted read of one source file (the read
 * behind a Slack or Linear row publish) records what it saw before the row
 * reaches the list index, and a deletion records that the file is gone. The
 * record is coupled to the publish: a mirror that cannot be written fails
 * the publish, so a row never lands in the index ahead of its catalog copy,
 * and a later cold rebuild cannot roll a session back behind the index.
 *
 * Observations are ordered by the time they were taken. Writes to one key
 * are serialized in-process, and a compare-and-set against the stored copy
 * settles the rest: an observation older than the stored one is dropped,
 * whichever lands first. A deletion is stored as an ordered marker rather
 * than a bare tombstone for the same reason: a read that saw the file just
 * before it was unlinked must not resurrect it by landing later.
 *
 * Until the namespace is marked imported a cold rebuild refuses rather than
 * guessing: an empty namespace and an unseeded one look the same, and a
 * rebuild that silently dropped every Slack thread would let the worktree
 * reaper treat their checkouts as finished work.
 */
import { randomUUID } from "node:crypto";
import {
  agentSessionSourceKey,
  type AgentSessionKind,
} from "./agent-session-source";
export {
  AGENT_SESSION_STORE_SKIP_FILES,
  agentSessionSourceDirectory,
  agentSessionSourceKey,
  type AgentSessionKind,
} from "./agent-session-source";
import {
  CATALOG_DOCUMENT_MAX_SEED_BATCH_BYTES,
  CATALOG_DOCUMENT_PAGE_LIMIT,
  CATALOG_DOCUMENT_SEED_LIMIT,
  sessionCatalogDocument,
  sessionKernelActorActive,
} from "./session-kernel";
import type { LinearSessionFile, SlackSessionFile } from "./types";

export const AGENT_SESSION_CATALOG_NAMESPACES: Record<
  AgentSessionKind,
  string
> = {
  slack: "slack-sessions",
  linear: "linear-sessions",
};

/** One agent-owned source file as read from disk: the parsed document plus
 * the file's mtime, which stands in for the timestamps an older loop did not
 * record. `file` is the basename the unified id derives from
 * (`slack-<file without .json>`, `linear-<branch>`). */
export type AgentSessionSource<K extends AgentSessionKind = AgentSessionKind> =
  {
    file: string;
    data: K extends "slack" ? SlackSessionFile : LinearSessionFile;
    mtime: string;
  };

export type SlackSessionSource = AgentSessionSource<"slack">;
export type LinearSessionSource = AgentSessionSource<"linear">;

/** What one targeted read saw: the file, or null when it was gone, and
 * when the read was taken (`Date.now()` before the read started). */
export type AgentSessionObservation = {
  source: AgentSessionSource | null;
  observedAt: number;
};

/** The stored shape. `data: null` records a deletion. */
type AgentSessionProjection = {
  file: string;
  data: SlackSessionFile | LinearSessionFile | null;
  mtime: string;
  observedAt: number;
};

function catalogAvailable(): boolean {
  // Tests run the catalog on the in-process compatibility store.
  return sessionKernelActorActive() || process.env.NODE_ENV === "test";
}

function encode(projection: AgentSessionProjection): string {
  return JSON.stringify(projection);
}

function decode(value: string): AgentSessionProjection | undefined {
  let parsed: Partial<AgentSessionProjection> | null = null;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || !("data" in parsed))
    return undefined;
  if (
    parsed.data !== null &&
    (typeof parsed.data !== "object" || Array.isArray(parsed.data))
  )
    return undefined;
  return {
    file: typeof parsed.file === "string" ? parsed.file : "",
    data: parsed.data ?? null,
    mtime:
      typeof parsed.mtime === "string"
        ? parsed.mtime
        : new Date(0).toISOString(),
    observedAt:
      typeof parsed.observedAt === "number" &&
      Number.isFinite(parsed.observedAt)
        ? parsed.observedAt
        : 0,
  };
}

export function agentSessionCatalogImportComplete(
  kind: AgentSessionKind,
): Promise<boolean> {
  return sessionCatalogDocument({
    op: "import_complete",
    namespace: AGENT_SESSION_CATALOG_NAMESPACES[kind],
  });
}

export function markAgentSessionCatalogImportComplete(
  kind: AgentSessionKind,
): Promise<void> {
  return sessionCatalogDocument({
    op: "mark_import_complete",
    namespace: AGENT_SESSION_CATALOG_NAMESPACES[kind],
  });
}

/** Seed the projection from source files read offline, as one observation
 * taken at `observedAt`. A key that already has a row (a live mirror or an
 * earlier seed) is left alone. Batches are bounded by the kernel's row and
 * byte limits. */
export async function seedAgentSessionCatalog(
  kind: AgentSessionKind,
  sources: AgentSessionSource[],
  observedAt = Date.now(),
): Promise<void> {
  const namespace = AGENT_SESSION_CATALOG_NAMESPACES[kind];
  let rows: Array<{ key: string; value: string }> = [];
  let bytes = 0;
  const flush = async () => {
    if (rows.length === 0) return;
    await sessionCatalogDocument({ op: "seed", namespace, rows });
    rows = [];
    bytes = 0;
  };
  for (const source of sources) {
    const key = agentSessionSourceKey(source.file);
    const value = encode({ ...source, observedAt });
    const size = Buffer.byteLength(key) + Buffer.byteLength(value);
    if (
      rows.length >= CATALOG_DOCUMENT_SEED_LIMIT ||
      (rows.length > 0 && bytes + size > CATALOG_DOCUMENT_MAX_SEED_BATCH_BYTES)
    )
      await flush();
    rows.push({ key, value });
    bytes += size;
  }
  await flush();
}

/** Every live source in the projection, in key order. Deleted files and
 * catalog tombstones are skipped. Pages until the kernel returns an empty
 * page: a short page is a byte bound, not the end. Yields to request
 * traffic between pages. */
export async function agentSessionCatalogSources<K extends AgentSessionKind>(
  kind: K,
): Promise<AgentSessionSource<K>[]> {
  const namespace = AGENT_SESSION_CATALOG_NAMESPACES[kind];
  const sources: AgentSessionSource<K>[] = [];
  let afterKey = "";
  for (;;) {
    const page = await sessionCatalogDocument({
      op: "page",
      namespace,
      afterKey,
      limit: CATALOG_DOCUMENT_PAGE_LIMIT,
    });
    if (page.length === 0) break;
    for (const row of page) {
      if (row.value === null) continue;
      const projection = decode(row.value);
      if (!projection)
        throw new Error(`Invalid ${kind} session projection: ${row.key}`);
      if (projection.data === null) continue;
      sources.push({
        file: projection.file || `${row.key}.json`,
        data: projection.data,
        mtime: projection.mtime,
      } as AgentSessionSource<K>);
    }
    afterKey = page[page.length - 1]!.key;
    await Bun.sleep(0);
  }
  return sources;
}

/** Live consumers must distinguish an empty imported store from missing coverage. */
export async function completeAgentSessionCatalogSources<
  K extends AgentSessionKind,
>(kind: K): Promise<AgentSessionSource<K>[]> {
  if (!(await agentSessionCatalogImportComplete(kind)))
    throw new Error(
      `${kind} session catalog is not seeded; run scripts/seed-session-metadata-catalog.ts`,
    );
  return agentSessionCatalogSources(kind);
}

const MIRROR_PUT_ATTEMPTS = 3;
// Per-key write chains. Observations of one file from this process land in
// order; the compare-and-set orders them against other writers.
const mirrors = new Map<string, Promise<void>>();

/**
 * Record one observation of a source file. Throws when the catalog cannot
 * take it, so the caller's row publish fails closed instead of advancing the
 * index past the projection. An observation older than the stored copy is
 * dropped: it carries nothing the projection does not already know.
 */
export async function mirrorAgentSessionSource(
  kind: AgentSessionKind,
  file: string,
  observation: AgentSessionObservation,
): Promise<void> {
  if (!catalogAvailable())
    throw new Error("Agent session catalog is unavailable");
  const namespace = AGENT_SESSION_CATALOG_NAMESPACES[kind];
  const key = agentSessionSourceKey(file);
  const chain = `${namespace}\0${key}`;
  const previous = mirrors.get(chain) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => writeObservation(namespace, key, file, observation));
  mirrors.set(chain, next);
  try {
    await next;
  } finally {
    if (mirrors.get(chain) === next) mirrors.delete(chain);
  }
}

async function writeObservation(
  namespace: string,
  key: string,
  file: string,
  { source, observedAt }: AgentSessionObservation,
): Promise<void> {
  const value = encode({
    file,
    data: source?.data ?? null,
    mtime: source?.mtime ?? new Date(0).toISOString(),
    observedAt,
  });
  for (let attempt = 1; ; attempt++) {
    const current = await sessionCatalogDocument({ op: "get", namespace, key });
    if (current?.value === value) return;
    const stored = current?.value ? decode(current.value) : undefined;
    if (stored && stored.observedAt > observedAt) return;
    // Nothing recorded and nothing to record: a deletion of an unknown file.
    if (!current && source === null) return;
    const result = await sessionCatalogDocument({
      op: "put",
      namespace,
      key,
      expectedRev: current?.rev ?? null,
      value,
      requestId: `agent-session-source:${randomUUID()}`,
    });
    if (result.status !== "conflict") return;
    if (attempt >= MIRROR_PUT_ATTEMPTS)
      throw new Error(
        `Agent session projection ${namespace}/${key} changed under ${MIRROR_PUT_ATTEMPTS} write attempts`,
      );
  }
}
