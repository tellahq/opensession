/**
 * Prompt-queue state: messages sent while a run is in flight queue up and
 * deliver afterwards, the same way Claude Code handles interruptions.
 * Attachments ride along: `images` as composer `data:` URLs (parsed to
 * ImageInput at delivery), `files` as the raw composer payload (staged-path or
 * inline refs). Both are persisted with the queue so a restart doesn't
 * silently drop a message's attachments.
 *
 * This module owns the queue/receipt STATE and its persistence + broadcast.
 * The run-coupled operations (enqueue-and-arm-drain, steer, interrupt, drain)
 * live in run-session.ts — they need the runner.
 */

import { copyFileSync, existsSync, readFileSync, rmSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { setTranscriptAppendListener } from "./file-watcher";
import { splitPastedTexts } from "@tellahq/opensession-protocol/pasted-text";
import { stripContext } from "./prompt-context";
import { SESSIONS_DIR } from "./session-cache";
import { setAppendHook } from "./transcript-store";
import { stageFileAttachments, stageInlineImages } from "./uploads";
import type { TranscriptEntry } from "./types";
import { broadcastToSession } from "./ws-hub";
import { AUTO_CONTINUE_USER } from "./auto-continue";
import { delegatedActorParent, isWorkerActor } from "./session-actors";
import { userMatchesAny } from "./shared/user-mappings";
import {
  DeliveryOwnedMap,
  EphemeralSessionSet,
  markSessionDeliveryMigrationComplete,
  sessionDelivery,
  sessionDeliveryMigrationComplete,
  sessionKernel,
  sessionQuarantineSnapshot,
  sessionTurn,
  sessionTurnSnapshot,
} from "./session-kernel";
import type { DurableSteerTarget } from "./session-kernel/store";

const queueMigrationState = ((
  globalThis as typeof globalThis & {
    __opensessionQueueMigrationState?: { complete: boolean };
  }
).__opensessionQueueMigrationState ??= { complete: false });

export type QueueItem = {
  id?: string;
  /** Stable transcript UUID for a prompt that was accepted before a restart.
   * Reusing it lets a recovery upsert the existing visible user line instead
   * of rendering the message twice. */
  promptEntryId?: string;
  /** Actor-internal identity for a previously accepted multi-item dispatch.
   * The restored group drains atomically before later queue policy can split it. */
  retryDispatchId?: string;
  content: string;
  user?: string;
  images?: string[];
  files?: unknown;
  /** Display-only: pasted blocks lifted out of `content` by queueItemForClient.
   *  Stored items carry them folded inside `content` instead. */
  pastedTexts?: string[];
  /** Sibling-session transcript ids attached when this message starts a turn. */
  contextSessions?: string[];
  /** Slack thread this message came from — the turn's reply is mirrored back
   *  there (rides the queue + persistence so a busy run can't drop it). */
  slackReplyTo?: { channel: string; threadTs: string };
  /** Human composer send made while the agent was busy: held until the agent
   *  FULLY finishes (no run and no running child workers), not just until the
   *  next turn boundary. Orchestration items (worker reports, auto-continues,
   *  GitHub FYIs) leave it unset and flow at any boundary. */
  hold?: boolean;
  /** Review feedback must start its own turn after any user work already in
   * flight. Never batch it into that work or steer it mid-turn. */
  reviewHandoff?: boolean;
  /** When the engine ACCEPTED this message as a steer (epoch ms). Set by
   * acceptQueuedSteer, read by the clients to show how long the fold-in has been
   * waiting. Acceptance is not delivery: the current tool or assistant message
   * must reach its boundary, so a long tool call can hold the message for
   * minutes. */
  steeredAt?: number;
};
export const promptQueues = new DeliveryOwnedMap<QueueItem[]>("queued");

/** A batch removed from the queue and handed to the runner. It remains durable
 * until the runner has written its own active-run journal. This closes the
 * crash window between showing a user's message in the transcript and making
 * it recoverable on boot. */
export type PromptDispatch = {
  promptEntryId: string;
  items: QueueItem[];
  kind?: "create";
};
export const promptDispatches = new DeliveryOwnedMap<PromptDispatch>(
  "dispatch",
);

export function deliveryQueueState(
  sessionId: string,
  deliveryId: string,
): "queued" | "steered" | "dispatching" | undefined {
  const queued = promptQueues
    .get(sessionId)
    ?.find((item) => item.id === deliveryId);
  if (queued) return queued.promptEntryId ? "steered" : "queued";
  if (steeredReceipts.get(sessionId)?.some((item) => item.id === deliveryId))
    return "steered";
  if (
    promptDispatches
      .get(sessionId)
      ?.items.some((item) => item.id === deliveryId)
  )
    return "dispatching";
  return undefined;
}

export function isGitHubQueueItem(item?: QueueItem): boolean {
  return item?.user === "GitHub" || item?.user === "GitHub (automation)";
}

/** A worker session's report to its parent, waiting for the parent's turn to
 * end. It rides the same queue as human sends because it drives the parent's
 * next turn, but nobody typed it: it is one agent handing work back to
 * another. Treating it as a composer message gave it an Edit button and
 * counted it in "N messages queued", which is what made reports read as
 * something the human had said. Keyed on the `worker <id>` sender minted by
 * workerActor — the same signal send_to_session uses to deliver a report
 * verbatim instead of wrapping it as a notice. */
export function isWorkerQueueItem(item?: QueueItem): boolean {
  return isWorkerActor(item?.user);
}

/** Any message sent by another session, whether it is a parent-linked worker
 * report or a peer session's coordination prompt. */
export function isDelegatedQueueItem(item?: QueueItem): boolean {
  return delegatedActorParent(item?.user) !== null;
}

/** A workflow completion nudge is attributed to the person who launched the
 * workflow so the model receives the right identity, but it is still system
 * traffic. The sentinel is the durable origin marker shared with transcript
 * classification; do not let that attribution turn the nudge into an editable
 * composer message while it is waiting to land. */
export function isWorkflowQueueItem(item?: QueueItem): boolean {
  return /^\s*<!--os:workflow-notice(?::[^\s>]+)?-->/.test(item?.content ?? "");
}

/** Only ordinary composer messages can be moved back into a draft. Routed
 * items carry queue-only metadata that a composer send cannot reconstruct. */
export function isEditableQueueItem(item?: QueueItem): boolean {
  return (
    !!item &&
    !!item.user &&
    !isGitHubQueueItem(item) &&
    !isDelegatedQueueItem(item) &&
    !isWorkflowQueueItem(item) &&
    item.user !== AUTO_CONTINUE_USER &&
    !item.contextSessions?.length &&
    !item.slackReplyTo &&
    !item.reviewHandoff
  );
}

function queueActorMatches(item: QueueItem, actor?: string): boolean {
  return !!actor && !!item.user && userMatchesAny(actor, [item.user]);
}

/** Atomically remove an ordinary human message so a client can put its full
 * payload back in the normal composer. Routed/system items stay queue-owned. */
export async function takeQueuedPrompt(
  sessionId: string,
  queueId: string,
  actor?: string,
  effects = true,
): Promise<QueueItem | undefined> {
  const queue = promptQueues.get(sessionId);
  if (!queue) return;
  const index = queue.findIndex((candidate) => candidate.id === queueId);
  const item = queue[index];
  if (!isEditableQueueItem(item) || !item || !queueActorMatches(item, actor))
    return;
  queue.splice(index, 1);
  if (queue.length > 0) await promptQueues.set(sessionId, queue);
  else await promptQueues.delete(sessionId);
  if (effects) {
    persistQueues();
    await broadcastQueue(sessionId);
  }
  return item;
}

export function editableSteerReceipt(
  sessionId: string,
  queueId: string,
  actor?: string,
): QueueItem | undefined {
  const item = (steeredReceipts.get(sessionId) || []).find(
    (candidate) => candidate.id === queueId,
  );
  return isEditableQueueItem(item) && item && queueActorMatches(item, actor)
    ? item
    : undefined;
}

/** Remove a steer receipt only after the engine confirms the exact message is
 * still pending. The caller owns that ordering; this function owns auth and
 * durable receipt state. */
export async function takeSteeredPrompt(
  sessionId: string,
  queueId: string,
  actor?: string,
  effects = true,
): Promise<QueueItem | undefined> {
  const item = editableSteerReceipt(sessionId, queueId, actor);
  if (!item) return;
  const steered = steeredReceipts.get(sessionId);
  if (!steered) return;
  const next = steered.filter((candidate) => candidate.id !== queueId);
  if (next.length > 0) await steeredReceipts.set(sessionId, next);
  else await steeredReceipts.delete(sessionId);
  if (effects) {
    persistQueues();
    await broadcastQueue(sessionId);
  }
  return item;
}

// Steered messages (folded into a live run, delivered at the run's next turn
// boundary) aren't in promptQueues — the drain would re-deliver them. But until
// their turn lands they're invisible on reload, so we keep a display-only
// receipt here: shown as "folded in" in the UI and reconciled away once the real
// transcript entry appears. Cleared when the run finishes (or is cancelled).
export const steeredReceipts = new DeliveryOwnedMap<QueueItem[]>("steered");

// Sessions whose run the user explicitly stopped. The queue drain skips these:
// without the flag, stop would requeue the held steers and drainQueue would
// immediately deliver them into a fresh run — "stop then instantly resume".
// The actor's durable `stopped` run state is authoritative across restart;
// this in-memory projection keeps existing hot-path checks immediate.
export const stoppedSessions = new EphemeralSessionSet();

/** Durable Stop ownership survives a gateway restart until an explicit prompt
 * advances the actor run state out of `stopped`. */
export async function isUserStopped(sessionId: string): Promise<boolean> {
  const cancel = (await sessionTurnSnapshot(sessionId)).cancel;
  return (
    stoppedSessions.has(sessionId) ||
    sessionKernel(sessionId).runStateProjection().state === "stopped" ||
    cancel?.phase === "prepared" ||
    cancel?.phase === "executing"
  );
}

/**
 * Lift a Stop so this session's queue can drain again. Call this on any
 * explicit human send. The latch is normally lifted by runSessionPrompt, but
 * the drain is what calls that: a message sent after a Stop enters the durable
 * queue and drainQueueInner returns at the latch, so without this the message
 * is parked forever and reads as lost (most visible right after a create, when
 * the opening turn is stopped before it settles).
 */
export async function liftUserStop(sessionId: string): Promise<void> {
  stoppedSessions.delete(sessionId);
  if (sessionKernel(sessionId).runStateProjection().state === "stopped")
    // Intake only releases the durable Stop latch. The later physical run
    // reservation owns `prompt` -> `starting` and supplies its run token.
    // Advancing to `starting` here makes the intake busy-check observe its own
    // half-created run, queue the message, and wait forever for an engine owner
    // that was never started.
    await sessionKernel(sessionId).applyRunEvent({ event: "stop_lifted" });
}

// Both maps are persisted to disk so a real restart/crash (not just a hot
// reload, which keeps the globalThis maps) doesn't silently drop queued or
// just-steered messages. Queued prompts re-drain on boot; steer receipts stay
// display-only until their transcript entry lands or cancellation requeues them.
export const QUEUE_STORE = `${SESSIONS_DIR}/prompt-queues.json`;
export function queueItem(item: QueueItem): QueueItem & { id: string } {
  if (item.id) return item as QueueItem & { id: string };
  return { ...item, id: crypto.randomUUID() };
}

/**
 * A queued item as a client shows it: fenced <opensession:context> blocks
 * stripped, and pasted blocks lifted out of the content onto `pastedTexts` so
 * the flap shows the message and a take-back restores the chips. Display copy
 * only; the stored item keeps the folded content the model will receive.
 */
export function queueItemForClient<T extends QueueItem>(item: T): T {
  const shown = stripContext(item.content);
  const content =
    shown === item.content ? item.content : shown || "(auto-continue)";
  const split = splitPastedTexts(content);
  if (!split) return content === item.content ? item : { ...item, content };
  return {
    ...item,
    content: split.content,
    pastedTexts: [...(item.pastedTexts ?? []), ...split.pastedTexts],
  };
}

/** Store attachment references, never inline attachment bodies, in actor state. */
export function durableQueueItem(
  sessionId: string,
  item: QueueItem,
): QueueItem {
  const images = item.images?.length
    ? stageInlineImages(sessionId, item.images, "prompt-queues")
    : undefined;
  const files =
    Array.isArray(item.files) && item.files.length
      ? stageFileAttachments(sessionId, item.files)
      : undefined;
  return {
    ...item,
    ...(images?.length ? { images } : { images: undefined }),
    ...(files?.length ? { files } : { files: undefined }),
  };
}

export function queueWithIds(
  items: QueueItem[] | undefined,
  sessionId?: string,
): QueueItem[] {
  return (items || []).map((item) => {
    const owned = item.id ? item : queueItem(item);
    return sessionId ? durableQueueItem(sessionId, owned) : owned;
  });
}

function removeLegacyQueueStore(storePath = QUEUE_STORE): void {
  for (const path of [storePath, `${storePath}.bak`]) {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      console.error(
        `[queue] Failed to remove migrated queue store ${path}:`,
        error,
      );
    }
  }
}

export function persistQueues(storePath = QUEUE_STORE): void {
  try {
    // Custom paths are migration/test fixtures. The production JSON stopped
    // being a projection once the actor acknowledged its one-time import.
    if (storePath === QUEUE_STORE && queueMigrationState.complete) return;
    const entries = (m: Iterable<[string, QueueItem[]]>) =>
      Object.fromEntries(
        [...m]
          .map(([k, v]) => [k, queueWithIds(v)] as const)
          .filter(([, v]) => v.length > 0),
      );
    // Keep the previous copy as .bak before overwriting: if the store on disk
    // ever ends up unparsable, restorePromptQueues falls back to it instead of
    // silently dropping every queued message.
    if (existsSync(storePath)) {
      try {
        copyFileSync(storePath, `${storePath}.bak`);
      } catch {}
    }
    writeJsonAtomic(
      storePath,
      {
        queued: entries(promptQueues),
        steered: entries(steeredReceipts),
        dispatching: Object.fromEntries(promptDispatches),
      },
      false,
    );
  } catch (e) {
    console.error("[queue] Failed to persist prompt queues:", e);
  }
}

export type PersistedQueueState = {
  queued?: Record<string, QueueItem[]>;
  steered?: Record<string, QueueItem[]>;
  dispatching?: Record<string, PromptDispatch>;
};

function readPersistedQueueState(
  storePath: string,
): PersistedQueueState | null {
  try {
    return JSON.parse(readFileSync(storePath, "utf8"));
  } catch (e) {
    console.error("[queue] Failed to read persisted queues:", e);
    try {
      const recovered = JSON.parse(readFileSync(`${storePath}.bak`, "utf8"));
      console.warn("[queue] Recovered persisted queues from .bak");
      return recovered;
    } catch (backupError) {
      console.error(
        "[queue] Backup queue store unreadable too; queued messages lost:",
        backupError,
      );
      return null;
    }
  }
}

/** Load raw durable maps before the server accepts writes. Ownership and
 * transcript reconciliation happen after recovery identifies adopted runs. */
export async function hydratePersistedQueueState(
  storePath = QUEUE_STORE,
): Promise<number> {
  const migrateToKernel = storePath === QUEUE_STORE;
  const actorAuthority =
    migrateToKernel && (await sessionDeliveryMigrationComplete());
  if (migrateToKernel) queueMigrationState.complete = actorAuthority;
  if (actorAuthority) {
    removeLegacyQueueStore(storePath);
    // The first schema-29 boot rebuilds the durable sparse projection in
    // bounded retryable read turns. Finish that before the one mutating
    // pending-steer reconciliation so no isolated store is skipped.
    await sessionDelivery({ op: "entries", slot: "queued" });
    await sessionDelivery({ op: "settle_pending_steers" });
    const [queued, steered, dispatching] = await Promise.all([
      sessionDelivery({ op: "entries", slot: "queued" }),
      sessionDelivery({ op: "entries", slot: "steered" }),
      sessionDelivery({ op: "entries", slot: "dispatch" }),
    ]);
    return (
      [...queued, ...steered].reduce(
        (count, [, items]) => count + (items as unknown[]).length,
        0,
      ) + dispatching.length
    );
  }
  if (!existsSync(storePath)) {
    if (migrateToKernel) {
      await markSessionDeliveryMigrationComplete();
      queueMigrationState.complete = true;
      removeLegacyQueueStore(storePath);
    }
    return 0;
  }
  const data = readPersistedQueueState(storePath);
  if (!data) return 0;
  await promptQueues.clear();
  await steeredReceipts.clear();
  await promptDispatches.clear();
  for (const [sessionId, items] of Object.entries(data.queued || {})) {
    if (items?.length)
      await promptQueues.set(sessionId, queueWithIds(items, sessionId));
  }
  for (const [sessionId, items] of Object.entries(data.steered || {})) {
    if (items?.length)
      await steeredReceipts.set(sessionId, queueWithIds(items, sessionId));
  }
  for (const [sessionId, dispatch] of Object.entries(data.dispatching || {})) {
    if (dispatch?.promptEntryId && dispatch.items?.length) {
      await promptDispatches.set(sessionId, {
        promptEntryId: dispatch.promptEntryId,
        items: queueWithIds(dispatch.items, sessionId),
        ...(dispatch.kind === "create" ? { kind: "create" as const } : {}),
      });
    }
  }
  if (migrateToKernel) {
    await markSessionDeliveryMigrationComplete();
    queueMigrationState.complete = true;
    removeLegacyQueueStore(storePath);
  }
  return (
    [...promptQueues.values(), ...steeredReceipts.values()].reduce(
      (count, items) => count + items.length,
      0,
    ) + promptDispatches.size
  );
}

/** Restore queue-owned state without deciding when queued prompts should drain.
 * The caller supplies journal/session/transcript facts and arms drains for the
 * returned queuedSessionIds. */
export async function restorePersistedQueueState(options: {
  storePath?: string;
  sessionExists: (sessionId: string) => boolean;
  sessionQuarantined?: (sessionId: string) => boolean | Promise<boolean>;
  journalOwnsPrompt: (sessionId: string, promptEntryId: string) => boolean;
  creationOwnsPrompt?: (
    sessionId: string,
    promptEntryId: string,
  ) => boolean | Promise<boolean>;
  runOwnsSteers: (sessionId: string) => boolean;
  deliveredUserTexts: (sessionId: string) => string[] | Promise<string[]>;
  effects?: boolean;
}): Promise<{
  queuedSessionIds: string[];
  queuedCount: number;
  steeredCount: number;
}> {
  const storePath = options.storePath ?? QUEUE_STORE;
  const actorOwned =
    storePath === QUEUE_STORE && (await sessionDeliveryMigrationComplete());
  if (storePath === QUEUE_STORE) queueMigrationState.complete = actorOwned;
  const actorEntries = actorOwned
    ? await Promise.all([
        sessionDelivery({ op: "entries", slot: "queued" }),
        sessionDelivery({ op: "entries", slot: "steered" }),
        sessionDelivery({ op: "entries", slot: "dispatch" }),
      ])
    : undefined;
  const data: PersistedQueueState = actorOwned
    ? {
        queued: Object.fromEntries(actorEntries![0]) as Record<
          string,
          QueueItem[]
        >,
        steered: Object.fromEntries(actorEntries![1]) as Record<
          string,
          QueueItem[]
        >,
        dispatching: Object.fromEntries(actorEntries![2]) as Record<
          string,
          PromptDispatch
        >,
      }
    : (readPersistedQueueState(storePath) ?? {});
  if (
    !Object.keys(data.queued || {}).length &&
    !Object.keys(data.steered || {}).length &&
    !Object.keys(data.dispatching || {}).length
  )
    return { queuedSessionIds: [], queuedCount: 0, steeredCount: 0 };

  if (actorOwned) {
    const actorSessionIds = new Set([
      ...Object.keys(data.queued || {}),
      ...Object.keys(data.steered || {}),
      ...Object.keys(data.dispatching || {}),
    ]);
    const quarantined = new Set(
      (
        await Promise.all(
          [...actorSessionIds].map(async (sessionId) =>
            (await sessionQuarantineSnapshot(sessionId)) ||
            (await options.sessionQuarantined?.(sessionId))
              ? sessionId
              : undefined,
          ),
        )
      ).filter((sessionId): sessionId is string => !!sessionId),
    );
    const restorable = (sessionId: string) => !quarantined.has(sessionId);
    for (const sessionId of Object.keys(data.queued || {})) {
      if (!restorable(sessionId)) continue;
      if (!options.sessionExists(sessionId))
        await promptQueues.delete(sessionId);
    }
    for (const [sessionId, dispatch] of Object.entries(
      data.dispatching || {},
    )) {
      if (!restorable(sessionId)) continue;
      const creationOwned =
        dispatch.kind === "create" &&
        ((await options.creationOwnsPrompt?.(
          sessionId,
          dispatch.promptEntryId,
        )) ||
          !options.journalOwnsPrompt(sessionId, dispatch.promptEntryId));
      // Creation dispatches intentionally precede the session file. The actor
      // opening plan and effect remain their recovery authority in this window.
      if (creationOwned) continue;
      if (!options.sessionExists(sessionId)) {
        await promptDispatches.delete(sessionId);
        continue;
      }
      if (options.journalOwnsPrompt(sessionId, dispatch.promptEntryId))
        await acknowledgePromptDispatch(
          sessionId,
          dispatch.promptEntryId,
          false,
        );
      else await failPromptDispatch(sessionId, dispatch.promptEntryId, false);
    }

    for (const [sessionId, items] of Object.entries(data.steered || {})) {
      if (!restorable(sessionId)) continue;
      if (!options.sessionExists(sessionId)) {
        await steeredReceipts.delete(sessionId);
        continue;
      }
      const delivered = await options.deliveredUserTexts(sessionId);
      const pending = queueWithIds(
        undeliveredSteers(items, delivered),
        sessionId,
      );
      if (options.runOwnsSteers(sessionId)) {
        if (pending.length) await steeredReceipts.set(sessionId, pending);
        else await steeredReceipts.delete(sessionId);
      } else {
        await sessionDelivery({
          op: "requeue_steers",
          sessionId,
          items: pending,
        });
      }
    }
    const [finalQueued, finalSteered] = await Promise.all([
      sessionDelivery({ op: "entries", slot: "queued" }),
      sessionDelivery({ op: "entries", slot: "steered" }),
    ]);
    if (options.effects !== false) {
      persistQueues(storePath);
      for (const sessionId of new Set([
        ...finalQueued.map(([sessionId]) => sessionId),
        ...finalSteered.map(([sessionId]) => sessionId),
      ]))
        if (restorable(sessionId)) await broadcastQueue(sessionId);
    }
    const queuedSessionIds = finalQueued
      .map(([sessionId]) => sessionId)
      .filter(restorable);
    return {
      queuedSessionIds,
      queuedCount: finalQueued.reduce(
        (count, [sessionId, items]) =>
          count + (restorable(sessionId) ? (items as unknown[]).length : 0),
        0,
      ),
      steeredCount: finalSteered.reduce(
        (count, [sessionId, items]) =>
          count + (restorable(sessionId) ? (items as unknown[]).length : 0),
        0,
      ),
    };
  }

  const liveDispatches = new Map(promptDispatches);
  const preservedDispatches = new Map<string, PromptDispatch>();
  const queued = new Map<string, QueueItem[]>();
  for (const [sessionId, items] of Object.entries(data.queued || {})) {
    if (options.sessionExists(sessionId) && items?.length) {
      queued.set(sessionId, queueWithIds(items, sessionId));
    }
  }
  for (const [sessionId, dispatch] of Object.entries(data.dispatching || {})) {
    const live = liveDispatches.get(sessionId);
    if (
      dispatch?.kind === "create" &&
      dispatch.promptEntryId &&
      ((await options.creationOwnsPrompt?.(
        sessionId,
        dispatch.promptEntryId,
      )) ||
        !options.journalOwnsPrompt(sessionId, dispatch.promptEntryId))
    ) {
      const createDispatch: PromptDispatch =
        live?.kind === "create" && live.promptEntryId === dispatch.promptEntryId
          ? live
          : {
              promptEntryId: dispatch.promptEntryId,
              items: queueWithIds(dispatch.items, sessionId),
              kind: "create",
            };
      preservedDispatches.set(sessionId, createDispatch);
      const remaining = (queued.get(sessionId) || []).filter(
        (item) =>
          item.id !== createDispatch.promptEntryId &&
          item.promptEntryId !== createDispatch.promptEntryId,
      );
      if (remaining.length) queued.set(sessionId, remaining);
      else queued.delete(sessionId);
      continue;
    }
    if (
      !options.sessionExists(sessionId) ||
      !dispatch?.items?.length ||
      !dispatch.promptEntryId ||
      options.journalOwnsPrompt(sessionId, dispatch.promptEntryId)
    ) {
      continue;
    }
    const items = dispatch.items.map((item, index) => ({
      ...item,
      retryDispatchId: dispatch.promptEntryId,
      ...(index === 0 ? { promptEntryId: dispatch.promptEntryId } : {}),
    }));
    queued.set(sessionId, [...items, ...(queued.get(sessionId) || [])]);
  }

  await promptQueues.clear();
  await steeredReceipts.clear();
  await promptDispatches.clear();
  for (const [sessionId, dispatch] of preservedDispatches)
    await promptDispatches.set(sessionId, dispatch);
  for (const [sessionId, items] of queued)
    await promptQueues.set(sessionId, items);

  let steeredCount = 0;
  for (const [sessionId, items] of Object.entries(data.steered || {})) {
    if (!options.sessionExists(sessionId) || !items?.length) continue;
    const delivered = await options.deliveredUserTexts(sessionId);
    const pending = queueWithIds(
      undeliveredSteers(items, delivered),
      sessionId,
    );
    if (!pending.length) continue;
    if (options.runOwnsSteers(sessionId)) {
      await steeredReceipts.set(sessionId, pending);
      steeredCount += pending.length;
    } else {
      queued.set(sessionId, [...pending, ...(queued.get(sessionId) || [])]);
      await promptQueues.set(sessionId, queued.get(sessionId)!);
    }
  }

  if (options.effects !== false) {
    persistQueues(storePath);
    for (const sessionId of new Set([
      ...promptQueues.keys(),
      ...steeredReceipts.keys(),
    ])) {
      await broadcastQueue(sessionId);
    }
  }
  return {
    queuedSessionIds: [...promptQueues.keys()],
    queuedCount: [...promptQueues.values()].reduce(
      (n, items) => n + items.length,
      0,
    ),
    steeredCount,
  };
}

/** Persist the interrupt before attempting its physical cancellation. */
export async function preparePromptInterrupt(
  sessionId: string,
  anchorId: string,
  dispatchId: string,
  soloId?: string,
): Promise<string> {
  const interruptId = `interrupt:${new Bun.CryptoHasher("sha256")
    .update(`${sessionId}\0${anchorId}`)
    .digest("hex")}`;
  await sessionDelivery({
    op: "prepare_interrupt",
    sessionId,
    interruptId,
    anchorId,
    dispatchId,
    ...(soloId ? { soloId } : {}),
  });
  return interruptId;
}

export async function beginPromptInterruptEffect(
  sessionId: string,
  interruptId: string,
  runGeneration: number,
): Promise<"execute" | "retry" | "adopt_confirmed" | "confirmed" | "settled"> {
  return sessionDelivery({
    op: "begin_interrupt_effect",
    sessionId,
    interruptId,
    runGeneration,
  });
}

export async function settlePromptInterrupt(
  sessionId: string,
  interruptId: string,
  outcome: "confirmed" | "not_aborted",
): Promise<void> {
  const settled = await sessionDelivery({
    op: "settle_interrupt",
    sessionId,
    interruptId,
    outcome,
  });
  if (!settled)
    throw new Error(`Prompt interrupt ${interruptId} lost actor ownership`);
}

/** Let the actor select and claim the next queue batch in one transaction. */
export async function beginNextPromptDispatch(
  sessionId: string,
  opts: {
    stillWorking?: boolean;
  },
  effects = true,
): Promise<
  | { kind: "empty" }
  | { kind: "hold"; heldCount: number }
  | {
      kind: "deliver";
      promptEntryId: string;
      batch: QueueItem[];
      interrupted: boolean;
    }
> {
  const claimed = await sessionDelivery({
    op: "claim_next_dispatch",
    sessionId,
    promptEntryId: crypto.randomUUID(),
    ...opts,
  });
  if (claimed.kind !== "deliver") return claimed;
  if (effects) persistQueues();
  return {
    kind: "deliver",
    promptEntryId: claimed.promptEntryId,
    batch: claimed.items as QueueItem[],
    interrupted: claimed.interrupted,
  };
}

/** Move a selected queue batch into durable dispatching state before starting
 * runner work. The caller has already removed the batch from promptQueues, so
 * this single persistence point records either the old queued copy (if we die
 * before it) or the dispatching copy (if we die after it). */
export async function beginPromptDispatch(
  sessionId: string,
  items: QueueItem[],
  promptEntryId = items.length === 1 ? items[0]?.promptEntryId : undefined,
  effects = true,
  kind?: "create",
  requireQueued = false,
): Promise<string> {
  const id = promptEntryId || crypto.randomUUID();
  const durableItems = queueWithIds(items, sessionId);
  await sessionDelivery({
    op: "claim_dispatch",
    sessionId,
    items: durableItems,
    promptEntryId: id,
    ...(kind ? { kind } : {}),
    ...(requireQueued ? { requireQueued: true } : {}),
  });
  if (effects) persistQueues();
  return id;
}

/** The engine's active-run journal is now durable, so it owns recovery and the
 * intake dispatch record can be removed. */
export async function acknowledgePromptDispatch(
  sessionId: string | undefined,
  promptEntryId: string | undefined,
  effects = true,
): Promise<void> {
  if (!sessionId || !promptEntryId) return;
  const acknowledged = await sessionDelivery({
    op: "ack_dispatch",
    sessionId,
    promptEntryId,
  });
  if (acknowledged && effects) {
    persistQueues();
    await broadcastQueue(sessionId);
  }
}

/** A runner failed before it adopted the dispatch. Restore its exact batch
 * atomically ahead of later queued work. */
export async function failPromptDispatch(
  sessionId: string,
  promptEntryId: string,
  effects = true,
): Promise<boolean> {
  const restored = await sessionDelivery({
    op: "fail_dispatch",
    sessionId,
    promptEntryId,
  });
  if (restored && effects) {
    persistQueues();
    await broadcastQueue(sessionId);
  }
  return restored;
}

/** Restore a pre-journal dispatch that has no physical or recovery owner.
 *
 * Boot normally settles this slot. A gateway handoff can nevertheless lose the
 * process between the actor's dispatch claim and runner admission, while the
 * next gateway has already completed its one-time restore pass. The next
 * queued message is then blocked by the old dispatch forever. Recheck live
 * ownership after the authoritative snapshot so a racing runner cannot be
 * mistaken for that orphan. Creation dispatches keep their separate durable
 * creation owner and are never repaired here. */
export async function recoverUnownedPromptDispatch(
  sessionId: string,
  ownerActive: () => boolean,
): Promise<boolean> {
  if (ownerActive()) return false;
  const snapshot = await sessionDelivery({ op: "snapshot", sessionId });
  const dispatch = snapshot.dispatch as PromptDispatch | undefined;
  if (!dispatch?.promptEntryId || dispatch.kind === "create" || ownerActive())
    return false;
  return failPromptDispatch(sessionId, dispatch.promptEntryId);
}

/** Automated turns stay durable in the queue but are not messages a person
 * sent. Review handoffs have their own Agents surface; workflow completion
 * nudges and auto-continues are model-routing plumbing. None belongs in message
 * counts or chips. */
function isClientVisibleQueueItem(item: QueueItem): boolean {
  return (
    // A stable prompt entry means this message has already been accepted into
    // the conversation. It may remain queue-owned as next-turn delivery
    // plumbing, but it must never move back above the composer.
    !item.promptEntryId &&
    !item.reviewHandoff &&
    !isWorkflowQueueItem(item) &&
    item.user !== AUTO_CONTINUE_USER &&
    // Background waits and other fenced system context are runner plumbing,
    // not messages a person queued. If transcript sanitization leaves no
    // visible body, do not expose the receipt as "(auto-continue)".
    stripContext(item.content).trim().length > 0
  );
}

export function clientVisibleQueuedCount(sessionId: string): number {
  return (promptQueues.get(sessionId) ?? []).filter(isClientVisibleQueueItem)
    .length;
}

/** One actor snapshot for list rendering, instead of one RPC per session. */
export async function clientVisibleQueuedCounts(): Promise<
  Map<string, number>
> {
  const counts = new Map<string, number>();
  for (const [sessionId, value] of await sessionDelivery({
    op: "entries",
    slot: "queued",
  })) {
    const items = value as QueueItem[];
    const visible = items.filter(isClientVisibleQueueItem).length;
    if (visible) counts.set(sessionId, visible);
  }
  return counts;
}

export async function queueDisplayState(sessionId: string) {
  const snapshot = await sessionDelivery({ op: "snapshot", sessionId });
  const queued = queueWithIds(snapshot.queued as QueueItem[]);
  const steered = queueWithIds(snapshot.steered as QueueItem[]);
  const pendingSteers = snapshot.pendingSteers
    .map((pending) => pending.item as QueueItem)
    .filter(Boolean);
  const dispatching =
    (snapshot.dispatch as PromptDispatch | undefined)?.items ?? [];
  // Display copy only: automated turns remain in the internal queue until
  // dispatch but never enter a client's message surface. The stored items
  // keep their full content for delivery.
  const forDisplay = (items: typeof queued) =>
    items.filter(isClientVisibleQueueItem).map((i) => ({
      ...queueItemForClient(i),
      editable: isEditableQueueItem(i),
    }));
  const pendingDeliveryIds = [
    ...queued,
    ...steered,
    ...pendingSteers,
    ...dispatching,
  ]
    .filter((item) => !!item.promptEntryId)
    .map((item) => item.promptEntryId || item.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return {
    queued: forDisplay(queued),
    steered: forDisplay(steered),
    ...(pendingDeliveryIds.length
      ? { pendingDeliveryIds: [...new Set(pendingDeliveryIds)] }
      : {}),
  };
}

export async function broadcastQueue(sessionId: string): Promise<void> {
  broadcastToSession(sessionId, {
    type: "queue_update",
    sessionId,
    ...(await queueDisplayState(sessionId)),
  });
}

/** Mark one item as already sent and put it at the front of actor-owned
 * delivery. It remains queue-shaped recovery state, but promptEntryId keeps it
 * out of the composer while the current run finishes or reconnects. */
export async function promoteQueuedPrompt(
  sessionId: string,
  itemId: string,
  promptEntryId: string,
  item?: QueueItem,
): Promise<QueueItem | undefined> {
  const promoted = await sessionDelivery({
    op: "promote_queued",
    sessionId,
    itemId,
    promptEntryId,
    ...(item ? { item } : {}),
  });
  if (promoted) {
    persistQueues();
    await broadcastQueue(sessionId);
  }
  return promoted as QueueItem | undefined;
}

export async function prepareQueuedSteer(
  sessionId: string,
  itemId: string,
  target: DurableSteerTarget,
  directItem?: QueueItem,
): Promise<QueueItem | undefined> {
  return (await sessionDelivery({
    op: "prepare_steer",
    sessionId,
    itemId,
    target,
    ...(directItem ? { item: directItem } : {}),
  })) as QueueItem | undefined;
}

export async function acceptQueuedSteer(
  sessionId: string,
  itemId: string,
  target: DurableSteerTarget,
): Promise<boolean> {
  const accepted = await sessionDelivery({
    op: "accept_steer",
    sessionId,
    itemId,
    target,
  });
  if (accepted) {
    persistQueues();
    await broadcastQueue(sessionId);
  }
  return accepted;
}

export async function rejectQueuedSteer(
  sessionId: string,
  itemId: string,
  target: DurableSteerTarget,
): Promise<boolean> {
  const rejected = await sessionDelivery({
    op: "reject_steer",
    sessionId,
    itemId,
    target,
  });
  if (rejected) {
    persistQueues();
    await broadcastQueue(sessionId);
  }
  return rejected;
}

/** Retire one exact receipt when the engine reports that it crossed the step
 * boundary. This is authoritative even when the delivered message is fenced
 * system context that transcript parsing intentionally hides. */
export async function acknowledgeSteerDelivery(
  sessionId: string,
  steerId: string,
  effects = true,
): Promise<boolean> {
  const steered = steeredReceipts.get(sessionId);
  if (!steered?.some((item) => item.id === steerId)) return false;
  const remaining = steered.filter((item) => item.id !== steerId);
  if (remaining.length > 0) await steeredReceipts.set(sessionId, remaining);
  else await steeredReceipts.delete(sessionId);
  if (effects) {
    persistQueues();
    await broadcastQueue(sessionId);
  }
  return true;
}

/** Clear a session's steer receipts once the run that owned them is done. */
export async function clearSteerReceipts(sessionId: string): Promise<void> {
  if (!steeredReceipts.has(sessionId)) return;
  await steeredReceipts.delete(sessionId);
  persistQueues();
  await broadcastQueue(sessionId);
}

/**
 * Take back the receipt for a steer the engine bounced (`steer_failed`), so
 * the caller can put that message where it actually is: the queue.
 *
 * The receipt and the queue are the two halves of one invariant. A message is
 * in promptQueues OR in steeredReceipts, never both, because "Steered" claims
 * the running turn already has it while a queued row promises a future turn
 * will. A rescue that only enqueues leaves the panel asserting both at once.
 *
 * Match on the ATTRIBUTED form as well as the raw one: the host echoes back
 * the exact string it was handed, which is what steerQueuedPrompt composed
 * (`[Name] text`), while the receipt stores content and user separately.
 * Returning the ORIGINAL item is the point. Re-queueing the echoed string
 * would store the prefix inside content, where a multi-item drain attributes
 * it a second time and the delivered-steer reconcile can never match it.
 *
 * Undefined = no receipt matched, and the caller owns the fallback. Pass
 * effects=false when a following queue write will persist and broadcast, so
 * watchers see one consistent update rather than a moment with the message
 * in neither place.
 */
export async function takeSteerReceiptForText(
  sessionId: string,
  text: string,
  effects = true,
): Promise<QueueItem | undefined> {
  const steered = steeredReceipts.get(sessionId);
  if (!steered?.length) return undefined;
  const wanted = text.trim();
  // First match only: two identical steers are two messages, and one bounce
  // retires exactly one of them (same one-for-one rule as undeliveredSteers).
  const index = steered.findIndex((item) => {
    const raw = item.content.trim();
    return (
      raw === wanted || (!!item.user && `[${item.user}] ${raw}` === wanted)
    );
  });
  if (index < 0) return undefined;
  const [item] = steered.splice(index, 1);
  if (steered.length > 0) await steeredReceipts.set(sessionId, steered);
  else await steeredReceipts.delete(sessionId);
  if (effects) {
    persistQueues();
    await broadcastQueue(sessionId);
  }
  return item;
}

// Clear a steer receipt the moment its message lands in the transcript (the
// file-watcher reports appended entries). Waiting for run end left delivered
// messages showing as "queued" whenever the client's transcript tail didn't
// reach back to their user entry — and a mid-run restart would have re-queued
// (re-delivered) them via restorePromptQueues. Matches the frontend reconcile:
// exact attributed form, or containment for turns joined at one boundary.
// Registered at module scope so every hot reload re-installs the current code.
/** Whether a steer receipt's message already appears among the transcript's
 *  user texts (same matching as the frontend reconcile: exact attributed
 *  form, or containment for turns joined at one boundary). */
export function steerDelivered(item: QueueItem, userTexts: string[]): boolean {
  // Early-persisted steers appear in the conversation before the engine reads
  // them. Their exact steer_delivered acknowledgement, not transcript text,
  // retires the receipt.
  if (item.promptEntryId) return false;
  const attributed = (
    item.user ? `[${item.user}] ${item.content}` : item.content
  ).trim();
  return userTexts.some((text) => userTextContainsSteer(text, attributed));
}

function userTextContainsSteer(text: string, attributed: string): boolean {
  return steerRange(text, attributed) !== null;
}

function steerRange(text: string, attributed: string): [number, number] | null {
  let start = text.indexOf(attributed);
  while (start >= 0) {
    const end = start + attributed.length;
    const startsAtBoundary =
      start === 0 || text.slice(start - 2, start) === "\n\n";
    const endsAtBoundary =
      end === text.length || text.slice(end, end + 2) === "\n\n";
    if (startsAtBoundary && endsAtBoundary) return [start, end];
    start = text.indexOf(attributed, start + 1);
  }
  return null;
}

/** Match receipts to transcript entries one-for-one. Two identical steers need
 * two landed user entries; one transcript occurrence cannot retire both. */
export function undeliveredSteers(
  items: QueueItem[],
  userTexts: string[],
): QueueItem[] {
  if (!userTexts.length) return items;
  const remainingTexts = [...userTexts];
  return items.filter((item) => {
    if (item.promptEntryId) return true;
    const attributed = (
      item.user ? `[${item.user}] ${item.content}` : item.content
    ).trim();
    const textIndex = remainingTexts.findIndex(
      (text) => steerRange(text, attributed) !== null,
    );
    if (textIndex < 0) return true;
    const range = steerRange(remainingTexts[textIndex], attributed)!;
    const text = remainingTexts[textIndex];
    remainingTexts[textIndex] =
      text.slice(0, range[0]) +
      "\0".repeat(attributed.length) +
      text.slice(range[1]);
    return false;
  });
}

async function reconcileSteerReceiptsOnAppend(
  sessionId: string,
  entries: TranscriptEntry[],
): Promise<void> {
  const steered = steeredReceipts.get(sessionId);
  if (!steered?.length) return;
  const users = entries
    .filter((e) => e.type === "user")
    .map((e) => e.content.trim());
  if (users.length === 0) return;
  const remaining = undeliveredSteers(steered, users);
  if (remaining.length === steered.length) return;
  if (remaining.length > 0) await steeredReceipts.set(sessionId, remaining);
  else await steeredReceipts.delete(sessionId);
  persistQueues();
  await broadcastQueue(sessionId);
}

setTranscriptAppendListener(reconcileSteerReceiptsOnAppend);
// Transcript v2 (docs/transcripts.md §4a): v2 viewers retire the
// mirror file-watcher, so delivered-steer reconciliation ALSO rides the
// store's post-commit append hook (same contract, same function; fires only
// when the flag-gated store path writes). Single globalThis slot — each hot
// reload replaces the registration rather than stacking, and the reconcile
// is idempotent, so both channels firing for one append is harmless.
setAppendHook(reconcileSteerReceiptsOnAppend);

/**
 * Put unread steers back into actor-owned next-turn delivery when their run
 * ends or is cancelled. New sent-in-chat receipts carry promptEntryId and are
 * retired only by the engine's exact steer_delivered event; their early visible
 * transcript row is not evidence that the model read them. Legacy receipts
 * without that id still reconcile against engine user text during rollout.
 */
export async function requeueSteerReceipts(
  sessionId: string,
  deliveredUserTexts?: string[],
  effects = true,
): Promise<number> {
  const steered = steeredReceipts.get(sessionId);
  if (!steered?.length) return 0;
  const undelivered = undeliveredSteers(steered, deliveredUserTexts || []);
  await sessionDelivery({
    op: "requeue_steers",
    sessionId,
    items: undelivered,
  });
  if (effects) {
    persistQueues();
    await broadcastQueue(sessionId);
  }
  return undelivered.length;
}

export function queuedPromptIndex(
  queue: QueueItem[],
  queueId?: string,
  queueIndex?: number,
): number {
  if (queueId) {
    return queue.findIndex((item) => item.id === queueId);
  }
  if (
    typeof queueIndex === "number" &&
    Number.isInteger(queueIndex) &&
    queueIndex >= 0 &&
    queueIndex < queue.length
  ) {
    return queueIndex;
  }
  return -1;
}

export async function deleteQueuedPrompt(
  sessionId: string,
  queueId?: string,
  queueIndex?: number,
  effects = true,
): Promise<boolean> {
  const queue = promptQueues.get(sessionId);
  if (queue) {
    const index = queuedPromptIndex(queue, queueId, queueIndex);
    if (index >= 0) {
      const next = queue.filter((_, i) => i !== index);
      if (next.length > 0) await promptQueues.set(sessionId, next);
      else await promptQueues.delete(sessionId);
      if (effects) {
        persistQueues();
        await broadcastQueue(sessionId);
      }
      return true;
    }
  }
  // Steer receipts are dismissable too (by id only — indexes are queue-
  // relative). A receipt normally reconciles away when its message lands,
  // but it lives server-side until the run finishes; on a long run a stale
  // one must be deletable without waiting for that.
  if (queueId) {
    const steered = steeredReceipts.get(sessionId);
    const index = (steered || []).findIndex((item) => item.id === queueId);
    if (steered && index >= 0) {
      const next = steered.filter((_, i) => i !== index);
      if (next.length > 0) await steeredReceipts.set(sessionId, next);
      else await steeredReceipts.delete(sessionId);
      if (effects) {
        persistQueues();
        await broadcastQueue(sessionId);
      }
      return true;
    }
  }
  return false;
}

/** Compatibility path for clients shipped before queued messages moved back
 * into the normal composer. Current clients use takeQueuedPrompt instead. */
export async function updateQueuedPrompt(
  sessionId: string,
  queueId: string | undefined,
  queueIndex: number | undefined,
  content: string,
  images?: string[],
): Promise<boolean> {
  const queue = promptQueues.get(sessionId);
  if (!queue) return false;
  const index = queuedPromptIndex(queue, queueId, queueIndex);
  if (index < 0) return false;
  const item = queue[index];
  if (!item || isGitHubQueueItem(item)) return false;
  item.content = content;
  if (images) {
    if (images.length > 0) item.images = images;
    else delete item.images;
  }
  if (
    !item.content.trim() &&
    !item.images?.length &&
    !(Array.isArray(item.files) && item.files.length > 0)
  ) {
    queue.splice(index, 1);
  }
  if (queue.length > 0) await promptQueues.set(sessionId, queue);
  else await promptQueues.delete(sessionId);
  persistQueues();
  await broadcastQueue(sessionId);
  return true;
}

/**
 * Reorder a session's queue to match `order` (queue-item ids in their new send
 * order). Items named in `order` are placed first in that order; any queued item
 * not named — one that arrived after the client took its snapshot — keeps its
 * relative position at the tail, so a racing enqueue is never dropped. No-ops
 * (unknown session, <2 items, or an order that doesn't change anything) return
 * false without a broadcast.
 */
export async function reorderQueuedPrompt(
  sessionId: string,
  order: string[],
  effects = true,
): Promise<boolean> {
  const queue = promptQueues.get(sessionId);
  if (!queue || queue.length < 2) return false;
  const byId = new Map(
    queue.filter((it) => it.id).map((it) => [it.id!, it] as const),
  );
  const placed = new Set<string>();
  const next: QueueItem[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item && !placed.has(id)) {
      next.push(item);
      placed.add(id);
    }
  }
  for (const item of queue) {
    if (!item.id || !placed.has(item.id)) next.push(item);
  }
  // Same references in the same slots ⇒ nothing moved.
  if (next.every((item, i) => item === queue[i])) return false;
  await promptQueues.set(sessionId, next);
  if (effects) {
    persistQueues();
    await broadcastQueue(sessionId);
  }
  return true;
}
