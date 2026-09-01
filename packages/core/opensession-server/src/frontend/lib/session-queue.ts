import type { TranscriptEntry } from "./types";
import {
  classifyQueuedContent,
  isClientVisibleQueuedContent,
  summarizeInFlightContent,
  type OptimisticTranscriptEntry,
} from "./transcript-state";
import {
  optimisticOutboxFallbacks,
  reconcilePending,
  withoutPendingTranscriptEchoes,
  type OptimisticPendingPrompt,
} from "./pending-reconcile";
import type { PromptOutboxItem } from "./prompt-outbox";

export interface QueueReceipt {
  id?: string;
  content: string;
  user?: string;
  images?: string[];
  files?: unknown;
  contextSessions?: string[];
  editable?: boolean;
  editing?: boolean;
  /** When the engine accepted this steer, in epoch milliseconds. */
  steeredAt?: number;
}

interface SessionQueueInput {
  queued: QueueReceipt[];
  steered: QueueReceipt[];
  pending: OptimisticPendingPrompt[];
  pendingDeliveryIds: string[];
  outboxItems: PromptOutboxItem[];
  landedOutboxIds: ReadonlySet<string>;
  entries: TranscriptEntry[];
  settingUpWorkspace: boolean;
  now: number;
}

const NO_OPTIMISTIC_ENTRIES: OptimisticTranscriptEntry[] = [];

export function queueDeleteLabel(classified: TranscriptEntry): string {
  if (classified.notice?.kind === "review-handoff")
    return "Dismiss review feedback";
  if (classified.notice?.kind === "worker-report")
    return "Dismiss worker report";
  if (classified.notice?.kind === "session-notice")
    return "Dismiss session message";
  return "Delete queued message";
}

export function deriveSessionQueue({
  queued,
  steered,
  pending,
  pendingDeliveryIds,
  outboxItems,
  landedOutboxIds,
  entries,
  settingUpWorkspace,
  now,
}: SessionQueueInput) {
  const failedOutboxIds = new Set(
    outboxItems
      .filter((item) => item.state === "failed")
      .map((item) => `outbox-${item.clientId}`),
  );
  const deliveryEchoes = [...queued, ...steered];
  const reconciliation = reconcilePending(
    pending,
    entries,
    deliveryEchoes,
    now,
  );
  const visiblePending = pending.filter(
    (item) =>
      !failedOutboxIds.has(item.id) &&
      !reconciliation.landed.has(item.id) &&
      !reconciliation.expired.has(item.id),
  );
  // Keep a pristine idle send on the optimistic transcript surface while the
  // React row, queue echo, and durable outbox settle on independent clocks.
  const fallbackCandidates = optimisticOutboxFallbacks(
    outboxItems,
    new Set(pending.map((item) => item.id)),
    landedOutboxIds,
  );
  const fallbackReconciliation = reconcilePending(
    fallbackCandidates,
    entries,
    deliveryEchoes,
    now,
  );
  const fallbackPending = fallbackCandidates.filter(
    (item) =>
      !fallbackReconciliation.landed.has(item.id) &&
      !fallbackReconciliation.expired.has(item.id),
  );
  const pendingQueue = [
    ...visiblePending.filter(
      (item) => item.busyMode === "queue" || settingUpWorkspace,
    ),
    ...(settingUpWorkspace ? fallbackPending : []),
  ];
  const pendingBubbles = [
    ...visiblePending.filter(
      (item) => item.busyMode !== "queue" && !settingUpWorkspace,
    ),
    ...(settingUpWorkspace ? [] : fallbackPending),
  ];
  const optimisticTranscriptEntries = pendingBubbles.length
    ? pendingBubbles.map<OptimisticTranscriptEntry>((item) => ({
        id: item.id,
        type: "user",
        content: item.content,
        timestamp: new Date(item.sentAt).toISOString(),
        optimisticAfterEntryId: item.transcriptAfterEntryId,
        optimisticAfterSeq: item.transcriptAfterSeq,
        sender: item.user,
        ...(item.images?.length ? { images: item.images } : {}),
      }))
    : NO_OPTIMISTIC_ENTRIES;
  const transcriptDeliveryIds = [
    ...pendingDeliveryIds,
    ...pendingBubbles
      .filter((item) => item.busyMode === "steer")
      .map((item) => item.id),
  ];
  const fallbackIds = new Set(fallbackCandidates.map((item) => item.id));
  const durableOutbox = outboxItems.filter(
    (item) =>
      item.state === "failed" ||
      (!fallbackIds.has(`outbox-${item.clientId}`) &&
        !pending.some((entry) => entry.id === `outbox-${item.clientId}`) &&
        !landedOutboxIds.has(`outbox-${item.clientId}`)),
  );
  // Admission briefly queues every send. Hide that echo while the same prompt
  // is still represented by an optimistic transcript bubble.
  const shownQueued = withoutPendingTranscriptEchoes(
    queued.filter((item) =>
      isClientVisibleQueuedContent(item.content, item.user),
    ),
    pendingBubbles,
  );
  const queuedClassified = shownQueued.map((item) =>
    classifyQueuedContent(item.content, item.user),
  );
  const summary = summarizeInFlightContent(queuedClassified);
  const queueCount =
    shownQueued.length + pendingQueue.length + durableOutbox.length;
  const queuedMessageCount =
    summary.messages + pendingQueue.length + durableOutbox.length;
  const queueTitle = settingUpWorkspace
    ? `Setting up workspace · ${queueCount} queued`
    : [
        queuedMessageCount
          ? `${queuedMessageCount} ${queuedMessageCount === 1 ? "message" : "messages"} queued`
          : null,
        summary.reviews
          ? `${summary.reviews} PR ${summary.reviews === 1 ? "review" : "reviews"} waiting`
          : null,
        summary.workerReports
          ? `${summary.workerReports} worker ${summary.workerReports === 1 ? "report" : "reports"} waiting`
          : null,
        summary.sessionMessages
          ? `${summary.sessionMessages} session ${summary.sessionMessages === 1 ? "message" : "messages"} waiting`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");

  return {
    pendingQueue,
    pendingBubbles,
    optimisticTranscriptEntries,
    pendingTranscriptDeliveryIds: transcriptDeliveryIds,
    durableOutbox,
    shownQueued,
    queuedClassified,
    queueCount,
    queueTitle,
  };
}
