export type SessionKernelStoreRoute =
  | { scope: "global" }
  | { scope: "session"; sessionId: string; mutation: boolean }
  | { scope: "outbox"; id: number; mutation: boolean };

const GLOBAL_METHODS = new Set([
  "actorTranscriptSessionIds",
  "askMigrationComplete",
  "markAskMigrationComplete",
  "deliveryMigrationComplete",
  "markDeliveryMigrationComplete",
  "askEntries",
  "clearAskRecords",
  "deliveryEntries",
  "clearDeliverySlot",
  "settlePendingSteers",
  "quarantinedSessions",
  "stats",
  "compact",
  "maintain",
  "deadLetters",
]);

const SESSION_FIRST_METHODS = new Set([
  "command",
  "quarantinedSession",
  "quarantineSession",
  "releaseQuarantine",
  "markProcessing",
  "completeCommand",
  "failCommand",
  "creationState",
  "runState",
  "appendChange",
  "changesSince",
  "isTombstoned",
  "tombstoneSession",
  "clearSession",
  "askSnapshot",
  "setAskRecord",
  "answerAskRecord",
  "deleteAskRecord",
  "turnSnapshot",
  "deliverySnapshot",
  "setDeliverySlot",
  "deleteDeliverySlot",
  "prepareSteerDelivery",
  "acceptSteerDelivery",
  "rejectSteerDelivery",
  "requeueSteerDeliveries",
  "ackDeliveryDispatch",
  "failDeliveryDispatch",
  "timer",
  "cancelTimer",
  "settleTimerSuccess",
  "noteTimerFailure",
  "acknowledgeCommand",
  "discardDeadTimer",
  "retryDeadTimer",
  "enqueueOutbox",
  "enqueueOutboxMany",
]);

const SESSION_INPUT_METHODS = new Set([
  "agentOperationCancellationIntent",
  "acceptCommand",
  "completeCommandDecision",
  "setRunState",
  "scheduleTimer",
  "requestGatewayCommand",
  "completeGatewayCommand",
  "failGatewayCommand",
  "requestSubmitPromptCommand",
  "completeSubmitPromptCommand",
  "failSubmitPromptCommand",
  "requestTurnCancelCommand",
  "completeTurnCancelCommand",
  "failTurnCancelCommand",
  "prepareTurnCancel",
  "beginTurnCancelEffect",
  "settleTurnCancel",
  "prepareTurnOutcomeProjection",
  "beginTurnOutcomeProjection",
  "settleTurnOutcomeProjection",
  "prepareDeliveryInterrupt",
  "beginDeliveryInterruptEffect",
  "settleDeliveryInterrupt",
  "claimNextDeliveryDispatch",
  "claimDeliveryDispatch",
  "beginTimerExecution",
  "completeTimerExecution",
  "failTimerExecution",
  "recordTimerRuntimeFailure",
]);

const OUTBOX_ID_METHODS = new Set([
  "outboxSessionId",
  "ackOutbox",
  "deferOutbox",
  "noteOutboxFailure",
  "discardDeadOutbox",
  "retryDeadOutbox",
]);

export const READ_METHODS = new Set([
  "actorTranscriptSessionIds",
  "command",
  "quarantinedSession",
  "creationState",
  "runState",
  "changesSince",
  "isTombstoned",
  "askSnapshot",
  "askEntries",
  "turnSnapshot",
  "deliverySnapshot",
  "deliveryEntries",
  "quarantinedSessions",
  "stats",
  "deadLetters",
  "timer",
  "outboxSessionId",
  "askMigrationComplete",
  "deliveryMigrationComplete",
]);

/** The single routing registry for the compatibility store surface. */
export function sessionKernelStoreRoute(
  method: string,
  args: unknown[],
): SessionKernelStoreRoute {
  if (GLOBAL_METHODS.has(method)) return { scope: "global" };
  if (OUTBOX_ID_METHODS.has(method)) {
    const id = Number(args[0]);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new Error(`Store method ${method} requires an outbox id`);
    return { scope: "outbox", id, mutation: !READ_METHODS.has(method) };
  }
  if (SESSION_FIRST_METHODS.has(method)) {
    const sessionId = args[0];
    if (typeof sessionId !== "string" || !sessionId)
      throw new Error(`Store method ${method} requires a session id`);
    return { scope: "session", sessionId, mutation: !READ_METHODS.has(method) };
  }
  if (SESSION_INPUT_METHODS.has(method)) {
    const input = args[0] as { sessionId?: unknown } | undefined;
    if (typeof input?.sessionId !== "string" || !input.sessionId)
      throw new Error(`Store method ${method} requires a session id`);
    return { scope: "session", sessionId: input.sessionId, mutation: true };
  }
  throw new Error(`Unrouted session kernel store method ${method}`);
}
