export interface RevertIntent {
  intentId: string;
  targetTurnId: string;
  revertedEntryRange: { fromSeq: number; toSeq: number };
  checkpointRef: string;
  preRevertRef: string;
  expectedHead: string;
  expectedIndexTree: string;
  fromEngineSessionId: string;
  toEngineSessionId: string;
  operation: "revert" | "undo";
  phase: "begun" | "files_restored";
  createdAt: string;
}
export interface RevertState {
  engineSessionId?: string;
  intent: RevertIntent | null;
  lastRevert: RevertIntent | null;
}
export type RevertActorRequest = { sessionId: string } & (
  | { op: "begin"; intent: Omit<RevertIntent, "phase" | "createdAt"> }
  | { op: "get" }
  | { op: "reconcile" }
  | { op: "mark_files_restored"; intentId: string }
  | { op: "complete" | "undo_last"; intentId: string }
  | { op: "rollback"; intentId: string; reason: string }
);
export type RevertMutationResult =
  | {
      status: "committed" | "duplicate";
      state: RevertState;
      wakeCursor?: number;
    }
  | {
      status: "refused";
      reason:
        | "run_active"
        | "queued_work"
        | "intent_exists"
        | "intent_missing"
        | "engine_changed"
        | "undo_unavailable"
        | "turn_missing";
      state: RevertState;
    };
export type RevertActorResult<T extends RevertActorRequest> = T extends {
  op: "get";
}
  ? RevertState
  : RevertMutationResult;
export function assertRevertRequest(request: RevertActorRequest): void {
  if (
    !request ||
    typeof request !== "object" ||
    ![
      "get",
      "reconcile",
      "begin",
      "mark_files_restored",
      "complete",
      "undo_last",
      "rollback",
    ].includes(request.op) ||
    Buffer.byteLength(JSON.stringify(request)) > 32 * 1024
  )
    throw new Error("Invalid revert request");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(request.sessionId))
    throw new Error("Invalid revert session");
  if (request.op === "get" || request.op === "reconcile") return;
  if (
    request.op === "begin" &&
    (!request.intent || typeof request.intent !== "object")
  )
    throw new Error("Invalid revert intent");
  const id =
    request.op === "begin" ? request.intent.intentId : request.intentId;
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id))
    throw new Error("Invalid revert identity");
  if (request.op !== "begin") return;
  const i = request.intent;
  if (
    !["revert", "undo"].includes(i.operation) ||
    !/^[a-f0-9]{40,64}$/.test(i.expectedHead) ||
    !/^[a-f0-9]{40,64}$/.test(i.expectedIndexTree)
  )
    throw new Error("Invalid revert fence");
  for (const ref of [i.checkpointRef, i.preRevertRef])
    if (
      !ref.startsWith(`refs/opensession/turns/${request.sessionId}/`) ||
      !/^refs\/[A-Za-z0-9_/-]+$/.test(ref)
    )
      throw new Error("Invalid revert checkpoint ref");
  for (const engine of [i.fromEngineSessionId, i.toEngineSessionId])
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(engine))
      throw new Error("Invalid revert engine id");
  const r = i.revertedEntryRange;
  if (
    !Number.isSafeInteger(r.fromSeq) ||
    !Number.isSafeInteger(r.toSeq) ||
    r.fromSeq < 1 ||
    r.toSeq < r.fromSeq
  )
    throw new Error("Invalid reverted entry range");
}
