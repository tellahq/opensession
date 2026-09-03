import { useEffect, useMemo, useRef } from "react";
import type { LiveSubagent } from "../components/ToolCallBlock";
import { EFFORTS } from "../components/ModelEffortSelect";
import { runningAgentCount } from "../components/session-viewer/runtime-controller";
import { useSessionDiff } from "../components/DiffPanel";
import { plainThreadUrl } from "../components/PlainThreadPanel";
import { feedForRefKind } from "../lib/feeds-meta";
import { matchesShortcut } from "../lib/shortcuts";
import type { UnifiedSession } from "../lib/types";
import type { SessionSubagentSnapshot } from "../lib/api";
import { useSessionModelWorkflowController } from "./useSessionModelWorkflowController";
import type { useSessionRuntime } from "./useSessionRuntime";
import { useShortcutKeys, useShortcutLabel } from "./useShortcutBindings";

interface WorkspaceToolsIdentity {
  session: UnifiedSession;
  focused: boolean;
  hideRightPanel: boolean;
  pendingCreation: boolean;
}

interface WorkspaceToolsRuntime {
  dispatch: ReturnType<typeof useSessionRuntime>[1];
  model: string;
  isBusy: boolean;
  hasWorkspace: boolean;
  hasRepoWork: boolean;
  activePanelOpen: boolean;
  infoPageOpen: boolean;
}

interface WorkspaceToolsRelations {
  subagents: SessionSubagentSnapshot[];
  sessionReportCount: number;
}

export function useSessionWorkspaceToolsController({
  identity,
  runtime,
  relations,
}: {
  identity: WorkspaceToolsIdentity;
  runtime: WorkspaceToolsRuntime;
  relations: WorkspaceToolsRelations;
}) {
  const { session, focused } = identity;
  const { model: modelController, workflows: workflowController } =
    useSessionModelWorkflowController(session, runtime.dispatch);
  const { models, defaultModel, effort, setEffort } = modelController;
  const runningAgents = runningAgentCount(
    workflowController.workflowRuns,
    relations.subagents,
  );
  const hasPlain = Boolean(session.plainThreadId);
  const plainUrl = session.plainThreadId
    ? plainThreadUrl(session.plainThreadId)
    : "";
  const feedRef = (session.externalRefs || []).find((ref) => ref.url);
  const feedRefLabel = feedRef
    ? feedForRefKind(feedRef.kind)?.title ||
      feedRef.kind.charAt(0).toUpperCase() + feedRef.kind.slice(1)
    : "";
  const panelAvailable =
    !identity.hideRightPanel &&
    (runtime.hasWorkspace ||
      hasPlain ||
      workflowController.workflowRuns.length > 0 ||
      relations.subagents.length > 0 ||
      relations.sessionReportCount > 0);
  const liveSubagents = useMemo(() => {
    const map = new Map<string, LiveSubagent>();
    for (const subagent of relations.subagents)
      if (subagent.toolUseId)
        map.set(subagent.toolUseId, {
          id: subagent.id,
          status: subagent.status,
        });
    return map;
  }, [relations.subagents]);
  const diffState = useSessionDiff(session.id, {
    enabled:
      !identity.pendingCreation &&
      runtime.hasRepoWork &&
      (runtime.activePanelOpen || runtime.infoPageOpen),
    isRunning: runtime.isBusy,
  });
  const archiveShortcutLabel = useShortcutLabel("session-archive");
  const copyTranscriptLabel = useShortcutLabel("session-copy-transcript");
  const nextChatKeys = useShortcutKeys("workspace-next-unread");
  const newSiblingKeys = useShortcutKeys("session-new-sibling");
  const transcriptDownKeys = useShortcutKeys("transcript-down");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!focused) return;
      if (matchesShortcut(event, "composer-focus")) {
        event.preventDefault();
        composerRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!focused || event.defaultPrevented) return;
      const direction = matchesShortcut(event, "effort-up")
        ? 1
        : matchesShortcut(event, "effort-down")
          ? -1
          : 0;
      if (direction === 0) return;
      const effectiveModel = runtime.model || defaultModel;
      const supportedIds =
        models.find((candidate) => candidate.id === effectiveModel)?.efforts ??
        [];
      const supported = EFFORTS.filter((candidate) =>
        supportedIds.includes(candidate.id),
      );
      if (supported.length < 2) return;
      const effective = supportedIds.includes(effort)
        ? effort
        : supportedIds.includes("high")
          ? "high"
          : supported[0].id;
      const index = supported.findIndex(
        (candidate) => candidate.id === effective,
      );
      const next =
        supported[(index + direction + supported.length) % supported.length];
      if (!next) return;
      event.preventDefault();
      setEffort(next.id);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused, models, defaultModel, runtime.model, effort, setEffort]);
  return {
    model: modelController,
    workflows: workflowController,
    relations: {
      runningAgents,
      hasPlain,
      plainUrl,
      feedRef,
      feedRefLabel,
      panelAvailable,
      liveSubagents,
    },
    workspace: { diffState },
    shortcuts: {
      archiveShortcutLabel,
      copyTranscriptLabel,
      nextChatKeys,
      newSiblingKeys,
      transcriptDownKeys,
      composerRef,
    },
  };
}
