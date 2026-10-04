import { randomUUIDv7 } from "bun";
import { realpath } from "node:fs/promises";
import { configuredRepos, getConfigAsync } from "./config";
import { isAgentSessionBusy } from "./agent-runner";
import {
  transcript,
  drainPendingTranscriptWakesForSessions,
} from "./actor-transcript";
import {
  sessionMetadata,
  sessionRevert,
  sessionDelivery,
  type RevertActorRequest,
  type RevertActorResult,
  type RevertIntent,
} from "./session-kernel";
import { publishSessionChange, updateSessionFile } from "./session-cache";
import {
  branchPiConversation,
  piConversationExists,
} from "./pi-conversation-branch";
import { withSessionLifecycleLane } from "./sandbox/lifecycle-lane";
import {
  captureTurnWorkspace,
  inspectTurnRestore,
  restoreTurnWorkspace,
  turnCheckpointRef,
  turnWorkspaceDiff,
  turnWorkspaceFence,
  turnCheckpointTree,
  pruneTurnWorkspaces,
} from "./turn-workspace-checkpoint";

interface CheckpointSession {
  id: string;
  worktreeDir?: string;
  piSessionId?: string;
  lastEngineProvider?: string;
  mode?: string;
  sandbox?: unknown;
  runner?: unknown;
  attachedRepos?: unknown[];
}
interface RevertDependencies {
  session: (sessionId: string) => Promise<CheckpointSession>;
  eligible: (session: CheckpointSession) => Promise<void>;
  busy: (sessionId: string) => boolean;
  siblings: (session: CheckpointSession) => Promise<string[]>;
  queued: (sessionId: string) => Promise<boolean>;
  actor: <T extends RevertActorRequest>(
    request: T,
  ) => Promise<RevertActorResult<T>>;
  outline: (
    sessionId: string,
  ) => Promise<{ entries: { id: string; seq: number }[]; lastSeq: number }>;
  branch: typeof branchPiConversation;
  engineExists: typeof piConversationExists;
  publish: (sessionId: string) => Promise<void>;
  recoveryNeeded: (sessionId: string) => Promise<boolean>;
  exportPending: (sessionId: string) => Promise<boolean>;
  /** Failure injection after the filesystem step, before actor completion. */
  afterRestore?: () => Promise<void>;
}
const defaults: RevertDependencies = {
  async session(sessionId) {
    const record = await sessionMetadata({ op: "catalog_get", sessionId });
    if (!record) throw new Error("Session metadata is unavailable");
    const session = JSON.parse(record.doc) as CheckpointSession;
    if (session.id !== sessionId)
      throw new Error("Revert is available only for managed sessions");
    return session;
  },
  async eligible(session) {
    if (
      !session.worktreeDir ||
      session.mode === "ask" ||
      session.mode === "scratch" ||
      session.sandbox ||
      session.runner ||
      session.attachedRepos?.length
    )
      throw new Error(
        "Revert requires a local, single-repository code worktree",
      );
    if (
      !session.piSessionId ||
      (session.lastEngineProvider && session.lastEngineProvider !== "pi")
    )
      throw new Error("This session's conversation cannot be rewound");
    const cwd = await realpath(session.worktreeDir);
    const repos = Object.values(configuredRepos(await getConfigAsync()));
    for (const repo of repos) {
      if (cwd === (await realpath(repo.repo)))
        throw new Error("Shared checkouts cannot be reverted");
    }
  },
  busy: isAgentSessionBusy,
  siblings: (session) =>
    sessionMetadata({
      op: "worktree_activity",
      worktreeDir: session.worktreeDir!,
      excludeSessionId: session.id,
    }),
  actor: sessionRevert,
  async queued(sessionId) {
    const state = await sessionDelivery({ op: "snapshot", sessionId });
    return (
      !!state.dispatch ||
      state.queued.length > 0 ||
      state.steered.length > 0 ||
      state.pendingSteers.length > 0
    );
  },
  async recoveryNeeded(sessionId) {
    const record = await sessionMetadata({ op: "catalog_get", sessionId });
    if (!record) return false;
    const doc = JSON.parse(record.doc) as CheckpointSession & {
      turnRevertIntent?: unknown;
    };
    return (
      !!doc.turnRevertIntent ||
      !!(
        doc.id === sessionId &&
        doc.piSessionId &&
        doc.worktreeDir &&
        !doc.sandbox &&
        !doc.runner
      )
    );
  },
  async exportPending(sessionId) {
    const record = await sessionMetadata({ op: "catalog_get", sessionId });
    return !!record && record.exportedRev < record.rev;
  },
  outline: (id) => transcript.readTranscriptIndex(id),
  branch: branchPiConversation,
  engineExists: piConversationExists,
  async publish(sessionId) {
    // Export the actor-committed pointer before synchronous run projections
    // can read the legacy session file. A crash here is repaired on admission.
    await updateSessionFile(sessionId, (doc) => doc);
    await drainPendingTranscriptWakesForSessions([sessionId]);
    await publishSessionChange(sessionId);
  },
};
function requireMutation(result: { status: string; reason?: string }): void {
  if (result.status === "refused")
    throw new Error(`Revert refused: ${result.reason}`);
}
function inputForRef(session: CheckpointSession, ref: string) {
  const prefix = `refs/opensession/turns/${session.id}/before/`;
  if (!ref.startsWith(prefix)) throw new Error("Unsupported restore ref");
  return {
    cwd: session.worktreeDir!,
    sessionId: session.id,
    turnId: ref.slice(prefix.length),
  };
}
export function createTurnRevertService(
  overrides: Partial<RevertDependencies> = {},
) {
  const deps = { ...defaults, ...overrides };
  const load = async (id: string) => {
    const session = await deps.session(id);
    await deps.eligible(session);
    return session;
  };
  const recoverHeld = async (session: CheckpointSession): Promise<void> => {
    const state = await deps.actor({ op: "get", sessionId: session.id });
    const { intent } = state;
    if (!intent) {
      if (state.engineSessionId !== session.piSessionId) {
        requireMutation(
          await deps.actor({ op: "reconcile", sessionId: session.id }),
        );
        await deps.publish(session.id);
      } else if (await deps.exportPending(session.id))
        await deps.publish(session.id);
      return;
    }
    await deps.eligible(session);
    if (deps.busy(session.id))
      throw new Error("Revert interrupted, needs attention: a run is active");
    if (intent.phase === "files_restored") {
      const fence = await turnWorkspaceFence(session.worktreeDir!);
      if (
        fence.head !== intent.expectedHead ||
        fence.indexTree !== intent.expectedIndexTree
      )
        throw new Error(
          "Revert interrupted, needs attention: commits or staged files changed. Resolve them or explicitly discard the interrupted revert.",
        );
      const input = inputForRef(session, intent.preRevertRef);
      const preview = await inspectTurnRestore(input);
      const targetTree = await turnCheckpointTree(
        session.worktreeDir!,
        intent.checkpointRef,
      );
      const originalTree = await turnCheckpointTree(
        session.worktreeDir!,
        intent.preRevertRef,
      );
      if (
        preview.currentTree !== targetTree &&
        preview.currentTree !== originalTree
      )
        throw new Error(
          "Revert interrupted, needs attention: workspace files changed or restore was incomplete. Discard the interrupted revert to keep the current files.",
        );
      await restoreTurnWorkspace(input, preview.currentTree);
    }
    requireMutation(
      await deps.actor({
        op: "rollback",
        sessionId: session.id,
        intentId: intent.intentId,
        reason: "Recovered interrupted revert",
      }),
    );
    await deps.publish(session.id);
  };
  const ready = async (id: string) => {
    const session = await load(id);
    await recoverHeld(session);
    const current = await load(id);
    if (deps.busy(id))
      throw new Error("Stop the active run before reverting a turn");
    if (await deps.queued(id))
      throw new Error("Finish or remove queued work before reverting a turn");
    if ((await deps.siblings(current)).length)
      throw new Error(
        "Another session in this worktree is active or has queued work",
      );
    return current;
  };
  const applyIntent = async (
    session: CheckpointSession,
    intent: Omit<RevertIntent, "phase" | "createdAt">,
    expectedTree: string,
  ) => {
    requireMutation(
      await deps.actor({ op: "begin", sessionId: session.id, intent }),
    );
    // Mark BEFORE touching files: a crash between restore and marking must
    // never look like an untouched `begun` intent. This phase means the files
    // MAY have changed, so recovery always restores the pre-revert snapshot.
    requireMutation(
      await deps.actor({
        op: "mark_files_restored",
        sessionId: session.id,
        intentId: intent.intentId,
      }),
    );
    await restoreTurnWorkspace(
      inputForRef(session, intent.checkpointRef),
      expectedTree,
    );
    await deps.afterRestore?.();
    requireMutation(
      await deps.actor({
        op: intent.operation === "undo" ? "undo_last" : "complete",
        sessionId: session.id,
        intentId: intent.intentId,
      }),
    );
    await pruneTurnWorkspaces(session.worktreeDir!, session.id, 50, [
      intent.checkpointRef,
      intent.preRevertRef,
    ]);
    await deps.publish(session.id);
  };
  return {
    recover: (id: string) =>
      withSessionLifecycleLane(id, async () => {
        if (!(await deps.recoveryNeeded(id))) return;
        await recoverHeld(await deps.session(id));
      }),
    preview: (id: string, turnId: string) =>
      withSessionLifecycleLane(id, async () => {
        const session = await load(id);
        let reason: string | null = null;
        try {
          await recoverHeld(session);
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
        }
        const state = await deps.actor({ op: "get", sessionId: id });
        let patch = "";
        try {
          patch = await turnWorkspaceDiff({
            cwd: session.worktreeDir!,
            sessionId: id,
            turnId,
          });
        } catch {
          /* incomplete or retained turn */
        }
        if (reason)
          return {
            patch,
            restorePatch: "",
            files: [] as string[],
            currentTree: "",
            canRestore: false,
            reason,
            canUndo: false,
            interrupted: true,
          };
        try {
          await ready(id);
          const preview = await inspectTurnRestore({
            cwd: session.worktreeDir!,
            sessionId: id,
            turnId,
          });
          if (
            !preview.metadata.conversation ||
            !(await deps.engineExists(
              id,
              preview.metadata.conversation.engineId,
            ))
          )
            throw new Error(
              "This turn has no restorable conversation checkpoint",
            );
          return {
            patch,
            restorePatch: preview.patch,
            files: preview.files,
            currentTree: preview.currentTree,
            canRestore: true,
            reason: null,
            canUndo: !!state.lastRevert,
            interrupted: false,
          };
        } catch (error) {
          return {
            patch,
            restorePatch: "",
            files: [] as string[],
            currentTree: "",
            canRestore: false,
            reason: error instanceof Error ? error.message : String(error),
            canUndo: !!state.lastRevert,
            interrupted: false,
          };
        }
      }),
    previewUndo: (id: string) =>
      withSessionLifecycleLane(id, async () => {
        const session = await ready(id);
        const { lastRevert } = await deps.actor({ op: "get", sessionId: id });
        if (!lastRevert) throw new Error("No workspace revert to undo");
        const outline = await deps.outline(id);
        if (outline.lastSeq !== lastRevert.revertedEntryRange.toSeq + 1)
          throw new Error("New transcript activity makes undo unavailable");
        const preview = await inspectTurnRestore(
          inputForRef(session, lastRevert.preRevertRef),
        );
        return {
          patch: preview.patch,
          restorePatch: preview.patch,
          files: preview.files,
          currentTree: preview.currentTree,
          canRestore: true,
          reason: null,
          canUndo: true,
          interrupted: false,
        };
      }),
    revert: (id: string, turnId: string, expectedTree: string) =>
      withSessionLifecycleLane(id, async () => {
        const session = await ready(id);
        const input = { cwd: session.worktreeDir!, sessionId: id, turnId };
        const preview = await inspectTurnRestore(input);
        if (preview.currentTree !== expectedTree)
          throw new Error(
            "Workspace changed since the restore preview. Review it again.",
          );
        if (!preview.metadata.conversation)
          throw new Error("This turn's conversation cannot be rewound");
        const outline = await deps.outline(id);
        const fromSeq = outline.entries.find((e) => e.id === turnId)?.seq;
        if (!fromSeq)
          throw new Error("The turn is not in this session's transcript");
        const toEngineSessionId = await deps.branch(
          id,
          preview.metadata.conversation,
        );
        const intentId = randomUUIDv7();
        const preTurnId = `revert-${intentId}`;
        await captureTurnWorkspace(
          { ...input, turnId: preTurnId },
          "before",
          undefined,
          false,
        );
        await applyIntent(
          session,
          {
            intentId,
            targetTurnId: turnId,
            revertedEntryRange: { fromSeq, toSeq: outline.lastSeq },
            checkpointRef: turnCheckpointRef(id, turnId, "before"),
            preRevertRef: turnCheckpointRef(id, preTurnId, "before"),
            expectedHead: preview.metadata.head,
            expectedIndexTree: preview.metadata.indexTree,
            fromEngineSessionId: session.piSessionId!,
            toEngineSessionId,
            operation: "revert",
          },
          expectedTree,
        );
      }),
    undo: (id: string, expectedTree: string) =>
      withSessionLifecycleLane(id, async () => {
        const session = await ready(id);
        const { lastRevert } = await deps.actor({ op: "get", sessionId: id });
        if (!lastRevert) throw new Error("No workspace revert to undo");
        const outline = await deps.outline(id);
        if (outline.lastSeq !== lastRevert.revertedEntryRange.toSeq + 1)
          throw new Error("New transcript activity makes undo unavailable");
        if (!(await deps.engineExists(id, lastRevert.fromEngineSessionId)))
          throw new Error("The original Pi conversation is missing");
        const target = inputForRef(session, lastRevert.preRevertRef);
        const preview = await inspectTurnRestore(target);
        if (preview.currentTree !== expectedTree)
          throw new Error(
            "Workspace changed since the restore preview. Review it again.",
          );
        const intentId = randomUUIDv7();
        const preTurnId = `undo-${intentId}`;
        await captureTurnWorkspace(
          { ...target, turnId: preTurnId },
          "before",
          undefined,
          false,
        );
        await applyIntent(
          session,
          {
            ...lastRevert,
            intentId,
            operation: "undo",
            checkpointRef: lastRevert.preRevertRef,
            preRevertRef: turnCheckpointRef(id, preTurnId, "before"),
            expectedHead: preview.metadata.head,
            expectedIndexTree: preview.metadata.indexTree,
            fromEngineSessionId: session.piSessionId!,
            toEngineSessionId: lastRevert.fromEngineSessionId,
          },
          expectedTree,
        );
      }),
    discard: (id: string) =>
      withSessionLifecycleLane(id, async () => {
        const session = await load(id);
        if (deps.busy(id)) throw new Error("Stop the active run first");
        const { intent } = await deps.actor({ op: "get", sessionId: id });
        if (!intent) return;
        requireMutation(
          await deps.actor({
            op: "rollback",
            sessionId: id,
            intentId: intent.intentId,
            reason:
              "Explicitly discarded interrupted revert; current files retained",
          }),
        );
        await deps.publish(session.id);
      }),
  };
}
export const turnRevertService = createTurnRevertService();
