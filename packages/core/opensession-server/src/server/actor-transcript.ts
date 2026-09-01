import type {
  AgentTranscriptAnchorV1,
  AgentTranscriptReceiptRefV1,
} from "./session-kernel/transcript-protocol";
import type { TranscriptEntry } from "./types";
import { publishTranscript } from "./transcript-bus";
import { v2SnapshotEntryWeight } from "./transcript-wire";
import {
  notifyTranscriptAppendHook,
  type AgentDestinationTranscriptAppendRequest,
  type AppendResult,
  type DestinationTranscriptAppendRequest,
  type DestinationTranscriptAppendResult,
  type TailWindowOpts,
  type TranscriptHydratedPage,
  type TranscriptImportInfo,
  type TranscriptOutline,
  type TranscriptPage,
  type TranscriptRangePage,
} from "./transcript-store";
import {
  actorTranscriptSessionIds,
  sessionTranscript,
  TRANSCRIPT_ACTOR_MAX_REQUEST_BYTES,
  type TranscriptActorRequest,
  type TranscriptMutationResult,
} from "./session-kernel";

async function callTranscript<T extends TranscriptActorRequest>(
  request: T,
): Promise<import("./session-kernel").TranscriptActorResult<T>> {
  if (process.env.NODE_ENV !== "test") {
    try {
      return await sessionTranscript(request);
    } catch (error) {
      // Keep pre-cutover sessions usable while the one-time actor transcript
      // migration is still pending. Actor-owned sessions never take this path.
      if (
        !(error instanceof Error) ||
        !error.message.includes("has no isolated actor transcript placement")
      )
        throw error;
    }
  }
  const { transcriptStore } = await import("./transcript-store");
  return transcriptStore().applyActorRequest(
    request,
  ) as import("./session-kernel").TranscriptActorResult<T>;
}

async function reconcilePendingWake(
  sessionId: string,
  minimumCursor = 0,
): Promise<void> {
  const wake = await callTranscript({ op: "pending_wake", sessionId });
  if (!wake || wake.cursor < minimumCursor) return;
  const reset = wake.resetEpoch > wake.ackedResetEpoch;
  let changeSeq = Math.max(0, wake.firstChangeSeq - 1);
  let published = false;
  while (changeSeq < wake.lastChangeSeq) {
    const page = await callTranscript({
      op: "changes_since",
      sessionId,
      changeSeq,
      limit: 200,
    });
    if (page.entries.length === 0) break;
    publishTranscript(sessionId, {
      entries: page.entries,
      firstSeq: page.firstSeq,
      lastSeq: page.lastSeq,
      ...(reset && !published ? { reset: true } : {}),
    });
    notifyTranscriptAppendHook(sessionId, page.entries);
    published = true;
    const next = Math.max(...page.entries.map((entry) => entry.changeSeq ?? 0));
    if (next <= changeSeq) break;
    changeSeq = next;
  }
  if (!published)
    publishTranscript(sessionId, {
      entries: [],
      firstSeq: 0,
      lastSeq: 0,
      ...(reset ? { reset: true } : {}),
    });
  await callTranscript({ op: "ack_wake", sessionId, cursor: wake.cursor });
}

export async function drainPendingTranscriptWakesForSessions(
  sessionIds: Iterable<string>,
): Promise<number> {
  let drained = 0;
  for (const sessionId of sessionIds) {
    const pending = await callTranscript({ op: "pending_wake", sessionId });
    if (pending) {
      await reconcilePendingWake(sessionId, pending.cursor);
      drained++;
    }
  }
  return drained;
}

/** One bounded startup catalog page. Readiness never waits on an unbounded
 * number of session mailboxes; later pages continue after readiness. */
export async function drainPendingTranscriptWakeBatch(
  afterSessionId = "",
  limit = 100,
): Promise<{ drained: number; nextAfter: string; complete: boolean }> {
  const boundedLimit = Math.min(Math.max(1, limit), 100);
  const ids = await actorTranscriptSessionIds(boundedLimit, afterSessionId);
  return {
    drained: await drainPendingTranscriptWakesForSessions(ids),
    nextAfter: ids[ids.length - 1] ?? afterSessionId,
    complete: ids.length < boundedLimit,
  };
}

export async function drainPendingTranscriptWakesAfter(
  afterSessionId: string,
): Promise<number> {
  let after = afterSessionId;
  let drained = 0;
  while (true) {
    await Bun.sleep(0);
    const batch = await drainPendingTranscriptWakeBatch(after);
    drained += batch.drained;
    if (batch.complete) return drained;
    after = batch.nextAfter;
  }
}

async function mutate<T>(
  request: Extract<TranscriptActorRequest, { requestId: string }>,
): Promise<T> {
  const mutation = (await callTranscript(
    request,
  )) as TranscriptMutationResult<T>;
  await reconcilePendingWake(request.sessionId, mutation.wakeCursor);
  return mutation.result;
}

export async function appendTranscriptEvents(
  sessionId: string,
  entries: TranscriptEntry[],
): Promise<AppendResult | null> {
  return mutate({
    op: "append",
    sessionId,
    requestId: crypto.randomUUID(),
    entries,
  });
}

export async function appendTranscriptDestination(
  request: DestinationTranscriptAppendRequest,
): Promise<DestinationTranscriptAppendResult> {
  return mutate({
    op: "append_destination",
    sessionId: request.sessionId,
    requestId: `transcript-destination:${request.appendId}`,
    appendId: request.appendId,
    runId: request.runId,
    turnId: request.turnId,
    generation: request.generation,
    entries: request.entries,
  });
}

export async function appendAgentTranscriptDestination(
  request: AgentDestinationTranscriptAppendRequest,
): Promise<AgentTranscriptReceiptRefV1> {
  return mutate({
    op: "agent_append_destination",
    sessionId: request.sessionId,
    requestId: `agent-transcript-destination:${request.appendId}`,
    appendId: request.appendId,
    runId: request.runId,
    turnId: request.turnId,
    generation: request.generation,
    transcriptAnchor: request.transcriptAnchor,
    entries: request.entries,
  });
}

export async function queryAgentTranscriptReceipt(input: {
  sessionId: string;
  runId: string;
  turnId: string;
  generation: number;
  transcriptAnchor: Readonly<AgentTranscriptAnchorV1>;
  appendId: string;
  requestDigest: `sha256:${string}`;
}): Promise<AgentTranscriptReceiptRefV1 | null> {
  return callTranscript({ op: "agent_query_destination_receipt", ...input });
}

export async function validateAgentTranscriptReceipt(input: {
  sessionId: string;
  runId: string;
  turnId: string;
  generation: number;
  transcriptAnchor: Readonly<AgentTranscriptAnchorV1>;
  receipt: Readonly<AgentTranscriptReceiptRefV1>;
}): Promise<AgentTranscriptReceiptRefV1 | null> {
  return callTranscript({ op: "agent_validate_destination_receipt", ...input });
}

function importChunks(entries: TranscriptEntry[]): TranscriptEntry[][] {
  if (entries.length === 0) return [[]];
  // Leave room for the request envelope, ids and import metadata. The actor
  // still performs the canonical exact-byte preflight on every final request.
  const byteBudget = TRANSCRIPT_ACTOR_MAX_REQUEST_BYTES - 64 * 1024;
  const chunks: TranscriptEntry[][] = [];
  let chunk: TranscriptEntry[] = [];
  let bytes = 2;
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (
      chunk.length > 0 &&
      (chunk.length >= 500 || bytes + entryBytes > byteBudget)
    ) {
      chunks.push(chunk);
      chunk = [];
      bytes = 2;
    }
    chunk.push(entry);
    bytes += entryBytes;
  }
  chunks.push(chunk);
  return chunks;
}

export async function importLegacyTranscript(
  sessionId: string,
  entries: TranscriptEntry[],
  src: string,
  watermark: number | null,
): Promise<{ inserted: number; updated: number }> {
  const importId = crypto.randomUUID();
  let inserted = 0;
  let updated = 0;
  let finalMutation: TranscriptMutationResult<{
    inserted: number;
    updated: number;
  }> | null = null;
  const chunks = importChunks(entries);
  for (let index = 0; index < chunks.length; index++) {
    const final = index === chunks.length - 1;
    const mutation = (await callTranscript({
      op: "import",
      sessionId,
      requestId: `import:${importId}:${index}`,
      entries: chunks[index]!,
      src,
      watermark,
      final,
    })) as TranscriptMutationResult<{ inserted: number; updated: number }>;
    inserted += mutation.result.inserted;
    updated += mutation.result.updated;
    finalMutation = mutation;
  }
  if (finalMutation)
    await reconcilePendingWake(sessionId, finalMutation.wakeCursor);
  return { inserted, updated };
}

export async function replaceTranscriptEvents(
  sessionId: string,
  entries: TranscriptEntry[],
  expectedEpoch?: number,
): Promise<{ inserted: number; updated: number }> {
  return mutate({
    op: "replace",
    sessionId,
    requestId: crypto.randomUUID(),
    entries,
    ...(expectedEpoch === undefined ? {} : { expectedEpoch }),
  });
}

export async function deleteSessionTranscript(
  sessionId: string,
): Promise<void> {
  await mutate({
    op: "delete",
    sessionId,
    requestId: crypto.randomUUID(),
  });
}

export const transcript = {
  needsImport: (sessionId: string): Promise<boolean> =>
    callTranscript({ op: "needs_import", sessionId }),
  getImportInfo: (sessionId: string): Promise<TranscriptImportInfo | null> =>
    callTranscript({ op: "import_info", sessionId }),
  readTail: (sessionId: string, limit?: number): Promise<TranscriptPage> =>
    callTranscript({ op: "tail", sessionId, limit }),
  readTailWindow: (
    sessionId: string,
    options: TailWindowOpts,
  ): Promise<TranscriptPage> => {
    const { weigh, ...bounded } = options;
    if (weigh && weigh !== v2SnapshotEntryWeight)
      return Promise.reject(
        new TypeError("Unsupported transcript tail weight profile"),
      );
    return callTranscript({
      op: "tail_window",
      sessionId,
      options: {
        ...bounded,
        ...(weigh ? { weightProfile: "v2_snapshot" as const } : {}),
      },
    });
  },
  readHandoffTail: (sessionId: string): Promise<TranscriptPage> =>
    callTranscript({
      op: "tail_window",
      sessionId,
      options: {
        minEntries: 32,
        minMessages: 24,
        minUserMessagesWithToolWork: 4,
        maxEntries: 512,
        maxEstimatedBytes: 180_000,
        weightProfile: "handoff",
      },
    }),
  readSince: (
    sessionId: string,
    sinceSeq: number,
    limit?: number,
  ): Promise<TranscriptPage> =>
    callTranscript({ op: "since", sessionId, sinceSeq, limit }),
  readChangesSince: (
    sessionId: string,
    changeSeq: number,
    limit?: number,
  ): Promise<TranscriptPage> =>
    callTranscript({ op: "changes_since", sessionId, changeSeq, limit }),
  readHydratedSince: (
    sessionId: string,
    sinceSeq: number,
    limit = 100,
    maxBytes = 12 * 1024 * 1024,
  ): Promise<TranscriptHydratedPage> =>
    callTranscript({
      op: "hydrated_since",
      sessionId,
      sinceSeq,
      limit,
      maxBytes,
    }),
  readBefore: (
    sessionId: string,
    beforeSeq: number,
    limit?: number,
  ): Promise<TranscriptPage> =>
    callTranscript({ op: "before", sessionId, beforeSeq, limit }),
  readRange: (
    sessionId: string,
    fromSeq: number,
    toSeq: number,
    afterSeq?: number,
    limit?: number,
  ): Promise<TranscriptRangePage> =>
    callTranscript({
      op: "range",
      sessionId,
      fromSeq,
      toSeq,
      afterSeq,
      limit,
    }),
  readTranscriptIndex: async (
    sessionId: string,
  ): Promise<TranscriptOutline> => {
    const entries: TranscriptOutline["entries"] = [];
    let afterSeq = 0;
    let lastChangeSeq = 0;
    let epoch = 0;
    while (true) {
      const page = await callTranscript({
        op: "outline",
        sessionId,
        afterSeq,
        limit: 2_000,
      });
      entries.push(...page.entries);
      lastChangeSeq = page.lastChangeSeq;
      epoch = page.epoch;
      if (page.entries.length < 2_000) break;
      const next = page.entries[page.entries.length - 1]!.seq;
      if (next <= afterSeq) break;
      afterSeq = next;
    }
    return {
      entries,
      firstSeq: entries[0]?.seq ?? 0,
      lastSeq: entries[entries.length - 1]?.seq ?? 0,
      lastChangeSeq,
      epoch,
    };
  },
  getFullEntry: (
    sessionId: string,
    entryId: string,
  ): Promise<TranscriptEntry | null> =>
    callTranscript({ op: "full_entry", sessionId, entryId }),
  getLastSeq: (sessionId: string): Promise<number> =>
    callTranscript({ op: "last_seq", sessionId }),
  getLastChangeSeq: (sessionId: string): Promise<number> =>
    callTranscript({ op: "last_change_seq", sessionId }),
  getLastResetChangeSeq: (sessionId: string): Promise<number> =>
    callTranscript({ op: "last_reset_change_seq", sessionId }),
  countEvents: (sessionId: string): Promise<number> =>
    callTranscript({ op: "count", sessionId }),
  summary: (
    sessionId: string,
  ): Promise<{ lastTs: number | null; seqHighWater: number } | null> =>
    callTranscript({ op: "summary", sessionId }),
  sessionIds: actorTranscriptSessionIds,
  appendTranscriptEvents,
  appendTranscriptDestination,
  importLegacyTranscript,
  replaceTranscriptEvents,
  deleteSessionTranscript,
};
