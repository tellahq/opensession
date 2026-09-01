/**
 * Workflow routes: read access to dynamic-workflow runs
 * (~/.opensession-workflows via workflow-store.ts) for the session viewer's
 * Agents panel, plus cancel. Runs are created through the
 * opensession-workflows MCP tools (workflow-tools.ts), never over HTTP.
 */

import type { RouteContext } from "./context";
import {
  isMcpJournalEntry,
  isSessionJournalEntry,
  type WorkflowJournalEntry,
} from "../workflow-types";
import {
  getWorkflowRun,
  listWorkflowRunsForSession,
  readWorkflowJournal,
} from "../workflow-store";
import {
  cancelWorkflow,
  controlWorkflowAgent,
  pauseWorkflow,
  recoverWorkflow,
  resumeWorkflow,
} from "../workflow-runner";
import {
  findPiNativeTranscript,
  findPiNativeTranscriptByPrompt,
  readPiNativeTranscript,
} from "../pi-native-transcript";

/** The journal's agent() records only. mcp.* records live in the same file
 *  under their own seq space, so every seq-keyed agent lookup goes through
 *  here — a raw find() can otherwise match an unrelated tool call. */
function agentJournalEntries(runId: string): WorkflowJournalEntry[] {
  return readWorkflowJournal(runId).filter(
    (e): e is WorkflowJournalEntry =>
      !isMcpJournalEntry(e) && !isSessionJournalEntry(e),
  );
}

export async function handleWorkflowsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  // All workflow runs for a session (newest first) — the Agents panel's
  // initial load; live updates arrive as workflow_update WS messages.
  {
    const m = path.match(/^\/api\/sessions\/([^/]+)\/workflows$/);
    if (m && req.method === "GET") {
      return Response.json({
        runs: listWorkflowRunsForSession(decodeURIComponent(m[1])),
      });
    }
  }

  // One agent call's journal entry (full prompt + outcome, not the snapshot
  // previews) — the panel's drill-in.
  {
    const m = path.match(/^\/api\/workflows\/([^/]+)\/agents\/(\d+)$/);
    if (m && req.method === "GET") {
      const runId = decodeURIComponent(m[1]);
      const seq = parseInt(m[2], 10);
      if (!getWorkflowRun(runId))
        return Response.json({ error: "Workflow not found" }, { status: 404 });
      const entry = agentJournalEntries(runId).find((e) => e.seq === seq);
      if (!entry)
        return Response.json(
          { error: "No journal entry for that agent (still running?)" },
          { status: 404 },
        );
      return Response.json(entry);
    }
  }

  // One agent's full conversation — the drill-in. Workflow agents run
  // WITHOUT an owning Open Session session, so their pi conversation is never
  // in transcripts.db; the native session jsonl is the only record. Removed
  // alongside the retired opencode engine (6b6bcfd2d) and restored here
  // against pi after the drill-in started 404-ing into "No conversation
  // recorded for this agent".
  {
    const m = path.match(
      /^\/api\/workflows\/([^/]+)\/agents\/(\d+)\/transcript$/,
    );
    if (m && req.method === "GET") {
      const runId = decodeURIComponent(m[1]);
      const seq = parseInt(m[2], 10);
      if (!getWorkflowRun(runId))
        return Response.json({ error: "Workflow not found" }, { status: 404 });
      const snap = getWorkflowRun(runId)?.agents.find((a) => a.seq === seq);
      // mcp.* records share journal.jsonl and number their own seq space,
      // so an agent lookup MUST skip them or it can match the wrong record.
      const journal = agentJournalEntries(runId).find((e) => e.seq === seq);
      const engineSessionId =
        snap?.engineSessionId || journal?.outcome.engineSessionId;
      const nativePath = engineSessionId
        ? findPiNativeTranscript(engineSessionId)
        : journal
          ? findPiNativeTranscriptByPrompt(journal)
          : null;
      if (!nativePath)
        return Response.json(
          { error: "No conversation recorded for this agent", entries: [] },
          { status: 404 },
        );
      return Response.json({ entries: readPiNativeTranscript(nativePath) });
    }
  }

  {
    const m = path.match(
      /^\/api\/workflows\/([^/]+)\/agents\/(\d+)\/(skip|retry)$/,
    );
    if (m && req.method === "POST") {
      return Response.json({
        ok: controlWorkflowAgent(
          decodeURIComponent(m[1]),
          Number.parseInt(m[2], 10),
          m[3] as "skip" | "retry",
        ),
      });
    }
  }

  {
    const m = path.match(/^\/api\/workflows\/([^/]+)\/(cancel|pause|resume)$/);
    if (m && req.method === "POST") {
      const runId = decodeURIComponent(m[1]);
      if (m[2] === "cancel")
        return Response.json({ ok: cancelWorkflow(runId) });
      if (m[2] === "pause")
        return Response.json({ ok: pauseWorkflow(runId, "paused from UI") });
      if (resumeWorkflow(runId)) return Response.json({ ok: true, runId });
      const recoveredRunId = await recoverWorkflow(runId);
      return Response.json({
        ok: Boolean(recoveredRunId),
        ...(recoveredRunId ? { runId: recoveredRunId } : {}),
      });
    }
  }

  // Full run snapshot. Keep this last in the family — it's the loosest match.
  {
    const m = path.match(/^\/api\/workflows\/([^/]+)$/);
    if (m && req.method === "GET") {
      const run = getWorkflowRun(decodeURIComponent(m[1]));
      if (!run)
        return Response.json({ error: "Workflow not found" }, { status: 404 });
      return Response.json(run);
    }
  }

  return undefined;
}
