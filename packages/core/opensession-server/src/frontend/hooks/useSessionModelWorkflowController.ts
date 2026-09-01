import { useEffect, useState } from "react";
import type { Dispatch } from "react";
import { BASE_PATH } from "../lib/base";
import {
  fetchModels,
  fetchProviderAccounts,
  type ModelOption,
  type ProviderAccountOption,
} from "../lib/api";
import type { SessionRuntimeAction } from "../lib/session-runtime";
import type { UnifiedSession } from "../lib/types";
import type { WorkflowRunSnapshot } from "../../server/workflow-types";

// Per-session model/account/effort/goal state plus the dynamic workflow-run
// list, extracted verbatim from SessionViewer so its hook order and effect
// dependencies are unchanged. Returns two cohesive groups rather than a flat
// list so call sites read as "the model controls" and "the workflow runs".
export function useSessionModelWorkflowController(
  session: UnifiedSession,
  dispatchSessionRuntime: Dispatch<SessionRuntimeAction>,
) {
  // Per-session model (switchable from the composer; "" = default)
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  // Pinnable Claude/Codex accounts + this session's pin ("" = auto pool).
  const [accounts, setAccounts] = useState<ProviderAccountOption[]>([]);
  const [accountId, setAccountId] = useState(session.accountId || "");
  // Live token/cost accounting is seeded from the session and updated per run
  // through the `usage_update` broadcast in useSessionRuntime.
  // Reasoning effort — a composer control mirroring the new-session palette.
  // Persisted on the session server-side and enforced per run (Claude effort /
  // Codex modelReasoningEffort), so seed from the session's stored value.
  const [effort, setEffort] = useState(session.effort || "high");
  const [fastMode, setFastMode] = useState(session.fastMode || false);
  // Optimistic goal: reflects a just-set/cleared goal instantly (the /goal
  // command persists server-side but doesn't broadcast a live session update).
  // `undefined` = defer to session.goal; a string/null = the pending override.
  const [goalOverride, setGoalOverride] = useState<string | null | undefined>(
    undefined,
  );
  // Drop the override once the server-side session catches up (or we switch).
  useEffect(() => setGoalOverride(undefined), [session.id, session.goal]);
  const currentGoal =
    goalOverride !== undefined ? goalOverride : (session.goal ?? null);
  useEffect(() => {
    fetchModels(session.workspaceId || undefined)
      .then((m) => {
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch(() => {});
    fetchProviderAccounts()
      .then(setAccounts)
      .catch(() => {});
  }, [session.workspaceId]);
  useEffect(() => {
    dispatchSessionRuntime({
      type: "sync_model",
      model: session.model || "",
    });
  }, [dispatchSessionRuntime, session.id, session.model]);
  useEffect(() => {
    setAccountId(session.accountId || "");
  }, [session.id, session.accountId]);
  useEffect(() => {
    setEffort(session.effort || "high");
  }, [session.id, session.effort]);
  useEffect(() => {
    setFastMode(session.fastMode || false);
  }, [session.id, session.fastMode]);
  useEffect(() => {
    dispatchSessionRuntime({ type: "sync_usage", usage: session.usage });
  }, [dispatchSessionRuntime, session.id, session.usage]);

  // Dynamic workflow runs (opensession-workflows MCP): seeded by a fetch on
  // open/session switch, then kept live by workflow_update broadcasts. Powers
  // the Agents tab — hidden entirely while empty.
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunSnapshot[]>([]);
  // True once the seed fetch for the current session has settled — the
  // runs-vanished fallback below must not flip tabs off an empty [] mid-fetch.
  const [workflowsLoaded, setWorkflowsLoaded] = useState(false);
  useEffect(() => {
    let stale = false;
    setWorkflowRuns([]);
    setWorkflowsLoaded(false);
    fetch(
      `${BASE_PATH}/api/sessions/${encodeURIComponent(session.id)}/workflows`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (stale) return;
        if (Array.isArray(d?.runs)) {
          const fetched = d.runs as WorkflowRunSnapshot[];
          // WS upserts may have landed while the fetch was in flight — those
          // snapshots are newer than the seed, so keep them and only add
          // fetched runs we don't have yet (the panel re-sorts by startedAt).
          setWorkflowRuns((prev) => {
            const have = new Set(prev.map((r) => r.runId));
            const added = fetched.filter((r) => !have.has(r.runId));
            return added.length ? [...prev, ...added] : prev;
          });
        }
        setWorkflowsLoaded(true);
      })
      .catch(() => {
        if (!stale) setWorkflowsLoaded(true);
      });
    return () => {
      stale = true;
    };
  }, [session.id]);
  function workflowAction(
    runId: string,
    action: "cancel" | "pause" | "resume" | "skip" | "retry",
    seq?: number,
  ) {
    // Fire-and-forget: workflow_update echoes every state transition. Resume
    // after a process restart may create a new run, which arrives as another
    // workflow_update on the same session.
    const suffix =
      action === "skip" || action === "retry"
        ? `/agents/${seq}/${action}`
        : `/${action}`;
    fetch(`${BASE_PATH}/api/workflows/${encodeURIComponent(runId)}${suffix}`, {
      method: "POST",
    }).catch(() => {});
  }

  return {
    model: {
      models,
      defaultModel,
      accounts,
      accountId,
      effort,
      fastMode,
      goalOverride,
      currentGoal,
      setEffort,
      setFastMode,
      setAccountId,
      setGoalOverride,
    },
    workflows: {
      workflowRuns,
      workflowsLoaded,
      workflowAction,
      setWorkflowRuns,
    },
  };
}
